# Brief A — "the site was updated" banner — report

## What changed

1. **`apps/web/svelte.config.js`** — added `kit.version.pollInterval: 60000`. SvelteKit now polls
   `/_app/version.json` every 60 s in the background. Confirmed in `apps/server/src/server.ts`
   (`serveStatic`) that only paths under `/_app/immutable/` get the year-long immutable
   `cache-control`; every other static file, `/_app/version.json` included, already gets
   `cache-control: no-cache`. No server change was needed for requirement 1 — it was already
   correct, just unexploited.

2. **`apps/web/src/lib/live.svelte.ts`** — imported `updated` from `$app/state` (this project's
   SvelteKit is 2.70.3, well past the 2.12 cutover, so the runes-era `$app/state` export is used
   rather than the legacy `$app/stores` one — this matches the brief's own guidance and required no
   deviation). In `connect()`'s `ws.onopen`, right where `reconnects` is bumped (i.e. only on an
   actual *re*connect, not the first connect), added `void updated.check().catch(() => {})` —
   best-effort, errors swallowed, never awaited or allowed to affect connection logic.

3. **`apps/web/src/lib/components/UpdateBanner.svelte`** (new) — renders nothing when
   `updated.current` is false. When true, shows a `role="status"` bar: "Carbon & Silicon was
   updated." plus a `Reload` button (`onclick={() => location.reload()}`). Styled with existing
   tokens (`--panel`, `--lattice`, `--chalk`) and the existing `.btn.primary` class (carbon-colored,
   already defined in `app.css`), matching `SanctionBanner.svelte`'s style. It's a plain flex row
   that wraps at narrow widths, so it fits at 400 px. The button is a normal focusable `<button>`,
   reachable and activatable by keyboard with no extra wiring. Nothing about the copy pressures a
   reload — it states a fact and offers a choice.

   Rendered in `apps/web/src/routes/+layout.svelte`, placed above `<Lattice />` and outside the
   `.shell` div (which gets `inert` while the handle gate is up) so the banner and its Reload
   button stay usable regardless of sign-in state or an active match — it never reloads on its own,
   the player always chooses.

4. **`e2e/update.e2e.ts`** (new) — loads the lobby, then:
   - registers `page.routeWebSocket('**/ws', ...)` with `connectToServer()` (pure pass-through) to
     get a handle on the client-side `WebSocketRoute`, since `**/_app/version.json` can be faked
     with `page.route`, but nothing forces the *existing* WS connection to actually cycle short of
     a real network primitive.
   - routes `/_app/version.json` to report `{"version":"e2e-new-build"}`.
   - calls `clientSocket.close()` to force-close the socket as the page sees it — this drives
     `live.svelte.ts`'s real `ws.onclose` → retry → reconnect path (visible via the Nav's
     "Reconnecting" title appearing then disappearing), which is exactly requirement 2's code path,
     not a synthetic shortcut.
   - asserts the banner and its Reload button become visible.

   `page.context().setOffline(true/false)` was tried first (per the brief's suggested options) but
   in this Chromium/Playwright setup it did not close the already-open WebSocket within a 5 s
   timeout — the Nav's "Reconnecting" indicator never appeared, so the reconnect path was never
   exercised and the test was a false negative. `page.routeWebSocket(...).close()` is Playwright's
   documented mechanism for a real, page-visible close and reliably exercises the actual reconnect
   code (verified over several repeated runs, no flakes).

## Test RED/GREEN evidence

RED (test written against the pre-implementation code, before any of the four other changes):
```
Error: expect(locator).toBeVisible() failed
Locator: getByRole('status').filter({ hasText: 'Carbon & Silicon was updated.' })
Expected: visible
Timeout: 5000ms
Error: element(s) not found
```

GREEN (after implementing all four changes, `bun x playwright test e2e/update.e2e.ts`, run 4x
including inside the full `bun run verify` pass, no flakes):
```
Running 1 test using 1 worker
  ✓  1 e2e/update.e2e.ts:4:1 › a stale tab learns a new build shipped when its socket reconnects, and offers a reload (1.1s)
  1 passed (3.4s)
```

## `bun run verify` output (tail)

```
$ playwright test
Running 20 tests using 1 worker
  ✓   1 e2e/accounts.e2e.ts ...
  ...
  ✓  20 e2e/update.e2e.ts:4:1 › a stale tab learns a new build shipped when its socket reconnects, and offers a reload (1.1s)
  20 passed (44.7s)
[exited with code 0]
```
`bun run verify` (typecheck + `bun test` + build + Playwright) exited 0. Earlier stages
(`tsc -p tsconfig.json`, `cd apps/web && bun run check`, `bun test`) all ran and passed — the
script is `&&`-chained, so a failure there would have stopped it before build/e2e output appeared,
and the command's exit code was 0. Confirmed separately:

- `cd apps/web && bun run check`: `394 FILES 0 ERRORS 0 WARNINGS 0 FILES_WITH_PROBLEMS`.
- `bun test`: `385 pass / 1 skip / 0 fail` across 386 tests, 43 files (the "error: boom" /
  "database went away" lines in its output are intentional simulated-failure test fixtures in
  `apps/server`, unrelated to this change, not real failures).

## Deviation from the brief

None. The brief's own uncertainty about `$app/state` vs `$app/stores` resolved cleanly: this
project's SvelteKit (2.70.3) ships the runes-era `updated` export in `$app/state` with
`.current`/`.check()`, exactly as the brief anticipated as the preferred option, so no fallback to
`$app/stores` was needed. The server-side cache-control requirement was already satisfied by
existing code (`apps/server/src/server.ts`), confirmed, not changed.
