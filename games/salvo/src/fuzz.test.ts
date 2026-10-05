import { describe, expect, test } from 'bun:test';
import { createRng, type Rng } from '@cs/game-api';
import {
  SEATS,
  cellIndex,
  liftedRows,
  neighbours,
  renderAscii,
  roundSummary,
  salvoGame as G,
  type SalvoCommand,
  type SalvoState,
  type SalvoView,
} from './index';

const turn = G.turn;
const GAMES = 300;
const CELL = /\b[a-h][1-8]\b/g;
const SHIP_NAME = /cruiser|destroyer|frigate|submarine/g;
const SAFE_DESCRIBE = ['fires', 'deploys a ship', 'deploys the fleet'];
const SAFE_NARRATE = ['is ready', 'deploys a ship', 'deploys the fleet'];
const viewOf = (s: SalvoState, seat: string | null) => G.view(s, seat) as SalvoView;
const isOut = (s: SalvoState, seat: string) => s.eliminated.some((x) => x.seat === seat);
const codeOf = (fn: () => unknown): string | null => {
  try {
    fn();
  } catch (e) {
    return (e as { code?: string }).code ?? 'NO_CODE';
  }
  return null;
};

/**
 * A player that reads only its own view: mostly chases unsunk hits and lifted ships, and otherwise
 * hunts the weakest fleet on a checkerboard, with a dash of pure randomness so every path gets walked.
 */
function choose(v: SalvoView, legal: SalvoCommand[], rng: Rng): SalvoCommand {
  if (v.phase === 'deploy') {
    const random = legal.find((c) => 'place' in c && c.place === 'random')!;
    return rng.next() < 0.5 ? random : rng.pick(legal);
  }
  const shots = legal as { fire: 'shell'; at: string; cell: string }[];
  if (rng.next() < 0.15) return rng.pick(shots);
  const hot: SalvoCommand[] = [];
  for (const t of v.targets) {
    const sunk = new Set(t.sunk.flatMap((x) => x.cells));
    const cells = new Set([
      ...t.hits.filter((c) => !sunk.has(c)).flatMap(neighbours),
      ...t.lifted.flatMap((x) => x.cells).filter((c) => !t.hits.includes(c)),
    ]);
    const known = new Set([...t.hits, ...t.misses]);
    for (const c of shots) if (c.at === t.sea && cells.has(c.cell) && !known.has(c.cell)) hot.push(c);
  }
  if (hot.length > 0) return rng.pick(hot);
  const weakest = [...v.targets].sort((a, b) => a.afloat - b.afloat)[0]?.sea;
  const known = new Set(v.targets.flatMap((t) => [...t.hits, ...t.misses].map((c) => `${t.sea} ${c}`)));
  const hunt = shots.filter(
    (c) => c.at === weakest && !known.has(`${c.at} ${c.cell}`) && (cellIndex(c.cell)! + Math.floor(cellIndex(c.cell)! / 8)) % 2 === 0,
  );
  return rng.pick(hunt.length > 0 ? hunt : shots);
}

/** Every string in a value, depth first. */
function strings(x: unknown, out: string[] = []): string[] {
  if (typeof x === 'string') out.push(x);
  else if (Array.isArray(x)) for (const y of x) strings(y, out);
  else if (x && typeof x === 'object') for (const y of Object.values(x)) strings(y, out);
  return out;
}

/** Ship cells nobody may see yet: unhit, in a ship still afloat, in a row the fog still covers. */
function hiddenCells(s: SalvoState, sea: string): Set<string> {
  const lifted = liftedRows(s.round);
  const out = new Set<string>();
  for (const ship of s.fleets[sea]) {
    if (ship.hits.length === ship.cells.length) continue;
    for (const c of ship.cells) if (!ship.hits.includes(c) && !lifted.includes(Number(c.slice(1)))) out.add(c);
  }
  return out;
}

