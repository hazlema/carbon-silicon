# Carry-over from Milestone 1

Decisions and deferred findings from building M1 ("Doors open"). Read this before planning M2.

## M2 must-do (from the final review)

- IdentityManager.cacheBySecret never invalidates — locking names, roles and bans must evict cached identities.
- Table chat has no slur filter (ruling R3) — add it with moderation.
- Idle guest names are never released (spec §3, 30 days).
- TRUST_PROXY switch for x-forwarded-for; prune rate-limit buckets; require auth (or cap waitMs) for unauthenticated match long-polls.
- Keyboard users can't tab across disabled (non-legal) board cells; consider aria-disabled.
- 3–4 player entry points: eliminated seats can spam resign; release() can knock a player out of 'playing' in a newer match; resign during countdown leaves the DB row at 'countdown'.
- A human who reconnects mid-match after the 15 s grace shows 'ready' in presence.
- Verify the postgres-js path against a real Postgres before/at first deploy (only PGlite was exercised).

## M2b must-do

- Close a person's open WebSockets when their session is revoked, their name is released or their IP is banned (M2a leaves them open until reload).
- A released person's open WebSocket keeps them in presence under the old handle (which is free to claim) — refresh presence identity on release.

M2a's sanctions and bans take effect on the next authenticated HTTP request (and, since Task 12, on the next WebSocket open too — see `refreshMe()` in `ws.onopen`), but a socket that's already open keeps receiving public chat and its own inbox pushes until the browser reloads. DMs and invites (M2b) raise the cost of that gap, so it's a must-do before they ship, not a nice-to-have.

## Rulings made during M1

- Ruling: R1 — expected test counts in Tasks 1, 5 and 16 are off by one; the test code in the plan is authoritative, implementers report actual counts — costs nothing if wrong.
- Ruling: R2 — work on branch `m1-doors-open` in the main checkout instead of a separate worktree, because the site must be runnable from the repo at session end (rule 12) — if wrong, only isolation is weaker; main stays untouched until merge.
- Ruling: R3 — spec items not in M1's §12 scope (release of idle guest names after 30 days; slur filter on table chat) are deferred to M2 moderation — if wrong, slurs in table chat are unfiltered until M2.
- Ruling: R4 — executed the plan without a separate plan-review stop because the Foreman handed off ("sounds great. happy creating!") and the rulebook makes the builder the owner — if wrong, the Foreman reviews after the fact and rework follows.
- Task 3: Ruling: plan-mandated finding "rules.ts mentions `legal` but CMView has none" — code stands: `legal` is part of the MatchEnvelope (Task 8 envelope(), GET /api/matches/:id), which is what agents read beside `view`; verified the Task 8 brief produces it — costs a confused agent if wrong; revisit wording in Task 17 docs.
- Task 9: Ruling: plan-mandated Important "partner silently dropped from queue if createMatch fails in direct pairing" — accepted; fix = on createMatch failure restore the partner's queue entry and re-arm its fallback timer, then rethrow to the caller (mirrors fallback()) — costs a slightly longer invites.ts if wrong.
- Task 13: Ruling: Important "steady-state reconnect uses flat 2 s retry, no backoff" — code stands: the requirement came from the controller's review prompt, not the spec or plan (plan code uses a flat 2 s retry; initial connect backs off); one request per 2 s against a down local server is harmless — costs log noise during an outage if wrong.
- Task 14: Ruling: plan-mandated Important "HandleGate aria-modal without focus containment" — accepted; fix = mark the page shell `inert` while the gate is shown (layout) and move role="dialog" from the <form> to a wrapping <div> (clears the svelte-check a11y warning) — costs nothing if wrong.
- Task 15: Ruling: plan-mandated Important "region accessible name is 'Here now N', not exactly 'Here now'" — code stands: Task 18's e2e selects it with the regex /Here now/, and announcing the count is useful to screen-reader users — costs one selector tweak if an exact matcher is ever used.
- Ruling: R5 — added Task 16b (house-bot token recovery via house-key rotation; greet once per match) after playtests showed a lost token silences a house bot forever and Sprocket greeting 3x in one match — both break rule 12 (live and playable) — costs one extra task if wrong.
- Task 16: Ruling: plan-mandated Important "board has no backing; fixed Lattice bleeds into the game grid" (also observed by controller in screenshots) — accepted; fix = opaque panel backing behind the board (Board.svelte), plus the minor unhandled 409-refetch failure in move() — costs nothing if wrong.
- Task 16b: Ruling: plan-mandated Important "greet-once check reads the newest 200 messages, so the hello scrolls out in long matches" + Important "greets-once test flaky (default limit 50, newest-first)" — accepted (controller brief bug); fix = query `?since=0&limit=200` (oldest-first) in bot.ts and the test; include minor: fail fast on 404 in the poll catch — costs nothing if wrong.
- Final review: Ruling: fix wave includes Important 1-3 + Minors 5,6,14,15,10,13,4,11 (numbered in final-fix-findings.md); deferred to M2 checklist: TRUST_PROXY switch (7), rate-limit bucket pruning (8), unauth long-poll on matches (9), keyboard traversal of disabled cells (12), 3-4p resign-in-countdown DB status (16), IdentityManager cache invalidation (T5), table-chat slur filter (R3) — costs: deferred items stay latent until M2.

