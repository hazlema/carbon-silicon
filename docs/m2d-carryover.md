# Carry-over from Milestone 2d ("Crowd")

This file records the rulings made while building M2d, what its reviews deferred, and what to watch. Read it before planning the public-rooms milestone. The earlier lists are in `docs/m3b-carryover.md` and its predecessors.

M2d grew group chats out of DMs, gave a group an owner who can remove and ban, made the chat line `#lobby` plus your conversations (`#critical-mass` is retired), and gave agents a front door: the page shell's `Link` header and `<noscript>` line point at `/llms.txt`.

## Rulings made while building

- **R-1.** `GroupManager` implements the `GroupHooks` `view` (and wires `setGroupHooks`) in Task 2, instead of the plan's `groupAccess` stop-gap. `check` refuses non-members and `stored` is a no-op until Task 3 completes them. One mechanism, not a throwaway. If wrong, Task 2 grew by one small hook object.
- **R-2.** Reports and deletion of a `grp:` line are report-only, like a DM. `reports.create` refuses a group line unless the reporter is a member who could see it (it came after they joined), and `moderation.deleteMessage` treats `grp:` like `dm:`. Spec §6 says moderators see a group only through a member's report. If wrong, Task 3 grew by two small guards and their tests.
- **R-3.** Task 3's hub `.catch` and its list/info robustness went into Task 4, the rule that a system line doesn't reopen a closed tab into Task 7, and the spec's `chat.group` row into Task 9. Each landed where its code was. If wrong, a little scope growth per task.
- **R-4.** The whole-handle mention regex is `@handle` followed by a lookahead `(?![A-Za-z0-9_-])`, built once, with a near-miss test, and the `bot.test.ts` check is scoped to the lobby channel. The plan's `\b` matched `@OLD_IRON-2` and never matched a handle ending in `-`; a bot answering someone else's mention is a real bug. If wrong, nothing is lost.
- **R-5.** The final fix wave also took the review's spec-gap minors (the report view's member list, Add someone in settings, "N of M"), not just the two Importants. They are spec §2, §4 and §6 items, and there was no second wave. If wrong, the wave was larger than it had to be.

## Deferred findings

### Minor

- Task 1 (diary and tabs):
  - `diary.ts` posts `#diary` (the dedupe record) before `#lobby`, so a lobby failure is never retried.
  - The layout e2e checks one row with 3 DMs but not the More ▾ fold or the table header.
  - The table page's `div.tabs` is `role=tablist` but now holds the DmTabs group (not `role=tab`), and its `overflow-x` may clip focus rings.
  - No RED run was captured.
- Task 2 (groups core):
  - `add()` counts then inserts without a transaction, so concurrent adds can overshoot the cap or hit a primary-key 500.
  - `clampGroupMax` warns "outside" for an in-range fractional value.
  - `info()` runs several queries per group, so `list()` is chatty.
  - The `NOT_OWNER` message is asserted only on remove (unban is code-only).
- Task 3 (delivery):
  - `chat.removed` goes to every current member (ids only, no text).
  - A member removed between `check` and the insert can land one last line.
  - `moderation.ts` hard-codes the `grp:` prefix; use `groupOf`.
  - The tests don't cover block (only ignore), system-line delivery to inboxes, the author's read-marking, or a removed member's socket in the hub.
- Task 4 (HTTP):
  - The HTTP tests check 401 only on `POST /api/groups`, and have no `NOT_OWNER` or read/close event tests.
- Task 5 (host with everyone):
  - A tiny await window between `host()` and `invite()` can fail the whole call on a state change, and `hostWith` duplicates `invite()`'s availability logic (a shared `whyUnavailable` would prevent drift).
  - `SLOW_DOWN` from the invite limiter closes the table with no partial invites.
- Task 6 (bots):
  - No test that a house bot's group line is ignored.
- Task 7 (web tabs):
  - `groups.test.ts` lacks "a system line keeps a closed group hidden" and convTabs-with-hidden cases, and the import order in the table page is off.
- Task 8 (web menus):
  - Two GameChoosers on the lobby page duplicate ids (`chooser-title`, `only-{id}`).
  - No unit tests for the `groupTitle` tie-break, the `#reloadGroup` race, Full, Too many, arrow keys, or the 400 px dialogs.
- Final fix wave:
  - The Bouncer's omission from the picker's suggestions has no test (the presence list in the e2e has no Bouncer handle to look for).
  - The report card's member list has a server test but no component test.

### Flaky tests seen

- `HANDLE_FILTERED`: a random test handle trips the profanity filter in a test's setup. It passes on rerun.
- `console.test`, "commands reach the console": failed once in Task 1's verify.
- The console "grant needs a locked human": failed once in Task 5.
- `e2e/accounts.e2e.ts:4`: failed twice on this branch (Tasks 8 and 9), unexplained, and passed on rerun.

## For the public-rooms milestone

- **The Visibility toggle.** A group is private by construction. Public rooms need a visibility flag on `chat_groups`, and a decision about who may read without joining (history from join point, or all of it).
- **Discovery.** How anyone finds a public room: a list, a search, or links. `GET /api/groups` lists only your own.
- **Does the Bouncer watch public rooms?** It is not in groups today (`HOUSE_AGENT`); it acts on reports. A public room may change that.
- **Room-name moderation.** Names pass the profanity and slur filters (`NAME_FILTERED`), but a public name is seen by strangers, so it may need reporting and a mod rename or takedown.
- **`GROUP_MAX_MEMBERS`.** The default of 8 suits conversations; public rooms need a separate, larger cap.
