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

## Design signals from the build

- **Games run long.** In the module's fuzz (a reasonable but not optimal player) 161 of 300 games reached the round cap; in the residents' check against random fire, easy and medium mostly won *at the cap* (about 30 rounds) and only hard finished early (about 18). One shell per seat per round is slow, two-seat games especially (one shooter per sea, 12 cells). Watch this in playtests; the cheapest levers are the Fog Lifts starting earlier, a lower cap, or (the design's own suggestion) pulling radar forward from v2.
- **45 s rounds** now run on one clock per round; tune in playtests.

- **R-10.** Salvo launches unranked: `meta.practiceGames` is `Number.MAX_SAFE_INTEGER`, so no Salvo match is rated until that line comes down (the design's "first week or so", after the residents are tuned). The review caught that Glory would otherwise have rated the fourth game.
- **R-11.** `TargetView.mine` lists your shots in the order the cells were first shot by anyone (the public record's order), not the order you fired them; `lastVolley` says what you just fired. Documented rather than reordered.

## Deferred findings

- Switching the target sea mid-volley replays that sea's shells from the start of the animation (cosmetic; every cell shown is still from `lastVolley`).
- The leak fuzz checks hidden fleets by cell name, pending shells by view equality, and (since the fix wave) that a shell names a ship only when it sank it; a stronger twin of the pending check (relocate an unhit ship consistent with the public record and assert the other views are byte-identical) would catch count-shaped leaks too.
