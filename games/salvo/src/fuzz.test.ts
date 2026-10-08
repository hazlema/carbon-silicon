import { describe, expect, test } from 'bun:test';
import { createRng, type Rng } from '@cs/game-api';
import {
  SEATS,
  cellIndex,
  cellName,
  buoyCells,
  hullCells,
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
const SAFE_DESCRIBE = ['fires', 'deploys a ship', 'deploys the fleet', 'plays a dirty trick', 'opens a crate'];
const SAFE_NARRATE = ['is ready', 'deploys a ship', 'deploys the fleet', 'is up to something…', 'opens a crate'];
const viewOf = (s: SalvoState, seat: string | null) => G.view(s, seat) as SalvoView;
const isOut = (s: SalvoState, seat: string) => s.eliminated.some((x) => x.seat === seat);
/** Sunk fleets still at the table, worked out from the state alone (the view's `ghosts` must agree). */
const ghostsOf = (s: SalvoState) =>
  s.phase === 'over' ? [] : s.seats.filter((x) => s.eliminated.some((e) => e.seat === x && e.reason === 'sunk') && !s.ghostsGone.includes(x));
const isTrickCmd = (c: unknown) => typeof c === 'object' && c !== null && 'trick' in c;
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
  // A ghost plays random mischief, as the autopilot does.
  if (legal.length > 0 && 'trick' in (legal[0] as object)) return rng.pick(legal);
  // An open crate comes first in legal: open it at random, as the autopilot does (Task 4 plays it properly).
  const crate = legal.filter((c) => 'crate' in c);
  if (crate.length > 0) return rng.pick(crate);
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

/**
 * What a viewer may know of the ghosts' mischief: everyone's pending shots and every other ghost's commit
 * gone, and (while the match is live) every mine but the viewer's own and every false splash it neither
 * played nor is fooled by. Nothing in its view may change for it.
 */
function secretsStripped(s: SalvoState, seat: string | null): SalvoState {
  const t = structuredClone(s);
  for (const x of t.seats) {
    if (x === seat) continue; // the viewer's own commits are its to know
    // Another seat's queued item goes back in its hand, as if never committed: the table can't tell.
    for (const o of t.pending[x]) if (o.kind === 'cluster' || o.kind === 'torpedo') t.arsenal[x].push(o.kind);
    t.pending[x] = [];
    t.pendingTrick[x] = null;
  }
  if (t.phase !== 'over') {
    t.mines = t.mines.filter((m) => m.ghost === seat);
    t.splashes = t.splashes.filter((x) => x.ghost === seat || x.fool === seat);
  }
  return t;
}

/** Review Focus 1: no unrevealed ship cell, nobody else's pending aim, and no ghost's secret reaches any view. */
function assertNoLeaks(s: SalvoState, step: number): void {
  const over = s.phase === 'over';
  const viewers = [null, ...s.seats];
  // One viewer per step (rotating) is compared against the same state with every secret it may not know removed.
  const witness = viewers[step % viewers.length];
  const ghosts = ghostsOf(s);
  const byBoard = (a: string, b: string) => cellIndex(a)! - cellIndex(b)!;
  for (const seat of viewers) {
    const v = viewOf(s, seat);
    const { ascii, ...rest } = v;
    const where = `round ${s.round}, ${seat ?? 'spectator'}`;
    // A viewer's own queued shots are in myOrders, exactly; nobody else's, and a spectator's is empty.
    const own = seat !== null && s.phase === 'fire' ? s.pending[seat].map((x) => ({ fire: x.kind, at: x.sea, cell: x.cell, ...(x.lane !== undefined ? { lane: x.lane } : {}) })) : [];
    check(JSON.stringify(v.myOrders) === JSON.stringify(own), `${where}: myOrders is not my own pending`);
    // Apart from myOrders (and the ascii line that recites it), the view is the same without anything it may not know.
    if (seat === witness) {
      const { myOrders: _o, ascii: _a, ...without } = viewOf(secretsStripped(s, seat), seat);
      const { myOrders: _p, ...mine } = rest;
      check(JSON.stringify(mine) === JSON.stringify(without), `${where}: the view depends on a secret`);
      // The drawing is made from the view alone, so it can only say what the view says.
      check(ascii === renderAscii(rest), `${where}: ascii is not drawn from the view`);
    }
    check(JSON.stringify(v.ghosts) === JSON.stringify(ghosts), `${where}: ghosts are wrong`);
    // myTricks: a ghost's own mischief, exactly; null for everyone else.
    const ghost = seat !== null && ghosts.includes(seat);
    check((v.myTricks !== null) === ghost, `${where}: myTricks for a seat that is not a ghost (or none for a ghost)`);
    if (v.myTricks) {
      const mines = s.mines.filter((m) => m.ghost === seat).map(({ sea, cell, round }) => ({ sea, cell, round }));
      check(JSON.stringify(v.myTricks.mines) === JSON.stringify(mines), `${where}: myTricks.mines is not my own mines`);
      const splashes = s.splashes.filter((x) => x.ghost === seat).map(({ fool, sea, cell, round }) => ({ fool, sea, cell, round }));
      check(JSON.stringify(v.myTricks.splashes) === JSON.stringify(splashes), `${where}: myTricks.splashes is not my own splashes`);
      const p = s.pendingTrick[seat!];
      check(
        JSON.stringify(v.myTricks.pending) === JSON.stringify(p ? { trick: p.kind, at: p.sea, cell: p.cell, ...(p.fool ? { fool: p.fool } : {}) } : null),
        `${where}: myTricks.pending is not my own commit`,
      );
    }
    // The false splashes this viewer is fooled by (it sees them as hits, and in its copy of the volley).
    const fakes = over || seat === null ? [] : s.splashes.filter((x) => x.fool === seat);
    const faked = new Set(fakes.map((x) => `${x.sea} ${x.cell}`));
    // guns: one per ship afloat, for every living seat, during fire only.
    const guns = s.phase === 'fire' ? Object.fromEntries(s.seats.filter((x) => !isOut(s, x)).map((x) => [x, s.fleets[x].filter((y) => y.hits.length < y.cells.length).length])) : {};
    check(JSON.stringify(v.guns) === JSON.stringify(guns), `${where}: guns miscounted`);
    if (seat === null) check(v.mySea === null, `${where}: a spectator has a sea`);
    else check(JSON.stringify(v.mySea!.ships.filter((x) => x.cells.length > 0)) === JSON.stringify(s.fleets[seat]), `${where}: mySea is not my fleet`);
    for (const t of v.targets) {
      check(t.sea !== seat, `${where}: my own sea is a target`);
      // Hits and misses are the real ones, plus (for a fool) its own false splashes and nobody else's.
      const real = Object.entries(s.shots[t.sea]);
      const hits = [...new Set([...real.filter(([, x]) => x.result === 'hit').map(([c]) => c), ...fakes.filter((x) => x.sea === t.sea).map((x) => x.cell)])].sort(byBoard);
      check(JSON.stringify(t.hits) === JSON.stringify(hits), `${where}: ${t.sea}'s hits are not the real ones and my own fakes`);
      const misses = real.filter(([, x]) => x.result === 'miss').map(([c]) => c).sort(byBoard);
      check(JSON.stringify(t.misses) === JSON.stringify(misses), `${where}: ${t.sea}'s misses are not the real ones`);
      // A live mine is never marked on a sea until a shell lands there (a fool's fake may sit on one by chance).
      for (const m of s.mines.filter((x) => x.sea === t.sea)) {
        if (s.shots[t.sea][m.cell] || faked.has(`${t.sea} ${m.cell}`)) continue;
        check(!t.hits.includes(m.cell) && !t.misses.includes(m.cell), `${where}: a live mine marked on ${t.sea}`);
      }
      // A false splash shows to its fool alone (its ghost has it in myTricks).
      for (const x of s.splashes.filter((y) => y.sea === t.sea && y.fool !== seat)) {
        check(!t.hits.includes(x.cell) || s.shots[t.sea][x.cell]?.result === 'hit', `${where}: someone else's false splash on ${t.sea}`);
      }
      if (over) continue;
      check(t.mines === undefined, `${where}: ${t.sea}'s mines shown while live`);
      check(t.revealed === undefined, `${where}: ${t.sea} revealed while live`);
      check(t.out === isOut(s, t.sea), `${where}: ${t.sea}'s out flag is wrong`);
      const hidden = hiddenCells(s, t.sea);
      // A buoy's cells are its 3×3, not ship positions; they are checked on their own below.
      // A fool's fake was aimed blind: if it happens to sit on a ship, that says nothing.
      for (const str of strings({ ...t, sonar: [] })) check(!hidden.has(str) || faked.has(`${t.sea} ${str}`), `${where}: hidden ship cell ${t.sea} ${str}`);
      // The fog's counts are true counts (a fake splash does not change them: the accepted bluff).
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
      // The fool's copy carries one fake shell per false splash first shown in this volley, dressed as a living shooter.
      const shown = fakes.filter((x) => x.round === v.lastVolley!.round);
      let fakeShells = 0;
      for (const x of v.lastVolley.shells) {
        if (s.shots[x.sea][x.cell] === undefined) {
          const fake = shown.find((f) => f.sea === x.sea && f.cell === x.cell);
          check(fake !== undefined && x.from === fake.as && x.result === 'hit' && x.ship === null && !x.blast, `${where}: unresolved shell in lastVolley`);
          fakeShells += 1;
          continue;
        }
        // A ship is named only by the shell that sank it: naming it on a hit would tell its length.
        check(x.result === 'sunk' ? x.ship !== null : x.ship === null, `${where}: a shell names a ship it did not sink`);
        // Nobody but the fool sees a shell on a live splash's cell.
        check(!s.splashes.some((f) => f.fool !== seat && f.sea === x.sea && f.cell === x.cell && f.round === v.lastVolley!.round), `${where}: someone else's fake shell`);
      }
      check(fakeShells === shown.length, `${where}: the fool's volley is missing a fake shell`);
      for (const b of v.lastVolley.blasts) for (const c of b.cells) check(s.shots[b.sea][c] !== undefined, `${where}: unresolved blast cell`);
      for (const b of v.lastVolley.buoys) check(s.sonar[b.from].some((x) => x.sea === b.sea && x.cell === b.cell), `${where}: unresolved buoy`);
      check(!JSON.stringify(v.lastVolley.buoys).includes('afloat'), `${where}: a buoy's reading in the public volley`);
      // Tricks are told once they are over: no live mine, no splash still on show (a ghost may splash the same
      // cell again in the round its last one is told: that one is first shown in this volley).
      for (const x of v.lastVolley.tricks) {
        if (x.kind === 'mine') check(!s.mines.some((m) => m.sea === x.sea && m.cell === x.cell && m.ghost === x.ghost), `${where}: a told mine still live`);
        else check(!s.splashes.some((f) => f.sea === x.sea && f.cell === x.cell && f.ghost === x.ghost && f.round !== v.lastVolley!.round), `${where}: a told splash still on show`);
      }
    }
    // Nothing outside mySea, targets, lastVolley and the viewer's own myOrders and myTricks names a cell.
    const { mySea: _m, targets: _t, lastVolley: _l, myOrders: _o, myTricks: _k, ...top } = rest;
    for (const str of strings(top)) check(cellIndex(str) === null, `${where}: a cell in the view's top level`);
  }
}

/** The round's story mentions only cells and ships of the volley that just landed (its tricks included, now told). */
function assertSummarySafe(before: SalvoState, after: SalvoState): void {
  const lines = roundSummary(before, after);
  const changed = after.round !== before.round || after.phase !== before.phase;
  if (!changed) {
    check(lines.length === 0, 'a summary inside a round');
    return;
  }
  const v = after.lastVolley;
  const told = v ? v.tricks.flatMap((t) => [t.cell, ...(t.kind === 'mine' && t.result === 'boomerang' ? t.hits.map((h) => h.cell) : [])]) : [];
  const used = v ? (v.items ?? []).flatMap((x) => (x.item === 'cluster' ? [x.cell, ...x.cells] : x.item === 'torpedo' ? x.path : [])) : [];
  const landed = new Set(v ? [...v.shells.map((x) => x.cell), ...v.buoys.map((x) => x.cell), ...v.blasts.flatMap((b) => b.cells), ...told, ...used] : []);
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
  /** Ghost commits, and tricks told by kind ('boomerang', 'backfire', 'splash'). */
  ghostMoves: number;
  tricks: Record<string, number>;
  /** States where a ghost's legal was checked against a fleet moved under it. */
  blind: number;
  /** Ghosts forfeited (placement checked at the end). */
  ghostForfeits: number;
}

/** A random trick command, legal or not. */
function randomTrick(s: SalvoState, rng: Rng): SalvoCommand {
  const at = rng.pick(s.seats);
  const cell = cellName(rng.int(64));
  return rng.next() < 0.5 ? { trick: 'mine', at, cell } : { trick: 'splash', fool: rng.pick(s.seats), at, cell };
}

/**
 * The same state with one unhit living ship moved somewhere else it fits: onto cells nobody has shot,
 * clear of the rest of its fleet, `shots` untouched (its old cells were never shot, or it would have a hit).
 * Null when no ship can move.
 */
function shipMoved(s: SalvoState, rng: Rng): SalvoState | null {
  const t = structuredClone(s);
  const seas = t.seats.filter((x) => !isOut(t, x));
  for (const sea of [...seas].sort(() => rng.next() - 0.5)) {
    const ships = t.fleets[sea].filter((x) => x.hits.length === 0);
    if (ships.length === 0) continue;
    const ship = rng.pick(ships);
    const others = new Set(t.fleets[sea].filter((x) => x !== ship).flatMap((x) => x.cells));
    const options: string[][] = [];
    for (let i = 0; i < 64; i++) {
      for (const facing of ['east', 'north'] as const) {
        const cells = hullCells(cellName(i), ship.cells.length, facing);
        if (cells && cells.every((c) => !others.has(c) && !t.shots[sea][c]) && cells.join() !== ship.cells.join()) options.push(cells);
      }
    }
    if (options.length === 0) continue;
    ship.cells = rng.pick(options);
    return t;
  }
  return null;
}

/** A ghost's turn, before it plays: legal × apply, refusals with a code, and a legal blind to where ships are. */
function checkGhostTurn(s: SalvoState, seat: string, legal: SalvoCommand[], rng: Rng, g: number, tally: Tally): void {
  const alive = s.seats.filter((x) => !isOut(s, x)).length;
  check(legal.length <= alive * 64 + (alive >= 3 ? alive * (alive - 1) * 64 : 0), `game ${g}: a ghost's legal is ${legal.length} long`);
  check(legal.every(isTrickCmd), `game ${g}: a ghost is offered something other than a trick`);
  // legal × apply: a sample of entries apply cleanly.
  for (let k = 0; k < 5; k++) {
    const cmd = rng.pick(legal);
    const code = codeOf(() => turn.apply(s, seat, cmd));
    check(code === null, `game ${g}: ${seat}'s legal ${JSON.stringify(cmd)} was refused (${code})`);
  }
  // A trick not in legal is refused with a code; a shell from a ghost is refused too.
  const offered = new Set(legal.map((x) => JSON.stringify(x)));
  for (let k = 0; k < 20; k++) {
    const cmd = randomTrick(s, rng);
    if (offered.has(JSON.stringify(cmd))) continue;
    const code = codeOf(() => turn.apply(s, seat, cmd));
    check(code !== null && code !== 'NO_CODE', `game ${g}: ${seat}'s ${JSON.stringify(cmd)} is not in legal but was ${code === null ? 'accepted' : 'refused without a code'}`);
    break;
  }
  check(codeOf(() => turn.apply(s, seat, { fire: 'shell', at: s.seats.find((x) => !isOut(s, x))!, cell: 'a1' })) === 'BAD_COMMAND', `game ${g}: a ghost fired`);
  // Blind: a living ship moved under it changes nothing the ghost can ask about.
  if (rng.next() < 0.25) {
    const moved = shipMoved(s, rng);
    if (moved) {
      tally.blind += 1;
      check(JSON.stringify(turn.legal(moved, seat)) === JSON.stringify(legal), `game ${g}: ${seat}'s legal depends on where a ship is`);
      check(JSON.stringify(turn.toMove(moved)) === JSON.stringify(turn.toMove(s)), `game ${g}: toMove depends on where a ship is`);
      for (let k = 0; k < 5; k++) {
        const cmd = randomTrick(s, rng);
        check(codeOf(() => turn.apply(moved, seat, cmd)) === codeOf(() => turn.apply(s, seat, cmd)), `game ${g}: ${seat}'s refusal of ${JSON.stringify(cmd)} depends on where a ship is`);
      }
    }
  }
}

/** One seeded game from setup to outcome, checking everything as it goes. */
function playthrough(g: number, tally: Tally, leaks: boolean): void {
  const n = 2 + (g % 3);
  const rng = createRng(1000 + g);
  let s = G.setup({ seats: SEATS.slice(0, n) as string[], seed: 7 * g + 3 });
  // In about one game in six (three and four seats), the first ghost is forfeited the moment it appears.
  const forfeitGhost = g % 12 === 1 || g % 12 === 5;
  let gone: { seat: string; round: number } | null = null;
  let guard = 0;
  while (!G.outcome(s)) {
    if (++guard > 3000) throw new Error(`game ${g} did not finish`);
    const owing = turn.toMove(s);
    check(owing.length > 0, `game ${g}: nobody owes a move`);
    const before = s;
    const ghost = ghostsOf(s)[0];
    if (forfeitGhost && !gone && ghost !== undefined) {
      // Ghost forfeits keep placement: eliminated (and so outcome) untouched, its mischief gone with it.
      s = G.forfeit(s, ghost, 'timeout');
      tally.ghostForfeits += 1;
      gone = { seat: ghost, round: before.eliminated.find((x) => x.seat === ghost)!.round };
      // (If it was the last one owing, the round resolves and may sink more fleets after it.)
      check(JSON.stringify(s.eliminated.slice(0, before.eliminated.length)) === JSON.stringify(before.eliminated), `game ${g}: a ghost forfeit changed eliminated`);
      check(s.ghostsGone.includes(ghost) && !ghostsOf(s).includes(ghost), `game ${g}: a forfeited ghost is still a ghost`);
      check(!s.mines.some((m) => m.ghost === ghost) && !s.splashes.some((x) => x.ghost === ghost) && s.pendingTrick[ghost] === null, `game ${g}: a forfeited ghost's mischief stayed`);
      check(!turn.toMove(s).includes(ghost) && turn.legal(s, ghost).length === 0, `game ${g}: a forfeited ghost still owes`);
      if (s.round === before.round) check(s.eliminated.length === before.eliminated.length, `game ${g}: a ghost forfeit added to eliminated`);
    } else if (rng.next() < 0.003) {
      const alive = s.seats.filter((x) => !isOut(s, x));
      s = G.forfeit(s, rng.pick(alive), rng.pick(['resign', 'timeout', 'disconnect']));
    } else {
      const seat = rng.pick(owing);
      const legal = turn.legal(s, seat) as SalvoCommand[];
      check(legal.length > 0, `game ${g}: ${seat} owes a move but has no legal one`);
      const mine = viewOf(s, seat);
      if (ghostsOf(s).includes(seat)) {
        checkGhostTurn(s, seat, legal, rng, g, tally);
        tally.ghostMoves += 1;
      } else {
        // Shells, buoys and crate choices, then a held cluster (a centre per cell) and a held torpedo (a lane per sea).
        if (s.phase === 'fire') check(legal.length <= 192 + 108 + 7 + 192 + 24, `game ${g}: legal is ${legal.length} long`);
        // legal × apply: a few other entries apply cleanly too, and a spent cell is refused.
        turn.apply(s, seat, rng.pick(legal));
      }
      if (s.phase === 'fire' && !ghostsOf(s).includes(seat)) {
        // A living seat cannot play a trick.
        check(codeOf(() => turn.apply(s, seat, randomTrick(s, rng))) === 'NOT_A_GHOST', `game ${g}: a living seat played a trick`);
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
    if (s.lastVolley && s.lastVolley !== before.lastVolley && s.lastVolley.round === before.round) {
      tally.blasts += s.lastVolley.blasts.length;
      for (const t of s.lastVolley.tricks) {
        const kind = t.kind === 'mine' ? t.result : 'splash';
        tally.tricks[kind] = (tally.tricks[kind] ?? 0) + 1;
      }
    }
    if (leaks) {
      assertNoLeaks(s, guard);
      assertSummarySafe(before, s);
    }
  }
  const out = G.outcome(s)!;
  expect(out.winners).toHaveLength(1);
  expect(out.placement[0]).toEqual(out.winners);
  expect(out.placement.flat().sort()).toEqual([...s.seats].sort());
  if (gone) {
    // The forfeited ghost keeps its sinking, and shares its place with everyone sunk in that round.
    expect(s.eliminated.find((x) => x.seat === gone!.seat)).toEqual({ seat: gone.seat, round: gone.round, reason: 'sunk' });
    const group = s.seats.filter((x) => s.eliminated.some((e) => e.seat === x && e.round === gone!.round));
    expect(out.placement.find((p) => p.includes(gone!.seat))).toEqual(group);
  }
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
  const tally: Tally = { reasons: {}, blasts: 0, knockouts: 0, ghostMoves: 0, tricks: {}, blind: 0, ghostForfeits: 0 };

  test(`legal × apply agreement, one winner, and no leaks over ${GAMES} games`, () => {
    for (let g = 0; g < GAMES; g++) playthrough(g, tally, true);
    // The fuzz reaches every ending and plenty of Time on Target.
    expect(tally.reasons['last-afloat']).toBeGreaterThan(0);
    expect(tally.blasts).toBeGreaterThan(0);
    // ...and the ghosts get up to every kind of mischief, are checked blind, and are forfeited.
    expect(tally.ghostMoves).toBeGreaterThan(0);
    expect(tally.tricks.boomerang).toBeGreaterThan(0);
    expect(tally.tricks.backfire).toBeGreaterThan(0);
    expect(tally.tricks.splash).toBeGreaterThan(0);
    expect(tally.blind).toBeGreaterThan(0);
    expect(tally.ghostForfeits).toBeGreaterThan(0);
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

  test('resolution never depends on commit order: all 24 seat orders agree, shot by shot or salvo by salvo, ghost tricks included', () => {
    let full = 0;
    const told: Record<string, number> = {};
    let twoGhosts = 0;
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
      // With nobody sunk yet, one fleet (every third seed, two) goes down before this round, so ghosts commit among the shooters.
      if (ghostsOf(s).length === 0 && s.seats.every((x) => !isOut(s, x))) {
        for (const d of seed % 3 === 0 ? [s.seats[seed % 4], s.seats[(seed + 1) % 4]] : [s.seats[seed % 4]]) {
          hitAllBut(s, d, [], s.seats.find((x) => x !== d && !isOut(s, x))!);
          s.eliminated.push({ seat: d, round: s.round - 1, reason: 'sunk' });
        }
      }
      const owing = turn.toMove(s);
      const alive = owing.filter((x) => !isOut(s, x));
      const spooks = owing.filter((x) => isOut(s, x));
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
        (x): x is Extract<SalvoCommand, { fire: 'shell' }> =>
          'fire' in x && x.fire === 'shell' && legalB.some((y) => 'fire' in y && y.fire === 'shell' && y.at === x.at && y.cell === x.cell),
      );
      // An older mine on the Time on Target cell, so two shooters set one off at once.
      const ghost = spooks[0];
      if (ghost && shared && 'fire' in shared && !s.shots[shared.at][shared.cell] && s.mines.filter((m) => m.ghost === ghost).length < 2) {
        s.mines.push({ ghost, sea: shared.at, cell: shared.cell, round: s.round - 1 });
      }
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
      // Each ghost's one trick: a false splash on odd seeds (when it may); else a mine under one of this round's
      // shells; with two ghosts, mines that stay live too (on even seeds both do, so their order in the state shows).
      const shelled = new Set(alive.flatMap((x) => salvos[x]).flatMap((x) => ('fire' in x && x.fire === 'shell' ? [`${x.at} ${x.cell}`] : [])));
      spooks.forEach((seat, k) => {
        const legal = turn.legal(s, seat) as SalvoCommand[];
        const splashes = legal.filter((x) => 'trick' in x && x.trick === 'splash');
        const mines = legal.filter((x) => 'trick' in x && x.trick === 'mine');
        const under = mines.filter((x) => shelled.has(`${x.at} ${x.cell}`));
        const quiet = mines.filter((x) => !shelled.has(`${x.at} ${x.cell}`));
        const wantUnder = spooks.length === 1 || (k === 0 && seed % 2 === 1);
        const from = seed % 2 === 1 && splashes.length > 0 ? splashes : wantUnder && under.length > 0 ? under : quiet.length > 0 ? quiet : legal;
        salvos[seat] = [rng.pick(from)];
      });
      const results: string[] = [];
      for (const order of permutations(owing)) {
        // salvo by salvo
        let t = s;
        for (const seat of order) for (const cmd of salvos[seat]) t = turn.apply(t, seat, cmd);
        results.push(JSON.stringify(t));
        // shot by shot, round robin in this seat order (each seat's own shots keep their order)
        let u = s;
        const longest = Math.max(...owing.map((x) => salvos[x].length));
        for (let k = 0; k < longest; k++) for (const seat of order) if (k < salvos[seat].length) u = turn.apply(u, seat, salvos[seat][k]);
        results.push(JSON.stringify(u));
      }
      if (owing.length === 4) full += 1;
      if (spooks.length >= 2) twoGhosts += 1;
      expect(new Set(results).size).toBe(1);
      const after = JSON.parse(results[0]) as SalvoState;
      for (const t of after.lastVolley!.tricks) told[t.kind === 'mine' ? t.result : 'splash'] = (told[t.kind === 'mine' ? t.result : 'splash'] ?? 0) + 1;
      told.shown = (told.shown ?? 0) + after.splashes.length;
      // A mine laid under one of this round's shells goes off in this volley.
      for (const seat of spooks) {
        const [x] = salvos[seat] as { trick: string; at: string; cell: string }[];
        if (x.trick === 'mine' && shelled.has(`${x.at} ${x.cell}`)) {
          expect(after.lastVolley!.tricks.some((t) => t.kind === 'mine' && t.ghost === seat && t.sea === x.at && t.cell === x.cell)).toBe(true);
        }
      }
      expect(after.lastVolley!.round).toBe(s.round);
      if (shared) expect(after.lastVolley!.blasts.length).toBeGreaterThan(0);
      if (c) expect(after.lastVolley!.sunk.some((x) => x.sea === victim && x.ship === ship.id)).toBe(true);
    }
    expect(full).toBeGreaterThan(5);
    expect(twoGhosts).toBeGreaterThan(0);
    // The tricks went off among the commits: mines both ways, and false splashes.
    expect(told.boomerang).toBeGreaterThan(0);
    expect(told.backfire).toBeGreaterThan(0);
    expect(told.shown + (told.splash ?? 0)).toBeGreaterThan(0);
  });
});
