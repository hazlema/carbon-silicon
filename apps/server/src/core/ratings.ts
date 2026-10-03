/** Elo and standings for one season of one game, replayed from its rated matches (M4). No I/O. */

export const START_ELO = 1000;
export const K_NEW = 32;
export const K_SETTLED = 16;
/** A player's first this-many rated games of the season use K_NEW. */
export const K_NEW_GAMES = 10;
export const WIN_POINTS = 3;
export const DRAW_POINTS = 1;

export interface RatedMatch {
  id: string;
  outcome: { winners: string[]; placement: string[][] };
  seats: { seat: string; playerId: string }[];
}

export interface SeasonLine {
  playerId: string;
  points: number;
  wins: number;
  draws: number;
  losses: number;
  games: number;
  elo: number;
}

/** Sole first place wins; shared first place or no winners at all is a draw; everyone else loses. */
export function resultOf(outcome: RatedMatch['outcome'], seat: string): 'win' | 'draw' | 'loss' {
  if (outcome.winners.length === 0) return 'draw';
  if (!outcome.winners.includes(seat)) return 'loss';
  return outcome.winners.length === 1 ? 'win' : 'draw';
}

/** A seat's placement group (0 is best); a seat missing from the placement counts as last. */
function placeOf(placement: string[][], seat: string): number {
  const i = placement.findIndex((g) => g.includes(seat));
  return i === -1 ? placement.length : i;
}

/** Replays `list` in order. Every pair is compared by placement; changes come from pre-match ratings. */
export function rateSeason(list: RatedMatch[]): SeasonLine[] {
  const lines = new Map<string, SeasonLine>();
  const lineOf = (playerId: string): SeasonLine => {
    let l = lines.get(playerId);
    if (!l) {
      l = { playerId, points: 0, wins: 0, draws: 0, losses: 0, games: 0, elo: START_ELO };
      lines.set(playerId, l);
    }
    return l;
  };
  for (const m of list) {
    if (m.seats.length < 2) continue;
    const players = m.seats.map((s) => ({ seat: s.seat, line: lineOf(s.playerId), place: placeOf(m.outcome.placement, s.seat) }));
    const before = players.map((p) => p.line.elo);
    const k = players.map((p) => (p.line.games < K_NEW_GAMES ? K_NEW : K_SETTLED) / (players.length - 1));
    const delta = players.map(() => 0);
    for (let i = 0; i < players.length; i++) {
      for (let j = i + 1; j < players.length; j++) {
        const expected = 1 / (1 + 10 ** ((before[j] - before[i]) / 400));
        const actual = players[i].place < players[j].place ? 1 : players[i].place > players[j].place ? 0 : 0.5;
        delta[i] += k[i] * (actual - expected);
        delta[j] += k[j] * (expected - actual);
      }
    }
    players.forEach((p, i) => {
      p.line.elo = before[i] + delta[i];
      p.line.games += 1;
      const result = resultOf(m.outcome, p.seat);
      if (result === 'win') {
        p.line.wins += 1;
        p.line.points += WIN_POINTS;
      } else if (result === 'draw') {
        p.line.draws += 1;
        p.line.points += DRAW_POINTS;
      } else {
        p.line.losses += 1;
      }
    });
  }
  return [...lines.values()];
}

/** Standings order: points, wins, Elo, then handle (case-insensitive), so every rank is unique. */
export function rankLines<T extends SeasonLine>(lines: T[], handleOf: (playerId: string) => string): (T & { rank: number })[] {
  return [...lines]
    .sort(
      (a, b) =>
        b.points - a.points ||
        b.wins - a.wins ||
        b.elo - a.elo ||
        handleOf(a.playerId).toLowerCase().localeCompare(handleOf(b.playerId).toLowerCase()),
    )
    .map((l, i) => ({ ...l, rank: i + 1 }));
}
