import { describe, expect, test } from 'bun:test';
import { createRng, type Rng } from '@cs/game-api';
import {
  AUCTION_MS,
  BID_LEGAL_MAX,
  ITEMS,
  ITEM_LIMIT,
  SEATS,
  cellIndex,
  cellName,
  buoyCells,
  hullCells,
  lanesFor,
  neighbours,
  renderAscii,
  roundSummary,
  salvoGame as G,
  type SalvoCommand,
  type SalvoState,
  type SalvoView,
  type ItemId,
  type Auction,
} from './index';

const turn = G.turn;
const GAMES = 300;
const CELL = /\b[a-h][1-8]\b/g;
const SHIP_NAME = /cruiser|destroyer|frigate|submarine/g;
const SAFE_DESCRIBE = ['fires', 'deploys a ship', 'deploys the fleet', 'plays a dirty trick', 'opens a crate', 'bids on a whisper', 'sets its whisper'];
const SAFE_NARRATE = ['is ready', 'deploys a ship', 'deploys the fleet', 'is up to something…', 'opens a crate', 'bids on a whisper', 'sets its whisper'];
const viewOf = (s: SalvoState, seat: string | null) => G.view(s, seat) as SalvoView;
const isOut = (s: SalvoState, seat: string) => s.eliminated.some((x) => x.seat === seat);
/** Sunk fleets still at the table, worked out from the state alone (the view's `ghosts` must agree). */
const ghostsOf = (s: SalvoState) =>
  s.phase === 'over' ? [] : s.seats.filter((x) => s.eliminated.some((e) => e.seat === x && e.reason === 'sunk') && !s.ghostsGone.includes(x));
const isTrickCmd = (c: unknown) => typeof c === 'object' && c !== null && 'trick' in c;
const isTellCmd = (c: unknown) => typeof c === 'object' && c !== null && 'tell' in c;
const openAuctionsOf = (s: SalvoState) => s.auctions.filter((a) => a.state === 'open');
const codeOf = (fn: () => unknown): string | null => {
  try {
    fn();
  } catch (e) {
    return (e as { code?: string }).code ?? 'NO_CODE';
  }
  return null;
};

/** The kind of a salvo entry: 'shell', 'buoy', an item, or null (a crate choice, a placement, a trick). */
const kindOf = (c: SalvoCommand): string | null => ('use' in c ? c.use : 'fire' in c ? c.fire : null);
const isItemCmd = (c: SalvoCommand) => {
  const k = kindOf(c);
  return k !== null && k !== 'shell' && k !== 'buoy';
};

/**
 * A player that reads only its own view: opens its crate at random (a card, a swap when its hands are full, or a
 * pass), uses a held item in about three rounds in ten (any kind it holds, any legal aim), mostly chases unsunk
 * hits and its sonar readings, drops a buoy now and then, and otherwise hunts the weakest fleet on a
 * checkerboard, with a dash of pure randomness so every path gets walked.
 */
function choose(v: SalvoView, legal: SalvoCommand[], rng: Rng): SalvoCommand {
  // A ghost plays random mischief, as the autopilot does; half the time it mines beside an unsunk hit, where
  // the living will shoot next (from its own view: a live decoy's hit looks like any other).
  if (legal.length > 0 && 'trick' in (legal[0] as object)) {
    const next = new Set(v.targets.flatMap((t) => {
      const sunk = new Set(t.sunk.flatMap((x) => x.cells));
      return t.hits.filter((c) => !sunk.has(c)).flatMap(neighbours).map((c) => `${t.sea} ${c}`);
    }));
    const lure = legal.filter((c) => 'trick' in c && c.trick === 'mine' && next.has(`${c.at} ${c.cell}`));
    return rng.pick(lure.length > 0 && rng.next() < 0.5 ? lure : legal);
  }
  // An open crate comes first in legal: pass one time in five, else a card (a swap, when the hands are full).
  const crate = legal.filter((c): c is Extract<SalvoCommand, { crate: string }> => 'crate' in c);
  if (crate.length > 0) {
    const cards = crate.filter((c) => c.crate !== 'pass');
    return rng.next() < 0.2 || cards.length === 0 ? crate.find((c) => c.crate === 'pass')! : rng.pick(cards);
  }
  if (v.phase === 'deploy') {
    const random = legal.find((c) => 'place' in c && c.place === 'random')!;
    return rng.next() < 0.5 ? random : rng.pick(legal);
  }
  // A held item, decided at the round's first shot: a kind it holds, then an aim of that kind.
  const items = legal.filter(isItemCmd);
  if (items.length > 0 && v.myOrders.length === 0 && rng.next() < 0.3) {
    const kind = rng.pick([...new Set(items.map(kindOf))]);
    return rng.pick(items.filter((c) => kindOf(c) === kind));
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

/**
 * Cells nobody but the sea's owner may see yet: unhit cells of a ship still afloat (the fog and the sonar only
 * count them), and the unhit cells of a live decoy (its owner's secret until a shot finds them).
 */
function hiddenCells(s: SalvoState, sea: string): Set<string> {
  const out = new Set<string>();
  for (const ship of s.fleets[sea]) {
    if (ship.hits.length === ship.cells.length) continue;
    for (const c of ship.cells) if (!ship.hits.includes(c)) out.add(c);
  }
  for (const d of s.decoys[sea]) if (!d.revealed) for (const c of d.cells) if (!d.hits.includes(c)) out.add(c);
  return out;
}
/** A sea's revealed decoy cells: public driftwood, no longer among its hits. */
const driftwoodOf = (s: SalvoState, sea: string) => new Set(s.decoys[sea].filter((d) => d.revealed).flatMap((d) => d.cells));

/** Unhit ship cells of a sea among `cells`: what a fog row or a buoy may report. */
const afloatAmong = (s: SalvoState, sea: string, cells: (c: string) => boolean) =>
  // A welded cell is heard as the hit the table saw (R-77).
  s.fleets[sea].reduce((n, x) => n + x.cells.filter((c) => cells(c) && !x.hits.includes(c) && !s.repairs[sea].some((r) => r.cell === c)).length, 0);

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
    for (const o of t.pending[x]) if (o.kind !== 'shell' && o.kind !== 'buoy') t.arsenal[x].push(o.kind);
    // Another seat's live decoy is its secret: gone, as if never laid (its hits stay: they are public hits).
    t.decoys[x] = t.decoys[x].filter((d) => d.revealed);
    // Which items another seat holds, and its crates' cards, are its secret: each swapped for another kind
    // (the counts stay: holding is public, and so is a crate owed, by the summary and by `ready`).
    t.arsenal[x] = t.arsenal[x].map(otherItem);
    t.crates[x] = t.crates[x].map((c) => c.map(otherItem));
    t.pending[x] = [];
    t.pendingTrick[x] = null;
  }
  if (t.phase !== 'over') {
    t.mines = t.mines.filter((m) => m.ghost === seat);
    t.splashes = t.splashes.filter((x) => x.ghost === seat || x.fool === seat);
    for (const a of t.auctions) {
      // Another seat's bid amounts are its own (a bid stays a bid; the close's price is public in its line).
      for (const [x, b] of Object.entries(a.bids)) if (x !== seat && b) a.bids[x] = { n: b.n + 1, at: b.at };
      if (a.ghost === seat) continue;
      // The truth and the tell are the ghost's, until the match ends; the winner knows only what it was told.
      if (a.state === 'sold' && a.winner === seat) a.tell = a.tell ?? a.truth;
      else if (a.tell !== null) a.tell = (a.tell + 1) % 10;
      a.truth = (a.truth + 1) % 10;
    }
  }
  return t;
}

/** A different item for each item (a bijection, so a crate's three stay three different cards). */
const otherItem = (x: ItemId): ItemId => ITEMS[(ITEMS.indexOf(x) + 1) % ITEMS.length];
const ITEM_WORD = /cluster|torpedo|repair|decoy/i;
/** Count of queued items per seat: they leave the hand at commit, and the table counts them until the reveal. */
const queuedItems = (s: SalvoState, seat: string) => s.pending[seat].filter((o) => o.kind !== 'shell' && o.kind !== 'buoy').length;
/** The table's afloat count for a sea: 12 less every public hit (a live decoy's hits count, a revealed decoy's don't). */
const publicAfloatOf = (s: SalvoState, sea: string) => {
  const drift = driftwoodOf(s, sea);
  // A welded cell still counts as the hit the table saw (R-77).
  return 12 - Object.entries(s.shots[sea]).filter(([c, x]) => x.result === 'hit' && !drift.has(c)).length - s.repairs[sea].length;
};
/** Unhit cells of a sea's live decoy. */
const liveDecoyCells = (s: SalvoState, sea: string) => s.decoys[sea].filter((d) => !d.revealed).flatMap((d) => d.cells.filter((c) => !d.hits.includes(c)));