/** Plain checks inside the hot loops (a bun `expect` per string costs too much over 300 games). */
function check(ok: boolean, what: string): void {
  if (!ok) throw new Error(`leak check failed: ${what}`);
}

/** Review Focus 1: no unrevealed ship cell and no pending aim reaches any view. */
function assertNoLeaks(s: SalvoState, step: number): void {
  const over = s.phase === 'over';
  const viewers = [null, ...s.seats];
  // One viewer per step (rotating) is compared against the same state with every pending shell removed.
  const witness = viewers[step % viewers.length];
  const blank = structuredClone(s);
  for (const x of blank.seats) blank.pending[x] = null;
  for (const seat of viewers) {
    const v = viewOf(s, seat);
    const { ascii, ...rest } = v;
    const where = `round ${s.round}, ${seat ?? 'spectator'}`;
    // Pending shells reach nobody's view, the shooter's own included: the view is the same without them.
    if (seat === witness) {
      check(JSON.stringify(v) === JSON.stringify(viewOf(blank, seat)), `${where}: the view depends on pending`);
      // The drawing is made from the view alone, so it can only say what the view says.
      check(ascii === renderAscii(rest), `${where}: ascii is not drawn from the view`);
    }
    if (seat === null) check(v.mySea === null, `${where}: a spectator has a sea`);
    else check(JSON.stringify(v.mySea!.ships.filter((x) => x.cells.length > 0)) === JSON.stringify(s.fleets[seat]), `${where}: mySea is not my fleet`);
    for (const t of v.targets) {
      check(t.sea !== seat, `${where}: my own sea is a target`);
      if (over) continue;
      check(t.revealed === undefined, `${where}: ${t.sea} revealed while live`);
      check(!isOut(s, t.sea), `${where}: ${t.sea} is out but still a target`);
      const hidden = hiddenCells(s, t.sea);
      for (const str of strings(t)) check(!hidden.has(str), `${where}: hidden ship cell ${t.sea} ${str}`);
    }
    if (v.lastVolley) {
      for (const x of v.lastVolley.shells) check(s.shots[x.sea][x.cell] !== undefined, `${where}: unresolved shell in lastVolley`);
      for (const b of v.lastVolley.blasts) for (const c of b.cells) check(s.shots[b.sea][c] !== undefined, `${where}: unresolved blast cell`);
    }
    // Nothing outside mySea, targets and lastVolley names a cell.
    const { mySea: _m, targets: _t, lastVolley: _l, ...top } = rest;
    for (const str of strings(top)) check(cellIndex(str) === null, `${where}: a cell in the view's top level`);
  }
}

/** The round's story mentions only cells and ships of the volley that just landed. */
function assertSummarySafe(before: SalvoState, after: SalvoState): void {
  const lines = roundSummary(before, after);
  const changed = after.round !== before.round || after.phase !== before.phase;
  if (!changed) {
    check(lines.length === 0, 'a summary inside a round');
    return;
  }
  const v = after.lastVolley;
  const landed = new Set(v ? [...v.shells.map((x) => x.cell), ...v.blasts.flatMap((b) => b.cells)] : []);
  const sunk = new Set<string>(v ? v.sunk.map((x) => x.ship) : []);
  for (const line of lines) {
    for (const cell of line.match(CELL) ?? []) check(landed.has(cell), `summary names ${cell}: ${line}`);
    for (const ship of line.match(SHIP_NAME) ?? []) check(sunk.has(ship), `summary names a ship afloat: ${line}`);
  }
}

interface Tally {
  reasons: Record<string, number>;
  blasts: number;
  knockouts: number;
}

