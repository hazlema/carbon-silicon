import { LETTERS, SIZE, cellName } from './board';
import type { SalvoView, Ship, ShipId, TargetView } from './index';

/** Ship letters for cells you are allowed to see whole: your own fleet, and every fleet once it is over. */
const LETTER: Record<ShipId, string> = { cruiser: 'C', destroyer: 'D', frigate: 'F', submarine: 'S' };
const FILES = `  ${LETTERS.split('').join(' ')}`;

/** Eight rows, 8 at the top, a1 bottom-left; `mark` gives each cell its one character, `note` a row its remark. */
function grid(mark: (cell: string) => string, note: (row: number) => string = () => ''): string[] {
  const lines = [FILES];
  for (let r = SIZE - 1; r >= 0; r--) {
    const row: string[] = [];
    for (let c = 0; c < SIZE; c++) row.push(mark(cellName(r * SIZE + c)));
    const remark = note(r + 1);
    lines.push(`${r + 1} ${row.join(' ')}${remark ? `   ${remark}` : ''}`);
  }
  lines.push(FILES);
  return lines;
}

/** A fleet seen whole: letters for unhit cells, X for hits, * for sunk ships, o for misses. */
function wholeFleet(ships: Ship[], shots: Record<string, 'miss' | 'hit'>) {
  const marks = new Map<string, string>();
  for (const [cell, result] of Object.entries(shots)) if (result === 'miss') marks.set(cell, 'o');
  for (const ship of ships) {
    const sunk = ship.cells.length > 0 && ship.hits.length === ship.cells.length;
    for (const cell of ship.cells) marks.set(cell, sunk ? '*' : ship.hits.includes(cell) ? 'X' : LETTER[ship.id]);
  }
  return (cell: string): string => marks.get(cell) ?? '.';
}

/** An enemy sea as the public sees it: hits, misses and sinkings; nothing else. */
function publicSea(t: TargetView) {
  const marks = new Map<string, string>();
  for (const cell of t.misses) marks.set(cell, 'o');
  for (const cell of t.hits) marks.set(cell, 'X');
  for (const cell of t.sunk.flatMap((x) => x.cells)) marks.set(cell, '*');
  return (cell: string): string => marks.get(cell) ?? '.';
}

/** A lifted row's count, at the end of its line. */
const fogNote = (t: TargetView) => (row: number) => {
  const lifted = t.lifted.find((x) => x.row === row);
  return lifted ? `fog lifted: ${lifted.afloat} afloat` : '';
};

/** The whole table in text, for language models: every sea in view, yours first with its ships. */
export function renderAscii(view: Omit<SalvoView, 'ascii'>): string {
  const lines: string[] = [];
  if (view.phase === 'deploy') {
    lines.push(`Deployment. Fleets down: ${view.ready.length > 0 ? view.ready.join(', ') : 'none yet'}.`);
  } else if (view.phase === 'fire') {
    lines.push(`Round ${view.round}. Ready: ${view.ready.length > 0 ? view.ready.join(', ') : 'nobody yet'}.`);
    lines.push(`Shots this round (one per ship afloat): ${Object.entries(view.guns).map(([seat, n]) => `${seat} ${n}`).join(', ')}.`);
    if (view.you && view.guns[view.you]) {
      const sent = view.myOrders.map((x) => `${x.fire === 'buoy' ? 'buoy' : 'shell'} at ${x.at} ${x.cell}`);
      lines.push(`Your salvo: ${view.myOrders.length} of ${view.guns[view.you]} sent${sent.length > 0 ? ` (${sent.join(', ')})` : ''}.`);
    }
  } else {
    lines.push(`Over after round ${view.round}: ${view.winner} wins (${view.endReason}).`);
  }
  if (view.liftedRows.length > 0) lines.push(`Lifted rows (a count of ship cells afloat in each, not where): ${view.liftedRows.join(', ')}.`);
  if (view.eliminated.length > 0) lines.push(`Out: ${view.eliminated.join(', ')}.`);

  if (view.you && view.mySea) {
    const afloat = view.mySea.ships.reduce((n, x) => n + x.cells.length - x.hits.length, 0);
    const port = view.mySea.port.length > 0 ? `, in port: ${view.mySea.port.join(', ')}` : '';
    lines.push('', `${view.you} (you), scrap ${view.scrap[view.you] ?? 0}, ${afloat} ship cells afloat${port}`);
    lines.push(...grid(wholeFleet(view.mySea.ships, view.mySea.shots)));
  }
  for (const t of view.targets) {
    lines.push('', `${t.sea}${t.out ? ' (out)' : ''}, scrap ${view.scrap[t.sea] ?? 0}, ${t.afloat} ship cells afloat`);
    if (t.revealed) {
      const shots: Record<string, 'miss' | 'hit'> = {};
      for (const c of t.misses) shots[c] = 'miss';
      lines.push(...grid(wholeFleet(t.revealed, shots)));
    } else {
      lines.push(...grid(publicSea(t), fogNote(t)));
    }
    for (const b of t.sonar) {
      lines.push(`Your sonar buoy at ${b.cell} (round ${b.round}) hears ${b.afloat} ship ${b.afloat === 1 ? 'cell' : 'cells'} afloat in ${b.cells[0]}–${b.cells.at(-1)}.`);
    }
  }
  lines.push(
    '',
    'C D F S = cruiser, destroyer, frigate, submarine (shown for your own fleet, and for every fleet once it is over)',
    'X = hit, * = sunk ship, o = miss, . = unknown or open water',
  );
  return lines.join('\n');
}