/** Review Focus 1: no unrevealed ship cell, nobody else's pending aim, and no ghost's secret reaches any view. */
function assertNoLeaks(s: SalvoState, step: number, tally?: Tally): void {
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
    const own = seat !== null && s.phase === 'fire' ? s.pending[seat].map((x) => ({ fire: x.kind, at: x.sea, cell: x.cell, ...(x.lane !== undefined ? { lane: x.lane } : {}), ...(x.facing !== undefined ? { facing: x.facing } : {}) })) : [];
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
      const a = openAuctionsOf(s).find((x) => x.ghost === seat);
      check(JSON.stringify(v.myTricks.whisper) === JSON.stringify(a ? { truth: a.truth, tell: a.tell } : null), `${where}: myTricks.whisper is not my own auction`);
    }
    // Whisper auctions: the open ones in public with each living seat's status, never an amount; your own bids;
    // the whispers you bought; every truth only once the match is over.
    const living = s.seats.filter((x) => !isOut(s, x));
    const auctions = openAuctionsOf(s).map((a) => ({
      ghost: a.ghost,
      sea: a.sea,
      centre: a.centre,
      cells: a.cells,
      closesAt: a.closesAt,
      bids: Object.fromEntries(living.map((x) => [x, a.bids[x] ? 'bid' : a.abstained.includes(x) ? 'abstained' : null])),
    }));
    check(JSON.stringify(v.auctions) === JSON.stringify(auctions), `${where}: auctions are not the open ones, sealed`);
    const myBids = seat === null ? {} : Object.fromEntries(openAuctionsOf(s).flatMap((a) => (a.bids[seat] ? [[a.ghost, a.bids[seat]!.n]] : [])));
    check(JSON.stringify(v.myBids) === JSON.stringify(myBids), `${where}: myBids is not my own`);
    const bought = s.auctions.filter((a) => seat !== null && a.state === 'sold' && a.winner === seat).map((a) => ({ ghost: a.ghost, sea: a.sea, cells: a.cells, said: a.tell ?? a.truth, paid: a.price, at: a.closedAt ?? null }));
    check(JSON.stringify(v.whispers) === JSON.stringify(bought), `${where}: whispers are not the ones I bought`);
    check((v.truths === null) === !over, `${where}: truths shown while live (or missing at the end)`);
    if (!over) {
      const { myTricks: _w, ...public_ } = rest;
      check(!JSON.stringify(public_).includes('"truth"') && !JSON.stringify(public_).includes('"tell"'), `${where}: a truth or a tell outside myTricks`);
    }
    // The false splashes this viewer is fooled by (it sees them as hits, and in its copy of the volley).
    const fakes = over || seat === null ? [] : s.splashes.filter((x) => x.fool === seat);
    const faked = new Set(fakes.map((x) => `${x.sea} ${x.cell}`));
    // guns: one per ship afloat, for every living seat, during fire only.
    const guns = s.phase === 'fire' ? Object.fromEntries(s.seats.filter((x) => !isOut(s, x)).map((x) => [x, s.fleets[x].filter((y) => y.hits.length < y.cells.length).length])) : {};
    check(JSON.stringify(v.guns) === JSON.stringify(guns), `${where}: guns miscounted`);
    if (seat === null) check(v.mySea === null, `${where}: a spectator has a sea`);
    else {
      check(JSON.stringify(v.mySea!.ships.filter((x) => x.cells.length > 0)) === JSON.stringify(s.fleets[seat]), `${where}: mySea is not my fleet`);
      const live = s.decoys[seat].find((d) => !d.revealed);
      check(JSON.stringify(v.mySea!.decoy) === JSON.stringify(live ? { cells: live.cells, hits: live.hits } : null), `${where}: mySea.decoy is not my live decoy`);
      check(JSON.stringify(v.mySea!.repaired) === JSON.stringify(s.repairs[seat].map((x) => x.cell)), `${where}: mySea.repaired is not my sparks`);
    }
    // holding: every living seat's items in hand plus any it has queued (they count until the volley lands),
    // capped at ITEM_LIMIT (a crate pick after queuing one must not read 3);
    // myArsenal: the viewer's own hand (a queued item already spent from it) and its open crate's cards.
    const holding = Object.fromEntries(s.seats.filter((x) => !isOut(s, x)).map((x) => [x, Math.min(ITEM_LIMIT, s.arsenal[x].length + queuedItems(s, x))]));
    check(JSON.stringify(v.holding) === JSON.stringify(holding), `${where}: holding is not hand + queued, capped`);
    check(Object.values(v.holding).every((n) => n <= ITEM_LIMIT), `${where}: holding reads over ${ITEM_LIMIT}`);
    if (tally && s.seats.some((x) => queuedItems(s, x) > 0)) tally.paths.heldQueued = (tally.paths.heldQueued ?? 0) + 1;
    const arsenal = seat !== null && !isOut(s, seat) ? { items: s.arsenal[seat], crate: s.crates[seat][0] ?? null } : null;
    check(JSON.stringify(v.myArsenal) === JSON.stringify(arsenal), `${where}: myArsenal is not my own hand and crate`);
    for (const t of v.targets) {
      check(t.sea !== seat, `${where}: my own sea is a target`);
      // Hits and misses are the real ones (a live decoy's hits among them, a revealed decoy's not), plus (for a fool)
      // its own false splashes and nobody else's, and the welded cells.
      const real = Object.entries(s.shots[t.sea]);
      const drift = driftwoodOf(s, t.sea);
      // A welded cell still reads as the hit it was (R-77).
      const hits = [...new Set([...real.filter(([c, x]) => x.result === 'hit' && !drift.has(c)).map(([c]) => c), ...s.repairs[t.sea].map((x) => x.cell), ...fakes.filter((x) => x.sea === t.sea).map((x) => x.cell)])].sort(byBoard);
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
      // The table's afloat: never below 1 while the fleet lives (a live decoy's hits could push it past), 0 once out.
      check(t.afloat === (isOut(s, t.sea) ? 0 : Math.max(1, 12 - t.hits.length)), `${where}: ${t.sea}'s afloat reads ${t.afloat}`);
      if (over) continue;
      check(t.mines === undefined, `${where}: ${t.sea}'s mines shown while live`);
      check(t.revealed === undefined, `${where}: ${t.sea} revealed while live`);
      check(t.out === isOut(s, t.sea), `${where}: ${t.sea}'s out flag is wrong`);
      const hidden = hiddenCells(s, t.sea);
      // A buoy's cells are its 3×3, not ship positions; they are checked on their own below.
      // A fool's fake was aimed blind: if it happens to sit on a ship, that says nothing.
      // A repair is its owner's secret (R-77): the table goes on seeing the hit that was there (so a welded cell may
      // be named, as a hit, as it was before), never a spark, and the hit's shooters keep it in their record.
      const welded = s.repairs[t.sea];
      check(!('repaired' in t), `${where}: ${t.sea}'s sparks shown to another seat`);
      for (const x of welded) check(t.hits.includes(x.cell), `${where}: ${t.sea}'s welded ${x.cell} no longer reads as a hit`);
      if (seat !== null) for (const x of welded) if ((x.by ?? []).includes(seat)) check(t.mine.some((m) => m.cell === x.cell && m.result === 'hit'), `${where}: my welded hit on ${t.sea} ${x.cell} left my record`);
      const weldedCells = new Set(welded.map((x) => x.cell));
      for (const str of strings({ ...t, sonar: [] })) check(!hidden.has(str) || faked.has(`${t.sea} ${str}`) || weldedCells.has(str), `${where}: hidden ship cell ${t.sea} ${str}`);
      // The fog's counts are true counts (a fake splash does not change them: the accepted bluff).
      // Fog and sonar count real ship cells only: a live decoy under them is invisible.
      const decoyed = liveDecoyCells(s, t.sea);
      for (const x of t.lifted) {
        check(x.afloat === afloatAmong(s, t.sea, (c) => Number(c.slice(1)) === x.row), `${where}: row ${x.row} miscounted`);
        if (tally && decoyed.some((c) => Number(c.slice(1)) === x.row)) tally.paths.decoyUnderFog = (tally.paths.decoyUnderFog ?? 0) + 1;
      }
      // A sonar reading reaches its dropper alone, and says what is really there.
      const own = seat === null ? [] : s.sonar[seat].filter((x) => x.sea === t.sea);
      check(t.sonar.length === own.length, `${where}: ${t.sea} shows sonar that is not the viewer's`);
      t.sonar.forEach((x, k) => {
        check(x.cell === own[k].cell && JSON.stringify(x.cells) === JSON.stringify(buoyCells(x.cell)), `${where}: a reading's 3×3`);
        check(x.afloat === afloatAmong(s, t.sea, (c) => x.cells.includes(c)), `${where}: a reading miscounts`);
        if (tally && decoyed.some((c) => x.cells.includes(c))) tally.paths.decoyUnderSonar = (tally.paths.decoyUnderSonar ?? 0) + 1;
      });
    }
    // A boomerang says its cell is water: no shot of that volley may read a hit there (only a decoy could make one).
    for (const t of s.lastVolley?.tricks ?? []) {
      if (t.kind !== 'mine' || t.result !== 'boomerang') continue;
      check(s.shots[t.sea][t.cell]?.result !== 'hit', `${where}: a boomerang's cell ${t.sea} ${t.cell} recorded a hit`);
      check(!s.lastVolley!.shells.some((x) => x.sea === t.sea && x.cell === t.cell && x.result !== 'miss'), `${where}: a boomerang's cell ${t.sea} ${t.cell} hit in its volley`);
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
      // Every cell the volley names was shot in it (a repair's spark is public; a told splash was aimed blind), so
      // never an unhit cell of a live decoy or a ship afloat.
      if (!over) {
        const named: [string, string][] = [
          ...v.lastVolley.shells.filter((x) => !faked.has(`${x.sea} ${x.cell}`)).map((x): [string, string] => [x.sea, x.cell]),
          ...v.lastVolley.blasts.flatMap((b) => b.cells.map((c): [string, string] => [b.sea, c])),
          ...v.lastVolley.tricks.flatMap((x): [string, string][] => (x.kind === 'mine' ? [[x.sea, x.cell], ...(x.result === 'boomerang' ? x.hits.map((h): [string, string] => [h.sea, h.cell]) : [])] : [])),
          ...v.lastVolley.items.flatMap((x): [string, string][] =>
            x.item === 'cluster' ? [x.cell, ...x.cells].map((c) => [x.sea, c]) : x.item === 'torpedo' ? x.path.map((c) => [x.sea, c]) : x.item === 'decoy' ? x.cells.map((c) => [x.sea, c]) : [],
          ),
        ];
        for (const [sea, c] of named) check(s.shots[sea][c] !== undefined, `${where}: lastVolley names ${sea} ${c}, unshot`);
      }
      // Where a repair welded is told to its owner alone while the match is live.
      for (const x of v.lastVolley.items) if (x.item === 'repair') check(over || x.from === seat ? true : x.cell === undefined, `${where}: ${x.from}'s repair cell told to ${seat}`);
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
    // (A whisper's area is public: a ghost's blind pick, like a buoy's drop.)
    const { mySea: _m, targets: _t, lastVolley: _l, myOrders: _o, myTricks: _k, auctions: _a, whispers: _w, truths: _r, ...top } = rest;
    for (const str of strings(top)) check(cellIndex(str) === null, `${where}: a cell in the view's top level`);
    // No item is named outside the viewer's own hand and orders and the public volley (a crate is its owner's alone).
    const { myArsenal: _h, ...elsewhere } = top;
    // (A shot of your own on a revealed decoy reads 'decoy': public driftwood, and only that.)
    for (const t of v.targets) for (const m of t.mine) check(m.result !== 'decoy' || driftwoodOf(s, t.sea).has(m.cell), `${where}: ${t.sea} ${m.cell} reads decoy, not driftwood`);
    const targets = v.targets.map((t) => ({ ...t, mine: t.mine.map((m) => m.cell) }));
    for (const str of strings([elsewhere, targets, v.mySea])) check(!ITEM_WORD.test(str), `${where}: an item named in the view: ${str}`);
  }
}

