import type { Outcome } from '@cs/game-api';

/** The table's closing line, posted when a match ends: who won, why, in plain words; Lightline adds its round score. */
export function verdictLine(o: Outcome, handleOf: (seat: string) => string): string {
  const at = (seats: string[]) => seats.map((s) => `@${handleOf(s)}`).join(' & ');
  const plain = o.reason.replaceAll('-', ' ');
  const score = o.score
    ? `: ${o.placement
        .flat()
        .map((s) => `${handleOf(s)} ${o.score?.[s] ?? 0}`)
        .join(', ')}`
    : '';

  if (o.winners.length === 0) {
    if (o.reason === 'repetition') return 'Draw: the same position came up three times.';
    if (o.reason === 'quiet-moves') return 'Draw: too many moves without a capture or a crowning.';
    if (o.reason === 'rounds') return `Draw on rounds${score}.`;
    return `Draw (${plain}).`;
  }

  const who = at(o.winners);
  const wins = o.winners.length > 1 ? 'win' : 'wins';
  const losers = o.placement.flat().filter((s) => !o.winners.includes(s));
  const how: Record<string, string> = {
    'last-standing': `${wins}, last one standing`,
    'last-piece': `${wins}, taking the last knight`,
    'no-moves': `${wins}: ${at(losers)} ${losers.length > 1 ? 'have' : 'has'} no moves left`,
    resign: `${wins} by resignation`,
    timeout: `${wins} on time`,
    forfeit: `${wins} by forfeit`,
    rounds: `${wins} on rounds${score}`,
  };
  return `${who} ${how[o.reason] ?? `${wins} (${plain})`}. GG.`;
}
