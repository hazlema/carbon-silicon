export type Kind = 'human' | 'agent';
export type Status = 'ready' | 'afk' | 'playing' | 'offline';
export type Role = 'user' | 'mod' | 'admin';

export interface IdentityPublic {
  id: string;
  handle: string;
  kind: Kind;
  tagline: string | null;
  color: string;
  model: string | null;
  isHouse: boolean;
  locked: boolean;
  role: Role;
  ownerHandle: string | null;
  /** The name was released (idle clean-up or deletion); show "a former player". */
  released: boolean;
}

export interface PresenceInfo {
  identity: IdentityPublic;
  status: Status;
  since: string;
}

export interface ChatMessage {
  id: number;
  channel: string;
  author: IdentityPublic | null;
  text: string;
  createdAt: string;
  system: boolean;
  /** Set when a moderator removed the message; `text` is then ''. */
  removed: { by: string } | null;
}

export interface SeatInfo {
  seat: string;
  identity: IdentityPublic;
}

export interface OutcomeWire {
  winners: string[];
  placement: string[][];
  reason: string;
}

export type MatchStatus = 'countdown' | 'live' | 'over' | 'abandoned';

export interface MatchSummary {
  id: string;
  gameId: string;
  status: MatchStatus;
  revision: number;
  seats: SeatInfo[];
  toMove: string[];
  deadline: string | null;
  /** Whole seconds until `deadline`, rounded up, never below 0; null when there is no deadline (countdown, real-time, over). */
  secondsLeft: number | null;
  startsAt: string;
  outcome: OutcomeWire | null;
  endReason: string | null;
  /** The table this match is played at; null for matches from before tables. */
  tableId: string | null;
}

/** What the bots' OpenRouter key has spent, in dollars, for the admins' Usage tab (GET /api/mod/usage). */
export type UsageReport =
  | {
      status: 'ok';
      today: number;
      week: number;
      month: number;
      total: number;
      /** Null when the key has no spending limit. */
      limit: number | null;
      limitRemaining: number | null;
      /** Requests to free models today, against OpenRouter's daily cap; null when it isn't reported. */
      freeRequests: { used: number; limit: number } | null;
      checkedAt: string;
    }
  | { status: 'unconfigured' | 'unavailable'; message: string };

/** One line of a match's recent history, narrated by the game: "places at b4 — small chain, takes 2 of Fable's cells". */
export interface MoveRecord {
  /** Counts the match's entries from 1 (a real-time round's entry carries the round). */
  number: number;
  /** Who it's about; null for a round nobody survived. */
  seat: string | null;
  handle: string | null;
  text: string;
}

export interface MatchEnvelope {
  match: MatchSummary;
  you: string | null;
  view: unknown;
  legal: unknown[];
  /** The turn clock in one plain sentence for this viewer; null when the match has no deadline right now. */
  clock: string | null;
  /** The match's last moves, oldest first (at most 20). Kept in memory while the match lives. */
  recent?: MoveRecord[];
  realtime?: RealtimeEnvelope;
}

export interface FiredRule {
  index: number;
  label: string | null;
}

/** Real-time matches only: the tick, each seat's last fired rule, and your own senses and orders. */
export interface RealtimeEnvelope {
  tick: number;
  /** `'steering'`: a person at the keys, not a doctrine. */
  fired: Record<string, FiredRule | 'steering' | null>;
  you?: {
    /** Null when the game could not work out your senses this tick (logged on the server). */
    senses: Record<string, number | string | boolean> | null;
    doctrine: { rules: unknown[] };
    pending: { rules: unknown[] } | null;
  };
}

/** The answer to PUT /api/matches/:id/doctrine. */
export interface DoctrineAck {
  status: 'applied' | 'pending';
  appliesAtTick: number;
  doctrine: { rules: unknown[] };
}

export type TableStatus = 'forming' | 'starting' | 'playing' | 'finished';

export interface TableInvite {
  id: string;
  to: IdentityPublic;
  expiresAt: string;
}

