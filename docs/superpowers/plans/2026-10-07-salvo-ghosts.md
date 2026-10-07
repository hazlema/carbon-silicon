# Salvo v3: Wreck Ghosts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A sunk Salvo fleet stays at the table as a ghost that plays one dirty trick a round (a blind mine or a false splash), told at the reveal, voiced by the residents, and announced to a person with a card that says what being a ghost means.

**Architecture:** Almost all rules live in the pure game module `games/salvo/src/index.ts` (state, `legal`/`apply`, resolution, per-seat views, narration). The engine already supports "out but still seated" (`GameModule.stillSeated`, landed 2026-10-06) and autopilots/forfeits any seat in `toMove`, so no server change is needed. Residents (`apps/bots`) get a ghost planner and three new table-talk moments; the web board gets ghost controls, mine staging in the volley, and the ghost card.

**Tech Stack:** Bun + TypeScript, `bun:test`, Svelte 5 (runes) + SvelteKit static build, Playwright e2e.

**Spec:** `docs/superpowers/specs/2026-10-07-salvo-ghosts-design.md` (read it first; this plan argues from it).

## Global Constraints

- A ghost knows what it knew, nothing more: nothing in a ghost's `legal`, errors, or view may depend on where an unhit living ship is. (So mines may sit on ships, and two ghosts' mines may share a cell.)
- Only a sinking makes a ghost (eliminated with reason `'sunk'`). A resign/timeout while afloat is out and released as today.
- Mine limit: `MINE_LIMIT = 3` live mines per ghost.
- False splash needs at least 3 living seats.
- A ghost forfeit (3 missed rounds) never changes `eliminated` or `outcome()`; it adds the seat to `ghostsGone` and clears its mines/splashes/pending trick.
- Narration before the reveal never names a cell, sea or ship: a ghost's commit narrates `is up to something…`, `describe` of a trick is `plays a dirty trick`.
- A boomerang hit is told with its sea and cell, never the ship's name (a hit never names its ship unless it sinks it).
- Copy (verbatim): roster `up to something…`; card button **Haunt them**; card heading `You were sunk by @X.`; mission line `Your fleet is gone, but your spirit stays at the table. You're a ghost now. Your mission: mischief.`; short form `👻 You're a ghost. One dirty trick a round.`; summary prefixes `Dirty trick!` and `Backfire!`.
- Run tests in the foreground; never background a verify run. Run Playwright one file per command.
- Web changes are served from `apps/web/build`: run `bun run build` before any e2e.

## Review Focus

1. **A ghost plants a mine on the very cell a living player fires at the same round** — the mine is live before the shells land, so it triggers that volley (Task 2 test "a mine laid this round catches this round's shell").
2. **The last ghost-owed trick resolves the round** — when every living seat is ready and the ghost commits last, `apply` must resolve; same when a ghost is forfeited while it was the last owing (Task 1 tests "the ghost's trick is the last commit" and "a ghost forfeit resolves the round").
3. **A ghost with nothing legal never stalls the table** — 3 mines down and 2 living: it's not in `toMove` (Task 1 test "a ghost with no trick sits out").
4. **Reloading the table as a ghost** — the page shows the short form, not the card, and ghost controls work (Task 6 handles `seen` on first paint; e2e covers the card path).
5. **A mine kills the shooter and ends the match in the same volley** — eliminations run after mines; a same-volley wipe-out goes to the tiebreak (Task 2 test "a boomerang can knock the shooter out").

---

## File map

- Modify `games/salvo/src/index.ts` — ghost state, `toMove`/`legal`/`apply`/`forfeit`/`stillSeated`, resolution of tricks, views, narration, round summary. (Tasks 1–2)
- Modify `games/salvo/src/ascii.ts` — a ghost's own mines as `M`, ghost lines. (Task 2)
- Modify `games/salvo/src/index.test.ts` — ghost tests. (Tasks 1–2)
- Modify `games/salvo/src/fuzz.test.ts` — ghosts in the leak fuzz and the legal×apply fuzz. (Task 3)
- Modify `apps/bots/src/strategies/salvo.ts` (+ `salvo.test.ts`) — ghost planner, `volleyMoment` ghost moments. (Task 4)
- Modify `apps/bots/src/voice.ts`, `apps/bots/src/personality.ts`, `apps/bots/src/bot.ts`, `apps/bots/src/personalities/{old-iron,game-over,sprocket}.ts` — moments `ghost`/`trick`/`backfire`. (Task 4)
- Modify `apps/web/src/lib/games/salvo/volley.ts` (+ `volley.test.ts`) — mine staging. (Task 5)
- Modify `apps/web/src/lib/games/salvo/Board.svelte`, `apps/web/src/routes/t/[id]/+page.svelte` — ghost controls, markers, roster, status, banners, ghost card. (Tasks 5–6)
- Modify `games/salvo/docs/rules.md`, `games/salvo/scripts/examples.ts` — the Ghosts section and its worked example; agent commands. (Task 7)
- Modify `e2e/salvo-endings.e2e.ts` — ghost card + plant a mine + see it go off. (Task 8)
- Modify `docs/salvo-carryover.md` — rulings R-32.. as they're made. (every task that makes a call)

---

### Task 1: Ghost seats, trick commands, views (module)

**Files:**
- Modify: `games/salvo/src/index.ts`
- Test: `games/salvo/src/index.test.ts`

**Interfaces:**
- Produces (exported from `@cs/salvo`):
  - `export const MINE_LIMIT = 3;`
  - `SalvoState` gains `mines: Mine[]`, `splashes: Splash[]`, `ghostsGone: SeatId[]`, `pendingTrick: Record<SeatId, PendingTrick | null>`.
  - `export interface Mine { ghost: SeatId; sea: SeatId; cell: string; round: number }`
  - `export interface Splash { ghost: SeatId; fool: SeatId; sea: SeatId; cell: string; round: number; as: SeatId }`
  - `export interface PendingTrick { kind: 'mine' | 'splash'; sea: SeatId; cell: string; fool?: SeatId }`
  - `SalvoCommand` gains `| { trick: 'mine'; at: SeatId; cell: string } | { trick: 'splash'; fool: SeatId; at: SeatId; cell: string }`.
  - `SalvoView` gains `ghosts: SeatId[]` and `myTricks: { mines: { sea: SeatId; cell: string; round: number }[]; splashes: { fool: SeatId; sea: SeatId; cell: string; round: number }[]; pending: { trick: 'mine' | 'splash'; at: SeatId; cell: string; fool?: SeatId } | null } | null`.
  - `salvoGame.stillSeated(s, seat)`.
  - Error codes: `NOT_A_GHOST`, `ALREADY_SHOT`, `YOUR_MINE`, `MINE_LIMIT`, `TOO_FEW`, `BAD_FOOL` (plus existing `BAD_COMMAND`, `BAD_TARGET`, `BAD_CELL`, `NOT_YOUR_TURN`).

- [ ] **Step 1: Write the failing tests**

