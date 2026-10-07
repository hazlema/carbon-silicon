# Carry-over from Salvo v1

This file records the rulings made while building Salvo's first cut, what waits on the engine, and what the reviews deferred. The design is `docs/ideas/Salvo — game design.md`; the engine changes it needs are `docs/ideas/Salvo — engine changes.md`; the plan was `docs/superpowers/plans/2026-10-05-salvo-v1.md`.

Salvo v1 is the design doc's first cut: four hidden 8×8 seas, deployment, one shell per seat per round, simultaneous resolution, Time on Target, the Fog Lifts, scrap and the one-winner tiebreak, the three heatmap residents, a click-to-fire board with incoming fire, and a rules guide whose diagrams are rendered by the engine. It was built against the engine as it is today, without touching `games.ts`: the module declares `simultaneous: true`, `round()` and `roundSummary()` through its own extended type, and keeps every narration safe on its own.

The build ran subagent-driven in `.worktrees/salvo`: the module (Opus), then the rules guide, the residents and the board in parallel worktrees, a final review and one fix wave.

## The engine (landed 2026-10-06)

The engine's `simultaneous` mode is on main (`docs/ideas/Salvo — engine changes.md`, items 1 to 6), and Salvo now uses `@cs/game-api`'s own `TurnRules` instead of its stopgap type. One deadline per round; any revision since the round opened is accepted; a timeout autopilots every seat still owing until it owes nothing (a whole fleet in deployment), then the round resolves once; commits log "is ready" and `roundSummary()` tells the round in the move log with no seat; the autopilot's table line names no move. `stillSeated()` exists for v3's wreck ghosts; Salvo doesn't declare it yet.

## Rulings made while planning

- **R-P1.** A ship's `facing` is `east` or `north` only; `at` is its first cell. Two facings enumerate every hull once, so deployment's `legal` stays under about 450 entries (385 on an empty sea).
- **R-P2.** `describe()` returns "fires" / "deploys a ship" / "deploys the fleet"; `narrate()` returns "is ready" / "deploys a ship" / "deploys the fleet"; the round is told by `roundSummary()`. Nothing names a cell, sea or ship before resolution.
- **R-P3.** Cells you have already fired at leave your `legal` for that sea; a cell someone else already hit stays legal and lands as a `hit` with no new scrap — the way two seats can aim a Time on Target at a known hit to blast its neighbours.
- **R-P4.** An eliminated seat is `isOut` (released by today's engine); its sea is no longer a target.
- **R-P5.** A forfeit eliminates the seat with the forfeit reason; its fleet stays as a wreck; if every other living seat was ready, the round resolves at once.
- **R-P6.** `turnSeconds` is 45 for deployment and for rounds (to tune).
- **R-P7.** The half-scrap elimination bonus goes to every seat credited with sinking one of the victim's ships in that volley (the code is a little wider than the design's "the last ship": in one volley several ships can go down at once, and all their sinkers share the credit).
- **R-P8.** The board is a CSS grid of real buttons on a tilted slab (fixed isometric tilt with a Top toggle; no drag-to-swivel), so keyboards, screen readers and tests work without canvas hit-testing.
- **R-P9.** Key art: `hero.jpg` and `thumbnail.jpg` were generated on OpenArt (rule 17) by the Proprietor.

## Rulings made while building

- **R-1.** Random deployment picks each ship uniformly from the placements that fit, with `createRng((seed + draws * 7919) >>> 0)`; deterministic, never retries.
- **R-2.** `ShellResult.ship` is named only when that shell sank the ship; naming it on a plain hit would give away its length.
- **R-3.** A shell's `result` describes its own cell: a blast centred on open water reads `miss` with `blast: true`; the blast record carries the nine cells and the new hits.
- **R-4.** Blast cells are recorded in `shots` for every shooter in the blast, so they leave those shooters' `legal` and appear in their `mine`.
- **R-5.** Hit credit goes to every seat that covered the cell this volley (shell or blast); `sunk.by` is the seats that landed new hits on that ship; the knockout bonus is computed from scrap before any bonus is paid, so mutual knockouts don't depend on order.
- **R-6.** A tiebreak winner is taken back out of `eliminated`; seats knocked out in the same round share a place; at the round cap, survivors who didn't win share second.
- **R-7.** `ready` covers deployment too (seats whose fleet is fully down), so the board can show who it is waiting for.
- **R-8.** Residents: sinking chatter reuses the `bigCascade` line kind ("I sank a ship"); the LLM voice prompts read "A shell just hit your fleet" / "Your shell just sank a ship" at a Salvo table (`voice.ts`). The heatmap weights a placement ×3 per known ship cell it covers; fog-revealed unshot ship cells rank above every guess. Easy skips cells anyone already shot. Medium picks its sea first (grudge, else most hits), then chases in line with an unsunk hit, then parity.
- **R-9.** Two-player same-volley knockouts always reach the coin flip (scrap and hits are necessarily equal); documented in the guide's surprises.

