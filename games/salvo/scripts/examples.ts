/**
 * The rules guide's diagrams, rendered from real engine states (setup + apply), never drawn by hand.
 * `bun games/salvo/scripts/examples.ts` prints each one under its name; `src/examples.test.ts` asserts
 * that docs/rules.md carries every one verbatim inside a fenced code block.
 */
import { cellIndex, clusterCells, hullCells, roundSummary, salvoGame as G, torpedoLane, type ItemUse, type SalvoCommand, type SalvoState, type SalvoView, type ShipId, type Trick } from '../src/index';

export interface Example {
  name: string;
  text: string;
}

type Fleet = [ShipId, string, 'east' | 'north'][];

const place = (s: SalvoState, seat: string, fleet: Fleet) =>
  fleet.reduce((x, [ship, at, facing]) => G.turn.apply(x, seat, { place: ship, at, facing }), s);

/** A story shot: a shell, a buoy when the third entry says so, or an Arsenal item sent as it is. */
type Shot = [string, string] | [string, string, 'buoy'] | SalvoCommand;
type Round = Record<string, Shot | Shot[]>;
/**
 * A round's extras: the tricks the story's ghosts send and the tricks the volley must tell ("mine west east d6");
 * the crate picks the story makes (every other crate is passed); the items the volley must tell ("torpedo north east c").
 */
interface Plays {
  tricks?: Record<string, SalvoCommand>;
  told?: string[];
  crates?: Record<string, SalvoCommand>;
  items?: string[];
}
const trickKey = (t: Trick) => `${t.kind} ${t.ghost} ${t.sea} ${t.cell}`;
/** An item as the volley tells it: "cluster north east c5", "torpedo west east 5", "repair east f6", "decoy-laid south", "decoy south g5 h5". */
function itemKey(x: ItemUse): string {
  if (x.item === 'cluster') return `cluster ${x.from} ${x.sea} ${x.cell}`;
  if (x.item === 'torpedo') return `torpedo ${x.from} ${x.sea} ${x.lane}`;
  if (x.item === 'repair') return `repair ${x.from} ${x.cell}`;
  if (x.item === 'decoy-laid') return `decoy-laid ${x.from}`;
  return `decoy ${x.sea} ${x.cells.join(' ')}`;
}
const isList = (x: Shot | Shot[]): x is Shot[] => Array.isArray(x) && typeof x[0] !== 'string';
const shotsOf = (x: Shot | Shot[]): Shot[] => (isList(x) ? x : [x]);
const isTuple = (x: Shot): x is [string, string] | [string, string, 'buoy'] => Array.isArray(x);
/** The sea a story shot aims at, if it aims at one (a repair or a decoy is on your own sea). */
const seaOf = (x: Shot): string | null => (isTuple(x) ? x[0] : 'at' in x && 'fire' in x ? (x.at as string) : null);
/** Every "sea cell" a story shot names or an item of it covers, so the open-water shots keep off them. */
function cellsOf(seat: string, x: Shot): string[] {
  if (isTuple(x)) return [`${x[0]} ${x[1]}`];
  const c = x as Record<string, string>;
  if (c.fire === 'cluster') return clusterCells(c.cell).map((y) => `${c.at} ${y}`);
  if (c.fire === 'torpedo') return torpedoLane(seat, c.lane)!.map((y) => `${c.at} ${y}`);
  if (c.use === 'repair') return [`${seat} ${c.cell}`];
  if (c.use === 'decoy') return hullCells(c.at, 2, c.facing as 'east' | 'north')!.map((y) => `${seat} ${y}`);
  return [];
}

/**
 * One round, in seat order (the order never changes the result): each seat's shots the story is about
 * (shells, or a buoy when the third entry says so), then the rest of its salvo, one shot per ship
 * afloat, into open water on the same sea, from h8 down, at cells no story shot of this game uses.
 */
