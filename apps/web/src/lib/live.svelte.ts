import type {
  ChatMessage,
  DmSummary,
  GameInfo,
  GroupInfo,
  IdentityPublic,
  InboxEvent,
  InviteOffer,
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
import { dmChannel, dmParticipants, groupOf } from '@cs/shared/protocol';
import { updated } from '$app/state';
import { api, ApiError } from './api';
import type { SteerKey } from './games/lightline/controls';
import { unreadTotal, withMessage } from './dms';
import { withGroupMessage } from './groups';
import { savePick } from './play';
import type { AgentNoticeEvent } from './owners';

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
  /** The table you're at (gathering, starting or playing). */
  myTable = $state<TableInfo | null>(null);
  /** Invites waiting for your answer. */
  offers = $state<InviteOffer[]>([]);
  games = $state<GameInfo[]>([]);
  /** Your DM conversations (spec M2c §5). */
  dms = $state<DmSummary[]>([]);
  /** Your group chats (spec M2d §5). */
  groups = $state<GroupInfo[]>([]);
  /** Unread lines across your open conversations (DMs and groups), for the Lobby link. */
  dmUnread: number = $derived(unreadTotal(this.dms) + this.groups.reduce((n, g) => n + (g.hidden ? 0 : g.unread), 0));
  /** A conversation someone asked to open (Message @x, /msg, a group). The page with a chat switches
   *  to it and clears this; `n` makes asking twice for the same one count. */
  convRequest = $state<{ channel: string; n: number } | null>(null);
  /** A line for the open conversation's notice area (e.g. who a hosted table skipped). */
  convNotice = $state<{ channel: string; text: string } | null>(null);
  /** The conversation on screen (lobby or table), so a name menu can offer to invite into it first. */
  openConv = $state<string | null>(null);
  get dmRequest() {
    return this.convRequest;
  }
  set dmRequest(v: { channel: string; n: number } | null) {
    this.convRequest = v;
  }
  /** What moderators did to your agents, until you dismiss it (at most the last 5). */
  agentNotices = $state<AgentNoticeEvent[]>([]);

  dismissAgentNotice(cursor: number): void {
    this.agentNotices = this.agentNotices.filter((e) => e.cursor !== cursor);
  }
  /** Everyone you ignore or block; their chat is hidden for you. */
  hiddenAuthors: Set<string> = $derived(new Set([...this.relations.ignores, ...this.relations.blocks].map((i) => i.id)));
  myStatus: Status = $derived(this.presence.find((p) => p.identity.id === this.me?.id)?.status ?? 'offline');

  #ws: WebSocket | null = null;
  #retry = 0;
  #everOpened = false;
  #chat = new Map<string, Set<Listener<ChatMessage>>>();
  #conv = new Set<Listener<ChatMessage>>();
  #removed = new Map<string, Set<Listener<Removal>>>();
  #tableWatch = new Map<string, Set<Listener<TableInfo | null>>>();
  #matches = new Map<string, Set<Listener<MatchEnvelope>>>();
  #inbox = new Set<Listener<InboxEvent>>();

  async init(): Promise<void> {
    try {
      await this.refreshMe();
      this.connect();
      void this.loadGames();
      void this.loadRelations();
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 401)) console.error(e);
    } finally {
      this.checked = true;
    }
  }

  async loadGames(): Promise<void> {
    try {
      this.games = (await api<{ games: GameInfo[] }>('GET', '/api/games')).games;
    } catch (e) {
      console.error(e);
    }
  }

  /** Re-read who you are, your match and queue, and your sanction. */
  async refreshMe(): Promise<void> {
    const r = await api<MeResponse>('GET', '/api/me');
    this.me = r.identity;
    this.activeMatch = r.activeMatch;
    this.queued = r.queued;
    this.sanction = r.sanction;
    this.myTable = r.table;
    this.offers = r.invites;
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
    // init() skips loadGames() when the page first loads signed out (a fresh guest's 401 short-circuits
    // it), so the catalog wouldn't otherwise arrive until a later reload — load it here too.
    if (this.games.length === 0) void this.loadGames();
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
      savePick(null);
    }
  }

  async leaveQueue(): Promise<void> {
    await api('DELETE', '/api/quickmatch');
    this.queued = null;
  }

  #dmsLoading: Promise<void> | null = null;
  #dmsDirty = false;

  /** Replaces the list with the server's. A message that lands while the fetch is in flight may be
   *  missing from its answer (and would then be lost), so it asks for one more round; callers
   *  arriving meanwhile wait for the same run. */
  loadDms(): Promise<void> {
    if (this.#dmsLoading) {
      this.#dmsDirty = true;
      return this.#dmsLoading;
    }
    const run = (async () => {
      try {
        do {
          this.#dmsDirty = false;
          const server = (await api<{ conversations: DmSummary[] }>('GET', '/api/dms')).conversations;
          // A conversation you opened but haven't written in yet isn't on the server: keep it, first (as openDm puts it).
          const local = this.dms.filter((d) => d.last === null && !server.some((s) => s.channel === d.channel));
          this.dms = [...local, ...server];
        } while (this.#dmsDirty);
      } catch (e) {
        console.error(e);
      } finally {
        this.#dmsLoading = null;
      }
    })();
    this.#dmsLoading = run;
    return run;
  }

  /** Opens (or reopens) the conversation with someone and asks the page to show it. */
  openDm(identity: IdentityPublic): string {
    const channel = dmChannel(this.me!.id, identity.id);
    this.dms = this.dms.some((d) => d.channel === channel)
      ? this.dms.map((d) => (d.channel === channel ? { ...d, hidden: false } : d))
      : [{ with: identity, channel, last: null, unread: 0, hidden: false }, ...this.dms];
    this.#requestDm(channel);
    return channel;
  }

  /** `/msg`: send first, so a wrong name fails in the composer, then show the conversation. `open: false`
   *  (a private line sent from a table's feed) sends without switching the chat to it. */
  async sendDm(handle: string, text: string, opts: { open?: boolean } = {}): Promise<ChatMessage> {
    const r = await api<{ message: ChatMessage }>('POST', `/api/dms/${encodeURIComponent(handle)}`, { text });
    if (!this.dms.some((d) => d.channel === r.message.channel)) await this.loadDms();
    if (opts.open !== false) this.#requestDm(r.message.channel);
    return r.message;
  }

  /** You're looking at it: the dot goes here, and (through the server's dm.read) on your other devices. */
  async readDm(channel: string): Promise<void> {
    const d = this.dms.find((x) => x.channel === channel);
    if (!d || d.unread === 0) return;
    this.dms = this.dms.map((x) => (x.channel === channel ? { ...x, unread: 0 } : x));
    await api('POST', `/api/dms/${encodeURIComponent(d.with.handle)}/read`).catch((e) => console.error(e));
  }

  /** Closes a tab until the next message. One never written to is simply forgotten. */
  async closeDm(channel: string): Promise<void> {
    const d = this.dms.find((x) => x.channel === channel);
    if (!d) return;
    if (!d.last) {
      this.dms = this.dms.filter((x) => x.channel !== channel);
      return;
    }
    this.dms = this.dms.map((x) => (x.channel === channel ? { ...x, hidden: true } : x));
    await api('POST', `/api/dms/${encodeURIComponent(d.with.handle)}/close`).catch((e) => console.error(e));
  }

  #requestDm(channel: string): void {
    this.convRequest = { channel, n: (this.convRequest?.n ?? 0) + 1 };
  }

  #groupsLoading: Promise<void> | null = null;
  #groupsDirty = false;

  /** Replaces the list with the server's, with the same one-more-round guard as `loadDms`. */
  loadGroups(): Promise<void> {
    if (this.#groupsLoading) {
      this.#groupsDirty = true;
      return this.#groupsLoading;
    }
    const run = (async () => {
      try {
        do {
          this.#groupsDirty = false;
          this.groups = (await api<{ groups: GroupInfo[] }>('GET', '/api/groups')).groups;
        } while (this.#groupsDirty);
      } catch (e) {
        console.error(e);
      } finally {
        this.#groupsLoading = null;
      }
    })();
    this.#groupsLoading = run;
    return run;
  }

  #upsertGroup(g: GroupInfo): void {
    this.groups = this.groups.some((x) => x.id === g.id) ? this.groups.map((x) => (x.id === g.id ? g : x)) : [g, ...this.groups];
  }

  /** Shows a group's tab (new, or closed) and asks the page to switch to it. */
  openGroup(g: GroupInfo): void {
    this.#upsertGroup({ ...g, hidden: false });
    this.#requestDm(g.channel);
  }

  /** You're looking at it: the dot goes here, and (through the server's group.read) on your other devices. */
  async readGroup(channel: string): Promise<void> {
    const g = this.groups.find((x) => x.channel === channel);
    if (!g || g.unread === 0) return;
    this.groups = this.groups.map((x) => (x.channel === channel ? { ...x, unread: 0 } : x));
    await api('POST', `/api/groups/${g.id}/read`).catch((e) => console.error(e));
  }

  /** Closes a tab until the next line from a person. */
  async closeGroup(channel: string): Promise<void> {
    const g = this.groups.find((x) => x.channel === channel);
    if (!g) return;
    this.groups = this.groups.map((x) => (x.channel === channel ? { ...x, hidden: true } : x));
    await api('POST', `/api/groups/${g.id}/close`).catch((e) => console.error(e));
  }

  #groupMessage(m: ChatMessage): void {
    const meId = this.me?.id;
    if (!meId) return;
    if (!this.groups.some((g) => g.channel === m.channel)) {
      void this.loadGroups(); // a group this page hasn't heard of yet
      return;
    }
    if (this.#groupsLoading) this.#groupsDirty = true;
    this.groups = withGroupMessage(this.groups, m, meId);
  }

  /** A group the page just changed itself (renamed, someone added): show it without waiting for group.changed. */
  putGroup(g: GroupInfo): void {
    this.#upsertGroup(g);
  }

  /** A group you just left: its tab goes. */
  dropGroup(id: string): void {
    this.groups = this.groups.filter((g) => g.id !== id);
  }

  async #reloadGroup(groupId: string): Promise<void> {
    const had = this.groups.some((g) => g.id === groupId);
    try {
      const { group } = await api<{ group: GroupInfo }>('GET', `/api/groups/${groupId}`);
      // A group.gone that landed while this read was in flight wins; a group we never had (we were just added) still appears.
      if (had && !this.groups.some((g) => g.id === groupId)) return;
      this.#upsertGroup(group);
    } catch (e) {
      console.error(e);
    }
  }

  #dmMessage(m: ChatMessage): void {
    const meId = this.me?.id;
    if (!meId) return;
    const prev = this.dms.find((d) => d.channel === m.channel);
    const other = m.author && m.author.id !== meId ? m.author : prev?.with;
    if (!other) {
      void this.loadDms(); // your own first line from another device: fetch who it's with
      return;
    }
    if (this.#dmsLoading) this.#dmsDirty = true;
    this.dms = withMessage(this.dms, m, other, meId);
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
      void this.loadDms();
      void this.loadGroups();
      for (const channel of this.#chat.keys()) if (!dmParticipants(channel) && !groupOf(channel)) this.#send({ type: 'subscribe', channel });
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
    ws.onclose = (e) => {
      this.connected = false;
      this.#ws = null;
      if (e.code === 4001) {
        // Signed out from elsewhere: start over from a clean page, as signOut() does, so nothing
        // of this person's (DMs, relations, notices) is left for whoever uses the browser next.
        void this.refreshMe().catch(() => location.assign('/'));
      }
      const delay = Math.min(10_000, 500 * 2 ** this.#retry++);
      setTimeout(() => {
        if (this.me) this.connect();
      }, delay);
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
        const before = this.presence.find((p) => p.identity.id === msg.presence.identity.id)?.status;
        const rest = this.presence.filter((p) => p.identity.id !== msg.presence.identity.id);
        this.presence = msg.presence.status === 'offline' ? rest : [...rest, msg.presence].sort(byHandle);
        // Out of a match that plays on without you (resigned, forfeited, eliminated): no match.over
        // comes until it ends, so ask the server where you stand now.
        if (msg.presence.identity.id === this.me?.id && before === 'playing' && msg.presence.status !== 'playing' && this.activeMatch) {
          void this.refreshMe().catch((e) => console.error(e));
        }
        break;
      }
      case 'chat':
        if (dmParticipants(msg.message.channel)) this.#dmMessage(msg.message);
        else if (groupOf(msg.message.channel)) this.#groupMessage(msg.message);
        if (dmParticipants(msg.message.channel) || groupOf(msg.message.channel)) for (const fn of this.#conv) fn(msg.message);
        for (const fn of this.#chat.get(msg.message.channel) ?? []) fn(msg.message);
        break;
      case 'chat.removed':
        for (const fn of this.#removed.get(msg.channel) ?? []) fn({ id: msg.id, by: msg.by });
        break;
      case 'inbox':
        if (msg.event.type === 'match.started') {
          this.activeMatch = msg.event.match.id;
          this.queued = null;
          // The lobby's game pick was for this match; once it starts, the Play panel starts fresh.
          savePick(null);
        }
        if (msg.event.type === 'match.over' && this.activeMatch === msg.event.matchId) this.activeMatch = null;
        // A sanction started or ended: the server may also have resigned a match or dropped a queue entry.
        if (msg.event.type === 'moderation') void this.refreshMe().catch((e) => console.error(e));
        if (msg.event.type === 'dm.read') {
          const read = msg.event.channel;
          this.dms = this.dms.map((d) => (d.channel === read ? { ...d, unread: 0 } : d));
        }
        if (msg.event.type === 'group.changed') void this.#reloadGroup(msg.event.groupId);
        if (msg.event.type === 'group.gone') {
          const gone = msg.event.groupId;
          this.groups = this.groups.filter((g) => g.id !== gone);
        }
        if (msg.event.type === 'group.read') {
          const read = msg.event.groupId;
          this.groups = this.groups.map((g) => (g.id === read ? { ...g, unread: 0 } : g));
        }
        if (msg.event.type === 'moderation.agent') this.agentNotices = [...this.agentNotices, msg.event].slice(-5);
        this.#tableEvent(msg.event);
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

  /** Keeps `myTable` and `offers` in step with the inbox. */
  #tableEvent(event: InboxEvent): void {
    const meId = this.me?.id;
    switch (event.type) {
      case 'invite.received':
        this.offers = [...this.offers.filter((o) => o.invite.id !== event.invite.id), { invite: event.invite, from: event.from, table: event.table }];
        break;
      case 'invite.cancelled':
        this.offers = this.offers.filter((o) => o.invite.id !== event.inviteId);
        break;
      case 'table.updated': {
        const t = event.table;
        const seated = !!meId && t.seated.some((p) => p.id === meId);
        if (seated && t.status !== 'finished') this.myTable = t;
        else if (this.myTable?.id === t.id) this.myTable = null;
        this.offers = this.offers.map((o) => (o.table.id === t.id ? { ...o, table: t } : o));
        break;
      }
      case 'table.closed':
        if (this.myTable?.id === event.tableId) this.myTable = null;
        this.offers = this.offers.filter((o) => o.table.id !== event.tableId);
        break;
      case 'match.over':
        if (this.myTable?.matchId === event.matchId) this.myTable = null;
        break;
    }
  }

  onChat(channel: string, fn: Listener<ChatMessage>): () => void {
    let set = this.#chat.get(channel);
    if (!set) {
      set = new Set();
      this.#chat.set(channel, set);
      if (!dmParticipants(channel) && !groupOf(channel)) this.#send({ type: 'subscribe', channel });
    }
    set.add(fn);
    return () => {
      set.delete(fn);
      if (set.size === 0) {
        this.#chat.delete(channel);
        if (!dmParticipants(channel) && !groupOf(channel)) this.#send({ type: 'unsubscribe', channel });
      }
    };
  }

  /** Every incoming line of any DM or group (after the lists took it in), including conversations that had no tab yet. */
  onConversation(fn: Listener<ChatMessage>): () => void {
    this.#conv.add(fn);
    return () => this.#conv.delete(fn);
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

  /** A key for a real-time match you're seated in; the server drops it when it doesn't apply. */
  steer(matchId: string, key: SteerKey): void {
    this.#send({ type: 'steer', matchId, key });
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
