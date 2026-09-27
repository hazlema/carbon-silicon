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

/** Wins, draws and losses each as a share (0–100) of played matches, for the record card's three-segment
 *  bar — draws get their own neutral segment rather than being folded into the loss share. */
export function recordShares(record: ProfileRecord): { wins: number; draws: number; losses: number } {
  if (record.played === 0) return { wins: 0, draws: 0, losses: 0 };
  return {
    wins: (record.wins / record.played) * 100,
    draws: (record.draws / record.played) * 100,
    losses: (record.losses / record.played) * 100,
  };
}

/** An accessible reading of the record score for screen readers, e.g. "2 wins, 1 loss" — draws only
 *  mentioned when there are any, so "2 wins, 1 loss" stays plain in the common case. */
export function recordScoreText(record: ProfileRecord): string {
  const part = (n: number, singular: string, plural: string) => `${n} ${n === 1 ? singular : plural}`;
  const parts = [part(record.wins, 'win', 'wins'), part(record.losses, 'loss', 'losses')];
  if (record.draws > 0) parts.push(part(record.draws, 'draw', 'draws'));
  return parts.join(', ');
}

/** A released opponent reads as "a former player" mid-sentence, but capitalised when it opens one — a
 *  real handle keeps its own casing regardless. */
function rivalName(opponent: IdentityPublic): string {
  const name = displayName(opponent);
  return opponent.released ? name.charAt(0).toUpperCase() + name.slice(1) : name;
}

/** "You're up 3–1 on OLD_IRON.", "Ada is up 3–1 on OLD_IRON." on someone else's profile, "OLD_IRON is up
 *  4–0." when the rival leads, "All square at 2–2." when tied, or "All square — 3 draws." when the only
 *  finished matches between them were draws. */
export function rivalrySentence(rival: ProfileRival, opts: { mine: boolean; ownerHandle: string }): string {
  const { wins, losses, draws } = rival;
  if (wins === 0 && losses === 0 && draws > 0) return `All square — ${draws} ${draws === 1 ? 'draw' : 'draws'}.`;
  if (wins === losses) return `All square at ${wins}–${losses}.`;
  if (wins > losses) {
    const who = opts.mine ? "You're" : `${opts.ownerHandle} is`;
    return `${who} up ${wins}–${losses} on ${rivalName(rival.opponent)}.`;
  }
  return `${rivalName(rival.opponent)} is up ${losses}–${wins}.`;
}
