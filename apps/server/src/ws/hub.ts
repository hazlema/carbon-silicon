import type { ServerWebSocket } from 'bun';
import { dmParticipants, groupOf, type IdentityPublic, type WsClientMsg, type WsServerMsg } from '@cs/shared/protocol';
import type { Core } from '../core/core';

export interface WsData {
  identity: IdentityPublic;
  /** The session this socket signed in with; revoking it closes the socket. */
  sessionId: string | null;
  /** The client's address; banning it closes the socket. */
  ip: string | null;
  channels: Set<string>;
  matches: Set<string>;
  tables: Set<string>;
}
type Socket = ServerWebSocket<WsData>;

/** Close code for "your session ended": the page re-reads who it is instead of reconnecting blindly. */
export const SIGNED_OUT = 4001;

const send = (ws: Socket, msg: WsServerMsg) => {
  ws.send(JSON.stringify(msg));
};

/** The human door: pushes presence, subscribed chat, inbox events, watched matches and tables. */
export class WsHub {
  private all = new Set<Socket>();
  private byIdentity = new Map<string, Set<Socket>>();
  private offs: (() => void)[] = [];

  constructor(private core: Core) {
    this.offs.push(
      core.bus.on('presence.changed', (presence) => {
        for (const ws of this.all) send(ws, { type: 'presence', presence });
      }),
      core.bus.on('chat.message', (message) => {
        for (const ws of this.all) if (ws.data.channels.has(message.channel)) send(ws, { type: 'chat', message });
      }),
      core.bus.on('dm.message', ({ message, to }) => {
        for (const id of to) for (const ws of this.byIdentity.get(id) ?? []) send(ws, { type: 'chat', message });
      }),
      core.bus.on('group.message', ({ message, to }) => {
        for (const id of to) for (const ws of this.byIdentity.get(id) ?? []) send(ws, { type: 'chat', message });
      }),
      core.bus.on('chat.removed', (removed) => {
        const groupId = groupOf(removed.channel);
        if (groupId) {
          void core.groups
            .memberIds(groupId)
            .then((ids) => {
              for (const id of ids) for (const ws of this.byIdentity.get(id) ?? []) send(ws, { type: 'chat.removed', ...removed });
            })
            .catch((e) => console.error("[hub] could not reach a group's members", e));
          return;
        }
        const pair = dmParticipants(removed.channel);
        if (pair) {
          for (const id of pair) for (const ws of this.byIdentity.get(id) ?? []) send(ws, { type: 'chat.removed', ...removed });
          return;
        }
        for (const ws of this.all) if (ws.data.channels.has(removed.channel)) send(ws, { type: 'chat.removed', ...removed });
      }),
      core.bus.on('inbox', ({ identityId, event }) => {
        for (const ws of this.byIdentity.get(identityId) ?? []) send(ws, { type: 'inbox', event });
      }),
      core.bus.on('match.updated', ({ matchId }) => {
        for (const ws of this.all) if (ws.data.matches.has(matchId)) this.pushMatch(ws, matchId);
      }),
      core.bus.on('table.changed', ({ tableId }) => this.tableChanged(tableId)),
      core.bus.on('sessions.ended', ({ sessionIds }) => {
        const ended = new Set(sessionIds);
        for (const ws of [...this.all]) if (ws.data.sessionId && ended.has(ws.data.sessionId)) ws.close(SIGNED_OUT, 'signed out');
      }),
      core.bus.on('ip.banned', ({ ip }) => {
        for (const ws of [...this.all]) if (ws.data.ip === ip) ws.close(SIGNED_OUT, 'signed out');
      }),
    );
  }

  private pushMatch(ws: Socket, matchId: string): void {
    try {
      send(ws, { type: 'match', envelope: this.core.games.envelope(matchId, ws.data.identity.id) });
    } catch {
      ws.data.matches.delete(matchId);
    }
  }

