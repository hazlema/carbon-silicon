export interface Layout {
  cols: number;
  rows: number;
  cell: number;
  width: number;
  height: number;
}

export function layout(cols: number, rows: number, width: number, height: number): Layout {
  const cell = Math.max(0, Math.min(width / cols, height / rows));
  return { cols, rows, cell, width: cell * cols, height: cell * rows };
}

/** Top-left corner of a cell in pixels. Row 1 is at the bottom, like the cell names. */
export function cellOrigin(l: Layout, index: number): { x: number; y: number } {
  const c = index % l.cols;
  const r = Math.floor(index / l.cols);
  return { x: c * l.cell, y: (l.rows - 1 - r) * l.cell };
}

/** Where orbs sit relative to the cell centre: one in the middle, otherwise evenly on a ring (max 6 drawn). */
export function orbOffsets(n: number, spread: number): { x: number; y: number }[] {
  if (n <= 0) return [];
  if (n === 1) return [{ x: 0, y: 0 }];
  const k = Math.min(n, 6);
  return Array.from({ length: k }, (_, i) => {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / k;
    return { x: Math.cos(a) * spread, y: Math.sin(a) * spread };
  });
}

export function waveSchedule(waves: number[][], waveMs: number): { index: number; start: number }[] {
  return waves.flatMap((wave, i) => wave.map((index) => ({ index, start: i * waveMs })));
}

export function burstDuration(waveCount: number, waveMs: number, burstMs: number): number {
  return waveCount === 0 ? 0 : (waveCount - 1) * waveMs + burstMs;
}

export function rgba(hex: string, alpha: number): string {
  const n = Number.parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}
