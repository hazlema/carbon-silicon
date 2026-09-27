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
}

export interface MatchEnvelope {
  match: MatchSummary;
  you: string | null;
  view: unknown;
  legal: unknown[];
}

type Stamp = { cursor: number; at: string };
export type InboxEvent =
  | (Stamp & { type: 'chat.mention'; message: ChatMessage })
  | (Stamp & { type: 'chat.table'; message: ChatMessage })
  | (Stamp & { type: 'match.started'; match: MatchSummary })
  | (Stamp & { type: 'match.yourTurn'; matchId: string; revision: number; deadline: string })
  | (Stamp & { type: 'match.over'; matchId: string; outcome: OutcomeWire; result: 'win' | 'loss' | 'draw' })
  | (Stamp & { type: 'moderation'; kind: SanctionKind | 'lift'; reason: string; endsAt: string | null })
  | (Stamp & { type: 'report.opened'; report: ReportInfo })
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
  result: 'win' | 'loss' | 'draw' | 'abandoned' | null;
  opponents: IdentityPublic[];
}

export interface Profile {
  identity: IdentityPublic;
  joinedAt: string;
  lastSeenAt: string;
  matches: ProfileMatch[];
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
  | { type: 'ping' };

export type WsServerMsg =
  | { type: 'hello'; identity: IdentityPublic; presence: PresenceInfo[] }
  | { type: 'presence'; presence: PresenceInfo }
  | { type: 'chat'; message: ChatMessage }
  | { type: 'inbox'; event: InboxEvent }
  | { type: 'match'; envelope: MatchEnvelope }
  | { type: 'chat.removed'; channel: string; id: number; by: string }
  | { type: 'pong' };

/** Public chat channels in M1. Table channels are `match:<id>`. */
export const PUBLIC_CHANNELS = ['lobby', 'critical-mass'] as const;
export const DIARY_CHANNEL = 'diary';

/** A season is a UTC calendar month, e.g. "2026-09". */
export function seasonOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 7);
}
