import { and, eq } from 'drizzle-orm';
import { censorText } from '@cs/shared/filter';
import { checkHandle } from '@cs/shared/handles';
import type { IdentityPublic, Kind, Role } from '@cs/shared/protocol';
import type { DB } from '../db';
import { identities, sessions } from '../db/schema';
import type { Clock } from '../lib/clock';
import { AppError, badRequest, conflict, forbidden, isUniqueViolation, notFound } from '../lib/errors';
import { hashSecret, newId, newSecret } from '../lib/ids';

export type IdentityRow = typeof identities.$inferSelect;

/** A new human's unranked grace week (M4). Agents are ranked from the start. */
export const RANKED_GRACE_MS = 7 * 86_400_000;

/** Where a browser session came from; shown back to its owner on their profile. */
export interface SessionMeta {
  label: string;
  ip: string | null;
}

const WARM = ['#ffb347', '#ff6b5b', '#ffd166', '#ff8fa3', '#ffa07a'];
const COOL = ['#3de0ff', '#9b6bff', '#5dffa5', '#6bd0ff', '#c38bff', '#b8ff5d'];
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const TOUCH_EVERY_MS = 5 * 60_000;
const DEFAULT_META: SessionMeta = { label: 'browser', ip: null };

export interface AgentInput {
  name?: unknown;
  tagline?: unknown;
  color?: unknown;
  model?: unknown;
}

export function toPublic(row: IdentityRow): IdentityPublic {
  return {
    id: row.id,
    handle: row.handle,
    kind: row.kind,
    tagline: row.tagline,
    color: row.color,
    model: row.model,
    isHouse: row.isHouse,
    locked: row.passwordHash !== null,
    role: row.role,
    ownerHandle: row.ownerHandle,
    released: row.releasedAt !== null,
  };
}

function paletteColor(palette: string[], seed: string): string {
  let h = 0;
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return palette[h % palette.length];
}

function optionalText(value: unknown, max: number, field: string): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw badRequest('BAD_FIELD', `${field} must be a string.`);
  const text = value.trim();
  if (text.length > max) throw badRequest('BAD_FIELD', `${field} is at most ${max} characters.`);
  return text ? censorText(text) : null;
}

const taken = (handle: string) => conflict('HANDLE_TAKEN', `@${handle} is taken. Try another.`);

interface Cached {
  identity: IdentityPublic;
  /** The browser session behind a human's key; null for agent tokens. */
  sessionId: string | null;
}

export class IdentityManager {
  /** Key hash → who it signs in. Anything that changes who a key belongs to or what they may do evicts. */
  private cache = new Map<string, Cached>();
  private touchedAt = new Map<string, number>();
  /** Bumped by every evict() call, so a DB read racing an eviction never writes a stale entry back in. */
  private evictions = 0;

  constructor(
    private db: DB,
    private clock: Clock,
    private opts: { houseKey: string | null },
  ) {}

  async createHuman(rawHandle: unknown, meta: SessionMeta = DEFAULT_META): Promise<{ identity: IdentityPublic; key: string }> {
    // A human's own secret is never handed out: browsers sign in through sessions.
    const identity = await this.insert({ rawHandle, kind: 'human', secret: newSecret('csx_'), color: null, tagline: null, model: null, isHouse: false });
    const key = await this.newSession(identity.id, meta);
    return { identity, key };
  }

  async registerAgent(input: AgentInput, houseKey: string | null): Promise<{ identity: IdentityPublic; token: string }> {
    let isHouse = false;
    if (houseKey !== null && houseKey !== undefined) {
      if (!this.opts.houseKey || houseKey !== this.opts.houseKey) throw forbidden('BAD_HOUSE_KEY', 'That house key is not valid.');
      isHouse = true;
    }
    let color: string | null = null;
    if (input.color !== undefined && input.color !== null) {
      if (typeof input.color !== 'string' || !COLOR_RE.test(input.color)) {
        throw badRequest('BAD_FIELD', 'color must look like "#3de0ff".');
      }
      color = input.color.toLowerCase();
    }
    const tagline = optionalText(input.tagline, 80, 'tagline');
    const model = optionalText(input.model, 40, 'model');
    if (isHouse) {
      const rotated = await this.rotateHouse({ rawHandle: input.name, color, tagline, model });
      if (rotated) return rotated;
    }
    const token = newSecret('cs_');
    const identity = await this.insert({ rawHandle: input.name, kind: 'agent', secret: token, color, tagline, model, isHouse });
    return { identity, token };
  }

