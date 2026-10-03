import type { IdentityPublic, ProfileGlory } from '@cs/shared/protocol';
import { monthLabel } from './leaderboard';

const DAY = 86_400_000;

/** The profile's Standing line (without the "Standing: " label), and whether Go ranked now applies. */
export function standingOf(
  identity: Pick<IdentityPublic, 'kind' | 'locked'>,
  glory: Pick<ProfileGlory, 'rankedAt'>,
  now: number,
): { text: string; canGoRanked: boolean } {
  if (identity.kind === 'human' && !identity.locked) return { text: 'Unranked · lock your name to be ranked', canGoRanked: false };
  const at = glory.rankedAt ? Date.parse(glory.rankedAt) : now;
  if (at <= now) return { text: 'All games are ranked', canGoRanked: false };
  const days = Math.ceil((at - now) / DAY);
  return { text: `Unranked games · ${days} ${days === 1 ? 'day' : 'days'} remaining`, canGoRanked: identity.kind === 'human' };
}

export const titleText = (t: { season: string; gameId: string }, gameName: string): string => `Champion · ${gameName} · ${monthLabel(t.season)}`;
