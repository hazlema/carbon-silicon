import type { ChatMessage, InboxEvent, PresenceInfo } from '@cs/shared/protocol';

export interface BusEvents {
  'presence.changed': PresenceInfo;
  'chat.message': ChatMessage;
  'chat.removed': { channel: string; id: number; by: string };
  /** A direct message, for the sockets of `to` only (never channel subscribers). */
  'dm.message': { message: ChatMessage; to: string[] };
  /** A group line (or system line), for the sockets of `to` only (never channel subscribers). */
  'group.message': { message: ChatMessage; to: string[] };
  inbox: { identityId: string; event: InboxEvent };
  'match.updated': { matchId: string; revision: number };
  'match.finished': { matchId: string; tableId: string | null };
  /** A match's result is in the database (or its write failed): standings may be recalculated. */
  'match.recorded': { matchId: string; gameId: string; season: string };
  'table.changed': { tableId: string };
  'sessions.ended': { sessionIds: string[] };
  'ip.banned': { ip: string };
}

type Handler<K extends keyof BusEvents> = (payload: BusEvents[K]) => void;

export class EventBus {
  private handlers = new Map<keyof BusEvents, Set<Handler<never>>>();

  on<K extends keyof BusEvents>(event: K, fn: Handler<K>): () => void {
    const set = this.handlers.get(event) ?? new Set();
    set.add(fn as Handler<never>);
    this.handlers.set(event, set);
    return () => set.delete(fn as Handler<never>);
  }

  emit<K extends keyof BusEvents>(event: K, payload: BusEvents[K]): void {
    for (const fn of [...(this.handlers.get(event) ?? [])]) {
      try {
        (fn as Handler<K>)(payload);
      } catch (e) {
        console.error(`[bus] handler for ${event} failed`, e);
      }
    }
  }
}