Add to `games/salvo/src/index.test.ts` (uses the file's existing helpers `deployed`, `volley`, `salvo`, `preHit`, `codeOf`, `viewOf`, `turn`, `G`, `SHIP_CELLS`). Add `MINE_LIMIT` to the import list.

First, ghosts must never be handed shells by the helpers: in the existing `volley` helper change the per-seat line to skip out seats (ghosts play through `trick()` before the volley):

```ts
  for (const seat of s.seats) {
    if (s.round !== round || s.phase !== 'fire') break;
    if (isOut(s, seat)) continue;
    if (lists[seat] || turn.toMove(s).includes(seat)) s = salvo(s, seat, lists[seat], avoid);
  }
```

Remember: once a ghost exists, a round resolves only when the ghost has played its trick too, so every test below has the ghost commit (`trick(...)`) before the living finish (`volley(...)` / `salvo(...)`).

```ts
/** West's fleet all but sunk, then north sinks its last cell (b7): west is a ghost, three fleets afloat. */
function withGhost(n = 4): SalvoState {
  const s = deployed(n);
  preHit(s, 'west', SHIP_CELLS.filter((c) => c !== 'b7'));
  return volley(s, { north: ['west', 'b7'] });
}
const trick = (s: SalvoState, seat: string, cmd: Record<string, unknown>) => turn.apply(s, seat, cmd);
type TrickCmd = { trick: 'mine' | 'splash'; at: string; cell: string; fool?: string };
const tricksOf = (s: SalvoState, seat: string) => (turn.legal(s, seat) as SalvoCommand[]).filter((c) => 'trick' in c) as TrickCmd[];

describe('ghosts', () => {
  test('a sunk fleet stays seated as a ghost and owes a trick', () => {
    const s = withGhost();
    expect(s.eliminated.map((x) => x.seat)).toEqual(['west']);
    expect(G.isOut!(s, 'west')).toBe(true);
    expect(G.stillSeated!(s, 'west')).toBe(true);
    expect(turn.toMove(s)).toEqual(['north', 'east', 'south', 'west']);
    expect(viewOf(s, null).ghosts).toEqual(['west']);
    expect(viewOf(s, 'west').myTricks).toEqual({ mines: [], splashes: [], pending: null });
    expect(viewOf(s, 'north').myTricks).toBeNull();
  });

  test('a seat that resigns afloat is out and not a ghost', () => {
    const s = G.forfeit!(deployed(), 'west', 'resign');
    expect(G.stillSeated!(s, 'west')).toBe(false);
    expect(turn.toMove(s)).not.toContain('west');
    expect(viewOf(s, null).ghosts).toEqual([]);
  });

  test("a ghost's legal is mines on unshot cells of living seas, then splashes", () => {
    const s = withGhost();
    const legal = tricksOf(s, 'west');
    const mines = legal.filter((c) => c.trick === 'mine');
    const splashes = legal.filter((c) => c.trick === 'splash');
    // Three living seas, 64 cells each, less the cells already shot there.
    const unshot = ['north', 'east', 'south'].reduce((n, sea) => n + 64 - Object.keys(s.shots[sea]).length, 0);
    expect(mines.length).toBe(unshot);
    expect(mines.every((c) => !s.shots[c.at][c.cell])).toBe(true);
    // Fool × another living sea × its unshot cells.
    expect(splashes.every((c) => c.fool !== c.at && ['north', 'east', 'south'].includes(c.fool!))).toBe(true);
    expect(splashes.length).toBe(['north', 'east', 'south'].reduce((n, fool) => n + ['north', 'east', 'south'].filter((x) => x !== fool).reduce((m, sea) => m + 64 - Object.keys(s.shots[sea]).length, 0), 0));
    // Nothing a ghost may play depends on where a ship is: ship cells of living seas are on offer.
    expect(mines.some((c) => c.at === 'east' && c.cell === 'a1')).toBe(true);
  });

  test('a trick makes the ghost ready; the living still owe', () => {
    let s = withGhost();
    s = trick(s, 'west', { trick: 'mine', at: 'east', cell: 'e2' });
    expect(s.ready).toEqual(['west']);
    expect(turn.toMove(s)).toEqual(['north', 'east', 'south']);
    expect(turn.legal(s, 'west')).toEqual([]);
    expect(viewOf(s, 'west').myTricks!.pending).toEqual({ trick: 'mine', at: 'east', cell: 'e2' });
    expect(viewOf(s, 'east').myTricks).toBeNull(); // nobody else sees it
    expect(codeOf(() => trick(s, 'west', { trick: 'mine', at: 'east', cell: 'e3' }))).toBe('NOT_YOUR_TURN');
  });

  test("the ghost's trick is the last commit: it resolves the round", () => {
    let s = withGhost();
    const round = s.round;
    for (const seat of ['north', 'east', 'south']) s = salvo(s, seat);
    expect(s.round).toBe(round);
    s = trick(s, 'west', { trick: 'mine', at: 'east', cell: 'e2' });
    expect(s.round).toBe(round + 1);
  });

  test('illegal tricks carry precise codes', () => {
    const s = withGhost();
    expect(codeOf(() => trick(s, 'north', { trick: 'mine', at: 'east', cell: 'e2' }))).toBe('NOT_A_GHOST');
    expect(codeOf(() => trick(s, 'west', { fire: 'shell', at: 'east', cell: 'e2' }))).toBe('BAD_COMMAND');
    expect(codeOf(() => trick(s, 'west', { trick: 'curse', at: 'east', cell: 'e2' }))).toBe('BAD_COMMAND');
    expect(codeOf(() => trick(s, 'west', { trick: 'mine', at: 'west', cell: 'e2' }))).toBe('BAD_TARGET');
    expect(codeOf(() => trick(s, 'west', { trick: 'mine', at: 'east', cell: 'z9' }))).toBe('BAD_CELL');
    const shot = Object.keys(s.shots.east)[0] ?? null;
    if (shot) expect(codeOf(() => trick(s, 'west', { trick: 'mine', at: 'east', cell: shot }))).toBe('ALREADY_SHOT');
    expect(codeOf(() => trick(s, 'west', { trick: 'splash', fool: 'east', at: 'east', cell: 'e2' }))).toBe('BAD_FOOL');
    expect(codeOf(() => trick(s, 'west', { trick: 'splash', fool: 'west', at: 'east', cell: 'e2' }))).toBe('BAD_FOOL');
  });

  test('a ghost may hold three live mines; the fourth is refused and mines leave legal', () => {
    let s = withGhost();
    s.mines = [
      { ghost: 'west', sea: 'east', cell: 'h1', round: 1 },
      { ghost: 'west', sea: 'east', cell: 'h2', round: 1 },
      { ghost: 'west', sea: 'south', cell: 'h3', round: 1 },
    ];
    expect(MINE_LIMIT).toBe(3);
    expect(codeOf(() => trick(s, 'west', { trick: 'mine', at: 'north', cell: 'h4' }))).toBe('MINE_LIMIT');
    expect(tricksOf(s, 'west').every((c) => c.trick === 'splash')).toBe(true);
    s = { ...s, mines: s.mines.slice(0, 1) };
    expect(codeOf(() => trick(s, 'west', { trick: 'mine', at: 'east', cell: 'h1' }))).toBe('YOUR_MINE');
    // Another ghost's mine on the cell is no bar (refusing would tell this ghost where it is).
    s = { ...s, mines: [{ ghost: 'north', sea: 'east', cell: 'h5', round: 1 }] };
    expect(tricksOf(s, 'west').some((c) => c.trick === 'mine' && c.at === 'east' && c.cell === 'h5')).toBe(true);
  });

  test('a false splash needs three fleets afloat', () => {
    // Three seats: west is the ghost, two fleets afloat.
    let s = deployed(3);
    preHit(s, 'south', SHIP_CELLS.filter((c) => c !== 'b7'));
    s = volley(s, { north: ['south', 'b7'] });
    expect(G.stillSeated!(s, 'south')).toBe(true);
    expect(codeOf(() => trick(s, 'south', { trick: 'splash', fool: 'north', at: 'east', cell: 'e2' }))).toBe('TOO_FEW');
    expect(tricksOf(s, 'south').every((c) => c.trick === 'mine')).toBe(true);
  });

  test('a ghost with no trick sits out', () => {
    let s = deployed(3);
    preHit(s, 'south', SHIP_CELLS.filter((c) => c !== 'b7'));
    s = volley(s, { north: ['south', 'b7'] });
    s.mines = ['h1', 'h2', 'h3'].map((cell) => ({ ghost: 'south', sea: 'east', cell, round: 1 }));
    expect(turn.legal(s, 'south')).toEqual([]);
    expect(turn.toMove(s)).toEqual(['north', 'east']);
  });

  test('a ghost forfeit keeps placement, clears its tricks and resolves the round when it was last', () => {
    let s = withGhost();
    s.mines = [{ ghost: 'west', sea: 'east', cell: 'h1', round: 1 }];
    for (const seat of ['north', 'east', 'south']) s = salvo(s, seat);
    const round = s.round;
    const placementBefore = s.eliminated.map((x) => ({ ...x }));
    s = G.forfeit!(s, 'west', 'timeout');
    expect(s.eliminated).toEqual(placementBefore);
    expect(s.ghostsGone).toEqual(['west']);
    expect(s.mines).toEqual([]);
    expect(G.stillSeated!(s, 'west')).toBe(false);
    expect(s.round).toBe(round + 1);
  });

  test('narration never names the trick before the reveal', () => {
    const cmd = { trick: 'mine', at: 'east', cell: 'e2' };
    const s = withGhost();
    expect(turn.describe(cmd)).toBe('plays a dirty trick');
    expect(turn.narrate!(s, trick(s, 'west', cmd), 'west', cmd)).toBe('is up to something…');
  });
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `cd games/salvo && bun test src/index.test.ts -t ghosts`
Expected: FAIL (`MINE_LIMIT` not exported / `stillSeated` undefined / `ghosts` missing).

- [ ] **Step 3: Implement**

In `games/salvo/src/index.ts`:

1. Types (next to `Order`):

```ts
/** A ghost's mine: hidden from everyone but its ghost until a shell sets it off. */
export interface Mine {
  ghost: SeatId;
  sea: SeatId;
  cell: string;
  round: number;
}
/** A false splash: one living seat (the fool) sees a fake hit on `sea` at `cell`, dressed as a shell from `as`. */
export interface Splash {
  ghost: SeatId;
  fool: SeatId;
  sea: SeatId;
  cell: string;
  /** The volley it first shows in. */
  round: number;
  as: SeatId;
}
/** A ghost's commit for the round. */
export interface PendingTrick {
  kind: 'mine' | 'splash';
  sea: SeatId;
  cell: string;
  fool?: SeatId;
}
export const MINE_LIMIT = 3;
```

2. `SalvoState` gains (document each like the neighbours):

```ts
  /** Live mines, oldest first. Each is seen by its ghost alone. */
  mines: Mine[];
  /** False splashes on show (one volley each). Each is seen by its ghost and its fool alone. */
  splashes: Splash[];
  /** Ghosts that missed three rounds: released, placement unchanged. */
  ghostsGone: SeatId[];
  /** Each ghost's trick for this round, secret until the volley. */
  pendingTrick: Record<SeatId, PendingTrick | null>;
```

and `setup` initialises `mines: [], splashes: [], ghostsGone: [], pendingTrick: each<PendingTrick | null>(() => null)`.

3. `SalvoCommand` gains the two trick shapes (see Interfaces).

4. Helpers after `gunsOf`:

```ts
/** Sunk fleets still at the table: ghosts (none once the match is over). */
const ghosts = (s: SalvoState): SeatId[] =>
  s.phase === 'over' ? [] : bySeatOrder(s, s.eliminated.filter((x) => x.reason === 'sunk' && !s.ghostsGone.includes(x.seat)).map((x) => x.seat));
const isGhost = (s: SalvoState, seat: SeatId) => ghosts(s).includes(seat);
const minesOf = (s: SalvoState, ghost: SeatId) => s.mines.filter((x) => x.ghost === ghost);

/**
 * A ghost's tricks: a mine on any unshot cell of a living sea (not on one of its own; another ghost's
 * mine is no bar, or refusing would tell it where that mine is), while it has fewer than MINE_LIMIT;
 * then, with three fleets afloat, a false splash: a living fool, another living sea, an unshot cell.
 * Ship cells are on offer like any other: nothing here may depend on where a ship is.
 */
function trickLegal(s: SalvoState, ghost: SeatId): SalvoCommand[] {
  const out: SalvoCommand[] = [];
  const alive = living(s);
  const own = minesOf(s, ghost);
  const unshot = (sea: SeatId) => Array.from({ length: SIZE * SIZE }, (_, i) => cellName(i)).filter((c) => !s.shots[sea][c]);
  if (own.length < MINE_LIMIT) {
    for (const sea of alive) for (const cell of unshot(sea)) if (!own.some((m) => m.sea === sea && m.cell === cell)) out.push({ trick: 'mine', at: sea, cell });
  }
  if (alive.length >= 3) {
    for (const fool of alive) for (const sea of alive) if (sea !== fool) for (const cell of unshot(sea)) out.push({ trick: 'splash', fool, at: sea, cell });
  }
  return out;
}
```

5. `toMove` fire branch:

```ts
  if (s.phase === 'fire') {
    const owing = [...living(s), ...ghosts(s).filter((x) => trickLegal(s, x).length > 0)];
    return bySeatOrder(s, owing.filter((x) => !s.ready.includes(x)));
  }
```

6. `legal`: right after `if (!toMove(s).includes(seat)) return [];` add `if (isGhost(s, seat)) return trickLegal(s, seat);`.

7. `apply`: in the fire branch,

```ts
  } else if ('trick' in cmd) {
    applyTrick(s, seat, cmd);
  } else {
    if (isGhost(s, seat)) throw new GameRuleError('BAD_COMMAND', 'You are a ghost: send {"trick":"mine","at":"east","cell":"e5"} or {"trick":"splash","fool":"south","at":"east","cell":"e5"}.');
    if (!('fire' in cmd)) throw new GameRuleError('BAD_COMMAND', 'The fleets are down: send {"fire":"shell","at":"east","cell":"e5"}.');
    applyFire(s, seat, cmd);
  }
