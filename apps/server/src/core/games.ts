import { and, eq, inArray } from 'drizzle-orm';
import { createRng, GameRuleError, validateDoctrine, type Action, type GameModule, type Outcome, type Rng, type SeatId } from '@cs/game-api';
import {
  seasonOf,
  tableChannel,
  type DoctrineAck,
  type GameInfo,
  type IdentityPublic,
  type MatchEnvelope,
  type MatchStatus,
  type MatchSummary,
  type SeatInfo,
} from '@cs/shared/protocol';
import type { DB } from '../db';
import { matches, matchPlayers } from '../db/schema';
import type { Clock } from '../lib/clock';
import { AppError, badRequest, conflict, forbidden, notFound } from '../lib/errors';
import { newId } from '../lib/ids';
import type { EventBus } from './bus';
import type { CommunicationManager } from './communication';
import type { Guard } from './guard';
import type { PresenceManager } from './presence';
import { DoctrineDesk, FLOOR_DEFAULT_MS, floorTicks } from './realtime';

export interface GameManagerOptions {
  countdownMs: number;
  maxTimeouts: number;
  retainMs: number;
  seed: () => number;
  /** The reaction floor for machines in real-time games (DOCTRINE_FLOOR_MS). */
  doctrineFloorMs: number;
  /** Tests only: a faster tick and a shorter countdown than the game's own. */
  realtimeTickMs?: number;
  realtimeCountdownMs?: number;
}

const DEFAULTS: GameManagerOptions = {
  countdownMs: 3000,
  maxTimeouts: 3,
  retainMs: 30 * 60_000,
  seed: () => Math.floor(Math.random() * 2 ** 31),
  doctrineFloorMs: FLOOR_DEFAULT_MS,
};

interface LiveMatch {
  id: string;
  gameId: string;
  tableId: string | null;
  module: GameModule<any>;
  state: unknown;
  seats: SeatInfo[];
  status: MatchStatus;
  revision: number;
  startsAt: number;
  deadline: number | null;
  timeouts: Record<SeatId, number>;
  outcome: Outcome | null;
  endReason: string | null;
  timer: unknown;
  failures: number;
  waiters: Set<() => void>;
  rng: Rng;
  desk: DoctrineDesk | null;
}

const resultFor = (o: Outcome, seat: SeatId): 'win' | 'loss' | 'draw' =>
  o.winners.length === 0 ? 'draw' : o.winners.includes(seat) ? 'win' : 'loss';

/** A real-time match whose ticks fail this many times in a row is abandoned. */
const MAX_TICK_FAILURES = 20;

export class GameManager {
  private matches = new Map<string, LiveMatch>();
  private active = new Map<string, string>();
  private closed = false;
  private modules: Map<string, GameModule<any>>;
  private opts: GameManagerOptions;

  constructor(
    private db: DB,
    private bus: EventBus,
    private clock: Clock,
    private comms: CommunicationManager,
    private presence: PresenceManager,
    modules: GameModule<any>[],
    private guard: Guard,
    opts: Partial<GameManagerOptions> = {},
  ) {
    this.modules = new Map(modules.map((m) => [m.meta.id, m]));
    this.opts = { ...DEFAULTS, ...opts };
    // A match without a table (tests, and anything from before tables) keeps its own channel.
    comms.setMatchAccess((matchId) => {
      const ids = this.playerIds(matchId);
      return ids ? { posters: ids } : null;
    });
  }

  catalog(): GameInfo[] {
    return [...this.modules.values()].map(({ meta }) => ({
      id: meta.id,
      name: meta.name,
      tagline: meta.tagline,
      mode: meta.mode,
      minPlayers: meta.minPlayers,
      maxPlayers: meta.maxPlayers,
      seats: meta.seats,
      humans: meta.humans,
      thumbnail: meta.thumbnail ? `/api/games/${meta.id}/files/${meta.thumbnail}` : null,
    }));
  }

  get doctrineFloorMs(): number {
    return this.opts.doctrineFloorMs;
  }

  module(gameId: string): GameModule<any> {
    const m = this.modules.get(gameId);
    if (!m) throw notFound('NO_GAME', `There is no game "${gameId}". See GET /api/games.`);
    return m;
  }

