# Salvo v2: the Arsenal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sinking a ship earns a crate (pick one of three items); four items — Cluster, Torpedo, Repair, Decoy — each cost one shot of your salvo; residents earn, pick and use them; the board shows a crate card, an item tray, item staging and a turn clock.

**Architecture:** Item geometry and crate dealing live in a new pure helper file `games/salvo/src/arsenal.ts`; the rules (state, `toMove`/`legal`/`apply`, resolution, views, narration) extend `games/salvo/src/index.ts`. Residents extend `apps/bots/src/strategies/salvo.ts`; the board extends `apps/web/src/lib/games/salvo/{Board.svelte,volley.ts}`. No server/engine change: a crate pick is just another command a seat owes in the simultaneous round.

**Tech Stack:** Bun + TypeScript, `bun:test`, Svelte 5 runes + SvelteKit static build, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-08-salvo-arsenal-design.md` (read it first).

## Global Constraints

- Items: `ItemId = 'cluster' | 'torpedo' | 'repair' | 'decoy'`; `ITEM_LIMIT = 2` held; a crate deals 3 different items; one item a round (on top of one buoy a round); an item uses one gun.
- Crates only from sinkings (one per sinking per credited seat, `Volley.sunk[].by`); never for ghosts, never for a decoy reveal; no comeback crate.
- A seat with an open crate owes the pick: it is not ready until its salvo is in AND its crate queue is empty.
- Hidden: which items you hold, your crate's cards, your live decoy's cells, your queued item. Public: `holding` counts, items used (at the reveal), revealed decoys, repair sparks.
- Narration before the reveal never names an item, cell, sea or ship: a crate pick narrates `opens a crate`; an item shot narrates `is ready` like a shell; `describe` of an item shot is `fires`.
- Sonar buoys and fog counts count real ship cells only (decoys invisible to them). `guns` never counts a decoy.
- Torpedo direction by shooter seat: north → down a column from row 8; south → up a column from row 1; east → along a row from column h westward; west → along a row from column a eastward. `lane` is a column letter for north/south shooters, a row number string ("1".."8") for east/west.
- Copy: crate card heading `📦 Crate! Pick one`; summary lines exactly as in the spec's "Telling it".
- Run tests in the FOREGROUND only. Playwright one file per command. `bun run build` before e2e.

## Review Focus

1. **A crate earned in the final volley** — the match is over; no crate opens, nothing owed (Task 1 test "no crate once the match is over").
2. **The autopilot with an open crate** — on the deadline it must pick (or pass) and fire, never stall (Task 1 test "a random legal command always makes progress"; Task 4 fuzz).
3. **A torpedo lane through your own earlier misses / other seats' shots** — passes them, stops only at an unhit ship or decoy cell (Task 2 test "a torpedo passes shot cells").
4. **A decoy hit that also completes a real ship's sinking in the same volley** — real sinking credited and crated; the decoy revealed separately (Task 3 test).
5. **Repair on a cell another seat is shelling this same volley** — repair lands first, so the shell hits it again (Task 3 test "repair lands before the shells").

---

## File map

- Create `games/salvo/src/arsenal.ts` (+ `arsenal.test.ts`) — `ITEMS`, `ITEM_LIMIT`, `clusterCells`, `torpedoLane`, `dealCrate`. (Task 1)
- Modify `games/salvo/src/index.ts`, `index.test.ts`, `ascii.ts` — state, crates, items, decoys, views, narration, summary. (Tasks 1–3)
- Modify `games/salvo/src/fuzz.test.ts`. (Task 4)
- Modify `apps/bots/src/strategies/salvo.ts` (+ test), `voice.ts`, `personality.ts`, `bot.ts`, `personalities/*.ts`. (Task 5)
- Modify `apps/web/src/lib/games/salvo/volley.ts` (+ test), `Board.svelte`, `apps/web/src/routes/t/[id]/+page.svelte`. (Tasks 6–7)
- Modify `games/salvo/docs/rules.md`, `games/salvo/scripts/examples.ts`. (Task 8)
- Modify `e2e/salvo-endings.e2e.ts` or create `e2e/salvo-arsenal.e2e.ts`; `docs/salvo-carryover.md`. (Task 9)

---

### Task 1: Arsenal helpers, state and crates

**Files:** Create `games/salvo/src/arsenal.ts`, `games/salvo/src/arsenal.test.ts`; modify `games/salvo/src/index.ts`, `index.test.ts`.

**Interfaces — produces:**
- `arsenal.ts`:
  ```ts
  export type ItemId = 'cluster' | 'torpedo' | 'repair' | 'decoy';
  export const ITEMS: readonly ItemId[] = ['cluster', 'torpedo', 'repair', 'decoy'];
  export const ITEM_LIMIT = 2;
  /** The cell and its four orthogonal neighbours that lie on the sea, centre first, then board order. */
  export function clusterCells(cell: string): string[];
  /** The cells a torpedo from `shooter` runs through on lane `lane`, in travel order; null if the lane is invalid for that shooter. */
  export function torpedoLane(shooter: SeatId, lane: string): string[] | null;
  /** The lanes a shooter may use: columns 'a'..'h' for north/south, '1'..'8' for east/west. */
  export function lanesFor(shooter: SeatId): string[];
  /** Three different items, seeded: rng from (seed, draws). */
  export function dealCrate(seed: number, draws: number): ItemId[];
  ```
- `index.ts` state: `arsenal: Record<SeatId, ItemId[]>`, `crates: Record<SeatId, ItemId[][]>` (queue; head is the open crate), `earned` bookkeeping not needed (crates dealt in resolve). Re-export `ITEMS`, `ITEM_LIMIT`, `ItemId`, `clusterCells`, `torpedoLane`, `lanesFor` from index.
- Commands: `{ crate: ItemId }`, `{ crate: ItemId, drop: ItemId }`, `{ crate: 'pass' }`. Codes: `NO_CRATE`, `NOT_IN_CRATE`, `HANDS_FULL` (pick without drop at 2 held), `BAD_DROP`.
- View: `holding: Record<SeatId, number>` (public, living seats), `myArsenal: { items: ItemId[]; crate: ItemId[] | null } | null` (you only; null for spectators/ghosts).
- `toMove` (fire): a living seat owes while `pending` < guns OR its crate queue is non-empty. `legal`: when a crate is open, its choices come FIRST (`{crate:x}` per card, or with `drop` per held item when full, then `{crate:'pass'}`), then the usual shells/buoys (if guns remain).
- Narration: `narrate` of a crate command → `opens a crate`; `describe` → `opens a crate`.
- Resolve: after sinkings are computed, for each `sunk` entry, for each `by` seat that is living after this volley's eliminations and isn't a ghost, push `dealCrate(s.seed, s.draws++)` onto its queue — unless the match ends this volley (then none). Summary line per crate: `{x} pulls a crate from the wreck.` (once per crate).

- [ ] **Step 1: Failing tests** (`arsenal.test.ts`)

```ts
import { describe, expect, test } from 'bun:test';
import { clusterCells, dealCrate, ITEMS, lanesFor, torpedoLane } from './arsenal';