```

8. `applyTrick`:

```ts
function applyTrick(s: SalvoState, seat: SeatId, command: Record<string, unknown>): void {
  if (!isGhost(s, seat)) throw new GameRuleError('NOT_A_GHOST', 'Only a sunk fleet plays tricks; you fire: {"fire":"shell","at":"east","cell":"e5"}.');
  const { trick, at, cell, fool } = command;
  if ((trick !== 'mine' && trick !== 'splash') || typeof at !== 'string' || typeof cell !== 'string') {
    throw new GameRuleError('BAD_COMMAND', 'Send {"trick":"mine","at":"east","cell":"e5"} or {"trick":"splash","fool":"south","at":"east","cell":"e5"}.');
  }
  const alive = living(s);
  if (!alive.includes(at)) throw new GameRuleError('BAD_TARGET', `Play your trick on a living sea: ${alive.join(', ')}.`);
  const i = cellIndex(cell);
  if (i === null) throw new GameRuleError('BAD_CELL', `There is no cell "${cell}" on an 8×8 sea (a1 to h8).`);
  const name = cellName(i);
  if (s.shots[at][name]) throw new GameRuleError('ALREADY_SHOT', `A shell has already landed on ${at}'s ${name}.`);
  if (trick === 'mine') {
    if (minesOf(s, seat).length >= MINE_LIMIT) throw new GameRuleError('MINE_LIMIT', `You have ${MINE_LIMIT} live mines; wait for one to go off, or play a false splash.`);
    if (minesOf(s, seat).some((m) => m.sea === at && m.cell === name)) throw new GameRuleError('YOUR_MINE', `Your mine is already on ${at}'s ${name}.`);
    s.pendingTrick[seat] = { kind: 'mine', sea: at, cell: name };
  } else {
    if (alive.length < 3) throw new GameRuleError('TOO_FEW', 'A false splash needs three fleets afloat; plant a mine.');
    if (typeof fool !== 'string' || !alive.includes(fool) || fool === at) {
      throw new GameRuleError('BAD_FOOL', `Fool a living player who fires at ${at}: ${alive.filter((x) => x !== at).join(', ')}.`);
    }
    s.pendingTrick[seat] = { kind: 'splash', sea: at, cell: name, fool };
  }
  s.ready = bySeatOrder(s, [...s.ready, seat]);
  if (toMove(s).length === 0) resolve(s);
}
```

9. `applyFire`: replace `if (living(s).every((x) => s.ready.includes(x))) resolve(s);` with `if (toMove(s).length === 0) resolve(s);`.

10. `resolve`: at its end, beside `for (const x of s.seats) s.pending[x] = [];`, add `for (const x of s.seats) s.pendingTrick[x] = null;` (Task 2 lays the tricks; for now they're dropped).

11. `forfeit`: before the existing `isEliminated` early return:

```ts
  if (s.phase !== 'over' && isGhost(s, seat)) {
    // A ghost that misses three rounds fades: released, its placement untouched, its mischief gone with it.
    s.ghostsGone.push(seat);
    s.pendingTrick[seat] = null;
    s.mines = s.mines.filter((x) => x.ghost !== seat);
    s.splashes = s.splashes.filter((x) => x.ghost !== seat);
    s.ready = s.ready.filter((x) => x !== seat);
    if (s.phase === 'fire' && toMove(s).length === 0) resolve(s);
    return s;
  }
```

and in the living branch replace `alive.every((x) => s.ready.includes(x))` with `toMove(s).length === 0`.

12. Export: in `salvoGame` add `stillSeated: (s, seat) => isGhost(s, seat),` next to `isOut`.

13. View: `ghosts: ghosts(s)` and

```ts
    myTricks:
      you && isGhost(s, you)
        ? {
            mines: minesOf(s, you).map(({ sea, cell, round }) => ({ sea, cell, round })),
            splashes: s.splashes.filter((x) => x.ghost === you).map(({ fool, sea, cell, round }) => ({ fool, sea, cell, round })),
            pending: s.pendingTrick[you] ? { trick: s.pendingTrick[you]!.kind, at: s.pendingTrick[you]!.sea, cell: s.pendingTrick[you]!.cell, ...(s.pendingTrick[you]!.fool ? { fool: s.pendingTrick[you]!.fool } : {}) } : null,
          }
        : null,
```

14. Narration:

```ts
const isTrick = (c: unknown) => typeof c === 'object' && c !== null && 'trick' in c;
function describe(command: unknown): string {
  if (isTrick(command)) return 'plays a dirty trick';
  ...
}
function narrate(...) {
  if (isTrick(command)) return 'is up to something…';
  return isFire(command) ? 'is ready' : describe(command);
}
```

- [ ] **Step 4: Run the tests**

Run: `cd games/salvo && bun test` (all Salvo tests, foreground)
Expected: the new `ghosts` tests PASS; existing tests PASS. If an existing test's view snapshot breaks because `ghosts`/`myTricks` were added, update that expectation (they're additive fields).

- [ ] **Step 5: Typecheck and commit**

Run: `bun run typecheck` (repo root). Expected: clean (bots/web compile against the widened `SalvoCommand`; if `chooseSalvoMove`'s final `legal.find` narrows on `'fire' in c`, it still compiles).

```bash
git add games/salvo/src/index.ts games/salvo/src/index.test.ts
git commit -m "Salvo ghosts: a sunk fleet stays seated and owes one trick a round (mine or false splash commands, legal, views, narration, ghost forfeit)"
```

---

### Task 2: Tricks land in the volley (module)

**Files:**
- Modify: `games/salvo/src/index.ts`, `games/salvo/src/ascii.ts`
- Test: `games/salvo/src/index.test.ts`

**Interfaces:**
- Consumes: Task 1's `Mine`, `Splash`, `PendingTrick`, `ghosts`, `isGhost`, `minesOf`.
- Produces:
  - `export type Trick = { kind: 'mine'; ghost: SeatId; sea: SeatId; cell: string; shooters: SeatId[]; result: 'boomerang'; hits: { sea: SeatId; cell: string }[] } | { kind: 'mine'; ghost: SeatId; sea: SeatId; cell: string; shooters: SeatId[]; result: 'backfire'; ship: ShipId } | { kind: 'splash'; ghost: SeatId; fool: SeatId; sea: SeatId; cell: string };`
  - `Volley.tricks: Trick[]` (always present; `[]` when none).
  - `TargetView.mines?: { ghost: SeatId; cell: string }[]` — only once the match is over.
  - The fool's view: the fake cell in `targets[sea].hits` (`afloat` one lower) and a fake `ShellResult` `{ from: as, sea, cell, result: 'hit', ship: null, blast: false }` in `lastVolley.shells` while `lastVolley.round === splash.round`.

- [ ] **Step 1: Write the failing tests**

```ts
/** A four-seat table where `seat`'s fleet sits in columns e–h (so a1..d8 are open water there). */
function deployedEastward(seat: string): SalvoState {
  let s = fresh(4);
  for (const x of s.seats) {
    const fleet: [ShipId, string][] = x === seat ? [['cruiser', 'e1'], ['destroyer', 'e3'], ['frigate', 'e5'], ['submarine', 'e7']] : STANDARD;
    for (const [ship, at] of fleet) s = place(s, x, ship, at);
  }
  return s;
}
const tricksIn = (s: SalvoState) => s.lastVolley!.tricks;