  /** A machines-only game refuses a human, whichever door they come through. */
  assertPlayable(identity: IdentityPublic, gameId: string): void {
    const meta = this.module(gameId).meta;
    if (identity.kind === 'human' && !meta.humans) {
      throw forbidden('MACHINES_ONLY', `${meta.name} is for machines for now; humans can watch.`);
    }
  }

  activeMatchOf(identityId: string): string | null {
    return this.active.get(identityId) ?? null;
  }

  playerIds(matchId: string): string[] | null {
    const m = this.matches.get(matchId);
    return m ? m.seats.map((s) => s.identity.id) : null;
  }

  /** Where a match's system lines go: its table's channel, or the old per-match channel without one. */
  private chatOf(m: LiveMatch): string {
    return m.tableId ? tableChannel(m.tableId) : `match:${m.id}`;
  }

  /** The table a match was played at: from memory while it's retained, else from the database. */
  async tableIdOf(matchId: string): Promise<string | null> {
    const live = this.matches.get(matchId);
    if (live) return live.tableId;
    const [row] = await this.db.select({ tableId: matches.tableId }).from(matches).where(eq(matches.id, matchId)).limit(1);
    return row?.tableId ?? null;
  }

  async recoverOnBoot(): Promise<number> {
    const stale = await this.db
      .update(matches)
      .set({ status: 'abandoned', endReason: 'server-restart', endedAt: new Date(this.clock.now()) })
      .where(inArray(matches.status, ['countdown', 'live']))
      .returning({ id: matches.id });
    if (stale.length > 0) {
      await this.db
        .update(matchPlayers)
        .set({ result: 'abandoned' })
        .where(inArray(matchPlayers.matchId, stale.map((s) => s.id)));
    }
    return stale.length;
  }

  async createMatch(gameId: string, players: IdentityPublic[], opts: { tableId?: string } = {}): Promise<MatchSummary> {
    if (this.closed) throw new AppError(503, 'SHUTTING_DOWN', 'The server is shutting down; try again in a moment.');
    const module = this.module(gameId);
    const { minPlayers, maxPlayers, seats: seatNames, name } = module.meta;
    if (players.length < minPlayers || players.length > maxPlayers) {
      throw badRequest('BAD_PLAYERS', `${name} takes ${minPlayers}–${maxPlayers} players.`);
    }
    if (new Set(players.map((p) => p.id)).size !== players.length) throw badRequest('BAD_PLAYERS', 'Players must be different.');
    for (const p of players) this.assertPlayable(p, gameId);
    for (const p of players) {
      if (this.active.has(p.id)) throw conflict('IN_MATCH', `@${p.handle} is already in a match.`);
    }
    const now = this.clock.now();
    const seed = this.opts.seed();
    const seats: SeatInfo[] = players.map((identity, i) => ({ seat: seatNames[i], identity }));
    const id = newId('m');
    const rt = module.realtime;
    const countdownMs = rt ? (this.opts.realtimeCountdownMs ?? rt.countdownSeconds * 1000) : this.opts.countdownMs;
    const m: LiveMatch = {
      id,
      gameId,
      tableId: opts.tableId ?? null,
      module,
      state: module.setup({ seats: seats.map((s) => s.seat), seed }),
      seats,
      status: 'countdown',
      revision: 1,
      startsAt: now + countdownMs,
      deadline: null,
      timeouts: Object.fromEntries(seats.map((s) => [s.seat, 0])),
      outcome: null,
      endReason: null,
      timer: null,
      failures: 0,
      waiters: new Set(),
      rng: createRng(seed ^ 0x5eed),
      desk: rt ? new DoctrineDesk(seatNames.slice(0, players.length), rt.defaultDoctrine, floorTicks(this.opts.doctrineFloorMs, 1000 / rt.tickHz)) : null,
    };
    this.matches.set(id, m);
    for (const s of seats) {
      this.active.set(s.identity.id, id);
      this.presence.setPlaying(s.identity.id, true);
    }
    m.timer = this.clock.setTimeout(() => {
      this.goLive(id).catch((e) => console.error('[games] goLive failed', e));
    }, countdownMs);
    try {
      await this.db.transaction(async (tx) => {
        await tx.insert(matches).values({
          id,
          gameId,
          tableId: opts.tableId ?? null,
          status: 'countdown',
          seed,
          season: seasonOf(now),
          rated: seats.every((s) => s.identity.kind === 'agent' || s.identity.locked),
          createdAt: new Date(now),
        });
        await tx.insert(matchPlayers).values(
          seats.map((s) => ({ matchId: id, seat: s.seat, identityId: s.identity.id, kind: s.identity.kind })),
        );
      });
    } catch (e) {
      this.clock.clearTimeout(m.timer);
      this.matches.delete(id);
      for (const s of seats) {
        if (this.active.get(s.identity.id) === id) this.active.delete(s.identity.id);
        this.presence.setPlaying(s.identity.id, false);
      }
      throw e;
    }
    const summary = this.toSummary(m);
    for (const s of seats) this.comms.deliver(s.identity.id, { type: 'match.started', match: summary });
    await this.comms.postSystem(
      this.chatOf(m),
      `${seats.map((s) => `@${s.identity.handle}`).join(' vs ')} — ${name}. Talk trash; play fair.`,
    );
    this.changed(m);
    return summary;
  }

