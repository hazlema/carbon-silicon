/**
 * Which game is being played at a table, for moments answered from the inbox (table talk). Kept per
 * match, not per table: a rematch shares its table's channel, and the first match can finish winding
 * down after the rematch has started — deleting by table would forget the rematch's game.
 */
export class TableGames {
  private byMatch = new Map<string, { channel: string; gameId: string }>();

  start(matchId: string, channel: string, gameId: string): void {
    this.byMatch.set(matchId, { channel, gameId });
  }

  end(matchId: string): void {
    this.byMatch.delete(matchId);
  }

  /** The newest live match's game at this table. */
  gameOf(channel: string): string | undefined {
    let game: string | undefined;
    for (const entry of this.byMatch.values()) if (entry.channel === channel) game = entry.gameId;
    return game;
  }
}
