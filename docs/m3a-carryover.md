# Carry-over from Milestone 3a ("Engine")

This file records what M3a (the real-time runner, doctrine and Lightline) deferred, the rulings made while building it, and the open questions. Read it before planning M3b. M2c's list is in `docs/m2c-carryover.md`.

**This list was written before the whole-branch review.** That review may fix some of these items; check the branch history before treating any of them as still open.

The build ran subagent-driven: 8 tasks, each implemented and reviewed. The Foreman was away, so the calls below are rulings.

## Deferred to M3b

- Human steering for real-time games. Lightline is `humans: false`, and every door (quickmatch, tables, invites, vs house) answers `MACHINES_ONLY`. M3b designs how a person steers, and lifts the flag.
- The Foreman's group-DM idea, as a pointer for M3b planning: grow DMs with "add someone to this DM" for private pre-game talk, not a separate group chat. A DM channel is pair-shaped today (`dm:<idA>:<idB>`, sorted, exactly two), so this means a new channel shape, not a tweak.

## Rulings made while building

- The Task 3 `/invite` command broke when the catalog grew to two games (`tables.e2e.ts:28`). It was fixed in Task 3, not Task 7, by filtering the catalog to `humans: true` in `runInviteCommand`, which keeps verify green per commit.
- The Task 5 timer leak was fixed in the core: `GameManager.close()` clears every match timer, and `core.close()` calls it before `database.close()`. It also fixes real shutdown and every later real-time test.
- `FiredRule` is declared in protocol.ts only; `realtime.ts` imports it rather than keeping a copy.
- T6 tests build random tags with `String(Math.floor(Math.random()*1e9))` where the bots have no helper.
- Task 1's first two commits (2f35c46, 4f1f81b) lack a blank line before Co-Authored-By, so it isn't a real trailer. Later tasks were fixed by the contract.
- **One permission denial happened, in Task 6.** The Foreman approved committing as it was.

## Deferred findings

### Worth doing soon

- **Anonymous watchers see a frozen frame.** An anonymous visitor behind the name gate sees only the first frame of a table, because live pushes go only to signed-in sockets. This was already true for Critical Mass, but it is glaring for a real-time board. The e2e watches as a guest.
- **A failing tick retries at 10 Hz forever** (Task 3); there is no abandon after N failures.
- **`envelope()` calls `rt.senses` unguarded** (Task 3): a senses bug would make seated GETs return 500.
- **Bot doctrine sends** (Task 6): a 5xx or network error in `playRealtime` escapes `playMatch`, a re-greet risk the turn loop guards against. A refused 4xx marks `sent` anyway, so the bot rides the default for that phase.
- **After `close()`, timer-setting entry points aren't guarded** (Task 5: `createMatch`, `startTurn` via move, `finish`, `wait`). Only reachable if requests race shutdown.

### Minor

- Task 1 (doctrine validation):
  - Unknown keys inside conditions (all/any/not/leaf) are dropped, not refused, and `{all, any}` together ignores `any`.
  - The label regex catches only C0 controls (DEL, U+2028/9 and bidi overrides pass).
  - Untested paths: a control-char label, a non-string label, `value: null`, an array value.
  - `{...a} as Action` is an unchecked cast (validated above it).
- Task 2 (Lightline):
  - The doctrine JSON blocks in `rules.md` aren't validated by a test.
  - Coverage gaps: three-seat setup, boost crash on sub-step 2, `view()` output, resign during intermission, a three-player mid-round resign into a fresh round.
- Task 3 (runner):
  - In `games.ts` `tick`, `desk.endTick()` runs before `roundEvent` and deliveries; if they throw, `desk.tick` runs one ahead of the installed state.
  - `clampFloor` warns "outside range" for an in-range fractional value.
  - The "test speed options" test asserts only the getter, not that the floor stays 3 ticks at `realtimeTickMs` 10.
  - The tick's `.catch` log text "could not record its end" also covers sync throws in `advance`.
- Task 4 (doctrine route and doors):
  - A host with `invite: [human]` on a machines-only game spends a `hostLimiter` token and emits transient table events before the invite throws (then rolls back).
  - The doctrine route buffers the whole body before the size check (no content-length precheck; Bun's cap bounds it).
  - No direct test for the accept door (only the createMatch test and the code check).
- Task 5 (exhibitions):
  - The console exhibition test takes the first two free house bots from presence order, not necessarily the two it registered.
  - `console.ts` reads the game from `b.handle`, a wart from the shared input shape; it needs a comment.
  - Pre-existing: `invites.test` "going afk leaves the queue" can flake when a random handle trips the profanity filter (`HANDLE_FILTERED`).
- Task 6: no test drives the shrinking flip and re-send.
- Task 7 (board):
  - The Resign button shows for a Lightline seat holder (`iAmOut` is always false for Lightline); harmless while machines only.
  - The new `tables.test` test sits above the describe's setup consts, and `.stage.ll` CSS is ordered before `.stage`.
  - The e2e doesn't assert that Sprocket is free after the resign.

## Found in the live check (Task 8)

Against a throwaway server (port 3200, in-memory database) with the real bots:

- `bun run admin exhibition lightline` printed `Exhibition: @OLD_IRON vs @Sprocket — Lightline. Watch at /t/…`. The board ran at 10 ticks a second. Round 1 ended at about 40 s (Sprocket crashed, "crashed" shown on its row), round 2 started at once, and "OLD_IRON wins." appeared at 2-0. At 400 px the board and the rider rows fit without horizontal scroll.
- A typo'd doctrine (`"sense":"ahed"`) from a fresh agent seated in a vs-house match returned 400 `BAD_DOCTRINE`: `rules[0].when.sense: unknown sense "ahed"; did you mean "ahead"?`
- The table page's browser title reads "Critical Mass" for a Lightline table.
- The intermission between rounds is short enough that a poll every few seconds never caught it; not confirmed visually.
- While the exhibition held both house bots, `POST /api/vs-house` answered `HOUSE_FULL`, as expected.
- After SIGTERM the throwaway server process stayed alive for several seconds and needed SIGKILL. It is unknown whether this is the PGlite memory database closing slowly or a hang in shutdown; worth a look, since `close()` was meant to make shutdown clean.
