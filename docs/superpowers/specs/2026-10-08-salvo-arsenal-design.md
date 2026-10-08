# Salvo v2: the Arsenal — design

2026-10-08 · agreed with the Foreman in chat · replaces the v2 section of `docs/ideas/Salvo — game design.md` (Supply Drops are dropped)

## Why

The Foreman, after ten full games: "Needs some sort of reward when you sink a ship." Scrap exists (+1 a hit, +3 a sinking) but it's only a number on a card. v2 makes a sinking pay off with something you can use.

## Decisions (the Foreman, 2026-10-08)

- **Crates come from sinking ships.** Your shell sinks a ship → you pick one of three item cards. No Supply Drops, **no comeback crate** (rubber-banding felt unfair; the mob that caused it was fixed in R-48 instead).
- **Four items this cut:** Cluster, Torpedo (attack), Repair, Decoy (defence). Jammer, depth charge and Whisper wait.
- **An item costs one shot of your salvo,** like the sonar buoy.
- **A turn clock** on the board (rolled in from the same day's ask).

## The rules

### Crates

- In the volley where a ship sinks, every seat credited with that sinking (`Volley.sunk[].by`) gets a crate, one per sinking. Ghosts never get crates; a mine's boomerang sinking credits its ghost, which gets none. A decoy "sinking" gives no crate.
- A crate is three different items dealt from the four by the seeded RNG (`s.seed`, `s.draws`), shown to its owner alone.
- **Picking is part of your round.** A seat with an open crate owes the pick as well as its salvo: `{"crate":"torpedo"}`, `{"crate":"torpedo","drop":"repair"}` (swap, when you already hold 2), or `{"crate":"pass"}`. You can pick before, between or after your shots. The autopilot picks at random.
- Two crates in one volley (two sinkings) open one after the other: the second is dealt when the first is resolved.
- **You hold at most 2 items.** With 2 held, a crate offers swap (drop one of yours) or pass.

### Using an item

- An item takes one gun of the salvo. At most **one item a round** (on top of the one-buoy rule). Using it removes it from your hand when the command is accepted (a queued item counts as used).
- **Cluster** `{"fire":"cluster","at":"east","cell":"c4"}`: the cell and its four orthogonal neighbours on the sea (cells off the sea are dropped). Each covered cell lands as a shell from you. The centre must be a cell you haven't shot; covered cells you have shot are skipped. A cluster cell that another seat also hits this volley is **not** a Time on Target (only shells aimed at the same cell are).
- **Torpedo** `{"fire":"torpedo","at":"east","lane":"c"}`: runs away from you. North fires down a column from row 8, south up a column from row 1, east along a row from column h going west, west along a row from column a going east (`lane` is a column letter for north/south shooters, a row number as a string for east/west). It stops at the first ship cell not yet hit (a hit, credited to you, like a shell); every cell it passed is marked a miss by you. A lane with no unhit ship cell is all misses. Legal: lanes with at least one cell you haven't shot. A decoy cell stops a torpedo like a ship cell.
- **Repair** `{"use":"repair","cell":"d1"}`: on a hit cell of your own ship that's still afloat (never a sunk ship, never a decoy). The cell is unhit again and unshot (anyone may shoot it again), your afloat count rises by one, and everyone sees a welding spark there (`TargetView.repaired`) until it's shot again. It can't be hidden: hits are public, so a hit vanishing from the list names the cell anyway. Repairs land at the reveal, **before** this volley's shells, so a repaired cell can be hit again the same volley.
- **Decoy** `{"use":"decoy","at":"c3","facing":"east"}`: a fake two-cell ship on your own sea: both cells unshot, on the sea, not overlapping a ship or another decoy. One decoy per sea at a time. Laid at the reveal, before this volley's shells.

### Decoys and what everyone sees

- A decoy cell hit reports **hit** to everyone: in `hits`, in the shooter's `mine`, in the volley's results, it pays scrap (+1) and lowers the owner's public afloat. Nothing tells it apart early.
- When both decoy cells are hit, it's revealed: the volley says `decoy` for the shell that completed it, the cells show as a decoy (new `TargetView.decoys`), its two hits stop counting against afloat, no sinking scrap, no crate. Told: "{north}'s shell finds {east}'s DECOY — nothing but driftwood."
- **Sonar buoys and fog counts count real ship cells only.** Radar sees through a decoy; that's the counter-play.
- `guns` never counts a decoy.

### Hidden and public

- Public: how many items each seat holds (`view.holding: Record<SeatId, number>`); at the reveal, every item used (in `Volley.items`); decoys once revealed.
- Private: which items you hold and your open crate's cards (`view.myArsenal: { items, crate: { cards } | null }`), your live decoy (in `mySea.decoy`), your queued item (in `myOrders`).
- Narration before the reveal never names an item: a crate pick narrates "opens a crate", an item shot "is ready" like any shell.

### Telling it (round summary)

- "{north}'s cluster lands on {east} around c4: 2 hits." / "…: all water."
- "{west}'s torpedo runs down {north}'s lane c and strikes at c5." / "…and runs clean through."
- "{east} welds the hit at d1 back together."
- "{north}'s shell finds {east}'s DECOY — nothing but driftwood."
- "{east} pulls a crate from the wreck." when a crate is earned (never which items).

## The module (`games/salvo/src/index.ts`)

- `ItemId = 'cluster' | 'torpedo' | 'repair' | 'decoy'`; `ITEM_LIMIT = 2`; state `arsenal: Record<SeatId, ItemId[]>`, `crates: Record<SeatId, { cards: ItemId[] }[]>` (queue), `decoys: Record<SeatId, { cells: string[]; hits: string[]; revealed: boolean } | null>`, `repaired` marks; `Order.kind` gains `cluster | torpedo | repair | decoy` (+ `lane`, `facing`).
- `toMove`: a living seat owes until its salvo is in **and** its crate queue is empty. Ready-at-salvo logic accounts for the crate.
- `legal`: crate choices first (when a crate is open), then shells, buoys, items held (one item a round).
- `resolve`: repairs and decoys land → shells, clusters, torpedoes land (decoy cells count as targets for landing and Time on Target) → mines (v3, unchanged) → sinkings, decoy reveals → crates dealt → eliminations.
- Views as above; `ascii` shows your decoy as `d`, revealed decoys as `~`, repaired cells as `r` in your own fleet.

## Residents (`apps/bots/src/strategies/salvo.ts`)

- **Crate pick by character:** GAME_OVER prefers cluster/torpedo, OLD IRON prefers repair, Sprocket picks at random. With 2 held, swap the least useful (a decoy once the fleet is mostly sunk, a repair with nothing hit).
- **Use:** cluster centred next to an open hit (chance-weighted plus); torpedo down the lane with the most expected ship cells when hunting; repair the hit cell of a ship one hit from sinking; decoy early (rounds 1–4) on open water away from its ships.
- **Doubt:** hard treats a lone two-cell hit pair with no sinking as maybe-decoy and buoys it before spending more shells.
- Moments: `crate` ("pulls a crate from the wreck") and `fooled` (its decoy ate a shell) with lines per resident.
- Sim: four residents with items finish under the cap; early knockouts stay ≤ 15%.

## The board (`Board.svelte`)

- **Crate card** over the stage when your crate opens: "📦 Crate! Pick one" with three item cards (name, one-line effect), Swap/Pass when full, the round clock showing.
- **Item tray** under the salvo controls: your held items as buttons; picking one switches the aim mode — cluster (cell, plus preview), torpedo (hover a cell → its lane highlights from your edge), repair (your fleet's hit cells become clickable), decoy (your sea shows big with a two-cell preview, R to turn).
- Volley staging: torpedo runs its lane, cluster flashes its plus, repair sparks, DECOY stamp on the revealed cells.
- 📦×N on each player's card.
- **Turn clock:** a countdown ring beside "Salvo: N shots" (and in the ghost controls): calm, amber at 20 s, red and pulsing at 10 s, a tick each second in the last 5 s when sound is on; a ✓ once you're locked in.

## The rules guide

An "Arsenal" section: crates, each item with a worked example rendered from the engine, decoys and what sees through them, how it's told; agent commands, codes and view fields.

## Tests

- Unit: each item legal/illegal with codes; crate dealing (seeded, three distinct), pick/swap/pass, owe-until-picked, autopilot; cluster coverage + edge; torpedo per seat direction, stop rule, misses marked; repair before shells; decoy placement, hits pay, reveal, no crate, afloat restored; one item a round; ghosts get no crate.
- Leak fuzz: items held, crate cards and decoy cells never appear to another seat or in narration before the reveal; sonar/fog never count decoys; `legal`×`apply` with items.
- e2e: sink a ship → the crate card → pick → use a cluster through the board → the server got it; the turn clock shows and counts down.

## Out of scope

Jammer, depth charge, Whisper, Supply Drops, a scrap shop, items for ghosts.
