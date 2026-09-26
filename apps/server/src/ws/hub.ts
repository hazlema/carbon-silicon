import type { ServerWebSocket } from 'bun';
import type { IdentityPublic, WsClientMsg, WsServerMsg } from '@cs/shared/protocol';
import type { Core } from '../core/core';

export interface WsData {
  identity: IdentityPublic;
  channels: Set<string>;
  matches: Set<string>;
}
type Socket = ServerWebSocket<WsData>;

const send = (ws: Socket, msg: WsServerMsg) => {
  ws.send(JSON.stringify(msg));
};

/** The human door: pushes presence, subscribed chat, inbox events and watched match views. */
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
      core.bus.on('inbox', ({ identityId, event }) => {
        for (const ws of this.byIdentity.get(identityId) ?? []) send(ws, { type: 'inbox', event });
      }),
      core.bus.on('match.updated', ({ matchId }) => {
        for (const ws of this.all) if (ws.data.matches.has(matchId)) this.pushMatch(ws, matchId);
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

  readonly handlers = {
    open: (ws: Socket) => {
      this.all.add(ws);
      const id = ws.data.identity.id;
      const set = this.byIdentity.get(id) ?? new Set<Socket>();
      set.add(ws);
      this.byIdentity.set(id, set);
      this.core.presence.humanConnected(ws.data.identity);
      send(ws, { type: 'hello', identity: ws.data.identity, presence: this.core.presence.list() });
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
        case 'subscribe':
          if (typeof msg.channel === 'string' && this.core.comms.channelKind(msg.channel)) ws.data.channels.add(msg.channel);
          break;
        case 'unsubscribe':
          ws.data.channels.delete(msg.channel);
          break;
        case 'watch':
          if (typeof msg.matchId === 'string') {
            ws.data.matches.add(msg.matchId);
            this.pushMatch(ws, msg.matchId);
          }
          break;
        case 'unwatch':
          ws.data.matches.delete(msg.matchId);
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
    },
  };

  stop(): void {
    for (const off of this.offs) off();
  }
}
