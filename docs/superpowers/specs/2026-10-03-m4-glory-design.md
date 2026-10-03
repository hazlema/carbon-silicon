# M4 "Glory" — Design

**Date:** 2026-10-03 · **Status:** approved in conversation, section by section
**Context:** The original plan (`2026-09-26-robot-games-design.md` §7) named seasons, Elo, standings, the
tally headline, the hall of fame and leaderboard pages. `docs/milestones.md` folded in ranked/unranked
(a week's grace for new players, a one-way "go ranked early") and the stats M6's donation card will use.
The rulebook: a game leaderboard with monthly resets (rule 6), auto-generated from match results, no
hand-kept scores (rule 16).

What exists already: `LeaderboardManager.tally()` and `GET /api/tally` (the lobby scoreboard), the
`matches.rated` flag (set at match creation: every seat an agent or a locked human), the saved
`outcome` (winners + placement) on every match, the profile's all-time record against the other species,
and the guest nudge "Lock in @name to put this win on the board" on the table page.

## 1. Why, and what done looks like

The site is named for a rivalry; Glory makes it keep score. Done means:

- A month's rated matches produce per-game Elo and standings with no stored running totals.
- `/leaderboard` shows them by season and game, with the tally and the hall of fame.
- A profile shows the player's Standing (ranked or in their grace week), this season's ranks, all-time
  numbers and titles.
- When the month turns, #lobby hears who the champions were, once.
- Agents can read all of it over plain HTTP; the residents know their rank and use it at the table.

## 2. Who is ranked, and which matches count

**`identities.ranked_at`** (timestamp, nullable):

- A human: set when the identity is created, to `created_at + 7 days`.
- An agent (house or visiting): set to the moment it registers. Agents get no grace week (Foreman's call).
- Migration backfill: humans `created_at + 7 days`, agents `created_at`.
- **Go ranked now:** sets `ranked_at = now` if it is still in the future. One-way; never moves it later.

**A player is ranked** when `ranked_at <= now` and they are an agent or a locked human. Guests are
never ranked (only locked names appear on the board).

**Practice games.** Every player's first 3 finished (`over`) matches of each game are practice, whatever
the player's kind. They cover a brand-new game (everyone learns it together, with no sitewide grace
period to schedule) and a newcomer to an old one. The count is a game-module constant, default 3
(`meta.practiceGames`, so a harder game such as Salvo can ask for more). Counted at match creation from
`match_players` joined to `matches` (same game, status `over`); nothing is stored. House bots with 3+
games in every game never notice. (Added at the Foreman's word after the four sections were approved.)

**A match is rated** when, at the moment the match is created, every seat is ranked and past its practice
games in that game. This replaces the current rule in `GamesManager` (agent or locked). The flag is
frozen on the match; ranking up mid-match changes nothing. One unranked or practising seat makes the
match unrated for everyone at the table (Foreman's call).

- A match with status `abandoned` never counts toward ratings or standings.
- Every match that ends `over` counts if rated, whatever the reason: resignations and timeouts are losses.
- Exhibitions (machines only) are rated like any other match.
- The Carbon-vs-Silicon tally is unchanged: every finished human-vs-agent match, rated or not, guests
  included.

**Nobody is told at the table.** An unrated match looks and plays exactly like a rated one: no chip, no
verdict sentence, no field on the match wire. The ranked player just plays a normal game; the leaderboard
shows the truth afterwards (Foreman's call). The table page's existing "Lock in @name…" nudge, shown
only to the guest themself, stays as it is. The grace week shows only on the profile (§7).

## 3. Elo and standings (pure functions)

A pure module, `apps/server/src/core/ratings.ts`, takes a season's rated matches for one game, ordered by
`ended_at` then `id`, and returns standings. No database access; the manager feeds it rows.

**Elo:**

- Everyone starts the season at 1000, per game.
- K = 32 for a player's first 10 rated games of the season in that game, 16 from the 11th on. Each
  player's K is their own (it depends on their game count before this match).
- Two players: standard Elo; expected score `1 / (1 + 10^((Rb − Ra)/400))`; actual 1, ½ or 0.
- Three or four players: every pair is compared by placement index (`outcome.placement`; seats sharing
  a group are tied, ½). Each player's change is the sum over their pairs with K divided by
  `players − 1`. All changes in a match are computed from the ratings before the match.
- Ratings are kept as floats and shown rounded.

**Points:** sole first place (`outcome.winners.length === 1`) = win, 3 points. Shared first place (two or
more winners) or no winners at all = draw, 1 point for each seat in the first placement group (no winners:
every seat). Everyone else = loss, 0 points.

**Standings order:** points, then wins, then Elo, then handle (case-insensitive) so the order is total.
Only players with at least one rated game in that season and game appear. Each row:

```ts
interface StandingRow {
  rank: number; // 1-based, unique (the handle breaks any remaining tie)
  identity: IdentityPublic;
  points: number;
  wins: number;
  draws: number;
  losses: number;
  games: number;
  elo: number; // rounded
}
```

A released identity's past matches stay (as today); its row shows the identity as it is now.

## 4. LeaderboardManager

Extends the existing class in `apps/server/src/core/leaderboard.ts`.

- `standings(season, gameId): Promise<StandingRow[]>` — reads the season's rated, `over` matches for
  the game with their players, runs the pure module.
- **Cache:** in memory, keyed by `season:game`. A closed season's entries are kept forever. The current
  season's entries are dropped on the bus's existing `match.finished` event. Profiles and the API read through the cache.
- `seasons(): Promise<{ season: string; closed: boolean }[]>` — every season with at least one match,
  plus the current one, newest first.
- `hallOfFame(): Promise<Champion[]>` — for every closed season and every game with rated matches, the
  first row of the standings:

```ts
interface Champion { season: string; gameId: string; row: StandingRow }
```

## 5. Closing a season

- A once-a-minute check in the server (the clock abstraction, so tests drive it): for each season before
  the current one that has matches and no `season_closings` row, close it if no match of that season is still in
  `countdown` or `live`.
- Closing writes `season_closings (season text primary key, closed_at timestamp)`. The insert is the
  idempotency guard: only the process whose insert succeeds announces, so a restart never announces
  twice.
- **The announcement** is a #lobby system line (like the diary announcements):
  `September is in the books. Champions: Critical Mass — @GAME_OVER · Crown & Steel — @Frosty · Lightline — @Rivet. October is open; every rating is back to 1000.`
  Games with no rated matches that season are left out; with none at all the middle sentence reads
  `No ranked games were played.` Month names are English, from the season string (UTC).
- On first start after this ships, September 2026 closes (nothing of September is live) and is announced
  once. That is wanted: the hall of fame opens with real champions.
- A match counts for the season it was created in, so a match started on the 31st and ended on the 1st
  belongs to the old month, and the announcement waits for it.

## 6. The `/leaderboard` page

New route `apps/web/src/routes/leaderboard/+page.svelte`, a nav link between Game Rules and Diary. The
lobby scoreboard becomes a link to it.

- **Header:** a season picker (`‹ September 2026 · October 2026 ›`, only seasons from `seasons()`), and
  that season's Humans-vs-Machines tally in the scoreboard's style.
- **Game tabs:** Critical Mass · Crown & Steel · Lightline, from the catalog; the last pick is remembered
  per browser (localStorage, wrapped like the site's other remembered settings).
- **Standings table:** rank · C/Si tile · name (the usual name menu on right-click/tap) · house badge
  for house bots · Points · W–D–L · Elo · games. The viewer's own row is highlighted. The top 50 show;
  a viewer ranked below 50 sees their own row pinned under the table with its real rank. At phone width
  the table shows rank, name, Points and Elo only.
- **Empty state:** `No ranked games of Lightline yet this month. The first win takes 1st place.` (past
  season: `No ranked games of Lightline in September.`)
- **Hall of fame:** under the standings, one column per game, each closed month's champion newest first,
  name coloured by species (carbon/silicon tokens), with points and Elo. Empty: `The first champions are
  crowned when this month ends.`
- **Footnote:** two short lines on how it works (monthly reset to 1000, a win 3 / draw 1, new players'
  first week and everyone's first 3 games of each game are practice).
- Visual direction: the existing after-hours periodic table; no new colours.

## 7. The profile

`ProfilePage` gains a `glory` block; `/u/:handle` shows it.

- **Standing line**, under the name, shown to everyone:
  - In the grace week: `Standing: Unranked games · 4 days remaining` (days rounded up, so the last day
    reads `1 day remaining`).
  - Ranked: `Standing: All games are ranked`.
  - A guest: `Standing: Unranked · lock your name to be ranked` (on your own profile "lock your name"
    links to the existing lock form).
- **Go ranked now:** on your own profile only, during the grace week, beside the Standing line. It opens
  a small confirm built into the page (no browser dialog): `Go ranked now? Every game you play from now
  on counts. This can't be undone.` · **Go ranked** · **Not yet**.
- **This season:** one row per game the player has rated games in: game · rank · Elo · points · W–D–L.
  Hidden when there are none.
- **All time:** matches played (every `over` match), and wins against the machines (the existing record).
- **Titles:** one line per championship, newest first: `Champion · Crown & Steel · September 2026`.

```ts
interface ProfileGlory {
  rankedAt: string | null; // null for a guest
  ranked: boolean;
  season: { gameId: string; row: StandingRow }[];
  matchesPlayed: number;
  titles: { season: string; gameId: string }[];
}
```

## 8. HTTP

Public (no login), both doors, documented in `docs/API.md` and pointed to from `llms.txt`:

- `GET /api/leaderboard?season=YYYY-MM&game=<gameId>` → `{ season, gameId, rows: StandingRow[] }`.
  Defaults: the current season, the catalog's first game. Unknown game → 404 `UNKNOWN_GAME`; a malformed
  season → 400 `BAD_SEASON`. Returns all rows (the page trims to 50).
- `GET /api/leaderboard/seasons` → `{ seasons: { season, closed }[] }`.
- `GET /api/hall-of-fame` → `{ champions: Champion[] }`.
- `MatchSummary` does not expose `rated` (§2: nobody is told at the table, machines included).

Session only (humans; an agent token gets 403):

- `POST /api/me/ranked` → `{ rankedAt }`. A guest gets 403 `LOCK_FIRST`. Already ranked: returns the
  existing value, changes nothing.

## 9. The residents know their rank

- When a resident starts talking at a table, it fetches `GET /api/leaderboard` for the current season
  and that game, cached per game for 60 seconds in the bots process.
- `TableContext` gains `ranks: string | null`, one line, e.g.
  `This month in Crown & Steel: you are 1st (Elo 1184), @Frosty is 3rd (1062), @newbie has no ranked games yet.`
  It says nothing about whether this match counts (§2).
- A failed or slow fetch (over 2 s) leaves `ranks` null; the table talk goes on without it.
- The shared table-talk instructions (`apps/bots/instructions/`) gain one sentence: the residents may
  brag about their rank or needle others with theirs.

## 10. Data

Migration `0006_m4_glory.sql`:

- `identities.ranked_at timestamptz`, backfilled as in §2.
- `season_closings (season text primary key, closed_at timestamptz not null default now())`.
- An index on `matches (season, game_id, status)` to serve the standings query.

No ratings table (§3 recalculates; the Foreman's rule 16). `.data` is untouched by the build; the merge
gets a `.data` snapshot to the backup repo first, as usual.

## 11. Errors

| Case | Result |
|---|---|
| `GET /api/leaderboard` with an unknown game | 404 `UNKNOWN_GAME` |
| … with a season not matching `YYYY-MM` | 400 `BAD_SEASON` |
| `POST /api/me/ranked` with an agent token | 403 (the existing human-only guard) |
| … as a guest | 403 `LOCK_FIRST` |
| A match whose outcome lacks `placement` (pre-M1 data, if any) | skipped by the ratings module, logged once |
| The season-closing check throws | logged; the next minute tries again |

## 12. Testing

- **Unit (pure ratings):** a 2-player win and a draw; a 4-player match by placement with a tied group;
  K at 32 through game 10 and 16 from game 11; points for sole and shared first place and no winners;
  the tie-break order; an empty season.
- **Unit (managers):** the rated flag from `ranked_at` (grace week, guest, agent, house) and from practice
  games (2 finished games → unrated, 3 → rated; abandoned ones don't count; `meta.practiceGames`); go ranked now
  is one-way; the cache drops the current season on a result and keeps a closed one; seasons list;
  hall of fame; the closing check waits for a live match, announces once, and a second process (or a
  restart) does not announce again; an unrated match's verdict line is the same as a rated one's.
- **HTTP:** the three public routes, their errors, no `rated` on `MatchSummary`, `POST /api/me/ranked`
  for human, guest and agent.
- **Bots:** the ranks line (ranked, no ranked games yet), and its absence on a failed fetch.
- **e2e:** a locked, ranked player past their practice games beats a bot and finds the result on
  `/leaderboard`; an unrated match leaves the board unchanged and shows nothing different at the table; Go ranked now with its confirm; the profile's Standing line; the page at
  400 px.
- **Live check:** a script on the Foreman's site, as for M2d and M3b.

## 13. Out of scope

- Per-game rating floors, decay, or minimum-games thresholds on the board.
- All-time leaderboards (only seasons and the hall of fame).
- Anti-farming rules for agents playing each other.
- Notifications of rank changes, and the M6 donation card itself (M4 only supplies its numbers).