function round(s: SalvoState, shots: Round, story: Set<string>, plays: Plays = {}): SalvoState {
  const start = s.round;
  // The ghosts' tricks the story is about, played first (the round can't resolve while a ghost owes one).
  for (const [ghost, trick] of Object.entries(plays.tricks ?? {})) s = G.turn.apply(s, ghost, trick);
  for (const seat of s.seats) {
    if (!shots[seat] || s.round !== start) continue;
    // The story's crate pick comes first, so an item picked this round can be used this round.
    if (plays.crates?.[seat]) s = G.turn.apply(s, seat, plays.crates[seat]);
    const mine = shotsOf(shots[seat]);
    for (const shot of mine) s = G.turn.apply(s, seat, isTuple(shot) ? { fire: shot[2] ?? 'shell', at: shot[0], cell: shot[1] } : shot);
    const sea = mine.map(seaOf).find((x) => x !== null);
    const named = story;
    // Until the salvo is in (the last one in resolves the round, and then the seat owes the next).
    while (s.round === start && s.phase === 'fire' && G.turn.toMove(s).includes(seat)) {
      const legal = G.turn.legal(s, seat) as { fire: string; at: string; cell: string }[];
      // Any other crate is owed too, and the story passes it.
      if (legal.some((c) => 'crate' in c)) {
        s = G.turn.apply(s, seat, { crate: 'pass' });
        continue;
      }
      if (!sea) throw new Error(`round ${start}: ${seat} has shots to fill and no sea to fill them on`);
      // Open water: no ship and no live decoy there, no story cell, nobody's shot this round.
      const water = legal
        .filter((c) => c.fire === 'shell' && c.at === sea && !named.has(`${sea} ${c.cell}`) && !s.fleets[sea].some((x) => x.cells.includes(c.cell)))
        .filter((c) => !s.decoys[sea].some((d) => d.cells.includes(c.cell)))
        .filter((c) => !s.seats.some((x) => s.pending[x].some((o) => o.sea === sea && o.cell === c.cell)))
        .sort((a, b) => cellIndex(b.cell)! - cellIndex(a.cell)!);
      s = G.turn.apply(s, seat, water[0]);
    }
  }
  // Any other ghost owes a trick before the round can resolve: a harmless one, a mine
  // on open water no story shot uses, so it never goes off and changes the story. Living seats are never
  // filled in here, so a round that forgets one fails visibly.
  for (const seat of s.seats) {
    if (s.round !== start || s.phase !== 'fire' || !G.stillSeated!(s, seat) || !G.turn.toMove(s).includes(seat)) continue;
    const legal = G.turn.legal(s, seat) as { trick: string; at: string; cell: string }[];
    const quiet = legal.find((c) => c.trick === 'mine' && !story.has(`${c.at} ${c.cell}`) && !s.fleets[c.at].some((x) => x.cells.includes(c.cell)));
    s = G.turn.apply(s, seat, quiet ?? legal[0]);
  }
  // A trick goes off only when the story names it (`plays.told`): one that went off unasked would change
  // the story without a word, and one the story names that doesn't go off would tell it wrong; both fail loudly.
  const told = s.lastVolley?.round === start ? s.lastVolley.tricks.map(trickKey) : [];
  const asked = plays.told ?? [];
  if (told.some((x) => !asked.includes(x)) || asked.some((x) => !told.includes(x))) {
    throw new Error(`round ${start} told tricks ${JSON.stringify(told)}, the story asked for ${JSON.stringify(asked)}`);
  }
  // The same for items: the open-water shots never use one, but one of them landing on a story's decoy or
  // repaired cell would change what an item did; every item the volley tells must be one the story asked for.
  const used = s.lastVolley?.round === start ? s.lastVolley.items.map(itemKey) : [];
  const wanted = plays.items ?? [];
  if (used.some((x) => !wanted.includes(x)) || wanted.some((x) => !used.includes(x))) {
    throw new Error(`round ${start} told items ${JSON.stringify(used)}, the story asked for ${JSON.stringify(wanted)}`);
  }
  return s;
}

