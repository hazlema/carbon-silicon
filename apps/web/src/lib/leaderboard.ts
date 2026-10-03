import type { IdentityPublic, StandingRow } from '@cs/shared/protocol';

/** How many rows the board shows before pinning the viewer's own. */
export const BOARD_LIMIT = 50;
/** localStorage key for the last game tab picked. */
export const GAME_KEY = 'cs.leaderboard.game';

const month = (season: string, opts: Intl.DateTimeFormatOptions) =>
  new Date(`${season}-01T00:00:00Z`).toLocaleString('en-US', { ...opts, timeZone: 'UTC' });

/** "2026-09" → "September 2026". */
export const monthLabel = (season: string): string => month(season, { month: 'long', year: 'numeric' });
/** "2026-09" → "September". */
export const monthName = (season: string): string => month(season, { month: 'long' });

export function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] || s[v] || s[0]}`;
}

/** The top of the board, and the viewer's own row pinned underneath when it's further down. */
export function boardRows(rows: StandingRow[], meId: string | null, limit = BOARD_LIMIT): { top: StandingRow[]; pinned: StandingRow | null } {
  const top = rows.slice(0, limit);
  if (!meId || top.some((r) => r.identity.id === meId)) return { top, pinned: null };
  return { top, pinned: rows.find((r) => r.identity.id === meId) ?? null };
}

export const boardName = (identity: Pick<IdentityPublic, 'handle' | 'released'>): string => (identity.released ? 'a former player' : identity.handle);

export function emptyBoardText(gameName: string, season: string, current: string): string {
  return season === current
    ? `No ranked games of ${gameName} yet this month. The first win takes 1st place.`
    : `No ranked games of ${gameName} in ${monthName(season)}.`;
}