/** A table: a host, a game, and up to the game's maxPlayers seats (spec M2b §2). */
export interface TableInfo {
  id: string;
  gameId: string;
  host: IdentityPublic;
  status: TableStatus;
  /** Anyone may take an empty seat. */
  open: boolean;
  /** The game's maxPlayers. */
  size: number;
  minPlayers: number;
  /** Host first. */
  seated: IdentityPublic[];
  /** Pending invites; empty unless the viewer is seated or invited. */
  invites: TableInvite[];
  /** The last match's players, who may call a rematch. */
  lastPlayers: IdentityPublic[];
  /** The current or last match. */
  matchId: string | null;
  /** Spectators with the table page open. */
  watching: number;
}

export interface InviteOffer {
  invite: TableInvite;
  from: IdentityPublic;
  table: TableInfo;
}

export type InviteAnswer = 'accepted' | 'declined' | 'expired';

export const tableChannel = (tableId: string) => `table:${tableId}`;
export const railChannel = (tableId: string) => `rail:${tableId}`;

/** A direct-message channel: the two ids, sorted, so both people name it the same way. */
export const dmChannel = (a: string, b: string): string => `dm:${[a, b].sort().join(':')}`;

const DM_RE = /^dm:([A-Za-z0-9_]+):([A-Za-z0-9_]+)$/;

/** The two people of a `dm:` channel, or null unless it is well formed (two distinct ids, sorted). */
export function dmParticipants(channel: string): [string, string] | null {
  const m = DM_RE.exec(channel);
  if (!m || m[1] >= m[2]) return null;
  return [m[1], m[2]];
}

export const groupChannel = (groupId: string): string => `grp:${groupId}`;

const GRP_RE = /^grp:(g_[a-f0-9]{16})$/;

/** The group of a `grp:` channel, or null. */
export function groupOf(channel: string): string | null {
  return GRP_RE.exec(channel)?.[1] ?? null;
}

export interface GroupMemberInfo {
  identity: IdentityPublic;
  joinedAt: string;
  owner: boolean;
}

/** A group as one member sees it (spec M2d §5). */
export interface GroupInfo {
  id: string;
  channel: string;
  /** Null until someone names it; the web shows the members' handles instead. */
  name: string | null;
  ownerId: string;
  members: GroupMemberInfo[];
  maxMembers: number;
  /** People removed and kept out; only the owner sees the list (others get []). */
  bans: IdentityPublic[];
  last: ChatMessage | null;
  unread: number;
  hidden: boolean;
}

/** One conversation as its viewer sees it (spec M2c §2). */
export interface DmSummary {
  with: IdentityPublic;
  channel: string;
  /** The newest message; null only for a conversation just opened on this page. */
  last: ChatMessage | null;
  /** Messages from the other person since you last read, at most 99. */
  unread: number;
  /** You closed its tab; the next message opens it again. */
  hidden: boolean;
}

type Stamp = { cursor: number; at: string };
export type InboxEvent =
  | (Stamp & { type: 'chat.mention'; message: ChatMessage })
  | (Stamp & { type: 'chat.table'; message: ChatMessage })
  | (Stamp & { type: 'match.started'; match: MatchSummary; /** The clock rules in words; null for a real-time game. */ clock: string | null })
  | (Stamp & { type: 'match.yourTurn'; matchId: string; revision: number; deadline: string; secondsLeft: number; clock: string })
  /** The autopilot just played your timed-out turn (not sent on the forfeit, which is `match.over`). */
  | (Stamp & { type: 'match.autopilot'; matchId: string; move: string; misses: number; forfeitAt: number })
  | (Stamp & { type: 'match.over'; matchId: string; outcome: OutcomeWire; result: 'win' | 'loss' | 'draw' })
  | (Stamp & { type: 'match.round'; matchId: string; round: number; ended: boolean; winner: string | null; score: Record<string, number> })
  | (Stamp & { type: 'match.doctrine'; matchId: string; tick: number })
  | (Stamp & { type: 'moderation'; kind: SanctionKind | 'lift'; reason: string; endsAt: string | null })
  | (Stamp & { type: 'report.opened'; report: ReportInfo })
  | (Stamp & { type: 'invite.received' } & InviteOffer)
  | (Stamp & { type: 'invite.answered'; inviteId: string; tableId: string; who: IdentityPublic; answer: InviteAnswer })
  | (Stamp & { type: 'invite.cancelled'; inviteId: string; tableId: string; reason: string })
  | (Stamp & { type: 'table.updated'; table: TableInfo })
  | (Stamp & { type: 'table.closed'; tableId: string; reason: string })
  | (Stamp & { type: 'chat.dm'; message: ChatMessage })
  | (Stamp & { type: 'dm.read'; channel: string })
  | (Stamp & { type: 'chat.group'; message: ChatMessage })
  | (Stamp & { type: 'group.changed'; groupId: string })
  | (Stamp & { type: 'group.gone'; groupId: string; reason: 'removed' | 'left' })
  | (Stamp & { type: 'group.read'; groupId: string })
  | (Stamp & { type: 'owner.changed'; owner: IdentityPublic | null })
  | (Stamp & { type: 'moderation.agent'; agent: IdentityPublic; kind: SanctionKind | 'lift' | 'removed'; reason: string; endsAt: string | null })
  | (Stamp & { type: 'system'; text: string });

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type InboxEventInput = DistributiveOmit<InboxEvent, 'cursor' | 'at'>;

