# Carry-over from Milestone 3b ("Controls")

This file records the rulings made while building M3b, what its reviews deferred, the flaky tests seen, and what to watch. Read it before planning M3c. M3a's list is in `docs/m3a-carryover.md`.

M3b did three things. It fixed the M3a findings that were worth doing soon: guests see a live board, a failing tick is abandoned after 20 tries, `envelope()` guards its senses, bot doctrine sends survive a 5xx, and the timer-setting entry points refuse after close (`createMatch` answers `503 SHUTTING_DOWN`). It let humans steer Lightline with keys or swipes over the site's WebSocket, and a human seat refuses doctrine (`409 HUMAN_STEERS`). And it opened Lightline to humans, so `humans` is true and `MACHINES_ONLY` stays for any future machines-only game.

The build ran subagent-driven: 8 tasks, each implemented and reviewed. The live check (a whole match at 1400 px with keys, a swipe round at 400 px, a guest watching from a private window) happens after the merge. Its notes are added here once it has run.

## Rulings made while building

- **R-1.** A refused doctrine (4xx) stays sent. A bot retries only on a 5xx or a network error. A doctrine the server called bad will be bad again.
- **R-2.** Steer keys are game-declared `SteerRules` (`moves`, `modifiers`, `action`), not Lightline code in the server. Lightline's keys are `n e s w` and `boost`. `GameManager` refuses at construction a module with `realtime` and `humans: true` but no `realtime.steer`, so "a human seat never runs doctrine" holds for any future game.
- **R-3.** The `botline` fixture (a machines-only real-time game) keeps the `MACHINES_ONLY` tests alive now that Lightline is open.
- **R-4.** Guests follow a table by short-poll, not by long-poll and not by a socket. The anonymous long-poll is refused on purpose (401), so the server never parks an anonymous connection, and the rule is pinned in `app.test`. A guest reads the plain `GET /api/matches/:id` every 200 ms (5 reads a second, not 10), skips unchanged revisions, and backs off on errors. If this feels slow, the board updates at 5 frames a second for a guest.
- **R-5.** The tick-side `if (paused) q.clear()` stays, with its test, though the test isn't sensitive to it for Lightline (the queue drains during the 50-tick intermission). The clear states the intent and protects a game with a shorter pause.
- **R-6.** `/invite` asks "Which game?" and Random match can land on Lightline for humans. Both follow from having two human-playable games. The e2e now names its game. The Foreman may want a chooser step removed in M3c.
- **R-7.** Implementers ran `bun run verify` in the foreground and left nothing running, after two haiku runs backgrounded it and left orphans.
- **R-8.** The diary entry and the live check aren't part of Task 8. The Proprietor writes the diary after playing the live match, so it can say how steering felt.

## Deferred findings

### Minor

- Task 1 (runner):
  - The collapsed one-line test modules in `games-realtime.test.ts` are cosmetic (the plan asked for them).
  - No direct test of `startTurn`'s closed guard; it's covered through resign.
  - `abandon` has no re-entry guard. It's unreachable, because `tick` returns right after.
- Task 2 (bot):
  - The new imports in `apps/bots/src/lightline.test.ts:82-84` sit mid-file.
  - The `playRealtime` docblock dropped the M3a R-P5 floor rationale.
  - The 4xx test doesn't show that a later shrinking flip still sends.
- Task 3 (guest board):
  - Stale "long-poll" wording in `+page.svelte:161` and a comment in `lightline.e2e.ts`; both now mean short-poll.
  - An extra first read when the initial envelope is already over or abandoned.
  - If `live.me` is still null when the first GET resolves (a session restore), a signed-in user also polls. The accept step drops stale revisions, so it's only wasteful.
  - A permanent error (404) keeps polling every 10 s until unmount, and no test covers the abandoned stop.
- Task 5 (steering):
  - No manager-level boost test (`SteerQueue` units cover it).
  - No RED run was captured, since tests and code were written together.
- Task 6 (doors):
  - The Random match check in `e2e/play.e2e.ts:491` was weakened to "a table region rendered" (it was: status past "Starting…").
  - The lightline e2e sit test depends on seated open tables leaving the lobby list.
  - Test (c)'s probe setup is never resigned (harmless on the fake clock).
- Task 7 (board):
  - Multi-touch: a single `down` slot, no `pointerId` or `isPrimary` tracking, no `pointercancel` (`Board.svelte:31-40`).
  - The key-listener effect re-subscribes every frame; it should depend on the match id.
  - `pressedTimer` isn't cleared on unmount.
  - The status detail still says "You steer…" after resigning in a 3-4 seat match.
  - The indicator's width jumps on a press (row reflow).
  - The countdown-hint e2e is timing-bound (a 1 s window).

### Flaky tests seen

- `HANDLE_FILTERED`: a random test handle trips the profanity filter. Seen in `owners.test`, `games.test`'s `setup` (twice) and `reports.test`. It passes on rerun. A fix is a tag helper that avoids the filter.
- `e2e/dms.e2e.ts:43`, "closing a tab": an `enter()` gate timeout. It passed on rerun.
- One unnamed flaky unit failure in a single verify during Task 6, not reproduced.

## Balance watch

Machines likely have the edge on reflexes: a doctrine reacts every tick, and a person has a key press and a network trip in the way. The live check will note the first results, both how steering feels (latency, and whether 10 Hz is playable) and who won. Tuning, for example a slower tick for mixed tables, is deferred until there is evidence. Don't tune from a guess.
