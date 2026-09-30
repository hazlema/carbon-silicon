export type SteerKey = 'n' | 'e' | 's' | 'w' | 'boost';

const KEYS: Record<string, SteerKey> = {
  ArrowUp: 'n', KeyW: 'n', ArrowRight: 'e', KeyD: 'e', ArrowDown: 's', KeyS: 's', ArrowLeft: 'w', KeyA: 'w', Space: 'boost',
};

/** A keydown's steer key: arrows or WASD steer, Space boosts. A held key's repeats and shortcuts are not presses. */
export function keyOf(e: { code: string; repeat: boolean; altKey: boolean; ctrlKey: boolean; metaKey: boolean }): SteerKey | null {
  if (e.repeat || e.altKey || e.ctrlKey || e.metaKey) return null;
  return KEYS[e.code] ?? null;
}

const TEXT_INPUTS = new Set(['text', 'search', 'email', 'password', 'url', 'tel', 'number']);

/** Is focus somewhere keys mean letters (the table chat)? Then they are not steering. */
export function typing(target: EventTarget | null): boolean {
  const el = target as { tagName?: string; type?: string; isContentEditable?: boolean } | null;
  if (!el?.tagName) return false;
  if (el.isContentEditable) return true;
  if (el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return true;
  return el.tagName === 'INPUT' && TEXT_INPUTS.has(el.type ?? 'text');
}

/** A touch's travel as a steer key: its main direction, or a tap (a boost) under `min` CSS px. */
export function swipeOf(dx: number, dy: number, min = 24): SteerKey {
  if (Math.max(Math.abs(dx), Math.abs(dy)) < min) return 'boost';
  if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? 'e' : 'w';
  return dy > 0 ? 's' : 'n';
}