const viewOf = (s: SalvoState, seat: string | null) => G.view(s, seat) as SalvoView;

/** One sea's part of a view's `ascii`: its heading line and the grid. */
function sea(view: SalvoView, seat: string): string {
  const chunk = view.ascii.split('\n\n').find((x) => x.startsWith(`${seat} (you),`) || x.startsWith(`${seat},`));
  if (!chunk) throw new Error(`no ${seat} sea in this view`);
  return chunk;
}

/** Two drawings side by side, the left one padded to a common width. */
function beside(left: string, right: string, gap = '     '): string {
  const a = left.split('\n');
  const b = right.split('\n');
  const width = Math.max(...a.map((x) => x.length));
  return Array.from({ length: Math.max(a.length, b.length) }, (_, i) => `${(a[i] ?? '').padEnd(width)}${gap}${b[i] ?? ''}`.trimEnd()).join('\n');
}

/** JSON with spaces, short values on one line, long ones broken one level at a time. */
function json(value: unknown, indent = ''): string {
  const inline = (v: unknown): string => {
    if (Array.isArray(v)) return `[${v.map(inline).join(', ')}]`;
    if (v && typeof v === 'object') return `{${Object.entries(v).map(([k, x]) => `"${k}": ${inline(x)}`).join(', ')}}`;
    return JSON.stringify(v);
  };
  const flat = inline(value);
  if (value === null || typeof value !== 'object') return flat;
  // A record of plain values (one shell, one ship) always stays on one line.
  const plain = !Array.isArray(value) && Object.values(value).every((x) => x === null || typeof x !== 'object');
  if (plain || indent.length + flat.length <= 100) return flat;
  const inner = `${indent}  `;
  if (Array.isArray(value)) return `[\n${value.map((x) => `${inner}${json(x, inner)}`).join(',\n')}\n${indent}]`;
  return `{\n${Object.entries(value).map(([k, x]) => `${inner}"${k}": ${json(x, inner)}`).join(',\n')}\n${indent}}`;
}

// ── The four-seat game most of the guide follows ──

const NORTH: Fleet = [['cruiser', 'b2', 'east'], ['destroyer', 'g3', 'north'], ['frigate', 'b6', 'east'], ['submarine', 'e5', 'north']];
const EAST: Fleet = [['cruiser', 'c4', 'north'], ['destroyer', 'e2', 'east'], ['frigate', 'f6', 'north'], ['submarine', 'g4', 'east']];
const SOUTH: Fleet = [['cruiser', 'a8', 'east'], ['destroyer', 'h1', 'north'], ['frigate', 'c3', 'east'], ['submarine', 'e6', 'north']];
const WEST: Fleet = [['cruiser', 'e1', 'north'], ['destroyer', 'a2', 'north'], ['frigate', 'b8', 'east'], ['submarine', 'g6', 'east']];

/** Every "sea cell" a list of rounds names, so the open-water shots keep off them. */
const storyOf = (rounds: Round[]) => new Set(rounds.flatMap((r) => Object.entries(r).flatMap(([seat, x]) => shotsOf(x).flatMap((y) => cellsOf(seat, y)))));

/** Each seat's shot the story follows, round by round; the rest of every salvo splashes. */
const FOUR_SEAT_ROUNDS: Round[] = [
  { north: ['east', 'd4'], east: ['north', 'c2'], south: ['east', 'c5'], west: ['north', 'f7'] },
  { north: ['east', 'c4'], east: ['north', 'd2'], south: ['east', 'g4'], west: ['south', 'a1'] },
  { north: ['east', 'c6'], east: ['north', 'a1'], south: ['east', 'h4'], west: ['east', 'b5'] },
  { north: ['east', 'c3'], east: ['north', 'e2'], south: ['east', 'b7'], west: ['south', 'd3'] },
  // Round 5: north and south both aim at east f2: Time on Target.
  { north: ['east', 'f2'], east: ['north', 'h1'], south: ['east', 'f2'], west: ['south', 'f5'] },
  // Round 6: north spends one shot on a sonar buoy at east g5.
  { north: ['east', 'g5', 'buoy'], east: ['north', 'h2'], south: ['east', 'h8'], west: ['south', 'f6'] },
  { north: ['east', 'a2'], east: ['north', 'h7'], south: ['east', 'g8'], west: ['south', 'f7'] },
  { north: ['east', 'a3'], east: ['north', 'h8'], south: ['east', 'h7'], west: ['south', 'f8'] },
  { north: ['east', 'a4'], east: ['north', 'a8'], south: ['east', 'h6'], west: ['south', 'g7'] },
];

