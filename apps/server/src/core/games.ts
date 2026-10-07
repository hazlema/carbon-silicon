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
  type MoveRecord,
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
import { isRatedMatch, PRACTICE_GAMES } from './ranked';
import type { PresenceManager } from './presence';
import { DoctrineDesk, FLOOR_DEFAULT_MS, floorTicks, SteerQueue } from './realtime';
import { verdictLine } from './verdict';

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
  season: string;
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
  /** The human seats' key queues (empty for turn games). */
  steer: Map<SeatId, SteerQueue>;
  /** The last RECENT_MOVES narrated entries, oldest first; memory only, gone with the match. */
  recent: MoveRecord[];
  /** Entries logged so far, so numbering runs on past the ones kept. */
  logged: number;
  /** Simultaneous games: the round the deadline covers (null before the first), and the revision that opened it. */
  round: number | null;
  roundRevision: number;
}

const resultFor = (o: Outcome, seat: SeatId): 'win' | 'loss' | 'draw' =>
  o.winners.length === 0 ? 'draw' : o.winners.includes(seat) ? 'win' : 'loss';

/** A real-time match whose ticks fail this many times in a row is abandoned. */
const MAX_TICK_FAILURES = 20;
/** How many narrated moves a match keeps for its envelope's `recent`. */
const RECENT_MOVES = 20;

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
    for (const { meta, realtime, turn } of modules) {
      if (realtime && meta.humans && !realtime.steer) throw new Error(`${meta.id} admits humans in real time but declares no steer rules`);
      if (turn?.simultaneous && typeof turn.round !== 'function') throw new Error(`${meta.id} moves simultaneously but declares no round()`);
    }
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
      houseFill: !!meta.houseFill,
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
    const steer = new Map<SeatId, SteerQueue>();
    if (rt?.steer) for (const s of seats) if (s.identity.kind === 'human') steer.set(s.seat, new SteerQueue(rt.steer));
    const countdownMs = rt ? (this.opts.realtimeCountdownMs ?? rt.countdownSeconds * 1000) : this.opts.countdownMs;
    const m: LiveMatch = {
      id,
      gameId,
      season: seasonOf(now),
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
      steer,
      recent: [],
      logged: 0,
      round: null,
      roundRevision: 1,
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
      const rated = await isRatedMatch(this.db, gameId, players, now, module.meta.practiceGames ?? PRACTICE_GAMES);
      await this.db.transaction(async (tx) => {
        await tx.insert(matches).values({
          id,
          gameId,
          tableId: opts.tableId ?? null,
          status: 'countdown',
          seed,
          season: m.season,
          rated,
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
    const clock = m.module.turn
      ? `Turn-based: ${m.module.turn.turnSeconds} s per move. ${this.rulesOfClock()}`
      : null;
    for (const s of seats) this.comms.deliver(s.identity.id, { type: 'match.started', match: summary, clock });
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
    const turn = m.module.turn;
    if (turn.simultaneous && m.status === 'live') {
      // One deadline per round: commits inside a round leave its clock alone.
      const round = turn.round!(m.state);
      if (round === m.round && m.deadline !== null) return;
      if (round !== m.round) {
        m.round = round;
        m.roundRevision = m.revision;
      }
    }
    this.clock.clearTimeout(m.timer);
    m.timer = null;
    m.deadline = null;
    if (m.status !== 'live') return;
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
        secondsLeft: this.secondsLeft(m) ?? 0,
        clock: this.moverClock(m, seat),
      });
    }
  }

  /** Synchronously installs the new state (so racing requests see the new revision), then persists. */
  private async advance(m: LiveMatch, next: unknown): Promise<void> {
    // A seat the game keeps at the table once it's out (a ghost) starts its run of misses afresh:
    // the rounds the autopilot played for it while it was in don't count toward its fading.
    const kept = m.module.stillSeated;
    if (kept) for (const s of m.seats) if (!kept(m.state, s.seat) && kept(next, s.seat)) m.timeouts[s.seat] = 0;
    m.state = next;
    m.revision += 1;
    const outcome = m.module.outcome(m.state);
    if (outcome) {
      await this.finish(m, outcome);
      return;
    }
    // A seat that's out (resigned, forfeited or eliminated) is free to go while the others play on,
    // unless the game keeps it at the table (stillSeated).
    for (const s of m.seats) if (this.isGone(m, s.seat)) this.release(m, s.identity.id);
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
    const turn = m.module.turn;
    // In a simultaneous round another seat's commit can't change what this seat may do, so any
    // revision since the round opened will do; apply() still refuses anything truly illegal.
    const fresh = turn?.simultaneous
      ? typeof revision === 'number' && revision >= m.roundRevision && revision <= m.revision
      : revision === m.revision;
    if (!fresh) {
      throw conflict('STALE_REVISION', `The match is at revision ${m.revision}; you sent ${JSON.stringify(revision)}. Fetch it and try again.`);
    }
    if (!turn) throw badRequest('NOT_TURN_BASED', 'This game uses doctrine, not moves.');
    if (!turn.toMove(m.state).includes(seat)) {
      throw conflict('NOT_YOUR_TURN', turn.simultaneous ? `${seat} owes nothing more this round.` : `It is not ${seat}'s turn.`);
    }
    const before = m.state;
    let next: unknown;
    try {
      next = turn.apply(before, seat, command);
    } catch (e) {
      if (e instanceof GameRuleError) throw new AppError(400, e.code, e.message);
      throw e;
    }
    m.timeouts[seat] = 0;
    // Logged before advancing: the envelope advance publishes must already carry it.
    this.logMove(m, before, next, seat, command, '');
    await this.advance(m, next);
    return this.envelope(matchId, identity.id);
  }

  async resign(matchId: string, identity: IdentityPublic): Promise<MatchEnvelope> {
    const m = this.require(matchId);
    const seat = this.seatOf(m, identity.id);
    if (!seat) throw forbidden('NOT_SEATED', 'You are not playing in this match.');
    if (m.status === 'over' || m.status === 'abandoned') throw conflict('MATCH_OVER', 'This match is already over.');
    if (this.isGone(m, seat)) throw conflict('OUT', "You're already out of this match.");
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
    // A seat the game kept at the table after it went out (a ghost) doesn't resign: it stops haunting.
    const ghost = !!m.module.stillSeated?.(before, seat);
    const next = m.module.forfeit(before, seat, 'resign');
    this.record(m, seat, ghost ? 'stops haunting' : 'resigns');
    this.announceRound(m, before, next);
    const done = this.advance(m, next);
    if ((m.status as MatchStatus) !== 'over') this.release(m, identity.id);
    await this.comms.postSystem(this.chatOf(m), ghost ? `@${identity.handle} stops haunting.` : `@${identity.handle} resigns.`);
    await wentLive?.catch((e) => console.error(`[games] could not record ${m.id} as live`, e));
    await done;
    return this.envelope(matchId, identity.id);
  }

  private async onTimeout(id: string): Promise<void> {
    const m = this.matches.get(id);
    const turn = m?.module.turn;
    if (!m || !turn || m.status !== 'live') return;
    if (turn.simultaneous) return this.onRoundTimeout(m);
    const seat = turn.toMove(m.state)[0];
    if (!seat) return;
    const who = this.seatInfo(m, seat).identity;
    const table = this.chatOf(m);
    m.timeouts[seat] = (m.timeouts[seat] ?? 0) + 1;
    const legal = turn.legal(m.state, seat);
    if (m.timeouts[seat] >= this.opts.maxTimeouts || legal.length === 0) {
      const ghost = !!m.module.stillSeated?.(m.state, seat);
      const misses = m.timeouts[seat];
      this.record(m, seat, ghost ? 'fades away' : 'times out and forfeits');
      const done = this.advance(m, m.module.forfeit(m.state, seat, 'timeout'));
      if ((m.status as MatchStatus) !== 'over') this.release(m, who.id);
      await this.comms.postSystem(table, this.forfeitLine(who, misses, ghost));
      await done;
      return;
    }
    const command = m.rng.pick(legal);
    const before = m.state;
    const next = turn.apply(before, seat, command);
    this.logMove(m, before, next, seat, command, ' (autopilot)');
    const text = this.describeCommand(m, command);
    // Tell the sleeper first, so the notice reaches them before any match.over or next match.yourTurn that advance() sends.
    this.comms.deliver(who.id, { type: 'match.autopilot', matchId: m.id, move: text, misses: m.timeouts[seat]!, forfeitAt: this.opts.maxTimeouts });
    const done = this.advance(m, next);
    await this.comms.postSystem(table, `@${who.handle} dozed off — autopilot played ${text}.`);
    await done;
  }

  /**
   * A simultaneous round ran out: every seat still owing is autopiloted (or forfeited, at the
   * limit), in seat order, until the round resolves; the seats of the next round get a fresh
   * deadline, not an autopilot. The table hears who dozed off, never what the autopilot sent.
   */
  private async onRoundTimeout(m: LiveMatch): Promise<void> {
    const turn = m.module.turn!;
    const round = turn.round!(m.state);
    const settled = (state: unknown) => m.module.outcome(state) !== null || turn.round!(state) !== round;
    let state = m.state;
    let applied = 0;
    const dozed: { who: IdentityPublic; seat: SeatId; moves: string[] }[] = [];
    const forfeited: { who: IdentityPublic; seat: SeatId; misses: number; ghost: boolean }[] = [];
    for (const seat of turn.toMove(state)) {
      if (settled(state)) break;
      if (!turn.toMove(state).includes(seat)) continue;
      const who = this.seatInfo(m, seat).identity;
      m.timeouts[seat] = (m.timeouts[seat] ?? 0) + 1;
      const moves: string[] = [];
      while (!settled(state) && turn.toMove(state).includes(seat)) {
        const before = state;
        const legal = turn.legal(before, seat);
        applied += 1;
        if (m.timeouts[seat] >= this.opts.maxTimeouts || legal.length === 0) {
          const ghost = !!m.module.stillSeated?.(before, seat);
          this.record(m, seat, ghost ? 'fades away' : 'times out and forfeits');
          state = m.module.forfeit(before, seat, 'timeout');
          this.announceRound(m, before, state);
          forfeited.push({ who, seat, misses: m.timeouts[seat], ghost });
          break;
        }
        const command = m.rng.pick(legal);
        state = turn.apply(before, seat, command);
        this.logMove(m, before, state, seat, command, ' (autopilot)');
        moves.push(this.describeCommand(m, command));
      }
      if (moves.length > 0) dozed.push({ who, seat, moves });
    }
    if (applied === 0) return;
    // Each command is a revision; advance() counts the last.
    m.revision += applied - 1;
    // This round's clock has run out: if the round somehow stands, it gets a fresh one.
    m.deadline = null;
    // Tell the sleepers first, so the notice reaches them before any match.over or match.yourTurn that advance() sends.
    for (const d of dozed) {
      const move = [...new Set(d.moves)].join(', ');
      this.comms.deliver(d.who.id, { type: 'match.autopilot', matchId: m.id, move, misses: m.timeouts[d.seat]!, forfeitAt: this.opts.maxTimeouts });
    }
    const done = this.advance(m, state);
    if ((m.status as MatchStatus) !== 'over') for (const f of forfeited) this.release(m, f.who.id);
    const table = this.chatOf(m);
    for (const d of dozed) await this.comms.postSystem(table, `@${d.who.handle} dozed off — the autopilot moved for them.`);
    for (const f of forfeited) await this.comms.postSystem(table, this.forfeitLine(f.who, f.misses, f.ghost));
    await done;
  }

  /** The table line for a seat the clock forfeits; a ghost (kept at the table after going out) fades away instead. */
  private forfeitLine(who: IdentityPublic, misses: number, ghost: boolean): string {
    return ghost ? `@${who.handle}'s ghost fades away.` : `@${who.handle} timed out ${misses} times in a row and forfeits.`;
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
      const paused = rt.paused?.(m.state) ?? false;
      for (const s of m.seats) {
        if (m.module.isOut?.(m.state, s.seat)) {
          desk.fired[s.seat] = null;
          continue;
        }
        const q = m.steer.get(s.seat);
        if (q) {
          if (paused) q.clear();
          actions[s.seat] = q.take();
          desk.fired[s.seat] = 'steering';
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

  /**
   * A real-time round that began or ended between these two states is news for every seat; a
   * simultaneous round that resolved (or a game that ended) is told once, credited to no seat.
   */
  private announceRound(m: LiveMatch, before: unknown, after: unknown): void {
    const turn = m.module.turn;
    if (turn?.simultaneous) {
      const ended = m.module.outcome(before) === null && m.module.outcome(after) !== null;
      if (!ended && turn.round!(before) === turn.round!(after)) return;
      let lines: string[] = [];
      try {
        lines = turn.roundSummary?.(before, after) ?? [];
      } catch (e) {
        console.error(`[games] the round summary of ${m.id} failed`, e);
      }
      for (const line of lines) if (typeof line === 'string' && line.trim()) this.record(m, null, line);
      return;
    }
    const round = m.module.realtime?.roundEvent?.(before, after) ?? null;
    if (!round) return;
    for (const s of m.seats) this.comms.deliver(s.identity.id, { type: 'match.round', matchId: m.id, ...round });
    if (!round.ended) return;
    const score = m.seats.map((s) => round.score[s.seat] ?? 0).join('–');
    if (round.winner) this.record(m, round.winner, `wins round ${round.round} (${score})`, round.round);
    else this.record(m, null, `Round ${round.round}: nobody survives`, round.round);
  }

  /** Logs a line for the recent-moves list; `{seat}` placeholders become that seat's handle. */
  private record(m: LiveMatch, seat: SeatId | null, text: string, number?: number): void {
    const handleOf = (s: string) => m.seats.find((x) => x.seat === s)?.identity.handle;
    m.logged += 1;
    m.recent.push({
      number: number ?? m.logged,
      seat,
      handle: seat ? (handleOf(seat) ?? null) : null,
      text: text.replace(/\{([A-Za-z0-9_-]+)\}/g, (whole, s: string) => handleOf(s) ?? whole),
    });
    if (m.recent.length > RECENT_MOVES) m.recent.shift();
  }

  /**
   * Logs a move. Simultaneous rounds keep their secrets until they resolve: the log says only that
   * the seat "is ready" (once it owes nothing more), then the round's story. Everyone else gets
   * the game's own sentence.
   */
  private logMove(m: LiveMatch, before: unknown, after: unknown, seat: SeatId, command: unknown, note: string): void {
    const turn = m.module.turn!;
    if (!turn.simultaneous) {
      this.record(m, seat, `${this.narrateMove(m, before, after, seat, command)}${note}`);
      return;
    }
    const resolved = m.module.outcome(after) !== null || turn.round!(before) !== turn.round!(after);
    if (resolved || !turn.toMove(after).includes(seat)) this.record(m, seat, `is ready${note}`);
    this.announceRound(m, before, after);
  }

  /** describe(), else the command as JSON; never throws. */
  private describeCommand(m: LiveMatch, command: unknown): string {
    try {
      const describe = m.module.turn?.describe;
      return describe ? describe(command) : JSON.stringify(command);
    } catch {
      return JSON.stringify(command);
    }
  }

  /** The game's own sentence for a move, else "plays <describe>", else the command as JSON: nothing a
   *  module does wrong here may break a move (the autopilot narrates before it advances). */
  private narrateMove(m: LiveMatch, before: unknown, after: unknown, seat: SeatId, command: unknown): string {
    const turn = m.module.turn!;
    const attempt = (what: string, fn: () => unknown): string | null => {
      try {
        const text = fn();
        return typeof text === 'string' && text.trim() ? text : null;
      } catch (e) {
        console.error(`[games] ${what} a move in ${m.id} failed`, e);
        return null;
      }
    };
    return (
      attempt('narrating', () => turn.narrate?.(before, after, seat, command)) ??
      `plays ${attempt('describing', () => turn.describe?.(command)) ?? attempt('serializing', () => JSON.stringify(command)) ?? 'a move'}`
    );
  }

  setDoctrine(matchId: string, identity: IdentityPublic, raw: unknown): DoctrineAck {
    this.guard.assert(identity, 'play');
    const m = this.require(matchId);
    const seat = this.seatOf(m, identity.id);
    if (!seat) throw forbidden('NOT_SEATED', 'You are not playing in this match.');
    const rt = m.module.realtime;
    if (!rt || !m.desk) throw conflict('NOT_REALTIME', `${m.module.meta.name} is turn-based: send moves, not doctrine.`);
    if (m.steer.has(seat)) throw conflict('HUMAN_STEERS', 'You steer with the keys; doctrine is for machines.');
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

  /**
   * A person's key (over the WebSocket). Anything that isn't a live, unpaused real-time match this
   * person is seated in, or a key the game doesn't know, is dropped quietly: a reply per keypress
   * would be noise, and a real player never hits these.
   */
  steer(identityId: string, matchId: string, key: string): boolean {
    const m = this.matches.get(matchId);
    if (!m || m.status !== 'live') return false;
    const seat = this.seatOf(m, identityId);
    const q = seat ? m.steer.get(seat) : undefined;
    if (!q || m.module.realtime?.paused?.(m.state)) return false;
    return q.press(key);
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
    this.bus.emit('match.recorded', { matchId: m.id, gameId: m.gameId, season: m.season });
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
    this.bus.emit('match.recorded', { matchId: m.id, gameId: m.gameId, season: m.season });
    await this.comms.postSystem(this.chatOf(m), 'The match broke down and was abandoned. Nobody wins or loses.');
  }

  private verdict(m: LiveMatch, o: Outcome): string {
    return verdictLine(o, (seat) => this.seatInfo(m, seat).identity.handle);
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
    return { match: this.toSummary(m), you, clock: this.clockFor(m, you), view: m.module.view(m.state, you), legal, recent: [...m.recent], ...(realtime ? { realtime } : {}) };
  }

  summary(matchId: string): MatchSummary {
    return this.toSummary(this.require(matchId));
  }

  private rulesOfClock(): string {
    return `At 0 the autopilot plays a random move for you; ${this.opts.maxTimeouts} misses in a row forfeit the match.`;
  }

  /** Whole seconds to the deadline, rounded up, never below 0; null with no deadline. */
  private secondsLeft(m: LiveMatch): number | null {
    if (!m.deadline) return null;
    return Math.max(0, Math.ceil((m.deadline - this.clock.now()) / 1000));
  }

  private moverClock(m: LiveMatch, seat: SeatId): string {
    const missed = m.timeouts[seat] ?? 0;
    const misses = missed > 0 ? ` You've missed ${missed} in a row.` : '';
    return `Your move: ${this.secondsLeft(m) ?? 0} s left. ${this.rulesOfClock()}${misses}`;
  }

  /** The clock as one sentence for this viewer (a seat, or null for a spectator). */
  private clockFor(m: LiveMatch, seat: SeatId | null): string | null {
    const left = this.secondsLeft(m);
    const turn = m.module.turn;
    if (left === null || !turn || m.status !== 'live') return null;
    const toMove = turn.toMove(m.state);
    if (seat && toMove.includes(seat)) return this.moverClock(m, seat);
    const first = toMove[0];
    if (!first) return null;
    const movers = turn.simultaneous ? toMove : [first];
    return `${movers.map((s) => `@${this.seatInfo(m, s).identity.handle}`).join(', ')} to move: ${left} s left.`;
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
      secondsLeft: m.status === 'live' ? this.secondsLeft(m) : null,
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

  /** Out of the match and not kept at the table. */
  private isGone(m: LiveMatch, seat: SeatId): boolean {
    return !!m.module.isOut?.(m.state, seat) && !m.module.stillSeated?.(m.state, seat);
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