  /**
   * Shuts the runner down with the core: every countdown, tick and retain timer is cleared and none
   * can re-arm, and every parked long-poll answers now (later ones don't wait).
   */
  close(): void {
    this.closed = true;
    for (const m of this.matches.values()) {
      this.clock.clearTimeout(m.timer);
      m.timer = null;
      for (const wake of [...m.waiters]) wake();
    }
  }

  private async goLive(id: string): Promise<void> {
    if (this.closed) return;
    const m = this.matches.get(id);
    if (!m || m.status !== 'countdown') return;
    m.status = 'live';
    m.revision += 1;
    if (m.desk) {
      m.desk.live = true;
      this.scheduleTick(m);
    }
    this.startTurn(m);
    this.changed(m);
    await this.db
      .update(matches)
      .set({ status: 'live' })
      .where(and(eq(matches.id, id), eq(matches.status, 'countdown')));
  }

  private startTurn(m: LiveMatch): void {
    // A real-time match's timer is its tick loop; there are no turns to start (or clear).
    if (!m.module.turn) return;
    if (this.closed) return;
    this.clock.clearTimeout(m.timer);
    m.timer = null;
    m.deadline = null;
    const turn = m.module.turn;
    if (!turn || m.status !== 'live') return;
    const toMove = turn.toMove(m.state);
    if (toMove.length === 0) return;
    const ms = turn.turnSeconds * 1000;
    m.deadline = this.clock.now() + ms;
    m.timer = this.clock.setTimeout(() => {
      this.onTimeout(m.id).catch((e) => console.error('[games] timeout failed', e));
    }, ms);
    const deadline = new Date(m.deadline).toISOString();
    for (const seat of toMove) {
      this.comms.deliver(this.seatInfo(m, seat).identity.id, {
        type: 'match.yourTurn',
        matchId: m.id,
        revision: m.revision,
        deadline,
      });
    }
  }

  /** Synchronously installs the new state (so racing requests see the new revision), then persists. */
  private async advance(m: LiveMatch, next: unknown): Promise<void> {
    m.state = next;
    m.revision += 1;
    const outcome = m.module.outcome(m.state);
    if (outcome) {
      await this.finish(m, outcome);
      return;
    }
    // A seat that's out (resigned, forfeited or eliminated) is free to go while the others play on.
    for (const s of m.seats) if (m.module.isOut?.(m.state, s.seat)) this.release(m, s.identity.id);
    this.startTurn(m);
    this.changed(m);
  }

  async move(matchId: string, identity: IdentityPublic, revision: unknown, command: unknown): Promise<MatchEnvelope> {
    this.guard.assert(identity, 'play');
    const m = this.require(matchId);
    const seat = this.seatOf(m, identity.id);
    if (!seat) throw forbidden('NOT_SEATED', 'You are not playing in this match.');
    if (m.status === 'countdown') throw conflict('NOT_STARTED', 'The match starts in a moment.');
    if (m.status !== 'live') throw conflict('MATCH_OVER', 'This match is already over.');
    if (revision !== m.revision) {
      throw conflict('STALE_REVISION', `The match is at revision ${m.revision}; you sent ${JSON.stringify(revision)}. Fetch it and try again.`);
    }
    const turn = m.module.turn;
    if (!turn) throw badRequest('NOT_TURN_BASED', 'This game uses doctrine, not moves.');
    if (!turn.toMove(m.state).includes(seat)) throw conflict('NOT_YOUR_TURN', `It is not ${seat}'s turn.`);
    let next: unknown;
    try {
      next = turn.apply(m.state, seat, command);
    } catch (e) {
      if (e instanceof GameRuleError) throw new AppError(400, e.code, e.message);
      throw e;
    }
    m.timeouts[seat] = 0;
    await this.advance(m, next);
    return this.envelope(matchId, identity.id);
  }

