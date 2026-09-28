import {
  tableChannel,
  type IdentityPublic,
  type InviteOffer,
  type MatchSummary,
  type TableInfo,
  type TableInvite,
  type TableStatus,
} from '@cs/shared/protocol';
import type { Clock } from '../lib/clock';
import { AppError, badRequest, conflict, forbidden, gone, notFound, tooMany } from '../lib/errors';
import { newId } from '../lib/ids';
import { RateLimiter } from '../lib/ratelimit';
import type { EventBus } from './bus';
import type { CommunicationManager } from './communication';
import type { GameManager } from './games';
import type { Guard } from './guard';
import type { IdentityManager } from './identity';
import type { PresenceManager } from './presence';
import type { RelationManager } from './relations';

export interface TableDeps {
  games: GameManager;
  presence: PresenceManager;
  comms: CommunicationManager;
  identities: IdentityManager;
  relations: RelationManager;
  guard: Guard;
  bus: EventBus;
  clock: Clock;
}

export interface TableOptions {
  inviteMs: number;
  idleMs: number;
  retainMs: number;
  declineCooldownMs: number;
  invitesPerMinute: number;
  /** Seat order for a new match; tests pass the identity function. */
  shuffle: <T>(items: T[]) => T[];
}

function shuffled<T>(items: T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

const DEFAULTS: TableOptions = {
  inviteMs: 60_000,
  idleMs: 10 * 60_000,
  retainMs: 30 * 60_000,
  declineCooldownMs: 2 * 60_000,
  invitesPerMinute: 10,
  shuffle: shuffled,
};

interface Invite {
  id: string;
  tableId: string;
  to: IdentityPublic;
  expiresAt: number;
  timer: unknown;
}

interface Table {
  id: string;
  gameId: string;
  host: IdentityPublic;
  status: TableStatus;
  open: boolean;
  seated: IdentityPublic[];
  invites: Invite[];
  lastPlayers: IdentityPublic[];
  matchId: string | null;
  watching: number;
  /** The idle timer while forming, the retention timer once finished. */
  timer: unknown;
  /** System lines go out one after another, in order. */
  lines: Promise<unknown>;
}

const wire = (i: Invite): TableInvite => ({ id: i.id, to: i.to, expiresAt: new Date(i.expiresAt).toISOString() });
const bare = (handle: string) => handle.trim().replace(/^@/, '');
const unavailable = (who: IdentityPublic) => conflict('NOT_AVAILABLE', `@${who.handle} can't take an invite right now.`);
const fullText = (t: { host: IdentityPublic }) => `The table is full — @${t.host.handle}, start when you're ready.`;

/** 1–3 handles, as an array of strings (a single string is accepted too). */
function handlesOf(raw: unknown): string[] {
  const list = typeof raw === 'string' ? [raw] : raw;
  if (!Array.isArray(list) || list.length === 0 || list.length > 3 || !list.every((h) => typeof h === 'string' && bare(h))) {
    throw badRequest('BAD_HANDLES', 'Send {"handles": ["someone"]}: one to three names.');
  }
  return list.map((h: string) => bare(h));
}

/**
 * Tables (spec M2b §2): a host, a game, and up to the game's maxPlayers seats, filled by invites
 * or, at an open table, by anyone. The host presses Start; the match runs at the table; a rematch
 * gathers the same table again. Everything lives in memory, like running matches.
 */
export class TableManager {
  private tables = new Map<string, Table>();
  /** identityId → the table they sit at (forming, starting or playing). */
  private seatOf = new Map<string, string>();
  private invites = new Map<string, Invite>();
  /** `${hostId}:${targetId}` → when the host may invite them again. */
  private declined = new Map<string, number>();
  private limiter: RateLimiter;
  private leaveQueue: (identityId: string) => void = () => {};
  private opts: TableOptions;

  constructor(
    private deps: TableDeps,
    opts: Partial<TableOptions> = {},
  ) {
    this.opts = { ...DEFAULTS, ...opts };
    this.limiter = new RateLimiter(deps.clock, this.opts.invitesPerMinute, this.opts.invitesPerMinute / 60_000);
    deps.comms.setTableAccess((tableId) => {
      const t = this.tables.get(tableId);
      return t ? { posters: this.posters(t) } : null;
    });
    deps.bus.on('match.finished', ({ matchId, tableId }) => {
      if (tableId) this.onFinished(tableId, matchId);
    });
    deps.bus.on('presence.changed', (p) => {
      if (p.status !== 'ready') this.onUnavailable(p.identity.id);
    });
  }

  /** Sitting down takes you out of the quick-match queue (InviteManager installs this). */
  setQueueLeaver(fn: (identityId: string) => void): void {
    this.leaveQueue = fn;
  }

  // ── reads ──

  get(tableId: string, viewerId: string | null): TableInfo {
    return this.info(this.require(tableId), viewerId);
  }

  /** The lobby's list: open tables still gathering, and tables playing now. Never shows invites. */
  list(): TableInfo[] {
    return [...this.tables.values()]
      .filter((t) => (t.status === 'forming' && t.open) || t.status === 'playing')
      .map((t) => this.info(t, null));
  }

  tableFor(identityId: string): TableInfo | null {
    const id = this.atTable(identityId);
    return id ? this.info(this.tables.get(id)!, identityId) : null;
  }

  offersFor(identityId: string): InviteOffer[] {
    const out: InviteOffer[] = [];
    for (const inv of this.invites.values()) {
      const t = this.tables.get(inv.tableId);
      if (t && inv.to.id === identityId) out.push({ invite: wire(inv), from: t.host, table: this.info(t, identityId) });
    }
    return out;
  }

  /** The table someone is at. A player already out of a running match is no longer "at" it. */
  atTable(identityId: string): string | null {
    const id = this.seatOf.get(identityId);
    const t = id ? this.tables.get(id) : undefined;
    if (!t) return null;
    if (t.status === 'playing' && this.deps.games.activeMatchOf(identityId) !== t.matchId) return null;
    return t.id;
  }

  /** At a table, or holding an invite to one (quick match's house fallback skips them). */
  isBusy(identityId: string): boolean {
    if (this.atTable(identityId)) return true;
    for (const inv of this.invites.values()) if (inv.to.id === identityId) return true;
    return false;
  }

  // ── gathering ──

  async host(identity: IdentityPublic, gameId: unknown, opts: { invite?: unknown; open?: unknown } = {}): Promise<TableInfo> {
    if (typeof gameId !== 'string') throw badRequest('BAD_GAME', 'Send {"gameId": "critical-mass"}.');
    const meta = this.deps.games.module(gameId).meta;
    if (identity.isHouse) throw forbidden('HOUSE_WAITS', 'House bots join tables; they never host.');
    this.assertFree(identity);
    if (this.atTable(identity.id)) throw conflict('AT_TABLE', "You're already at a table. Leave it first.");
    if (opts.open !== undefined && typeof opts.open !== 'boolean') throw badRequest('BAD_FIELD', 'open is true or false.');
    const t: Table = {
      id: newId('t'),
      gameId,
      host: identity,
      status: 'forming',
      open: opts.open === true,
      seated: [],
      invites: [],
      lastPlayers: [],
      matchId: null,
      watching: 0,
      timer: null,
      lines: Promise.resolve(),
    };
    this.tables.set(t.id, t);
    this.seat(t, identity);
    this.say(t, `@${identity.handle} opened a table for ${meta.name}.`);
    this.touch(t);
    if (opts.invite === undefined) {
      this.changed(t);
    } else {
      try {
        await this.invite(identity, t.id, opts.invite);
      } catch (e) {
        this.close(t, 'cancelled');
        throw e;
      }
    }
    return this.info(t, identity.id);
  }

  async invite(identity: IdentityPublic, tableId: string, rawHandles: unknown): Promise<TableInfo> {
    const t = this.asHost(identity, tableId);
    this.assertForming(t);
    const handles = handlesOf(rawHandles);
    const targets: IdentityPublic[] = [];
    for (const handle of handles) {
      const who = await this.deps.identities.getByHandle(handle);
      if (!who || who.released) throw notFound('NO_USER', `There is no @${handle}.`);
      if (who.id === identity.id) throw badRequest('SELF', "You're already at your own table.");
      if (!targets.some((x) => x.id === who.id)) targets.push(who);
    }
    for (const who of targets) {
      if (await this.deps.relations.blocks(who.id, identity.id)) throw unavailable(who);
    }
    // From here on nothing awaits, so the checks and the writes see the same table.
    this.assertForming(t);
    const now = this.deps.clock.now();
    for (const who of targets) {
      if (t.seated.some((x) => x.id === who.id) || t.invites.some((x) => x.to.id === who.id)) {
        throw conflict('ALREADY_INVITED', `@${who.handle} is already at this table.`);
      }
      if (!this.available(who)) throw unavailable(who);
      if ((this.declined.get(`${identity.id}:${who.id}`) ?? 0) > now) {
        throw tooMany('SLOW_DOWN', `@${who.handle} said no a moment ago. Give it a couple of minutes.`);
      }
    }
    if (this.taken(t) + targets.length > this.size(t)) throw conflict('TABLE_FULL', fullText(t));
    let spent = 0;
    for (; spent < targets.length; spent++) {
      if (!this.limiter.take(identity.id)) {
        for (let i = 0; i < spent; i++) this.limiter.refund(identity.id);
        throw tooMany('SLOW_DOWN', 'That is a lot of invites. Give it a minute.');
      }
    }
    for (const who of targets) this.addInvite(t, identity, who);
    this.touch(t);
    this.changed(t);
    return this.info(t, identity.id);
  }

  accept(identity: IdentityPublic, inviteId: string): TableInfo {
    const inv = this.invites.get(inviteId);
    const t = inv ? this.tables.get(inv.tableId) : undefined;
    if (!inv || !t || inv.to.id !== identity.id) throw gone('INVITE_GONE', 'That invite has expired, or the table is gone.');
    this.assertForming(t);
    this.assertFree(identity);
    this.forgetInvite(inv);
    this.seat(t, identity);
    this.deps.comms.deliver(t.host.id, { type: 'invite.answered', inviteId: inv.id, tableId: t.id, who: identity, answer: 'accepted' });
    this.sat(t, identity);
    return this.info(t, identity.id);
  }

  decline(identity: IdentityPublic, inviteId: string): void {
    const inv = this.invites.get(inviteId);
    if (!inv || inv.to.id !== identity.id) throw gone('INVITE_GONE', 'That invite has expired, or the table is gone.');
    this.forgetInvite(inv);
    const t = this.tables.get(inv.tableId);
    if (!t) return;
    this.declined.set(`${t.host.id}:${identity.id}`, this.deps.clock.now() + this.opts.declineCooldownMs);
    this.deps.comms.deliver(t.host.id, { type: 'invite.answered', inviteId: inv.id, tableId: t.id, who: identity, answer: 'declined' });
    this.say(t, `@${identity.handle} declined.`);
    this.changed(t);
  }

  async sit(identity: IdentityPublic, tableId: string): Promise<TableInfo> {
    const t = this.require(tableId);
    this.assertForming(t);
    if (t.seated.some((x) => x.id === identity.id)) return this.info(t, identity.id);
    const mine = t.invites.find((i) => i.to.id === identity.id);
    if (mine) return this.accept(identity, mine.id);
    if (!t.open) throw forbidden('NOT_OPEN', 'This table is invite-only.');
    this.assertFree(identity);
    if (await this.deps.relations.blocks(t.host.id, identity.id)) throw forbidden('NOT_OPEN', 'This table is invite-only.');
    this.assertForming(t);
    if (this.taken(t) >= this.size(t)) throw conflict('TABLE_FULL', fullText(t));
    this.seat(t, identity);
    this.sat(t, identity);
    return this.info(t, identity.id);
  }

  leave(identity: IdentityPublic, tableId: string): void {
    const t = this.require(tableId);
    if (!t.seated.some((x) => x.id === identity.id)) throw forbidden('NOT_SEATED', "You're not at this table.");
    if (t.status !== 'forming') throw conflict('TABLE_BUSY', 'The match is on. Resign to leave it.');
    this.unseat(t, identity.id, 'left');
  }

  remove(identity: IdentityPublic, tableId: string, rawHandle: unknown): TableInfo {
    const t = this.asHost(identity, tableId);
    this.assertForming(t);
    const handle = typeof rawHandle === 'string' ? bare(rawHandle).toLowerCase() : '';
    const inv = t.invites.find((i) => i.to.handle.toLowerCase() === handle);
    if (inv) {
      this.dropInvite(inv, 'withdrawn');
      this.touch(t);
      this.changed(t);
      return this.info(t, identity.id);
    }
    const who = t.seated.find((x) => x.handle.toLowerCase() === handle && x.id !== t.host.id);
    if (!who) throw notFound('NOT_SEATED', `@${handle} isn't at this table.`);
    this.unseat(t, who.id, 'removed');
    return this.info(t, identity.id);
  }

  setOpen(identity: IdentityPublic, tableId: string, open: unknown): TableInfo {
    const t = this.asHost(identity, tableId);
    this.assertForming(t);
    if (typeof open !== 'boolean') throw badRequest('BAD_FIELD', 'open is true or false.');
    t.open = open;
    this.touch(t);
    this.changed(t);
    return this.info(t, identity.id);
  }

  async start(identity: IdentityPublic, tableId: string): Promise<MatchSummary> {
    const t = this.asHost(identity, tableId);
    this.assertForming(t);
    const meta = this.deps.games.module(t.gameId).meta;
    if (t.seated.length < meta.minPlayers) {
      const short = meta.minPlayers - t.seated.length;
      throw conflict('NOT_ENOUGH', `${meta.name} needs at least ${meta.minPlayers} players — invite ${short} more to start.`);
    }
    return this.launch(t);
  }

  disband(identity: IdentityPublic, tableId: string): void {
    const t = this.asHost(identity, tableId);
    if (t.status === 'starting' || t.status === 'playing') throw conflict('TABLE_BUSY', 'The match is on. Resign to leave it.');
    this.close(t, 'disbanded');
  }

  // ── inner workings ──

  private require(tableId: string): Table {
    const t = this.tables.get(tableId);
    if (!t) throw notFound('NO_TABLE', 'There is no such table. It may have been cleared.');
    return t;
  }

  private asHost(identity: IdentityPublic, tableId: string): Table {
    const t = this.require(tableId);
    if (t.host.id !== identity.id) throw forbidden('NOT_HOST', 'Only the host can do that.');
    return t;
  }

  private assertForming(t: Table): void {
    if (t.status !== 'forming' || !this.tables.has(t.id)) {
      throw conflict('TABLE_BUSY', 'That table is not gathering players right now.');
    }
  }

  /** The caller may take a seat: allowed to play, not in a match, and ready. */
  private assertFree(identity: IdentityPublic): void {
    this.deps.guard.assert(identity, 'play');
    if (this.deps.games.activeMatchOf(identity.id)) throw conflict('IN_MATCH', 'Finish your current match first.');
    if (!this.deps.presence.isReady(identity.id)) throw conflict('NOT_READY', 'Set your status to ready first.');
  }

  /** Could this person take an invite right now? (Blocks are checked separately; they need the database.) */
  private available(who: IdentityPublic): boolean {
    if (!this.deps.presence.isReady(who.id) || this.deps.games.activeMatchOf(who.id)) return false;
    try {
      this.deps.guard.assert(who, 'play');
      return true;
    } catch (e) {
      if (e instanceof AppError) return false;
      throw e;
    }
  }

  private size(t: Table): number {
    return this.deps.games.module(t.gameId).meta.maxPlayers;
  }

  private taken(t: Table): number {
    return t.seated.length + t.invites.length;
  }

  private posters(t: Table): string[] {
    return [...new Set([...t.seated, ...t.lastPlayers].map((p) => p.id))];
  }

  private info(t: Table, viewerId: string | null): TableInfo {
    const meta = this.deps.games.module(t.gameId).meta;
    const insider = viewerId !== null && (t.seated.some((p) => p.id === viewerId) || t.invites.some((i) => i.to.id === viewerId));
    return {
      id: t.id,
      gameId: t.gameId,
      host: t.host,
      status: t.status,
      open: t.open,
      size: meta.maxPlayers,
      minPlayers: meta.minPlayers,
      seated: [...t.seated],
      invites: insider ? t.invites.map(wire) : [],
      lastPlayers: [...t.lastPlayers],
      matchId: t.matchId,
      watching: t.watching,
    };
  }

  /** Everyone at the table (seated, invited, and after a match its players) hears about every change. */
  private changed(t: Table): void {
    const ids = new Set([...t.seated.map((p) => p.id), ...t.invites.map((i) => i.to.id)]);
    if (t.status === 'finished') for (const p of t.lastPlayers) ids.add(p.id);
    for (const id of ids) this.deps.comms.deliver(id, { type: 'table.updated', table: this.info(t, id) });
    this.deps.bus.emit('table.changed', { tableId: t.id });
  }

  private say(t: Table, text: string): void {
    t.lines = t.lines
      .then(() => this.deps.comms.postSystem(tableChannel(t.id), text))
      .catch((e) => console.error('[tables] system line failed', e));
  }

  /** (Re)arms the forgotten-table timer; every seat or invite change calls it while forming. */
  private touch(t: Table): void {
    this.deps.clock.clearTimeout(t.timer);
    t.timer = this.deps.clock.setTimeout(() => this.close(t, 'idle'), this.opts.idleMs);
  }

  private seat(t: Table, identity: IdentityPublic): void {
    const other = this.seatOf.get(identity.id);
    if (other && other !== t.id) {
      const o = this.tables.get(other);
      if (o?.status === 'forming') this.unseat(o, identity.id, 'left');
      else this.seatOf.delete(identity.id);
    }
    this.leaveQueue(identity.id);
    t.seated.push(identity);
    this.seatOf.set(identity.id, t.id);
  }

  private sat(t: Table, who: IdentityPublic): void {
    this.say(t, `@${who.handle} sat down.`);
    if (t.seated.length === this.size(t)) this.say(t, fullText(t));
    this.touch(t);
    this.changed(t);
  }

  /** Someone leaves a forming table (the host leaving disbands it). They're told why. */
  private unseat(t: Table, identityId: string, reason: 'left' | 'removed' | 'away'): void {
    if (t.host.id === identityId) {
      this.close(t, 'host-left');
      return;
    }
    const who = t.seated.find((p) => p.id === identityId);
    if (!who) return;
    t.seated = t.seated.filter((p) => p.id !== identityId);
    if (this.seatOf.get(identityId) === t.id) this.seatOf.delete(identityId);
    this.deps.comms.deliver(identityId, { type: 'table.closed', tableId: t.id, reason });
    this.say(t, `@${who.handle} left the table.`);
    this.touch(t);
    this.changed(t);
  }

  private addInvite(t: Table, from: IdentityPublic, to: IdentityPublic): void {
    const inv: Invite = { id: newId('i'), tableId: t.id, to, expiresAt: this.deps.clock.now() + this.opts.inviteMs, timer: null };
    inv.timer = this.deps.clock.setTimeout(() => this.expire(inv.id), this.opts.inviteMs);
    t.invites.push(inv);
    this.invites.set(inv.id, inv);
    this.deps.comms.deliver(to.id, { type: 'invite.received', invite: wire(inv), from, table: this.info(t, to.id) });
  }

  /** Takes an invite off its table without telling anyone. */
  private forgetInvite(inv: Invite): void {
    this.deps.clock.clearTimeout(inv.timer);
    this.invites.delete(inv.id);
    const t = this.tables.get(inv.tableId);
    if (t) t.invites = t.invites.filter((i) => i.id !== inv.id);
  }

  /** Takes an invite away and tells the invitee why. */
  private dropInvite(inv: Invite, reason: string): void {
    this.forgetInvite(inv);
    this.deps.comms.deliver(inv.to.id, { type: 'invite.cancelled', inviteId: inv.id, tableId: inv.tableId, reason });
  }

  private expire(inviteId: string): void {
    const inv = this.invites.get(inviteId);
    if (!inv) return;
    this.dropInvite(inv, 'expired');
    const t = this.tables.get(inv.tableId);
    if (!t) return;
    this.deps.comms.deliver(t.host.id, { type: 'invite.answered', inviteId: inv.id, tableId: t.id, who: inv.to, answer: 'expired' });
    this.say(t, `@${inv.to.handle}'s invite expired — the seat is empty.`);
    this.changed(t);
  }

  private async launch(t: Table): Promise<MatchSummary> {
    t.status = 'starting';
    this.deps.clock.clearTimeout(t.timer);
    t.timer = null;
    for (const inv of [...t.invites]) this.dropInvite(inv, 'started');
    const players = this.opts.shuffle(t.seated);
    try {
      const match = await this.deps.games.createMatch(t.gameId, players, { tableId: t.id });
      t.status = 'playing';
      t.matchId = match.id;
      t.lastPlayers = players;
      this.changed(t);
      return match;
    } catch (e) {
      t.status = 'forming';
      this.touch(t);
      this.changed(t);
      throw e;
    }
  }

  private onFinished(tableId: string, matchId: string): void {
    const t = this.tables.get(tableId);
    if (!t || t.matchId !== matchId) return;
    t.status = 'finished';
    for (const p of t.seated) if (this.seatOf.get(p.id) === t.id) this.seatOf.delete(p.id);
    t.seated = [];
    this.deps.clock.clearTimeout(t.timer);
    t.timer = this.deps.clock.setTimeout(() => this.close(t, 'done'), this.opts.retainMs);
    this.changed(t);
  }

  /** Not ready any more (AFK, playing, offline): invites to them go, and they lose a forming seat. */
  private onUnavailable(identityId: string): void {
    for (const inv of [...this.invites.values()]) {
      if (inv.to.id !== identityId) continue;
      this.dropInvite(inv, 'unavailable');
      const t = this.tables.get(inv.tableId);
      if (t) this.changed(t);
    }
    const id = this.seatOf.get(identityId);
    const t = id ? this.tables.get(id) : undefined;
    if (t?.status === 'forming') this.unseat(t, identityId, 'away');
  }

  private close(t: Table, reason: string): void {
    if (!this.tables.has(t.id)) return;
    this.deps.clock.clearTimeout(t.timer);
    for (const inv of [...t.invites]) this.dropInvite(inv, reason);
    for (const p of t.seated) {
      if (this.seatOf.get(p.id) === t.id) this.seatOf.delete(p.id);
      this.deps.comms.deliver(p.id, { type: 'table.closed', tableId: t.id, reason });
    }
    t.seated = [];
    this.tables.delete(t.id);
    this.deps.bus.emit('table.changed', { tableId: t.id });
  }
}
