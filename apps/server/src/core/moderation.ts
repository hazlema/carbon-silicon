import { and, desc, eq, gt, ilike, inArray, isNull, lt, or, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type {
  IdentityPublic,
  ModActionKind,
  ModLogEntry,
  PersonDetail,
  PersonSummary,
  SanctionInfo,
  SanctionKind,
} from '@cs/shared/protocol';
import type { DB } from '../db';
import { identities, ipBans, modActions, sanctions } from '../db/schema';
import type { Clock } from '../lib/clock';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors';
import type { AccountManager } from './accounts';
import type { EventBus } from './bus';
import type { CommunicationManager } from './communication';
import type { GameManager } from './games';
import type { GuardedAction } from './guard';
import { toPublic, type IdentityManager } from './identity';
import type { InviteManager } from './invites';
import { actorName, checkPower, type Actor } from './powers';
import type { ProfileService } from './profiles';

export type PeopleFilter = 'all' | 'suspended' | 'muted' | 'mods' | 'guests' | 'agents' | 'house';
export const PEOPLE_FILTERS: readonly PeopleFilter[] = ['all', 'suspended', 'muted', 'mods', 'guests', 'agents', 'house'];

export interface ModerationDeps {
  identities: IdentityManager;
  accounts: AccountManager;
  profiles: ProfileService;
  comms: CommunicationManager;
  games: GameManager;
  invites: InviteManager;
}

interface Active {
  kind: SanctionKind;
  reason: string;
  since: number;
  endsAt: number | null;
}

/** Every moderation action carries a reason: 1–300 characters after trimming. */
export function reasonOf(raw: unknown): string {
  const reason = typeof raw === 'string' ? raw.trim() : '';
  if (reason.length < 1 || reason.length > 300) throw badRequest('BAD_REASON', 'Give a reason of 1–300 characters.');
  return reason;
}

export function peopleFilterOf(raw: unknown): PeopleFilter {
  if (raw === undefined || raw === null || raw === '') return 'all';
  if (typeof raw === 'string' && (PEOPLE_FILTERS as readonly string[]).includes(raw)) return raw as PeopleFilter;
  throw badRequest('BAD_FILTER', `filter is one of: ${PEOPLE_FILTERS.join(', ')}.`);
}

function minutesOf(raw: unknown, permanentAllowed: boolean): number | null {
  if (raw === undefined || raw === null) {
    if (permanentAllowed) return null;
    throw badRequest('BAD_MINUTES', 'Send minutes: a whole number from 1.');
  }
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1) {
    throw badRequest('BAD_MINUTES', 'minutes must be a whole number from 1.');
  }
  return raw;
}

const IP_RE = /^[0-9A-Fa-f:.]{2,64}$/;
function ipOf(raw: unknown): string {
  const ip = typeof raw === 'string' ? raw.trim() : '';
  if (!IP_RE.test(ip)) throw badRequest('BAD_IP', 'Send an IPv4 or IPv6 address, e.g. "203.0.113.7".');
  return ip;
}

const actorIdOf = (actor: Actor): string | null => (actor.kind === 'console' ? null : actor.identity.id);
const iso = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());
const untilText = (a: Active): string => (a.endsAt === null ? 'indefinitely' : `until ${new Date(a.endsAt).toISOString()}`);
const toInfo = (a: Active): SanctionInfo => ({ kind: a.kind, reason: a.reason, since: new Date(a.since).toISOString(), endsAt: iso(a.endsAt) });

/**
 * Sanctions, IP bans and the audit log. Active sanctions live in memory (loaded at boot, written
 * through to the database) and end by the clock alone: nothing needs to run when one expires.
 */
export class ModerationManager {
  private active = new Map<string, Map<SanctionKind, Active>>();
  private bans = new Set<string>();

  constructor(
    private db: DB,
    private bus: EventBus,
    private clock: Clock,
    private deps: ModerationDeps,
  ) {}

