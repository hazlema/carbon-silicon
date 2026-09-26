import { LETTERS } from './board';

const SYMBOL: Record<string, string> = { red: 'R', blue: 'B', green: 'G', gold: 'Y' };

export function renderAscii(cols: number, rows: number, cells: { owner: string | null; orbs: number }[]): string {
  const lines: string[] = [];
  for (let r = rows - 1; r >= 0; r--) {
    const row: string[] = [];
    for (let c = 0; c < cols; c++) {
      const cell = cells[r * cols + c];
      row.push(cell.owner ? `${SYMBOL[cell.owner] ?? '?'}${cell.orbs}` : ' .');
    }
    lines.push(`${String(r + 1).padStart(2)} ${row.join(' ')}`);
  }
  lines.push(`   ${Array.from({ length: cols }, (_, c) => ` ${LETTERS[c]}`).join(' ')}`);
  lines.push('R=red B=blue G=green Y=gold, number = orbs');
  return lines.join('\n');
}
