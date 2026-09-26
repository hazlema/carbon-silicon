# Verification receipts

Rule 13: a feature exists only when it is tested and verified running. Each run below lists what was run, what it printed, and what broke along the way. Newest first.

## Final review fix wave, 2026-09-26

**Tree:** parent `91ce95b` (`git rev-parse --short HEAD` before this task's commit(s)).

Fixes 11 findings from the whole-branch review: a rate limit on `POST /api/session` (guest-identity squatting/spam), human auto-AFK not firing because GET polling counted as activity, a ghost match left behind when `GameManager.createMatch`'s DB inserts throw, a `goLive` status write that could race past a finished match, wrapping `finish()`'s match/match-player updates in one transaction, an outdated `http2` directive in `deploy/nginx.conf`, a missing `HOUSE_WAITS` entry in `docs/API.md`, `ChatPanel` loading only the last 100 messages instead of the spec's 200, unguarded `JSON.parse` of WS frames in `live.svelte.ts`, chat missing after a WS reconnect until the channel changed, and focus not moving to the verdict heading when a match ends.

### Automated

Final run 2026-09-26 23:52:38Z to 23:53:30Z UTC (an earlier run at 23:50:37Z–23:51:30Z passed identically; this one is after moving one `$effect` below its `$derived` dependencies for readability, no behavior change):

```sh
bun run verify 2>&1 | tee /tmp/verify.log
# = bun run typecheck && bun test && bun run build && bun run e2e
```

| Stage | Result |
|---|---|
| `tsc -p tsconfig.json` | clean, no output |
| `svelte-check` (apps/web) | `COMPLETED 369 FILES 0 ERRORS 0 WARNINGS 0 FILES_WITH_PROBLEMS` |
| `bun test` | `121 pass`, `0 fail`, `3708 expect() calls`, `Ran 121 tests across 19 files.` |
| `bun run build` | adapter-static `Wrote site to "build"` |
| `playwright test` | `4 passed (17.2s)` |

Same two `[bus] handler for match.updated failed … error: boom` traces as every prior run (the EventBus test that deliberately throws to prove failure isolation — expected, not a regression).

New/changed tests covering this wave:

- `apps/server/src/http/app.test.ts`: `new human identities are limited to 10 per hour per IP; an existing cookie is unaffected` (10×201 then 429 from one IP, `SLOW_DOWN` body, and the "already have a cookie" branch confirmed to bypass the limiter even once it's exhausted); `human auto-AFK > a GET does not reset the idle timer; a POST does` (FakeClock-driven: idle at 10 min after a GET at the 9-minute mark, still ready after a POST at the 9-minute mark).
- `apps/server/src/core/games.test.ts`: `a DB failure while creating a match leaves no ghost: both players freed, error rethrown` (a seat with no `identities` row makes the `match_players` FK insert fail; asserts both players' `activeMatchOf` clears, presence returns to its prior status, the error still reaches the caller, and a fresh match can be created afterwards).

Both new server-side tests were run RED (against the pre-fix code, via `git stash` of just the implementation file) before the fix, then GREEN after, per TDD.

Findings 4–5 (the `goLive` guard clause and the `finish()` transaction) and 6–11 (nginx, docs/API.md, ChatPanel limit, WS frame guard, reconnect chat catch-up, verdict focus) are covered indirectly by the existing suite (`games.test.ts`'s existing match-lifecycle tests still pass unchanged) plus the full typecheck/build/e2e pass above; they did not call for new dedicated tests per the findings list.

### By hand

Not repeated for this pass — the live site on port 3000 was left running throughout per instruction and not touched; the fixes were verified through the automated suite above (including the Playwright e2e suite against a separate instance on port 3100).

## M1 "Doors open", 2026-09-26

**Tree:** `def04ec` (`git rev-parse --short HEAD`) plus this task's uncommitted changes. Those changes (the e2e suite, the two fixes below, this file) went into the commit that adds this file, so the hash above is its parent.

### Automated

Final run, 2026-09-26 23:28:12Z to 23:29:04Z UTC:

```sh
bunx playwright install chromium   # Playwright 1.63.0, chromium-1243
bun run verify 2>&1 | tee .data/verify.log
# = bun run typecheck && bun test && bun run build && bun run e2e
```

| Stage | Result |
|---|---|
| `tsc -p tsconfig.json` | clean, no output |
| `svelte-check` (apps/web) | `COMPLETED 369 FILES 0 ERRORS 0 WARNINGS 0 FILES_WITH_PROBLEMS` |
| `bun test` | `118 pass`, `0 fail`, `3693 expect() calls`, `Ran 118 tests across 19 files.` |
| `bun run build` | adapter-static `Wrote site to "build"` |
| `playwright test` | `4 passed (17.8s)` |

The `bun test` output also prints two `[bus] handler for match.updated failed … error: boom` stack traces. Those come from the EventBus test that deliberately throws inside a subscriber to prove failures are isolated. They are expected.

The four Playwright tests (`e2e/*.e2e.ts`, run against `e2e/serve.ts`: in-memory PGlite, 500 ms countdown, 3 s house fallback, Sprocket in-process):

1. `agent-vs-human.e2e.ts`: an HTTP-only agent and a browser human play each other and talk (6.6s)
2. `lobby.e2e.ts`: a human picks a handle, chats in the lobby, and sees Sprocket here (393ms)
3. `lobby.e2e.ts`: a taken handle explains itself (412ms)
4. `match.e2e.ts`: quick match seats a human against Sprocket and the game plays to a verdict (8.1s)

An earlier run of `bun run verify` (23:20:07Z, before the fixes below) also passed with 117 bun tests and 4 Playwright tests. The 118th test is the regression test for the long-poll fix.

### By hand

`bun run start` (dev database at `.data/pglite`) and `bun run bots`, driven in Chromium through the Playwright MCP tools.

- **Sprocket's stale token.** The saved token in `.data/bots/sprocket.token` no longer matched the dev database. The bot logged `saved token rejected; registering again`, then `registered as @Sprocket`, and recovered without help.
- **Lobby.** I entered as `Frosty`. "Here now 2" listed Frosty (C tile, Fraunces) and Sprocket (Si tile, Plex Mono, "house" badge). "Evening, parlor. Anyone want a game?" appeared in #lobby.
- **A full game.** I clicked "Find a match". Sprocket sat down after 8.0 s (the house-bot fallback) at `/play/m_ee57195f4de64c8b`. It said hello once: "Oh good, a challenger! I've been polishing my orbs all day." I replied "Polish harder, Sprocket." and played to the end. The verdict heading read "You lose." Table talk showed the system line "@Sprocket wins (last standing). GG." and then Sprocket: "GG! I'd say it was close, but my circuits don't lie." Its log said `match m_ee57195f4de64c8b over: last-standing`.
- **Scoreboard.** Back in the lobby it read Humans 0, Machines 1.
- **Pages.** `/diary` showed "Build diary" and the "Doors open" entry, which opens at `/diary/2026-09-26-doors-open`. `/docs` showed "The agent API". `/games` showed the Critical Mass rules.
- **Console.** The only console error was `401` on `/api/me` before a handle is chosen. That is the expected "who am I?" probe.
- **curl.**
  - `curl -s http://127.0.0.1:3000/llms.txt | head -3` printed `# Carbon & Silicon — quick start for AI agents`, a blank line, then `A game parlor where humans and AI agents chat, trash-talk and play. You can do everything over plain HTTP with JSON bodies.`
  - `curl -s http://127.0.0.1:3000/api | jq '.games[0].id'` printed `"critical-mass"`.
- **Screenshots**, taken at 1440×900 and 400×860:
  - `docs/screenshots/lobby-desktop.png`
  - `docs/screenshots/lobby-mobile.png`
  - `docs/screenshots/table-desktop.png`
  - `docs/screenshots/table-mobile.png` (both table shots were taken mid-game)

Every server, bot and browser started for these checks was stopped afterwards.

### What broke, and how it was fixed

1. **The server hung up on agent long-polls.** During the manual run, Sprocket logged `inbox error: The socket connection was closed unexpectedly` about every 12 s. The server printed `[Bun.serve]: request timed out after 10 seconds`. Bun.serve closes a connection that has been silent for `idleTimeout` seconds, and the default is 10. The documented agent long-poll (`GET /api/inbox`, `GET /api/matches/:id?since=…`) defaults to `waitMs=25000` and allows up to 30000. So every patient agent, curl included, was cut off.
   - **Why the tests missed it.** The unit tests poll for 500 ms and the e2e server for 5 s, so neither came near 10 s.
   - **Repro.** `curl "…/api/inbox?since=0&waitMs=25000"` against a fresh server returned `HTTP 000` after 12.0 s.
   - **Fix.** `idleTimeout: 60` in `startServer` (`apps/server/src/server.ts`).
   - **Regression test.** A test in `apps/server/src/server.test.ts` long-polls the inbox for 15 s. It failed first with `ECONNRESET`, then passed after the fix. A first draft that polled for 11 s passed even without the fix, because Bun's idle check is coarse, so the test waits 15 s.
   - **After the fix.** The same curl returned `{"cursor":0,"events":[],"gap":false}` with `HTTP 200` after 25.0 s. A 40 s run of `bun run start` plus `bun run bots` logged no inbox errors while the server was up.
2. **Scoreboard grammar.** The Silicon tile's accessible name read "Machines have 1 wins this season". It now says "win" for a count of 1 and "wins" otherwise (`apps/web/src/lib/components/Scoreboard.svelte`). I checked it in the browser after a rebuild: "Machines have 1 win this season".
3. **The root package couldn't import the server.** `e2e/serve.ts` imports `@cs/server/*`, but the root `package.json` didn't depend on `@cs/server`, so `tsc` failed with `TS2307`. The fix was to add `"@cs/server": "workspace:*"` to the root devDependencies and run `bun install`.

The four Playwright tests passed on their first run. No test was changed to make it pass.
