import type { GameInfo } from '@cs/shared/protocol';

/** Where this browser remembers the last game its player picked. */
export const PICK_KEY = 'cs.play.game';

/** The games a person can play from the site (machines-only games are watch-only for now). */
export function playable(games: GameInfo[]): GameInfo[] {
  return games.filter((g) => g.humans);
}

/** Random match: any game a person can play, or null when there is none. */
export function randomGame(games: GameInfo[], rng: () => number = Math.random): GameInfo | null {
  const choices = playable(games);
  return choices[Math.floor(rng() * choices.length)] ?? null;
}

/** The remembered pick, as long as that game is still here and still playable. */
export function remembered(games: GameInfo[], id: string | null): GameInfo | null {
  return playable(games).find((g) => g.id === id) ?? null;
}

export function loadPick(): string | null {
  try {
    return localStorage.getItem(PICK_KEY);
  } catch {
    return null;
  }
}

export function savePick(id: string | null): void {
  try {
    if (id) localStorage.setItem(PICK_KEY, id);
    else localStorage.removeItem(PICK_KEY);
  } catch {
    // Private mode or storage off: the pick lasts only as long as the page.
  }
}
