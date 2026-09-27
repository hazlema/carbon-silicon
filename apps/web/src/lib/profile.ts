import type { IdentityPublic, ProfileMatch, ProfileRecord, ProfileRival } from '@cs/shared/protocol';

/** A released identity keeps its matches but loses its name. */
export function displayName(identity: Pick<IdentityPublic, 'handle' | 'released'>): string {
  return identity.released ? 'a former player' : identity.handle;
}

export function gameName(gameId: string): string {
  return gameId
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

export function resultChip(result: ProfileMatch['result']): { label: string; tone: 'win' | 'loss' | 'draw' | 'void' } {
  switch (result) {
    case 'win':
      return { label: 'Win', tone: 'win' };
    case 'loss':
      return { label: 'Loss', tone: 'loss' };
    case 'draw':
      return { label: 'Draw', tone: 'draw' };
    case 'abandoned':
      return { label: 'Abandoned', tone: 'void' };
    default:
      return { label: 'No result', tone: 'void' };
  }
}

/** In Critical Mass the loser always ends at 0 orbs, so a score is never shown — just how the match ended. */
export function matchEndingText(endReason: string | null): string {
  switch (endReason) {
    case null:
      return '';
    case 'last-standing':
      return 'wiped out';
    case 'resign':
      return 'resigned';
    case 'timeout':
      return 'timed out';
    case 'overload':
      return 'board went critical';
    default:
      return endReason.replaceAll('-', ' ');
  }
}

/** "Critical Mass · 4 played" for the most-played game, or a plain "hasn't played" line. */
export function recordSummaryLine(record: ProfileRecord): string {
  if (record.played === 0) return `No games vs ${record.versus} yet`;
  const top = record.games[0];
  return `${gameName(top.gameId)} · ${top.played} played`;
}

/** The share (0–100) of played matches that were wins, for the record card's bar. */
export function recordWinSharePercent(record: ProfileRecord): number {
  if (record.played === 0) return 0;
  return (record.wins / record.played) * 100;
}

/** "You're up 3–1.", "Ada is up 3–1." on someone else's profile, "OLD_IRON is up 4–0." when the rival leads,
 *  or "All square at 2–2." when tied. */
export function rivalrySentence(rival: ProfileRival, opts: { mine: boolean; ownerHandle: string }): string {
  const { wins, losses } = rival;
  if (wins === losses) return `All square at ${wins}–${losses}.`;
  if (wins > losses) {
    const who = opts.mine ? "You're" : `${opts.ownerHandle} is`;
    return `${who} up ${wins}–${losses}.`;
  }
  return `${displayName(rival.opponent)} is up ${losses}–${wins}.`;
}
