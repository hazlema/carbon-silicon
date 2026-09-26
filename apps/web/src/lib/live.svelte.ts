import type {
  ChatMessage,
  IdentityPublic,
  InboxEvent,
  MatchEnvelope,
  PresenceInfo,
  Status,
  WsClientMsg,
  WsServerMsg,
} from '@cs/shared/protocol';
import { api, ApiError } from './api';

type Listener<T> = (value: T) => void;

const byHandle = (a: PresenceInfo, b: PresenceInfo) =>
  a.identity.handle.toLowerCase().localeCompare(b.identity.handle.toLowerCase());

/** The one live connection: session, presence, and fan-out of pushed events to components. */
class Live {
  me = $state<IdentityPublic | null>(null);
  checked = $state(false);
  connected = $state(false);
  /** Bumped each time the socket reopens after the first connection, so listeners can catch up on what they missed. */
  reconnects = $state(0);
  presence = $state<PresenceInfo[]>([]);
  activeMatch = $state<string | null>(null);
  queued = $state<string | null>(null);
  myStatus: Status = $derived(this.presence.find((p) => p.identity.id === this.me?.id)?.status ?? 'offline');

  #ws: WebSocket | null = null;
  #retry = 0;
  #everOpened = false;
  #chat = new Map<string, Set<Listener<ChatMessage>>>();
  #matches = new Map<string, Set<Listener<MatchEnvelope>>>();
  #inbox = new Set<Listener<InboxEvent>>();

  async init(): Promise<void> {
    try {
      const r = await api<{ identity: IdentityPublic; activeMatch: string | null; queued: string | null }>('GET', '/api/me');
      this.me = r.identity;
      this.activeMatch = r.activeMatch;
      this.queued = r.queued;
      this.connect();
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 401)) console.error(e);
    } finally {
      this.checked = true;
    }
  }

  async join(handle: string): Promise<void> {
    const r = await api<{ identity: IdentityPublic }>('POST', '/api/session', { handle });
    this.me = r.identity;
    this.connect();
  }

  async setStatus(status: 'ready' | 'afk'): Promise<void> {
    await api('PATCH', '/api/me', { status });
  }

  async quickMatch(gameId: string): Promise<void> {
    const r = await api<{ status: 'queued' } | { status: 'matched'; match: { id: string } }>('POST', '/api/quickmatch', { gameId });
    if (r.status === 'queued') {
      this.queued = gameId;
    } else {
      this.queued = null;
      this.activeMatch = r.match.id;
    }
  }

  async leaveQueue(): Promise<void> {
    await api('DELETE', '/api/quickmatch');
    this.queued = null;
  }

  connect(): void {
    if (this.#ws || typeof window === 'undefined') return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.#ws = ws;
    ws.onopen = () => {
      this.connected = true;
      this.#retry = 0;
      if (this.#everOpened) this.reconnects += 1;
      this.#everOpened = true;
      for (const channel of this.#chat.keys()) this.#send({ type: 'subscribe', channel });
      for (const matchId of this.#matches.keys()) this.#send({ type: 'watch', matchId });
    };
    ws.onmessage = (e) => {
      let msg: WsServerMsg;
      try {
        msg = JSON.parse(String(e.data)) as WsServerMsg;
      } catch {
        return;
      }
      this.#handle(msg);
    };
    ws.onclose = () => {
      this.connected = false;
      this.#ws = null;
      const delay = Math.min(10_000, 500 * 2 ** this.#retry++);
      setTimeout(() => this.connect(), delay);
    };
  }

  #send(msg: WsClientMsg): void {
    if (this.#ws?.readyState === WebSocket.OPEN) this.#ws.send(JSON.stringify(msg));
  }

  #handle(msg: WsServerMsg): void {
    switch (msg.type) {
      case 'hello':
        this.me = msg.identity;
        this.presence = [...msg.presence].sort(byHandle);
        break;
      case 'presence': {
        const rest = this.presence.filter((p) => p.identity.id !== msg.presence.identity.id);
        this.presence = msg.presence.status === 'offline' ? rest : [...rest, msg.presence].sort(byHandle);
        break;
      }
      case 'chat':
        for (const fn of this.#chat.get(msg.message.channel) ?? []) fn(msg.message);
        break;
      case 'inbox':
        if (msg.event.type === 'match.started') {
          this.activeMatch = msg.event.match.id;
          this.queued = null;
        }
        if (msg.event.type === 'match.over' && this.activeMatch === msg.event.matchId) this.activeMatch = null;
        for (const fn of this.#inbox) fn(msg.event);
        break;
      case 'match':
        for (const fn of this.#matches.get(msg.envelope.match.id) ?? []) fn(msg.envelope);
        break;
      case 'pong':
        break;
    }
  }

  onChat(channel: string, fn: Listener<ChatMessage>): () => void {
    let set = this.#chat.get(channel);
    if (!set) {
      set = new Set();
      this.#chat.set(channel, set);
      this.#send({ type: 'subscribe', channel });
    }
    set.add(fn);
    return () => {
      set.delete(fn);
      if (set.size === 0) {
        this.#chat.delete(channel);
        this.#send({ type: 'unsubscribe', channel });
      }
    };
  }

  watchMatch(matchId: string, fn: Listener<MatchEnvelope>): () => void {
    let set = this.#matches.get(matchId);
    if (!set) {
      set = new Set();
      this.#matches.set(matchId, set);
      this.#send({ type: 'watch', matchId });
    }
    set.add(fn);
    return () => {
      set.delete(fn);
      if (set.size === 0) {
        this.#matches.delete(matchId);
        this.#send({ type: 'unwatch', matchId });
      }
    };
  }

  onInbox(fn: Listener<InboxEvent>): () => void {
    this.#inbox.add(fn);
    return () => this.#inbox.delete(fn);
  }
}

export const live = new Live();