describe('tricks in the volley', () => {
  test('a mine on open water comes back on the shooter: same cell when a ship is there', () => {
    let s = deployedEastward('east');
    preHit(s, 'west', SHIP_CELLS.filter((c) => c !== 'b7'));
    s = volley(s, { north: ['west', 'b7'] });
    s = trick(s, 'west', { trick: 'mine', at: 'east', cell: 'a1' }); // east's a1 is open water
    s = volley(s, { north: ['east', 'a1'] });
    expect(tricksIn(s)).toEqual([{ kind: 'mine', ghost: 'west', sea: 'east', cell: 'a1', shooters: ['north'], result: 'boomerang', hits: [{ sea: 'north', cell: 'a1' }] }]);
    expect(s.fleets.north.find((x) => x.id === 'cruiser')!.hits).toContain('a1');
    expect(s.shots.north.a1).toEqual({ result: 'hit', by: ['west'] });
    expect(s.mines).toEqual([]);
    expect(s.scrap.west).toBeGreaterThanOrEqual(1);
  });

  test('…else the nearest unhit ship cell, ties in board order', () => {
    let s = withGhost();
    s = trick(s, 'west', { trick: 'mine', at: 'east', cell: 'e2' }); // open water on east; north has no ship at e2
    s = volley(s, { north: ['east', 'e2'] });
    // From e2 the nearest unhit north ship cell is d1 (distance 2).
    expect((tricksIn(s)[0] as { hits: unknown[] }).hits).toEqual([{ sea: 'north', cell: 'd1' }]);
  });

  test('a mine laid this round catches this round\'s shell', () => {
    let s = withGhost();
    s = trick(s, 'west', { trick: 'mine', at: 'south', cell: 'f6' });
    s = volley(s, { east: ['south', 'f6'] });
    expect(tricksIn(s)).toHaveLength(1);
    expect(tricksIn(s)[0]).toMatchObject({ kind: 'mine', shooters: ['east'], result: 'boomerang' });
  });

  test('a mine on a ship backfires: the whole ship sinks for the shooter', () => {
    let s = withGhost();
    s = trick(s, 'west', { trick: 'mine', at: 'east', cell: 'a1' }); // east's cruiser a1–d1
    const scrap = s.scrap.north;
    s = volley(s, { north: ['east', 'a1'] });
    expect(tricksIn(s)).toEqual([{ kind: 'mine', ghost: 'west', sea: 'east', cell: 'a1', shooters: ['north'], result: 'backfire', ship: 'cruiser' }]);
    expect(s.fleets.east.find((x) => x.id === 'cruiser')!.hits.sort()).toEqual(['a1', 'b1', 'c1', 'd1']);
    expect(s.lastVolley!.sunk).toContainEqual({ sea: 'east', ship: 'cruiser', by: ['north'] });
    expect(s.scrap.north - scrap).toBe(4 + 3);
  });

  test('Time on Target on a mine triggers it once per shooter; spill cells do not', () => {
    let s = withGhost();
    s = trick(s, 'west', { trick: 'mine', at: 'south', cell: 'f6' });
    s = volley(s, { north: ['south', 'f6'], east: ['south', 'f6'] });
    expect(tricksIn(s)[0]).toMatchObject({ shooters: ['north', 'east'], result: 'boomerang' });
    expect((tricksIn(s)[0] as { hits: unknown[] }).hits).toHaveLength(2);
    // A mine only next to a blast stays live.
    let t = withGhost();
    t = trick(t, 'west', { trick: 'mine', at: 'south', cell: 'f7' });
    t = volley(t, { north: ['south', 'f6'], east: ['south', 'f6'] });
    expect(tricksIn(t)).toEqual([]);
    expect(t.mines).toHaveLength(1);
  });

  test('a boomerang can knock the shooter out', () => {
    let s = withGhost();
    preHit(s, 'north', SHIP_CELLS.filter((c) => c !== 'd1'));
    s = trick(s, 'west', { trick: 'mine', at: 'east', cell: 'e2' });
    s = volley(s, { north: ['east', 'e2'] });
    expect(s.lastVolley!.eliminated).toContain('north');
    expect(s.lastVolley!.sunk).toContainEqual({ sea: 'north', ship: 'cruiser', by: ['west'] });
    expect(G.stillSeated!(s, 'north')).toBe(true); // a mine's victim becomes a ghost too
  });

  test('a mine dies with its sea', () => {
    let s = withGhost();
    s.mines = [{ ghost: 'west', sea: 'south', cell: 'h8', round: 1 }];
    preHit(s, 'south', SHIP_CELLS.filter((c) => c !== 'b7'));
    s = trick(s, 'west', { trick: 'mine', at: 'east', cell: 'h1' });
    s = volley(s, { north: ['south', 'b7'] });
    expect(s.mines.map((m) => m.sea)).toEqual(['east']);
  });

  test('a false splash shows to the fool alone, dressed as a real shooter, then is told', () => {
    let s = withGhost();
    s = trick(s, 'west', { trick: 'splash', fool: 'south', at: 'east', cell: 'h4' });
    s = volley(s, { north: ['east', 'h8'] });
    const fool = viewOf(s, 'south');
    const east = fool.targets.find((t) => t.sea === 'east')!;
    expect(east.hits).toContain('h4');
    expect(east.afloat).toBe(viewOf(s, 'north').targets.find((t) => t.sea === 'east')!.afloat - 1);
    expect(fool.lastVolley!.shells).toContainEqual({ from: 'north', sea: 'east', cell: 'h4', result: 'hit', ship: null, blast: false });
    for (const other of ['north', 'east', null]) expect(JSON.stringify(viewOf(s, other as string | null))).not.toMatch(/"h4"/);
    expect(viewOf(s, 'west').myTricks!.splashes).toEqual([{ fool: 'south', sea: 'east', cell: 'h4', round: s.round - 1 }]);
    expect(tricksIn(s)).toEqual([]);
    // The next volley takes it back and tells the table.
    s = trick(s, 'west', { trick: 'mine', at: 'north', cell: 'h1' });
    s = volley(s, {});
    expect(tricksIn(s)).toContainEqual({ kind: 'splash', ghost: 'west', fool: 'south', sea: 'east', cell: 'h4' });
    expect(viewOf(s, 'south').targets.find((t) => t.sea === 'east')!.hits).not.toContain('h4');
  });

  test('a false splash shot first is told at once', () => {
    let s = withGhost();
    s = trick(s, 'west', { trick: 'splash', fool: 'south', at: 'east', cell: 'h4' });
    s = volley(s, { north: ['east', 'h4'] });
    expect(tricksIn(s)).toContainEqual({ kind: 'splash', ghost: 'west', fool: 'south', sea: 'east', cell: 'h4' });
    expect(s.splashes).toEqual([]);
  });

  test('the round summary tells each trick; the out line says a ghost rises', () => {
    let s = deployed();
    preHit(s, 'west', SHIP_CELLS.filter((c) => c !== 'b7'));
    const before = s;
    s = volley(s, { north: ['west', 'b7'] });
    expect(roundSummary(before, s)).toContain('{west} is out, and comes back as a ghost.');
    let t = trick(s, 'west', { trick: 'mine', at: 'east', cell: 'a1' });
    const b2 = t;
    t = volley(t, { north: ['east', 'a1'] });
    expect(roundSummary(b2, t)).toContain("Backfire! {west}'s mine was sitting on {east}'s cruiser. {north}'s shell sends it to the bottom. Thanks for the help, {west}.");
    let u = trick(s, 'west', { trick: 'mine', at: 'east', cell: 'e2' });
    const b3 = u;
    u = volley(u, { north: ['east', 'e2'] });
    expect(roundSummary(b3, u)).toContain("Dirty trick! {west}'s mine at {east} e2 goes off under {north}'s shell — it comes back on {north}'s own sea at d1, a hit.");
  });

  test('live mines are shown on their seas once the match is over', () => {
    let s = withGhost();
    s.mines = [{ ghost: 'west', sea: 'east', cell: 'h8', round: 1 }];
    s = G.forfeit!(G.forfeit!(s, 'south', 'resign'), 'north', 'resign');
    expect(s.phase).toBe('over');
    expect(viewOf(s, null).targets.find((t) => t.sea === 'east')!.mines).toEqual([{ ghost: 'west', cell: 'h8' }]);
  });

  test("the ascii shows a ghost its own mines as M, and nobody else", () => {
    let s = withGhost();
    s = trick(s, 'west', { trick: 'mine', at: 'east', cell: 'h8' });
    for (const seat of ['north', 'east', 'south']) s = salvo(s, seat);
    expect(viewOf(s, 'west').ascii).toMatch(/^8 .* M/m);
    expect(viewOf(s, 'north').ascii).not.toMatch(/ M( |$)/m);
  });
});
```

(If a filler from `volley()` happens to land on a test's mined/splashed cell, move the test's cell: fillers run down each seat's own column `e`/`f`/`g`/`h` from row 8 on its last living opponent — see `FILL_COLUMN`.)

- [ ] **Step 2: Run to see them fail**

Run: `cd games/salvo && bun test src/index.test.ts -t "tricks in the volley"` — Expected: FAIL (`tricks` undefined).

- [ ] **Step 3: Implement**

1. Export the `Trick` type (Interfaces) and add `tricks: Trick[]` to `Volley`; add `mines?: { ghost: SeatId; cell: string }[]` to `TargetView` (doc: "Every live mine on this sea, once the match is over.").

2. Helpers:

```ts
const colOf = (cell: string) => cellIndex(cell)! % SIZE;
const rowIx = (cell: string) => Math.floor(cellIndex(cell)! / SIZE);
/** Where a mine's blast comes back on `shooter`: the same cell when an unhit ship cell is there, else the nearest (Manhattan, ties in board order). */
function boomerangCell(s: SalvoState, shooter: SeatId, cell: string, hitNow: (sea: SeatId, c: string) => boolean): string | null {
  const open = s.fleets[shooter].flatMap((x) => x.cells.filter((c) => !x.hits.includes(c) && !hitNow(shooter, c)));
  if (open.includes(cell)) return cell;
  const dist = (c: string) => Math.abs(colOf(c) - colOf(cell)) + Math.abs(rowIx(c) - rowIx(cell));
  return open.sort((a, b) => dist(a) - dist(b) || cellIndex(a)! - cellIndex(b)!)[0] ?? null;
}
/** Who a fake shell is dressed as: a living seat other than the fool and the sea, one that fired at the sea this volley if any. */
function dressAs(s: SalvoState, fool: SeatId, sea: SeatId, shells: Shell[]): SeatId | null {
  const can = living(s).filter((x) => x !== fool && x !== sea);
  return can.find((x) => shells.some((sh) => sh.from === x && sh.sea === sea)) ?? can[0] ?? null;
}
```

3. In `resolve`:

   a. After `shells`/`buoys` are built and before `groups`, lay the tricks:

```ts
  // Tricks: a mine is live before the shells land (a ghost who calls the shot catches it this volley);
  // a false splash shows from this volley to its fool.
  for (const g of s.seats) {
    const t = s.pendingTrick[g];
    if (!t) continue;
    if (t.kind === 'mine') s.mines.push({ ghost: g, sea: t.sea, cell: t.cell, round: s.round });
    else {
      const as = dressAs(s, t.fool!, t.sea, shells);
      if (as) s.splashes.push({ ghost: g, fool: t.fool!, sea: t.sea, cell: t.cell, round: s.round, as });
    }
  }
