import type { GameInfo, IdentityPublic, Status, TableInfo } from '@cs/shared/protocol';

/** The line the gathering card shows under the seats (same wording as the server's system lines). */
export function gatherNote(t: TableInfo, gameName: string): string {
  if (t.seated.length >= t.size) return `The table is full — @${t.host.handle}, start when you're ready.`;
  const short = t.minPlayers - t.seated.length;
  const invitesShort = short - t.invites.length;
  if (invitesShort > 0) return `${gameName} needs at least ${t.minPlayers} players — invite ${invitesShort} more to start.`;
  if (short > 0) return t.invites.length === 1 ? `Waiting for @${t.invites[0].to.handle} to accept.` : 'Waiting for an invite to be accepted.';
  // How to invite is the host's own hint under this line, so the note only says where things stand.
  return t.invites.length > 0 ? 'Start now, or wait for the rest.' : `Enough to play — @${t.host.handle}, start when you're ready.`;
}

export const secondsLeft = (iso: string, now: number): number => Math.max(0, Math.ceil((Date.parse(iso) - now) / 1000));

/** `/invite a, @b c` → ['a', 'b', 'c']; null when the text isn't an /invite command. */
export function parseInviteCommand(text: string): string[] | null {
  const m = /^\/invite(?:\s+(.*))?$/i.exec(text.trim());
  if (!m) return null;
  return (m[1] ?? '')
    .split(/[\s,]+/)
    .map((w) => w.replace(/^@/, ''))
    .filter(Boolean);
}

/** A trailing word that names a game picks it: `/invite bob critical-mass`. */
export function splitGame(words: string[], catalog: GameInfo[]): { handles: string[]; game: GameInfo | null } {
  const last = words.at(-1)?.toLowerCase();
  const game = catalog.find((g) => g.id === last);
  return game && words.length > 1 ? { handles: words.slice(0, -1), game } : { handles: words, game: null };
}

/** The named game, else the game whose channel you're in, else the only game there is. */
export function gameFor(explicit: GameInfo | null, channel: string, catalog: GameInfo[]): GameInfo | null {
  return explicit ?? catalog.find((g) => g.id === channel) ?? (catalog.length === 1 ? catalog[0] : null);
}

export type InviteChoice = { kind: 'invite'; label: string; disabled: string | null } | { kind: 'host'; games: GameInfo[] } | null;

/** What a name's menu offers: invite them to the table you're hosting, or host a game with them. */
export function inviteChoice(
  target: IdentityPublic,
  ctx: { me: IdentityPublic | null; status: Status | null; myTable: TableInfo | null; catalog: GameInfo[] },
): InviteChoice {
  const { me, myTable } = ctx;
  if (!me || target.id === me.id || target.released) return null;
  const hosting = myTable && myTable.status === 'forming' && myTable.host.id === me.id ? myTable : null;
  if (!hosting) return myTable ? null : { kind: 'host', games: ctx.catalog };
  const name = ctx.catalog.find((g) => g.id === hosting.gameId)?.name ?? hosting.gameId;
  const label = `Invite to ${name}`;
  const already = hosting.seated.some((p) => p.id === target.id) || hosting.invites.some((i) => i.to.id === target.id);
  if (already) return { kind: 'invite', label, disabled: 'Already at your table' };
  if (hosting.seated.length + hosting.invites.length >= hosting.size) return { kind: 'invite', label, disabled: 'Your table is full' };
  if (ctx.status !== 'ready') {
    const why = ctx.status === 'afk' ? 'AFK right now' : ctx.status === 'playing' ? 'In a match' : 'Not here';
    return { kind: 'invite', label, disabled: why };
  }
  return { kind: 'invite', label, disabled: null };
}
