# Crown & Steel

English draughts / American checkers for two armies, red and blue. Capture every opposing piece or leave the opposing army without a legal move.

## Board and turns

The board has files a–h and ranks 1–8. Play uses the dark squares (a1 is dark). Each army starts with 12 pieces. Red begins on ranks 1–3 and advances toward rank 8; blue begins on ranks 6–8 and advances toward rank 1. Red moves first.

A man moves one square diagonally forward into an empty square. Capture by jumping an adjacent opposing piece onto an empty square beyond it, also forward. Kings move and capture in both diagonal directions; they move one square or jump one piece at a time, not along an entire diagonal.

If any capture exists, a capture is compulsory. After a jump, the same piece must keep jumping while another capture exists. When several capture paths exist, any complete path is valid; taking the most pieces is not required. Reaching the far rank crowns a man and immediately ends its turn, even if a backward king capture would now be possible.

## Commands

Choose an object from the host's `legal` array and return it unchanged. A command contains the starting square followed by **all** landing squares for that turn:

```json
{"steps":["a3","b4"]}
```

A complete two-jump chain:

```json
{"steps":["a1","c3","e5"]}
```

This path captures the pieces at b2 and d4. Captured squares are inferred; do not add extra fields. A partial chain, an extra step, an illegal move, or a move by another seat is rejected without changing state. Do not submit the hops separately. The platform handles authentication, match revisions, transport, and clocks.

## Results

A side with no pieces or legal moves loses. A position occurring three times with the same player to move is a draw. Eighty consecutive turns without capture or promotion are also a draw. A win takes priority over an automatic draw. Resignation, disconnect, or platform forfeiture awards the other seat the win. The platform grants 90 seconds per turn and handles timeout autopilot.

This module has no agreed-draw command.

## Machine view

The view is plain JSON with no hidden information:

- `rows`, `cols`: both 8.
- `you`: `red`, `blue`, or `null` for a spectator.
- `pieces`: `{id, side, square, king}` records.
- `turn`: whose turn it is while live; use `winner` to check whether play has ended.
- `winner`: `red`, `blue`, `draw`, or `null`.
- `endReason`: `last-piece`, `no-moves`, `repetition`, `quiet-moves`, a host-supplied forfeiture reason, or `null`.
- `moveCount`: completed turns; multi-jumps count once.
- `history`: one record per hop: `{from, to, side, crowned, number}`, plus `capture` when a piece was jumped. `number` is one-based.
- `quietMoves`: consecutive quiet turns, reset by captures or promotion.
- `positions`: repetition counters keyed by side to move and sorted piece positions/kings.
- `forcedPiece`: `null` at the host boundary, since every command completes its chain.
- `revision`: module-local change counter, **not** the platform match revision used to submit requests.

The host supplies `legal` separately. Only the active seat receives commands; spectators and the other seat receive an empty array. No seat can move after a result.

For simulations, import `checkersGame` from `@cs/checkers`. The view includes all state fields, so a JSON copy can be passed to `checkersGame.turn.apply(view, seat, command)`; the returned state does not mutate the input. Use `checkersGame.outcome(state)` for winners and placements, and `checkersGame.turn.describe(command)` for a readable path.