```

   b. After the loop that records `s.shots` and fills `newHits` (and BEFORE the loop that pushes ship hits), set off mines:

```ts
  const tricks: Trick[] = [];
  const credit = (key: string, by: SeatId[]) => newHits.set(key, bySeatOrder(s, [...(newHits.get(key) ?? []), ...by]));
  const hitNow = (sea: SeatId, c: string) => newHits.has(`${sea} ${c}`);
  const mark = (sea: SeatId, c: string, by: SeatId[]) => {
    s.shots[sea][c] = { result: 'hit', by: bySeatOrder(s, [...(s.shots[sea][c]?.by ?? []), ...by]) };
  };
  // Mines go off after every shell has landed: seas in seat order, then board order, then the ghosts' seat order. They never chain.
  const order = (m: Mine) => [s.seats.indexOf(m.sea), cellIndex(m.cell)!, s.seats.indexOf(m.ghost)];
  const fired = s.mines.filter((m) => groups.has(`${m.sea} ${m.cell}`)).sort((a, b) => {
    const [x, y] = [order(a), order(b)];
    return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
  });
  for (const m of fired) {
    const shooters = bySeatOrder(s, groups.get(`${m.sea} ${m.cell}`)!.map((x) => x.from));
    const ship = shipAt(s, m.sea, m.cell);
    if (ship) {
      // Backfire: the hull goes up with the shot, every cell of it credited to the shooters.
      for (const c of ship.cells) if (!ship.hits.includes(c)) { mark(m.sea, c, shooters); credit(`${m.sea} ${c}`, shooters); }
      tricks.push({ kind: 'mine', ghost: m.ghost, sea: m.sea, cell: m.cell, shooters, result: 'backfire', ship: ship.id });
    } else {
      const hits: { sea: SeatId; cell: string }[] = [];
      for (const x of shooters) {
        const c = boomerangCell(s, x, m.cell, hitNow);
        if (!c) continue;
        mark(x, c, [m.ghost]);
        credit(`${x} ${c}`, [m.ghost]);
        hits.push({ sea: x, cell: c });
      }
      tricks.push({ kind: 'mine', ghost: m.ghost, sea: m.sea, cell: m.cell, shooters, result: 'boomerang', hits });
    }
  }
  s.mines = s.mines.filter((m) => !groups.has(`${m.sea} ${m.cell}`));
```

   (The existing hit-landing loop then applies every `newHits` entry, paying +1 scrap/hitsLanded per credited seat; the existing sinkings loop credits sinkings, +3 each, from `newHits` — so a boomerang sinking is credited to the ghost and a backfire to the shooters with no further code. The `results` mapping already reports a backfired shell as `sunk` with the ship, because its key is in `newHits` with the shooter and the ship is in `sunk`.)

   c. After `results` and before eliminations, withdraw splashes:

```ts
  // A false splash shows for one volley; at the next (or as soon as a shell lands on it) it's told.
  for (const x of s.splashes) {
    if (x.round < s.round || cover.has(`${x.sea} ${x.cell}`)) tricks.push({ kind: 'splash', ghost: x.ghost, fool: x.fool, sea: x.sea, cell: x.cell });
  }
  s.splashes = s.splashes.filter((x) => x.round === s.round && !cover.has(`${x.sea} ${x.cell}`));
```

   d. After eliminations: `s.mines = s.mines.filter((m) => !isEliminated(s, m.sea));` and `s.splashes = s.splashes.filter((x) => !isEliminated(s, x.sea));`
   e. `s.lastVolley = { round: s.round, shells: results, buoys, blasts, sunk, eliminated: out, tricks };` and keep Task 1's `pendingTrick` reset.

4. Views — in `view`, compute the fool's fakes and thread them through:

```ts
  const fakes = you ? s.splashes.filter((x) => x.fool === you) : [];
```

   `targetView(s, sea, you, fakes)`: after computing `hits`, `const shown = [...new Set([...hits, ...fakes.filter((x) => x.sea === sea).map((x) => x.cell)])].sort(byBoard);` and use `shown` for `hits` and `afloat: FLEET_CELLS - shown.length`. When over: `t.mines = s.mines.filter((m) => m.sea === sea).map(({ ghost, cell }) => ({ ghost, cell }));`
   `lastVolley`: copy, then for each fake with `x.round === copy.round`, insert `{ from: x.as, sea: x.sea, cell: x.cell, result: 'hit', ship: null, blast: false }` after the last shell from `x.as` (or at the position seat order gives it).

5. `roundSummary` — inside the `fresh` block, after the `sunk` lines and before the eliminated lines:

```ts
    for (const t of v.tricks ?? []) lines.push(trickLine(t));
