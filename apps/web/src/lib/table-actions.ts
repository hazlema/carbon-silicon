import type { MatchSummary, TableInfo } from '@cs/shared/protocol';
import { api } from './api';
import { live } from './live.svelte';
import { gameFor, splitGame } from './tables';

const mine = (t: TableInfo) => {
  live.myTable = t;
  return t;
};

/** Every table action goes through the same routes an agent uses. */
export const tableApi = {
  host: async (gameId: string, invite?: string[]) =>
    mine((await api<{ table: TableInfo }>('POST', '/api/tables', { gameId, ...(invite?.length ? { invite } : {}) })).table),
  vsHouse: async (gameId: string, bot?: string) =>
    mine((await api<{ table: TableInfo }>('POST', '/api/vs-house', { gameId, ...(bot ? { bot } : {}) })).table),
  invite: async (tableId: string, handles: string[]) => mine((await api<{ table: TableInfo }>('POST', `/api/tables/${tableId}/invite`, { handles })).table),
  remove: async (tableId: string, handle: string) => mine((await api<{ table: TableInfo }>('POST', `/api/tables/${tableId}/remove`, { handle })).table),
  setOpen: async (tableId: string, open: boolean) => mine((await api<{ table: TableInfo }>('PATCH', `/api/tables/${tableId}`, { open })).table),
  sit: async (tableId: string) => mine((await api<{ table: TableInfo }>('POST', `/api/tables/${tableId}/sit`)).table),
  start: (tableId: string) => api<{ match: MatchSummary }>('POST', `/api/tables/${tableId}/start`),
  leave: async (tableId: string) => {
    await api('POST', `/api/tables/${tableId}/leave`);
    live.myTable = null;
  },
  disband: async (tableId: string) => {
    await api('DELETE', `/api/tables/${tableId}`);
    live.myTable = null;
  },
  rematch: async (tableId: string) => mine((await api<{ table: TableInfo }>('POST', `/api/tables/${tableId}/rematch`)).table),
  accept: async (inviteId: string) => {
    const t = (await api<{ table: TableInfo }>('POST', `/api/invites/${inviteId}/accept`)).table;
    live.offers = live.offers.filter((o) => o.invite.id !== inviteId);
    return mine(t);
  },
  decline: async (inviteId: string) => {
    live.offers = live.offers.filter((o) => o.invite.id !== inviteId);
    await api('POST', `/api/invites/${inviteId}/decline`);
  },
};

/** Invite someone to the table you're hosting. */
export async function inviteHandle(handle: string): Promise<void> {
  const t = live.myTable;
  if (!t) throw new Error('Host a table first.');
  await tableApi.invite(t.id, [handle]);
}

/** Host a table (and invite these people straight away). */
export async function hostWith(gameId: string, handles: string[] = []): Promise<void> {
  await tableApi.host(gameId, handles);
}

/** `/invite a, b [game]` from a chat box. Returns a line to show; throws with the reason. */
export async function runInviteCommand(words: string[], channel: string): Promise<string> {
  const { handles, game } = splitGame(words, live.games);
  if (handles.length === 0) throw new Error('Who? Try /invite DiceRoller');
  const names = handles.map((h) => `@${h}`).join(', ');
  const t = live.myTable;
  if (t && t.status === 'forming' && t.host.id === live.me?.id) {
    await tableApi.invite(t.id, handles);
    return `Invited ${names}.`;
  }
  if (t) throw new Error("You're at a table already. Leave it first.");
  const g = gameFor(game, channel, live.games);
  if (!g) throw new Error('Which game? Try /invite DiceRoller critical-mass');
  await hostWith(g.id, handles);
  return `Invited ${names} to ${g.name}.`;
}
