# Salvo: Whisper — the 30-second ghost intel auction

2026-10-08 · agreed with the Foreman in chat · the third ghost trick (deferred from v3, `docs/superpowers/specs/2026-10-07-salvo-ghosts-design.md`)

## Why

Ghosts can mine and splash; the design always had a third trick where a ghost sells intel. The Foreman reshaped it: not a chat haggle but a **silent 30-second auction** among the living, where the owner of the scanned sea can bid to bury it, and the ghost may lie.

## Decisions (the Foreman, 2026-10-08)

- **The ghost may lie.** It scans for real, sees the true count privately, and tells the buyer whatever number it likes.
- **An auction, not a haggle.** Every living player may bid, the sea's owner included ("OLD_IRON bids on it so no one else will get it"). Abstaining is fine.
- **A real 30-second timer.** "30 second ghost intel auction"; best bid at 30 s wins.
- **Silent bids.** The panel shows who has bid, never how much.
- The listing names the sea's owner and the region.
- **Collusion** (a friend sinks a teammate to make a helpful ghost) can't be fully prevented in a free-for-all; the auction removes free intel, mines stay blind, and the sacrificed player places last. A moderation flag ("a human sunk almost entirely by one other human early in a ranked match") is noted for later, not built.

## The rules

### Listing

- `{"trick":"whisper","at":"east","cell":"c4"}` is a ghost's trick for the round: a 3×3 on a living sea, centre b2–g7 (as a sonar buoy). Legal while the ghost has no auction open and at least one other living seat besides the sea's owner exists or the owner itself can bid (i.e. any living seat; at least one bidder always exists).
- At the reveal: the ghost alone sees the **true** count of ship cells afloat in the 3×3 (real ships only; decoys and fog as for sonar). Everyone else sees the listing: `👻 {ghost} auctions a sonar reading on {east}'s sea, c3–e5 — 30 seconds.`
- The auction opens when the next round opens and closes **30 seconds** after it opens, or when that round resolves, whichever is first.

### Bidding

- Living seats bid with `{"bid": n}` (n ≥ 1, n ≤ your scrap): a sealed bid you may replace any time before the close; `{"bid": 0}` withdraws/abstains. Optional — a bid is never owed and never blocks your readiness.
- Public while open: for each living seat, `bid` / `abstained` / `—` (nothing yet). Never amounts.
- At the close: the highest bid wins; ties go to the earliest time that amount was placed. The winner's scrap moves to the ghost (the ghost's scrap is for show; it can't win). No bids → no sale.
- Told: `{north} wins {ghost}'s whisper for 4 scrap.` / `Nobody bids on {ghost}'s whisper.`

### The claim

- During the same 30 s the ghost sets the number it tells: `{"tell": n}`, 0–9, changeable until the close. If it never tells, the true count is told.
- The winner alone sees: `👻 {ghost} says 3 ship cells in c3–e5` — a marker on that area until the match ends (labelled as the ghost's word, not a reading).
- **At the end of the match** every whisper is told with the truth: `{ghost} told {north} 3 in {east}'s c3–e5. The truth was 1.` (or `…The truth was 3. An honest ghost!`).

### Limits

- One open auction per ghost; a ghost still owes its normal trick each round (the whisper *is* that round's trick when it lists one). Several ghosts may each run one.
- An auction whose sea goes out before it closes still closes (the reading is still worth something for the record); an auction whose ghost fades is cancelled (no sale, told).

## The engine: wake-ups

A small generic addition to `TurnRules`:
- `clock?(state, nowMs): S` — called by the engine after every accepted move and at every scheduled wake-up; returns the new state (stamping times, closing what's due). Must be deterministic in `nowMs`.
- `wakeAt?(state): number | null` — the next time (epoch ms) the game wants `clock` called; the engine schedules it (alongside the round deadline) and clears it on match end.

Salvo stamps an auction's `closesAt = now + 30 000` on the first `clock` after it opens and closes it on the first `clock` at or after `closesAt` (or at round resolution). Other games define neither and are untouched.

## Views

- Public: `auctions: { ghost, sea, centre, cells, closesAt | null, bids: Record<SeatId, 'bid' | 'abstained' | null> }[]` (open ones); `lastVolley`/summary tell listings, wins and ends.
- The ghost (owner of the auction): `myTricks.whisper: { truth, tell | null }`.
- A bidder: `myBids: Record<ghost, number>`.
- The winner: `whispers: { ghost, sea, cells, said }[]` (their bought words).
- Match over: every whisper with its truth.

## Residents

- **Bid** when the area is on a sea they're hunting and they don't know it (no sonar of their own there, few shots in it): value ≈ expected ship cells × their strength; bid a share of their scrap.
- **Bury**: when the scan sits over their own ships, bid high to keep it from rivals.
- **Ghost listing**: scan where the living are hunting. **Tell**: GAME_OVER lies often (a plausible wrong number), OLD IRON never lies ("A HOUSEHOLD NAME DOES NOT FIB"), Sprocket lies badly (off by a lot, or tells the truth by accident).
- Lines for listing, winning, burying and for a lie told at the end.

## The board

- **Auction panel** (`👻 30-second ghost intel auction`) when one is open: whose sea and which area (highlighted on the board), a countdown ring, every living player with `bid` / `abstained` / `—`, and for you: Bid +1 / +2 / +5 / custom, Withdraw, Abstain; your own bid shown to you.
- **Ghost controls**: a third trick, Whisper (pick an area on a living sea); during its auction the ghost sees the truth and sets the number it tells (0–9 stepper), with a live view of who has bid.
- **Bought whispers** marked on their areas: `👻 3?`.
- End of match: the whispers and the truth in the end panel.

## The rules guide

A "Whisper" part of the Ghosts section: listing, the silent 30-second auction, burying, the ghost's word vs the truth, how it's told; agents: commands, codes, view fields; the engine's wake-up noted for game authors (creating-a-game doc).

## Tests

- Engine: a test module with `clock`/`wakeAt` gets called after moves and at the wake time (fake timers), stops at match end; other games untouched.
- Module: listing legality; truth computed over real ships; open/close timing via `clock`; sealed bids (others' views show only status); replace/withdraw; ties by earliest; scrap transfer; no-bid; tell default; winner-only reading; end-of-match truth lines; ghost fades → cancelled; sea goes out → still closes; leak fuzz (amounts, truth, tell never reach anyone but their owners before the close/end).
- Residents: bids/bury choices legal; tells by character.
- e2e: a resident ghost lists a whisper; the human bids through the panel; the auction closes at 30 s (fake clock or real); the human sees the ghost's word.

## Out of scope

Chat haggling, open bids, the collusion flag, items for ghosts.
