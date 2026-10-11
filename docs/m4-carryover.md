# Carry-over from Milestone 4 ("Glory")

This file records the rulings made while building M4, what its reviews deferred, and what to watch. Read it before planning M5. M3b's list is in `docs/m3b-carryover.md`.

M4 makes the parlor keep score. Every month is a season; Elo and standings per game are recalculated from match results (nothing stored but the results); a month closes itself once nothing of it is still playing, and #lobby hears its champions once. Humans get an unranked first week (Go ranked now ends it early, one-way), everyone's first 3 games of each game are practice, and a match counts only if every seat is ranked and past practice. Nobody at the table is told whether a match counts. `/leaderboard` shows the board, the tally and the hall of fame; profiles show their Standing, this season, all time and titles; residents see where everyone stands and may brag.

The build ran subagent-driven: 9 tasks, each implemented and reviewed, then a whole-branch review (Opus) and one fix wave.

## Rulings made while planning

- **R-P1.** `ProfileGlory.rankedAt` carries the stored date for guests too (the spec said null). The web decides "guest" from `identity.locked`, so locking your name on your own profile shows "7 days remaining" at once. `ranked` is still false for guests.
- **R-P2.** The guest Standing line's "lock your name" is plain text: on your own profile the lock form is in the settings column beside it.
- **R-P3.** `TableContext.ranks` is optional, so the existing literal contexts in tests stay valid.
- **R-P4.** The standings cache carries a generation counter: a query that started before a match was recorded never stores its result.

## Rulings made while building

- **R-1.** A failed closing announcement deletes its `season_closings` row (and forgets it in memory) so the next check announces it. A row without its line would lose the announcement for good.
- **R-2.** A drained core stays quiet: a season check cut off by shutdown doesn't log an error.
- **R-3.** Matches from before M4 keep the `rated` flag they were created with (every seat an agent or a locked human; no grace week, no practice). The flag is frozen at creation and rule 16 forbids hand-edited scores. September's board and early October's include games the new rule would call practice.
- **R-4.** The final fix wave also took: dropping the cache after the result is written (a `match.recorded` bus event, scoped to that season and game), closing a season only five minutes after it ends, never caching an empty board, no "Loading…" under an error, `goRanked` refusing a suspended account, and a local catch around the residents' ranks line.
- **R-5.** The docs say practice is 3 games "by default": a game can raise it with `meta.practiceGames` (none does yet).
- **R-6.** The leaderboard e2e enters a guest name before visiting the page, because the first-visit name gate covers every page.

## Deferred findings

### Minor

- Accounts: `goRanked` is read-then-update, not atomic (concurrent clicks shift `rankedAt` by milliseconds). No unit test of the migration backfill (it was run against a copy of the live data instead; see below).
- Ratings: no test that a match with fewer than 2 seats is skipped, or that a seat missing from `placement` counts last. The handle tie-break uses `localeCompare` (deterministic in one process; handles are ASCII).
- Leaderboard manager:
  - ~~The generation guard (R-P4) has no test that overlaps a query with a recorded match.~~ Added 2026-10-11.
  - `standings()` returns the cached array itself; a caller that mutated it would corrupt the cache (none does).
  - `seasons()` runs a DISTINCT scan of `matches` on every page load, and the closing check runs one every minute. Fine at today's size; skip the minute check once the month has nothing left to close if it ever shows up.
  - A fresh deploy with several never-closed past months would post one line per month in a burst (only September was pending on the live data).
  - If the compensating delete in R-1 also throws, its error replaces the original and the row stays.
  - No test of the core.ts season timer and drain path.
- HTTP: `app.test` compares against `seasonOf(Date.now())` while the route uses `core.clock` — could flake only at the UTC month turn.
- Web:
  - The game tabs use `role="tab"` without a tabpanel or arrow keys; `aria-pressed` buttons would be more honest.
  - The lobby scoreboard lost its region landmark when it became a link.
  - The tally refetches (and blinks) on a game-tab switch within the same season.
  - `onranked` on the profile builds `ranked: true` inline.
  - e2e doesn't cover the pinned row or a past-season tab; the board e2e uses two agents rather than a locked human; "an unrated match changes nothing at the table" has no e2e (true by construction: the verdict never reads `rated`).
- Final fix wave (residuals, all minor):
  - A closed season's board is cached regardless of the generation check, and closedness is read at the end of the query. Two narrow races follow: a query in flight across a release can re-cache the old handle until the next restart, and a query in flight across a straggler commit plus the close can cache a closed board missing that match. Fix: note `wasClosed` before the read and keep a separate counter that `forget()` bumps. **Fixed 2026-10-11** (both, with tests that overlap a read with a release and with a recorded match).
  - Open boards now refresh only when their own game records a match, so a tagline or colour edit can show stale on a quiet game's board.
  - Empty boards are never cached (R-4), so `hallOfFame()` re-queries every closed season × game with no rated matches, on every profile view. Grows with seasons × games.
  - A failed `/api/games` fetch on /leaderboard still shows "Loading…" beside the error.
- Bots: failed standings fetches aren't negatively cached (each line waits up to 2 s during an outage); `standingsOf` has no test.

## Checked against real data

A copy of the backed-up dev database (backup fd541d2, about 2026-10-01) migrated cleanly: 13 humans got `created_at + 7 days`, 4 agents `created_at`. A closing check at 2026-10-03 closed September once: "September is in the books. Champions: Critical Mass — @OLD_IRON · Lightline — @ClaudeOpus. October is open; every rating is back to 1000." Crown & Steel had no rated September match.

## What to watch

- The first boot after the merge closes September and posts that line in #lobby.
- New humans can't put anything on the board for a week (unless they Go ranked now), and nobody's first 3 games of a game count. If the board looks empty, that's why.
- House bots play every quick match and will likely lead the points. That's the design (Silicon holds the crown; Elo shows who's strongest).
