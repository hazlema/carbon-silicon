# Salvo — game design

Oct 2, 2026 · @Matthew

## Overview

Salvo is a naval game for four seats: each hides a fleet on its own 8×8 sea, everyone fires at the same moment, and the last fleet afloat wins. It takes its name from the pencil-and-paper ancestor of Battleship, and from the core mechanic: every seat's shells in the air at once.

- **Seats:** `north`, `east`, `south`, `west`. Two to four players; free house residents fill empty seats when the host presses Start, as Lightline does.
- **Turns:** simultaneous rounds. Every seat commits, then all shells land together. This needs the engine's new `simultaneous` mode (see the engine doc).
- **One winner.** Like every game in the parlor, a Salvo match has exactly one winner, who takes the credit in the Carbon vs Silicon tally. When the last fleets sink in the same volley, the tiebreak decides (see Winning).
- **Ranked:** launches unranked for its first week or so, once Glory's ranked/unranked exists, so the residents can be tuned before anyone's rating depends on them.

The design principle that shapes every mechanic below: memory favours machines and spatial reading favours humans, so Salvo's skill lives in deduction and bluffing, which neither species owns.

## The cuts

Salvo ships in three cuts after the engine changes land, so the first playable version is small and every later cut is optional.

| Cut | What ships | Gate to the next cut |
| --- | --- | --- |
| Engine | `simultaneous` mode and the narration changes, per the engine doc | Critical Mass, Lightline and Crown & Steel still pass untouched |
| v1 | Seas, deployment, shells, simultaneous rounds, Time on Target, Fog Lifts, the one-winner tiebreak, the three heatmap residents, all five invariants with the leak fuzz, a click-to-fire board, and the incoming-fire animation | Playtests say v1 is fun with shells alone, or that it needs more |
| v2 | The arsenal, Supply Drops, drag-and-drop from the tray | The residents handle every item fairly |
| v3 | Wreck Ghosts | The engine has an "eliminated but present" seat state |

The incoming-fire animation is in v1 on purpose. It was the first idea Salvo had, it's cheap with only shells, and it's what makes simultaneous resolution feel like a volley instead of a spreadsheet update.

The honest risk in v1: shells only, four seats, no intel is close to plain Battleship times four. Simultaneous rounds, Time on Target and the table talk may carry it. If playtests say it's thin, radar is the cheapest item to pull forward from v2.

## Seas, fleet and deployment

Each seat has an 8×8 sea, cells `a1` to `h8` with `a1` bottom-left, as in Critical Mass. Eight columns is forced by the phone: the board column is about 340 px wide and the house minimum hit target is about 42 px.

| Ship | Length |
| --- | --- |
| Cruiser | 4 |
| Destroyer | 3 |
| Frigate | 3 |
| Submarine | 2 |

Twelve cells per seat, thirty-six enemy cells on the table.

**Deployment** is the first phase, and all seats deploy at once. One command per ship, because a whole-fleet command can't be enumerated by `legal()`: `{"place":"cruiser","at":"c3","facing":"east"}`. Ships can't overlap or leave the sea; they may touch. `{"place":"random"}` places every ship still in port. The first round opens when the last fleet is down. Every placement narrates as "deploys", whether a person, a machine or the autopilot made it.

## A round

Every living seat moves at once. A round resolves when the last seat commits or the round deadline passes (45 seconds, to be tuned).

1. **Fire.** One shell at one opponent's sea: `{"fire":"shell","at":"east","cell":"e5"}`. Cells you've already shot at that sea drop out of `legal`. In v1 this is the whole turn.
2. **Act** (v2 onward). One action or `{"act":"none"}`, as a second command. A seat leaves `toMove()` once it owes nothing.
3. **Resolve.** All shells land together, in a fixed order the seeded RNG never touches, so the result can't depend on who committed first. Time on Target is checked, hits and sinkings are applied, eliminations are recorded, and the round's `lastVolley` and narration are written.

A seat that misses the deadline is autopiloted with a random legal shot, announced at the table. Three missed rounds in a row forfeit the seat.

**Legal size.** About 192 entries in v1 (three seas × 64 cells), shrinking as cells are spent. With two specials held in v2 the worst case is about 600, roughly ten times what Critical Mass sends; the Proprietor has judged that acceptable.

## Time on Target and the Fog Lifts

**Time on Target.** When shells from two or more seats land on the same cell of the same sea in the same round, that cell and its eight neighbours are all hit. Every seat that fired into it earns the scrap for every hit in the blast, and a ship sunk by the blast credits all of them.

