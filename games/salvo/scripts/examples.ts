/**
 * The rules guide's diagrams, rendered from real engine states (setup + apply), never drawn by hand.
 * `bun games/salvo/scripts/examples.ts` prints each one under its name; `src/examples.test.ts` asserts
 * that docs/rules.md carries every one verbatim inside a fenced code block.
 */
import { cellIndex, roundSummary, salvoGame as G, type SalvoState, type SalvoView, type ShipId } from '../src/index';

export interface Example {
  name: string;
  text: string;
}

type Fleet = [ShipId, string, 'east' | 'north'][];

const place = (s: SalvoState, seat: string, fleet: Fleet) =>
  fleet.reduce((x, [ship, at, facing]) => G.turn.apply(x, seat, { place: ship, at, facing }), s);

type Shot = [string, string] | [string, string, 'buoy'];
type Round = Record<string, Shot | Shot[]>;
const shotsOf = (x: Shot | Shot[]): Shot[] => (Array.isArray(x[0]) ? (x as Shot[]) : [x as Shot]);

/**
 * One round, in seat order (the order never changes the result): each seat's shots the story is about
 * (shells, or a buoy when the third entry says so), then the rest of its salvo, one shot per ship
 * afloat, into open water on the same sea, from h8 down, at cells no story shot of this game uses.
 */
function round(s: SalvoState, shots: Round, story: Set<string>): SalvoState {
  const start = s.round;
  for (const seat of s.seats) {
    if (!shots[seat] || s.round !== start) continue;
    const mine = shotsOf(shots[seat]);
    for (const shot of mine) s = G.turn.apply(s, seat, { fire: shot[2] ?? 'shell', at: shot[0], cell: shot[1] });
    const sea = mine[0][0];
    const named = story;
    // Until the salvo is in (the last one in resolves the round, and then the seat owes the next).
    while (s.round === start && s.phase === 'fire' && G.turn.toMove(s).includes(seat)) {
      const legal = G.turn.legal(s, seat) as { fire: string; at: string; cell: string }[];
      const water = legal
        .filter((c) => c.fire === 'shell' && c.at === sea && !named.has(`${sea} ${c.cell}`) && !s.fleets[sea].some((x) => x.cells.includes(c.cell)))
        .filter((c) => !s.seats.some((x) => s.pending[x].some((o) => o.sea === sea && o.cell === c.cell)))
        .sort((a, b) => cellIndex(b.cell)! - cellIndex(a.cell)!);
      s = G.turn.apply(s, seat, water[0]);
    }
  }
  // Ghosts owe a trick before the round can resolve: the first one on offer (Task 7 stages the real ones).
  for (const seat of s.seats) {
    if (s.round === start && s.phase === 'fire' && G.turn.toMove(s).includes(seat)) s = G.turn.apply(s, seat, (G.turn.legal(s, seat) as unknown[])[0]);
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
const storyOf = (rounds: Round[]) => new Set(rounds.flatMap((r) => Object.values(r).flatMap((x) => shotsOf(x).map(([sea, cell]) => `${sea} ${cell}`))));

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

export function examples(): Example[] {
  const g = fourSeatGame();
  const t = tiebreakGame();
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
  return out;
}

if (import.meta.main) {
  for (const x of examples()) console.log(`── ${x.name} ──\n${x.text}\n`);
}
