import type { IdentityPublic, ProfileMatch } from '@cs/shared/protocol';

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
