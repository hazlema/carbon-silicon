import { eq } from 'drizzle-orm';
import { censorText } from '@cs/shared/filter';
import { checkHandle } from '@cs/shared/handles';
import type { IdentityPublic, Kind } from '@cs/shared/protocol';
import type { DB } from '../db';
import { identities } from '../db/schema';
import { AppError, badRequest, conflict, forbidden, isUniqueViolation } from '../lib/errors';
import { hashSecret, newId, newSecret } from '../lib/ids';

type Row = typeof identities.$inferSelect;

const WARM = ['#ffb347', '#ff6b5b', '#ffd166', '#ff8fa3', '#ffa07a'];
const COOL = ['#3de0ff', '#9b6bff', '#5dffa5', '#6bd0ff', '#c38bff', '#b8ff5d'];
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

export interface AgentInput {
  name?: unknown;
  tagline?: unknown;
  color?: unknown;
  model?: unknown;
}

export function toPublic(row: Row): IdentityPublic {
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
    ownerHandle: null,
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

export class IdentityManager {
  private cacheBySecret = new Map<string, IdentityPublic>();

  constructor(
    private db: DB,
    private opts: { houseKey: string | null; adminHandles: string[] },
  ) {}

  async createHuman(rawHandle: unknown): Promise<{ identity: IdentityPublic; key: string }> {
    const key = newSecret('csk_');
    const identity = await this.insert({ rawHandle, kind: 'human', secret: key, color: null, tagline: null, model: null, isHouse: false });
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
    for (const [hash, cachedIdentity] of this.cacheBySecret) {
      if (cachedIdentity.id === row.id) this.cacheBySecret.delete(hash);
    }
    const identity = toPublic(updated);
    this.cacheBySecret.set(updated.secretHash, identity);
    return { identity, token };
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
          role: this.opts.adminHandles.includes(handleLower) ? 'admin' : 'user',
        })
        .returning();
      const identity = toPublic(row);
      this.cacheBySecret.set(row.secretHash, identity);
      return identity;
    } catch (e) {
      if (isUniqueViolation(e)) throw taken(handle);
      throw e;
    }
  }

  async authenticate(secret?: string | null): Promise<IdentityPublic | null> {
    if (!secret || secret.length > 200) return null;
    const hash = hashSecret(secret);
    const cached = this.cacheBySecret.get(hash);
    if (cached) return cached;
    const [row] = await this.db.select().from(identities).where(eq(identities.secretHash, hash)).limit(1);
    if (!row) return null;
    const identity = toPublic(row);
    this.cacheBySecret.set(hash, identity);
    return identity;
  }

  async get(id: string): Promise<IdentityPublic | null> {
    const [row] = await this.db.select().from(identities).where(eq(identities.id, id)).limit(1);
    return row ? toPublic(row) : null;
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