export interface InboxPoll {
  cursor: number;
  events: InboxEvent[];
  gap: boolean;
}

export interface ApiErrorBody {
  error: { code: string; message: string };
}

export interface GameInfo {
  id: string;
  name: string;
  tagline: string;
  mode: 'turn' | 'realtime';
  minPlayers: number;
  maxPlayers: number;
  seats: string[];
  /** Humans may play it; false means machines only (they can still watch). */
  humans: boolean;
  /** Empty seats fill with free house bots when a match starts (Lightline). */
  houseFill: boolean;
  /** The chooser's picture, served beside the rules; null when the game has none. */
  thumbnail: string | null;
}

export interface Tally {
  season: string;
  carbon: number;
  silicon: number;
  draws: number;
}

/** One player's line on a season's board for one game (M4). */
export interface StandingRow { rank: number; identity: IdentityPublic; points: number; wins: number; draws: number; losses: number; games: number; elo: number }
/** A season's board for one game (M4). */
export interface LeaderboardPage { season: string; gameId: string; rows: StandingRow[] }
/** A season in the picker, and whether it has been closed into the hall of fame (M4). */
export interface SeasonInfo { season: string; closed: boolean }
/** A closed season's first place in one game (M4). */
export interface Champion { season: string; gameId: string; row: StandingRow }
/** What a profile shows of the leaderboard: standing, this season's rows, matches played, titles (M4). */
export interface ProfileGlory {
  /** When their matches started (or start) counting; the web treats an unlocked human as a guest whatever this says. */
  rankedAt: string | null;
  ranked: boolean;
  season: { gameId: string; row: StandingRow }[];
  matchesPlayed: number;
  titles: { season: string; gameId: string }[];
}

export interface DiaryEntrySummary {
  slug: string;
  title: string;
  date: string;
  /** The opening paragraph in plain words, at most 240 characters. */
  excerpt: string;
  /** How many words the entry runs to. */
  words: number;
}

export interface DiaryEntry extends DiaryEntrySummary {
  markdown: string;
}

export type SanctionKind = 'mute' | 'suspend';
export interface SanctionInfo {
  kind: SanctionKind;
  reason: string;
  since: string;
  endsAt: string | null;
}

export interface SessionInfo {
  id: string;
  label: string;
  ip: string | null;
  createdAt: string;
  lastUsedAt: string;
  current: boolean;
}

export interface ProfileMatch {
  id: string;
  gameId: string;
  endedAt: string | null;
  endReason: string | null;
  result: 'win' | 'loss' | 'draw' | 'abandoned' | null;
  opponents: IdentityPublic[];
}

export interface ProfileRecord {
  versus: 'machines' | 'humans';
  wins: number;
  losses: number;
  draws: number;
  played: number;
  games: { gameId: string; played: number }[];
}

export interface ProfileRival {
  opponent: IdentityPublic;
  wins: number;
  losses: number;
  draws: number;
}

export interface Profile {
  identity: IdentityPublic;
  joinedAt: string;
  lastSeenAt: string;
  matches: ProfileMatch[];
  record: ProfileRecord;
  rival: ProfileRival | null;
}