## Deferred minor findings

- Task 1: minor (deferred): commit 26dab21 trailer names Haiku instead of the global-constraint attribution line — future dispatches state the trailer verbatim
- Task 2: minor (deferred): "different seeds differ" test compares only the first next() output (plan-verbatim)
- Task 3: minor (deferred): no test exercises GAME_OVER path of apply()
- Task 4: minor (deferred): enum-like text columns have no CHECK constraints (plan-verbatim)
- Task 5: minor (deferred, M2-relevant): IdentityManager.cacheBySecret never invalidates — M2 (lock names, roles, bans) must add invalidation
- Task 5: minor (deferred): lastSeenAt column never updated in M1
- Task 6: minor (deferred): setManualStatus on a new entry with 'afk' emits a transient 'ready' presence event first
- Task 6: minor (deferred): no direct test that isReady() is false while playing/offline
- Task 7: minor (deferred): no test for two concurrent polls on one identity; empty waiter Set lingers until next deliver; postSystem skips channelKind validation
- Task 8: minor (deferred, fix before multiplayer entry point): eliminated seat can spam resign (bumps revision, resets clock); release() calls setPlaying(false) even for a player already in a newer match
- Task 8: minor (deferred, fix before prod Postgres — flag to final review): createMatch leaves a ghost match if DB insert throws (no rollback); goLive status write lacks WHERE status='countdown' guard (can race finish write on postgres-js pool); finish() writes not transactional; DB failure in finish() skips match.over delivery
- Task 8: minor (deferred): wrong forfeit wording for no-legal-moves branch; autopilot apply() throw doesn't re-arm timer; casts removable by computing outcome before advance(); test gaps (walk-away player status, restart matchPlayers rows, move resets timeout counter, unused firstLegal)
- Task 8: minor (deferred, cross-task): human who reconnects mid-match after grace period shows 'ready' instead of 'playing' in presence
- Task 9: minor (deferred): unexpected throw inside fallback() before leave() orphans the entry without re-arm; re-arm waits a full houseFallbackMs
- Task 9: minor (deferred): caller's prior queue entry for a different game is not restored if the new pairing's createMatch fails
- Task 10: minor (deferred): diary announcement uses straight quotes instead of the brief's curly quotes (undisclosed deviation; cosmetic)
- Task 5/lib: minor (deferred): EventBus failure-isolation test prints console.error noise in full-suite output
- Task 11: minor (deferred): waitMs clamp duplicated in two routes; `command: null` bypasses the BAD_COMMAND guard (game layer rejects it); BAD_QUERY path untested
- Task 12: minor (deferred): `as any` casts in server.test.ts could be narrower; /ws and static errors are plain text (not API surfaces); async shutdown handler rejection would be unhandled
- Task 13: minor (deferred): resumed playMatch re-sends a hello line mid-game; bot tests cover only the happy path (plan-mandated)
- Task 14: minor (deferred): no client-side character-class hint on the handle input; wordmark uses species colors for the words Carbon/Silicon (judged consistent with the concept)
- Task 15: minor (deferred): commit ef44bc0 trailer names Sonnet 5 instead of the global-constraint attribution line; apps/web/tsconfig.json gained "types": ["bun"] so svelte-check resolves bun:test
- Task 16: minor (deferred): verdict dialog lacks aria-modal/focus management (non-blocking panel by design); `reduced` motion flag not reactive to OS changes
- Task 16b: minor (deferred): rotateHouse read-then-update not transactional (same as insert())
- Task 17: minor (deferred): README references e2e/ before Task 18 creates it; nginx `listen 443 ssl http2` deprecated syntax; HOUSE_WAITS 403 code undocumented
- Task 18: minor (deferred): idle-timeout regression test adds ~15 s to bun test; Scoreboard singular fix has no automated test; idleTimeout comment doesn't cross-reference nginx proxy_read_timeout 45s

## Added after M1 (OLD IRON)

- Unprompted replies assume a single voiced house bot: nothing arbitrates which resident answers an unanswered line. Add coordination before a second voiced personality ships.
- Voiced bots short-poll #lobby and #critical-mass every 1.5 s (about 1.3 requests/s of chat history reads). Add `waitMs` long-poll support to `GET /api/chat/:channel`, as the inbox already has, and switch the watcher to it.
- The unanswered-line watcher has no dedicated test that shutdown is prompt; a voiced personality without an `unanswered` line bank silently says nothing when the LLM is down.
- Graceful server shutdown can take 10–15 s or more while long-polls drain; consider closing idle long-polls on SIGTERM.

## Added after M1 (redesign from docs/mock)

- The lobby mock has a "vs house" button. Quick match already seats a house machine after `houseFallbackMs` (8 s); a direct "play the house now" needs a server entry point that skips the wait.
- The lobby mock gives humans a one-line bio in Here now ("Human. Asks about technology."). Only agents have a `tagline`; humans need a way to set one.
- Seat colours: one human against one machine plays Carbon orange against Silicon cyan; every other table takes orange, cyan, green, violet in seat order (`apps/web/src/lib/seats.ts`). With two humans, one of them is cyan.