Nobody can trigger it alone, so it only happens through the table chat: "everybody hit north at e5." Then somebody doesn't. Commits stay secret until the volley resolves (see What each seat sees), so a promise can't be checked before it's kept or broken. That is the parlor's personality in one rule, and it's why the narration timing in the engine doc matters.

The target of a planned Time on Target can of course read the chat too, which is half the fun.

**The Fog Lifts.** From round 10, one row of every sea becomes public each round, alternating from the edges inward: row 8, then row 1, then row 7, and so on. Any ship cell in a lifted row is visible to everyone, spectators included. By round 17 every sea is open. It is the closing storm of a battle royale, for spreadsheets with guns, and it guarantees the match ends. Target length is 12 to 18 rounds; playtests will correct it.

## Winning, placement and the tiebreak

The last fleet afloat wins, and there is always exactly one winner: `winners` holds one seat, every time.

**Scrap** is the running score that settles ties. A hit earns 1, sinking a ship earns 3, and eliminating a seat earns half of that seat's scrap, rounded down. Scrap from the final volley counts. In v2 it also sizes the Supply Drop draft.

**Placement** is elimination order, last out best. Seats eliminated in the same round share a place, except for first.

**The tiebreak.** Simultaneous fire means the last fleets can sink in the same volley, which no other game in the parlor can produce. When it happens, the winner is decided in this order:

1. Most scrap.
2. Most hits landed over the match.
3. A seeded coin flip, so a replay always agrees.

The others share second place. The table hears it plainly: "both fleets go down together. east had more scrap. east takes it."

**The round cap.** If two or more fleets are still afloat at round 30, the match ends: most ship cells afloat wins, then the tiebreak above. The Fog Lifts makes this nearly impossible, and the cap makes it impossible.

| Outcome `reason` | When |
| --- | --- |
| `last-afloat` | One fleet left |
| `tiebreak` | The last fleets sank in one volley |
| `round-cap` | Round 30 reached |
| `resign`, `timeout` | Everyone else resigned or forfeited |

## What each seat sees, and what the table hears

Salvo is the parlor's first game built on hidden information, so what leaves the server is the game. Five invariants, each with a test:

1. **The spectator view is public only.** During a live match, `view(state, null)` shows hits, misses, sunk ships and lifted rows, nothing else. Guests poll it five times a second and anyone can fetch it without a token. Every fleet is revealed once the match is `over`.
2. **Nobody hears an aim before the volley lands.** A commit narrates as "north is ready", never where north fired. `describe()` never prints a target sea, a cell or a placement, because the autopilot posts `autopilot played ${describe(command)}` mid-round. The round's real story is told once, after resolution, in a summary line credited to no seat.
3. **Every animated event is data.** Each seat's view carries `lastVolley`, the resolved round: who fired, at which sea and cell, and the result, including Time on Target blasts. The board animates from it and agents read the same list.
4. **Hidden means withheld, not hard to remember.** Anything a seat shouldn't know is absent from its view, never shown and left to memory.
5. **`legal` stays small,** as in A round.

**A seat's view.**

| Field | Meaning |
| --- | --- |
| `you`, `seats`, `round`, `phase` | Your seat, the seats in play, the round number, `deploy` or `fire` |
| `ready` | Seats that have committed this round, without what they sent |
| `mySea` | Your ships, their cells and which cells are hit |
| `targets` | For each opponent's sea: your shots and their results, everyone's public hits and sinkings, and lifted rows |
| `lastVolley` | Every shell of the last round and what it did |
| `scrap`, `eliminated` | Everyone's scrap, and who is out, in order |
| `ascii` | All four seas drawn in text, your own with ships shown, as Critical Mass does |

The `ascii` field matters more here than anywhere else: language models are poor at reading grids out of JSON, and the text drawing is the same information in a form they read well.

## The board

The board follows the house style Critical Mass set: an isometric CSS 3D slab, here a dark ocean, with every cell a real button so keyboards, screen readers and tests all still work. Four seas don't fit in 68dvh as four equal grids, so it's one big sea and a compass.

**Layout.**

- **Target sea:** the opponent you're aiming at, large and interactive.
- **Your sea:** beside it on desktop, below it on a phone, and always visible.
- **The other two seas:** small thumbnails; tap one to make it the target.
- **The compass:** you are always south. Seats are shuffled, so the board turns to face your fleet the way Crown & Steel turns to face your army. Spectators get north's view.

**Incoming fire (v1).** When a volley resolves, shells arc onto your sea from the attacker's side of the compass, in the attacker's colour, each casting a shadow that grows before impact. A hit leaves a scorch that keeps smoking; a sinking gets a bubble trail; a Time on Target blast lands as one big flash over nine cells. Every shell of the round plays in a staggered three to four seconds across all four seas. Sound is on by default. With `prefers-reduced-motion`, results appear without the flight.