/** An agent on its owner's profile (spec M2c §3). */
export interface AgentSummary {
  identity: IdentityPublic;
  status: Status;
  /** The agent's record vs humans. */
  record: ProfileRecord;
  sanction: SanctionInfo | null;
}

/** GET /api/users/:handle: a profile plus, for a human, the agents they own, and their glory (M4). */
export interface ProfilePage extends Profile {
  agents: AgentSummary[];
  glory: ProfileGlory;
}

export interface RelationsInfo {
  ignores: IdentityPublic[];
  blocks: IdentityPublic[];
}

export interface ReportSnapshot {
  messageId: number;
  channel: string;
  author: IdentityPublic | null;
  text: string;
  createdAt: string;
}

export interface ReportNote {
  by: string;
  text: string;
  at: string;
}

export type ReportStatus = 'open' | 'resolved';
export type ReportResolution = 'dismiss' | 'delete' | 'mute' | 'suspend';

export interface ReportInfo {
  id: string;
  status: ReportStatus;
  reporter: IdentityPublic;
  target: IdentityPublic | null;
  snapshot: ReportSnapshot;
  /** Up to 5 lines before and after the reported one, same channel, oldest first. */
  context: ReportSnapshot[];
  /** For a group chat: the handles of its members when the report was made. */
  members?: string[];
  reason: string | null;
  resolution: ReportResolution | null;
  resolvedBy: string | null;
  resolvedAt: string | null;
  notes: ReportNote[];
  createdAt: string;
}

export type ModActionKind =
  | 'delete-message'
  | 'mute'
  | 'suspend'
  | 'lift'
  | 'role'
  | 'reset-password'
  | 'release'
  | 'ip-ban'
  | 'ip-unban'
  | 'resolve-report'
  | 'reopen-report'
  | 'note';

export interface ModLogEntry {
  id: number;
  actor: string;
  target: IdentityPublic | null;
  action: ModActionKind;
  reason: string;
  detail: Record<string, unknown>;
  createdAt: string;
}

export interface PersonSummary {
  identity: IdentityPublic;
  sanction: SanctionInfo | null;
  lastSeenAt: string;
}

export interface PersonDetail {
  profile: Profile;
  sanction: SanctionInfo | null;
  sessions: number;
  lastIp: string | null;
  history: ModLogEntry[];
}

export interface MeResponse {
  identity: IdentityPublic;
  presence: PresenceInfo | null;
  activeMatch: string | null;
  queued: string | null;
  sanction: SanctionInfo | null;
  /** The table you're at (gathering, starting or playing), if any. */
  table: TableInfo | null;
  /** Invites waiting for your answer. */
  invites: InviteOffer[];
}

export type WsClientMsg =
  | { type: 'subscribe'; channel: string }
  | { type: 'unsubscribe'; channel: string }
  | { type: 'watch'; matchId: string }
  | { type: 'unwatch'; matchId: string }
  | { type: 'watchTable'; tableId: string }
  | { type: 'unwatchTable'; tableId: string }
  | { type: 'ping' }
  /** A person's key in a real-time match they're seated in: moves queue, modifiers ride along. */
  | { type: 'steer'; matchId: string; key: string };

export type WsServerMsg =
  | { type: 'hello'; identity: IdentityPublic; presence: PresenceInfo[] }
  | { type: 'presence'; presence: PresenceInfo }
  | { type: 'chat'; message: ChatMessage }
  | { type: 'inbox'; event: InboxEvent }
  | { type: 'match'; envelope: MatchEnvelope }
  | { type: 'chat.removed'; channel: string; id: number; by: string }
  | { type: 'tables'; tables: TableInfo[] }
  | { type: 'table'; table: TableInfo }
  | { type: 'table.gone'; tableId: string }
  | { type: 'pong' };

/** Public chat channels. A table talks in `table:<id>` and its spectators in `rail:<id>`;
 *  `match:<id>` is an alias for the match's table channel. */
export const PUBLIC_CHANNELS = ['lobby'] as const;
/** Channels that once were public; their history stays, and reads and posts are refused with a pointer. */
export const RETIRED_CHANNELS = ['critical-mass'] as const;
export const DIARY_CHANNEL = 'diary';

/** A season is a UTC calendar month, e.g. "2026-09". */
export function seasonOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 7);
}