/** The game, kept at each point the guide stops to look. */
function fourSeatGame() {
  const start = G.setup({ seats: ['north', 'east', 'south', 'west'], seed: 2026 });
  const halfway = place(start, 'north', NORTH.slice(0, 2));
  let s = place(halfway, 'north', NORTH.slice(2));
  s = place(s, 'east', EAST);
  s = place(s, 'south', SOUTH);
  const beforeLast = s;
  const deployed = place(s, 'west', WEST);
  s = deployed;
  const story = storyOf(FOUR_SEAT_ROUNDS);
  const after: SalvoState[] = [s];
  for (const r of FOUR_SEAT_ROUNDS) after.push((s = round(s, r, story)));
  const [beforeRound4, afterRound4, afterRound5, afterRound6, beforeRound9, round10] = [after[3], after[4], after[5], after[6], after[8], after[9]];
  const beforeRound6 = afterRound5;
  return { start, halfway, beforeLast, deployed, beforeRound4, afterRound4, afterRound5, beforeRound6, afterRound6, beforeRound9, round10 };
}

// ── A three-seat game that ends with two fleets sinking in the same volley ──

const STANDARD: Fleet = [['cruiser', 'a1', 'east'], ['destroyer', 'a3', 'east'], ['frigate', 'a5', 'east'], ['submarine', 'a7', 'east']];
const STANDARD_CELLS = ['a1', 'b1', 'c1', 'd1', 'a3', 'b3', 'c3', 'a5', 'b5', 'c5', 'a7', 'b7'];
const WATER = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'h7', 'h8', 'g1', 'g2', 'g3', 'g4', 'g5', 'g6', 'g7', 'g8'];

/**
 * North sinks south with three full salvos while the others splash; then north and east fire the
 * same cells at each other, ship by ship, until both go down at once.
 */
function tiebreakGame() {
  let s = G.setup({ seats: ['north', 'east', 'south'], seed: 7 });
  for (const seat of s.seats) s = place(s, seat, STANDARD);
  // Every ship cell, and the water the bystanders splash into, is the story; open-water shots keep off it.
  const story = new Set([...['north', 'east', 'south'].flatMap((sea) => STANDARD_CELLS.map((c) => `${sea} ${c}`)), ...['north', 'east'].flatMap((sea) => WATER.map((c) => `${sea} ${c}`))]);
  const guns = (seat: string) => (G.view(s, seat) as SalvoView).guns[seat] ?? 0;
  for (let i = 0; i < 3; i++) {
    const salvo = STANDARD_CELLS.slice(4 * i, 4 * i + guns('north')).map((c): Shot => ['south', c]);
    s = round(s, { north: salvo, east: ['north', WATER[i]], south: ['east', WATER[i]] }, story);
  }
  // The duel: each fires as many ship cells as it has guns, the same cells both ways.
  let fired = 0;
  let before = s;
  while (s.phase === 'fire') {
    before = s;
    const next = STANDARD_CELLS.slice(fired, fired + guns('north'));
    fired += next.length;
    s = round(s, { north: next.map((c): Shot => ['east', c]), east: next.map((c): Shot => ['north', c]) }, story);
  }
  return { before, after: s };
}

// ── A four-seat game where west goes down early and comes back as a ghost ──