## The 6a board (2026-10-06)

The Foreman's Claude Design mock `docs/mock/Salvo Redesign.html`, option 6a, replaced the compass layout:

- **R-12.** The target sea takes the stage and swivels (drag, ⟲/⟳ 90°, Iso, Top) the way Critical Mass does; with the compass gone, nothing on screen depends on which way the sea faces, which is what R-P8 was protecting. Phones still open flat (Top).
- **R-13.** A 290 px column: an opponents list (mini-map of the public record, afloat · scrap, a TARGET badge, locked in / aiming / sunk), then your fleet as a flat chart with a legend, then one control that says what you're doing ("Pick a cell to fire" → "Fire at c3" → "Locked in at c3. Waiting on …").
- **R-14.** People are drawn in identity colours, not seat colours: names, shells and the aim are orange for carbon and cyan for silicon. Ships are white hulls; a hit is an orange peg on the target sea and a cyan peg on your own fleet; a miss is a ripple. The table's seat colours are no longer used by the board.
- **R-15.** The mock's 10×10 grid stays 8×8. The small "your shot" dot on the target sea is gone (the mini-map and the disabled cells already say it). The status line reads "Round 5 — your shot. Everyone else is locked in."
- **R-16.** Pegs live in their own layer over the cells, as sized billboards (Critical Mass's orb pattern). Inside a cell's button, or as a zero-size billboard, Chrome clipped them at any tilt.

## v1.5 Intel (2026-10-06)

- **R-17.** The Fog Lifts from round 6 (was 10) and shows a count per row (`TargetView.lifted: {row, afloat}`), never cells. The count is live: it falls as hits land, which says nothing the public hits don't.
- **R-18.** The sonar buoy is `{"fire":"buoy",…}`, not a new verb, so v2's fire-step items (cluster, torpedo, depth charge) slot in the same way. Centre b2–g7 so the square is always nine cells; once per centre per sea per seat.
- **R-19.** A buoy listens after the volley's shells land, and its reading is computed live in the view (`TargetView.sonar`, the dropper's alone). Stored is only where and when (`SalvoState.sonar`).
- **R-20.** Where a buoy fell is public (`Volley.buoys`, a round-summary line); the count is private. Being scanned is part of the drama, and the cell gives nothing away about the target's ships.
- **R-21.** The autopilot picks any legal command, so an absent seat sometimes drops a buoy; the rules say so.

## v1.6 Salvos (2026-10-06)

- **R-22.** One shot per ship afloat, each a separate `{"fire":…}` command; `pending` is a list per seat; ready when the list is as long as the seat's guns. Guns are counted from ships not sunk, so a sinking takes effect from the next round.
- **R-23.** One buoy a round (`ONE_BUOY`); a seat can't aim two of its own shells at one cell in a round (`ALREADY_AIMED`), so a Time on Target is always two or more players.
- **R-24.** A seat sees its own queued shots this round (`view.myOrders`) so a reload mid-salvo shows what's in; nobody else does. `view.guns` is public (it follows from public sinkings).
- **R-25.** The round summary names hits and sinkings and counts misses ("… and 13 misses."), since a four-seat round fires up to sixteen shells.
- **R-26.** The guide's worked game keeps its story shots; the script tops each salvo up with shots into open water away from every story cell, so the narrated hits, the Time on Target, the buoy and the fog land as told.

## Residents read the odds (2026-10-06)

