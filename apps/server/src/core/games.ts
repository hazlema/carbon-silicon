import { and, eq, inArray } from 'drizzle-orm';
import { createRng, GameRuleError, type GameModule, type Outcome, type Rng, type SeatId } from '@cs/game-api';
import {
  seasonOf,
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
import type { PresenceManager } from './presence';

export interface GameManagerOptions {
  countdownMs: number;
  maxTimeouts: number;
  retainMs: number;
  seed: () => number;
}

const DEFAULTS: GameManagerOptions = {
  countdownMs: 3000,
  maxTimeouts: 3,
  retainMs: 30 * 60_000,
  seed: () => Math.floor(Math.random() * 2 ** 31),
};

interface LiveMatch {
  id: string;
  gameId: string;
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
  waiters: Set<() => void>;
  rng: Rng;
}

const resultFor = (o: Outcome, seat: SeatId): 'win' | 'loss' | 'draw' =>
  o.winners.length === 0 ? 'draw' : o.winners.includes(seat) ? 'win' : 'loss';

export class GameManager {
  private matches = new Map<string, LiveMatch>();
  private active = new Map<string, string>();
  private modules: Map<string, GameModule<any>>;
  private opts: GameManagerOptions;

  constructor(
    private db: DB,
    private bus: EventBus,
    private clock: Clock,
    private comms: CommunicationManager,
    private presence: PresenceManager,
    modules: GameModule<any>[],
    opts: Partial<GameManagerOptions> = {},
  ) {
    this.modules = new Map(modules.map((m) => [m.meta.id, m]));
    this.opts = { ...DEFAULTS, ...opts };
    comms.setTableAccess((matchId) => {
      const ids = this.playerIds(matchId);
      return ids ? { playerIds: ids } : null;
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
    }));
  }

  module(gameId: string): GameModule<any> {
    const m = this.modules.get(gameId);
    if (!m) throw notFound('NO_GAME', `There is no game "${gameId}". See GET /api/games.`);
    return m;
  }

  activeMatchOf(identityId: string): string | null {
    return this.active.get(identityId) ?? null;
  }

  playerIds(matchId: string): string[] | null {
    const m = this.matches.get(matchId);
    return m ? m.seats.map((s) => s.identity.id) : null;
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

  async createMatch(gameId: string, players: IdentityPublic[]): Promise<MatchSummary> {
    const module = this.module(gameId);
    const { minPlayers, maxPlayers, seats: seatNames, name } = module.meta;
    if (players.length < minPlayers || players.length > maxPlayers) {
      throw badRequest('BAD_PLAYERS', `${name} takes ${minPlayers}–${maxPlayers} players.`);
    }
    if (new Set(players.map((p) => p.id)).size !== players.length) throw badRequest('BAD_PLAYERS', 'Players must be different.');
    for (const p of players) {
      if (this.active.has(p.id)) throw conflict('IN_MATCH', `@${p.handle} is already in a match.`);
    }
    const now = this.clock.now();
    const seed = this.opts.seed();
    const seats: SeatInfo[] = players.map((identity, i) => ({ seat: seatNames[i], identity }));
    const id = newId('m');
    const m: LiveMatch = {
      id,
      gameId,
      module,
      state: module.setup({ seats: seats.map((s) => s.seat), seed }),
      seats,
      status: 'countdown',
      revision: 1,
      startsAt: now + this.opts.countdownMs,
      deadline: null,
      timeouts: Object.fromEntries(seats.map((s) => [s.seat, 0])),
      outcome: null,
      endReason: null,
      timer: null,
      waiters: new Set(),
      rng: createRng(seed ^ 0x5eed),
    };
    this.matches.set(id, m);
    for (const s of seats) {
      this.active.set(s.identity.id, id);
      this.presence.setPlaying(s.identity.id, true);
    }
    m.timer = this.clock.setTimeout(() => {
      this.goLive(id).catch((e) => console.error('[games] goLive failed', e));
    }, this.opts.countdownMs);
    await this.db.insert(matches).values({
      id,
      gameId,
      status: 'countdown',
      seed,
      season: seasonOf(now),
      rated: seats.every((s) => s.identity.kind === 'agent' || s.identity.locked),
      createdAt: new Date(now),
    });
    await this.db.insert(matchPlayers).values(
      seats.map((s) => ({ matchId: id, seat: s.seat, identityId: s.identity.id, kind: s.identity.kind })),
    );
    const summary = this.toSummary(m);
    for (const s of seats) this.comms.deliver(s.identity.id, { type: 'match.started', match: summary });
    await this.comms.postSystem(
      `match:${id}`,
      `${seats.map((s) => `@${s.identity.handle}`).join(' vs ')} — ${name}. Talk trash; play fair.`,
    );
    this.changed(m);
    return summary;
  }

  private async goLive(id: string): Promise<void> {
    const m = this.matches.get(id);
    if (!m || m.status !== 'countdown') return;
    m.status = 'live';
    m.revision += 1;
    this.startTurn(m);
    this.changed(m);
    await this.db.update(matches).set({ status: 'live' }).where(eq(matches.id, id));
  }

  private startTurn(m: LiveMatch): void {
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
    this.startTurn(m);
    this.changed(m);
  }

  async move(matchId: string, identity: IdentityPublic, revision: unknown, command: unknown): Promise<MatchEnvelope> {
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
    if (m.status === 'countdown') m.status = 'live';
    const done = this.advance(m, m.module.forfeit(m.state, seat, 'resign'));
    if ((m.status as MatchStatus) !== 'over') this.release(m, identity.id);
    await this.comms.postSystem(`match:${m.id}`, `@${identity.handle} resigns.`);
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
    const table = `match:${m.id}`;
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

  private async finish(m: LiveMatch, outcome: Outcome): Promise<void> {
    this.clock.clearTimeout(m.timer);
    m.status = 'over';
    m.outcome = outcome;
    m.endReason = outcome.reason;
    m.deadline = null;
    for (const s of m.seats) this.release(m, s.identity.id);
    this.changed(m);
    m.timer = this.clock.setTimeout(() => this.matches.delete(m.id), this.opts.retainMs);
    await this.db
      .update(matches)
      .set({ status: 'over', outcome, endReason: outcome.reason, endedAt: new Date(this.clock.now()) })
      .where(eq(matches.id, m.id));
    for (const s of m.seats) {
      await this.db
        .update(matchPlayers)
        .set({ result: resultFor(outcome, s.seat) })
        .where(and(eq(matchPlayers.matchId, m.id), eq(matchPlayers.seat, s.seat)));
    }
    for (const s of m.seats) {
      this.comms.deliver(s.identity.id, { type: 'match.over', matchId: m.id, outcome, result: resultFor(outcome, s.seat) });
    }
    await this.comms.postSystem(`match:${m.id}`, this.verdict(m, outcome));
  }

  private verdict(m: LiveMatch, o: Outcome): string {
    if (o.winners.length === 0) return `Draw (${o.reason.replaceAll('-', ' ')}).`;
    const names = o.winners.map((w) => `@${this.seatInfo(m, w).identity.handle}`).join(' & ');
    return `${names} wins (${o.reason.replaceAll('-', ' ')}). GG.`;
  }

  private release(m: LiveMatch, identityId: string): void {
    if (this.active.get(identityId) === m.id) this.active.delete(identityId);
    this.presence.setPlaying(identityId, false);
  }

  async wait(matchId: string, since: number, waitMs: number): Promise<void> {
    const m = this.require(matchId);
    if (m.revision > since || waitMs <= 0 || m.status === 'over' || m.status === 'abandoned') return;
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
    return { match: this.toSummary(m), you, view: m.module.view(m.state, you), legal };
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