// ── Whisper: the copy the table may hear (written out here, not borrowed from the module) ──
const areaText = (a: Auction) => `${a.cells[0]}–${a.cells.at(-1)}`;
const listingText = (a: Auction) => `👻 {${a.ghost}} auctions a sonar reading on {${a.sea}}'s sea, ${areaText(a)} — 30 seconds.`;
const closeText = (a: Auction) => (a.state === 'sold' ? `{${a.winner}} wins {${a.ghost}}'s whisper for ${a.price} scrap.` : `Nobody bids on {${a.ghost}}'s whisper.`);
const fadeText = (a: Auction) => `{${a.ghost}}'s whisper fades with them.`;
const truthText = (a: Auction) => {
  const told = a.tell ?? a.truth;
  return `{${a.ghost}} told {${a.winner}} ${told} in {${a.sea}}'s ${areaText(a)}. The truth was ${a.truth}.${told === a.truth ? ' An honest ghost!' : ''}`;
};
const WHISPER_LINE = /whisper|auctions a sonar|The truth was/;
/** Auctions open before and sold or unsold after (pairs: before, after). */
const closedAuctions = (before: SalvoState, after: SalvoState): [Auction, Auction][] =>
  before.auctions.flatMap((a, i): [Auction, Auction][] => (a.state === 'open' && (after.auctions[i].state === 'sold' || after.auctions[i].state === 'unsold') ? [[a, after.auctions[i]]] : []));
/** Every whisper line a change may tell: its listings, closes and fades, and the truths once the match ends. */
function whisperTexts(before: SalvoState, after: SalvoState): Set<string> {
  const out = new Set<string>(closedAuctions(before, after).map(([, a]) => closeText(a)));
  for (const a of after.auctions.slice(before.auctions.length)) out.add(listingText(a));
  for (const a of after.auctions) if (a.state === 'faded' && a.closedRound === before.round) out.add(fadeText(a));
  if (before.phase !== 'over' && after.phase === 'over') for (const a of after.auctions) if (a.state === 'sold') out.add(truthText(a));
  return out;
}

