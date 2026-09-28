import type {
  ChatMessage,
  IdentityPublic,
  InboxEvent,
  MatchEnvelope,
  MeResponse,
  PresenceInfo,
  RelationsInfo,
  SanctionInfo,
  Status,
  TableInfo,
  WsClientMsg,
  WsServerMsg,
} from '@cs/shared/protocol';
import { updated } from '$app/state';
import { api, ApiError } from './api';

type Listener<T> = (value: T) => void;
export type Removal = { id: number; by: string };

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
  /** Your active mute or suspension, if any. */
  sanction = $state<SanctionInfo | null>(null);
  relations = $state<RelationsInfo>({ ignores: [], blocks: [] });
  /** The lobby's tables: open ones gathering, and ones playing now (pushed by the server). */
  tables = $state<TableInfo[]>([]);
  /** Everyone you ignore or block; their chat is hidden for you. */
  hiddenAuthors: Set<string> = $derived(new Set([...this.relations.ignores, ...this.relations.blocks].map((i) => i.id)));
  myStatus: Status = $derived(this.presence.find((p) => p.identity.id === this.me?.id)?.status ?? 'offline');

  #ws: WebSocket | null = null;
  #retry = 0;
  #everOpened = false;
  #chat = new Map<string, Set<Listener<ChatMessage>>>();
  #removed = new Map<string, Set<Listener<Removal>>>();
  #tableWatch = new Map<string, Set<Listener<TableInfo | null>>>();
  #matches = new Map<string, Set<Listener<MatchEnvelope>>>();
  #inbox = new Set<Listener<InboxEvent>>();

  async init(): Promise<void> {
    try {
      await this.refreshMe();
      this.connect();
      void this.loadRelations();
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 401)) console.error(e);
    } finally {
      this.checked = true;
    }
  }

  /** Re-read who you are, your match and queue, and your sanction. */
  async refreshMe(): Promise<void> {
    const r = await api<MeResponse>('GET', '/api/me');
    this.me = r.identity;
    this.activeMatch = r.activeMatch;
    this.queued = r.queued;
    this.sanction = r.sanction;
  }

  async join(handle: string): Promise<void> {
    const r = await api<{ identity: IdentityPublic }>('POST', '/api/session', { handle });
    await this.#signedIn(r.identity);
  }

  async signIn(handle: string, password: string): Promise<void> {
    const r = await api<{ identity: IdentityPublic }>('POST', '/api/session/login', { handle, password });
    await this.#signedIn(r.identity);
  }

  /** Sets a new password with a recovery code. The browser is already signed in afterwards, but the
   *  gate shows the new code first and calls `finishRecovery` once the player has saved it. */
  recover(handle: string, code: string, password: string): Promise<{ identity: IdentityPublic; recoveryCode: string }> {
    return api('POST', '/api/session/recover', { handle, code, password });
  }

  async finishRecovery(identity: IdentityPublic): Promise<void> {
    await this.#signedIn(identity);
  }

  async #signedIn(identity: IdentityPublic): Promise<void> {
    this.me = identity;
    try {
      await this.refreshMe();
    } catch (e) {
      console.error(e);
    }
    this.connect();
    void this.loadRelations();
  }

  /** Sign this browser out and start over from a clean page. */
  async signOut(): Promise<void> {
    await api('DELETE', '/api/session');
    location.assign('/');
  }

  async loadRelations(): Promise<void> {
    try {
      this.relations = await api<RelationsInfo>('GET', '/api/me/relations');
    } catch (e) {
      console.error(e);
    }
  }

  async setRelation(handle: string, kind: 'ignore' | 'block', on: boolean): Promise<void> {
    const path = `/api/me/${kind === 'ignore' ? 'ignores' : 'blocks'}/${encodeURIComponent(handle)}`;
    this.relations = await api<RelationsInfo>(on ? 'PUT' : 'DELETE', path);
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
      if (this.#everOpened) {
        this.reconnects += 1;
        // A reconnect is a good time to check whether a new build shipped while we were away.
        void updated.check().catch(() => {});
      }
      this.#everOpened = true;
      // A sanction (or a session revocation, a release, an IP ban) that lands in the gap between
      // the earlier refreshMe() and the socket actually opening would otherwise be missed until
      // the next authenticated request; re-read /api/me on every open, first connect included, to
      // close that window. This also fires on every reconnect, so a push missed while offline is
      // caught up here rather than waiting on the next push.
      void this.refreshMe().catch((e) => console.error(e));
      for (const channel of this.#chat.keys()) this.#send({ type: 'subscribe', channel });
      for (const matchId of this.#matches.keys()) this.#send({ type: 'watch', matchId });
      for (const tableId of this.#tableWatch.keys()) this.#send({ type: 'watchTable', tableId });
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
      case 'chat.removed':
        for (const fn of this.#removed.get(msg.channel) ?? []) fn({ id: msg.id, by: msg.by });
        break;
      case 'inbox':
        if (msg.event.type === 'match.started') {
          this.activeMatch = msg.event.match.id;
          this.queued = null;
        }
        if (msg.event.type === 'match.over' && this.activeMatch === msg.event.matchId) this.activeMatch = null;
        // A sanction started or ended: the server may also have resigned a match or dropped a queue entry.
        if (msg.event.type === 'moderation') void this.refreshMe().catch((e) => console.error(e));
        for (const fn of this.#inbox) fn(msg.event);
        break;
      case 'match':
        for (const fn of this.#matches.get(msg.envelope.match.id) ?? []) fn(msg.envelope);
        break;
      case 'tables':
        this.tables = msg.tables;
        break;
      case 'table':
        for (const fn of this.#tableWatch.get(msg.table.id) ?? []) fn(msg.table);
        break;
      case 'table.gone':
        for (const fn of this.#tableWatch.get(msg.tableId) ?? []) fn(null);
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

  /** Messages a mod removed in a channel you already follow with `onChat`. */
  onChatRemoved(channel: string, fn: Listener<Removal>): () => void {
    let set = this.#removed.get(channel);
    if (!set) {
      set = new Set();
      this.#removed.set(channel, set);
    }
    set.add(fn);
    return () => {
      set.delete(fn);
      if (set.size === 0) this.#removed.delete(channel);
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

  /** Follow one table (seats, status, watchers). `null` means it was cleared. */
  watchTable(tableId: string, fn: Listener<TableInfo | null>): () => void {
    let set = this.#tableWatch.get(tableId);
    if (!set) {
      set = new Set();
      this.#tableWatch.set(tableId, set);
      this.#send({ type: 'watchTable', tableId });
    }
    set.add(fn);
    return () => {
      set.delete(fn);
      if (set.size === 0) {
        this.#tableWatch.delete(tableId);
        this.#send({ type: 'unwatchTable', tableId });
      }
    };
  }

  onInbox(fn: Listener<InboxEvent>): () => void {
    this.#inbox.add(fn);
    return () => this.#inbox.delete(fn);
  }
}

export const live = new Live();
