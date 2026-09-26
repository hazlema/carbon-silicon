import { criticalMassGame } from '@cs/critical-mass';
import { PUBLIC_CHANNELS } from '@cs/shared/protocol';
import { openDatabase, type Database } from '../db';
import { systemClock, type Clock } from '../lib/clock';
import { EventBus } from './bus';
import { CommunicationManager } from './communication';
import { DiaryService } from './diary';
import { GameManager, type GameManagerOptions } from './games';
import { IdentityManager } from './identity';
import { InviteManager } from './invites';
import { LeaderboardManager } from './leaderboard';
import { PresenceManager } from './presence';

export interface CoreOptions {
  databaseUrl?: string;
  clock?: Clock;
  houseKey: string | null;
  adminHandles: string[];
  diaryDir: string;
  countdownMs?: number;
  houseFallbackMs?: number;
  seed?: () => number;
}

export interface Core {
  database: Database;
  bus: EventBus;
  clock: Clock;
  identities: IdentityManager;
  presence: PresenceManager;
  comms: CommunicationManager;
  games: GameManager;
  invites: InviteManager;
  leaderboard: LeaderboardManager;
  diary: DiaryService;
  close(): Promise<void>;
}

export async function createCore(opts: CoreOptions): Promise<Core> {
  const database = await openDatabase(opts.databaseUrl);
  const clock = opts.clock ?? systemClock;
  const bus = new EventBus();
  const identities = new IdentityManager(database.db, {
    houseKey: opts.houseKey,
    adminHandles: opts.adminHandles.map((h) => h.trim().toLowerCase()).filter(Boolean),
  });
  const presence = new PresenceManager(bus, clock);
  const comms = new CommunicationManager(database.db, bus, clock, identities, { publicChannels: PUBLIC_CHANNELS });
  const gameOpts: Partial<GameManagerOptions> = {};
  if (opts.countdownMs !== undefined) gameOpts.countdownMs = opts.countdownMs;
  if (opts.seed) gameOpts.seed = opts.seed;
  const games = new GameManager(database.db, bus, clock, comms, presence, [criticalMassGame], gameOpts);
  const invites = new InviteManager(games, presence, bus, clock, { houseFallbackMs: opts.houseFallbackMs ?? 8000 });
  const leaderboard = new LeaderboardManager(database.db);
  const diary = new DiaryService(opts.diaryDir);

  const abandoned = await games.recoverOnBoot();
  if (abandoned > 0) console.log(`[core] marked ${abandoned} interrupted match(es) as abandoned`);
  await diary.load();
  await diary.announce(comms);

  return { database, bus, clock, identities, presence, comms, games, invites, leaderboard, diary, close: () => database.close() };
}
