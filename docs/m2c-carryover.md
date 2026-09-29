# Carry-over from Milestone 2c ("Company")

This file records two things: the decisions the Proprietor made on the Foreman's behalf while building M2c (direct messages and owner links), and the findings deferred to later. Read it before planning M3. M2b's list is in `docs/m2b-carryover.md`.

The build ran subagent-driven: 11 tasks, each implemented and reviewed by a fresh agent, then a whole-branch review and one fix wave. The Foreman was away for most of it ("use your best judgment"), so every call below is a ruling.

## Rulings made while planning (R-P)

- **R-P1.** `chat.dm` carries only `message`, since its author is the sender. The spec listed `{message, from}`.
- **R-P2.** `ownerHandle` is stored as `identities.owner_handle` beside `owner_id`. `toPublic` is synchronous and runs on raw rows everywhere, so it can't look the owner up. Link, unlink and release keep the two in step.
- **R-P3.** `AgentSummary.record` is the agent's full record vs humans, and the summary adds `sanction`. The spec sketched `{wins, losses, draws}`.
- **R-P4.** The owner's corner card uses the site's `untilText` wording ("muted until 3:40 PM") rather than "for 10 min".
- **R-P5.** DMs reach browsers through their own bus event, `dm.message {message, to}`, never `chat.message`, so a channel subscriber can't receive one even by mistake.
- **R-P6.** A `dm:` channel that isn't sorted, or names one id twice, is not a channel (`404 NO_CHANNEL`).
- **R-P7.** The e2e server runs only Sprocket, so the e2e "a house bot answers a DM" uses Sprocket's canned line. OLD IRON's voice path is pinned by the bot unit tests.
- **R-P8.** "Message @x" closes the name menu without refocusing the name; the composer takes focus instead.
- **R-P9.** A DM arriving in the open tab bumps its unread count, and the page's effect reads it straight away. There is no "viewing" flag in the store.

## Rulings made while building (R)

Each ruling gives what was decided, why, and what it costs if wrong.

- **R-1. Built in a git worktree.** The worktree is `.worktrees/m2c-company`; `.worktrees/` was added to `.gitignore` on `main` (a4cbc88).
  - Why: the Foreman's dev server and bots auto-restart from the main checkout. He picked this option before leaving.
  - Cost if wrong: nothing; the branch merges like any other.
- **R-2. Subagent commits name their own model** in the Co-Authored-By trailer (Sonnet 5.5, Opus 5.5) rather than the plan's single line.
  - Why: it's the accurate attribution.
  - Cost if wrong: nothing.
- **R-3. Two Task 2 review minors were folded into Task 3:** `postSystem` refuses `dm:` channels (`NO_SYSTEM_DM`), and the hooks' `to` list is filtered to the pair before any push.
  - Why: two-line privacy hardening, cheaper then than later.
  - Cost if wrong: a slightly larger Task 3.
- **R-4. Lines sent while you ignored someone count as unread once you stop ignoring them.**
  - Why: they are real messages you chose to see again. The spec only promises that nothing arrives and the tab stays shut while the ignore holds.
  - Cost if wrong: an un-ignore can show a burst of unread lines.
- **R-5. `drop()` (the agent unlinking itself) also sends the agent `owner.changed {owner: null}`.**
  - Why: the spec says the agent hears every unlink.
  - Cost if wrong: one redundant event.
- **R-6. `loadDms` keeps local conversations the server doesn't list yet** (`last === null`).
  - Why: without it, a reconnect while you compose a first DM throws you back to #lobby.
  - Cost if wrong: a placeholder can linger until the page reloads. The shared-browser half of that risk was closed by F-2 below.
- **R-7. DM tabs got their own row beneath the channel/tab row**, in the lobby and at a table. They are plain buttons with `aria-current`, and handles are truncated at about 14ch with the full handle as a tooltip.
  - Why: the inline tabs hid the first DM and its dot off-screen at 400 px, collided with the channel description at 1400 px, and put non-tab children inside the table page's tablist.
  - Cost if wrong: one more row (about 2.5rem) when any conversation is open.
- **R-8. Three Task 9 minors were folded into its fix round:** the unread dot is `role="img"`, More's accessible name drops the glyph and More closes when it empties, and `/msg` honours the sending guard.
  - Why: a line or two each.
  - Cost if wrong: nothing.
- **R-9. The carry-over and diary were written after the final review** (Task 11 split), as M2b's R-15 did.
  - Why: both record the review and its fix wave.
  - Cost if wrong: nothing.
- **R-10 (final review C-1). A profile's `agents[].sanction` goes only to that human and to staff**; everyone else gets `null`. `/api/me/agents` keeps it.
  - Why: the spec's "the owner's agent list shows each agent's active sanction" reads as owner-only. A moderator's reason, notably the Bouncer's, can quote a reported DM, so a public reason could leak DM text.
  - Cost if wrong: the public no longer sees that someone's bot is muted.
- **R-11 (I-1). A 4001 close whose `/api/me` re-read fails reloads the page**, as `signOut()` does.
  - Why: no per-person state (DMs, placeholders, agent notices, relations) can then survive into the next person's session on a shared browser.
  - Cost if wrong: a reload instead of an in-place gate, including after a network blip at that moment.
- **R-12 (I-2). The conversation list skips released correspondents.**
  - Why: a released name can't be written to or read by handle, so its tab could be neither read nor closed. It would be a ghost, and a common one, since idle guests are released.
  - Cost if wrong: that history is no longer reachable from the tabs (it stays in the database).
