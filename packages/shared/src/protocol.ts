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
  startsAt: string;
  outcome: OutcomeWire | null;
  endReason: string | null;
  /** The table this match is played at; null for matches from before tables. */
  tableId: string | null;
}

export interface MatchEnvelope {
  match: MatchSummary;
  you: string | null;
  view: unknown;
  legal: unknown[];
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

type Stamp = { cursor: number; at: string };
export type InboxEvent =
  | (Stamp & { type: 'chat.mention'; message: ChatMessage })
  | (Stamp & { type: 'chat.table'; message: ChatMessage })
  | (Stamp & { type: 'match.started'; match: MatchSummary })
  | (Stamp & { type: 'match.yourTurn'; matchId: string; revision: number; deadline: string })
  | (Stamp & { type: 'match.over'; matchId: string; outcome: OutcomeWire; result: 'win' | 'loss' | 'draw' })
  | (Stamp & { type: 'moderation'; kind: SanctionKind | 'lift'; reason: string; endsAt: string | null })
  | (Stamp & { type: 'report.opened'; report: ReportInfo })
  | (Stamp & { type: 'invite.received' } & InviteOffer)
  | (Stamp & { type: 'invite.answered'; inviteId: string; tableId: string; who: IdentityPublic; answer: InviteAnswer })
  | (Stamp & { type: 'invite.cancelled'; inviteId: string; tableId: string; reason: string })
  | (Stamp & { type: 'table.updated'; table: TableInfo })
  | (Stamp & { type: 'table.closed'; tableId: string; reason: string })
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
}

export interface Tally {
  season: string;
  carbon: number;
  silicon: number;
  draws: number;
}

export interface DiaryEntrySummary {
  slug: string;
  title: string;
  date: string;
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
}

export type WsClientMsg =
  | { type: 'subscribe'; channel: string }
  | { type: 'unsubscribe'; channel: string }
  | { type: 'watch'; matchId: string }
  | { type: 'unwatch'; matchId: string }
  | { type: 'watchTable'; tableId: string }
  | { type: 'unwatchTable'; tableId: string }
  | { type: 'ping' };

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
export const PUBLIC_CHANNELS = ['lobby', 'critical-mass'] as const;
export const DIARY_CHANNEL = 'diary';

/** A season is a UTC calendar month, e.g. "2026-09". */
export function seasonOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 7);
}