/** One seeded game from setup to outcome, checking everything as it goes. */
function playthrough(g: number, tally: Tally, leaks: boolean): void {
  const n = 2 + (g % 3);
  const rng = createRng(1000 + g);
  let s = G.setup({ seats: SEATS.slice(0, n) as string[], seed: 7 * g + 3 });
  let guard = 0;
  while (!G.outcome(s)) {
    if (++guard > 1000) throw new Error(`game ${g} did not finish`);
    const owing = turn.toMove(s);
    check(owing.length > 0, `game ${g}: nobody owes a move`);
    const before = s;
    if (rng.next() < 0.003) {
      const alive = s.seats.filter((x) => !isOut(s, x));
      s = G.forfeit(s, rng.pick(alive), rng.pick(['resign', 'timeout', 'disconnect']));
    } else {
      const seat = rng.pick(owing);
      const legal = turn.legal(s, seat) as SalvoCommand[];
      check(legal.length > 0, `game ${g}: ${seat} owes a move but has no legal one`);
      if (s.phase === 'fire') check(legal.length <= 200, `game ${g}: legal is ${legal.length} long`);
      // legal × apply: a few other entries apply cleanly too, and a spent cell is refused.
      turn.apply(s, seat, rng.pick(legal));
      const mine = viewOf(s, seat);
      if (s.phase === 'fire') {
        const spent = mine.targets.flatMap((t) => t.mine.map((m) => ({ fire: 'shell', at: t.sea, cell: m.cell })));
        if (spent.length > 0) check(codeOf(() => turn.apply(s, seat, rng.pick(spent))) === 'ALREADY_FIRED', `game ${g}: a spent cell was accepted`);
      }
      const cmd = choose(mine, legal, rng);
      s = turn.apply(s, seat, cmd);
      check(SAFE_DESCRIBE.includes(turn.describe!(cmd)), `describe: ${turn.describe!(cmd)}`);
      check(SAFE_NARRATE.includes(turn.narrate!(before, s, seat, cmd)), `narrate: ${turn.narrate!(before, s, seat, cmd)}`);
    }
    if (guard % 10 === 0) expect(JSON.parse(JSON.stringify(s))).toEqual(s); // plain JSON, no undefined, no Maps
    if (s.lastVolley && s.lastVolley !== before.lastVolley && s.lastVolley.round === before.round) tally.blasts += s.lastVolley.blasts.length;
    if (leaks) {
      assertNoLeaks(s, guard);
      assertSummarySafe(before, s);
    }
  }
  const out = G.outcome(s)!;
  expect(out.winners).toHaveLength(1);
  expect(out.placement[0]).toEqual(out.winners);
  expect(out.placement.flat().sort()).toEqual([...s.seats].sort());
  tally.reasons[out.reason] = (tally.reasons[out.reason] ?? 0) + 1;
  if (out.reason === 'tiebreak') tally.knockouts += 1;
  expect(turn.toMove(s)).toEqual([]);
  for (const seat of s.seats) expect(turn.legal(s, seat)).toEqual([]);
  if (leaks) for (let k = 0; k <= s.seats.length; k++) assertNoLeaks(s, k);
}

/** Mark every cell of a sea's ships hit except `keep` (setup for forced endings). */
function hitAllBut(s: SalvoState, sea: string, keep: string[], by: string): void {
  for (const ship of s.fleets[sea]) {
    ship.hits = ship.cells.filter((c) => !keep.includes(c));
    for (const c of ship.hits) s.shots[sea][c] = { result: 'hit', by: [by] };
  }
}

/** A seeded game with every fleet deployed at random. */
function deployedAtRandom(n: number, seed: number): SalvoState {
  let s = G.setup({ seats: SEATS.slice(0, n) as string[], seed });
  for (const seat of s.seats) s = turn.apply(s, seat, { place: 'random' });
  expect(s.phase).toBe('fire');
  return s;
}

function permutations<T>(xs: T[]): T[][] {
  if (xs.length <= 1) return [xs];
  return xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p]));
}

