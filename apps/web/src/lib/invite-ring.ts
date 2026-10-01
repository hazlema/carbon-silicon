// Geometry and colour for the invite countdown ring: a clockwise sweep that
// fills from 12 o'clock as an invite's time runs out. Kept pure so the sweep
// maths can be tested without a browser; the Svelte component only draws it.

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);
// Snap to 3 decimals so sin/cos float noise doesn't leak into the path string.
const tidy = (n: number): number => Math.round(n * 1000) / 1000;

/** A point on a circle, measured as a clockwise fraction (0..1) from the top. */
export function pointOnRing(cx: number, cy: number, r: number, fraction: number): { x: number; y: number } {
  const theta = fraction * 2 * Math.PI;
  return { x: tidy(cx + r * Math.sin(theta)), y: tidy(cy - r * Math.cos(theta)) };
}

/** SVG path `d` for an arc filling clockwise from the top by `fraction` (0..1). */
export function arcPath(fraction: number, cx: number, cy: number, r: number): string {
  const f = clamp01(fraction);
  if (f <= 0) return '';
  if (f >= 1) {
    const top = pointOnRing(cx, cy, r, 0);
    const bottom = pointOnRing(cx, cy, r, 0.5);
    // A single arc command can't close a full 360°, so sweep it in two halves.
    return `M ${top.x} ${top.y} A ${r} ${r} 0 1 1 ${bottom.x} ${bottom.y} A ${r} ${r} 0 1 1 ${top.x} ${top.y}`;
  }
  const start = pointOnRing(cx, cy, r, 0);
  const end = pointOnRing(cx, cy, r, f);
  const largeArc = f > 0.5 ? 1 : 0;
  return `M ${start.x} ${start.y} A ${r} ${r} 0 ${largeArc} 1 ${end.x} ${end.y}`;
}

export type RingTone = 'ready' | 'warn' | 'urgent';

/** Tone from the fraction of time LEFT (1 = just arrived, 0 = expiring). */
export function ringTone(remaining: number): RingTone {
  const r = clamp01(remaining);
  if (r > 0.5) return 'ready';
  if (r > 0.2) return 'warn';
  return 'urgent';
}

const toneColor: Record<RingTone, string> = {
  ready: 'var(--ready)',
  warn: 'var(--afk)',
  urgent: 'var(--danger)',
};

/** The app colour token for how much time is left. */
export function ringColor(remaining: number): string {
  return toneColor[ringTone(remaining)];
}