/** North, east and south pile onto west for two rounds; then west's ghost plays a mine, a mine on a ship, and a false splash. */
const GHOST_ROUNDS: Round[] = [
  { north: [['west', 'e1'], ['west', 'e2']], east: [['west', 'a2'], ['west', 'a3']], south: [['west', 'b8'], ['west', 'c8']], west: ['north', 'a1'] },
  { north: [['west', 'e3'], ['west', 'e4'], ['west', 'a4'], ['west', 'd8']], east: [['west', 'g6'], ['west', 'h6']], south: ['east', 'h1'], west: ['north', 'a8'] },
  // Round 3: west's ghost hides a mine on east's d6 (open water).
  { north: ['south', 'a1'], east: ['north', 'h1'], south: ['east', 'a2'] },
  // Round 4: north fires at east's d6; west's ghost hides a second mine on south's c8 (south's cruiser).
  { north: ['east', 'd6'], east: ['north', 'h2'], south: ['east', 'a3'] },
  // Round 5: north fires at south's c8; west's ghost shows east a fake hit on north's a5.
  { north: ['south', 'c8'], east: ['north', 'h3'], south: ['north', 'a6'] },
  { north: ['south', 'a2'], east: ['north', 'h4'], south: ['north', 'a7'] },
];
const GHOST_PLAYS: Plays[] = [
  {},
  {},
  { tricks: { west: { trick: 'mine', at: 'east', cell: 'd6' } } },
  { tricks: { west: { trick: 'mine', at: 'south', cell: 'c8' } }, told: ['mine west east d6'] },
  { tricks: { west: { trick: 'splash', fool: 'east', at: 'north', cell: 'a5' } }, told: ['mine west south c8'] },
  { told: ['splash west north a5'] },
];

function ghostGame() {
  let s = G.setup({ seats: ['north', 'east', 'south', 'west'], seed: 1974 });
  for (const [seat, fleet] of [['north', NORTH], ['east', EAST], ['south', SOUTH], ['west', WEST]] as const) s = place(s, seat, fleet);
  const story = storyOf(GHOST_ROUNDS);
  for (const p of GHOST_PLAYS) for (const t of Object.values(p.tricks ?? {})) story.add(`${(t as { at: string }).at} ${(t as { cell: string }).cell}`);
  const after: SalvoState[] = [s];
  GHOST_ROUNDS.forEach((r, i) => after.push((s = round(s, r, story, GHOST_PLAYS[i]))));
  return { beforeSinking: after[1], sunk: after[2], mined: after[3], boomerang: after[4], backfire: after[5], told: after[6] };
}

// ── A four-seat game with the Arsenal: crates from sinkings, then each item in use ──

/**
 * Round 1 everyone sinks a submarine and round 2 a destroyer, two crates each. Then four torpedoes (one
 * from every side), a cluster that finishes east's cruiser around west's hit, a decoy south lays that fools
 * west, and east's repair.
 */