  private pushTable(ws: Socket, tableId: string): void {
    try {
      send(ws, { type: 'table', table: this.core.tables.get(tableId, ws.data.identity.id) });
    } catch {
      ws.data.tables.delete(tableId);
      send(ws, { type: 'table.gone', tableId });
    }
  }

  private tableChanged(tableId: string): void {
    const tables = this.core.tables.list();
    for (const ws of this.all) {
      send(ws, { type: 'tables', tables });
      if (ws.data.tables.has(tableId)) this.pushTable(ws, tableId);
    }
    this.recount(tableId);
  }

  /** Spectators: distinct people with the table page open who aren't its players. */
  private recount(tableId: string): void {
    let players: Set<string>;
    try {
      const t = this.core.tables.get(tableId, null);
      players = new Set([...t.seated, ...t.lastPlayers].map((p) => p.id));
    } catch {
      return;
    }
    const watchers = new Set<string>();
    for (const ws of this.all) {
      if (ws.data.tables.has(tableId) && !players.has(ws.data.identity.id)) watchers.add(ws.data.identity.id);
    }
    this.core.tables.setWatching(tableId, watchers.size);
  }

  readonly handlers = {
    open: (ws: Socket) => {
      this.all.add(ws);
      const id = ws.data.identity.id;
      const set = this.byIdentity.get(id) ?? new Set<Socket>();
      set.add(ws);
      this.byIdentity.set(id, set);
      this.core.presence.humanConnected(ws.data.identity);
      // Back after the grace period: presence forgot the match, the game manager didn't.
      if (this.core.games.activeMatchOf(id)) this.core.presence.setPlaying(id, true);
      send(ws, { type: 'hello', identity: ws.data.identity, presence: this.core.presence.list() });
      send(ws, { type: 'tables', tables: this.core.tables.list() });
    },
    message: (ws: Socket, raw: string | Buffer) => {
      this.core.presence.humanActivity(ws.data.identity.id);
      let msg: WsClientMsg;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      switch (msg?.type) {
        case 'subscribe': {
          const kind = typeof msg.channel === 'string' ? this.core.comms.channelKind(msg.channel) : null;
          // DMs and groups are pushed to their people directly; nobody subscribes to one.
          if (kind && kind !== 'dm' && kind !== 'group') {
            const raw = msg.channel;
            ws.data.channels.add(raw);
            void this.core.comms
              .resolve(raw)
              .then((ch) => {
                if (ws.data.channels.has(raw)) ws.data.channels.add(ch);
              })
              .catch(() => {});
          }
          break;
        }
        case 'unsubscribe': {
          const raw = msg.channel;
          ws.data.channels.delete(raw);
          void this.core.comms
            .resolve(raw)
            .then((ch) => ws.data.channels.delete(ch))
            .catch(() => {});
          break;
        }
        case 'watch':
          if (typeof msg.matchId === 'string') {
            ws.data.matches.add(msg.matchId);
            this.pushMatch(ws, msg.matchId);
          }
          break;
        case 'unwatch':
          ws.data.matches.delete(msg.matchId);
          break;
        case 'watchTable':
          if (typeof msg.tableId === 'string') {
            ws.data.tables.add(msg.tableId);
            this.pushTable(ws, msg.tableId);
            this.recount(msg.tableId);
          }
          break;
        case 'unwatchTable':
          if (ws.data.tables.delete(msg.tableId)) this.recount(msg.tableId);
          break;
        case 'steer':
          if (typeof msg.matchId === 'string' && typeof msg.key === 'string') this.core.games.steer(ws.data.identity.id, msg.matchId, msg.key);
          break;
        case 'ping':
          send(ws, { type: 'pong' });
          break;
      }
    },
    close: (ws: Socket) => {
      this.all.delete(ws);
      const id = ws.data.identity.id;
      const set = this.byIdentity.get(id);
      set?.delete(ws);
      if (set && set.size === 0) this.byIdentity.delete(id);
      this.core.presence.humanDisconnected(id);
      for (const tableId of ws.data.tables) this.recount(tableId);
    },
  };

  stop(): void {
    for (const off of this.offs) off();
  }
}
