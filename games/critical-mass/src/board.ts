export const LETTERS = 'abcdefghijklmnopqrstuvwxyz';

/** Index 0 is a1 (bottom-left); rows grow upward, columns grow rightward. */
export function cellName(cols: number, index: number): string {
  return `${LETTERS[index % cols]}${Math.floor(index / cols) + 1}`;
}

export function cellIndex(cols: number, rows: number, name: string): number | null {
  const m = /^([a-z])(\d{1,2})$/.exec(name.trim().toLowerCase());
  if (!m) return null;
  const c = LETTERS.indexOf(m[1]);
  const r = Number(m[2]) - 1;
  if (c < 0 || c >= cols || r < 0 || r >= rows) return null;
  return r * cols + c;
}

export function neighbors(cols: number, rows: number, index: number): number[] {
  const c = index % cols;
  const r = Math.floor(index / cols);
  const out: number[] = [];
  if (r > 0) out.push(index - cols);
  if (r < rows - 1) out.push(index + cols);
  if (c > 0) out.push(index - 1);
  if (c < cols - 1) out.push(index + 1);
  return out;
}

/** Corners 2, edges 3, interior 4. */
export function criticalMass(cols: number, rows: number, index: number): number {
  return neighbors(cols, rows, index).length;
}
