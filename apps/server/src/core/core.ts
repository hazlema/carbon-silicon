import { checkersGame } from '@cs/checkers';
import { criticalMassGame } from '@cs/critical-mass';
import { lightlineGame } from '@cs/lightline';
import { PUBLIC_CHANNELS } from '@cs/shared/protocol';
import { openDatabase, type Database } from '../db';
import { systemClock, type Clock } from '../lib/clock';
import { AccountManager } from './accounts';
import { EventBus } from './bus';
import { CommunicationManager } from './communication';
import { DiaryService } from './diary';
import { GameManager, type GameManagerOptions } from './games';
import { Guard } from './guard';
import { IdentityManager } from './identity';
import { InviteManager } from './invites';
import { LeaderboardManager } from './leaderboard';
import { ModerationManager } from './moderation';
import { OwnerManager } from './owners';
import { PresenceManager } from './presence';
import { ProfileService } from './profiles';
import { DmManager } from './dms';
import { GROUP_MAX_DEFAULT, GroupManager } from './groups';
import { RelationManager } from './relations';
import { ReportManager } from './reports';
import { TableManager } from './tables';

export interface CoreOptions {
  databaseUrl?: string;
  clock?: Clock;
  houseKey: string | null;
  diaryDir: string;
  countdownMs?: number;
  houseFallbackMs?: number;
  seed?: () => number;
  /** The reaction floor for machines in real-time games (DOCTRINE_FLOOR_MS; default 300). */
  doctrineFloorMs?: number;
  /** Tests and the e2e server only. */
  realtimeTickMs?: number;
  realtimeCountdownMs?: number;
  /** How often idle guest names are swept (default 6 h; 0 disables the timer). The boot sweep always runs. */
  sweepEveryMs?: number;
  /** How often past seasons are checked for closing (default 60 s; 0 disables the timer). The boot check always runs. */
  seasonCheckMs?: number;
  /** The most people in a group chat (GROUP_MAX_MEMBERS; default 8). */
  groupMaxMembers?: number;
}

export interface Core {
  database: Database;
  bus: EventBus;
  clock: Clock;
  guard: Guard;
  identities: IdentityManager;
  accounts: AccountManager;
  profiles: ProfileService;
  presence: PresenceManager;
  comms: CommunicationManager;
  dms: DmManager;
  groups: GroupManager;
  games: GameManager;
  tables: TableManager;
  invites: InviteManager;
  moderation: ModerationManager;
  owners: OwnerManager;
  relations: RelationManager;
  reports: ReportManager;
  leaderboard: LeaderboardManager;
  diary: DiaryService;
  /** Stops the timers and wakes every parked long-poll, so the HTTP server can stop; close() does this too. */
  drain(): void;
  /** Drains, then closes the database. */
  close(): Promise<void>;
}