  async resign(matchId: string, identity: IdentityPublic): Promise<MatchEnvelope> {
    const m = this.require(matchId);
    const seat = this.seatOf(m, identity.id);
    if (!seat) throw forbidden('NOT_SEATED', 'You are not playing in this match.');
    if (m.status === 'over' || m.status === 'abandoned') throw conflict('MATCH_OVER', 'This match is already over.');
    if (m.module.isOut?.(m.state, seat)) throw conflict('OUT', "You're already out of this match.");
    let wentLive: Promise<unknown> | null = null;
    if (m.status === 'countdown' && !m.desk) {
      m.status = 'live';
      // The goLive timer will now find the match live and do nothing, so record it here. The guard
      // keeps a faster finish() write ('over') from being overwritten.
      wentLive = this.db
        .update(matches)
        .set({ status: 'live' })
        .where(and(eq(matches.id, m.id), eq(matches.status, 'countdown')));
    }
    const before = m.state;
    const next = m.module.forfeit(before, seat, 'resign');
    this.announceRound(m, before, next);
    const done = this.advance(m, next);
    if ((m.status as MatchStatus) !== 'over') this.release(m, identity.id);
    await this.comms.postSystem(this.chatOf(m), `@${identity.handle} resigns.`);
    await wentLive?.catch((e) => console.error(`[games] could not record ${m.id} as live`, e));
    await done;
    return this.envelope(matchId, identity.id);
  }

  private async onTimeout(id: string): Promise<void> {
    const m = this.matches.get(id);
    const turn = m?.module.turn;
    if (!m || !turn || m.status !== 'live') return;
    const seat = turn.toMove(m.state)[0];
    if (!seat) return;
    const who = this.seatInfo(m, seat).identity;
    const table = this.chatOf(m);
    m.timeouts[seat] = (m.timeouts[seat] ?? 0) + 1;
    const legal = turn.legal(m.state, seat);
    if (m.timeouts[seat] >= this.opts.maxTimeouts || legal.length === 0) {
      const done = this.advance(m, m.module.forfeit(m.state, seat, 'timeout'));
      if ((m.status as MatchStatus) !== 'over') this.release(m, who.id);
      await this.comms.postSystem(table, `@${who.handle} timed out ${m.timeouts[seat]} times in a row and forfeits.`);
      await done;
      return;
    }
    const command = m.rng.pick(legal);
    const done = this.advance(m, turn.apply(m.state, seat, command));
    const text = turn.describe ? turn.describe(command) : JSON.stringify(command);
    await this.comms.postSystem(table, `@${who.handle} dozed off — autopilot played ${text}.`);
    await done;
  }

  private scheduleTick(m: LiveMatch): void {
    if (this.closed) return;
    const ms = this.opts.realtimeTickMs ?? 1000 / m.module.realtime!.tickHz;
    m.timer = this.clock.setTimeout(() => this.tick(m.id), ms);
  }

  /**
   * One tick: waiting doctrine changes take over, every seat still in decides by its doctrine (or
   * the game's default action), the game steps, and everyone hears. A tick that throws is logged
   * and skipped; the next one still comes, unless 20 in a row have failed, and then the match is abandoned.
   */
  private tick(id: string): void {
    if (this.closed) return;
    const m = this.matches.get(id);
    if (!m || !m.desk || m.status !== 'live') return;
    const rt = m.module.realtime!;
    const desk = m.desk;
    try {
      for (const seat of desk.beginTick()) {
        this.comms.deliver(this.seatInfo(m, seat).identity.id, { type: 'match.doctrine', matchId: m.id, tick: desk.tick });
      }
      const actions: Record<SeatId, Action> = {};
      for (const s of m.seats) {
        if (m.module.isOut?.(m.state, s.seat)) {
          desk.fired[s.seat] = null;
          continue;
        }
        actions[s.seat] = desk.decide(s.seat, rt.senses(m.state, s.seat)) ?? rt.defaultAction;
      }
      const before = m.state;
      const next = rt.step(before, actions, m.rng);
      desk.endTick();
      this.announceRound(m, before, next);
      // advance installs the state (and, at the end, marks the match over) before its first await.
      this.advance(m, next).catch((e) => console.error(`[games] tick ${m.id} could not record its end`, e));
      m.failures = 0;
    } catch (e) {
      m.failures += 1;
      console.error(`[games] a tick of ${m.id} failed (${m.failures} in a row)`, e);
      if (m.failures >= MAX_TICK_FAILURES) {
        this.abandon(m, 'tick-failed').catch((e2) => console.error(`[games] could not abandon ${m.id}`, e2));
        return;
      }
    }
    if (m.status === 'live') this.scheduleTick(m);
  }

