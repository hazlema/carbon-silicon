# Salvo Whisper Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A ghost lists a sonar reading on a living sea; a silent 30-second auction among the living sells it; the ghost tells the winner any number it likes; the truth comes out at the end.

**Architecture:** Three small generic engine hooks (wake-ups via `clock`/`wakeAt`, `mayAct` for optional commands from seats that owe nothing, and story lines told from a wake-up), then the auction rules in the Salvo module, residents, the board, the guide and an e2e.

**Tech Stack:** Bun + TypeScript, `bun:test` (engine tests use the injectable clock / fake timers already used in `apps/server/src/core/games-simultaneous.test.ts`), Svelte 5, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-08-salvo-whisper-design.md` (read first).

## Global Constraints

- Auction length `AUCTION_MS = 30_000`; it opens with the round after the listing and closes at `closesAt` or when that round resolves, whichever first.
- Bids are sealed: other seats see only `'bid' | 'abstained' | null` per living seat, never amounts, until the close. `{bid: n}`, `1 ≤ n ≤ your scrap`; `{bid: 0}` = abstain/withdraw; replaceable until the close; ties → earliest time that amount was placed; the winner pays its bid to the ghost.
- The ghost's claim `{tell: n}`, `0 ≤ n ≤ 9`, changeable until the close; default = the true count. The truth (real ship cells only, as sonar) is the ghost's alone until the match ends.
- Copy: listing `👻 {ghost} auctions a sonar reading on {east}'s sea, c3–e5 — 30 seconds.`; win `{north} wins {ghost}'s whisper for 4 scrap.`; none `Nobody bids on {ghost}'s whisper.`; end `{ghost} told {north} 3 in {east}'s c3–e5. The truth was 1.` / `…The truth was 3. An honest ghost!`; winner's marker text `👻 {ghost} says 3`; panel title `👻 30-second ghost intel auction`.
- A bid or tell never makes a seat owe anything and never blocks readiness or round resolution.
- Engine hooks are optional; games that don't define them behave exactly as before.
- FOREGROUND test runs only; Playwright one file per command; `bun run build` before e2e.

## Review Focus

1. **An auction still open when the round resolves early** (everyone fired in 10 s) — it closes at resolution, winner decided from bids so far (Task 2 test).
2. **A bid after the close / a stale bid racing the close** — refused `AUCTION_CLOSED`, scrap never double-spent (Task 2 test).
3. **A bidder who spends scrap… scrap only moves at the close; a bid above current scrap at the close** (scrap can't fall in Salvo, but test the guard: a bid > scrap is refused at bid time) (Task 2).
4. **The server restarting the wake-up timer** — a wake-up scheduled, then the match ends or a move lands first: no stale timer fires on a finished match (Task 1 test).
5. **A spectator / another seat's view during the auction** never carries amounts, truth or tell (Task 3 fuzz).

---

### Task 1: Engine hooks — wake-ups, optional actors, told from a wake-up

**Files:** `packages/game-api/src/types.ts`, `apps/server/src/core/games.ts`, test in `apps/server/src/core/games-simultaneous.test.ts` (or a new `games-clock.test.ts`), `docs/creating-a-game.md` (a short section).

**Produces (TurnRules, all optional):**
```ts
/** Called with the current time after every accepted move and at every wake-up; deterministic in nowMs. */
clock?(state: S, nowMs: number): S;
/** When the game next wants `clock` called (epoch ms), or null. */
wakeAt?(state: S): number | null;
/** A seat that owes nothing may still send this kind of command now (e.g. a bid). Checked when toMove doesn't include the seat. */
mayAct?(state: S, seat: SeatId): boolean;
```
- `move()`: accept when `toMove` includes the seat **or** `mayAct?.(state, seat)`; misses/timeouts untouched for such moves (don't reset the miss count either — only owed moves do).
- After every accepted move (and after `onRoundTimeout`'s autopilot moves) and at each wake-up: if `clock` exists, `next = clock(state, now)`; if it changed, log story lines (`roundSummary?(before, after)`, the same system-line path used for round summaries) and `advance`.
- Scheduling: after every state change, compute `wakeAt?.(state)`; keep one wake timer per match (clear and reschedule); clear it on finish/abandon; a wake firing on a finished/abandoned match does nothing.
- Tests with a toy simultaneous module (like the existing `picks` fake): `clock` called after a move with `clock.now()`; a wake-up scheduled at `wakeAt` fires `clock` and advances the revision; story lines from a wake-up reach the table; `mayAct` lets a non-owing seat move without touching `toMove`/misses; a match ending clears the wake timer (advance the fake clock past it: nothing happens); Critical Mass/Lightline/C&S/Salvo-without-hooks unchanged (existing tests stay green).

- [ ] Write failing tests → implement → `cd apps/server && bun test` + root typecheck → commit `Engine: games may ask for wake-ups (clock/wakeAt), accept optional moves from seats that owe nothing (mayAct), and tell story lines from a wake-up`.

---

### Task 2: The whisper auction (module)

**Files:** `games/salvo/src/index.ts` (and a new `games/salvo/src/whisper.ts` for the auction helpers if index.ts grows past reason), `index.test.ts`, `ascii.ts`.

**Produces:**
- `{trick:'whisper', at, cell}` in a ghost's `trickLegal` (centres b2–g7 on living seas; only while the ghost has no open auction). Pending → at resolve: record `Auction { ghost, sea, centre, cells, truth, tell: number|null, opensRound: round+1, closesAt: null, bids: Record<SeatId, {n:number, at:number}|null>, abstained: SeatId[], state:'open' }`; the listing line in the round summary.
- `clock(state, now)`: for each open auction whose `opensRound === s.round` and `closesAt === null` → `closesAt = now + AUCTION_MS`; for each with `closesAt !== null && now >= closesAt` → close. Resolution also closes every auction whose round is resolving (before the round advances). `wakeAt` = min open `closesAt` (or null).
- `mayAct(state, seat)`: true when an auction is open and `seat` is living and not that auction's ghost (bid) or is the ghost of an open auction (tell).
- Commands: `{bid: n}` (`NO_AUCTION`, `AUCTION_CLOSED`, `BAD_BID` (n<0, non-integer, > scrap), `OWN_WHISPER` (the ghost bidding)); `{tell: n}` (`NOT_YOUR_AUCTION`, `BAD_TELL` (not 0–9)). Bid time `at` = a monotonically increasing counter in state (not wall time) so ties are deterministic.
- Close: winner = max n, ties by smallest `at`; scrap moves (winner −n, ghost +n); `whispers` for the winner `{ghost, sea, cells, said: tell ?? truth}`; summary lines (win / none); state 'sold' | 'unsold'; the ghost fading cancels its open auction (told `{ghost}'s whisper fades with them.`).
- Views: `auctions` (public, open: ghost, sea, centre, cells, closesAt, `bids: Record<seat,'bid'|'abstained'|null>`); `myBids` (own amounts); `myTricks.whisper` (the ghost's `{truth, tell}` for its open auction); `whispers` (winner's bought words); at match over every auction with its truth for the end lines. `legal` for a seat with `mayAct`: `{bid: n}` for n in 0..scrap (cap 20 entries: 0..min(scrap,20)) and/or `{tell: n}` 0–9 for the ghost; owed commands still come first.
- End lines in the final summary: `{ghost} told {north} 3 in {east}'s c3–e5. The truth was 1.` / honest variant.
- Tests: every rule above with exact codes and lines; the Review Focus 1–3 cases.