  async load(): Promise<void> {
    const now = new Date(this.clock.now());
    const rows = await this.db
      .select()
      .from(sanctions)
      .where(and(isNull(sanctions.liftedAt), or(isNull(sanctions.endsAt), gt(sanctions.endsAt, now))));
    this.active.clear();
    for (const r of rows) {
      this.remember(r.identityId, {
        kind: r.kind as SanctionKind,
        reason: r.reason,
        since: r.createdAt.getTime(),
        endsAt: r.endsAt ? r.endsAt.getTime() : null,
      });
    }
    this.bans = new Set((await this.db.select({ ip: ipBans.ip }).from(ipBans)).map((b) => b.ip));
  }

  private remember(identityId: string, a: Active): void {
    const byKind = this.active.get(identityId) ?? new Map<SanctionKind, Active>();
    byKind.set(a.kind, a);
    this.active.set(identityId, byKind);
  }

  private current(identityId: string, kind: SanctionKind): Active | null {
    const a = this.active.get(identityId)?.get(kind);
    if (!a) return null;
    if (a.endsAt !== null && a.endsAt <= this.clock.now()) {
      this.active.get(identityId)?.delete(kind);
      return null;
    }
    return a;
  }

  sanctionOf(identityId: string): SanctionInfo | null {
    const a = this.current(identityId, 'suspend') ?? this.current(identityId, 'mute');
    return a ? toInfo(a) : null;
  }

  /** Installed into the Guard: the one checkpoint both doors pass through. */
  check(identity: IdentityPublic, action: GuardedAction): void {
    const suspended = this.current(identity.id, 'suspend');
    if (suspended) throw forbidden('SUSPENDED', `You are suspended ${untilText(suspended)}: ${suspended.reason}`);
    if (action === 'chat') {
      const muted = this.current(identity.id, 'mute');
      if (muted) throw forbidden('MUTED', `You are muted ${untilText(muted)}: ${muted.reason}`);
    }
  }

  private async target(targetId: string): Promise<IdentityPublic> {
    const target = await this.deps.identities.get(targetId);
    if (!target || target.released) throw notFound('NO_USER', 'There is no such player.');
    return target;
  }

  async mute(actor: Actor, targetId: string, reason: unknown, minutes: unknown): Promise<SanctionInfo> {
    const why = reasonOf(reason);
    const mins = minutesOf(minutes, false) as number;
    const target = await this.target(targetId);
    checkPower(actor, { action: 'mute', minutes: mins }, target);
    return this.impose(actor, target, 'mute', why, mins);
  }

  async suspend(actor: Actor, targetId: string, reason: unknown, minutes: unknown): Promise<SanctionInfo> {
    const why = reasonOf(reason);
    const mins = minutesOf(minutes, true);
    const target = await this.target(targetId);
    checkPower(actor, { action: 'suspend', minutes: mins }, target);
    const info = await this.impose(actor, target, 'suspend', why, mins);
    await this.bench(target);
    return info;
  }

  /** Read-only starts now: out of the quick-match queue, and resigned from any match in progress.
   *  Used by suspend() and release() — and by DELETE /api/me after deleteSelf() succeeds, so a
   *  self-delete leaves the queue and the table the same way a moderator's release does. */
  async bench(target: IdentityPublic): Promise<void> {
    this.deps.invites.leave(target.id);
    const matchId = this.deps.games.activeMatchOf(target.id);
    if (!matchId) return;
    await this.deps.games.resign(matchId, target).catch((e) => console.error('[moderation] resign failed', e));
  }

  private async impose(actor: Actor, target: IdentityPublic, kind: SanctionKind, reason: string, minutes: number | null): Promise<SanctionInfo> {
    const now = this.clock.now();
    const endsAt = minutes === null ? null : now + minutes * 60_000;
    // A new sanction of the same kind replaces the old one, whether it is shorter or longer.
    await this.db
      .update(sanctions)
      .set({ liftedAt: new Date(now), liftedBy: actorName(actor) })
      .where(and(eq(sanctions.identityId, target.id), eq(sanctions.kind, kind), isNull(sanctions.liftedAt)));
    await this.db.insert(sanctions).values({
      identityId: target.id,
      kind,
      reason,
      actorId: actorIdOf(actor),
      createdAt: new Date(now),
      endsAt: endsAt === null ? null : new Date(endsAt),
    });
    const active: Active = { kind, reason, since: now, endsAt };
    this.remember(target.id, active);
    await this.record(actor, kind, target.id, reason, { minutes });
    this.deps.comms.deliver(target.id, { type: 'moderation', kind, reason, endsAt: iso(endsAt) });
    return toInfo(active);
  }