  /** A real-time round that began or ended between these two states is news for every seat. */
  private announceRound(m: LiveMatch, before: unknown, after: unknown): void {
    const round = m.module.realtime?.roundEvent?.(before, after) ?? null;
    if (round) for (const s of m.seats) this.comms.deliver(s.identity.id, { type: 'match.round', matchId: m.id, ...round });
  }

  setDoctrine(matchId: string, identity: IdentityPublic, raw: unknown): DoctrineAck {
    this.guard.assert(identity, 'play');
    const m = this.require(matchId);
    const seat = this.seatOf(m, identity.id);
    if (!seat) throw forbidden('NOT_SEATED', 'You are not playing in this match.');
    const rt = m.module.realtime;
    if (!rt || !m.desk) throw conflict('NOT_REALTIME', `${m.module.meta.name} is turn-based: send moves, not doctrine.`);
    if (m.status === 'over' || m.status === 'abandoned') throw conflict('MATCH_OVER', 'This match is already over.');
    if (m.module.isOut?.(m.state, seat)) throw conflict('OUT', "You're already out of this match.");
    let doctrine;
    try {
      doctrine = validateDoctrine(raw, rt.catalog);
    } catch (e) {
      if (e instanceof GameRuleError) throw new AppError(400, e.code, e.message);
      throw e;
    }
    return { ...m.desk.set(seat, doctrine), doctrine };
  }

  private async finish(m: LiveMatch, outcome: Outcome): Promise<void> {
    this.clock.clearTimeout(m.timer);
    m.status = 'over';
    m.outcome = outcome;
    m.endReason = outcome.reason;
    m.deadline = null;
    for (const s of m.seats) this.release(m, s.identity.id);
    this.changed(m);
    this.bus.emit('match.finished', { matchId: m.id, tableId: m.tableId });
    if (!this.closed) m.timer = this.clock.setTimeout(() => this.matches.delete(m.id), this.opts.retainMs);
    try {
      await this.db.transaction(async (tx) => {
        await tx
          .update(matches)
          .set({ status: 'over', outcome, endReason: outcome.reason, endedAt: new Date(this.clock.now()) })
          .where(eq(matches.id, m.id));
        for (const s of m.seats) {
          await tx
            .update(matchPlayers)
            .set({ result: resultFor(outcome, s.seat) })
            .where(and(eq(matchPlayers.matchId, m.id), eq(matchPlayers.seat, s.seat)));
        }
      });
    } catch (e) {
      // The match is over whether or not the database heard about it; a row left in `live` is
      // marked abandoned at the next boot. The players must still get their verdict.
      console.error(`[games] could not record the result of ${m.id}`, e);
    }
    for (const s of m.seats) {
      this.comms.deliver(s.identity.id, { type: 'match.over', matchId: m.id, outcome, result: resultFor(outcome, s.seat) });
    }
    await this.comms.postSystem(this.chatOf(m), this.verdict(m, outcome));
  }

  /**
   * A match that can't go on (its ticks keep failing): nobody wins or loses, the seats go free, and
   * the table hears. Recorded the way a restart records one, as abandoned.
   */
  private async abandon(m: LiveMatch, reason: string): Promise<void> {
    this.clock.clearTimeout(m.timer);
    m.status = 'abandoned';
    m.endReason = reason;
    m.deadline = null;
    m.revision += 1;
    for (const s of m.seats) this.release(m, s.identity.id);
    this.changed(m);
    this.bus.emit('match.finished', { matchId: m.id, tableId: m.tableId });
    m.timer = this.closed ? null : this.clock.setTimeout(() => this.matches.delete(m.id), this.opts.retainMs);
    try {
      await this.db.transaction(async (tx) => {
        await tx.update(matches).set({ status: 'abandoned', endReason: reason, endedAt: new Date(this.clock.now()) }).where(eq(matches.id, m.id));
        await tx.update(matchPlayers).set({ result: 'abandoned' }).where(eq(matchPlayers.matchId, m.id));
      });
    } catch (e) {
      console.error(`[games] could not record ${m.id} as abandoned`, e);
    }
    await this.comms.postSystem(this.chatOf(m), 'The match broke down and was abandoned. Nobody wins or loses.');
  }