- **R-27.** The Foreman found the residents easy (he won 5 of 6) and noticed they ignored him: over a 14-round game his sea took 16 shots, theirs about 50 each. Hard aimed at the fleet closest to sinking and medium at its grudge, so once the residents had hurt each other they stayed on each other. Now medium and hard rank every legal shell on every sea by the chance of a ship there (`chances`: the heatmap scaled so a sea's cells sum to its ship cells afloat, sure cells 1), so a hit or a dense fog row anywhere draws fire. Hard takes the best; medium picks among cells within 80% of its best (at 60% it wandered two cells off a lone hit). Simulated, a sharp player against GAME_OVER, OLD IRON and Sprocket wins 32% (was 51%) and takes 65 shots a game (was 48, the least at the table); new medium beats old medium 163–37.

## Endings and defeated seas (2026-10-06)

- **R-28.** A fleet that's out stays in every view (`TargetView.out`), so a sea you're looking at never vanishes when it sinks; the board stamps it DEFEATED (a red angled SVG) once the volley that sank it has landed. It's no longer a target (legal never names it).
- **R-29.** The verdict waits for the last volley: the board reports `settling` while a volley plays and the table page holds the end-of-match panel and the status verdict ("The last volley is landing…"); the winner label, the revealed fleets and the DEFEATED stamp wait too. The server's GG line in chat still lands at once.
- **R-30.** (2026-10-07) The sea on view counts as picked even when the board chose it, so a fleet that sinks while you watch it stays the big sea for its stamp (before, the default slid to the next living sea and the stamp never showed mid-match). You leave it by picking another card; while it's on view the fire control says "That fleet is sunk: pick a living sea".
- **R-31.** (banner superseded by R-39: the ghost card) (2026-10-07) Your own sinking is told once its volley has landed: a hot banner ("Your fleet is sunk — you're out. The others play on.", 6 s, in place of the next round's call), a red SUNK stamp on your fleet with its count reading "sunk", and the status line "Your fleet is sunk." with who the round waits on. Covered by e2e/salvo-endings.e2e.ts (four seats, scripted agents).

## Ghosts (2026-10-07)

- **R-32.** Only a sinking makes a ghost.
- **R-33.** Mines are blind: one may sit on a ship (the reveal says Backfire!), and two ghosts may share a cell.
- **R-34.** A mine on a cell that was spent without a direct shot fizzles untold.
- **R-35.** Splashes on show at a match's end are told in the final volley; a forfeit ending clears them.
- **R-36.** A false splash doesn't change the fog or sonar counts (a detectable bluff).
- **R-37.** A ghost with no legal trick sits out.
- **R-38.** The boomerang names the cell, never the ship.
- **R-39.** The ghost card replaces R-31's banner and opens after the volley's trick banners.
- **R-40.** Resident ghosts mine where the living will shoot but ships are unlikely (sim: median 12 rounds, 0% at the cap).

## Design signals from the build

- **Games run long.** In the module's fuzz (a reasonable but not optimal player) 161 of 300 games reached the round cap; in the residents' check against random fire, easy and medium mostly won *at the cap* (about 30 rounds) and only hard finished early (about 18). One shell per seat per round is slow, two-seat games especially (one shooter per sea, 12 cells). Watch this in playtests; the cheapest levers are the Fog Lifts starting earlier, a lower cap, or (the design's own suggestion) pulling radar forward from v2.
- **45 s rounds** now run on one clock per round; tune in playtests.

- **R-10.** Salvo launches unranked: `meta.practiceGames` is `Number.MAX_SAFE_INTEGER`, so no Salvo match is rated until that line comes down (the design's "first week or so", after the residents are tuned). The review caught that Glory would otherwise have rated the fourth game.
- **R-11.** `TargetView.mine` lists your shots in the order the cells were first shot by anyone (the public record's order), not the order you fired them; `lastVolley` says what you just fired. Documented rather than reordered.

## Deferred findings

- e2e: under the full suite (not alone), the Salvo test now and then times out at the shared host → Start → `/t/` step, with the page showing a Critical Mass table from an earlier phone test's player. Same family as the lobby:95 / pocket:62 / update:4 flakes: state leaking between tests in the host flow, not Salvo play.
- Residents think once per salvo: follow-up shots in a round wait 250–600 ms, not the full think time (bot.ts).

- Switching the target sea mid-volley replays that sea's shells from the start of the animation (cosmetic; every cell shown is still from `lastVolley`).
- The leak fuzz checks hidden fleets by cell name, pending shells by view equality, and (since the fix wave) that a shell names a ship only when it sank it; a stronger twin of the pending check (relocate an unhit ship consistent with the public record and assert the other views are byte-identical) would catch count-shaped leaks too.