/** The round's story mentions only cells and ships of the volley that just landed (its tricks included, now told). */
function assertSummarySafe(before: SalvoState, after: SalvoState): void {
  const lines = roundSummary(before, after);
  const changed = after.round !== before.round || after.phase !== before.phase;
  const ended = before.phase !== 'over' && after.phase === 'over';
  // Whispers: inside a round (a clock close) the summary is exactly the closes, and nothing at all when none
  // closed; a resolution tells its closes, listings, fades and (at the end) truths, and no other whisper line.
  const closes = closedAuctions(before, after).map(([, a]) => closeText(a));
  if (!changed) {
    check(JSON.stringify(lines) === JSON.stringify(closes), `a summary inside a round is not exactly its closes: ${JSON.stringify(lines)}`);
    return;
  }
  const said = whisperTexts(before, after);
  const must = [...closes, ...after.auctions.slice(before.auctions.length).map(listingText), ...(ended ? after.auctions.filter((a) => a.state === 'sold').map(truthText) : [])];
  for (const line of must) check(lines.includes(line), `the summary misses a whisper line: ${line}`);
  for (const line of lines) if (WHISPER_LINE.test(line)) check(said.has(line), `a whisper line not owed by this change: ${line}`);
  if (!ended) for (const line of lines) check(!/truth|told/i.test(line), `a whisper's truth told while live: ${line}`);
  const v = after.lastVolley;
  const told = v ? v.tricks.flatMap((t) => [t.cell, ...(t.kind === 'mine' && t.result === 'boomerang' ? t.hits.map((h) => h.cell) : [])]) : [];
  const used = v ? (v.items ?? []).flatMap((x) => (x.item === 'cluster' ? [x.cell, ...x.cells] : x.item === 'torpedo' ? x.path : x.item === 'repair' ? [] : x.item === 'decoy-laid' ? [] : x.cells)) : [];
  // A whisper's area is told when it's listed (this volley) and when the truth comes out (the end).
  const listed = after.auctions.slice(before.auctions.length).flatMap((a) => a.cells);
  const truths = after.phase === 'over' ? after.auctions.filter((a) => a.state === 'sold').flatMap((a) => a.cells) : [];
  const landed = new Set([...(v ? [...v.shells.map((x) => x.cell), ...v.buoys.map((x) => x.cell), ...v.blasts.flatMap((b) => b.cells), ...told, ...used] : []), ...listed, ...truths]);
  const sunk = new Set<string>(v ? v.sunk.map((x) => x.ship) : []);
  // An item is named only when it was used in this volley (a decoy also when one is found, or a mine blows it up):
  // never a held item, a crate's cards, or a decoy still out there.
  const kinds = new Set<string>(v ? (v.items ?? []).map((x) => (x.item === 'decoy-laid' ? 'decoy' : x.item)) : []);
  if (v?.tricks.some((t) => t.kind === 'mine' && t.result === 'backfire' && t.ship === 'decoy')) kinds.add('decoy');
  const words: [RegExp, string][] = [
    [/cluster/i, 'cluster'],
    [/torpedo/i, 'torpedo'],
    [/weld|repair/i, 'repair'],
    [/decoy/i, 'decoy'],
  ];
  for (const line of lines) {
    for (const [word, kind] of words) check(!word.test(line) || kinds.has(kind), `summary names an item not used: ${line}`);
    if (line.includes('pulls a crate')) check(!ITEM_WORD.test(line), `a crate's cards told: ${line}`);
    // Laying a decoy is told, never where.
    if (line.includes('slips a decoy')) check((line.match(CELL) ?? []).length === 0, `a decoy laid is placed: ${line}`);
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
  /**
   * Arsenal paths walked: items used and decoys found or blown up (from the volleys), crate pick/swap/pass,
   * legal entries applied by kind (`apply:<kind>`), random item and crate commands checked against legal
   * (`agree`), decoys moved under a seat's legal (`decoyBlind`), decoys under fog and sonar.
   */
  paths: Record<string, number>;
}
const bump = (t: Tally, k: string, n = 1) => (t.paths[k] = (t.paths[k] ?? 0) + n);

/** A random trick command, legal or not. */
function randomTrick(s: SalvoState, rng: Rng): SalvoCommand {
  const at = rng.pick(s.seats);
  const cell = cellName(rng.int(64));
  return rng.next() < 0.5 ? { trick: 'mine', at, cell } : { trick: 'splash', fool: rng.pick(s.seats), at, cell };
}

/** A random item or crate command, legal or not (key order as legal writes them, so JSON compares). */
function randomItemCmd(s: SalvoState, seat: string, rng: Rng): SalvoCommand {
  const sea = rng.pick(s.seats);
  const cell = cellName(rng.int(64));
  switch (rng.int(5)) {
    case 0: {
      const r = rng.next();
      return r < 0.2 ? { crate: 'pass' } : r < 0.6 ? { crate: rng.pick(ITEMS) } : { crate: rng.pick(ITEMS), drop: rng.pick(ITEMS) };
    }
    case 1:
      return { fire: 'cluster', at: sea, cell };
    case 2:
      return { fire: 'torpedo', at: sea, lane: rng.pick([...lanesFor('north'), ...lanesFor('east')]) };
    case 3: {
      // Half the time a cell of the seat's own fleet: hit or not, sunk or not.
      const own = s.fleets[seat]?.flatMap((x) => x.cells) ?? [];
      return { use: 'repair', cell: own.length > 0 && rng.next() < 0.5 ? rng.pick(own) : cell };
    }
    default:
      return { use: 'decoy', at: cell, facing: rng.pick(['east', 'north'] as const) };
  }
}

/**
 * legal × apply for the arsenal: one entry of every kind on offer applies cleanly (a crate pick, swap and pass,
 * each item, a shell, a buoy), and random item and crate commands are accepted exactly when legal lists them
 * (refused with a code otherwise).
 */
function checkArsenalCommands(s: SalvoState, seat: string, legal: SalvoCommand[], rng: Rng, g: number, tally: Tally): void {
  const groups = new Map<string, SalvoCommand[]>();
  for (const c of legal) {
    const k = 'crate' in c ? (c.crate === 'pass' ? 'pass' : 'drop' in c ? 'swap' : 'pick') : (kindOf(c) ?? 'other');
    groups.set(k, [...(groups.get(k) ?? []), c]);
  }
  for (const [k, cmds] of groups) {
    // Shells and buoys are most of every turn (and apply once a turn already): sampled; crates and items always.
    if ((k === 'shell' || k === 'buoy') && rng.next() < 0.85) continue;
    const cmd = rng.pick(cmds);
    const code = codeOf(() => turn.apply(s, seat, cmd));
    check(code === null, `game ${g}: ${seat}'s legal ${JSON.stringify(cmd)} was refused (${code})`);
    bump(tally, `apply:${k}`);
  }
  const offered = new Set(legal.map((x) => JSON.stringify(x)));
  for (let k = 0; k < 2; k++) {
    const cmd = randomItemCmd(s, seat, rng);
    const code = codeOf(() => turn.apply(s, seat, cmd));
    if (offered.has(JSON.stringify(cmd))) check(code === null, `game ${g}: ${seat}'s legal ${JSON.stringify(cmd)} was refused (${code})`);
    else check(code !== null && code !== 'NO_CODE', `game ${g}: ${seat}'s ${JSON.stringify(cmd)} is not in legal but was ${code === null ? 'accepted' : 'refused without a code'}`);
    bump(tally, code === null ? 'agree:accepted' : 'agree:refused');
  }
}

/**
 * The same state with another seat's live decoy moved somewhere else it may lie: cells nobody has shot, clear of
 * that fleet, a hit cell kept where it is (a hit is public). Null when no decoy of a seat but `not` can move.
 */
function decoyMoved(s: SalvoState, not: string, rng: Rng): SalvoState | null {
  const t = structuredClone(s);
  for (const sea of [...t.seats].sort(() => rng.next() - 0.5)) {
    if (sea === not) continue;
    const d = t.decoys[sea].find((x) => !x.revealed);
    if (!d || d.hits.length > 1) continue;
    const ships = new Set(t.fleets[sea].flatMap((x) => x.cells));
    const options: string[][] = [];
    for (let i = 0; i < 64; i++) {
      for (const facing of ['east', 'north'] as const) {
        const cells = hullCells(cellName(i), 2, facing);
        if (!cells || cells.join() === d.cells.join() || !d.hits.every((h) => cells.includes(h))) continue;
        if (cells.every((c) => d.hits.includes(c) || (!t.shots[sea][c] && !ships.has(c)))) options.push(cells);
      }
    }
    if (options.length === 0) continue;
    d.cells = rng.pick(options);
    return t;
  }
  return null;
}

/** Blind to decoys: another seat's live decoy moved under this seat changes nothing it can ask about or see. */
function checkBlindToDecoys(s: SalvoState, seat: string, legal: SalvoCommand[], rng: Rng, g: number, tally: Tally): void {
  const moved = decoyMoved(s, seat, rng);
  if (!moved) return;
  bump(tally, 'decoyBlind');
  check(JSON.stringify(turn.legal(moved, seat)) === JSON.stringify(legal), `game ${g}: ${seat}'s legal depends on where a decoy is`);
  check(JSON.stringify(turn.toMove(moved)) === JSON.stringify(turn.toMove(s)), `game ${g}: toMove depends on where a decoy is`);
  check(JSON.stringify(viewOf(moved, seat)) === JSON.stringify(viewOf(s, seat)), `game ${g}: ${seat}'s view depends on where a decoy is`);
  for (let k = 0; k < 4; k++) {
    const cmd = k % 2 === 0 ? randomItemCmd(s, seat, rng) : rng.next() < 0.5 ? randomTrick(s, rng) : { fire: 'shell' as const, at: rng.pick(s.seats), cell: cellName(rng.int(64)) };
    check(codeOf(() => turn.apply(moved, seat, cmd)) === codeOf(() => turn.apply(s, seat, cmd)), `game ${g}: ${seat}'s refusal of ${JSON.stringify(cmd)} depends on where a decoy is`);
  }
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
  const living = s.seats.filter((x) => !isOut(s, x)).length;
  // Mines, splashes, whispers (36 centres a living sea), then tells 0–9 while its auction runs.
  check(legal.length <= living * 64 + (living >= 3 ? living * (living - 1) * 64 : 0) + living * 36 + 10, `game ${g}: a ghost's legal is ${legal.length} long`);
  check(legal.every((c) => isTrickCmd(c) || isTellCmd(c)), `game ${g}: a ghost is offered something other than a trick or a tell`);
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
  // A ghost holds no items and opens no crates.
  const item = randomItemCmd(s, seat, rng);
  check(!['NO_CODE', null].includes(codeOf(() => turn.apply(s, seat, item))), `game ${g}: a ghost's ${JSON.stringify(item)} was not refused with a code`);
  // A false splash is offered on exactly the living seas the table reads at 2+ afloat (a live decoy's hits count).
  const alive = s.seats.filter((x) => !isOut(s, x));
  const splashSeas = s.seats.filter((x) => legal.some((c) => 'trick' in c && c.trick === 'splash' && c.at === x));
  const want = alive.length >= 3 ? alive.filter((x) => publicAfloatOf(s, x) >= 2) : [];
  check(JSON.stringify(splashSeas) === JSON.stringify(want), `game ${g}: splash seas ${splashSeas} are not the seas the table reads at 2+ afloat (${want})`);
  if (want.some((x) => s.decoys[x].some((d) => !d.revealed && d.hits.length > 0))) bump(tally, 'splashOverDecoyHits');
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

// ── Whisper: the auction's invariants, checked on every change ──

const isOptionalCmd = (c: unknown) => typeof c === 'object' && c !== null && ('bid' in c || 'tell' in c);

/** The same state with every open auction's bids withdrawn: whatever closes now moves no scrap. */
function bidsStripped(s: SalvoState): SalvoState {
  const t = structuredClone(s);
  for (const a of t.auctions) if (a.state === 'open') a.bids = {};
  return t;
}

/** The sale an auction's bids make among `alive` (the oracle): the highest bid its bidder can pay, ties to the earliest. */
function expectedSale(s: SalvoState, a: Auction, alive: string[]): { winner: string; price: number } | null {
  let best: { winner: string; price: number; at: number } | null = null;
  for (const [x, b] of Object.entries(a.bids)) {
    if (!b || !alive.includes(x) || b.n < 1 || b.n > s.scrap[x]) continue;
    if (!best || b.n > best.price || (b.n === best.price && b.at < best.at)) best = { winner: x, price: b.n, at: b.at };
  }
  return best && { winner: best.winner, price: best.price };
}

/** Everything in a state but the auctions, the bid counter and the scrap: what a bid or a clock close may not touch. */
/** Everything but the whisper's own bookkeeping (the auctions, the bid counter, scrap, the clock's last time). */
const restOf = (s: SalvoState) => JSON.stringify({ ...s, auctions: null, bidSeq: null, scrap: null, lastNow: null });

/**
 * How a state changed: by the clock at `now` (a wake-up, or the call after a move), by an optional bid or tell,
 * or by an owed move or a forfeit (`redo` repeats it on another state).
 */
type Change = { kind: 'clock'; now: number } | { kind: 'optional' } | { kind: 'move' | 'forfeit'; redo: (t: SalvoState) => SalvoState };

/**
 * The auction's invariants across one change: one open auction per ghost, all a ghost's; wakeAt the earliest
 * open close; a closed auction frozen; listings only at a resolution; a close by the clock at or after its
 * closesAt, any other only when the round resolves (or the match ends); the winner the oracle's; and scrap
 * conserved: a clock close or a bid moves only the price, winner to ghost, and a resolution's scrap is the
 * same move on top of what the round would have paid with nobody bidding.
 */
function checkWhisper(before: SalvoState, after: SalvoState, change: Change, g: number, tally: Tally): void {
  const where = `game ${g}, round ${before.round}, ${change.kind}`;
  const open = openAuctionsOf(after);
  check(new Set(open.map((a) => a.ghost)).size === open.length, `${where}: a ghost with two auctions open`);
  check(open.every((a) => ghostsOf(after).includes(a.ghost)), `${where}: an auction open for a seat that is not a ghost at the table`);
  const times = after.phase === 'fire' ? open.flatMap((a) => (a.closesAt === null ? [] : [a.closesAt])) : [];
  check(turn.wakeAt!(after) === (times.length > 0 ? Math.min(...times) : null), `${where}: wakeAt ${turn.wakeAt!(after)} is not the earliest open close`);
  check(after.auctions.length >= before.auctions.length, `${where}: an auction vanished`);
  // Frozen once closed, but for its close time: a sale made as a round resolved is stamped by the next clock, at its now.
  before.auctions.forEach((a, i) => {
    if (a.state === 'open') return;
    const b = after.auctions[i];
    const stamped = change.kind === 'clock' && a.state === 'sold' && a.closedAt == null && b.closedAt === change.now;
    if (stamped) bump(tally, 'whisper:stampedAfterResolution');
    check(JSON.stringify(stamped ? { ...b, closedAt: a.closedAt } : b) === JSON.stringify(a), `${where}: a closed auction changed`);
  });
  // A sale by the clock carries that clock's time.
  if (change.kind === 'clock') after.auctions.forEach((b, i) => check(b.state !== 'sold' || (before.auctions[i]?.state ?? 'open') !== 'open' || b.closedAt === change.now, `${where}: a clock sale not stamped at its now`));
  const resolved = after.round !== before.round || after.phase !== before.phase;
  for (const a of after.auctions.slice(before.auctions.length)) {
    check(change.kind !== 'clock' && change.kind !== 'optional' && resolved, `${where}: a whisper listed outside a resolution`);
    check(a.state === 'open' && a.opensRound === before.round + 1 && a.closesAt === null && a.tell === null && Object.keys(a.bids).length === 0, `${where}: a listing is not a fresh auction for next round`);
    check(ghostsOf(before).includes(a.ghost) && a.truth >= 0 && a.truth <= 9 && a.sea !== a.ghost, `${where}: a listing by a non-ghost, or a truth out of range`);
    bump(tally, 'whisper:listed');
  }
  // The seats alive when the close was decided: before the change, less any seat forfeited by it (never a sinking: shells land after).
  const alive = before.seats.filter((x) => !isOut(before, x) && !after.eliminated.some((e) => e.seat === x && e.reason !== 'sunk'));
  const moved: Record<string, number> = Object.fromEntries(after.seats.map((x) => [x, 0]));
  const winners: string[] = [];
  before.auctions.forEach((a, i) => {
    const b = after.auctions[i];
    if (a.state !== 'open' || b.state === 'open') return;
    if (b.state === 'faded') {
      check(change.kind === 'forfeit' && after.ghostsGone.includes(b.ghost) && !before.ghostsGone.includes(b.ghost) && b.winner === null, `${where}: a whisper faded with its ghost still here`);
      bump(tally, 'whisper:faded');
      return;
    }
    if (b.state === 'void') {
      check(after.phase === 'over' && a.opensRound > before.round, `${where}: an open auction voided`);
      return;
    }
    // Sold or unsold: by the clock at or after closesAt, or by the round resolving (or the match ending); never before.
    if (change.kind === 'clock') check(a.closesAt !== null && change.now >= a.closesAt, `${where}: closed at ${change.now}, before its close at ${a.closesAt}`);
    else check(change.kind !== 'optional' && resolved, `${where}: closed by a ${change.kind} that resolved nothing`);
    bump(tally, change.kind === 'clock' ? 'whisper:closeByClock' : 'whisper:closeByResolution');
    const want = expectedSale(before, a, alive);
    check(
      want ? b.state === 'sold' && b.winner === want.winner && b.price === want.price : b.state === 'unsold' && b.winner === null && b.price === 0,
      `${where}: ${a.ghost}'s whisper went ${b.state} to ${b.winner} for ${b.price}, not ${JSON.stringify(want)}`,
    );
    bump(tally, `whisper:${b.state}`);
    if (b.state !== 'sold') return;
    moved[b.winner!] -= b.price;
    moved[b.ghost] += b.price;
    winners.push(b.winner!);
    bump(tally, (b.tell ?? b.truth) === b.truth ? 'whisper:honest' : 'whisper:lie');
    if (b.winner === b.sea) bump(tally, 'whisper:bury');
    if (Object.entries(a.bids).filter(([k, x]) => x && x.n === b.price && alive.includes(k)).length > 1) bump(tally, 'whisper:tie');
  });
  // Scrap: transfers net 0, and nothing else moves scrap unless the round resolves.
  check(Object.values(moved).reduce((x, y) => x + y, 0) === 0, `${where}: a transfer that does not net to 0`);
  if (change.kind === 'clock' || change.kind === 'optional') {
    for (const x of after.seats) check(after.scrap[x] === before.scrap[x] + moved[x], `${where}: ${x}'s scrap ${before.scrap[x]} → ${after.scrap[x]}, transfers ${moved[x]}`);
    check(restOf(after) === restOf(before), `${where}: a ${change.kind} change touched more than the auctions and scrap`);
    if (change.kind === 'optional') check(JSON.stringify(after.scrap) === JSON.stringify(before.scrap), `${where}: a bid moved scrap`);
  } else if (winners.length > 0) {
    // The same change with nobody bidding: every seat's scrap is that plus the transfers. (A winner sunk in this
    // volley pays out half its scrap to its sinkers, after the price: that pay-out differs, so the check skips.)
    const victims = after.lastVolley && after.lastVolley !== before.lastVolley ? after.lastVolley.eliminated : [];
    if (winners.some((x) => victims.includes(x))) bump(tally, 'whisper:scrapSkipped');
    else {
      const bare = change.redo(bidsStripped(before));
      for (const x of after.seats) check(after.scrap[x] === bare.scrap[x] + moved[x], `${where}: ${x}'s scrap is ${after.scrap[x]}, not ${bare.scrap[x]} + transfers ${moved[x]}`);
      check(after.seats.reduce((n, x) => n + after.scrap[x], 0) === after.seats.reduce((n, x) => n + bare.scrap[x], 0), `${where}: scrap not conserved across a close`);
      bump(tally, 'whisper:scrapConserved');
    }
  }
}

/**
 * The engine's clock at `now`: its change checked (stamps at now + AUCTION_MS, closes only what is due, nothing
 * due left behind, the same object when nothing is due), told safely, and leak-free.
 */
function clocked(s: SalvoState, now: number, g: number, step: number, tally: Tally, leaks: boolean): SalvoState {
  const after = turn.clock!(s, now);
  const where = `game ${g}, round ${s.round}, clock ${now}`;
  if (after.phase === 'fire') {
    for (const a of openAuctionsOf(after)) {
      if (a.opensRound <= after.round) check(a.closesAt !== null && a.closesAt > now && a.closesAt <= now + AUCTION_MS, `${where}: an open auction unstamped, or due and still open`);
      else check(a.closesAt === null, `${where}: an auction stamped before its round`);
    }
    for (const [i, a] of after.auctions.entries()) if (a.closesAt !== null && s.auctions[i].closesAt === null) check(a.closesAt === now + AUCTION_MS, `${where}: stamped at ${a.closesAt}`);
  }
  check(turn.clock!(after, now) === after, `${where}: the clock changed a state twice at one time`);
  if (after === s) return s;
  bump(tally, 'clock:changed');
  checkWhisper(s, after, { kind: 'clock', now }, g, tally);
  if (leaks) {
    assertNoLeaks(after, step, tally);
    assertSummarySafe(s, after);
  }
  return after;
}

/**
 * A move that is never owed, before it is played: mayAct agrees with legal's optional entries for every seat;
 * `optional` flags exactly the bids and tells; a sample of the optional legal applies cleanly and changes nobody's
 * debt; random bids and tells apply exactly when legal lists them (refused with a code otherwise); a ghost, a gone
 * ghost or a spectator never bids; a bid without its ghost, while one auction is open, is the same bid. Then
 * one seat that may act bids, re-bids, abstains or tells. Null when nobody may act.
 */
function optionalMove(s: SalvoState, rng: Rng, g: number, tally: Tally): { seat: string; cmd: SalvoCommand } | null {
  const open = openAuctionsOf(s);
  const where = `game ${g}, round ${s.round}`;
  const optionals: Record<string, SalvoCommand[]> = {};
  for (const x of s.seats) {
    const legal = turn.legal(s, x) as SalvoCommand[];
    const opt = legal.filter(isOptionalCmd);
    optionals[x] = opt;
    check((opt.length > 0) === turn.mayAct!(s, x), `${where}: ${x}'s mayAct disagrees with its legal`);
    check(legal.every((c) => turn.optional!(s, c) === isOptionalCmd(c)), `${where}: optional flags a command wrongly for ${x}`);
    // Optional entries come after the owed ones (the autopilot reads the front).
    check(legal.findIndex(isOptionalCmd) === -1 || legal.slice(legal.findIndex(isOptionalCmd)).every(isOptionalCmd), `${where}: an owed entry after the optional ones`);
    const ghost = isOut(s, x);
    if (ghost) {
      check(opt.every(isTellCmd), `${where}: a ghost is offered a bid`);
      for (const a of open) {
        const code = codeOf(() => turn.apply(s, x, { bid: 1, ghost: a.ghost }));
        check(code !== null && code !== 'NO_CODE', `${where}: ghost ${x} bid on ${a.ghost}'s whisper (${code})`);
        bump(tally, 'whisper:ghostBidRefused');
      }
    } else check(opt.every((c) => 'bid' in c), `${where}: a living seat is offered a tell`);
    if (!opt.some(isTellCmd)) {
      const code = codeOf(() => turn.apply(s, x, { tell: 1 }));
      check(code !== null && code !== 'NO_CODE', `${where}: ${x} told without an auction of its own (${code})`);
    }
  }
  const nobody = codeOf(() => turn.apply(s, 'spectator', { bid: 1, ghost: open[0]?.ghost ?? s.seats[0] }));
  check(nobody !== null && nobody !== 'NO_CODE', `${where}: a spectator bid`);
  const actors = s.seats.filter((x) => optionals[x].length > 0);
  if (actors.length === 0) return null;
  const seat = rng.pick(actors);
  const opt = optionals[seat];
  const offered = new Set(opt.map((c) => JSON.stringify(c)));
  const owes = JSON.stringify([turn.toMove(s), s.ready]);
  for (let k = 0; k < 3; k++) {
    const cmd = rng.pick(opt);
    let t = s;
    const code = codeOf(() => (t = turn.apply(s, seat, cmd)));
    check(code === null, `${where}: ${seat}'s legal ${JSON.stringify(cmd)} was refused (${code})`);
    check(JSON.stringify([turn.toMove(t), t.ready]) === owes, `${where}: ${seat}'s ${JSON.stringify(cmd)} changed who owes`);
    bump(tally, 'apply:optional');
  }
  for (let k = 0; k < 3; k++) {
    const cmd: SalvoCommand = rng.next() < 0.5 ? { bid: rng.int(BID_LEGAL_MAX + 4) - 1, ghost: rng.pick([...s.seats]) } : { tell: rng.int(13) - 1 };
    const code = codeOf(() => turn.apply(s, seat, cmd));
    if (offered.has(JSON.stringify(cmd))) check(code === null, `${where}: ${seat}'s legal ${JSON.stringify(cmd)} was refused (${code})`);
    else if ('bid' in cmd && cmd.bid > BID_LEGAL_MAX && cmd.bid <= s.scrap[seat] && optionals[seat].some((c) => 'bid' in c && c.ghost === cmd.ghost)) continue; // legal lists bids up to BID_LEGAL_MAX; any up to your scrap is fine
    else check(code !== null && code !== 'NO_CODE', `${where}: ${seat}'s ${JSON.stringify(cmd)} is not in legal but was ${code === null ? 'accepted' : 'refused without a code'}`);
    bump(tally, code === null ? 'agree:optionalAccepted' : 'agree:optionalRefused');
  }
  // With one auction open, a bid may leave out its ghost: the same as naming it.
  const bids = opt.filter((c): c is Extract<SalvoCommand, { bid: number }> => 'bid' in c);
  if (open.length === 1 && bids.length > 0) {
    const b = rng.pick(bids);
    check(JSON.stringify(turn.apply(s, seat, { bid: b.bid } as SalvoCommand)) === JSON.stringify(turn.apply(s, seat, b)), `${where}: a bid without its ghost is not the same bid`);
  }
  // The move: a ghost tells the truth about a third of the time, else any number; a living seat abstains one
  // time in five, re-bids its own amount sometimes (its place in the tiebreak kept), and otherwise bids a few
  // scrap (the sea's owner, half the time, all it may: a bury).
  const v = viewOf(s, seat);
  if (isOut(s, seat)) {
    const truth = v.myTricks!.whisper!.truth;
    bump(tally, 'optional:tell');
    return { seat, cmd: rng.next() < 0.35 ? { tell: truth } : (rng.pick(opt) as SalvoCommand) };
  }
  const a = rng.pick(v.auctions);
  const on = bids.filter((c) => c.ghost === a.ghost);
  const mine = v.myBids[a.ghost];
  const r = rng.next();
  bump(tally, 'optional:bid');
  if (r < 0.2) return { seat, cmd: on[0] }; // { bid: 0 }
  if (r < 0.35 && mine !== undefined) {
    bump(tally, 'optional:rebid');
    return { seat, cmd: { bid: mine, ghost: a.ghost } };
  }
  if (a.sea === seat && rng.next() < 0.5) return { seat, cmd: on.at(-1)! };
  return { seat, cmd: on[Math.min(on.length - 1, 1 + rng.int(4))] };
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
  // A fake clock: 0–40 s pass between commands (mostly a few seconds, so some auctions run into the round's
  // resolution and some close on the clock), with a wake-up before each command and the engine's call after it.
  let now = 1_700_000_000_000;
  while (!G.outcome(s)) {
    if (++guard > 3000) throw new Error(`game ${g} did not finish`);
    now += rng.next() < 0.7 ? rng.int(4_000) : rng.int(40_001);
    s = clocked(s, now, g, guard, tally, leaks);
    const owing = turn.toMove(s);
    check(owing.length > 0, `game ${g}: nobody owes a move`);
    const before = s;
    const ghost = ghostsOf(s)[0];
    let change: Change;
    let optional: { seat: string; cmd: SalvoCommand } | null = null;
    // A ghost with its whisper up for auction fades now and then (a forfeit) before the close.
    const fader = openAuctionsOf(s).find((a) => a.opensRound <= s.round)?.ghost;
    if (forfeitGhost && !gone && ghost !== undefined) {
      change = { kind: 'forfeit', redo: (t) => G.forfeit(t, ghost, 'timeout') };
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
      const [who, why] = [rng.pick(alive), rng.pick(['resign', 'timeout', 'disconnect'])];
      change = { kind: 'forfeit', redo: (t) => G.forfeit(t, who, why) };
      s = G.forfeit(s, who, why);
    } else if (fader !== undefined && rng.next() < 0.03) {
      change = { kind: 'forfeit', redo: (t) => G.forfeit(t, fader, 'timeout') };
      s = G.forfeit(s, fader, 'timeout');
      check(s.auctions.some((a) => a.ghost === fader && a.state === 'faded'), `game ${g}: ${fader}'s whisper outlived it`);
    } else if (openAuctionsOf(s).length > 0 && rng.next() < 0.3 && (optional = optionalMove(s, rng, g, tally)) !== null) {
      // A bid, a re-bid, an abstention or a tell: owed by nobody, and it changes nobody's debt.
      const { seat, cmd } = optional;
      change = { kind: 'optional' };
      s = turn.apply(s, seat, cmd);
      check(JSON.stringify([turn.toMove(s), s.ready]) === JSON.stringify([turn.toMove(before), before.ready]), `game ${g}: ${seat}'s ${JSON.stringify(cmd)} changed who owes`);
      check(SAFE_DESCRIBE.includes(turn.describe!(cmd)), `describe: ${turn.describe!(cmd)}`);
      check(SAFE_NARRATE.includes(turn.narrate!(before, s, seat, cmd)), `narrate: ${turn.narrate!(before, s, seat, cmd)}`);
    } else {
      const seat = rng.pick(owing);
      const legal = turn.legal(s, seat) as SalvoCommand[];
      check(legal.length > 0, `game ${g}: ${seat} owes a move but has no legal one`);
      const mine = viewOf(s, seat);
      if (ghostsOf(s).includes(seat)) {
        checkGhostTurn(s, seat, legal, rng, g, tally);
        tally.ghostMoves += 1;
      } else {
        // Shells, buoys and crate choices, then a held cluster (a centre per cell), a held torpedo (a lane per sea),
        // a held repair (a hit cell of the fleet) and a held decoy (two facings from each cell: 56 + 56).
        // Then the bids, 0..20 on each open auction (three ghosts at most).
        if (s.phase === 'fire') check(legal.length <= 192 + 108 + 7 + 192 + 24 + 12 + 112 + 3 * 21, `game ${g}: legal is ${legal.length} long`);
        // legal × apply: a few other entries apply cleanly too, and a spent cell is refused.
        turn.apply(s, seat, rng.pick(legal));
        if (s.phase === 'fire' && rng.next() < 0.4) checkArsenalCommands(s, seat, legal, rng, g, tally);
      }
      // Nothing this seat may ask or see depends on where another seat's live decoy lies.
      if (s.phase === 'fire' && rng.next() < 0.25) checkBlindToDecoys(s, seat, legal, rng, g, tally);
      if (s.phase === 'fire' && !ghostsOf(s).includes(seat)) {
        // A living seat cannot play a trick.
        check(codeOf(() => turn.apply(s, seat, randomTrick(s, rng))) === 'NOT_A_GHOST', `game ${g}: a living seat played a trick`);
        // Spent: my water, my sunk cells and driftwood. A hit on a ship afloat may be shot again (R-77), and legal
        // offers every one of mine that isn't aimed this round, welded or not: legal can't tell them apart.
        const spent = mine.targets.filter((t) => !t.out).flatMap((t) => t.mine.filter((m) => m.result !== 'hit').map((m) => ({ fire: 'shell', at: t.sea, cell: m.cell })));
        if (!mine.myOrders.length) {
          for (const t of mine.targets.filter((x) => !x.out)) {
            for (const m of t.mine.filter((x) => x.result === 'hit')) {
              check((legal as { fire?: string; at?: string; cell?: string }[]).some((c) => c.fire === 'shell' && c.at === t.sea && c.cell === m.cell) || (mine.guns[seat] ?? 0) === 0 || legal.some((c) => 'crate' in (c as object)), `game ${g}: legal refuses my hit ${t.sea} ${m.cell}`);
            }
          }
        }
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
        // A seat with its salvo in owes only its crate.
        check(mine.myOrders.length < mine.guns[seat] || mine.myArsenal!.crate !== null, `game ${g}: ${seat} owes a shot with its salvo full`);
      }
      // A ghost lists a whisper about one time in five it may (choose would pick one only now and then).
      const whispers = legal.filter((c) => 'trick' in c && c.trick === 'whisper');
      const cmd = whispers.length > 0 && rng.next() < 0.2 ? rng.pick(whispers) : choose(mine, legal, rng);
      change = { kind: 'move', redo: (t) => turn.apply(t, seat, cmd) };
      if ('crate' in cmd) bump(tally, cmd.crate === 'pass' ? 'crate:pass' : 'drop' in cmd ? 'crate:swap' : 'crate:pick');
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
        if (t.kind === 'mine' && t.result === 'backfire' && t.ship === 'decoy') bump(tally, 'decoyBackfire');
      }
      for (const x of s.lastVolley.items) bump(tally, `item:${x.item}`);
    }
    // Whispers listed, closed (sold or not) or faded, and scrap conserved across the change.
    checkWhisper(before, s, change, g, tally);
    if (leaks) {
      assertNoLeaks(s, guard, tally);
      assertSummarySafe(before, s);
    }
    // The engine calls the clock after every accepted move.
    s = clocked(s, now, g, guard, tally, leaks);
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
  if (leaks) for (let k = 0; k <= s.seats.length; k++) assertNoLeaks(s, k, tally);
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
  const tally: Tally = { reasons: {}, blasts: 0, knockouts: 0, ghostMoves: 0, tricks: {}, blind: 0, ghostForfeits: 0, paths: {} };

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
    // ...and the arsenal: every crate choice, every item used, decoys found, blown up by a mine and moved
    // under other seats' legal, under fog and sonar, a queued item counted, and every kind applied from legal.
    const walked = [
      ...['crate:pick', 'crate:swap', 'crate:pass', 'item:cluster', 'item:torpedo', 'item:repair', 'item:decoy-laid', 'item:decoy', 'decoyBackfire'],
      ...['whisper:listed', 'whisper:sold', 'whisper:unsold', 'whisper:faded', 'whisper:lie', 'whisper:honest', 'whisper:bury', 'whisper:tie'],
      ...['whisper:closeByClock', 'whisper:closeByResolution', 'whisper:scrapConserved', 'whisper:ghostBidRefused', 'clock:changed'],
      ...['optional:bid', 'optional:rebid', 'optional:tell', 'apply:optional', 'agree:optionalAccepted', 'agree:optionalRefused'],
      ...['decoyBlind', 'decoyUnderFog', 'decoyUnderSonar', 'heldQueued', 'splashOverDecoyHits', 'agree:accepted', 'agree:refused'],
      ...['pick', 'swap', 'pass', 'cluster', 'torpedo', 'repair', 'decoy', 'shell', 'buoy'].map((k) => `apply:${k}`),
    ];
    expect(walked.filter((k) => !((tally.paths[k] ?? 0) > 0))).toEqual([]);
  }, 120_000);

  test('whisper closes never depend on bid order: highest bid, ties to the earliest placed, the same by the clock or by the round', () => {
    const seen = { interleavings: 0, ties: 0, sold: 0, unsold: 0, orderDecides: 0 };
    const T0 = 1_700_000_000_000;
    for (let seed = 1; seed <= 30; seed++) {
      const rng = createRng(seed * 71);
      const n = 3 + (seed % 2);
      const base = deployedAtRandom(n, 200 + seed);
      // One fleet down: a ghost whose whisper on a living sea opens this round; every living seat holds a little scrap.
      const ghost = base.seats[seed % n];
      hitAllBut(base, ghost, [], base.seats.find((x) => x !== ghost)!);
      base.eliminated.push({ seat: ghost, round: 0, reason: 'sunk' });
      const alive = base.seats.filter((x) => x !== ghost);
      const sea = alive[seed % alive.length];
      for (const x of alive) base.scrap[x] = 1 + rng.int(4);
      const cells = buoyCells('d4');
      const truth = afloatAmong(base, sea, (c) => cells.includes(c));
      base.auctions.push({ ghost, sea, centre: 'd4', cells, truth, tell: null, opensRound: base.round, closesAt: null, bids: {}, abstained: [], state: 'open', winner: null, price: 0, closedRound: null });
      const s = turn.clock!(base, T0);
      expect(s.auctions[0].closesAt).toBe(T0 + AUCTION_MS);
      // Each living seat's bids, in its own order: 1–3 amounts of 0..min(scrap, 3) (small, so ties come often).
      const scripts = alive.map((x) => Array.from({ length: 1 + rng.int(3) }, () => ({ seat: x, n: rng.int(Math.min(base.scrap[x], 3) + 1) })));
      const winners = new Set<string>();
      for (let k = 0; k < 6; k++) {
        // An interleaving of the scripts (each seat's own bids keep their order).
        const queues = scripts.map((q) => [...q]);
        const events: { seat: string; n: number }[] = [];
        while (queues.some((q) => q.length > 0)) events.push(rng.pick(queues.filter((q) => q.length > 0)).shift()!);
        // The model: a new amount takes the next place; the same amount again keeps its place; 0 withdraws.
        const held: Record<string, { n: number; at: number } | null> = {};
        events.forEach((e, at) => (held[e.seat] = e.n === 0 ? null : held[e.seat]?.n === e.n ? held[e.seat] : { n: e.n, at }));
        const top = Object.entries(held)
          .filter((e): e is [string, { n: number; at: number }] => e[1] !== null)
          .sort((x, y) => y[1].n - x[1].n || x[1].at - y[1].at);
        const want: { state: 'sold' | 'unsold'; winner: string | null; price: number } = top[0] ? { state: 'sold', winner: top[0][0], price: top[0][1].n } : { state: 'unsold', winner: null, price: 0 };
        if (top.length > 1 && top[0][1].n === top[1][1].n) seen.ties += 1;
        let t = s;
        for (const e of events) t = turn.apply(t, e.seat, { bid: e.n, ghost });
        expect(turn.toMove(t)).toEqual(turn.toMove(s));
        // Closed by the clock, at its close...
        const byClock = turn.clock!(t, T0 + AUCTION_MS);
        expect(turn.clock!(t, T0 + AUCTION_MS - 1)).toBe(t);
        // ...or by the round resolving first (every seat plays what it owes; the close comes before the shells).
        let byRound = t;
        while (byRound.round === t.round && !G.outcome(byRound)) {
          const seat = turn.toMove(byRound)[0];
          const owed = (turn.legal(byRound, seat) as SalvoCommand[]).filter((c) => !turn.optional!(byRound, c));
          byRound = turn.apply(byRound, seat, choose(viewOf(byRound, seat), owed, rng));
        }
        for (const end of [byClock, byRound]) {
          const a = end.auctions[0];
          expect({ state: a.state, winner: a.winner, price: a.price }).toEqual(want);
        }
        // Scrap moves only by the price, winner to ghost (a clock close changes nothing else).
        const paid = Object.fromEntries(base.seats.map((x) => [x, x === want.winner ? -want.price : x === ghost ? want.price : 0]));
        for (const x of base.seats) expect(byClock.scrap[x]).toBe(t.scrap[x] + paid[x]);
        seen[want.state] += 1;
        seen.interleavings += 1;
        winners.add(String(want.winner));
      }
      if (winners.size > 1) seen.orderDecides += 1;
    }
    expect(seen.ties).toBeGreaterThan(0);
    expect(seen.sold).toBeGreaterThan(0);
    expect(seen.unsold).toBeGreaterThan(0);
    // Ties are the only way order matters, and it does: the earliest placed wins.
    expect(seen.orderDecides).toBeGreaterThan(0);
  }, 30_000);

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

  test('resolution never depends on commit order with the arsenal: cluster, torpedo, repair and decoy (and a crate) in one round', () => {
    const tally = { rounds: 0, revealed: 0, rehit: 0, struckDecoy: 0 };
    for (let seed = 1; seed <= 12; seed++) {
      const rng = createRng(seed * 53);
      let s = deployedAtRandom(4, 100 + seed);
      while (s.round <= 2 + (seed % 4) && !G.outcome(s)) {
        const seat = turn.toMove(s)[0];
        s = turn.apply(s, seat, choose(viewOf(s, seat), turn.legal(s, seat) as SalvoCommand[], rng));
      }
      if (G.outcome(s) || s.eliminated.length > 0) continue;
      // Roles turn with the seed: one seat each holds a cluster, a torpedo, a repair and a decoy (nothing else).
      const [cl, tp, rp, dc] = [0, 1, 2, 3].map((k) => s.seats[(k + seed) % 4]);
      if (s.decoys[dc].some((d) => !d.revealed && d.hits.length > 0)) continue;
      s.decoys[dc] = s.decoys[dc].filter((d) => d.revealed);
      Object.assign(s.arsenal, { [cl]: ['cluster'], [tp]: ['torpedo'], [rp]: ['repair'], [dc]: ['decoy'] });
      // The torpedo's seat also has a crate to open this round.
      s.crates[tp] = [...s.crates[tp], ['cluster', 'repair', 'decoy']];
      // The repairer has a hit to weld on a ship afloat.
      if (!s.fleets[rp].some((x) => x.hits.length > 0 && x.hits.length < x.cells.length)) {
        const ship = s.fleets[rp].find((x) => x.cells.some((c) => !s.shots[rp][c]))!;
        const c = ship.cells.find((x) => !s.shots[rp][x])!;
        ship.hits = ship.cells.filter((x) => ship.hits.includes(x) || x === c);
        s.shots[rp][c] = { result: 'hit', by: [cl] };
      }
      const legalOf = (seat: string) => turn.legal(s, seat) as SalvoCommand[];
      const pickOr = (seat: string, want: SalvoCommand, kind: string) => {
        const offered = legalOf(seat);
        return offered.some((x) => JSON.stringify(x) === JSON.stringify(want)) ? want : rng.pick(offered.filter((x) => kindOf(x) === kind));
      };
      // The decoy goes down; the cluster lands on it and the torpedo runs its lane (the decoy may stop it);
      // the repaired cell is shelled in the same volley by a seat that never shot it.
      const decoy = rng.pick(legalOf(dc).filter((x) => kindOf(x) === 'decoy')) as Extract<SalvoCommand, { use: 'decoy' }>;
      const cells = hullCells(decoy.at, 2, decoy.facing)!;
      const lane = tp === 'east' || tp === 'west' ? cells[1].slice(1) : cells[1][0];
      const repair = rng.pick(legalOf(rp).filter((x) => kindOf(x) === 'repair')) as Extract<SalvoCommand, { use: 'repair' }>;
      const first: Record<string, SalvoCommand[]> = {
        [cl]: [pickOr(cl, { fire: 'cluster', at: dc, cell: cells[0] }, 'cluster')],
        [tp]: [pickOr(tp, { fire: 'torpedo', at: dc, lane }, 'torpedo')],
        [rp]: [repair],
        [dc]: [decoy],
      };
      const welder = s.seats.find((x) => x !== rp && !s.shots[rp][repair.cell].by.includes(x) && s.fleets[x].filter((y) => y.hits.length < y.cells.length).length >= 2);
      if (welder) first[welder].push({ fire: 'shell', at: rp, cell: repair.cell });
      const salvos: Record<string, SalvoCommand[]> = {};
      for (const seat of s.seats) {
        let t = s;
        for (const cmd of first[seat]) t = turn.apply(t, seat, cmd);
        const cmds = [...first[seat]];
        while (turn.toMove(t).includes(seat)) {
          const cmd = choose(viewOf(t, seat), turn.legal(t, seat) as SalvoCommand[], rng);
          cmds.push(cmd);
          t = turn.apply(t, seat, cmd);
        }
        expect(t.round).toBe(s.round);
        salvos[seat] = cmds;
      }
      expect(salvos[tp].some((x) => 'crate' in x)).toBe(true);
      const results: string[] = [];
      for (const order of permutations([...s.seats])) {
        let t = s;
        for (const seat of order) for (const cmd of salvos[seat]) t = turn.apply(t, seat, cmd);
        results.push(JSON.stringify(t));
        let u = s;
        const longest = Math.max(...s.seats.map((x) => salvos[x].length));
        for (let k = 0; k < longest; k++) for (const seat of order) if (k < salvos[seat].length) u = turn.apply(u, seat, salvos[seat][k]);
        results.push(JSON.stringify(u));
      }
      expect(new Set(results).size).toBe(1);
      const after = JSON.parse(results[0]) as SalvoState;
      const used = after.lastVolley!.items.map((x) => x.item);
      expect(used).toEqual(expect.arrayContaining(['cluster', 'torpedo', 'repair', 'decoy-laid']));
      tally.rounds += 1;
      if (used.includes('decoy')) tally.revealed += 1;
      if (after.lastVolley!.items.some((x) => x.item === 'torpedo' && x.struck !== null && cells.includes(x.struck))) tally.struckDecoy += 1;
      if (welder) {
        // Review Focus 5: the repair lands first, so the shell hits the welded cell again.
        expect(after.shots[rp][repair.cell]?.result).toBe('hit');
        tally.rehit += 1;
      }
    }
    expect(tally.rounds).toBeGreaterThan(5);
    expect(tally.revealed).toBeGreaterThan(0);
    expect(tally.rehit).toBeGreaterThan(0);
    expect(tally.struckDecoy).toBeGreaterThan(0);
  });
});