const ARSENAL_ROUNDS: Round[] = [
  { north: [['east', 'g4'], ['east', 'h4']], east: [['south', 'e6'], ['south', 'e7']], south: [['west', 'g6'], ['west', 'h6']], west: [['north', 'e5'], ['north', 'e6']] },
  {
    north: [['east', 'e2'], ['east', 'f2'], ['east', 'g2']],
    east: [['south', 'h1'], ['south', 'h2'], ['south', 'h3']],
    south: [['west', 'a2'], ['west', 'a3'], ['west', 'a4']],
    west: [['north', 'g3'], ['north', 'g4'], ['north', 'g5']],
  },
  // Round 3: a torpedo from every side.
  {
    north: { fire: 'torpedo', at: 'east', lane: 'c' },
    east: { fire: 'torpedo', at: 'north', lane: '6' },
    south: { fire: 'torpedo', at: 'east', lane: 'f' },
    west: { fire: 'torpedo', at: 'east', lane: '5' },
  },
  // Round 4: north's cluster on west's hit at east c5; south slips a decoy onto g5–h5.
  { north: { fire: 'cluster', at: 'east', cell: 'c5' }, east: ['north', 'a1'], south: [{ use: 'decoy', at: 'g5', facing: 'east' }, ['west', 'a1']], west: ['south', 'a1'] },
  // Round 5: east welds f6; west hits south's decoy at g5, and drops a buoy over it.
  { north: ['east', 'a1'], east: { use: 'repair', cell: 'f6' }, south: ['west', 'b1'], west: [['south', 'g5'], ['south', 'g4', 'buoy']] },
  // Round 6: west finishes the decoy.
  { north: ['east', 'b1'], east: ['north', 'b1'], south: ['west', 'c1'], west: ['south', 'h5'] },
];
const ARSENAL_PLAYS: Plays[] = [
  {},
  { crates: { north: { crate: 'torpedo' }, east: { crate: 'torpedo' }, south: { crate: 'torpedo' }, west: { crate: 'torpedo' } } },
  {
    crates: { north: { crate: 'cluster' }, east: { crate: 'repair' }, south: { crate: 'decoy' } },
    items: ['torpedo north east c', 'torpedo east north 6', 'torpedo south east f', 'torpedo west east 5'],
  },
  { items: ['cluster north east c5', 'decoy-laid south'] },
  { items: ['repair east f6'] },
  { items: ['decoy south g5 h5'] },
];

function arsenalGame() {
  let s = G.setup({ seats: ['north', 'east', 'south', 'west'], seed: 16 });
  for (const [seat, fleet] of [['north', NORTH], ['east', EAST], ['south', SOUTH], ['west', WEST]] as const) s = place(s, seat, fleet);
  const story = storyOf(ARSENAL_ROUNDS);
  const after: SalvoState[] = [s];
  ARSENAL_ROUNDS.forEach((r, i) => after.push((s = round(s, r, story, ARSENAL_PLAYS[i]))));
  // after[n] is the game once round n has landed.
  return after;
}