  /** A house key re-registering an existing house identity rotates its token instead of colliding. */
  private async rotateHouse(p: { rawHandle: unknown; color: string | null; tagline: string | null; model: string | null }): Promise<{ identity: IdentityPublic; token: string } | null> {
    const check = checkHandle(p.rawHandle);
    if (!check.ok) throw new AppError(400, check.code, check.message);
    const handleLower = check.handle.toLowerCase();
    const [row] = await this.db.select().from(identities).where(eq(identities.handleLower, handleLower)).limit(1);
    if (!row) return null;
    if (!row.isHouse) throw taken(check.handle);
    const token = newSecret('cs_');
    const [updated] = await this.db
      .update(identities)
      .set({ secretHash: hashSecret(token), tagline: p.tagline, color: p.color ?? row.color, model: p.model })
      .where(eq(identities.id, row.id))
      .returning();
    this.evict(row.id);
    return { identity: toPublic(updated), token };
  }

  private async insert(p: {
    rawHandle: unknown;
    kind: Kind;
    secret: string;
    color: string | null;
    tagline: string | null;
    model: string | null;
    isHouse: boolean;
  }): Promise<IdentityPublic> {
    const check = checkHandle(p.rawHandle);
    if (!check.ok) throw new AppError(400, check.code, check.message);
    const handle = check.handle;
    const handleLower = handle.toLowerCase();
    const existing = await this.db
      .select({ id: identities.id })
      .from(identities)
      .where(eq(identities.handleLower, handleLower))
      .limit(1);
    if (existing.length > 0) throw taken(handle);
    try {
      const now = new Date(this.clock.now());
      const [row] = await this.db
        .insert(identities)
        .values({
          id: newId('id'),
          handle,
          handleLower,
          kind: p.kind,
          secretHash: hashSecret(p.secret),
          color: p.color ?? paletteColor(p.kind === 'human' ? WARM : COOL, handleLower),
          tagline: p.tagline,
          model: p.model,
          isHouse: p.isHouse,
          createdAt: now,
          lastSeenAt: now,
          rankedAt: new Date(now.getTime() + (p.kind === 'agent' ? 0 : RANKED_GRACE_MS)),
        })
        .returning();
      return toPublic(row);
    } catch (e) {
      if (isUniqueViolation(e)) throw taken(handle);
      throw e;
    }
  }

  /** Opens a new browser session for a human and returns its raw csk_ key (shown once, stored hashed). */
  async newSession(identityId: string, meta: SessionMeta): Promise<string> {
    const key = newSecret('csk_');
    const now = new Date(this.clock.now());
    await this.db.insert(sessions).values({
      id: newId('se'),
      identityId,
      keyHash: hashSecret(key),
      label: meta.label.trim().slice(0, 60) || 'browser',
      ip: meta.ip,
      createdAt: now,
      lastUsedAt: now,
    });
    return key;
  }

  async authenticate(secret?: string | null): Promise<IdentityPublic | null> {
    return (await this.authenticateSession(secret))?.identity ?? null;
  }

  /** Humans sign in with a session key (csk_…), agents with their token (cs_…). Released identities never do. */
  async authenticateSession(secret?: string | null): Promise<Cached | null> {
    if (!secret || secret.length > 200) return null;
    const hash = hashSecret(secret);
    const cached = this.cache.get(hash);
    if (cached) return cached;
    const gen = this.evictions; // captured before the read: a concurrent evict() must not be undone below
    let found: Cached | null = null;
    if (secret.startsWith('csk_')) {
      const [hit] = await this.db
        .select({ s: sessions, i: identities })
        .from(sessions)
        .innerJoin(identities, eq(identities.id, sessions.identityId))
        .where(eq(sessions.keyHash, hash))
        .limit(1);
      if (hit && hit.i.releasedAt === null) found = { identity: toPublic(hit.i), sessionId: hit.s.id };
    } else {
      const [row] = await this.db
        .select()
        .from(identities)
        .where(and(eq(identities.secretHash, hash), eq(identities.kind, 'agent')))
        .limit(1);
      if (row && row.releasedAt === null) found = { identity: toPublic(row), sessionId: null };
    }
    if (found && gen === this.evictions) this.cache.set(hash, found);
    return found;
  }