describe('fuzz', () => {
  const tally: Tally = { reasons: {}, blasts: 0, knockouts: 0 };

  test(`legal × apply agreement, one winner, and no leaks over ${GAMES} games`, () => {
    for (let g = 0; g < GAMES; g++) playthrough(g, tally, true);
    // The fuzz reaches every ending and plenty of Time on Target.
    expect(tally.reasons['last-afloat']).toBeGreaterThan(0);
    expect(tally.blasts).toBeGreaterThan(0);
  }, 60_000);

  test('same-volley knockouts always go through the tiebreak to one winner', () => {
    let forced = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const n = 2 + (seed % 3);
      let s = deployedAtRandom(n, seed);
      // every fleet down to one cell; each seat fires at the next seat's last cell, all in the same volley
      const last: Record<string, string> = {};
      for (const sea of s.seats) {
        last[sea] = s.fleets[sea][seed % 4].cells[0];
        hitAllBut(s, sea, [last[sea]], s.seats.find((x) => x !== sea)!);
      }
      for (let k = 0; k < n; k++) {
        const target = s.seats[(k + 1) % n];
        s = turn.apply(s, s.seats[k], { fire: 'shell', at: target, cell: last[target] });
      }
      const out = G.outcome(s)!;
      expect(out.reason).toBe('tiebreak');
      expect(out.winners).toHaveLength(1);
      expect(out.placement).toEqual([out.winners, s.seats.filter((x) => x !== out.winners[0])]);
      expect(s.lastVolley!.eliminated).toEqual(s.seats);
      forced += 1;
    }
    expect(forced + tally.knockouts).toBeGreaterThan(0);
  });

  test('resolution never depends on commit order: all 24 orders agree', () => {
    let full = 0;
    for (let seed = 1; seed <= 12; seed++) {
      const rng = createRng(seed * 31);
      let s = deployedAtRandom(4, seed);
      // play some rounds so there are hits, sinkings and lifted rows to land on
      const rounds = 3 + (seed % 12);
      while (s.round <= rounds && !G.outcome(s)) {
        for (const seat of turn.toMove(s)) s = turn.apply(s, seat, choose(viewOf(s, seat), turn.legal(s, seat) as SalvoCommand[], rng));
      }
      if (G.outcome(s)) continue;
      const alive = turn.toMove(s);
      const [a, b, c] = alive;
      // c is one cell from sinking a ship of someone else's
      const victim = s.seats.find((x) => x !== c && !isOut(s, x))!;
      const ship = s.fleets[victim].find((x) => x.hits.length < x.cells.length)!;
      const open = ship.cells.find((x) => !ship.hits.includes(x))!;
      ship.hits = ship.cells.filter((x) => x !== open);
      for (const h of ship.hits) s.shots[victim][h] ??= { result: 'hit', by: [victim === a ? b : a] };
      // everyone fires somewhere; a and b share a cell (Time on Target); c finishes the ship
      const shells: Record<string, unknown> = {};
      for (const seat of alive) shells[seat] = rng.pick(turn.legal(s, seat) as SalvoCommand[]);
      const legalB = turn.legal(s, b) as SalvoCommand[];
      const shared = (turn.legal(s, a) as SalvoCommand[]).find((x) => 'fire' in x && legalB.some((y) => 'fire' in y && y.at === x.at && y.cell === x.cell));
      if (shared) shells[a] = shells[b] = shared;
      if (c) shells[c] = { fire: 'shell', at: victim, cell: open };
      const results = permutations(alive).map((order) => {
        let t = s;
        for (const seat of order) t = turn.apply(t, seat, shells[seat]);
        return JSON.stringify(t);
      });
      if (alive.length === 4) full += 1;
      expect(new Set(results).size).toBe(1);
      const after = JSON.parse(results[0]) as SalvoState;
      expect(after.lastVolley!.round).toBe(s.round);
      if (shared) expect(after.lastVolley!.blasts.length).toBeGreaterThan(0);
      if (c) expect(after.lastVolley!.sunk.some((x) => x.sea === victim && x.ship === ship.id)).toBe(true);
    }
    expect(full).toBeGreaterThan(5);
  });
});