export async function createCore(opts: CoreOptions): Promise<Core> {
  const database = await openDatabase(opts.databaseUrl);
  const clock = opts.clock ?? systemClock;
  const bus = new EventBus();
  const guard = new Guard();
  const identities = new IdentityManager(database.db, clock, { houseKey: opts.houseKey });
  const accounts = new AccountManager(database.db, clock, identities, guard);
  const profiles = new ProfileService(database.db, identities);
  const presence = new PresenceManager(bus, clock);
  const comms = new CommunicationManager(database.db, bus, clock, identities, { publicChannels: PUBLIC_CHANNELS, guard });
  const gameOpts: Partial<GameManagerOptions> = {};
  if (opts.countdownMs !== undefined) gameOpts.countdownMs = opts.countdownMs;
  if (opts.seed) gameOpts.seed = opts.seed;
  if (opts.doctrineFloorMs !== undefined) gameOpts.doctrineFloorMs = opts.doctrineFloorMs;
  if (opts.realtimeTickMs !== undefined) gameOpts.realtimeTickMs = opts.realtimeTickMs;
  if (opts.realtimeCountdownMs !== undefined) gameOpts.realtimeCountdownMs = opts.realtimeCountdownMs;
  const games = new GameManager(database.db, bus, clock, comms, presence, [criticalMassGame, lightlineGame, checkersGame], guard, gameOpts);
  comms.setMatchTable((matchId) => games.tableIdOf(matchId));
  const relations = new RelationManager(database.db, identities);
  const dms = new DmManager(database.db, { comms, identities, relations });
  comms.setDmHooks({ check: (author, otherId) => dms.check(author, otherId), stored: (message, otherId) => dms.stored(message, otherId) });
  const groups = new GroupManager(database.db, clock, { comms, identities, relations, guard }, { maxMembers: opts.groupMaxMembers ?? GROUP_MAX_DEFAULT });
  comms.setGroupHooks({ check: (a, g) => groups.check(a, g), view: (v, g) => groups.view(v, g), stored: (m, g) => groups.stored(m, g) });
  const tables = new TableManager({ games, presence, comms, identities, relations, guard, bus, clock });
  groups.setTables(tables, games);
  const invites = new InviteManager(games, presence, bus, clock, guard, tables, { houseFallbackMs: opts.houseFallbackMs ?? 8000 });
  tables.setQueueLeaver((identityId) => invites.leave(identityId));
  const leaderboard = new LeaderboardManager(database.db, { clock, bus, games: () => games.catalog() });
  const diary = new DiaryService(opts.diaryDir);

  const moderation = new ModerationManager(database.db, bus, clock, { identities, accounts, profiles, comms, games, invites, tables });
  guard.install((identity, action) => moderation.check(identity, action));
  await moderation.load();
  const owners = new OwnerManager(database.db, { identities, comms, presence, profiles, moderation, guard });

  comms.setMentionFilter((ownerId, authorId) => relations.mutes(ownerId, authorId));
  accounts.onRelease((identityId) => relations.forget(identityId));
  accounts.onRelease((identityId) => moderation.liftOnRelease(identityId));
  accounts.onRelease((identityId) => dms.forget(identityId));
  accounts.onRelease((identityId) => groups.forget(identityId));
  accounts.onRelease((identityId) => owners.forget(identityId));
  accounts.onRelease(async (identityId) => presence.drop(identityId));
  accounts.onSessionsEnded((sessionIds) => bus.emit('sessions.ended', { sessionIds }));
  const reports = new ReportManager(database.db, clock, { identities, comms, moderation, guard, groups });

  const abandoned = await games.recoverOnBoot();
  if (abandoned > 0) console.log(`[core] marked ${abandoned} interrupted match(es) as abandoned`);
  await diary.load();
  await diary.announce(comms);

  let closed = false;
  let sweepTimer: unknown = null;
  const sweep = async () => {
    try {
      const n = await accounts.sweepIdle();
      if (n > 0) console.log(`[core] released ${n} idle guest name(s)`);
    } catch (e) {
      console.error('[core] idle sweep failed', e);
    }
  };
  const sweepEvery = opts.sweepEveryMs ?? 6 * 3_600_000;
  const schedule = () => {
    if (closed || sweepEvery <= 0) return;
    sweepTimer = clock.setTimeout(() => void sweep().finally(schedule), sweepEvery);
  };
  await sweep();
  schedule();

  let seasonTimer: unknown = null;
  const closeSeasons = async () => {
    try {
      const done = await leaderboard.closeSeasons(comms);
      if (done.length > 0) console.log(`[core] closed season(s) ${done.join(', ')}`);
    } catch (e) {
      if (!closed) console.error('[core] season closing failed', e);
    }
  };
  const seasonEvery = opts.seasonCheckMs ?? 60_000;
  const scheduleSeasons = () => {
    if (closed || seasonEvery <= 0) return;
    seasonTimer = clock.setTimeout(() => void closeSeasons().finally(scheduleSeasons), seasonEvery);
  };
  await closeSeasons();
  scheduleSeasons();

  const drain = () => {
    closed = true;
    clock.clearTimeout(sweepTimer);
    clock.clearTimeout(seasonTimer);
    games.close();
    comms.close();
  };

  return {
    database,
    bus,
    clock,
    guard,
    identities,
    accounts,
    profiles,
    presence,
    comms,
    dms,
    groups,
    games,
    tables,
    invites,
    moderation,
    owners,
    relations,
    reports,
    leaderboard,
    diary,
    drain,
    close: async () => {
      drain();
      await database.close();
    },
  };
}