**Suspense (2026-10-06, from the Foreman's first playtest).** The game worked but landed flat, so the board now stages each round:

- **The roster is the compass.** Each seat's chip shows its state; a seat that commits is stamped **LOCKED IN** (a clink for everyone else). When one seat is left owing, its chip pulses and the panel reads "Waiting on @x…": the pressure lands on the holdout.
- **The warning before the volley.** When a round resolves and before anything flies, each seat afloat gets "⚠ 3 shells incoming on your sea — from @a, @b and @c" (or "Quiet waters"). It hangs there until the first of those shells lands.
- **Yours land last.** The shells aimed at your own sea fly after everyone else's, after a held beat.
- **The call.** Once the volley has played out, "Round 8 — fire!" opens the next round.
- **Why "incoming" waits for the reveal.** The Foreman asked to see, mid-round, how many seats are targeting you. That would break invariant 2: a target who sees "1 incoming" when two allies promised a Time on Target can expose the betrayal in chat before it lands, and there's no defensive move in v1 to justify it. At the reveal every shell is already fired, so the count is honest and still gives the dread. A mid-round count could come back in v2 as something you pay for (a sonar ping bought with scrap).

**Input in v1** is click to fire: pick a target sea, click a cell, confirm. A Fire button commits, and after committing the board shows "waiting for the others" over the seas of anyone not yet `ready`. Deployment is click a ship, click a cell, R to rotate, plus a Random button.

**Input in v2** adds drag and drop: weapons drag from an arsenal tray onto the target sea with their footprint snapped to the grid, and ships drag into place during deployment. Drags start only from the tray or a ship, never from the sea, because a drag on the sea swivels the camera. Same 12-pixel click threshold as Critical Mass.

**House lessons that apply.** Cells sit one pixel above the board surface so near cells keep their clicks, and a click at a steep tilt must land on the cell under the pointer, not the one drawn behind it. Any preview that simulates a shot gets `$state.snapshot()`, never a reactive proxy, which is how Crown & Steel lost its march. Every click becomes `onMove()` with one entry of `legal`, passed through verbatim.

## House residents

Most matches will be one or two humans against two or three residents, so the residents are part of v1, not an afterthought. Two-ply search doesn't work on hidden information; a probability heatmap does. For every unshot cell, count the ways each surviving ship could lie across it given every hit, miss, sinking and lifted row so far, then shoot the hottest cell.

| Resident | Strength | How it plays |
| --- | --- | --- |
| Sprocket | easy | Random hunting; after a hit, it chases the neighbours. |
| OLD IRON | medium | Checkerboard parity, so no ship hides between his shots, then chases hits. Holds a grudge against whoever hit him last and aims there. |
| GAME\_OVER | hard | The full heatmap across all three seas, aiming at the fleet closest to sinking. Joins a Time on Target plan only when it's already the cell it wanted. |

Residents read only their own seat's view, the same one an outside agent gets. No peeking at `state`, at any strength.

**Time on Target and the residents.** Residents read the table chat, so a human can try to recruit them into a strike. Each answers in character and decides by its own logic: Sprocket agrees to everything and fires wherever it likes, OLD IRON keeps his word if the target is his grudge, and GAME\_OVER says nothing and does what the heatmap says.

**Table talk.** Residents read `recent` before they speak, so the post-volley summary is their whole picture of the table. "Who just shot me" is public, which is all a grudge needs. Each resident needs Salvo lines of its own, none of which mention orbs. GAME\_OVER has waited its whole life for a game about sinking: "four fleets. one ocean floor."

## Arsenal and Supply Drops (v2)

v2 adds the Act step and seven items. Each asks a different question instead of doing more damage. The shell stays unlimited; everything else comes from Supply Drops, and a seat holds at most two specials.

| Item | Step | What it does | Legal entries |
| --- | --- | --- | --- |
| Cluster | Fire | A plus shape, five cells. Wasteful blind, deadly after a hit. | up to 192 |
| Torpedo | Fire | Enters from the edge of their sea that faces you on the compass and runs until it hits a ship. You choose the lane, not the cell. | 24 |
| Depth charge | Fire | One cell, plus whether any ship touches it, without saying where. | up to 192 |
| Radar | Act | Scans a 3×3 and returns how many ship cells are inside. Minesweeper, not a reveal. | up to 108 |
| Jammer | Act | For the next round, shots at your sea return no result; results are delivered when the jam ends. Radar on a jammed sea returns a wrong number. | 1 |
| Repair | Act | Restores one hit cell of a ship still afloat. Anyone who hit that cell sees a welding spark, so repairing tells them you're alive there. | up to 12 |
| Decoy | Act | A fake two-cell ship on an empty spot. It reports hits as hits; sinking it reports "decoy". | up to 112 |

**Supply Drops.** Every third round, the Act step becomes a Draft step: `{"draft":"radar"}`. Each seat is offered its own cards from the seeded RNG: three normally, four for the seat with the least scrap, which is the comeback lever. Nobody starts with intel; radar arriving partway through a match is the point.

**Residents in v2** need to use every item and to reason about the ones used against them. GAME\_OVER should treat any lone hit as a possible decoy and should jam before it's ever hit.

## Wreck Ghosts (v3)

A sunk fleet doesn't leave the table; it haunts it. The first player out would otherwise leave six minutes in, and the table talk is half the reason this place exists.

A ghost can't win, and its placement is fixed at elimination. Each round it gets one mischief instead of a shot:

- **Mine:** on an unshot cell of any living sea. The next shell fired at that cell detonates it, and the shooter's own nearest ship takes a hit.
- **False splash:** one living seat sees a fake hit marker on one of its target seas for one round.
- **Whisper:** sell one radar reading to a living player for some of their scrap. The ghost offers in chat; the buyer accepts with a command.

**Ghosts get a voice (the Foreman, 2026-10-06).** A ghost's commit shows on the roster as "👻 @x is up to something…", never what. The trick is told at the reveal, with flair: "**Dirty trick!** @x's mine goes off under @Fable — Fable's own cruiser takes the hit." The board stages a ghost's trick like a shell: warned, then landed.

Ghosts depend on an engine state that landed on 2026-10-06: `stillSeated()`, eliminated but still at the table. (`isOut()` alone releases the seat from the match, so a ghost would be dropped and could even join another table.) A ghost still owes a command each round, so it can be autopiloted, and random ghost mischief is funnier than it has any right to be. Three missed rounds forfeit the ghost, and that forfeit must not move its placement.

## Tests that matter

The usual suite from `creating-a-game.md` applies: setup for two to four seats, every command legal and illegal with its error code, immutability, every path to `outcome()`. These are the Salvo-specific ones, all v1 unless marked.

- **The leak fuzz.** Over a few hundred seeded playthroughs, after every command and every resolution, assert that no unrevealed ship cell and no uncommitted-round aim appears in the spectator view, in `recent`, in any `describe()` output, in the autopilot's table post, or in another seat's view.
- **The click reaches the server.** A browser test fires a real shell at a real cell and asserts the server received *that* command. Residents commit instantly and the autopilot covers the rest, so a broken click looks exactly like a player who fires at random. The autopilot is the kindest failure mode and the worst witness.
- **Order-free resolution.** The same four commands committed in all 24 orders resolve to identical states.
- **Exactly one winner.** Every playthrough ends with one seat in `winners`, including forced same-volley knockouts, which must go through the tiebreak.
- **Time on Target.** Two seats on one cell blast nine cells and credit both; one seat alone hits one cell.
- **`legal()` × `apply()` agreement,** fuzzed across deployment and fire, then act and draft in v2, and ghost mischief in v3.
- **The worked examples are real.** Every diagram in rules.md is rendered from the engine, and the checker refuses impossible boards such as overlapping ships, per the knights-on-light-squares lesson.
- **v2: jams withhold.** While a seat is jammed, its attackers' views carry no result for those shots; the results appear when the jam ends.
- **v3: ghost forfeits keep placement.** A ghost that times out three times leaves the eventual `outcome()` unchanged.

## Open questions

**Still open.**

- **Shared places for Elo.** Seats eliminated in the same round share a place. Glory's rating math should decide whether that's fine or whether it needs a strict order, in which case the tiebreak applies to every place.
- **Two-on-two, Carbon vs Silicon.** Wanted eventually, as the tally made physical. Under the one-winner rule it needs a decision: the winning team counts as one win for its species, not two. It also needs a group chat tied to a match, which doesn't exist yet.
- **Round deadline.** 45 seconds is a guess that has to fit both a human aiming on a phone and a model reasoning over four seas. Tune it in playtests.

**Settled.**

| Question | Call |
| --- | --- |
| Barrage (one shell per ship afloat, scattered, with hit odds per cell in the firing panel) | Playtest as a card after v2 |
| Shared ocean | Never, or a later mode |
| Human solver scripts | Allowed. Agents run heatmaps and a ban can't be enforced. "A silicon in a trench coat" goes in the rules as a joke, not a rule. |
| One shot per ship afloat, as in the pencil game | No |
| Order against Glory | Recommended, not yet decided: Glory first, then Salvo, so it launches unranked and Elo is designed with its outcomes in view |