describe('arsenal geometry', () => {
  test('a cluster is the plus around its cell, clipped to the sea', () => {
    expect(clusterCells('c4')).toEqual(['c4', 'c3', 'b4', 'd4', 'c5']);
    expect(clusterCells('a1')).toEqual(['a1', 'b1', 'a2']);
  });
  test('torpedoes run away from the shooter', () => {
    expect(torpedoLane('north', 'c')).toEqual(['c8', 'c7', 'c6', 'c5', 'c4', 'c3', 'c2', 'c1']);
    expect(torpedoLane('south', 'c')).toEqual(['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8']);
    expect(torpedoLane('east', '3')).toEqual(['h3', 'g3', 'f3', 'e3', 'd3', 'c3', 'b3', 'a3']);
    expect(torpedoLane('west', '3')).toEqual(['a3', 'b3', 'c3', 'd3', 'e3', 'f3', 'g3', 'h3']);
    expect(torpedoLane('north', '3')).toBeNull();
    expect(lanesFor('east')).toEqual(['1', '2', '3', '4', '5', '6', '7', '8']);
  });
  test('a crate is three different items, the same for the same seed and draw', () => {
    const c = dealCrate(7, 0);
    expect(new Set(c).size).toBe(3);
    expect(c.every((x) => ITEMS.includes(x))).toBe(true);
    expect(dealCrate(7, 0)).toEqual(c);
    expect(new Set(Array.from({ length: 20 }, (_, i) => dealCrate(7, i).join())).size).toBeGreaterThan(1);
  });
});
```

And in `index.test.ts` (use the file's `deployed`, `volley`, `preHit`, `codeOf`, `viewOf`, `turn`, `G`, `salvo` helpers):

```ts
describe('crates', () => {
  /** North sinks east's submarine (a7–b7) in one volley: preHit a7, then shoot b7. */
  function sinkSub(): SalvoState {
    const s = deployed();
    preHit(s, 'east', ['a7'], 'north');
    return volley(s, { north: ['east', 'b7'] });
  }
  test('sinking a ship earns its shooter a crate of three items; the table hears it, never which', () => {
    const s = sinkSub();
    const mine = viewOf(s, 'north').myArsenal!;
    expect(mine.items).toEqual([]);
    expect(mine.crate).toHaveLength(3);
    expect(viewOf(s, 'east').myArsenal!.crate).toBeNull();
    expect(viewOf(s, null).myArsenal).toBeNull();
    expect(roundSummary(deployed(), s).join(' ')).not.toMatch(/cluster|torpedo|repair|decoy/);
  });
  test('an open crate is owed: legal leads with its cards and pass; the seat is not ready until it picks', () => {
    let s = sinkSub();
    const legal = turn.legal(s, 'north') as SalvoCommand[];
    const crate = viewOf(s, 'north').myArsenal!.crate!;
    expect(legal.slice(0, 4)).toEqual([...crate.map((x) => ({ crate: x })), { crate: 'pass' }]);
    s = salvo(s, 'north'); // all guns fired
    expect(turn.toMove(s)).toContain('north');
    s = turn.apply(s, 'north', { crate: crate[0] });
    expect(viewOf(s, 'north').myArsenal).toEqual({ items: [crate[0]], crate: null });
    expect(viewOf(s, 'east').holding.north).toBe(1);
  });
  test('two held: a pick needs a drop; pass is always fine', () => {
    let s = sinkSub();
    s.arsenal.north = ['repair', 'decoy'];
    const crate = s.crates.north[0];
    const card = crate.find((x) => x !== 'repair' && x !== 'decoy') ?? crate[0];
    expect(codeOf(() => turn.apply(s, 'north', { crate: card }))).toBe('HANDS_FULL');
    expect(codeOf(() => turn.apply(s, 'north', { crate: card, drop: 'torpedo' }))).toBe('BAD_DROP');
    s = turn.apply(s, 'north', { crate: card, drop: 'repair' });
    expect(s.arsenal.north.sort()).toEqual(['decoy', card].sort());
    expect(codeOf(() => turn.apply(s, 'north', { crate: 'pass' }))).toBe('NO_CRATE');
  });
  test('cards not in the crate are refused', () => {
    const s = sinkSub();
    const missing = ITEMS.find((x) => !s.crates.north[0].includes(x))!;
    expect(codeOf(() => turn.apply(s, 'north', { crate: missing }))).toBe('NOT_IN_CRATE');
  });
  test('a shared sinking crates every shooter; ghosts and the finished match get none', () => {
    let s = deployed();
    preHit(s, 'east', ['a7'], 'north');
    s = volley(s, { north: ['east', 'b7'], south: ['east', 'b7'] }); // Time on Target on b7
    expect(s.crates.north).toHaveLength(1);
    expect(s.crates.south).toHaveLength(1);
  });
  test('no crate once the match is over', () => {
    let s = deployed(2);
    preHit(s, 'east', SHIP_CELLS.filter((c) => c !== 'b7'));
    s = volley(s, { north: ['east', 'b7'] });
    expect(s.phase).toBe('over');
    expect(s.crates.north).toEqual([]);
  });
  test('narration never names a crate card', () => {
    const s = sinkSub();
    const cmd = { crate: s.crates.north[0][0] };
    expect(turn.describe(cmd)).toBe('opens a crate');
    expect(turn.narrate!(s, turn.apply(s, 'north', cmd), 'north', cmd)).toBe('opens a crate');
  });
  test('a random legal command always makes progress (the autopilot never stalls on a crate)', () => {
    let s = sinkSub();
    for (let k = 0; k < 20 && turn.toMove(s).includes('north'); k++) s = turn.apply(s, 'north', (turn.legal(s, 'north') as SalvoCommand[]).at(-1)!);
    expect(turn.toMove(s)).not.toContain('north');
  });
});
```

(Adjust helper names to what `index.test.ts` really has; `ITEMS`, `roundSummary`, `SHIP_CELLS` are imported/defined there. If a filler shell from `volley()` lands on a cell a test relies on, move the test's cell and note it.)

- [ ] **Step 2: Run to see them fail** — `cd games/salvo && bun test src/arsenal.test.ts src/index.test.ts -t "crates|arsenal"`.

- [ ] **Step 3: Implement** — `arsenal.ts` with `createRng` from `@cs/game-api` (`dealCrate`: shuffle `ITEMS` with `createRng((seed + draws * 7919) >>> 0)`, take 3). In `index.ts`: state + setup init (`arsenal: each(() => [])`, `crates: each(() => [])`); `applyCrate(s, seat, cmd)`; `toMove`/`legal` as in Interfaces; resolve deals crates after sinkings (and after eliminations, skipping eliminated/ghost seats and skipping entirely when the match ends this volley); `holding`/`myArsenal` in the view; narration; summary line. Ready-state: a seat becomes ready when its salvo is complete AND its crate queue is empty — update both `applyFire` and `applyCrate` to recompute, and resolve when `toMove(s).length === 0`.

- [ ] **Step 4: Run** — `cd games/salvo && bun test` (all), `bun run typecheck` at root (bots/web fixtures may need the new view fields: add `holding: {}`, `myArsenal: null`).

- [ ] **Step 5: Commit** — `Salvo arsenal: sinking a ship earns a crate (pick one of three items, or swap, or pass), owed before you're ready`.

