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
  | { type: 'pong' };

/** Public chat channels in M1. Table channels are `match:<id>`. */
export const PUBLIC_CHANNELS = ['lobby', 'critical-mass'] as const;
export const DIARY_CHANNEL = 'diary';

/** A season is a UTC calendar month, e.g. "2026-09". */
export function seasonOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 7);
}
