# Carry-over from Milestone 2b ("Tables")

Decisions the Proprietor made on the Foreman's behalf while building M2b, and the findings deferred to later. Read this before planning M2c ("Company": DMs and owner links). M1's list, with what M2b closed, stays in `docs/m1-carryover.md`; M2a's in `docs/m2a-carryover.md`.

## Rulings

Each line: what was decided — why — what it costs if wrong. P1–P7 were made while planning (`docs/superpowers/plans/2026-09-28-m2b-tables.md`); R-P1 and R-P2 at the pre-flight check; R-1 onwards during execution.

- P1 — The spec's "keyboard players can reach every cell" and "reconnect after grace shows playing" fixes already shipped in M2a (`e2e/match.e2e.ts` keyboard test, `apps/server/src/ws/hub.test.ts`). No task re-does them; Task 2 only keeps those tests green — costs nothing.
- P2 — Unseating someone (left, removed, away) always sends them `table.closed` with the reason, so their card disappears — the spec only said so for disbanding — costs one extra event.
- P3 — A tableless live match (unit tests call `createMatch` without a table) keeps a postable `match:<id>` channel through `setMatchAccess` — cheaper than making every GameManager test build a table — costs a second access hook in CommunicationManager.
- P4 — A busy house bot declines silently unless it was one of the table's last players (rematch), because only seated and last players may post at a table — the spec's "in-character line" needs chat rights — costs: most busy declines are silent.
- P5 — The Rail tab's number is unread rail lines while you're on the Table tab (the header already shows "Watching: n") — costs nothing.
- P6 — `@mention` menus open only for people in Here now (the menu needs their identity, and only people present can be invited) — costs: a mention of an absent person is plain text.
- P7 — `/invite` never grows a table: size is the game's `maxPlayers`, so a name that doesn't fit gets the `TABLE_FULL` wording (the spec's §2 "grows the table if needed" predates the fixed-size decision) — costs nothing.
- R-P1 — T5's implementer drops `ben` from that test's destructuring and the `expect(ben).toBeDefined()` line instead of keeping a do-nothing assertion — plan-mandated no-op assertion is a test-hygiene defect — costs nothing if wrong.
- R-P2 — work on branch m2b-tables in the main checkout (as M2a R1) — rule 12 needs the site runnable from the repo at session end; main stays untouched until the Foreman approves a merge — costs weaker isolation if wrong.
- R-1 — every later brief's final verify step is `bun run verify` (constraints.md wins over narrower per-step commands); the controller tells each implementer so — costs a few minutes of e2e per task.
- R-2 — an evidence-only fix round (no diff) is closed by the controller checking the appended evidence instead of an empty-diff re-review — costs nothing.
- R-3 — T2's first 'tables' test checks the system line by querying the `messages` table directly (channel = 'table:t_games1') instead of comms.history — keeps T2 independent of T3's channel work and keeps T3's RED baseline — costs a DB-level assertion instead of an API-level one (T3/T4 tests cover history on table: channels).
- R-4 — subagent commits may carry the attribution line their own harness supplies (e.g. Sonnet) instead of the plan's Opus line — the harness attribution rule outranks a plan constraint, and it names who actually wrote the commit — costs cosmetic trailer drift (as in M1 Tasks 1/15).
- R-5 — Task 5 also changes WsHub subscribe/unsubscribe to resolve `match:` aliases (add/remove the resolved channel as well as the raw one) with a hub test — T5 is the first task where aliases resolve to tables, so its verify would otherwise fail — costs one more file in T5.
- R-6 — tables.test.ts setup() builds PresenceManager with humanIdleMs 3_600_000 (agentTimeoutMs 90_000, humanGraceMs 15_000 unchanged) so the idle-close test isolates the table's own timer; production behaviour stands (an idle host auto-AFKs and the table closes as host-left, which is equally correct) — costs nothing.
- R-7 — accept I1 and I2 against the plan text: sit() re-runs its early checks after the await and seat() is a no-op for someone already seated at that table; remove() uses forbidden('NOT_SEATED') — the spec's "checks and writes see the same table" and the constraints' 403 bind — costs a few lines.
- R-8 — pull the two minimal fixes into Task 5 so verify stays green (rule 12, constraint "verify passes at the end of every task"): (a) apps/bots/src/bot.ts — playMatch talks at `table:<tableId>` when env.match.tableId is set (greet check reads the same channel) and runBot tracks a matchId → table-channel map for the table-talk check (the same shape Task 8 Step 5 prescribes, taken early; Task 8 then adds only invites/busy); (b) apps/web/src/routes/play/[id]/+page.svelte — ChatPanel channel = match.tableId ? `table:${match.tableId}` : `match:${match.id}` (Task 9 replaces the page anyway) — costs a small overlap with Tasks 8/9.
- R-9 — accept I1–I3 against the plan text: after the await rematch() re-checks the caller (assertFree + atTable) and, if the table is already forming, recurses into the forming branch; the finished branch refuses house bots with 403 HOUSE_WAITS — spec §2 binds — costs a few lines.
- R-10 — playOut() long-polls when the player has no legal move (GET /api/matches/:id?since=<revision>&waitMs=50 with that player's token) instead of spinning; test-only, same technique as app.test.ts — costs nothing.
- R-11 — drop the upgrade-time isIpBanned 403: the ban still closes the IP's open sockets (4001, spec §3) and revokes sessions created there; a locked account signing in from that IP gets a socket like it gets HTTP — M2a's IP-ban policy binds and the brief's extra refusal contradicts it — costs: a banned IP's still-valid session reconnects its socket (as its HTTP already works). Also pin SIGNED_OUT === 4001 in a test (Minor 1, one line, taken with the fix).
- R-12 — I2: code stands — GET /api/matches/:id only serves matches still retained in memory (30 min), so a tableless match's old page already fell to "This table has been cleared" once it aged out, and every match since Task 5 has a table; the spec sentence is outdated — costs: a stale /play bookmark to a pre-M2b match within its 30-minute retention shows "cleared" instead of the board.
- R-13 — accept I1/I2 against the plan text: decline removes the offer only after the call succeeds (like accept); the countdown number is aria-hidden (the card's appearance stays announced) — costs a few lines.
- R-14 — accept the live.svelte.ts loadGames fix inside Task 11 (outside its file list) — without it the lobby shows raw game ids and /invite can't pick a game for new guests; it's a 3-line fix of Task 10 code — costs nothing.

## Deferred findings (minor, from the per-task reviews)

- Task 1: minor (deferred): generated 0003 migration/snapshot lack trailing newline (drizzle-kit default)
- Task 3: minor (deferred): ReportsTab paren-wrapped regex could carry a comment explaining the Svelte `{/` gotcha
- Task 4: minor (deferred): decline/expire/onUnavailable invite drops don't touch() the idle timer (spec says any seat or invite change resets it)
- Task 4: minor (deferred): host() failure path leaves a table.closed event, an "opened a table" line and a table.changed for a table the caller never saw
- Task 4: minor (deferred): sit() silently moves you off another table (disbanding one you host) while host() refuses AT_TABLE — inconsistent
- Task 4: minor (deferred): a host's block is inferable at an open table (NOT_OPEN while listed open)
- Task 4: minor (deferred): `declined` map never pruned
- Task 4: minor (deferred): test gaps — starting lock not attempted, last-player posting, outsider info() view, refund loop, host AFK → host-left, offline path
- Task 4: minor (deferred): sit() post-await re-check doesn't re-check t.open (host closing the table mid-await still lets an uninvited sit complete)
- Task 5: minor (deferred): vsHouse tests don't pin "the one you name" (single bot) or the AFK case (Bouncer); a freshly-upserted Bouncer presence is 'ready' until it sets AFK
- Task 5: minor (deferred): two simultaneous vsHouse calls can invite the same bot (invite() re-checks available() not isBusy())
- Task 5: minor (deferred): startNow rollback sends table.updated then table.closed for a table the players never saw; untested
- Task 5: minor (deferred): rematch reports TABLE_BUSY when the table closed mid-await (should be NO_TABLE); rematch blocks path untested; forming-branch seats an uninvited last player without the host-blocks check
- Task 5: minor (deferred): R-5 hub channel set has no refcount (unsubscribing the alias drops a direct table: subscription); unsubscribe path untested
- Task 5: minor (deferred): bot.test R-8 assertion passes even if tableId were null; invites.test 'fallback skips invited bot' relies on Bun.sleep(20)
- Task 5: minor (deferred): AT_TABLE check sits after NOT_READY in quickMatch (brief put it after IN_MATCH) — harmless
- Task 5: minor (deferred): rematch forming-branch open-seat path ignores the blocked set / available() for a recursed second presser
- Task 7: minor (deferred): revokeOthers/revokeByIp ended-id paths, upgrade trustProxy and released-person socket close untested
- Task 7: minor (deferred): race between authenticateSession and open() lets a just-revoked session's socket survive
- Task 7: minor (deferred): presence.drop runs after the other release hooks (a throwing hook leaves the handle in Here now until grace)
- Task 7: minor (deferred): every table.changed broadcasts the full list to every socket, incl. private-table and watcher-count changes (nested emit doubles it)
- Task 7: minor (deferred): "PGlite is closed" line in full-suite output dismissed without base-commit evidence
- Task 8: minor (deferred): a non-ApiError failure of me() in answer() leaves the invite unanswered (it expires) and the catch comment doesn't describe that path
- Task 9: minor (deferred): tab flashes to Rail for a player until the table loads (isPlayer false while table is null)
- Task 9: minor (deferred): tab/railUnread not reset on client-side navigation between two /t/ pages
- Task 9: minor (deferred): reports.test 'suspended people cannot report' flaked once in a full verify under CPU load (a hung stray bun test process from 09:53 pegs a core; my kill was refused by the permission checker — left for the Foreman)
- Task 10: minor (deferred): InviteCard has no busy state (double Accept fires two requests)
- Task 10: minor (deferred): an invite past 0 s stays in live.offers (hidden) until refreshMe
- Task 10: minor (deferred): 4001 reconnect timer races the refreshMe that may null `me` (one stray reconnect)
- Task 10: minor (deferred): Play panel buttons stack one per line (.btn width:100% inside the flex row) instead of a three-button row
- Task 11: minor (deferred): PersonMenu's window keydown listener is unconditional (one per rendered author)
- Task 11: minor (deferred): host-branch firstItem unbound if the catalog is momentarily empty
- Task 11: minor (deferred): Open list shows a full forming table (Sit → TABLE_FULL error) — brief code
- Task 11: minor (deferred): PersonMenu stays open after an action while MessageMenu switches to 'done' — brief code, UX seam
- Task 11: minor (deferred): e2e '/invite from the lobby chat reaches someone on their profile page…' (added in Task 11) flaked once in a full run; clean on 3 isolated reruns + a full rerun — triage at final review