  async lift(actor: Actor, targetId: string, reason: unknown): Promise<void> {
    const why = reasonOf(reason);
    const target = await this.target(targetId);
    checkPower(actor, { action: 'lift' }, target);
    if (!this.current(target.id, 'suspend') && !this.current(target.id, 'mute')) {
      throw conflict('NOT_SANCTIONED', `@${target.handle} has no active mute or suspension.`);
    }
    await this.db
      .update(sanctions)
      .set({ liftedAt: new Date(this.clock.now()), liftedBy: actorName(actor) })
      .where(and(eq(sanctions.identityId, target.id), isNull(sanctions.liftedAt)));
    this.active.delete(target.id);
    await this.record(actor, 'lift', target.id, why);
    this.deps.comms.deliver(target.id, { type: 'moderation', kind: 'lift', reason: why, endsAt: null });
  }

  async setRole(actor: Actor, targetId: string, role: unknown, reason: unknown): Promise<IdentityPublic> {
    const why = reasonOf(reason);
    if (role !== 'user' && role !== 'mod' && role !== 'admin') throw badRequest('BAD_ROLE', 'role is "user", "mod" or "admin".');
    const target = await this.target(targetId);
    checkPower(actor, { action: 'role', role }, target);
    if (role === 'admin' && target.kind !== 'human') throw badRequest('BAD_ROLE', 'Only a human can be an admin.');
    if (role !== 'user' && target.kind === 'human' && !target.locked) {
      throw conflict('NOT_LOCKED', `@${target.handle} must lock their name before holding a role.`);
    }
    const updated = await this.deps.identities.setRole(target.id, role);
    this.deps.identities.evict(target.id);
    // detail.role is the new role: Task 15's web log line reads `detail.role`, not `detail.to`.
    await this.record(actor, 'role', target.id, why, { role, from: target.role });
    return updated;
  }

  async resetPassword(actor: Actor, targetId: string, reason: unknown): Promise<string> {
    const why = reasonOf(reason);
    const target = await this.target(targetId);
    checkPower(actor, { action: 'reset-password' }, target);
    if (target.kind !== 'human' || !target.locked) throw conflict('NOT_LOCKED', `@${target.handle} has no password to reset.`);
    const code = await this.deps.accounts.issueResetCode(target.id);
    await this.deps.accounts.revokeOthers(target.id, null);
    this.deps.identities.evict(target.id);
    await this.record(actor, 'reset-password', target.id, why);
    return code;
  }

  async release(actor: Actor, targetId: string, reason: unknown): Promise<void> {
    const why = reasonOf(reason);
    const target = await this.target(targetId);
    checkPower(actor, { action: 'release' }, target);
    await this.bench(target);
    // Lift any active sanction in storage too (same update as lift()), or load() at the next boot
    // would find an un-lifted row and reinstate it as still active for a released identity.
    await this.db
      .update(sanctions)
      .set({ liftedAt: new Date(this.clock.now()), liftedBy: actorName(actor) })
      .where(and(eq(sanctions.identityId, target.id), isNull(sanctions.liftedAt)));
    this.active.delete(target.id);
    // Recorded first, so the log keeps the handle the tombstone is about to erase.
    await this.record(actor, 'release', target.id, why, { handle: target.handle });
    await this.deps.accounts.release(target.id);
  }

  async banIp(actor: Actor, ip: unknown, reason: unknown): Promise<void> {
    const why = reasonOf(reason);
    const addr = ipOf(ip);
    checkPower(actor, { action: 'ip-ban' }, null);
    await this.db
      .insert(ipBans)
      .values({ ip: addr, reason: why, actorId: actorIdOf(actor), createdAt: new Date(this.clock.now()) })
      .onConflictDoUpdate({ target: ipBans.ip, set: { reason: why } });
    this.bans.add(addr);
    const signedOut = await this.deps.accounts.revokeByIp(addr);
    await this.record(actor, 'ip-ban', null, why, { ip: addr, signedOut });
  }