- **R-13 (I-3). The Lobby count sums only visible conversations,** per spec §5.
  - Why: the spec says so. Otherwise a closed tab's unread count could never be cleared.
  - Cost if wrong: none.
- **R-14 (I-4). The Bouncer's judge is told a `dm:` line is private**: profanity is fine, harassment, threats and personal information are not. It is also told never to quote the reported line in its reason.
  - Why: it had been judging DMs by public-room standards.
  - Cost if wrong: prompt text only.
- **R-15. Five small final-review minors were folded into the fix wave.**
  - M-1: a moderator can't delete a `dm:` line nobody reported (`404 NO_MESSAGE`, like a missing id), and resolving a report with "delete" still works.
  - M-2: reading or closing an empty conversation creates no row.
  - M-4: the token field uses `autocomplete="one-time-code"`.
  - M-5: a suspended human can't link an agent (the guarded action is `profile`).
  - M-6: docs drift fixed.
  - Why: a few lines each, in files the wave touched.
  - Cost if wrong: a slightly larger wave.

- **R-16. After the final review, one more fix: a send clears the composer only if it still holds what was sent** (904d8de).
  - Why: the full e2e suite failed intermittently (2 runs in 3) on the first DM test. The trace showed the composer race. The next line was typed while the previous send was still in flight, then the finishing send's `draft = ''` wiped it and Send stayed disabled. A fast typist could hit the same thing.
  - The DM tests now also wait for a line to appear before typing the next. Afterwards the DM e2e file passed 18 of 18, and the full suite 41 of 41 twice.
  - Cost if wrong: nothing.

## Deferred findings

### Worth doing soon

- **Stale ownership in open pages (final review M-3).**
  - Presence and table snapshots keep an agent's old `ownerHandle` after a link, unlink or owner release, and nothing re-broadcasts the identity. Open pages show a stale "assistant of @x" (or none) until the agent's status changes or the page reloads.
  - If a released owner's handle is re-claimed, the wrong person could appear to own the bot.
  - Fix: emit `presence.changed` when `setOwner`/`forget` touches a present agent.
- **No global cap on house-bot DM replies (M-7).**
  - The caps are per person (3 an hour to an agent, 30 to a human), so many fresh guests or agents can drive OLD IRON's LLM spend.
  - A per-bot hourly ceiling is a small spec follow-up.
- **Link is check-then-write (Task 5).**
  - Two concurrent links with one leaked token, or a link racing its owner's release, could last-write or leave a stale owner.
  - Fix: a conditional `UPDATE … WHERE owner_id IS NULL OR owner_id = ?`.
- **At 400 px the corner notice card covers the chat composer while shown (Task 11 live check).** It can be dismissed. Revisit with the dock layout.

### Minor

- Task 1: `identity.test` round-trips a fake owner id; the real linking tests are Task 5's.
- Task 2:
  - If `dmHooks.stored` throws after the insert, `post()` rejects, and a retry would duplicate the message. Worth a transaction someday.
  - The unsorted-channel test pins pre-existing behaviour.
- Task 3:
  - `check()`'s `NO_USER` copy lacks the `@handle` (reachable only through the raw chat route).
  - `list()` summarises every row before cutting to 50 (fine at parlor scale).
  - `DmManager` import order in `core.ts`.
- Task 4:
  - No HTTP tests for `BLOCKED`, successful `?before` paging, or read/close on an unknown handle; the core tests cover the logic.
  - API.md doesn't say `@handle` is accepted.
- Task 5:
  - No test warms the auth cache before a link or release.
  - `agentByToken` duplicates `authenticateSession`'s agent query (plan-mandated).
- Task 6: no HTTP test that `NOT_LOCKED`/`HOUSE_AGENT`/`OWNED` refund the wrong-token budget, or of the per-IP pool.
- Task 7:
  - The Bouncer marks its hour before a (swallowed) failed send.
  - The reply maps are never pruned (bounded by accounts).
  - No bot-level tests of the human cap, the Bouncer's exclusions, or OLD IRON's DM transcript.
- Task 8:
  - A `dm.read` echo can wipe a DM that landed between the POST and the echo (narrow; the next read or reconnect heals it).
  - A tab closed on one device reaches the others only at their next load (brief-mandated).
- Task 9:
  - The e2e tests cover the lobby only: no table-page DM tab, message-menu "Message @x", bounce-back, blocked-disabled or `/msg` usage-error tests.
  - A disabled "Message @x" item bound as the first item can't take focus.
- Task 10:
  - `AgentList` rows are cramped at 400 px (put `.meta` on its own row).
  - `agentNoticeText` has no default branch.
  - An unlocked viewer who still owns agents sees no explanation.
  - `PersonMenu`'s `.owner` spacing relies on `.pop p` defaults.
- Final review M-8 (raw `@~id_…` on released DM tabs) is moot after R-12.

### Flakes seen during the build

- `tables.e2e.ts` "/invite from the lobby chat…": failed once in a full run, passed on rerun (known from M2b).
- One unidentified unit test in the "PGlite is closed" log noise: failed once in about 560, three times across the build. It never reproduced; M2b's list mentions similar. Worth a hunt when someone has an afternoon.

## The final review

The whole-branch review (Opus) judged the core sound:
- DM privacy (their own bus event, reads gated to the pair, no subscribe, removal pushed only to the two, reports only by the two);
- token handling (hashed only, `cs_` agents only, wrong tokens rate-limited);
- no bot loops;
- a clean release;
- a safe additive migration.

It found one Critical (C-1, public sanction reasons) and four Important issues (I-1 to I-4), all fixed in one wave (R-10 to R-15) with a test each. Verify was green after the wave: 568 unit, 41 e2e.