  private verdict(m: LiveMatch, o: Outcome): string {
    if (o.winners.length === 0) return `Draw (${o.reason.replaceAll('-', ' ')}).`;
    const names = o.winners.map((w) => `@${this.seatInfo(m, w).identity.handle}`).join(' & ');
    return `${names} wins (${o.reason.replaceAll('-', ' ')}). GG.`;
  }

  private release(m: LiveMatch, identityId: string): void {
    if (this.active.get(identityId) === m.id) this.active.delete(identityId);
    // Someone already playing a newer match keeps their "playing".
    if (!this.active.has(identityId)) this.presence.setPlaying(identityId, false);
  }

  async wait(matchId: string, since: number, waitMs: number): Promise<void> {
    const m = this.require(matchId);
    if (m.revision > since || waitMs <= 0 || m.status === 'over' || m.status === 'abandoned' || this.closed) return;
    await new Promise<void>((resolve) => {
      let timer: unknown = null;
      const finish = () => {
        this.clock.clearTimeout(timer);
        m.waiters.delete(finish);
        resolve();
      };
      m.waiters.add(finish);
      timer = this.clock.setTimeout(finish, waitMs);
    });
  }

  private changed(m: LiveMatch): void {
    const waiting = [...m.waiters];
    m.waiters.clear();
    for (const wake of waiting) wake();
    this.bus.emit('match.updated', { matchId: m.id, revision: m.revision });
  }

  envelope(matchId: string, identityId: string | null): MatchEnvelope {
    const m = this.require(matchId);
    const you = identityId ? this.seatOf(m, identityId) : null;
    const turn = m.module.turn;
    const legal = you && m.status === 'live' && turn && turn.toMove(m.state).includes(you) ? turn.legal(m.state, you) : [];
    const rt = m.module.realtime;
    const senses = (seat: SeatId) => {
      try {
        return rt!.senses(m.state, seat);
      } catch (e) {
        console.error(`[games] senses for ${m.id}/${seat} failed`, e);
        return null;
      }
    };
    const realtime =
      m.desk && rt
        ? {
            tick: m.desk.tick,
            fired: { ...m.desk.fired },
            ...(you ? { you: { senses: senses(you), doctrine: m.desk.doctrineOf(you), pending: m.desk.pendingOf(you) } } : {}),
          }
        : undefined;
    return { match: this.toSummary(m), you, view: m.module.view(m.state, you), legal, ...(realtime ? { realtime } : {}) };
  }

  summary(matchId: string): MatchSummary {
    return this.toSummary(this.require(matchId));
  }

  private toSummary(m: LiveMatch): MatchSummary {
    const turn = m.module.turn;
    return {
      id: m.id,
      gameId: m.gameId,
      status: m.status,
      revision: m.revision,
      seats: m.seats,
      toMove: m.status === 'live' && turn ? turn.toMove(m.state) : [],
      deadline: m.deadline ? new Date(m.deadline).toISOString() : null,
      startsAt: new Date(m.startsAt).toISOString(),
      outcome: m.outcome,
      endReason: m.endReason,
      tableId: m.tableId,
    };
  }

  private require(matchId: string): LiveMatch {
    const m = this.matches.get(matchId);
    if (!m) throw notFound('NO_MATCH', `There is no live match "${matchId}".`);
    return m;
  }

  private seatOf(m: LiveMatch, identityId: string): SeatId | null {
    return m.seats.find((s) => s.identity.id === identityId)?.seat ?? null;
  }

  private seatInfo(m: LiveMatch, seat: SeatId): SeatInfo {
    const info = m.seats.find((s) => s.seat === seat);
    if (!info) throw new Error(`seat ${seat} not in match ${m.id}`);
    return info;
  }
}
