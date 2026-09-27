# Carry-over from Milestone 2a ("Keys & Bouncers")

Decisions the Proprietor made on the Foreman's behalf while building M2a, and the findings deferred to later. Read this before planning M2b. The M2b must-do list stays in `docs/m1-carryover.md`.

## Rulings

Each line: what was decided — why — what it costs if wrong.

- R1 — branch in the main checkout, no separate worktree (as M1's R2) — rule 12 needs the live site runnable from the repo at session end and main stays untouched until the Foreman approves a merge — costs weaker isolation if wrong (a broken web build is served by the dev server mid-task).
- PF1 — T10 must ADD `calls`/`prune()`/`size` to the existing RateLimiter (keeping T5's `blocked()`), not replace the file — the replacement breaks login/recover — costs nothing if wrong.
- PF2 — T2's slur test uses `containsSlur('k1ke')` instead of the spaced 'K I K E' — obscenity 0.4.6 does not join spaced letters, and a whitespace-skipping transformer would cause false positives — costs: spaced-out slurs pass the filter.
- PF3 — the console also refuses (403 CONSOLE_OFF) any request carrying X-Forwarded-For, with a test (socket 127.0.0.1 + XFF), and T17 adds `location /api/console/ { return 404; }` to deploy/nginx.conf — behind nginx every request is loopback, so the loopback check alone would expose the console to the internet guarded only by ADMIN_KEY — costs nothing if wrong.
- PF4 — T17 Step 2 deletes T8's "## Moderation and safety" stub section and T5's two inserted sections, and places `### DELETE /api/me` after the PATCH status paragraph — avoids duplicate docs — costs nothing.
- PF5 — T13's e2e uses `getByRole('textbox', { name: 'Bio' })` — strict-mode double match — costs nothing.
- PF6 — T17's .env.example replacement keeps the LLM_API_KEY / LLM_TEMPERATURE / BOUNCER_MODEL / LLM_SETTINGS lines from 0f9b720 — costs nothing.
- PF7 — implement the spec: comms.history()/message() take the viewer; staff (mod/admin) get the original text of removed messages alongside `removed`; the chat route passes the caller; ChatPanel shows it dimmed for mods (T7 server, T8 route, T14 web) — spec S145-146 requires it — costs a small amount of code if wrong.
- PF8 — T8 adds one HTTP table test (suspended → chat/quickmatch/move/report/PATCH /api/me/DELETE /api/me = 403 SUSPENDED) and T12's suspension e2e asserts the send box is gone — spec §8 names HTTP-door tests — costs test time only.
- PF9 — delete T10's "leave e2e/serve.ts untrusted" clause; T12's trustProxy: true stands — costs nothing.
- PF10 — contract line updated: peopleFilterOf/PeopleFilter live in moderation.ts — costs nothing.
- PF11 — T6 records role changes as `{ role: <new>, from: <old> }` so T15's logLine (detail.role) reads it — costs nothing.
- PF12 — T16 judge.ts: the LlmConnection type import goes in the import block — costs nothing.
- PF13 — T6's expected count reads 49 tests — costs nothing.
- PF14 — DELETE /api/me calls deleteSelf first; only after it succeeds does the route leave the queue and resign a live match — costs nothing.
- PF15 — T17 error table: SELF is the ignore/block-yourself code (moderators acting on themselves get FORBIDDEN_ROLE); add NO_SESSION; reports are once ever per reporter and message — costs nothing.
- PF16 — T12's live store calls refreshMe() in ws.onopen (after the first open too), closing the push window for sanctions in production as well as e2e — costs one extra GET per (re)connect.
- PF17a — fix one-liners: `lock` is guarded 'profile' (suspended accounts can't lock); ModerationManager.release lifts active sanctions; the end-of-match nudge shows only after a win; the resolvedBy filter compares lower-case; the Bouncer sets AFK immediately after registering, before anything else — costs nothing.
- PF17b — accepted deviations, no change: lastSeenAt throttled per session (still ≥ once per 5 min per identity); suspension doesn't evict the auth cache (sanctions are checked live); PersonDrawer omits recent matches (the profile link has them); spec field names `code`/`resolution` stand — costs cosmetic spec drift.
- PF17c — open WebSockets are NOT closed on session revocation, release or IP ban in M2a; logged to docs/m1-carryover.md as an M2b must-do before DMs ship — an open socket only receives public chat and its own inbox until reload — costs: a revoked browser keeps receiving its old inbox pushes until it reloads.
- T3-R1 — fix the eviction race with a generation counter (capture before the DB read, only cache.set if unchanged), overriding the plan's code — spec/Review Focus 1 require the old cookie to fail on its next request and prod postgres-js pools queries — costs a few lines if wrong.
- T3-R2 — replace the non-failing test with human rows whose secretHash = hashSecret(known) (a csk_ secret without a sessions row, and a non-csk_ secret), asserting authenticate(known) is null — the plan's test re-hashes the hash and asserts nothing — costs nothing.
- T5-R1 — reserve a token on both limiters before the attempt and refund it when the attempt doesn't end in BAD_PASSWORD/BAD_CODE (RateLimiter.refund), with a concurrent regression test, overriding the brief's code — spec requires the limit and each attempt costs an argon2 verify — costs a few lines if wrong.
- T5-R2 — the inline leave-queue + resign sequence in DELETE /api/me is carried to Task 6: its implementer replaces it with the shared bench helper ModerationManager builds, so the logic lives in one core place — costs nothing.
- T6-R1 — sanctions carry their imposer's rank (console 4 > admin 3 > human mod 2 > house mod 1, derived from actor_id's current role/isHouse on load, null actor = console); replacing an active sanction of the same kind or lifting one requires actor rank ≥ imposer rank, else 403 FORBIDDEN_ROLE; the pinned "replace whether shorter or longer" test stays valid for equal/higher rank and gains lower-rank refusal cases — spec: long/permanent suspensions are admin-only and house mods are capped, which replace/lift would otherwise undo — costs: a mod can't soften a colleague-admin's sanction without asking an admin (or the console).
- T9-R1 — the spec's "each command writes to the moderation log" covers state-changing commands; `list` is a read and writes nothing — costs nothing.
- T15-R1 — fix all three against the brief: close the drawer after a successful release; make the drawer a <div role="dialog" aria-modal="true"> with focus moved in on open (HandleGate's pattern) and svelte-check at 0 warnings; route every released-name display through displayName() — the spec requires keyboard access and the reviewer confirmed the release bug is reachable — costs little if wrong.
- T16-R1 — promote reviewer Minor 1 (LlmJudge `stopped` rejects unhandled when already aborted or when the connection read outlasts the timeout; reviewer reproduced exit code 1, which takes down every bot via main.ts's Promise.all) and Minor 2 (transcript END marker spoofable; the spec names injection resistance) into this fix round — both are cheap and break stated contracts — costs a few lines if wrong.
- T17-R1 — the controller runs the live check against a COPY of the dev PGlite database on port 3200 with a scratch bot-token dir (not the live :3000 site), because booting M2a on the real dev DB runs migration 0001, which rewrites human keys and would strand sign-ins if the Foreman chose not to merge; the real site moves to M2a only at merge (the Foreman's call). The receipts go into docs/verification.md `### Live` via the Task 17 implementer — costs: the live check exercises a copy, not the running site.
- T17-R2 — the Live receipts fix is a verbatim transcription of observations the controller made and wrote itself, so the controller checked it against its own text instead of dispatching a re-reviewer — costs nothing (the final whole-branch review reads it too).
- FR1 — the final review's "declined to judge" items stand as decided: per-handle sign-in limit enables lockout of a named user (spec-mandated; flagged to the Foreman); admin reset-password signs out sessions but the old password still works until the player sets a new one (spec frames reset as the lost-password path); open sockets (PF17c); cache vs sanctions (PF17b); unfiltered HTTP chat reads (spec); no mod delete in the chat menu and no IP-ban UI in /mod (spec lists neither; APIs exist); spaced slurs (PF2); staff get report.opened about themselves (harmless); table-chat history public over HTTP (M1 scope) — costs: listed items stay as-is until the Foreman asks.
- FR2 — Minor 9 (released person's open socket keeps presence under the old handle) goes to the M2b must-do list alongside PF17c — costs: a brief duplicate handle in "Here now" until the socket closes.
- real, deferred to M2b (evict + delete sessions before hooks, or try/finally); hooks are internal and have not been seen to throw — costs: a stale cached session could survive a failed release until restart.
- deferred (only possible in dev DBs made before today's fix) — costs: remove such a row by hand.
- accepted as specified in the fix wave — costs: a retry later.
- deferred, harmless.

## Deferred findings (minor, from the per-task and final reviews)

- Task 1: minor (deferred): migration session ids use md5(random()||id) with no explicit collision guard (one-time backfill; astronomically unlikely)
- Task 3: minor (deferred): touchedAt map never pruned (grows per session/agent for process lifetime)
- Task 3: minor (deferred): constraints say lastSeenAt throttled per identity, code throttles per session (decided extension, PF17b)
- Task 3: minor (deferred): createHuman inserts identity then session without a transaction (failed newSession strands the handle)
- Task 3: minor (deferred): newSession doesn't guard that the identity is a non-released human
- Task 3: minor (deferred): cached IdentityPublic objects returned by reference (M1 behaviour); Cached type unexported but in a public signature
- Task 3: minor (deferred): eviction test covers one session only; touch negative check uses Bun.sleep(30)
- Task 3: minor (deferred): pre-existing EventBus failure-isolation test prints console noise in the full suite
- Task 4: minor (deferred): sweepIdle releases candidates without re-checking passwordHash/lastSeenAt — a guest who locks mid-sweep could be released (spec: locked names never released) — triage at final review
- Task 4: minor (deferred): one throwing onRelease hook aborts the whole sweep (catch/log per candidate)
- Task 4: minor (deferred): recover/lock check-then-write not atomic (concurrent same-code recover; concurrent lock overwrites recovery code)
- Task 4: minor (deferred): dummyHash built lazily — first unknown-handle miss after boot is slower (timing)
- Task 4: minor (deferred): test gaps — lock guard, recover on unknown/released handle, sessions() newest-first, NO_USER
- Task 5: minor (deferred): no test that DELETE /api/me resigns/leaves queue only after success
- Task 5: minor (deferred): no HTTP tests for DELETE /api/me/sessions/:id (204/404), recover failures counting, GET /api/users/:handle on a released name
- Task 5: minor (deferred): idle-sweep console.log prints during bun test
- Task 5: minor (deferred): optionalBody drops non-JSON bodies silently → misleading BAD_PASSWORD message; API.md lacks session/revoke response shapes; index-doc GET /api/me text omits sanction
- Task 5: minor (deferred): ProfileService orderBy endedAt has no tiebreaker
- Task 5: minor (deferred): POST /api/me/password and DELETE /api/me verify the current password without a rate limit (stolen-cookie brute force)
- Task 6: minor (deferred): unused `bus` dependency in ModerationManager
- Task 6: minor (deferred): IP_RE accepts non-addresses and bans match exact strings (no isIP validation, no lower-casing, ::ffff: mapping)
- Task 6: minor (deferred): impose update+insert, release and setRole multi-row writes not transactional
- Task 6: minor (deferred): lift stamps liftedAt on already-expired rows
- Task 6: minor (deferred): current() leaves empty inner maps (small leak in people() iteration)
- Task 6: minor (deferred): release() clears active sanctions without an imposer-rank check (admin release can clear a console-imposed sanction; release tombstones the account anyway)
- Task 6: minor (deferred): load() defaults a missing imposer row to rank 2
- Task 7: minor (deferred): resolve's early minutesOf check is defence in depth (mute()/suspend() already validate); its test passes without it and two comments overstate a "cap bypass"
- Task 7: minor (deferred): resolvedBy comment promises "@Bob" matching but code only lower-cases (strip leading @)
- Task 7: minor (deferred): re-reporting an already-removed message → 400 CANT_REPORT rather than 409 DUPLICATE_REPORT (still refused)
- Task 7: minor (deferred): resolve 'delete' on an already-removed message writes a second delete-message log row
- Task 7: minor (deferred): resolve doesn't claim the report atomically (concurrent resolves double-apply); addNote read-modify-write can lose a note
- Task 7: minor (deferred): relations mutes() cache can be refilled with stale data after set/clear during an in-flight read
- Task 7: minor (deferred): report context lines removed earlier are stored as '' with no removed flag
- Task 7: minor (deferred): no test for house-mod report.opened delivery or ignoring a released target
- Task 9: minor (deferred, triage before merge): .env.example ships ADMIN_KEY=dev-admin-key and deploy copies it — production could run with a public key (treat the dev value as unset in production, or comment it out)
- Task 9: minor (deferred): console key compared with !== (not constant-time; local callers only)
- Task 9: minor (deferred): nginx.conf should say every proxied location MUST set X-Forwarded-For (console depends on it)
- Task 9: minor (deferred): console list capped at 50 via people(); grant-mod silently demotes an admin; CLI usage on no command goes to stdout
- Task 9: minor (deferred): console test gaps — grant-mod on locked human / guest, revoke on non-admin
- Task 11: minor (deferred): keyboard e2e RED step skipped (reasoned instead of observed); final verify green
- Task 12: minor (deferred): HandleGate 'saved' step finish() no-ops silently if recovered is null (unreachable today)
- Task 13: minor (deferred): delete-account handle confirmation is case-insensitive; rejected bios surface as a generic alert (no inline hint)
- Task 14: minor (deferred): MessageMenu uses role=menu without arrow-key roving focus (Tab order instead)
- Task 14: minor (deferred): "message removed by @console" reads oddly for console removals
- Task 15: minor (deferred): ActionForm renders an empty length picker and submits a stale 60 when maxMinutes is 0 (house mods; not reachable from the browser today)
- Task 15: minor (deferred): e2e covers 3 mod scenarios only (no release/role/reset/reopen)
- Task 15: minor (deferred): PersonDrawer (like HandleGate) has no focus trap
- Task 16: minor (deferred): any 403 on resolve logs "no powers yet" (should check code FORBIDDEN_ROLE)
- Task 16: minor (deferred): setStatus('afk') right after connect sits outside a try — a failure rejects runBouncer and main's Promise.all (same pattern as runBot's me())
- Task 16: minor (deferred): Bouncer profile's model name read once at startup while the judge follows the file live
- Task 16: minor (deferred): the post-resolve note is posted after the resolve and unguarded — a note failure leaves a resolved report without a Bouncer note (narrow re-judge window after reopen+restart)
- Final fix wave: re-review — 13/13 ADDRESSED, no new Critical/Important. Residual minors parked:
- Final: parked — release() hooks run after the tombstone UPDATE; a throwing hook leaves sessions/cache un-evicted and a retry can't rerun hooks — Ruling: real, deferred to M2b (evict + delete sessions before hooks, or try/finally); hooks are internal and have not been seen to throw — costs: a stale cached session could survive a failed release until restart.
- Final: parked — unbanIp refuses loopback too, so a pre-fix loopback ban can't be removed via the API — Ruling: deferred (only possible in dev DBs made before today's fix) — costs: remove such a row by hand.
- Final: parked — DELETE /api/me and POST /api/me/password share the per-IP login budget, so a password-less guest behind a busy NAT can get 429 on self-delete — Ruling: accepted as specified in the fix wave — costs: a retry later.
- Final: parked — report.opened still reaches suspended staff; pre-fix release sanctions stay un-lifted in dev DBs — Ruling: deferred, harmless.