  /** Forgets every cached key of this identity; the next request re-reads the database. Also bumps the
   *  eviction generation, so an authenticateSession() read already in flight for this identity — or for
   *  a key that hadn't been cached yet — can't write a now-stale result back into the cache afterward. */
  evict(identityId: string): void {
    this.evictions++;
    for (const [hash, entry] of this.cache) {
      if (entry.identity.id === identityId) this.cache.delete(hash);
    }
  }

  /** Records that someone was here: last seen, last IP and the session's last use. At most once per
   *  5 minutes per session (or per agent), and fire-and-forget so it never slows a request. */
  touch(identityId: string, ip: string | null, sessionId: string | null = null): void {
    const now = this.clock.now();
    const key = sessionId ?? identityId;
    const last = this.touchedAt.get(key);
    if (last !== undefined && now - last < TOUCH_EVERY_MS) return;
    this.touchedAt.set(key, now);
    const at = new Date(now);
    void (async () => {
      await this.db.update(identities).set({ lastSeenAt: at, ...(ip ? { lastIp: ip } : {}) }).where(eq(identities.id, identityId));
      if (sessionId) await this.db.update(sessions).set({ lastUsedAt: at, ...(ip ? { ip } : {}) }).where(eq(sessions.id, sessionId));
    })().catch((e) => console.error('[identity] touch failed', e));
  }

  /** Re-reads an identity after a change, and drops its cached keys so they pick the change up. */
  async refresh(identityId: string): Promise<IdentityPublic | null> {
    this.evict(identityId);
    const row = await this.row(identityId);
    return row ? toPublic(row) : null;
  }

  async setRole(identityId: string, role: Role): Promise<IdentityPublic> {
    const [row] = await this.db.update(identities).set({ role }).where(eq(identities.id, identityId)).returning();
    if (!row) throw notFound('NO_USER', 'No such player.');
    this.evict(identityId);
    return toPublic(row);
  }

  async row(id: string): Promise<IdentityRow | null> {
    const [row] = await this.db.select().from(identities).where(eq(identities.id, id)).limit(1);
    return row ?? null;
  }

  async get(id: string): Promise<IdentityPublic | null> {
    const row = await this.row(id);
    return row ? toPublic(row) : null;
  }

  /** The live agent a token belongs to, for owner links. The token is only hashed, never kept. */
  async agentByToken(token: unknown): Promise<IdentityRow | null> {
    const t = typeof token === 'string' ? token.trim() : '';
    if (!t.startsWith('cs_') || t.length > 200) return null;
    const [row] = await this.db
      .select()
      .from(identities)
      .where(and(eq(identities.secretHash, hashSecret(t)), eq(identities.kind, 'agent')))
      .limit(1);
    return row && row.releasedAt === null ? row : null;
  }

  /** Links an agent to its owner, or unlinks it (null); both owner columns move together. */
  async setOwner(agentId: string, owner: IdentityPublic | null): Promise<IdentityPublic> {
    const [row] = await this.db
      .update(identities)
      .set({ ownerId: owner?.id ?? null, ownerHandle: owner?.handle ?? null })
      .where(eq(identities.id, agentId))
      .returning();
    if (!row) throw notFound('NO_USER', 'No such player.');
    this.evict(agentId);
    return toPublic(row);
  }

  async getByHandle(handle: string): Promise<IdentityPublic | null> {
    const [row] = await this.db
      .select()
      .from(identities)
      .where(eq(identities.handleLower, handle.trim().toLowerCase()))
      .limit(1);
    return row ? toPublic(row) : null;
  }
}