export function examples(): Example[] {
  const g = fourSeatGame();
  const t = tiebreakGame();
  const h = ghostGame();
  const out: Example[] = [];
  const add = (name: string, text: string) => out.push({ name, text });

  add('deploying', sea(viewOf(g.halfway, 'north'), 'north'));
  add('deployed-sea', sea(viewOf(g.deployed, 'north'), 'north'));
  add('deploy-header', viewOf(g.beforeLast, 'north').ascii.split('\n\n')[0]);
  add('target-sea', sea(viewOf(g.afterRound4, 'north'), 'east'));
  add('target-view', json(viewOf(g.afterRound4, 'north').targets.find((x) => x.sea === 'east')));
  add('round-4-summary', roundSummary(g.beforeRound4, g.afterRound4).join('\n'));
  add('round-4-volley', json(viewOf(g.afterRound4, 'north').lastVolley));
  add('time-on-target', beside(sea(viewOf(g.afterRound4, 'north'), 'east'), sea(viewOf(g.afterRound5, 'north'), 'east')));
  add('time-on-target-volley', json(viewOf(g.afterRound5, 'north').lastVolley));
  add('time-on-target-summary', roundSummary(g.afterRound4, g.afterRound5).join('\n'));
  add('fog-summary', roundSummary(g.beforeRound9, g.round10).join('\n'));
  add('lifted-row', beside(sea(viewOf(g.round10, null), 'east'), sea(viewOf(g.round10, null), 'south')));
  add('lifted-json', json(viewOf(g.round10, null).targets.find((x) => x.sea === 'east')!.lifted));
  add('buoy-summary', roundSummary(g.beforeRound6, g.afterRound6).join('\n'));
  add('buoy-reading', json(viewOf(g.afterRound6, 'north').targets.find((x) => x.sea === 'east')!.sonar));
  add('buoy-ascii', sea(viewOf(g.afterRound6, 'north'), 'east'));
  add('full-view', viewOf(g.afterRound5, 'north').ascii);
  add('my-sea', json(viewOf(g.afterRound5, 'north').mySea));
  add('tiebreak-summary', roundSummary(t.before, t.after).join('\n'));
  add('tiebreak-outcome', json(G.outcome(t.after)));
  add('tiebreak-scrap', json(viewOf(t.after, null).scrap));
  add('ghost-rises', roundSummary(h.beforeSinking, h.sunk).join('\n'));
  add('ghost-header', viewOf(h.mined, 'west').ascii.split('\n\n')[0]);
  add('ghost-mine-sea', sea(viewOf(h.mined, 'west'), 'east'));
  add('ghost-my-tricks', json(viewOf(h.mined, 'west').myTricks));
  add('ghost-mine', beside(sea(viewOf(h.mined, 'north'), 'north'), sea(viewOf(h.boomerang, 'north'), 'north')));
  add('ghost-mine-summary', roundSummary(h.mined, h.boomerang).join('\n'));
  add('ghost-mine-tricks', json(viewOf(h.boomerang, 'north').lastVolley!.tricks));
  add('ghost-backfire', beside(sea(viewOf(h.boomerang, 'north'), 'south'), sea(viewOf(h.backfire, 'north'), 'south')));
  add('ghost-backfire-summary', roundSummary(h.boomerang, h.backfire).join('\n'));
  add('ghost-splash', beside(sea(viewOf(h.backfire, 'east'), 'north'), sea(viewOf(h.told, 'east'), 'north')));
  add('ghost-splash-shells', json(viewOf(h.backfire, 'east').lastVolley!.shells.filter((x) => x.sea === 'north')));
  add('ghost-splash-summary', roundSummary(h.backfire, h.told).join('\n'));
  const a = arsenalGame();
  const told = (n: number) => roundSummary(a[n - 1], a[n]).join('\n');
  add('crate-summary', told(1));
  add('crate-arsenal', json(viewOf(a[1], 'north').myArsenal));
  add('crate-legal', (G.turn.legal(a[1], 'north') as SalvoCommand[]).slice(0, 4).map((x) => json(x)).join('\n'));
  add('holding', json(viewOf(a[3], 'north').holding));
  add('torpedo-sea', beside(sea(viewOf(a[2], 'north'), 'east'), sea(viewOf(a[3], 'north'), 'east')));
  add('torpedo-north-sea', beside(sea(viewOf(a[2], 'east'), 'north'), sea(viewOf(a[3], 'east'), 'north')));
  add('torpedo-summary', told(3));
  add('torpedo-items', json(viewOf(a[3], 'north').lastVolley!.items));
  add('cluster-sea', beside(sea(viewOf(a[3], 'north'), 'east'), sea(viewOf(a[4], 'north'), 'east')));
  add('cluster-summary', told(4));
  add('cluster-items', json(viewOf(a[4], 'north').lastVolley!.items));
  add('decoy-own-sea', beside(sea(viewOf(a[4], 'south'), 'south'), sea(viewOf(a[5], 'south'), 'south')));
  add('decoy-my-sea', json(viewOf(a[4], 'south').mySea!.decoy));
  add('repair-sea', beside(sea(viewOf(a[4], 'north'), 'east'), sea(viewOf(a[5], 'north'), 'east')));
  add('repair-summary', told(5));
  add('decoy-fooled', beside(sea(viewOf(a[4], 'west'), 'south'), sea(viewOf(a[5], 'west'), 'south')));
  add('decoy-revealed', sea(viewOf(a[6], 'west'), 'south'));
  add('decoy-summary', told(6));
  add('decoy-volley', json({ shells: viewOf(a[6], 'west').lastVolley!.shells.filter((x) => x.from === 'west'), items: viewOf(a[6], 'west').lastVolley!.items }));
  add('decoy-target', json(viewOf(a[6], 'west').targets.find((x) => x.sea === 'south')));
  return out;
}

if (import.meta.main) {
  for (const x of examples()) console.log(`── ${x.name} ──\n${x.text}\n`);
}
