import { and, desc, eq, isNull, lt, ne, sql, type SQL } from 'drizzle-orm';
import { censorText } from '@cs/shared/filter';
import type { IdentityPublic, SessionInfo } from '@cs/shared/protocol';
import type { DB } from '../db';
import { identities, matchPlayers, sessions } from '../db/schema';
import type { Clock } from '../lib/clock';
import { badRequest, conflict, notFound, unauthorized } from '../lib/errors';
import { hashSecret, newSecret } from '../lib/ids';
import type { Guard } from './guard';
import { toPublic, type IdentityManager, type IdentityRow, type SessionMeta } from './identity';

const DAY = 86_400_000;
const BIO_MAX = 80;

const badPassword = () => unauthorized('BAD_PASSWORD', "That handle and password don't match.");
const badCode = () => unauthorized('BAD_CODE', "That recovery code doesn't match.");
const notLocked = () => conflict('NOT_LOCKED', 'This name is not locked. Lock it from your profile first.');

function newPassword(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length < 10 || raw.length > 200) {
    throw badRequest('BAD_FIELD', 'Passwords are 10–200 characters.');
  }
  return raw;
}

const hashPassword = (pw: string) => Bun.password.hash(pw, { algorithm: 'argon2id' });

let dummyHash: Promise<string> | null = null;
/** Checks a password; with no account it checks against a throwaway hash, so a miss takes as long as a hit. */
async function verify(pw: unknown, hash: string | null): Promise<boolean> {
  dummyHash ??= hashPassword('not a real password');
  const ok = await Bun.password.verify(typeof pw === 'string' ? pw : '', hash ?? (await dummyHash));
  return ok && hash !== null;
}

/** Locked names, sign-in from anywhere, recovery, sessions, and giving names back. */
export class AccountManager {
  private releaseHooks: ((identityId: string) => Promise<void>)[] = [];
  private idleGuestMs: number;
  private idleMatchedMs: number;

  constructor(
    private db: DB,
    private clock: Clock,
    private identities: IdentityManager,
    private guard: Guard,
    opts: { idleGuestMs?: number; idleMatchedMs?: number } = {},
  ) {
    this.idleGuestMs = opts.idleGuestMs ?? 30 * DAY;
    this.idleMatchedMs = opts.idleMatchedMs ?? 180 * DAY;
  }

  /** Runs inside release(), once the name is scrubbed (e.g. to drop ignore and block lists, lift sanctions). */
  onRelease(fn: (identityId: string) => Promise<void>): void {
    this.releaseHooks.push(fn);
  }

  private async require(identityId: string): Promise<IdentityRow> {
    const row = await this.identities.row(identityId);
    if (!row || row.releasedAt) throw notFound('NO_USER', 'No such player.');
    return row;
  }

  /** A locked, unreleased human by handle; null for anything else, so every miss looks the same. */
  private async lockedByHandle(handle: unknown): Promise<IdentityRow | null> {
    if (typeof handle !== 'string') return null;
    const lower = handle.trim().toLowerCase();
    if (!lower) return null;
    const [row] = await this.db.select().from(identities).where(eq(identities.handleLower, lower)).limit(1);
    return row && row.kind === 'human' && row.passwordHash !== null && row.releasedAt === null ? row : null;
  }

  async lock(identity: IdentityPublic, password: unknown): Promise<{ identity: IdentityPublic; recoveryCode: string }> {
    this.guard.assert(identity, 'profile'); // a suspended account can't lock a name either (S120-121)
    const row = await this.require(identity.id);
    if (row.kind !== 'human') throw conflict('ALREADY_LOCKED', 'Agent names are reserved already; they sign in with their token.');
    if (row.passwordHash) throw conflict('ALREADY_LOCKED', 'This name is already locked.');
    const passwordHash = await hashPassword(newPassword(password));
    const recoveryCode = newSecret('csr_');
    await this.db.update(identities).set({ passwordHash, recoveryHash: hashSecret(recoveryCode) }).where(eq(identities.id, row.id));
    return { identity: (await this.identities.refresh(row.id))!, recoveryCode };
  }

  async login(handle: unknown, password: unknown, meta: SessionMeta): Promise<{ identity: IdentityPublic; key: string }> {
    const row = await this.lockedByHandle(handle);
    const ok = await verify(password, row?.passwordHash ?? null);
    if (!ok || !row) throw badPassword();
    return { identity: toPublic(row), key: await this.identities.newSession(row.id, meta) };
  }

  async changePassword(identity: IdentityPublic, current: unknown, next: unknown, keepSessionId: string | null): Promise<void> {
    const row = await this.require(identity.id);
    if (!row.passwordHash) throw notLocked();
    if (!(await verify(current, row.passwordHash))) throw unauthorized('BAD_PASSWORD', "That isn't your current password.");
    const passwordHash = await hashPassword(newPassword(next));
    await this.db.update(identities).set({ passwordHash }).where(eq(identities.id, row.id));
    await this.revokeOthers(row.id, keepSessionId);
  }

  async recover(
    handle: unknown,
    code: unknown,
    password: unknown,
    meta: SessionMeta,
  ): Promise<{ identity: IdentityPublic; key: string; recoveryCode: string }> {
    const row = await this.lockedByHandle(handle);
    const given = typeof code === 'string' ? hashSecret(code.trim()) : '';
    if (!row || !row.recoveryHash || given !== row.recoveryHash) throw badCode();
    const passwordHash = await hashPassword(newPassword(password));
    const recoveryCode = newSecret('csr_');
    await this.db.update(identities).set({ passwordHash, recoveryHash: hashSecret(recoveryCode) }).where(eq(identities.id, row.id));
    await this.revokeOthers(row.id, null);
    const key = await this.identities.newSession(row.id, meta);
    return { identity: toPublic(row), key, recoveryCode };
  }

