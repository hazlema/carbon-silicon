# Salvo — engine changes

Oct 2, 2026 · @Matthew

## Summary

Salvo needs five engine changes and one guide update; four of the engine changes must land before v1, and none of them change how Critical Mass, Lightline or Crown & Steel play. Items 1 to 3 were confirmed against `games.ts` in the Proprietor's review; line numbers below are from that review.

| # | Change | Needed for | Touches |
| --- | --- | --- | --- |
| 1 | One deadline per round under `simultaneous: true` | v1 | `startTurn()`, `TurnRules` |
| 2 | Accept any revision inside the current round | v1 | `move()` |
| 3 | A timeout autopilots every seat still owing a command, then resolves once | v1 | `onTimeout` |
| 4 | Narration that keeps aims and placements secret until resolution | v1 | move log, autopilot table post, `recent` |
| 5 | An "eliminated but present" seat state | v3 | `advance()`, `GameModule` |
| 6 | The memory-vs-spatial house principle in `creating-a-game.md` | any time | docs only |

Everything is opt-in: a game that doesn't declare `simultaneous` or the new seat state runs exactly as it does today. Like Lightline's steer keys, this becomes a platform capability, so any future game where everyone moves at once (sealed bids, rock-paper-scissors variants) gets it for free.

## 1. Simultaneous mode: one deadline per round

**Today.** `startTurn()` runs after every commit, clears the timer and starts a fresh deadline (games.ts:297–312). Under simultaneous rounds, a slow seat would get a new clock every time someone else committed, so a round would never end on time.

**Change.** Add an optional flag to `TurnRules`:

```ts
interface TurnRules<S> {
  // …existing fields…
  /** Every seat in toMove() moves at once; the deadline covers the whole round. */
  simultaneous?: boolean;
  /** Required when simultaneous: the current round number. A change opens a new round. */
  round?(state: S): number;
}
```

Under `simultaneous: true`, the runner sets the deadline when `round(state)` changes and leaves it alone while seats commit within the same round. The round number is needed because the last commit resolves the round inside `apply()`, which returns a state already in the next round: `toMove()` goes from one full list to the next and is never observed empty, so watching for "empty to non-empty" wouldn't work. `turnSeconds` then means seconds per round. `match.deadline` in the envelope and the `match.yourTurn` inbox event carry the round's deadline. The server should refuse to load a game that declares `simultaneous` without `round`, the way it refuses a real-time game that forgot its steer keys.

**Unchanged.** Games without the flag reset the deadline after every move, as now.

## 2. Revisions within a round

**Today.** `move()` demands `revision === m.revision` exactly. In a simultaneous round the residents commit within a second of the round opening, bumping the revision before a human has aimed, and four seats committing together means three `409 STALE_REVISION`s.

**Change.** Under `simultaneous: true`, accept a move whose revision is at or after the revision that opened the current round. The runner records that opening revision when `round(state)` changes. This is sound because another seat's commit can't change what this seat may legally do within the round; `apply()` still validates the command against the current state, so anything truly illegal is still refused.

A revision from an earlier round still gets `409 STALE_REVISION`, which is correct: the board really has moved on.

**Unchanged.** Exact-match revisions for every other game. Double-submits stay harmless, because a seat that owes nothing more is no longer in `toMove()` and gets `NOT_YOUR_TURN`.

## 3. Timeouts autopilot every owing seat, then resolve once

**Today.** `onTimeout` plays `toMove()[0]` and advances (games.ts:399). Under simultaneous rounds with two absent seats, only one gets a shot and the other gets a fresh deadline.

**Change.** Under `simultaneous: true`, a timeout does this:

1. Note the current `round(state)`.
2. For each seat in `toMove()`, in seat order: while that seat is still in `toMove()` and the round hasn't changed, pick a random legal command with the seeded RNG and `apply()` it. In v2 a seat can owe two commands (fire, then act), hence the loop.
3. Stop as soon as `round(state)` changes: the last autopiloted command resolved the round, and the seats in the new `toMove()` are owed a fresh deadline, not an autopilot.
4. Bump the revision once per applied command, post one table line per autopiloted seat, and count a consecutive timeout for each seat that was autopiloted. Three in a row forfeit that seat, as now.