  async unbanIp(actor: Actor, ip: unknown, reason: unknown): Promise<void> {
    const why = reasonOf(reason);
    const addr = ipOf(ip);
    checkPower(actor, { action: 'ip-unban' }, null);
    const gone = await this.db.delete(ipBans).where(eq(ipBans.ip, addr)).returning({ ip: ipBans.ip });
    if (gone.length === 0) throw notFound('NO_BAN', `${addr} is not banned.`);
    this.bans.delete(addr);
    await this.record(actor, 'ip-unban', null, why, { ip: addr });
  }

  isIpBanned(ip: string | null): boolean {
    return ip !== null && this.bans.has(ip);
  }

  async record(actor: Actor, action: ModActionKind, targetId: string | null, reason: string, detail: Record<string, unknown> = {}): Promise<void> {
    await this.db.insert(modActions).values({
      actorId: actorIdOf(actor),
      actorName: actorName(actor),
      targetId,
      action,
      reason,
      detail,
      createdAt: new Date(this.clock.now()),
    });
  }

  async log(opts: { before?: number; targetId?: string; limit?: number } = {}): Promise<ModLogEntry[]> {
    const targetRow = alias(identities, 'target_identity');
    const where: SQL[] = [];
    if (opts.before !== undefined) where.push(lt(modActions.id, opts.before));
    if (opts.targetId) where.push(eq(modActions.targetId, opts.targetId));
    const rows = await this.db
      .select({ a: modActions, target: targetRow })
      .from(modActions)
      .leftJoin(targetRow, eq(modActions.targetId, targetRow.id))
      .where(where.length > 0 ? and(...where) : undefined)
      .orderBy(desc(modActions.id))
      .limit(Math.min(200, Math.max(1, opts.limit ?? 50)));
    return rows.map(({ a, target }) => ({
      id: a.id,
      actor: a.actorName,
      target: target ? toPublic(target) : null,
      action: a.action as ModActionKind,
      reason: a.reason,
      detail: (a.detail ?? {}) as Record<string, unknown>,
      createdAt: a.createdAt.toISOString(),
    }));
  }

  async people(q: string, filter: PeopleFilter): Promise<PersonSummary[]> {
    const where: SQL[] = [isNull(identities.releasedAt)];
    const needle = q.trim().toLowerCase();
    if (needle) where.push(ilike(identities.handleLower, `%${needle.replace(/[\\%_]/g, '\\$&')}%`));
    if (filter === 'mods') where.push(inArray(identities.role, ['mod', 'admin']));
    if (filter === 'guests') where.push(eq(identities.kind, 'human'), isNull(identities.passwordHash));
    if (filter === 'agents') where.push(eq(identities.kind, 'agent'));
    if (filter === 'house') where.push(eq(identities.isHouse, true));
    if (filter === 'suspended' || filter === 'muted') {
      const kind: SanctionKind = filter === 'suspended' ? 'suspend' : 'mute';
      const ids = [...this.active.keys()].filter((id) => this.current(id, kind));
      if (ids.length === 0) return [];
      where.push(inArray(identities.id, ids));
    }
    const rows = await this.db
      .select()
      .from(identities)
      .where(and(...where))
      .orderBy(desc(identities.lastSeenAt))
      .limit(50);
    return rows.map((row) => ({ identity: toPublic(row), sanction: this.sanctionOf(row.id), lastSeenAt: row.lastSeenAt.toISOString() }));
  }

  async person(handle: string): Promise<PersonDetail> {
    const profile = await this.deps.profiles.profile(handle);
    const id = profile.identity.id;
    const [row, sessions, history] = await Promise.all([
      this.deps.identities.row(id),
      this.deps.accounts.sessions(id, null),
      this.log({ targetId: id, limit: 100 }),
    ]);
    return { profile, sanction: this.sanctionOf(id), sessions: sessions.length, lastIp: row?.lastIp ?? null, history };
  }
}
