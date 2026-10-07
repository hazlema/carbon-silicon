import { describe, expect, test } from 'bun:test';
import { createRng, type Rng } from '@cs/game-api';
import {
  SEATS,
  cellIndex,
  buoyCells,
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
 * A player that reads only its own view: mostly chases unsunk hits and its sonar readings, drops a
 * buoy now and then, and otherwise hunts the weakest fleet on a checkerboard, with a dash of pure
 * randomness so every path gets walked.
 */
function choose(v: SalvoView, legal: SalvoCommand[], rng: Rng): SalvoCommand {
  if (v.phase === 'deploy') {
    const random = legal.find((c) => 'place' in c && c.place === 'random')!;
    return rng.next() < 0.5 ? random : rng.pick(legal);
  }
  const fired = legal as { fire: 'shell' | 'buoy'; at: string; cell: string }[];
  if (rng.next() < 0.15) return rng.pick(fired);
  const buoys = fired.filter((c) => c.fire === 'buoy');
  if (buoys.length > 0 && rng.next() < 0.1) return rng.pick(buoys);
  const shots = fired.filter((c) => c.fire === 'shell');
  const hot: SalvoCommand[] = [];
  for (const t of v.targets) {
    const sunk = new Set(t.sunk.flatMap((x) => x.cells));
    const cells = new Set([
      ...t.hits.filter((c) => !sunk.has(c)).flatMap(neighbours),
      ...t.sonar.filter((x) => x.afloat > 0).flatMap((x) => x.cells),
    ]);
    const known = new Set([...t.hits, ...t.misses]);
    for (const c of shots) if (c.at === t.sea && cells.has(c.cell) && !known.has(c.cell)) hot.push(c);
  }
  if (hot.length > 0) return rng.pick(hot);
  const weakest = v.targets.filter((t) => !t.out).sort((a, b) => a.afloat - b.afloat)[0]?.sea;
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

/** Ship cells nobody may see yet: unhit, in a ship still afloat (the fog and the sonar only count them). */
function hiddenCells(s: SalvoState, sea: string): Set<string> {
  const out = new Set<string>();
  for (const ship of s.fleets[sea]) {
    if (ship.hits.length === ship.cells.length) continue;
    for (const c of ship.cells) if (!ship.hits.includes(c)) out.add(c);
  }
  return out;
}

/** Unhit ship cells of a sea among `cells`: what a fog row or a buoy may report. */
const afloatAmong = (s: SalvoState, sea: string, cells: (c: string) => boolean) =>
  s.fleets[sea].reduce((n, x) => n + x.cells.filter((c) => cells(c) && !x.hits.includes(c)).length, 0);

/** Plain checks inside the hot loops (a bun `expect` per string costs too much over 300 games). */
function check(ok: boolean, what: string): void {
  if (!ok) throw new Error(`leak check failed: ${what}`);
}

/** Review Focus 1: no unrevealed ship cell and nobody else's pending aim reaches any view. */
function assertNoLeaks(s: SalvoState, step: number): void {
  const over = s.phase === 'over';
  const viewers = [null, ...s.seats];
  // One viewer per step (rotating) is compared against the same state with every pending shot removed.
  const witness = viewers[step % viewers.length];
  const blank = structuredClone(s);
  for (const x of blank.seats) blank.pending[x] = [];
  for (const seat of viewers) {
    const v = viewOf(s, seat);
    const { ascii, ...rest } = v;
    const where = `round ${s.round}, ${seat ?? 'spectator'}`;
    // A viewer's own queued shots are in myOrders, exactly; nobody else's, and a spectator's is empty.
    const own = seat !== null && s.phase === 'fire' ? s.pending[seat].map((x) => ({ fire: x.kind, at: x.sea, cell: x.cell })) : [];
    check(JSON.stringify(v.myOrders) === JSON.stringify(own), `${where}: myOrders is not my own pending`);
    // Apart from myOrders (and the ascii line that recites it), the view is the same without anyone's pending.
    if (seat === witness) {
      const { myOrders: _o, ascii: _a, ...without } = viewOf(blank, seat);
      const { myOrders: _p, ...mine } = rest;
      check(JSON.stringify(mine) === JSON.stringify(without), `${where}: the view depends on pending`);
      // The drawing is made from the view alone, so it can only say what the view says.
      check(ascii === renderAscii(rest), `${where}: ascii is not drawn from the view`);
    }
    // guns: one per ship afloat, for every living seat, during fire only.
    const guns = s.phase === 'fire' ? Object.fromEntries(s.seats.filter((x) => !isOut(s, x)).map((x) => [x, s.fleets[x].filter((y) => y.hits.length < y.cells.length).length])) : {};
    check(JSON.stringify(v.guns) === JSON.stringify(guns), `${where}: guns miscounted`);
    if (seat === null) check(v.mySea === null, `${where}: a spectator has a sea`);
    else check(JSON.stringify(v.mySea!.ships.filter((x) => x.cells.length > 0)) === JSON.stringify(s.fleets[seat]), `${where}: mySea is not my fleet`);
    for (const t of v.targets) {
      check(t.sea !== seat, `${where}: my own sea is a target`);
      if (over) continue;
      check(t.revealed === undefined, `${where}: ${t.sea} revealed while live`);
      check(t.out === isOut(s, t.sea), `${where}: ${t.sea}'s out flag is wrong`);
      const hidden = hiddenCells(s, t.sea);
      // A buoy's cells are its 3×3, not ship positions; they are checked on their own below.
      for (const str of strings({ ...t, sonar: [] })) check(!hidden.has(str), `${where}: hidden ship cell ${t.sea} ${str}`);
      // The fog's counts are true counts.
      for (const x of t.lifted) check(x.afloat === afloatAmong(s, t.sea, (c) => Number(c.slice(1)) === x.row), `${where}: row ${x.row} miscounted`);
      // A sonar reading reaches its dropper alone, and says what is really there.
      const own = seat === null ? [] : s.sonar[seat].filter((x) => x.sea === t.sea);
      check(t.sonar.length === own.length, `${where}: ${t.sea} shows sonar that is not the viewer's`);
      t.sonar.forEach((x, k) => {
        check(x.cell === own[k].cell && JSON.stringify(x.cells) === JSON.stringify(buoyCells(x.cell)), `${where}: a reading's 3×3`);
        check(x.afloat === afloatAmong(s, t.sea, (c) => x.cells.includes(c)), `${where}: a reading miscounts`);
      });
    }
    if (v.lastVolley) {
      for (const x of v.lastVolley.shells) {
        check(s.shots[x.sea][x.cell] !== undefined, `${where}: unresolved shell in lastVolley`);
        // A ship is named only by the shell that sank it: naming it on a hit would tell its length.
        check(x.result === 'sunk' ? x.ship !== null : x.ship === null, `${where}: a shell names a ship it did not sink`);
      }
      for (const b of v.lastVolley.blasts) for (const c of b.cells) check(s.shots[b.sea][c] !== undefined, `${where}: unresolved blast cell`);
      for (const b of v.lastVolley.buoys) check(s.sonar[b.from].some((x) => x.sea === b.sea && x.cell === b.cell), `${where}: unresolved buoy`);
      check(!JSON.stringify(v.lastVolley.buoys).includes('afloat'), `${where}: a buoy's reading in the public volley`);
    }
    // Nothing outside mySea, targets, lastVolley and the viewer's own myOrders names a cell.
    const { mySea: _m, targets: _t, lastVolley: _l, myOrders: _o, ...top } = rest;
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
  const landed = new Set(v ? [...v.shells.map((x) => x.cell), ...v.buoys.map((x) => x.cell), ...v.blasts.flatMap((b) => b.cells)] : []);
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
    if (++guard > 3000) throw new Error(`game ${g} did not finish`);
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
      if (s.phase === 'fire') check(legal.length <= 192 + 108, `game ${g}: legal is ${legal.length} long`);
      // legal × apply: a few other entries apply cleanly too, and a spent cell is refused.
      turn.apply(s, seat, rng.pick(legal));
      const mine = viewOf(s, seat);
      if (s.phase === 'fire') {
        const spent = mine.targets.filter((t) => !t.out).flatMap((t) => t.mine.map((m) => ({ fire: 'shell', at: t.sea, cell: m.cell })));
        if (spent.length > 0) check(codeOf(() => turn.apply(s, seat, rng.pick(spent))) === 'ALREADY_FIRED', `game ${g}: a spent cell was accepted`);
        // A cell already in this salvo, or a second buoy, is refused, and legal never offers either.
        // (Shots queued at a sea that has since gone out are tested against a living sea instead.)
        const living = new Set(mine.targets.filter((t) => !t.out).map((t) => t.sea));
        const queued = mine.myOrders.filter((x) => x.fire === 'shell');
        const live = queued.filter((x) => living.has(x.at));
        if (live.length > 0) check(codeOf(() => turn.apply(s, seat, rng.pick(live))) === 'ALREADY_AIMED', `game ${g}: a cell aimed twice in a salvo`);
        for (const c of legal as { fire: string; at: string; cell: string }[]) check(!queued.some((q) => q.at === c.at && q.cell === c.cell && c.fire === 'shell'), `game ${g}: legal offers an aimed cell`);
        const buoyed = mine.myOrders.find((x) => x.fire === 'buoy');
        if (buoyed) {
          check(!legal.some((c) => 'fire' in c && c.fire === 'buoy'), `game ${g}: legal offers a second buoy`);
          const again = { fire: 'buoy', at: [...living][0] ?? mine.targets[0].sea, cell: buoyed.cell };
          check(codeOf(() => turn.apply(s, seat, again)) === 'ONE_BUOY', `game ${g}: a second buoy was accepted`);
        }
        check(mine.myOrders.length < mine.guns[seat], `game ${g}: ${seat} owes a shot with its salvo full`);
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

  test('resolution never depends on commit order: all 24 seat orders agree, shot by shot or salvo by salvo', () => {
    let full = 0;
    for (let seed = 1; seed <= 16; seed++) {
      const rng = createRng(seed * 31);
      let s = deployedAtRandom(4, seed);
      // play some rounds, whole salvos, so there are hits, sinkings and lifted rows to land on
      const rounds = 3 + (seed % 12);
      while (s.round <= rounds && !G.outcome(s)) {
        const seat = turn.toMove(s)[0];
        s = turn.apply(s, seat, choose(viewOf(s, seat), turn.legal(s, seat) as SalvoCommand[], rng));
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
      // a and b share a cell (Time on Target); c finishes the ship; each salvo is then filled out by the player
      const legalB = turn.legal(s, b) as SalvoCommand[];
      const shared = (turn.legal(s, a) as SalvoCommand[]).find(
        (x) => 'fire' in x && x.fire === 'shell' && legalB.some((y) => 'fire' in y && y.fire === 'shell' && y.at === x.at && y.cell === x.cell),
      );
      const salvos: Record<string, SalvoCommand[]> = {};
      for (const seat of alive) {
        const first: SalvoCommand[] = seat === c ? [{ fire: 'shell', at: victim, cell: open }] : shared && (seat === a || seat === b) ? [shared] : [];
        // queue the salvo on a scratch copy (this seat alone, so the round never resolves) to keep every shot legal
        let t = s;
        for (const cmd of first) t = turn.apply(t, seat, cmd);
        const cmds = [...first];
        while (turn.toMove(t).includes(seat)) {
          const cmd = choose(viewOf(t, seat), turn.legal(t, seat) as SalvoCommand[], rng);
          cmds.push(cmd);
          t = turn.apply(t, seat, cmd);
        }
        expect(t.round).toBe(s.round);
        salvos[seat] = cmds;
      }
      const results: string[] = [];
      for (const order of permutations(alive)) {
        // salvo by salvo
        let t = s;
        for (const seat of order) for (const cmd of salvos[seat]) t = turn.apply(t, seat, cmd);
        results.push(JSON.stringify(t));
        // shot by shot, round robin in this seat order (each seat's own shots keep their order)
        let u = s;
        const longest = Math.max(...alive.map((x) => salvos[x].length));
        for (let k = 0; k < longest; k++) for (const seat of order) if (k < salvos[seat].length) u = turn.apply(u, seat, salvos[seat][k]);
        results.push(JSON.stringify(u));
      }
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