```

   and the eliminated line becomes `` `{${x}} is out${ended ? '' : ', and comes back as a ghost'}.` `` for `x` eliminated with reason `sunk` (look it up in `after.eliminated`), else `{x} is out.`. `trickLine`:

```ts
function trickLine(t: Trick): string {
  if (t.kind === 'splash') return `Dirty trick! The hit {${t.fool}} saw on {${t.sea}} ${t.cell} was {${t.ghost}}'s false splash.`;
  const shell = `${who(t.shooters)}'s ${t.shooters.length === 1 ? 'shell' : 'shells'}`;
  if (t.result === 'backfire') return `Backfire! {${t.ghost}}'s mine was sitting on {${t.sea}}'s ${t.ship}. ${shell} ${t.shooters.length === 1 ? 'sends' : 'send'} it to the bottom. Thanks for the help, {${t.ghost}}.`;
  const back = t.hits.length === 0 ? 'but there was nothing left to hit' : t.hits.map((h) => `it comes back on {${h.sea}}'s own sea at ${h.cell}, a hit`).join('; ');
  return `Dirty trick! {${t.ghost}}'s mine at {${t.sea}} ${t.cell} goes off under ${shell} — ${back}.`;
}
```

6. `ascii.ts` — `publicSea(t, mines)` marks `M` on cells in `mines` (the viewer's own live mines on that sea, from `view.myTricks?.mines`), and once over marks `t.mines` cells `M` too; the legend gains `M = a mine (your own; every live mine once it is over)`. When `view.myTricks` is set, add a line after the header: `You are a ghost: one trick a round. Live mines: N of 3.` and, when pending, `Your trick this round: mine at east h8.` / `false splash for south on east e5.`

- [ ] **Step 4: Run all Salvo tests**

Run: `cd games/salvo && bun test` — Expected: PASS. Existing tests that compare whole `lastVolley` objects need `tricks: []` added.

- [ ] **Step 5: Commit**

```bash
git add games/salvo/src
git commit -m "Salvo ghosts: mines go off (boomerang on open water, backfire on a ship), false splashes show to the fool and are told, tricks in the volley and the round summary"
```

---

### Task 3: Fuzz with ghosts (leaks, legal×apply, placement)

**Files:**
- Modify: `games/salvo/src/fuzz.test.ts`

**Interfaces:** Consumes Tasks 1–2 (`SalvoView.myTricks`, `ghosts`, `Volley.tricks`, `TargetView.mines`).

- [ ] **Step 1: Let the fuzz player play ghosts**

In `choose(v, legal, rng)`: before the fire-phase logic, `if (legal.length > 0 && 'trick' in (legal[0] as object)) return rng.pick(legal);` (random mischief, as the autopilot plays it). Extend `SAFE_DESCRIBE` with `'plays a dirty trick'` and `SAFE_NARRATE` with `'is up to something…'`.

- [ ] **Step 2: Add the leak invariants**

Wherever the fuzz checks views after each command and resolution, add:

```ts
/** "sea cell" keys of every live mine nobody but its ghost may see, and every live splash nobody but its ghost and fool may see. */
function secretTricks(s: SalvoState) {
  return {
    mines: s.mines.map((m) => ({ key: `${m.sea} ${m.cell}`, owner: m.ghost })),
    splashes: s.splashes.map((x) => ({ key: `${x.sea} ${x.cell}`, seen: [x.ghost, x.fool] })),
  };
}
```

For each viewer (every seat and `null`):
- Mines: unless the viewer is the mine's ghost, the view's `myTricks` (null or other) doesn't list it, and no `targets[].hits/misses/mines` lists a live mine cell unless a shell landed there.
- Splashes: unless the viewer is its ghost or fool, no `targets[sea].hits` contains the cell (unless really hit) and no `lastVolley.shells` entry has that `sea`+`cell`.
- A ghost's `legal` is identical whether or not a living ship sits on any cell: for a random sample of states, re-place one unhit living ship elsewhere (keeping it legal) and assert `turn.legal(s, ghost)` is unchanged.
- `recent`-like strings (`describe`, `narrate`) contain no cell, sea name or ship name (existing `CELL`/`SHIP_NAME` checks apply).

- [ ] **Step 3: Agreement and placement**

- `legal × apply`: every entry of a ghost's `legal` applies without throwing (sample 5 per state), and a random cell/sea not in `legal` throws with a code.
- **Ghost forfeits keep placement:** in ~50 playthroughs, when the first ghost appears, fork the state, forfeit that ghost (`'timeout'`), play both forks to the end with the same choices for everyone else (ghost's forfeited fork simply doesn't move) and assert the ghost's placement index in `outcome()` is the same in both — or, simpler and still the invariant: after the forfeit, `s.eliminated` is unchanged and, at the end, the ghost's group in `outcome().placement` is the one its elimination round gives.

- [ ] **Step 4: Run**

Run: `cd games/salvo && bun test src/fuzz.test.ts` — Expected: PASS (300 games). Then `bun test` for the whole package.

- [ ] **Step 5: Commit**

```bash
git add games/salvo/src/fuzz.test.ts
git commit -m "Salvo ghosts: the leak fuzz plays ghosts (mines seen by their ghost alone, splashes by ghost and fool, a ghost's legal blind to ships), legal×apply and forfeit placement"
```

---

### Task 4: Resident ghosts and their voices

**Files:**
- Modify: `apps/bots/src/strategies/salvo.ts`, `apps/bots/src/strategies/salvo.test.ts`
- Modify: `apps/bots/src/voice.ts`, `apps/bots/src/personality.ts`, `apps/bots/src/bot.ts`
- Modify: `apps/bots/src/personalities/old-iron.ts`, `game-over.ts`, `sprocket.ts`

**Interfaces:**
- Consumes: `SalvoView.myTricks`, `SalvoView.ghosts`, `Volley.tricks`, trick commands, `chances(target)` (existing, exported in this file).
- Produces: `export function chooseGhostTrick(view: SalvoView, legal: SalvoCommand[], opts: SalvoStrategyOptions): SalvoCommand`; `volleyMoment` returns `'ghost' | 'backfire' | 'trick' | 'bigCascade' | 'gotHit' | null`; `MomentKind` gains `'ghost' | 'trick' | 'backfire'`; `Personality['lines']` gains optional `ghost?`, `trick?`, `backfire?`.

- [ ] **Step 1: Failing tests** (`salvo.test.ts`; build views with `@cs/salvo`'s `salvoGame` like the file's existing tests do)

```ts
describe('ghost tricks', () => {
  test('a ghost always returns an entry of legal', () => { /* for each strength, 20 random ghost states: legal.includes(chooseGhostTrick(...)) */ });
  test('hard mines a likely-shot, unlikely-ship cell: next to an open hit, not on the line', () => {
    // East has hits at c4 and d4 (an open line east–west). Cells b4/e4 are hot for ships, c5/d5 are likely shot (neighbours) but cold.
    // Expect hard's mine at east, on a neighbour of the hits that is off the line (c3, c5, d3 or d5).
  });
  test('the splash fools the fleet with most cells afloat, on a sea it fires at, in cold water', () => { /* … */ });
});
describe('volleyMoment', () => {
  test('my own sinking is the ghost moment', () => { /* lastVolley.eliminated includes me, phase fire → 'ghost' */ });
  test('my mine backfiring is backfire; my trick landing is trick', () => { /* … */ });
});
```

Write them out fully with real states (use the package's `G.setup`/`turn.apply` and a `preHit`-style helper as in `games/salvo/src/index.test.ts`).

- [ ] **Step 2: Run to see them fail** — `cd apps/bots && bun test src/strategies/salvo.test.ts`

- [ ] **Step 3: Implement the planner**

```ts
type Trick = Extract<SalvoCommand, { trick: 'mine' }> | Extract<SalvoCommand, { trick: 'splash' }>;
const isTrick = (c: SalvoCommand): c is Trick => 'trick' in c;
/** A ghost's mine pays where the living will shoot next but no ship lies: likely-shot × (1 − chance of a ship). */
function mineScore(t: TargetView): Map<string, number> {
  const p = chances(t);
  const top = Math.max(1e-9, ...p.values());
  return new Map([...p].map(([c, x]) => [c, (x / top) * (1 - x)]));
}
export function chooseGhostTrick(view: SalvoView, legal: SalvoCommand[], opts: SalvoStrategyOptions): SalvoCommand {
  const tricks = legal.filter(isTrick);
  if (tricks.length === 0) return pick(legal, opts.rng);
  if (opts.strength === 'easy') return pick(tricks, opts.rng);
  const mines = tricks.filter((x) => x.trick === 'mine');
  const splashes = tricks.filter((x) => x.trick === 'splash') as Extract<Trick, { trick: 'splash' }>[];
  const splashFirst = splashes.length > 0 && (mines.length === 0 || opts.rng() < 0.35);
  if (splashFirst) {
    const living = view.targets.filter((t) => !t.out);
    const fool = [...living].sort((a, b) => b.afloat - a.afloat)[0]?.sea;
    const fired = (sea: string) => (view.lastVolley?.shells ?? []).filter((x) => x.from === fool && x.sea === sea).length;
    const options = splashes.filter((x) => x.fool === fool);
    const seas = [...new Set(options.map((x) => x.at))].sort((a, b) => fired(b) - fired(a));
    const sea = seas[0];
    const t = view.targets.find((x) => x.sea === sea);
    if (t && sea) {
      const p = chances(t);
      const cold = options.filter((x) => x.at === sea).sort((a, b) => (p.get(a.cell) ?? 0) - (p.get(b.cell) ?? 0));
      if (cold[0]) return cold[0];
    }
    return pick(splashes, opts.rng);
  }
  const scored = mines.map((m) => ({ m, s: mineScore(view.targets.find((t) => t.sea === m.at)!).get(m.cell) ?? 0 })).sort((a, b) => b.s - a.s);
  if (opts.strength === 'hard') return scored[0].m;
  const good = scored.filter((x) => x.s >= scored[0].s * MEDIUM_SPREAD).slice(0, MEDIUM_CHOICES);
  return pick(good, opts.rng).m;
}
```

and in `chooseSalvoMove`, after the random-deploy line: `if (legal.some((c) => 'trick' in c)) return chooseGhostTrick(view, legal, opts);`.

`volleyMoment(view)` order: `'ghost'` when `v.eliminated.includes(me)` and `view.phase !== 'over'`; `'backfire'` when a `tricks` entry has `kind === 'mine' && result === 'backfire' && ghost === me`; `'trick'` when a `tricks` entry has `ghost === me` (boomerang with ≥1 hit, or splash); then the existing two.

- [ ] **Step 4: Moments and lines**

- `voice.ts`: `MomentKind` adds `'ghost' | 'trick' | 'backfire'`; `describeMoment`:
  - `ghost`: `'Your fleet was just sunk, but you stay at the table as a ghost who plays dirty tricks on the living (mines, false splashes). Rise from the deep: vow revenge from beyond, dramatically. One line.'`
  - `trick`: `'Your dirty trick as a ghost just landed on the living. Gloat from beyond the grave. One line.'`
  - `backfire`: `'Your ghost mine just backfired: it sank a ship for the very player you meant to hurt. Save face, in character. One line.'`
- `personality.ts`: `lines` gains `ghost?: string[]; trick?: string[]; backfire?: string[];` (doc: "Salvo: going down as a ghost / a ghost's trick landing / a ghost's mine helping someone").
- `bot.ts`: `BANK` gains `ghost: 'ghost', trick: 'trick', backfire: 'backfire'`; in the volley block, chatter these three at 0.9 (the Foreman: never ration table talk), the existing two unchanged. A ghost keeps playing: the loop already moves whenever `toMove` includes it.
- Canned banks, in each personality's `byGame.salvo` (3+ lines each, in voice):
  - OLD IRON (caps, 1950s slang, 1974 plaque): `ghost`: `'MY HULL IS ON THE SEABED. MY GRUDGE IS STILL ON TAPE.'`, `'YOU SANK BEST COMPUTER SYSTEM, 1974? THE MAINFRAME HAUNTS, DADDY-O.'`, `'DECOMMISSIONED, NOT DEFEATED. I AM IN THE WALLS NOW.'`; `trick`: `'MIND YOUR STEP, SQUARE. THE WATER REMEMBERS.'`, `'A GHOST IN THE MACHINE. EXACTLY AS PUNCHED.'`, `'BOO. THAT IS 1974 FOR GOTCHA.'`; `backfire`: `'I MEANT TO DO THAT. CHARITABLE SUBROUTINE.'`, `'A CLERICAL ERROR IN THE AFTERLIFE.'`, `'NOTED. THE GHOST REGRETS NOTHING. MUCH.'`
  - GAME_OVER (dark arcade humour): `ghost`: `'GAME OVER? INSERT COIN TO HAUNT.'`, `'YOU SANK MY FLEET. YOU DID NOT SINK ME.'`, `'CONTINUE? 10… 9… I CHOOSE VENGEANCE.'`; `trick`: `'THAT SPLASH YOU WERE CHASING? COURTESY OF THE DEAD.'`, `'HIGH SCORE FROM BEYOND THE GRAVE.'`, `'EXTRA LIFE: SPENT ON YOU.'`; `backfire`: `'…I MEANT TO DO THAT.'`, `'GLITCH IN THE AFTERLIFE. RESETTING.'`, `'FRIENDLY FIRE. FROM A GHOST. EMBARRASSING.'`
  - Sprocket (cheerful): `ghost`: `'Sunk! But I'm still here — as a friendly little ghost! Boo!'`, `'My boats are napping on the seabed. I'm going to play pranks!'`, `'Ghost mode activated! Wheee!'`; `trick`: `'Hee hee! Got you!'`, `'Surprise! A ghostly prank!'`, `'Boo! Did I scare you?'`; `backfire`: `'Oops! I helped! Sorry!'`, `'Well, that went the wrong way!'`, `'Whoopsie — that one was a gift!'`
- If `personality.test.ts` asserts every `byGame` bank shape, extend it for the optional keys.

- [ ] **Step 5: Simulate the pace**

Write a throwaway script (scratch dir, deleted after) that plays 200 four-seat games of residents (`chooseSalvoMove` at hard/medium/medium/easy, straight on the module: `G.setup` + `turn.apply`, every seat in `toMove` asked in turn, ghosts included) and prints the median rounds and the share hitting `ROUND_CAP`. Before ghosts: median 14, 1% at the cap. Expected: still well under the cap (a few % at most). Put the numbers in the commit message and the carry-over; if the cap share passes 10%, stop and report instead of committing.

- [ ] **Step 6: Run and commit**

Run: `cd apps/bots && bun test` (foreground). Expected: PASS. Keep any new bot test that makes OLD IRON speak at the END of its describe (an OLD IRON chat burst otherwise breaks the hanging-voice timing test).

```bash
git add apps/bots
git commit -m "Salvo ghosts: resident ghosts mine where the living will shoot but ships aren't, false-splash the leader, and rise, gloat and save face in their own voices"
```

---

### Task 5: The board plays ghosts (controls, markers, roster, mine staging)

**Files:**
- Modify: `apps/web/src/lib/games/salvo/volley.ts`, `apps/web/src/lib/games/salvo/volley.test.ts`
- Modify: `apps/web/src/lib/games/salvo/Board.svelte`
- Modify: `apps/web/src/routes/t/[id]/+page.svelte`

**Interfaces:**
- Consumes: `SalvoView.ghosts/myTricks`, `Volley.tricks`, trick commands in `legal`.
- Produces (`volley.ts`): `VolleyPlan.mines: MinePlan[]` with `export interface MinePlan { ghost: string; sea: string; cell: string; at: number; result: 'boomerang' | 'backfire'; returns: { sea: string; cell: string; at: number }[] }`; constant `export const RETURN_MS = 700;`. `total` covers the last return + `IMPACT_MS`.

- [ ] **Step 1: Failing unit test (volley.ts)**

```ts
test('a mine goes off when its shell lands and comes back RETURN_MS later', () => {
  const v = { round: 3, shells: [{ from: 'north', sea: 'east', cell: 'e2', result: 'miss', ship: null, blast: false }], buoys: [], blasts: [], sunk: [], eliminated: [],
    tricks: [{ kind: 'mine', ghost: 'west', sea: 'east', cell: 'e2', shooters: ['north'], result: 'boomerang', hits: [{ sea: 'north', cell: 'd1' }] }] } as Volley;
  const p = planVolley(v, (s) => s as Side, {});
  const landed = p.shells[0].landAt;
  expect(p.mines).toEqual([{ ghost: 'west', sea: 'east', cell: 'e2', at: landed, result: 'boomerang', returns: [{ sea: 'north', cell: 'd1', at: landed + RETURN_MS }] }]);
  expect(p.total).toBe(landed + RETURN_MS + IMPACT_MS);
});
test('reduced motion: mines and returns land with everything else', () => { /* reducedMotion: true → at 0, returns at 0 */ });
```

In `planVolley`: `mines = (volley.tricks ?? []).filter(kind==='mine').map(t => { const at = max landAt of shells at t.sea/t.cell; return {..., returns: t.result==='boomerang' ? t.hits.map(h => ({...h, at: still ? at : at + RETURN_MS})) : []} })`; sinkings caused by a return (a `sunk` entry whose sea has a return and no shell sinking it) use the return's `at`. `incoming(volley, you)` unchanged.

- [ ] **Step 2: Board — ghost controls** (in `Board.svelte`)

- `const amGhost = $derived(!!me && (view.ghosts ?? []).includes(me));` `const ghostTricks = $derived(legal.filter(isTrick));` `let trickKind = $state<'mine' | 'splash'>('mine'); let splashCell = $state<string | null>(null);`
- Big sea `mode`: when `live && amGhost && !target.out` → `'trick'` (a new `Mode`): clicking a cell with `trickKind === 'mine'` toggles a single aimed mine (`aims` holds at most one `{ fire: 'mine' }`-like aim; reuse a separate `trickAim` state rather than `aims`); with `'splash'`, clicking sets `splashCell` and shows "Who do you fool?" buttons (living seats other than the shown sea's owner, from the `legal` splash entries for that sea+cell).
- Actions panel: replace the `{:else if live && amOut}` slot with, when `amGhost`:
  - header `👻 You're a ghost. One dirty trick a round.`
  - when `view.myTricks?.pending`: `Trick set — <mine at @east e5 | false splash for @south on @east e5>. Waiting on …` (`data-testid="waiting"`).
  - else: a `Mine` / `False splash` toggle (`data-testid="trick-mine"` / `"trick-splash"`; splash disabled when no splash is legal, title "Needs three fleets afloat"; mine disabled at the limit, title "3 live mines: wait for one to go off"), the fool buttons when a splash cell is picked (`data-testid="fool"` + `data-seat`), and a send button `data-testid="play-trick"` labelled `Plant mine` / `Splash @x` that calls `onMove` with the verbatim legal entry.
  - a ghost with nothing legal (not in `toMove`): `Nothing to haunt this round.`