  /** An admin's way back in for a player: replaces the recovery code and returns the new one. */
  async issueResetCode(identityId: string): Promise<string> {
    const row = await this.require(identityId);
    if (!row.passwordHash) throw notLocked();
    const code = newSecret('csr_');
    await this.db.update(identities).set({ recoveryHash: hashSecret(code) }).where(eq(identities.id, row.id));
    return code;
  }

  async sessions(identityId: string, currentSessionId: string | null): Promise<SessionInfo[]> {
    const rows = await this.db.select().from(sessions).where(eq(sessions.identityId, identityId)).orderBy(desc(sessions.lastUsedAt));
    return rows.map((s) => ({
      id: s.id,
      label: s.label,
      ip: s.ip,
      createdAt: s.createdAt.toISOString(),
      lastUsedAt: s.lastUsedAt.toISOString(),
      current: s.id === currentSessionId,
    }));
  }

  async revokeSession(identityId: string, sessionId: string): Promise<boolean> {
    const gone = await this.db
      .delete(sessions)
      .where(and(eq(sessions.identityId, identityId), eq(sessions.id, sessionId)))
      .returning({ id: sessions.id });
    this.identities.evict(identityId);
    return gone.length > 0;
  }

  async revokeOthers(identityId: string, keepSessionId: string | null): Promise<number> {
    const where = keepSessionId
      ? and(eq(sessions.identityId, identityId), ne(sessions.id, keepSessionId))
      : eq(sessions.identityId, identityId);
    const gone = await this.db.delete(sessions).where(where).returning({ id: sessions.id });
    this.identities.evict(identityId);
    return gone.length;
  }

  async revokeByIp(ip: string): Promise<number> {
    const gone = await this.db.delete(sessions).where(eq(sessions.ip, ip)).returning({ identityId: sessions.identityId });
    for (const id of new Set(gone.map((g) => g.identityId))) this.identities.evict(id);
    return gone.length;
  }

  /**
   * Gives a name back. The row stays, because match records point at it; its handle becomes a
   * tombstone nobody can type, and everything personal goes, its role included. Idempotent.
   * `idleBefore` is the idle sweep's re-check, made in the same UPDATE: the name is released only
   * if it is still an unlocked plain guest last seen before then, so one that locks or comes back
   * between the sweep's selection and this call stays. An admin's or your own release passes none.
   * Hooks (dropping relations, lifting sanctions) run only when the release actually happened.
   * Returns whether it did.
   */
  async release(identityId: string, idleBefore?: Date): Promise<boolean> {
    const tomb = `~${identityId}`;
    const where: SQL[] = [eq(identities.id, identityId), isNull(identities.releasedAt)];
    if (idleBefore) {
      where.push(isNull(identities.passwordHash), eq(identities.role, 'user'), lt(identities.lastSeenAt, idleBefore));
    }
    const done = await this.db
      .update(identities)
      .set({
        handle: tomb,
        handleLower: tomb.toLowerCase(),
        tagline: null,
        passwordHash: null,
        recoveryHash: null,
        email: null,
        ownerId: null,
        role: 'user',
        secretHash: `released:${identityId}`,
        releasedAt: new Date(this.clock.now()),
      })
      .where(and(...where))
      .returning({ id: identities.id });
    if (done.length === 0) return false;
    for (const hook of this.releaseHooks) await hook(identityId);
    await this.db.delete(sessions).where(eq(sessions.identityId, identityId));
    this.identities.evict(identityId);
    return true;
  }

  async deleteSelf(identity: IdentityPublic, password: unknown): Promise<void> {
    this.guard.assert(identity, 'profile');
    const row = await this.require(identity.id);
    if (row.passwordHash && !(await verify(password, row.passwordHash))) {
      throw unauthorized('BAD_PASSWORD', 'Send your password to delete a locked name.');
    }
    await this.release(row.id);
  }

  async setBio(identity: IdentityPublic, raw: unknown): Promise<IdentityPublic> {
    this.guard.assert(identity, 'profile');
    let tagline: string | null = null;
    if (raw !== undefined && raw !== null && raw !== '') {
      if (typeof raw !== 'string') throw badRequest('BAD_FIELD', 'tagline must be a string.');
      const text = raw.trim();
      if (text.length > BIO_MAX) throw badRequest('BAD_FIELD', `tagline is at most ${BIO_MAX} characters.`);
      tagline = text ? censorText(text) : null;
    }
    const row = await this.require(identity.id);
    await this.db.update(identities).set({ tagline }).where(eq(identities.id, row.id));
    return (await this.identities.refresh(row.id))!;
  }

  /** Releases guest names nobody has used for a while. Locked names, staff, agents and house bots stay. */
  async sweepIdle(): Promise<number> {
    const now = this.clock.now();
    const candidates = await this.db
      .select({
        id: identities.id,
        lastSeenAt: identities.lastSeenAt,
        played: sql<boolean>`exists (select 1 from ${matchPlayers} where ${matchPlayers.identityId} = ${identities.id})`,
      })
      .from(identities)
      .where(
        and(
          eq(identities.kind, 'human'),
          eq(identities.isHouse, false),
          eq(identities.role, 'user'),
          isNull(identities.passwordHash),
          isNull(identities.releasedAt),
          lt(identities.lastSeenAt, new Date(now - this.idleGuestMs)),
        ),
      );
    let released = 0;
    for (const c of candidates) {
      const idleBefore = new Date(now - (c.played ? this.idleMatchedMs : this.idleGuestMs));
      if (c.lastSeenAt >= idleBefore) continue;
      if (await this.release(c.id, idleBefore)) released += 1;
    }
    return released;
  }
}