- [ ] TDD → `cd games/salvo && bun test`, root typecheck → commit `Salvo whisper: a ghost auctions a sonar reading; silent 30-second bids; the ghost tells what it likes; the truth at the end`.

---

### Task 3: Fuzz for the auction

**Files:** `games/salvo/src/fuzz.test.ts`.
- [ ] The fuzz drives `clock` with a fake `now` (advance a random 0–40 s between commands); ghosts list whispers sometimes; living seats bid/abstain/replace; ghosts tell. Invariants: no amounts, truth or tell in any other seat's view, `recent`/narrate/describe, or summary before the close (truth only after the match ends); scrap conservation (sum of scrap changes only by hits/sinkings + transfers net 0); one open auction per ghost; `wakeAt` equals the earliest open `closesAt`; legal×apply with bids/tells; order-free closes. Commit.

---

### Task 4: Residents bid, bury, list and tell

**Files:** `apps/bots/src/strategies/salvo.ts` (+ test), `bot.ts` (bids are optional: when `legal` holds bid entries and the resident hasn't bid on an open auction, it decides once per auction), `voice.ts`, `personality.ts`, `personalities/*.ts`.
- [ ] `chooseBid(view, legal, opts)`: value of the area = expected ship cells there on a sea it hunts (chances), minus what it already knows; bid `round(value × strengthFactor)` capped by a share of scrap; **bury** when the area covers its own ships (it knows its fleet): bid up to half its scrap; else abstain. GAME_OVER bids sharp, OLD IRON grudgingly, Sprocket impulsively.
- [ ] Ghost listing: a whisper on the sea the living hunt most, over the hottest unknown 3×3, ~25% of ghost rounds when legal. `chooseTell`: GAME_OVER lies often (±1–3, plausible), OLD IRON never, Sprocket lies badly (0 or 9) half the time.
- [ ] Moments + lines: `whisper` (I listed), `wonWhisper`, `buried` (I bought a reading on my own sea), `lied` (end of match: my lie told). Tests (choices legal; bury on own ships; tells by character). Commit.

---

### Task 5: The board — auction panel, ghost Whisper, markers

**Files:** `apps/web/src/lib/games/salvo/Board.svelte` (+ `+page.svelte` if the page must react to wake-up revisions — it already re-renders on every envelope).
- [ ] Auction panel (`data-testid="auction"`, title `👻 30-second ghost intel auction`): whose sea + area (highlight the 3×3 on that sea), countdown ring from `closesAt` (reuse CountdownRing), each living player with `bid` / `abstained` / `—`, your controls: Bid +1/+2/+5/custom (≤ scrap), Withdraw, Abstain (`auction-bid-<n>`, `auction-abstain`), your own bid shown; sends verbatim legal entries; several auctions stack.
- [ ] Ghost controls: a third trick button Whisper (`trick-whisper`) → pick a centre on a living sea (3×3 preview like the buoy); while its auction runs: the truth, a 0–9 stepper for the number it tells (`tell-<n>`), and who has bid.
- [ ] Bought whispers: a `👻 3?` marker on the area for the winner; end panel lists every whisper with the truth.
- [ ] check/build; screenshots (panel, ghost tell) described in the report. Commit.

---

### Task 6: Rules guide + game authors' doc

**Files:** `games/salvo/docs/rules.md`, `games/salvo/scripts/examples.ts`, `docs/creating-a-game.md`.
- [ ] Ghosts → Whisper: listing, the silent 30-second auction, burying, the ghost's word vs the truth, how it's told (lines verbatim from an engine-rendered example); agents: commands, codes, view fields, that bids are allowed while you owe nothing; creating-a-game: `clock`/`wakeAt`/`mayAct`. Commit.

---

### Task 7: End to end, verify, carry-over

**Files:** `e2e/salvo-whisper.e2e.ts` (new), `docs/salvo-carryover.md`.
- [ ] e2e (a human + scripted agents; one scripted agent sunk early → a ghost; the test drives the ghost via the API to list a whisper on another agent's sea): the human sees the auction panel, bids through it, other scripted seats see `bid` not the amount (API), the auction closes (wait up to ~35 s, or round resolution), the human sees `👻 … says N` on the area; the table hears the win line.
- [ ] Build; the new e2e 3×; salvo, salvo-endings, salvo-arsenal e2e; root typecheck + bun test; full Playwright once (known flakes re-run alone).
- [ ] Carry-over `## Whisper (2026-10-08)` from the next R- number: the auction rules, silent bids, the ghost may lie, the truth at the end, engine hooks, collusion noted (moderation flag not built). Commit.