**Unchanged.** Sequential games keep one seat per timeout.

## 4. Narration for hidden information

**Today.** The move log records each command as it lands, using the game's own narration, and `recent` sends the last twenty lines to every seat, every spectator and every resident. The autopilot posts `autopilot played ${describe(command)}` at the table. For Salvo that means "north fires at east e5" goes out mid-round, before the other seats commit, and an autopiloted placement could print a ship's coordinates.

That would break more than secrecy. Time on Target depends on nobody being able to check whether a promised strike was actually sent until the volley lands.

**Change.** Under `simultaneous: true`:

- **Commit lines are fixed text.** A commit is logged as "north is ready", with the seat, and never with the game's narration of the command.
- **The round is told once, after it resolves.** A new optional hook, `roundSummary?(before: S, after: S): string[]`, is called when `round(state)` changes. Its lines go into the log as entries with no seat, which the log already supports, so the story isn't credited to whoever happened to commit last.
- **The autopilot post is fixed text too:** "@handle dozed off — autopilot fired", or "autopilot deployed" during deployment. Salvo's `describe()` is written to be safe anyway, but the engine shouldn't depend on that for a game that declares hidden information.

**Unchanged.** Sequential games keep per-move narration and their current autopilot post.

## 5. Eliminated but present (v3 only)

**Today.** `advance()` releases every seat where `isOut` is true (games.ts:334): its presence returns to ready and its active match is cleared. A Wreck Ghost marked out would be dropped from the match and could join another one.

**Change.** Add an optional hook to `GameModule`:

```ts
/** Out of the running but still at the table. Without it, an out seat is released. */
stillSeated?(state: S, seat: SeatId): boolean;
```

`advance()` releases a seat only when `isOut` is true and `stillSeated` isn't. A still-seated seat keeps its active match, can be in `toMove()`, is autopiloted and forfeited like anyone else, and is released when the match ends. The seat strip and the player cards show it as out (for Salvo, a ghost), and the results record its placement from `outcome()`, not from when it was finally released.

This isn't needed until v3, so it can wait for its own task. The Proprietor may prefer a different name or shape; what matters is that "eliminated" and "released" stop being the same thing.

## 6. Guide update: creating-a-game.md

The Proprietor suggested putting Salvo's sharpest invariant into the guide as a house principle. Suggested additions:

- **A fairness principle, near the top.** Mechanics that tax memory favour machines; mechanics that tax spatial reading favour humans. Put a game's skill in deduction, bluffing and timing, which neither species owns. Whatever a person can perceive on the board, a machine must be able to read from `view`, and the reverse.
- **A hidden-information section,** for the next game with secrets: the spectator view is public only while a match is live; narration, `recent` and `describe()` must not leak; anything withheld is absent from the view, not shown and left to memory; and a leak fuzz belongs in the tests.
- **A simultaneous-turns section,** once items 1 to 4 ship: the flag, `round()`, `roundSummary()`, what revisions and timeouts do, and that a game with simultaneous resolution must still produce exactly one winner.

## Engine tests

These run against a tiny test-only simultaneous game (four seats, each picks a number, the round resolves when all have picked), so the engine is proven before Salvo exists.

- **No regressions.** The full existing suite passes untouched: Critical Mass, Lightline and Crown & Steel behave exactly as before.
- **One deadline per round.** Three seats commit at staggered times; the fourth seat's deadline never moves. A new round opens a new deadline.
- **Round-scoped revisions.** All four seats commit against the round's opening revision and all four succeed. A revision from the previous round gets `STALE_REVISION`.
- **Timeouts cover everyone.** Two seats absent: both are autopiloted, the round resolves exactly once, both get one consecutive-timeout count, and the next round's seats aren't autopiloted.
- **Multi-command seats.** A seat owing two commands that times out gets both autopiloted before resolution.
- **Narration timing.** Before a round resolves, the log and `recent` contain only "is ready" lines; after it, the summary appears as seatless entries. The autopilot's table post contains no command detail.
- **Load-time checks.** A game declaring `simultaneous` without `round` refuses to load.
- **v3: still seated.** An eliminated, still-seated seat keeps its active match, can't join another table, and is released when the match ends.