---

### Task 2: Cluster and Torpedo

**Files:** `games/salvo/src/index.ts`, `index.test.ts`, `ascii.ts` (none needed unless output changes).

**Interfaces — produces:**
- Commands `{ fire: 'cluster', at, cell }`, `{ fire: 'torpedo', at, lane }`; `Order.kind` gains `'cluster' | 'torpedo'` and `Order` gains optional `lane?: string`.
- Codes: `NO_ITEM` (not held), `ONE_ITEM` (an item already queued this round), `ALREADY_FIRED` (cluster centre you've shot), `BAD_LANE`, `LANE_SPENT` (no cell in the lane you haven't shot).
- `Volley.items: ItemUse[]` (always present; `[]` when none):
  ```ts
  export type ItemUse =
    | { item: 'cluster'; from: SeatId; sea: SeatId; cell: string; cells: string[]; hits: string[] }
    | { item: 'torpedo'; from: SeatId; sea: SeatId; lane: string; path: string[]; struck: string | null }
    | { item: 'repair'; from: SeatId; cell: string }
    | { item: 'decoy'; sea: SeatId; cells: string[]; by: SeatId[] }; // revealed decoys (Task 3)
  ```
- Using an item removes it from `s.arsenal[seat]` when the command is accepted.
- Resolve: cluster cells and torpedo path cells are recorded through the same `covered()` / `s.shots` / `newHits` machinery as lone shells (credited to the shooter), so hits, scrap, sinkings, crates and mine fizzling all work unchanged. A cluster cell or torpedo cell is never part of a Time on Target `group` and never triggers a mine (only shells aimed at the exact cell do; a mined cell spent by a cluster/torpedo fizzles per R-34). A torpedo stops at the first cell holding an unhit ship (or, after Task 3, an unhit decoy) cell **as of the start of the volley**; cells before it are misses by the shooter; the struck cell is a hit; a torpedo with no target marks the whole lane as misses. Cells the shooter already shot are passed without re-marking.
- `legal`: one item entry per held item kind, at most one item a round: clusters `{fire:'cluster', at, cell}` for every living opponent sea × cell you haven't shot; torpedoes `{fire:'torpedo', at, lane}` for every living sea × `lanesFor(seat)` with an unshot-by-you cell.
- Summary lines (spec's "Telling it"): cluster `{north}'s cluster lands on {east} around c4: 2 hits.` / `…: all water.`; torpedo `{west}'s torpedo runs down {north}'s lane c and strikes at c5.` / `…and runs clean through.`

- [ ] **Step 1: Failing tests** — in `index.test.ts`, `describe('cluster and torpedo', …)` covering: legal includes cluster/torpedo entries only when held, and only one item a round (`ONE_ITEM`); cluster lands 5 cells (edge: 3), hits credited and paid (+1 each), can sink (and crate); cluster cell overlapping another seat's lone shell is not a blast; torpedo from each seat runs its direction and stops at the first ship cell (use STANDARD fleets: west's torpedo along row "1" at east hits a1 immediately; north's torpedo down column "e" at east runs clean through: all misses); a torpedo passes cells already shot; `NO_ITEM`, `BAD_LANE`, `LANE_SPENT`; the volley's `items` entries; the summary lines verbatim; narration of an item shot is `is ready` and `describe` is `fires`.

- [ ] **Step 2–4: Implement, run `cd games/salvo && bun test`, typecheck** (fuzz may need `items: []` in fixtures; the fuzz player isn't taught items until Task 4 — if fuzz fails only because items are now legal and unhandled, make the fuzz `choose()` skip item commands for now and say so).

- [ ] **Step 5: Commit** — `Salvo arsenal: Cluster (a plus of five) and Torpedo (a lane from your side, to the first ship, the water it passes revealed)`.

---

### Task 3: Repair and Decoy

**Files:** `games/salvo/src/index.ts`, `index.test.ts`, `ascii.ts`.

**Interfaces — produces:**
- Commands `{ use: 'repair', cell }`, `{ use: 'decoy', at, facing }`. Codes: `NOT_HIT` (repair on a cell that isn't a hit on your afloat ship), `SHIP_SUNK`, `NO_ROOM`-style `DECOY_PLACE` (off sea / overlaps ship or decoy / on a shot cell), `ONE_DECOY` (you already have a live decoy).
- State: `decoys: Record<SeatId, { cells: string[]; hits: string[]; revealed: boolean } | null>`; `repairs: Record<SeatId, { cell: string; round: number }[]>` (public sparks; a spark clears when the cell is shot again).
- Resolve order: **repairs and decoys land first** (repair: remove the cell from the ship's `hits`, delete `s.shots[seat][cell]`, push a spark; decoy: set `decoys[seat]`), then shells/clusters/torpedoes. Landing treats an unhit decoy cell as a target: the shot records `result: 'hit'`, credit +1 scrap (and `hitsLanded`), the decoy's `hits` grows. A torpedo stops at an unhit decoy cell. When both decoy cells are hit, it's revealed: `Volley.items` gets `{ item: 'decoy', sea, cells, by }`, no sinking scrap, no crate, the shell that completed it reports result `decoy` (extend `ShotResult` with `'decoy'`). Real ship sinking/elimination logic ignores decoys.
- Views: `mySea.decoy: { cells: string[]; hits: string[] } | null` (yours only); `TargetView.decoys: string[][]` (revealed only); `TargetView.repaired: string[]` (live sparks); `TargetView.afloat` = `FLEET_CELLS − (real hits shown)` where a revealed decoy's cells are excluded from `hits` (they move to `decoys`), so afloat comes back; while unrevealed, decoy hits are in `hits` (bluff). Fog counts / sonar use `afloatIn` over real fleets only (already true) — add a test.
- ascii: your decoy as `d` (hit `x`), revealed decoys as `~`, sparks as `r`.
- Summary: `{east} welds the hit at d1 back together.`; `{north}'s shell finds {east}'s DECOY — nothing but driftwood.` (use the completing shooter(s); a torpedo/cluster wording: same line with "torpedo"/"cluster" for "shell").

- [ ] **Step 1: Failing tests** — `describe('repair and decoy', …)`: repair legal only on a hit cell of an afloat ship you own; `repair lands before the shells` (east repairs d1 while north shells d1 the same volley → d1 is hit again, north credited); spark visible to all and cleared when shot; afloat rises; decoy placement legal/illegal codes; decoy hits look like hits to everyone (other seats' `hits`, the shooter's `mine`, `afloat` lower, scrap +1) and the owner's `mySea.decoy` shows it; fog row counts and a sonar reading over a decoy count real ships only; revealing (both cells hit): `items` entry, result `decoy`, no crate, no sinking scrap, afloat back, `decoys` lists it; **a decoy hit that also completes a real ship's sinking in the same volley** credits and crates the real sinking only; torpedo stops at a decoy; narration of `use` commands is `is ready`/`fires`.

- [ ] **Step 2–4: Implement and run** — `cd games/salvo && bun test`, typecheck.

- [ ] **Step 5: Commit** — `Salvo arsenal: Repair (patch a hit; everyone sees the spark) and Decoy (a fake two-cell ship; sonar and fog see through it)`.

---

### Task 4: Fuzz with the arsenal

**Files:** `games/salvo/src/fuzz.test.ts`.

- [ ] Teach the fuzz `choose()` to: pick a crate card / swap / pass at random when a crate is open; use a held item ~30% of rounds (random legal item entry).
- [ ] Leak invariants per viewer: no other seat's held items, crate cards or live decoy cells appear in any view, `recent`/`describe`/`narrate`, or summary before the reveal; `holding` matches `arsenal` lengths; a seat's `legal` never depends on another seat's decoy position (move a live decoy elsewhere legally; other seats' `legal` unchanged).
- [ ] Sonar readings and lifted-row counts equal the counts over real ship cells only.
- [ ] `legal × apply`: every legal entry (sample) applies; crate commands, item commands included.
- [ ] Order-free resolution with items (cluster + torpedo + repair + decoy in one round, two commit orders → identical state).
- [ ] Tallies prove each item and crate path was exercised (> 0 each).
- [ ] Run `cd games/salvo && bun test src/fuzz.test.ts` (< 60 s), then the package. Commit `Salvo arsenal: the fuzz plays crates and all four items and guards their secrets`.

---

### Task 5: Residents earn, pick and use

**Files:** `apps/bots/src/strategies/salvo.ts` (+ test), `voice.ts`, `personality.ts`, `bot.ts`, `personalities/{old-iron,game-over,sprocket}.ts`.

- [ ] **Crate pick** `chooseCrate(view, legal, opts)`: GAME_OVER (`style: 'finisher'`) prefers cluster > torpedo > decoy > repair; OLD IRON (`grudge`) repair > decoy > cluster > torpedo; Sprocket (`wanderer`) random. When full: drop the least useful held item (a repair with no hit on an afloat ship; a decoy after round 6) or pass if every held item outranks the cards.
- [ ] **Item use** inside `chooseSalvoMove` (at most one a round, as the salvo's first order): cluster centred on the cell maximising the summed chance over the plus (only when it beats the best single shell by ≥ 1.5×); torpedo down the lane with the highest summed chance on any living sea when nothing is being chased; repair the hit cell of the own ship with exactly one cell left unhit; decoy in rounds 1–4 on two unshot cells of open water far from its own ships (pick the placement maximising min distance).
- [ ] **Doubt** (hard only): a two-cell hit pair, both hit, no sinking, ship not sunk after its neighbours were shot — buoy it before more shells (if a buoy is legal).
- [ ] Moments: `crate` (I earned a crate) and `fooled` (my decoy ate a shell) — `MomentKind`, `describeMoment` ("You just pulled a crate from the wreck of a ship you sank. Crow about it. One line." / "Someone just shot your decoy and thinks they hit a ship. Gloat (without saying it's a decoy until it's revealed). One line."), `BANK`, optional `lines.crate`/`lines.fooled`, three lines each per resident in voice; chatter at 0.9.
- [ ] Tests: every choice is an entry of `legal`; crate preferences per style; cluster/torpedo/repair/decoy picked in the scenarios above; doubt buoys; `volleyMoment` → `crate`/`fooled`.
- [ ] **Sim** (throwaway, deleted after): 200 four-resident games with items: median rounds, % at cap, % of games losing a fleet by round 5 (≤ 15%), items used per game. Numbers in the commit message; stop and report if cap > 10% or early knockouts > 20%.
- [ ] Commit `Salvo arsenal: residents pick crates in character and use all four items`.

---

### Task 6: Board — item tray, aiming, staging, 📦×N

**Files:** `apps/web/src/lib/games/salvo/volley.ts` (+ test), `Board.svelte`.

- [ ] `volley.ts`: `VolleyPlan.items: ItemPlan[]` — cluster (flash the plus at the centre shell's land time), torpedo (a run from its entry edge along `path`, landing at `struck` or exiting; `at` start + per-cell step `TORPEDO_STEP_MS = 90`), repair (spark at `lead`), decoy reveal (stamp at the completing shot's land time). Reduced motion: all at once. Unit tests for each.
- [ ] Board: item tray under "Salvo: N shots" — held items as buttons (`data-testid="item-<id>"`); selecting one switches the aim: cluster (hover previews the plus; click the centre), torpedo (hover a cell → its lane from your edge highlights; click), repair (your fleet's hit cells become clickable, on the mini fleet sea), decoy (your own sea shows big with a two-cell hull preview; R turns it; click). The chosen item is part of the salvo (counts a pip, shows in `myOrders`); "Fire" sends it with the rest. Disabled with a visible reason line (like the ghost controls) when no legal entry exists for it.
- [ ] Staging per `ItemPlan`; DECOY stamp (small, like SUNK) on revealed decoy cells; sparks on `repaired` cells; your live decoy drawn on your own fleet (dashed hull).
- [ ] 📦×N on each player's card from `view.holding`.
- [ ] `bun run check` (0/0), build, `npx playwright test e2e/salvo.e2e.ts`. Screenshot (scratch, not committed) of the tray and a torpedo aim; describe in the report.
- [ ] Commit `Salvo arsenal on the board: the item tray, aiming each item, items staged in the volley, holdings on the cards`.

---

### Task 7: Board — crate card and turn clock

**Files:** `Board.svelte`, `apps/web/src/routes/t/[id]/+page.svelte`.

- [ ] Crate card (`data-testid="crate-card"`) over the stage when `view.myArsenal.crate` is set and the volley has landed: heading `📦 Crate! Pick one`, three item cards (`data-testid="crate-<id>"`: name, one-line effect), when full a "Swap for …" choice per held item, a Pass button; it sends the verbatim `legal` entry; it can be minimised to a 📦 button in the tray (the crate stays owed). Not shown on first paint unless a crate is still open (a reload with an open crate shows it — it's owed).
- [ ] Turn clock: a countdown ring (reuse `CountdownRing.svelte`) beside "Salvo: N shots" and in the ghost controls, fed by the page's `secondsLeft` (already a Board prop); calm → amber at 20 s → red + pulse at 10 s; a tick each second in the last 5 s when sound is on (`sound` already exists); ✓ when you're locked in; hidden when you owe nothing.
- [ ] check/build; screenshot both. Commit `Salvo arsenal: the crate card and a turn clock`.

---

### Task 8: Rules guide

**Files:** `games/salvo/docs/rules.md`, `games/salvo/scripts/examples.ts`.

- [ ] An "Arsenal" section after "The sonar buoy": crates (earned, three cards, owed, swap/pass, hold two), each item with a worked example rendered by `examples.ts` (cluster around a hit; torpedo from each side; repair spark; decoy fooling a shooter then revealed), what sees through decoys, how it's told (summary lines verbatim). Agents: commands, codes, view fields (`holding`, `myArsenal`, `items`, `decoys`, `repaired`, `mySea.decoy`), legal order (crate first). Quick reference card lines. Remove the old "Supply Drops" mentions if any.
- [ ] `cd games/salvo && bun test` (examples test). Commit `Salvo guide: the Arsenal`.

---

### Task 9: End to end, full verify, carry-over

**Files:** `e2e/salvo-arsenal.e2e.ts` (new), `docs/salvo-carryover.md`.

- [ ] e2e (pattern from `e2e/salvo-endings.e2e.ts`: a human + three scripted HTTP agents): the human sinks a ship (scripted agents keep one target's sub easy to find, or set it up by preferring cells; simplest: the human fires at the cells of an agent sea that the agents deployed with fixed `place` commands the test chose), the crate card shows, the human picks a card through the board, `view.myArsenal.items` holds it; next round the human uses a cluster through the tray; the server's `myOrders` holds `{fire:'cluster', …}`; after the volley `lastVolley.items` lists it; the turn clock shows and counts down (assert the ring's seconds decrease).
- [ ] Build; run the new e2e 3×; `npx playwright test e2e/salvo.e2e.ts` and `e2e/salvo-endings.e2e.ts`; then `bun run typecheck && bun test` and the full `npx playwright test` (known flakes lobby:95, pocket:62, update:4 re-run alone).
- [ ] Carry-over: `## Arsenal (2026-10-08)` from R-50: crates only from sinkings, no comeback crate (R-48 fixed the cause); an item costs a gun, one a round; cluster arms never a Time on Target and never set off mines; torpedoes run away from the shooter, never set off mines, reveal the water they pass; repair and decoy land before shells; repair sparks are public (hits are public); decoys pay scrap, reveal without crate or sinking scrap, invisible to sonar and fog; the turn clock.
- [ ] Commit `Salvo arsenal e2e: sink, pick from the crate, fire a cluster through the board; carry-over R-50..`.