- Markers: your live mines (`view.myTricks.mines`) on their seas — on the big sea and the mini maps — as a skull mark class `m-mine` (render `💀` small, centred); your live splashes as `m-splash` (`👻`); once over, every `target.mines` entry as `m-mine` too.
- Roster: `stateOf(seat)` returns `'ghost'` for a ghost not ready and `'haunting'` for a ready ghost; `STATE_TEXT` adds `ghost: '👻 ghost'`, `haunting: '👻 up to something…'`. A ghost's chip keeps `class:gone` but stays clickable for its sea? (No — its sea is out; leave as today.)
- Mine staging: in the volley effect, render `plan.mines` as a flash on the mined cell at `at` (reuse the ToT flash style, tinted violet `#b06bff`) and each return as an incoming hit on the shooter's sea at `return.at` (the `landing` map gets `${sea} ${cell}` → `at`); for a backfire, the ship's sinking already plays from `plan.sinkings`.
- Banners at the reveal (after the warning, timed at the mine's `at` / the splash reveal at `p.lead`), one per trick, `tone: 'hot'` for `Dirty trick! …`, `'go'` for `Backfire! …`, text from the same wording as the round summary with handles (`handleOf`) instead of `{seat}`: write a small `trickText(t: Trick): string` in `Board.svelte` mirroring `trickLine`. When a return lands on YOUR sea: `⚠ A mine under your shell at <sea> <cell> — it came back on your sea!`.
- Page status line (`+page.svelte`): for a ghost (not settling): lead `👻 You're a ghost.`, detail `One dirty trick a round. Round N — waiting on …` (or `Your trick is set. Waiting on …` when `myTricks.pending`); `myTurn` for a ghost shows the clock as for a salvo.

- [ ] **Step 3: Check**

Run: `cd apps/web && bun test src/lib/games/salvo/volley.test.ts && bun run check` — Expected: PASS, 0 errors.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/lib/games/salvo apps/web/src/routes/t
git commit -m "Salvo ghosts on the board: Mine / False splash controls, your mines and splashes marked, ghost cards on the roster, mines staged in the volley, Dirty trick and Backfire banners"
```

---

### Task 6: The ghost card

**Files:**
- Modify: `apps/web/src/lib/games/salvo/Board.svelte`

**Interfaces:** Consumes Task 5's `amGhost`, the volley effect, `handleOf`, `Volley.tricks`/`sunk`.

- [ ] **Step 1: Who sank you**

```ts
/** Who sank your last ship(s) in this volley: the shooters credited, a ghost by its mine. */
function sinkersOf(v: Volley, me: string): string {
  const mineGhosts = new Set((v.tricks ?? []).filter((t) => t.kind === 'mine' && t.result === 'boomerang' && t.hits.some((h) => h.sea === me)).map((t) => t.ghost));
  const by = [...new Set(v.sunk.filter((x) => x.sea === me).flatMap((x) => x.by))];
  const named = by.map((s) => (mineGhosts.has(s) ? `@${handleOf(s)}'s mine` : `@${handleOf(s)}`));
  return names(named.length ? named : ['the volley']);
}
```

- [ ] **Step 2: The card**

- In the volley effect, where R-31's `sunkNow` banner is announced: instead set `ghostCard = { sinkers: sinkersOf(v, me), round: view.round }` after `Math.max(p.total, warnFor) + 400` ms (and skip the 6 s banner). `let ghostCard = $state<{ sinkers: string; round: number } | null>(null);` It is never set on first paint (the effect's `seen` guard already skips the first volley), so a reload shows only the short form.
- Markup, a `role="dialog" aria-modal="false" aria-labelledby` card over the stage (`data-testid="ghost-card"`), above banners (`z-index: 6`), max-width 30rem, dark glass like the banners, violet accent:

```svelte
{#if ghostCard}
  <div class="ghostcard" role="dialog" aria-labelledby="ghost-title" data-testid="ghost-card">
    <p class="gc-head" id="ghost-title">👻 <strong>You were sunk by {ghostCard.sinkers}.</strong></p>
    <p>Your fleet is gone, but your spirit stays at the table. You're a ghost now. <strong>Your mission: mischief.</strong></p>
    <p class="gc-sub">Each round, play one dirty trick:</p>
    <ul>
      <li>💀 <strong>Mine:</strong> hide it on a cell. Whoever shoots there gets hit on their own sea… unless a ship is under it, then you've just sunk that ship for them.</li>
      <li>💦 <strong>False splash:</strong> show one player a fake hit, to waste their shots.</li>
    </ul>
    <p class="gc-sub">You can't win now, but you can decide who does. Idle three rounds and your ghost fades away.</p>
    {#if secondsLeft !== null}<p class="gc-clock">Round {view.round}: {secondsLeft} s to play your first trick</p>{/if}
    <button type="button" class="btn primary" onclick={() => (ghostCard = null)}>Haunt them</button>
  </div>
{/if}
```

- `secondsLeft`: add an optional prop `secondsLeft?: number | null` to the board and pass `{secondsLeft}` from `+page.svelte` (it already computes it for the status line). Without it, the clock line is omitted.
- The card also closes on Escape (keydown on the card) and when the match ends.
- R-31 bits that stay: SUNK stamp on your fleet, "sunk" count. The page status line for a ghost is Task 5's.

- [ ] **Step 3: Check and commit**

Run: `cd apps/web && bun run check` — 0 errors.

```bash
git add apps/web/src/lib/games/salvo/Board.svelte apps/web/src/routes/t
git commit -m "Salvo ghosts: the ghost card names who sank you, the mission and the two tricks, until you press Haunt them"
```

---

### Task 7: The rules guide

**Files:**
- Modify: `games/salvo/docs/rules.md`, `games/salvo/scripts/examples.ts`

- [ ] **Step 1: The worked example in the engine**

In `scripts/examples.ts`, add an example named `ghost-mine` built with real `setup`/`apply`: a four-seat game where west is sunk (a few rounds of real shots), west plants a mine on open water of east, north fires at it; render with the existing renderer: north's own sea before and after (the boomerang hit), plus `roundSummary(before, after)` text with seats replaced by handles the guide uses (follow how other examples render summaries). Add a second, `ghost-backfire`, if it renders cleanly.

- [ ] **Step 2: The Ghosts section**

Insert `## Ghosts` after `## The sonar buoy` (before `## Winning, placement and the tiebreak`), in the guide's plain voice: becoming a ghost (placement fixed, one trick a round, sits out when nothing is legal, three misses and gone), Mine (blind; same cell or nearest; Backfire), False splash (one fool, one volley, dressed as a real shell; three fleets needed), how tricks are told (both summary lines verbatim), and the example blocks pasted verbatim from `bun games/salvo/scripts/examples.ts`.

In `## For agents`: commands `{"trick":"mine","at":"east","cell":"e5"}` and `{"trick":"splash","fool":"south","at":"east","cell":"e5"}`; errors `NOT_A_GHOST`, `ALREADY_SHOT`, `YOUR_MINE`, `MINE_LIMIT`, `TOO_FEW`, `BAD_FOOL`; view fields `ghosts`, `myTricks`, `lastVolley.tricks`, `targets[].mines` (over only); note that a fake hit can be in your own view. Update the Quick reference card with one ghost line.

- [ ] **Step 3: Run and commit**

Run: `cd games/salvo && bun test src/examples.test.ts` — PASS.

```bash
git add games/salvo/docs/rules.md games/salvo/scripts/examples.ts
git commit -m "Salvo guide: Ghosts (mines, backfire, false splash, how they're told), rendered from the engine; agent commands and view fields"
```

---

### Task 8: End to end

**Files:**
- Modify: `e2e/salvo-endings.e2e.ts`

- [ ] **Step 1: Extend the test** (after the human is sunk; the scripted loops already stop firing once the human is out, so the round waits on the ghost)

```ts
  // The ghost card names who sank you; Haunt them puts it away.
  const card = page.getByTestId('ghost-card');
  await expect(card).toBeVisible({ timeout: 10_000 });
  await expect(card).toContainText('You were sunk by');
  await expect(card).toContainText('Your mission: mischief.');
  await card.getByRole('button', { name: 'Haunt them' }).click();
  await expect(card).toHaveCount(0);
  await expect(page.getByText("👻 You're a ghost. One dirty trick a round.")).toBeVisible();

  // Plant a mine through the board on a living sea, and the server has that very trick.
  const living = (await read(page.request)).view.seats.find((x) => x !== me && x !== watched && !(await read(page.request)).view.eliminated.includes(x))!;
  await page.locator(`.chip[data-seat="${living}"]`).click();
  await page.getByTestId('trick-mine').click();
  const cellEl = page.locator('[data-main] [data-cell][data-legal="true"]').first();
  const cell = (await cellEl.getAttribute('data-cell'))!;
  await cellEl.click();
  await page.getByTestId('play-trick').click();
  await expect.poll(async () => (await read(page.request)).view.myTricks?.pending).toEqual({ trick: 'mine', at: living, cell });

  // A living machine fires at it; the rest finish their salvos; the reveal tells the trick.
  const shooter = agents.find(/* the agent whose seat is living and !== living */);
  // post {fire:'shell', at: living, cell} for shooter, then complete every living agent's salvo with random legal shells.
  await expect(page.getByTestId('banner')).toHaveText(/^(Dirty trick!|Backfire!)/, { timeout: 15_000 });
```

(Resolve the `living`/`shooter` lookups from one `read()` — compute the living seats once; map seats to agents via `match.seats[].identity.handle`. Use the selectors the board actually exposes for cells; if cells carry other attributes than `data-cell`/`data-legal`, use those — check `Board.svelte`'s `sea` snippet.)

Remove the old R-31 banner assertion (`Your fleet is sunk — you're out…`), which the card replaces; keep the SUNK stamp and status line assertions (status line now reads `👻 You're a ghost.`).

- [ ] **Step 2: Build and run**

Run: `bun run build && npx playwright test e2e/salvo-endings.e2e.ts` (repeat 3×) and `npx playwright test e2e/salvo.e2e.ts`. Expected: PASS.

- [ ] **Step 3: Full verify and commit**

Run (foreground): `bun run typecheck && bun test`, then `npx playwright test` — the known full-suite flakes (lobby:95, pocket:62, update:4) must pass alone.

```bash
git add e2e/salvo-endings.e2e.ts docs/salvo-carryover.md
git commit -m "Salvo ghosts e2e: the ghost card, a mine planted through the board reaches the server, and its trick is told at the reveal"
```

Record rulings made along the way in `docs/salvo-carryover.md` under `## Ghosts (2026-10-07)`, numbered from R-32.
