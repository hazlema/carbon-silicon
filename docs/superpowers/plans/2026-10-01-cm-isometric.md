# Critical Mass — Isometric Board Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Critical Mass's flat canvas board with the comp's swivelling CSS-3D isometric board (shaded billboard orbs, cell-state animations, chain-reaction flights, synthesized sound) and move its players into corner cards on the stage.

**Architecture:** The board stays one Svelte component (`Board.svelte`) whose cells are real `<button>`s laid on the top face of a `preserve-3d` slab; a stage applies `rotateX(tilt) rotateZ(spin) scale(fit)`. Pure geometry/colour/schedule helpers live in `iso.ts`, WebAudio in `sound.ts`, both unit-tested with `bun test`. The table page swaps its Critical Mass side columns for a `SeatCard.svelte` per seat in the stage corners.

**Tech Stack:** SvelteKit + Svelte 5 runes, TypeScript, CSS 3D transforms, WebAudio, `bun test`, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-01-cm-isometric-design.md` (comp: `docs/ideas/critical mass redesign/project/Lobby Redesign.dc.html`, option 5a, lines 18–129; keyframes lines 11–16).

## Global Constraints

- No new dependencies; no WebGL on this page.
- Rules, server, bots, `CMView`, Lightline and Crown & Steel are untouched.
- DOM contract kept: one `<button>` per cell with `data-cell`, `data-legal`, `aria-label` `"<cell>, <n> <seat> orb(s), explodes at <k>"` (or `"<cell>, empty, explodes at <k>"`), never `disabled`, top row first (6×9 → first button `a9`), arrow keys move focus, Enter/Space place on a legal cell.
- Seat colours come from `colorOf(colors, seat)` (`$lib/seats`), never hard-coded orange/cyan.
- Default camera **Iso: spin −35°, tilt 55°**; Top: spin 0°, tilt 0°; tilt clamped **0–70°**; drag 0.4°/px spin, 0.3°/px tilt; >4 px movement = drag, never a click.
- Sound off by default; `localStorage` key `cm_sound` (`'on'`/`'off'`), every storage access in try/catch.
- e2e runs with `reducedMotion: 'reduce'` (playwright.config.ts): reduced motion must skip drop/pop/ring/flights/camera easing but keep everything functional.
- Run e2e in the foreground; never leave background verify runs.
- Code style: match the surrounding Svelte files (2-space indent, single quotes, comments only where the why isn't obvious).

## Review Focus

1. **Clicking at extreme angles** (Top view, rotated 270°, tilt 70°) must place on the cell under the pointer — pinned in Task 3's e2e.
2. **A swivel that ends over a cell** must not place an orb — pinned in Task 3's e2e.
3. **Resizing the window mid-game** must refit the board without overflow or clipping cells — pinned by `fitScale` units (Task 1) and a resize assertion (Task 3).
4. **A huge chain reaction** (dozens of waves, hundreds of explosions) must not flood the DOM or run for ten seconds — `flightPlan` caps flights and compresses wave spacing, pinned in Task 1 units.
5. **Spectators** (`view.you === null`) get no hover tint and no "you" card, and the existing spectator e2e keeps passing — Task 6.

---

### Task 1: Pure helpers — geometry, colours, schedules

**Files:**
- Create: `apps/web/src/lib/games/critical-mass/iso.ts`
- Test: `apps/web/src/lib/games/critical-mass/iso.test.ts`

**Interfaces:**
- Produces (used by Tasks 2–6):
  - `CELL = 66`, `GAP = 6`, `PAD = 14`, `SLAB = 26`, `PILL_RESERVE = 64` (px)
  - `ISO = { spin: -35, tilt: 55 }`, `TOP = { spin: 0, tilt: 0 }`
  - `clampTilt(t: number): number`
  - `boardSize(cols: number, rows: number): { w: number; h: number }`
  - `fitScale(board: {w,h}, stage: {w,h}, spinDeg: number, tiltDeg: number, reserve?: number): number`
  - `cellOrder(cols: number, rows: number): number[]` (DOM order, top row first)
  - `cellCenter(index: number, cols: number, rows: number): { x: number; y: number }` (board-face px)
  - `orbSpots(n: number): [number, number][]` (px inside a 66 px cell)
  - `interface Shades { rim; rimHi; floor; light; dark; glow: string }`, `EMPTY: Shades`, `shades(hex: string): Shades`, `mix(a: string, b: string, t: number): string`
  - `changedCells(prev: { owner: string | null; orbs: number }[], next: same[]): number[]`
  - `captured(prev, next, mover: string): boolean`
  - `interface Flight { from: number; to: number; delay: number }`, `flightPlan(waves: number[][], cols: number, rows: number): { flights: Flight[]; hits: Map<number, number>; bursts: { index: number; delay: number }[]; total: number }`
  - `WAVE_MS = 150`, `FLIGHT_MS = 300`, `MAX_FLIGHTS = 240`

- [ ] **Step 1: Write the failing tests**

```ts
// apps/web/src/lib/games/critical-mass/iso.test.ts
import { describe, expect, test } from 'bun:test';
import { cellIndex } from '@cs/critical-mass';
import {
  boardSize, captured, cellCenter, cellOrder, changedCells, clampTilt, CELL, EMPTY, fitScale, flightPlan,
  FLIGHT_MS, GAP, MAX_FLIGHTS, mix, orbSpots, PAD, shades, WAVE_MS,
} from './iso';

describe('geometry', () => {
  test('the slab is cells + gaps + padding', () => {
    expect(boardSize(6, 9)).toEqual({ w: 6 * CELL + 5 * GAP + 2 * PAD, h: 9 * CELL + 8 * GAP + 2 * PAD });
  });
  test('tilt stays between flat and 70°', () => {
    expect(clampTilt(-10)).toBe(0);
    expect(clampTilt(40)).toBe(40);
    expect(clampTilt(95)).toBe(70);
  });
  test('top row first, so a9 leads on 6×9', () => {
    const order = cellOrder(6, 9);
    expect(order).toHaveLength(54);
    expect(order[0]).toBe(cellIndex(6, 9, 'a9'));
    expect(order[53]).toBe(cellIndex(6, 9, 'f1'));
  });
  test('cell centres sit on the face, a1 bottom-left', () => {
    expect(cellCenter(cellIndex(6, 9, 'a9')!, 6, 9)).toEqual({ x: PAD + CELL / 2, y: PAD + CELL / 2 });
    expect(cellCenter(cellIndex(6, 9, 'a1')!, 6, 9)).toEqual({ x: PAD + CELL / 2, y: PAD + 8 * (CELL + GAP) + CELL / 2 });
  });
  test('orb spots follow the comp, capped at three', () => {
    expect(orbSpots(0)).toEqual([]);
    expect(orbSpots(1)).toEqual([[33, 33]]);
    expect(orbSpots(2)).toEqual([[23, 33], [43, 33]]);
    expect(orbSpots(3)).toEqual([[23, 40], [43, 40], [33, 22]]);
    expect(orbSpots(5)).toHaveLength(3);
  });
});

describe('fitScale', () => {
  const board = boardSize(6, 9);
  test('top view is bound by height once the pill is reserved', () => {
    expect(fitScale(board, { w: 1000, h: 800 }, 0, 0)).toBeCloseTo((0.9 * (800 - 64)) / board.h, 5);
  });
  test('a narrow stage is bound by width', () => {
    expect(fitScale(board, { w: 300, h: 2000 }, 0, 0)).toBeCloseTo((0.9 * 300) / board.w, 5);
  });
  test('the projected footprint never exceeds the stage at any angle', () => {
    const stage = { w: 700, h: 600 };
    for (const spin of [-35, 0, 45, 90, 135, 270]) {
      for (const tilt of [0, 30, 55, 70]) {
        const s = fitScale(board, stage, spin, tilt);
        const r = (spin * Math.PI) / 180, t = (tilt * Math.PI) / 180;
        const pw = (Math.abs(board.w * Math.cos(r)) + Math.abs(board.h * Math.sin(r))) * s;
        const depth = Math.abs(board.w * Math.sin(r)) + Math.abs(board.h * Math.cos(r));
        expect(pw).toBeLessThanOrEqual(stage.w);
        expect((depth * Math.cos(t) + 26 * Math.sin(t)) * s).toBeLessThanOrEqual(stage.h - 64);
      }
    }
  });
  test('an unmeasured stage never yields zero or negative scale', () => {
    expect(fitScale(board, { w: 0, h: 0 }, -35, 55)).toBeGreaterThan(0);
  });
});

describe('shades', () => {
  test('mix blends channel by channel', () => {
    expect(mix('#000000', '#ffffff', 0.5)).toBe('#808080');
    expect(mix('#ff8a3d', '#ff8a3d', 0.3)).toBe('#ff8a3d');
  });
  test('every palette colour yields usable shades', () => {
    for (const hex of ['#ff8a3d', '#4fe3ff', '#6dffa8', '#c792ff', '#9aa1cf']) {
      const s = shades(hex);
      expect(s.rim).toMatch(/^rgba\(\d+, \d+, \d+, 0\.3\)$/);
      expect(s.floor).toMatch(/0\.1\)$/);
      expect(s.light).toMatch(/^#[0-9a-f]{6}$/);
      expect(s.dark).toMatch(/^#[0-9a-f]{6}$/);
    }
    expect(EMPTY.floor).toBe('rgba(8,6,4,.38)');
  });
});

describe('move diffs', () => {
  const cell = (owner: string | null, orbs: number) => ({ owner, orbs });
  test('changed cells are those whose owner or count moved', () => {
    expect(changedCells([cell(null, 0), cell('red', 1), cell('blue', 2)], [cell('red', 1), cell('red', 1), cell('red', 3)])).toEqual([0, 2]);
  });
  test('a capture is an opponent cell that became the mover’s', () => {
    expect(captured([cell('blue', 2)], [cell('red', 3)], 'red')).toBe(true);
    expect(captured([cell(null, 0)], [cell('red', 1)], 'red')).toBe(false);
    expect(captured([cell('red', 1)], [cell('red', 2)], 'red')).toBe(false);
  });
});

describe('flightPlan', () => {
  const i = (n: string) => cellIndex(6, 9, n)!;
  test('each exploding cell sends one orb to each neighbour, wave by wave', () => {
    const plan = flightPlan([[i('a1')], [i('a2'), i('b1')]], 6, 9);
    expect(plan.bursts).toEqual([{ index: i('a1'), delay: 0 }, { index: i('a2'), delay: WAVE_MS }, { index: i('b1'), delay: WAVE_MS }]);
    expect(plan.flights.filter((f) => f.from === i('a1')).map((f) => f.to).sort()).toEqual([i('a2'), i('b1')].sort());
    // a neighbour lands when its last flight arrives
    expect(plan.hits.get(i('a2'))).toBe(WAVE_MS + FLIGHT_MS);
    expect(plan.total).toBe(WAVE_MS + FLIGHT_MS);
  });
  test('no waves, no plan', () => {
    expect(flightPlan([], 6, 9)).toEqual({ flights: [], hits: new Map(), bursts: [], total: 0 });
  });
  test('a runaway chain is capped and compressed', () => {
    const waves = Array.from({ length: 80 }, () => [i('c4'), i('d5'), i('c5')]);
    const plan = flightPlan(waves, 6, 9);
    expect(plan.flights.length).toBeLessThanOrEqual(MAX_FLIGHTS);
    expect(plan.total).toBeLessThanOrEqual(3000);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test apps/web/src/lib/games/critical-mass/iso.test.ts`
Expected: FAIL — `Cannot find module './iso'`.

- [ ] **Step 3: Implement `iso.ts`**

```ts
// apps/web/src/lib/games/critical-mass/iso.ts
import { neighbors } from '@cs/critical-mass';
import { rgba } from './render';

/** Board geometry in board-face pixels (the whole slab is then scaled to fit the stage). */
export const CELL = 66;
export const GAP = 6;
export const PAD = 14;
export const SLAB = 26;
/** Room kept free at the stage's foot for the view pill. */
export const PILL_RESERVE = 64;

export const ISO = { spin: -35, tilt: 55 };
export const TOP = { spin: 0, tilt: 0 };

export const WAVE_MS = 150;
export const FLIGHT_MS = 300;
export const MAX_FLIGHTS = 240;
const MAX_TOTAL_MS = 3000;

export const clampTilt = (t: number) => Math.min(70, Math.max(0, t));

export function boardSize(cols: number, rows: number) {
  return { w: cols * CELL + (cols - 1) * GAP + 2 * PAD, h: rows * CELL + (rows - 1) * GAP + 2 * PAD };
}

/** Largest scale at which the rotated, tilted slab fits the stage above the pill (orthographic estimate, 10% margin). */
export function fitScale(board: { w: number; h: number }, stage: { w: number; h: number }, spinDeg: number, tiltDeg: number, reserve = PILL_RESERVE) {
  const r = (spinDeg * Math.PI) / 180;
  const t = (tiltDeg * Math.PI) / 180;
  const pw = Math.abs(board.w * Math.cos(r)) + Math.abs(board.h * Math.sin(r));
  const depth = Math.abs(board.w * Math.sin(r)) + Math.abs(board.h * Math.cos(r));
  const ph = depth * Math.cos(t) + SLAB * Math.sin(t);
  const s = Math.min((0.9 * stage.w) / pw, (0.9 * (stage.h - reserve)) / ph);
  return Number.isFinite(s) && s > 0 ? s : 0.1;
}

/** Cell indices in DOM order: the top row (highest rank) first, column a on the left. */
export function cellOrder(cols: number, rows: number): number[] {
  return Array.from({ length: rows }, (_, k) => rows - 1 - k).flatMap((r) => Array.from({ length: cols }, (_, c) => r * cols + c));
}

export function cellCenter(index: number, cols: number, rows: number) {
  const c = index % cols;
  const fromTop = rows - 1 - Math.floor(index / cols);
  return { x: PAD + c * (CELL + GAP) + CELL / 2, y: PAD + fromTop * (CELL + GAP) + CELL / 2 };
}

const SPOTS: Record<number, [number, number][]> = { 1: [[33, 33]], 2: [[23, 33], [43, 33]], 3: [[23, 40], [43, 40], [33, 22]] };
export const orbSpots = (n: number): [number, number][] => (n <= 0 ? [] : SPOTS[Math.min(n, 3)]);

export interface Shades {
  rim: string;
  rimHi: string;
  floor: string;
  light: string;
  dark: string;
  glow: string;
}
/** The comp's empty-cell glass. */
export const EMPTY: Shades = {
  rim: 'rgba(210,225,255,.13)',
  rimHi: 'rgba(230,240,255,.45)',
  floor: 'rgba(8,6,4,.38)',
  light: '#ffffff',
  dark: '#000000',
  glow: 'transparent',
};

export function mix(a: string, b: string, t: number): string {
  const pa = Number.parseInt(a.slice(1), 16);
  const pb = Number.parseInt(b.slice(1), 16);
  const ch = (shift: number) => Math.round(((pa >> shift) & 255) * (1 - t) + ((pb >> shift) & 255) * t);
  return `#${[16, 8, 0].map((s) => ch(s).toString(16).padStart(2, '0')).join('')}`;
}

/** The comp's owner tints and orb shading, derived from any seat colour. */
export function shades(hex: string): Shades {
  return {
    rim: rgba(hex, 0.3),
    rimHi: rgba(mix(hex, '#ffffff', 0.55), 0.85),
    floor: rgba(hex, 0.1),
    light: mix(hex, '#ffffff', 0.72),
    dark: mix(hex, '#000000', 0.42),
    glow: rgba(hex, 0.55),
  };
}

type Cell = { owner: string | null; orbs: number };
export const changedCells = (prev: Cell[], next: Cell[]) =>
  next.flatMap((c, i) => (c.owner !== prev[i]?.owner || c.orbs !== prev[i]?.orbs ? [i] : []));
export const captured = (prev: Cell[], next: Cell[], mover: string) =>
  next.some((c, i) => c.owner === mover && !!prev[i]?.owner && prev[i].owner !== mover);

export interface Flight {
  from: number;
  to: number;
  delay: number;
}

/**
 * The chain reaction as decoration: a burst at each exploding cell, one orb flying to each neighbour,
 * and the time each cell's final state should land. Long chains squeeze their spacing and drop flights.
 */
export function flightPlan(waves: number[][], cols: number, rows: number) {
  const flights: Flight[] = [];
  const hits = new Map<number, number>();
  const bursts: { index: number; delay: number }[] = [];
  if (waves.length === 0) return { flights, hits, bursts, total: 0 };
  const waveMs = Math.min(WAVE_MS, (MAX_TOTAL_MS - FLIGHT_MS) / waves.length);
  waves.forEach((wave, k) => {
    const delay = k * waveMs;
    for (const from of wave) {
      bursts.push({ index: from, delay });
      hits.set(from, Math.max(hits.get(from) ?? 0, delay));
      for (const to of neighbors(cols, rows, from)) {
        if (flights.length < MAX_FLIGHTS) flights.push({ from, to, delay });
        hits.set(to, Math.max(hits.get(to) ?? 0, delay + FLIGHT_MS));
      }
    }
  });
  const total = Math.max(...hits.values());
  return { flights, hits, bursts, total };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test apps/web/src/lib/games/critical-mass/iso.test.ts`
Expected: PASS (all tests). If the `total` cap test fails, check `waveMs` compression: 80 waves → `(3000-300)/80 = 33.75` ms spacing, total ≈ 79·33.75 + 300 ≈ 2966.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/games/critical-mass/iso.ts apps/web/src/lib/games/critical-mass/iso.test.ts
git commit -m "Critical Mass: iso helpers — slab geometry, fit scale, seat shades, move diffs, chain flight plan"
```

---

### Task 2: The static 3D board (slab, cells, billboard orbs, fit)

Replace the canvas renderer with the CSS-3D board at a fixed Iso camera. The existing `match.e2e.ts` must pass unchanged.

**Files:**
- Modify (rewrite): `apps/web/src/lib/games/critical-mass/Board.svelte`
- Modify: `apps/web/src/lib/games/critical-mass/render.ts` (remove `layout`, `cellOrigin`, `orbOffsets`, `waveSchedule`, `burstDuration`; keep `rgba`)
- Modify: `apps/web/src/lib/games/critical-mass/render.test.ts` (keep only an `rgba` test)
- Modify: `apps/web/src/routes/t/[id]/+page.svelte` (Critical Mass `.boardwrap` gives the board a definite box — see Step 4)

**Interfaces:**
- Consumes: Task 1 exports.
- Produces: `Board.svelte` props unchanged `{ view: CMView; colors: TableColors; legal: string[]; interactive: boolean; onMove: (cell: string) => void }`. Board fills its parent (width/height 100%). Root stage element `.stage3d` carries `data-spin`/`data-tilt` (numbers). Each cell button also carries `data-owner` (seat or `''`) and `data-orbs`.

- [ ] **Step 1: Run the current CM e2e as the baseline**

Run: `bun run build && bunx playwright test e2e/match.e2e.ts`
Expected: PASS (4 tests). This is the contract the rewrite must keep.

- [ ] **Step 2: Rewrite `Board.svelte`**

```svelte
<script lang="ts">
  import type { CMBoardCell, CMView } from '@cs/critical-mass';
  import { colorOf, type TableColors } from '$lib/seats';
  import { boardSize, cellOrder, EMPTY, fitScale, ISO, orbSpots, shades } from './iso';
  import { rgba } from './render';

  let {
    view,
    colors,
    legal,
    interactive,
    onMove,
  }: { view: CMView; colors: TableColors; legal: string[]; interactive: boolean; onMove: (cell: string) => void } = $props();

  let spin = $state(ISO.spin);
  let tilt = $state(ISO.tilt);
  let stage: HTMLDivElement | undefined = $state();
  let stageSize = $state({ w: 0, h: 0 });
  const size = $derived(boardSize(view.cols, view.rows));
  const scale = $derived(fitScale(size, stageSize, spin, tilt));
  const legalSet = $derived(new Set(legal));
  const order = $derived(cellOrder(view.cols, view.rows));
  const mine = $derived(view.you ? colorOf(colors, view.you) : null);
  let cellsEl: HTMLDivElement | undefined = $state();

  $effect(() => {
    if (!stage) return;
    const ro = new ResizeObserver(([entry]) => {
      stageSize = { w: entry.contentRect.width, h: entry.contentRect.height };
    });
    ro.observe(stage);
    return () => ro.disconnect();
  });

  const tone = (b: CMBoardCell) => (b.owner && b.orbs > 0 ? shades(colorOf(colors, b.owner)) : EMPTY);
  const hot = (b: CMBoardCell) => !!b.owner && b.orbs > 0 && b.orbs === b.critical - 1;

  /** Arrow keys move focus across the grid; every cell is focusable, legal or not. */
  function step(e: KeyboardEvent, k: number) {
    const d = ({ ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] } as Record<string, [number, number]>)[e.key];
    if (!d || !cellsEl) return;
    e.preventDefault();
    const col = Math.min(view.cols - 1, Math.max(0, (k % view.cols) + d[0]));
    const row = Math.min(view.rows - 1, Math.max(0, Math.floor(k / view.cols) + d[1]));
    (cellsEl.children[row * view.cols + col] as HTMLElement | undefined)?.focus();
  }

  function label(b: CMBoardCell): string {
    const state = b.owner ? `${b.orbs} ${b.owner} ${b.orbs === 1 ? 'orb' : 'orbs'}` : 'empty';
    return `${b.cell}, ${state}, explodes at ${b.critical}`;
  }
</script>

<div
  class="stage3d"
  bind:this={stage}
  data-spin={spin}
  data-tilt={tilt}
  style:--spin="{spin}deg"
  style:--tilt="{tilt}deg"
  style:--mine={mine ? rgba(mine, 0.14) : 'transparent'}
>
  <div class="slab" style:transform="rotateX({tilt}deg) rotateZ({spin}deg) scale({scale})">
    <div class="shadow" aria-hidden="true"></div>
    <div class="face" role="group" aria-label="Board" bind:this={cellsEl} style:grid-template-columns="repeat({view.cols}, var(--cell))">
      <i class="edge s" aria-hidden="true"></i><i class="edge n" aria-hidden="true"></i><i class="edge w" aria-hidden="true"></i><i class="edge e" aria-hidden="true"></i>
      {#each order as i, k (i)}
        {@const b = view.board[i]}
        {@const ok = interactive && legalSet.has(b.cell)}
        {@const t = tone(b)}
        <button
          type="button"
          data-cell={b.cell}
          data-legal={ok ? 'true' : 'false'}
          data-owner={b.owner ?? ''}
          data-orbs={b.orbs}
          aria-disabled={!ok}
          aria-label={label(b)}
          style:--rim={t.rim}
          style:--rim-hi={t.rimHi}
          style:--floor={t.floor}
          style:--orb-light={t.light}
          style:--orb-dark={t.dark}
          style:--orb={b.owner ? colorOf(colors, b.owner) : 'transparent'}
          style:--glow={t.glow}
          onclick={() => ok && onMove(b.cell)}
          onkeydown={(e) => step(e, k)}
        >
          <span class="floor"></span>
          <span class="rim s"></span><span class="rim n"></span><span class="rim w"></span><span class="rim e"></span>
          {#if hot(b)}<span class="hot"></span>{/if}
          {#each orbSpots(b.owner ? b.orbs : 0) as [x, y], o (o)}
            <span class="spot" style:left="{x}px" style:top="{y}px">
              <i class="contact"></i>
              <span class="bb"><i class="orb"></i></span>
            </span>
          {/each}
        </button>
      {/each}
    </div>
  </div>
</div>

<style>
  .stage3d {
    --cell: 66px;
    --grain: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='120'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='1.1' numOctaves='2' stitchTiles='stitch'/%3E%3CfeColorMatrix values='0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 0 0 0 .07 0'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");
    position: relative;
    width: 100%;
    height: 100%;
    display: grid;
    place-items: center;
    padding-bottom: 64px;
    perspective: 1900px;
    perspective-origin: 50% 40%;
    overflow: hidden;
    user-select: none;
    background: radial-gradient(ellipse at 50% 55%, #171c33 0%, transparent 60%);
  }
  .slab {
    transform-style: preserve-3d;
  }
  .shadow {
    position: absolute;
    inset: -40px;
    border-radius: 40px;
    background: radial-gradient(closest-side, rgba(0, 0, 0, 0.6), rgba(0, 0, 0, 0));
    transform: translateZ(-60px);
  }
  /* The comp's Soil surface: two noise layers over warm highlights. */
  .face {
    position: relative;
    transform-style: preserve-3d;
    display: grid;
    gap: 6px;
    padding: 14px;
    border-radius: 3px;
    background:
      url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='180' height='180'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.85' numOctaves='3' stitchTiles='stitch'/%3E%3CfeColorMatrix values='0 0 0 0 .12 0 0 0 0 .08 0 0 0 0 .05 0 0 0 .9 0'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E") 0 0 / 180px,
      url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='180' height='180'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.85' numOctaves='3' stitchTiles='stitch'/%3E%3CfeColorMatrix values='0 0 0 0 .55 0 0 0 0 .4 0 0 0 0 .28 0 0 0 .35 0'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E") 0 0 / 260px,
      radial-gradient(ellipse at 25% 20%, #5a3f2a 0%, transparent 45%),
      radial-gradient(ellipse at 80% 75%, #4a3222 0%, transparent 50%),
      linear-gradient(160deg, #3b2a1d, #22170f);
    box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.08), inset 0 0 60px rgba(0, 0, 0, 0.55);
  }
  .edge {
    position: absolute;
    background: linear-gradient(#2a1d13, #120c08);
    pointer-events: none;
  }
  .edge.s { left: 0; top: 100%; width: 100%; height: 26px; transform-origin: top; transform: rotateX(-90deg); }
  .edge.n { left: 0; bottom: 100%; width: 100%; height: 26px; transform-origin: bottom; transform: rotateX(90deg); }
  .edge.w { right: 100%; top: 0; width: 26px; height: 100%; transform-origin: right; transform: rotateY(-90deg); }
  .edge.e { left: 100%; top: 0; width: 26px; height: 100%; transform-origin: left; transform: rotateY(90deg); }
  .face > button {
    position: relative;
    width: var(--cell);
    height: var(--cell);
    padding: 0;
    border: 0;
    background: none;
    transform-style: preserve-3d;
    cursor: pointer;
  }
  .face > button[aria-disabled='true'] {
    cursor: default;
  }
  .floor {
    position: absolute;
    inset: 0;
    border-radius: 3px;
    background: var(--grain), var(--floor);
    box-shadow: inset 0 3px 8px rgba(0, 0, 0, 0.6), inset 0 -1px 0 rgba(255, 255, 255, 0.06);
  }
  button[data-legal='true']:hover .floor,
  button[data-legal='true']:focus-visible .floor {
    background: var(--grain), var(--mine);
  }
  button:focus-visible .floor {
    outline: 2px solid var(--chalk);
    outline-offset: 2px;
  }
  .rim {
    position: absolute;
    background: var(--grain), var(--rim);
    pointer-events: none;
  }
  .rim.s { left: 0; bottom: 0; width: 100%; height: 8px; transform-origin: bottom; transform: rotateX(-90deg); border-top: 1px solid var(--rim-hi); }
  .rim.n { left: 0; top: 0; width: 100%; height: 8px; transform-origin: top; transform: rotateX(90deg); border-bottom: 1px solid var(--rim-hi); }
  .rim.w { left: 0; top: 0; width: 8px; height: 100%; transform-origin: left; transform: rotateY(-90deg); border-right: 1px solid var(--rim-hi); }
  .rim.e { right: 0; top: 0; width: 8px; height: 100%; transform-origin: right; transform: rotateY(90deg); border-left: 1px solid var(--rim-hi); }
  .hot {
    position: absolute;
    inset: -1px;
    border-radius: 4px;
    box-shadow: 0 0 18px rgba(255, 255, 255, 0.28), inset 0 0 0 1px rgba(255, 255, 255, 0.55);
    transform: translateZ(8px);
    pointer-events: none;
  }
  .spot {
    position: absolute;
    width: 0;
    height: 0;
    transform-style: preserve-3d;
    pointer-events: none;
  }
  .contact {
    position: absolute;
    left: -10px;
    top: -5px;
    width: 20px;
    height: 10px;
    border-radius: 50%;
    background: rgba(0, 0, 0, 0.55);
    filter: blur(2px);
  }
  /* Billboard: undo the board's spin and tilt so every orb faces the camera. */
  .bb {
    position: absolute;
    left: -10px;
    top: -10px;
    width: 20px;
    height: 20px;
    transform: translateZ(11px) rotateZ(calc(-1 * var(--spin))) rotateX(calc(-1 * var(--tilt)));
  }
  .orb {
    position: absolute;
    inset: 0;
    border-radius: 50%;
    background: radial-gradient(circle at 35% 30%, var(--orb-light) 0%, var(--orb) 45%, var(--orb-dark) 100%);
    box-shadow: 0 0 12px var(--glow);
  }
</style>
```

- [ ] **Step 3: Trim `render.ts` and its test to what's still used**

`render.ts` becomes:

```ts
export function rgba(hex: string, alpha: number): string {
  const n = Number.parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}
```

`render.test.ts` becomes:

```ts
import { describe, expect, test } from 'bun:test';
import { rgba } from './render';

describe('rgba', () => {
  test('hex to rgba with alpha', () => {
    expect(rgba('#ff8a3d', 0.5)).toBe('rgba(255, 138, 61, 0.5)');
  });
});
```

Run `grep -rn "render'" apps/web/src` to confirm nothing else imports the removed helpers.

- [ ] **Step 4: Give the board a definite box on the table page**

In `apps/web/src/routes/t/[id]/+page.svelte`, the Critical Mass `.stage` grid sizes its board column by `--board-w` (68dvh). For this task only, keep the side cards and make the board column fill the stage height: change the CM stage's style to `style:--board-w="min(60vw, calc((100dvh - 14rem) * {view.cols} / {view.rows} * 1.6))"` and add to the page CSS:

```css
  .stage:not(.ll):not(.ck) .boardwrap {
    align-self: stretch;
    min-height: 24rem;
  }
```

(Task 6 replaces this whole stage with corner cards; this keeps the board usable in between.)

- [ ] **Step 5: Type-check, unit tests, CM e2e**

Run: `bun run typecheck && bun test apps/web && bun run build && bunx playwright test e2e/match.e2e.ts`
Expected: typecheck clean; unit tests pass; 4/4 e2e pass (the first test clicks `button[data-legal="true"]` through to a verdict — proof that hit-testing on the transformed buttons works).

- [ ] **Step 6: Screenshot check (throwaway)**

Write `e2e/zz-cm-shot.e2e.ts` (deleted before commit) that does what match.e2e's keyboard test does up to the board, then `page.screenshot({ path: '<scratchpad>/cm-static.png' })` at 1400×900. Compare with the comp screenshot: slab, recessed cells, glass rims, orbs as spheres. Fix obvious divergences, then `rm e2e/zz-cm-shot.e2e.ts`.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/lib/games/critical-mass apps/web/src/routes/t/\[id\]/+page.svelte
git commit -m "Critical Mass: the board goes 3D — Soil slab, glass-rimmed cells as real buttons, billboard orbs, fit to the stage"
```

---

### Task 3: The camera — drag to swivel, view pill, touch

**Files:**
- Modify: `apps/web/src/lib/games/critical-mass/Board.svelte`
- Create: `e2e/cm-board.e2e.ts`

**Interfaces:**
- Consumes: `ISO`, `TOP`, `clampTilt`, `fitScale` (Task 1); `.stage3d` `data-spin`/`data-tilt`, cell `data-orbs` (Task 2).
- Produces: view pill buttons with accessible names `Rotate left 90°`, `Isometric view`, `Top view`, `Rotate right 90°` inside a `role="toolbar"` named `Board view`; a `<slot>`-free `pill` element that Task 5 adds the `♪` button to (class `.pill`).

- [ ] **Step 1: Write the failing e2e**

```ts
// e2e/cm-board.e2e.ts
import { expect, test, type Page } from '@playwright/test';
import { pickGame, randomTag } from './testing';

async function startMatch(page: Page) {
  await page.goto('/');
  await page.getByLabel('Your handle').fill(`iso${randomTag()}`);
  await page.getByRole('button', { name: 'Enter the parlor' }).click();
  await pickGame(page);
  await page.getByRole('button', { name: 'Find a match' }).click();
  await page.waitForURL(/\/t\/t_/, { timeout: 20_000 });
}
async function myTurn(page: Page) {
  await expect(page.locator('button[data-legal="true"]').first()).toBeVisible({ timeout: 20_000 });
}
async function resign(page: Page) {
  await page.getByRole('button', { name: 'Resign' }).click();
  await page.getByRole('button', { name: 'Yes, resign' }).click();
  await expect(page.getByRole('heading', { name: 'You lose.' })).toBeVisible();
}
const stage = (page: Page) => page.locator('.stage3d');
const totalOrbs = (page: Page) =>
  page.locator('button[data-cell]').evaluateAll((els) => els.reduce((n, el) => n + Number((el as any).dataset.orbs), 0));

test('the view pill turns the board, and a click still lands on the cell under the pointer', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await startMatch(page);
  await expect(stage(page)).toHaveAttribute('data-spin', '-35');
  await expect(stage(page)).toHaveAttribute('data-tilt', '55');
  const view = page.getByRole('toolbar', { name: 'Board view' });
  await view.getByRole('button', { name: 'Top view' }).click();
  await expect(stage(page)).toHaveAttribute('data-tilt', '0');
  await view.getByRole('button', { name: 'Rotate left 90°' }).click();
  await view.getByRole('button', { name: 'Rotate left 90°' }).click();
  await view.getByRole('button', { name: 'Rotate left 90°' }).click();
  await expect(stage(page)).toHaveAttribute('data-spin', '-270');
  await myTurn(page);
  // An empty legal cell: after our click it holds an orb of ours.
  const target = page.locator('button[data-legal="true"][data-orbs="0"]').first();
  const name = (await target.getAttribute('data-cell'))!;
  await target.click();
  await expect(page.locator(`button[data-cell="${name}"]`)).not.toHaveAttribute('data-orbs', '0');
  await view.getByRole('button', { name: 'Isometric view' }).click();
  await expect(stage(page)).toHaveAttribute('data-spin', '-35');
  await resign(page);
});

test('a swivel that ends over a cell places nothing, and tilt stays within 0–70°', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await startMatch(page);
  await myTurn(page);
  const before = await totalOrbs(page);
  const cell = (await page.locator('button[data-legal="true"]').first().boundingBox())!;
  await page.mouse.move(cell.x + cell.width / 2, cell.y + cell.height / 2);
  await page.mouse.down();
  await page.mouse.move(cell.x + cell.width / 2 + 40, cell.y + cell.height / 2 - 400, { steps: 8 });
  await page.mouse.move(cell.x + cell.width / 2, cell.y + cell.height / 2, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(800);
  expect(await totalOrbs(page)).toBe(before);
  const tilt = Number(await stage(page).getAttribute('data-tilt'));
  expect(tilt).toBeGreaterThanOrEqual(0);
  expect(tilt).toBeLessThanOrEqual(70);
  expect(Number(await stage(page).getAttribute('data-spin'))).not.toBe(-35);
  await resign(page);
});

test('a resized window refits the board: every cell stays inside the stage', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await startMatch(page);
  for (const size of [{ width: 1920, height: 1080 }, { width: 1024, height: 700 }]) {
    await page.setViewportSize(size);
    await page.waitForTimeout(400);
    const s = (await stage(page).boundingBox())!;
    for (const b of await page.locator('button[data-cell]').evaluateAll((els) => els.map((el) => (el as any).getBoundingClientRect().toJSON()))) {
      expect(b.left).toBeGreaterThanOrEqual(s.x - 1);
      expect(b.right).toBeLessThanOrEqual(s.x + s.width + 1);
      expect(b.top).toBeGreaterThanOrEqual(s.y - 1);
      expect(b.bottom).toBeLessThanOrEqual(s.y + s.height + 1);
    }
  }
  await resign(page);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun run build && bunx playwright test e2e/cm-board.e2e.ts`
Expected: test 1 FAILS (no toolbar), test 2 FAILS (spin unchanged, -35), test 3 may pass (fit exists) — that's fine.

- [ ] **Step 3: Add camera state and handlers to `Board.svelte`**

In the `<script>`, below `let tilt = …`, add:

```ts
  import { clampTilt, TOP } from './iso'; // merge into the existing iso import

  /** The angle the fit is computed for: only updated at rest, so the board doesn't breathe while you drag. */
  let rest = $state({ spin: ISO.spin, tilt: ISO.tilt });
  let drag: { x: number; y: number; spin: number; tilt: number; touch: boolean; moved: boolean } | null = null;
  let dragging = $state(false);
  /** Set for the click that ends a swivel, so it never places an orb. */
  let suppress = false;

  function aim(next: { spin: number; tilt: number }) {
    spin = next.spin;
    tilt = clampTilt(next.tilt);
    rest = { spin, tilt };
  }
  function down(e: PointerEvent) {
    if (e.button !== 0 || (e.target as Element).closest('.pill')) return;
    drag = { x: e.clientX, y: e.clientY, spin, tilt, touch: e.pointerType === 'touch', moved: false };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
  }
  function move(e: PointerEvent) {
    if (!drag) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    // Touch swivels only sideways: up and down stay with the page's scroll.
    if (!drag.moved && Math.abs(dx) + (drag.touch ? 0 : Math.abs(dy)) > 4) {
      drag.moved = true;
      dragging = true;
    }
    if (!drag.moved) return;
    spin = drag.spin + dx * 0.4;
    if (!drag.touch) tilt = clampTilt(drag.tilt - dy * 0.3);
  }
  function up() {
    if (drag?.moved) {
      suppress = true;
      setTimeout(() => (suppress = false), 0);
      rest = { spin, tilt };
    }
    cancel();
  }
  function cancel() {
    drag = null;
    dragging = false;
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', cancel);
  }
  $effect(() => cancel);
```

Change `scale` to use the rest angle:

```ts
  const scale = $derived(fitScale(size, stageSize, rest.spin, rest.tilt));
```

On the stage element add `onpointerdown={down}` and `class:dragging`; on each button change the click to `onclick={() => !suppress && ok && onMove(b.cell)}`.

After the `.slab` div (still inside `.stage3d`) add the pill:

```svelte
  <div class="pill" role="toolbar" aria-label="Board view">
    <button type="button" aria-label="Rotate left 90°" onclick={() => aim({ spin: spin - 90, tilt })}>⟲ 90°</button>
    <button type="button" aria-label="Isometric view" onclick={() => aim(ISO)}>Iso</button>
    <button type="button" aria-label="Top view" onclick={() => aim(TOP)}>Top</button>
    <button type="button" aria-label="Rotate right 90°" onclick={() => aim({ spin: spin + 90, tilt })}>90° ⟳</button>
    <span class="hint">drag to swivel</span>
  </div>
```

CSS additions:

```css
  .stage3d {
    cursor: grab;
    touch-action: pan-y;
  }
  .stage3d.dragging {
    cursor: grabbing;
  }
  .slab {
    transition: transform 0.7s cubic-bezier(0.2, 0.8, 0.2, 1);
  }
  .dragging .slab,
  .dragging .bb {
    transition: none;
  }
  .bb {
    transition: transform 0.7s cubic-bezier(0.2, 0.8, 0.2, 1);
  }
  .pill {
    position: absolute;
    bottom: 16px;
    left: 50%;
    transform: translateX(-50%);
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 4px;
    background: rgba(13, 16, 32, 0.9);
    border: 1px solid #23283f;
    border-radius: 999px;
    font: 500 12px var(--font-sans, 'IBM Plex Sans', sans-serif);
    color: #b8bdd4;
    cursor: default;
    z-index: 3;
  }
  .pill button {
    width: auto;
    height: auto;
    padding: 6px 12px;
    border-radius: 999px;
    color: inherit;
    font: inherit;
    transform-style: flat;
  }
  .pill button:hover {
    background: #1a1f35;
    color: #e6e8f2;
  }
  .hint {
    padding: 6px 12px 6px 8px;
    color: #5c6280;
    border-left: 1px solid #23283f;
    white-space: nowrap;
  }
  @media (max-width: 560px) {
    .hint {
      display: none;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .slab,
    .bb {
      transition: none;
    }
  }
```

Note: cell styles are scoped to `.face > button` (Task 2), so the pill's buttons only get the `.pill button` rules.

- [ ] **Step 4: Run to verify it passes**

Run: `bun run build && bunx playwright test e2e/cm-board.e2e.ts e2e/match.e2e.ts`
Expected: 3/3 cm-board and 4/4 match pass.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/games/critical-mass/Board.svelte e2e/cm-board.e2e.ts
git commit -m "Critical Mass: the camera — drag to swivel and tilt, the view pill, sideways-only swivel on touch, a swivel never places"
```

---

### Task 4: Animations — drop, pop, last-move ring, chain flights

**Files:**
- Modify: `apps/web/src/lib/games/critical-mass/Board.svelte`

**Interfaces:**
- Consumes: `cellIndex` (`@cs/critical-mass`), `changedCells`, `flightPlan`, `cellCenter`, `FLIGHT_MS` (Task 1).
- Produces: `prev` board snapshot and a per-move `anim` record that Task 5's sound reads: `{ move: number; last: number | null; hits: Map<number, number>; flights: Flight[]; bursts: {index, delay}[]; total: number; mover: string | null }`, plus a `onNewMove(prevBoard, view)` hook point where Task 5 adds sound calls.

- [ ] **Step 1: Add the move tracker to the script**

```ts
  import { cellIndex } from '@cs/critical-mass';
  import { cellCenter, changedCells, flightPlan, FLIGHT_MS, type Flight } from './iso'; // merge into the iso import

  const reduced = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  type Anim = {
    move: number;
    last: number | null;
    hits: Map<number, number>;
    changed: Set<number>;
    flights: Flight[];
    bursts: { index: number; delay: number }[];
    total: number;
    mover: string | null;
  };
  let anim = $state<Anim | null>(null);
  let seenMove = -1;
  let prev: { owner: string | null; orbs: number }[] = [];
  let clearFlights: ReturnType<typeof setTimeout> | undefined;

  // A new move arrived: work out what changed and stage its animation (skipped on first paint and with reduced motion).
  $effect(() => {
    const move = view.moveCount;
    const board = view.board.map((b) => ({ owner: b.owner, orbs: b.orbs }));
    if (move === seenMove) return;
    const firstPaint = seenMove === -1;
    seenMove = move;
    const before = prev;
    prev = board;
    if (firstPaint || before.length !== board.length) return;
    onNewMove(before, board);
    if (reduced) return;
    const waves = (view.lastMove?.waves ?? []).map((w) =>
      w.map((c) => cellIndex(view.cols, view.rows, c)).filter((i): i is number => i !== null),
    );
    const plan = flightPlan(waves, view.cols, view.rows);
    const last = view.lastMove ? cellIndex(view.cols, view.rows, view.lastMove.cell) : null;
    anim = { move, last, changed: new Set(changedCells(before, board)), mover: view.lastMove?.seat ?? null, ...plan };
    clearTimeout(clearFlights);
    clearFlights = setTimeout(() => anim && (anim = { ...anim, flights: [], bursts: [] }), plan.total + 100);
  });
  $effect(() => () => clearTimeout(clearFlights));

  /** Hook for side effects of a move seen live (Task 5 plays sounds here). */
  function onNewMove(before: { owner: string | null; orbs: number }[], after: { owner: string | null; orbs: number }[]) {
    void before;
    void after;
  }

  /** Orbs re-mount (and so re-animate) only for cells this move touched. */
  const animKey = (i: number) => (anim && (anim.changed.has(i) || i === anim.last) ? anim.move : -1);
```

- [ ] **Step 2: Mark up the animated layers**

Replace the orb `{#each}` inside each button with:

```svelte
          {#if anim && i === anim.last}{#key anim.move}<span class="ring" style:--ring={colorOf(colors, anim.mover)}></span>{/key}{/if}
          {#key animKey(i)}
            {#each orbSpots(b.owner ? b.orbs : 0) as [x, y], o (o)}
              {@const isDrop = anim && i === anim.last && !anim.hits.has(i) && o === Math.min(b.orbs, 3) - 1}
              {@const delay = anim && animKey(i) !== -1 ? (anim.hits.get(i) ?? 0) + o * 50 : 0}
              <span class="spot" style:left="{x}px" style:top="{y}px">
                <i class="contact"></i>
                <span class="bb"><i class="orb" class:drop={isDrop} class:pop={!isDrop && animKey(i) !== -1} style:animation-delay="{delay}ms"></i></span>
              </span>
            {/each}
          {/key}
```

After the `{#each order …}` block, still inside `.face`, add the flights and bursts layer:

```svelte
      {#if anim}
        <div class="fx" aria-hidden="true">
          {#each anim.bursts as burst, n (n)}
            {@const c = cellCenter(burst.index, view.cols, view.rows)}
            <i class="burst" style:left="{c.x}px" style:top="{c.y}px" style:animation-delay="{burst.delay}ms" style:--burst={colorOf(colors, anim.mover)}></i>
          {/each}
          {#each anim.flights as f, n (n)}
            {@const a = cellCenter(f.from, view.cols, view.rows)}
            {@const z = cellCenter(f.to, view.cols, view.rows)}
            {@const t = shades(colorOf(colors, anim.mover))}
            <span class="flight" style:left="{a.x}px" style:top="{a.y}px" style:--dx="{z.x - a.x}px" style:--dy="{z.y - a.y}px" style:--flight="{FLIGHT_MS}ms" style:animation-delay="{f.delay}ms">
              <span class="bb"><i class="orb small" style:--orb-light={t.light} style:--orb={colorOf(colors, anim.mover)} style:--orb-dark={t.dark} style:--glow={t.glow}></i></span>
            </span>
          {/each}
        </div>
      {/if}
```

- [ ] **Step 3: Keyframes and animation CSS (values from the comp)**

```css
  .orb.drop {
    animation: cm-drop 0.55s cubic-bezier(0.3, 0.7, 0.4, 1) both;
  }
  .orb.pop {
    animation: cm-pop 0.42s ease-out both;
  }
  .ring {
    position: absolute;
    inset: -2px;
    border-radius: 5px;
    border: 2px solid var(--ring);
    transform: translateZ(8px);
    animation: cm-ring 0.55s ease-out both;
    pointer-events: none;
  }
  .fx {
    position: absolute;
    inset: 0;
    transform-style: preserve-3d;
    pointer-events: none;
  }
  .burst {
    position: absolute;
    width: 0;
    height: 0;
    transform: translateZ(10px);
  }
  .burst::after {
    content: '';
    position: absolute;
    left: -22px;
    top: -22px;
    width: 44px;
    height: 44px;
    border-radius: 50%;
    background: radial-gradient(circle, rgba(255, 255, 255, 0.9), var(--burst) 40%, transparent 70%);
    animation: cm-burst 0.42s ease-out both;
    animation-delay: inherit;
  }
  .flight {
    position: absolute;
    width: 0;
    height: 0;
    transform-style: preserve-3d;
    animation: cm-fly var(--flight) cubic-bezier(0.4, 0, 0.6, 1) both;
  }
  .orb.small {
    inset: 3px;
  }
  @keyframes cm-drop {
    0% { transform: translateY(-80px); opacity: 0; }
    50% { transform: translateY(0) scale(1.18, 0.8); opacity: 1; }
    70% { transform: translateY(-7px) scale(0.95, 1.06); }
    85% { transform: translateY(0) scale(1.04, 0.96); }
    100% { transform: none; }
  }
  @keyframes cm-pop {
    0% { transform: scale(0.2); opacity: 0; }
    60% { transform: scale(1.25); opacity: 1; }
    100% { transform: none; }
  }
  @keyframes cm-ring {
    0% { transform: translateZ(8px) scale(0.85); opacity: 0.9; }
    100% { transform: translateZ(8px) scale(1.35); opacity: 0; }
  }
  @keyframes cm-burst {
    0% { transform: scale(0.3); opacity: 0; }
    30% { opacity: 1; }
    100% { transform: scale(1.4); opacity: 0; }
  }
  @keyframes cm-fly {
    0% { transform: translate(0, 0); opacity: 0; }
    15% { opacity: 1; }
    100% { transform: translate(var(--dx), var(--dy)); opacity: 1; }
  }
  @media (prefers-reduced-motion: reduce) {
    .orb.drop,
    .orb.pop,
    .ring,
    .burst::after,
    .flight {
      animation: none;
    }
  }
```

- [ ] **Step 4: Verify behaviour and nothing regressed**

Run: `bun run typecheck && bun run build && bunx playwright test e2e/match.e2e.ts e2e/cm-board.e2e.ts`
Expected: all pass (e2e runs reduced-motion, so animation code must be inert there).

Then a throwaway motion check: write `e2e/zz-cm-motion.e2e.ts` with `test.use({ reducedMotion: 'no-preference' })`, play ~12 legal clicks against Sprocket, and after each click take `page.screenshot` at +120 ms and +400 ms into `<scratchpad>/cm-motion-*.png`. Look for: drop on the placed orb, ring on the last move, bursts and flying orbs during a chain, landing pops. Delete the file.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/games/critical-mass/Board.svelte
git commit -m "Critical Mass: the board moves — drop and squash on a placement, last-move ring, chain reactions burst and fly wave by wave"
```

---

### Task 5: Sound

**Files:**
- Create: `apps/web/src/lib/games/critical-mass/sound.ts`
- Test: `apps/web/src/lib/games/critical-mass/sound.test.ts`
- Modify: `apps/web/src/lib/games/critical-mass/Board.svelte`
- Modify: `e2e/cm-board.e2e.ts`

**Interfaces:**
- Consumes: `onNewMove` hook, `prev`, `captured`, `WAVE_MS` (Tasks 1, 4); `.pill` toolbar (Task 3).
- Produces: `popFrequency(wave: number): number`; `createSound(key?: string): { readonly enabled: boolean; toggle(): boolean; clink(delay?: number): void; pop(wave: number, delay?: number): void; thud(delay?: number): void; close(): void }`; pill button named `Sound` with `aria-pressed`.

- [ ] **Step 1: Failing unit test**

```ts
// apps/web/src/lib/games/critical-mass/sound.test.ts
import { describe, expect, test } from 'bun:test';
import { popFrequency } from './sound';

describe('popFrequency', () => {
  test('each wave pops a semitone higher, levelling off after an octave', () => {
    expect(popFrequency(0)).toBeCloseTo(440, 5);
    expect(popFrequency(1)).toBeCloseTo(440 * 2 ** (1 / 12), 5);
    expect(popFrequency(12)).toBeCloseTo(880, 5);
    expect(popFrequency(40)).toBeCloseTo(880, 5);
  });
});
```

Add to `e2e/cm-board.e2e.ts`:

```ts
test('the sound toggle starts off and is remembered', async ({ page }) => {
  await startMatch(page);
  const sound = page.getByRole('toolbar', { name: 'Board view' }).getByRole('button', { name: 'Sound' });
  await expect(sound).toHaveAttribute('aria-pressed', 'false');
  await sound.click();
  await expect(sound).toHaveAttribute('aria-pressed', 'true');
  await page.reload();
  await expect(page.getByRole('toolbar', { name: 'Board view' }).getByRole('button', { name: 'Sound' })).toHaveAttribute('aria-pressed', 'true');
  await resign(page);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `bun test apps/web/src/lib/games/critical-mass/sound.test.ts` → FAIL (no module).
Run: `bun run build && bunx playwright test e2e/cm-board.e2e.ts -g "sound"` → FAIL (no Sound button).

- [ ] **Step 3: Implement `sound.ts`**

```ts
// apps/web/src/lib/games/critical-mass/sound.ts
/** Explosion waves climb a semitone each, for an octave. */
export const popFrequency = (wave: number) => 440 * 2 ** (Math.min(wave, 12) / 12);

/** Critical Mass's sounds, synthesized like Crown & Steel's: no files, nothing until the player turns it on. */
export function createSound(key = 'cm_sound') {
  let enabled = false;
  try {
    enabled = localStorage.getItem(key) === 'on';
  } catch {
    /* Storage is optional. */
  }
  let ctx: AudioContext | undefined;
  let noise: AudioBuffer | undefined;
  function audio() {
    if (!enabled) return;
    try {
      ctx ??= new AudioContext();
      void ctx.resume();
      return ctx;
    } catch {
      return; /* Sound is optional. */
    }
  }
  function noiseBuffer(a: AudioContext) {
    if (!noise) {
      noise = a.createBuffer(1, Math.floor(a.sampleRate * 0.25), a.sampleRate);
      const data = noise.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    }
    return noise;
  }
  /** A glassy clink: two bright partials, fast decay. */
  function clink(delay = 0) {
    const a = audio();
    if (!a) return;
    const t = a.currentTime + delay;
    for (const [freq, vol] of [[1568, 0.08], [2349, 0.04]] as const) {
      const osc = a.createOscillator();
      const gain = a.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(vol, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.25);
      osc.connect(gain);
      gain.connect(a.destination);
      osc.start(t);
      osc.stop(t + 0.26);
    }
  }
  /** A pop: a short pitched blip over a puff of bandpassed noise. */
  function pop(wave: number, delay = 0) {
    const a = audio();
    if (!a) return;
    const t = a.currentTime + delay;
    const f = popFrequency(wave);
    const osc = a.createOscillator();
    const gain = a.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(f * 1.5, t);
    osc.frequency.exponentialRampToValueAtTime(f, t + 0.06);
    gain.gain.setValueAtTime(0.12, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.14);
    osc.connect(gain);
    gain.connect(a.destination);
    osc.start(t);
    osc.stop(t + 0.15);
    const puff = a.createBufferSource();
    puff.buffer = noiseBuffer(a);
    const band = a.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = f * 2;
    const puffGain = a.createGain();
    puffGain.gain.setValueAtTime(0.08, t);
    puffGain.gain.exponentialRampToValueAtTime(0.001, t + 0.08);
    puff.connect(band);
    band.connect(puffGain);
    puffGain.connect(a.destination);
    puff.start(t);
    puff.stop(t + 0.09);
  }
  /** A capture: a low sine dropping fast. */
  function thud(delay = 0) {
    const a = audio();
    if (!a) return;
    const t = a.currentTime + delay;
    const osc = a.createOscillator();
    const gain = a.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(110, t);
    osc.frequency.exponentialRampToValueAtTime(42, t + 0.18);
    gain.gain.setValueAtTime(0.28, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.24);
    osc.connect(gain);
    gain.connect(a.destination);
    osc.start(t);
    osc.stop(t + 0.25);
  }
  return {
    get enabled() {
      return enabled;
    },
    toggle() {
      enabled = !enabled;
      try {
        localStorage.setItem(key, enabled ? 'on' : 'off');
      } catch {
        /* Storage is optional. */
      }
      if (enabled) clink();
      return enabled;
    },
    clink,
    pop,
    thud,
    close() {
      void ctx?.close();
    },
  };
}
```

- [ ] **Step 4: Wire it into `Board.svelte`**

Script:

```ts
  import { createSound } from './sound';
  import { captured, WAVE_MS } from './iso'; // merge into the iso import

  const sound = typeof window === 'undefined' ? null : createSound();
  let soundOn = $state(sound?.enabled ?? false);
  $effect(() => () => sound?.close());
```

Replace the body of `onNewMove`:

```ts
  function onNewMove(before: { owner: string | null; orbs: number }[], after: { owner: string | null; orbs: number }[]) {
    if (!sound?.enabled) return;
    sound.clink();
    const waves = view.lastMove?.waves ?? [];
    waves.forEach((_, k) => sound.pop(k, (k * WAVE_MS) / 1000));
    const mover = view.lastMove?.seat;
    if (mover && captured(before, after, mover)) sound.thud((waves.length * WAVE_MS) / 1000);
  }
```

Pill: before the `.hint` span add

```svelte
    <button type="button" class="snd" aria-label="Sound" aria-pressed={soundOn} onclick={() => (soundOn = sound?.toggle() ?? false)}>♪</button>
```

CSS: `.pill .snd[aria-pressed='true'] { color: #e6e8f2; background: #1a1f35; }`

- [ ] **Step 5: Run to verify they pass**

Run: `bun test apps/web/src/lib/games/critical-mass && bun run build && bunx playwright test e2e/cm-board.e2e.ts`
Expected: unit PASS; 4/4 e2e PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/lib/games/critical-mass e2e/cm-board.e2e.ts
git commit -m "Critical Mass: sound — a clink on every placement, pops that climb with the chain, a thud on a capture; off until you turn it on"
```

---

### Task 6: Corner cards on the table page

**Files:**
- Create: `apps/web/src/lib/games/critical-mass/SeatCard.svelte`
- Modify: `apps/web/src/routes/t/[id]/+page.svelte` (Critical Mass stage block ~lines 382–421 and its CSS; remove the now-unused `card` snippet, `.player`/`.side`/`.orbs`/`.cells`/`.swatch` rules and Task 2's interim `.boardwrap` rule)
- Modify: `e2e/cm-board.e2e.ts`

**Interfaces:**
- Consumes: `SeatInfo` (`@cs/shared/protocol`), `Avatar`, `IdentityChip`, `clock`, `colorOf`.
- Produces: `SeatCard` props `{ s: SeatInfo; color: string; you: boolean; onClock: boolean; out: boolean; secondsLeft: number | null; live: boolean; count: { cells: number; orbs: number }; corner: 'tl' | 'tr' | 'bl' | 'br' }`; root element `.seat[data-seat=<seat>]`, clock in `.clock`.

- [ ] **Step 1: Failing e2e**

Append to `e2e/cm-board.e2e.ts`:

```ts
test('players sit in corner cards; the seat to move shows the clock', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await startMatch(page);
  await myTurn(page);
  const cards = page.locator('.seat[data-seat]');
  await expect(cards).toHaveCount(2);
  await expect(cards.first()).toContainText('you');
  await expect(cards.first().locator('.clock')).toBeVisible();
  await expect(cards.nth(1)).toContainText('waiting');
  await resign(page);
});

test('at 400 px the board fits and the cards never cover a cell', async ({ page }) => {
  await page.setViewportSize({ width: 400, height: 860 });
  await startMatch(page);
  const { scroll, inner } = await page.evaluate(() => {
    const g = globalThis as any;
    return { scroll: g.document.documentElement.scrollWidth as number, inner: g.innerWidth as number };
  });
  expect(scroll).toBeLessThanOrEqual(inner);
  const cards = await page.locator('.seat[data-seat]').evaluateAll((els) => els.map((el) => (el as any).getBoundingClientRect().toJSON()));
  const cells = await page.locator('button[data-cell]').evaluateAll((els) => els.map((el) => (el as any).getBoundingClientRect().toJSON()));
  for (const c of cards) for (const b of cells) {
    const overlap = c.left < b.right && b.left < c.right && c.top < b.bottom && b.top < c.bottom;
    expect(overlap, 'a card covers a cell').toBe(false);
  }
  await resign(page);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun run build && bunx playwright test e2e/cm-board.e2e.ts -g "corner|400"` → FAIL (no `.seat`).

- [ ] **Step 3: Create `SeatCard.svelte`**

```svelte
<script lang="ts">
  import type { SeatInfo } from '@cs/shared/protocol';
  import Avatar from '$lib/components/Avatar.svelte';
  import IdentityChip from '$lib/components/IdentityChip.svelte';
  import { clock } from '$lib/seats';

  let {
    s,
    color,
    you,
    onClock,
    out,
    secondsLeft,
    live,
    count,
    corner,
  }: {
    s: SeatInfo;
    color: string;
    you: boolean;
    onClock: boolean;
    out: boolean;
    secondsLeft: number | null;
    live: boolean;
    count: { cells: number; orbs: number };
    corner: 'tl' | 'tr' | 'bl' | 'br';
  } = $props();
  const note = $derived(you ? 'you' : s.identity.isHouse ? 'house' : '');
</script>

<div class="seat {corner}" class:onclock={onClock && !out} class:out style:--seat={color} data-seat={s.seat}>
  <Avatar kind={s.identity.kind} size="2.5rem" glow={onClock && !out} />
  <div class="id">
    <span class="name"><IdentityChip identity={s.identity} badge={false} tag={false} />{#if note}<small>{note}</small>{/if}</span>
    <span class="stats"><b>{count.orbs}</b> {count.orbs === 1 ? 'orb' : 'orbs'} · {count.cells} {count.cells === 1 ? 'cell' : 'cells'}</span>
  </div>
  <span class="state">
    {#if out}out{:else if onClock && secondsLeft !== null}<span class="clock" class:low={secondsLeft <= 15} aria-label="{secondsLeft} seconds left">{clock(secondsLeft)}</span>{:else if live}waiting{/if}
  </span>
</div>

<style>
  .seat {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px 14px;
    background: rgba(18, 22, 42, 0.85);
    border: 1px solid #1f2438;
    border-radius: 12px;
    pointer-events: none;
    min-width: 0;
  }
  .seat.tr,
  .seat.br {
    flex-direction: row-reverse;
    text-align: right;
  }
  .seat.onclock {
    border-color: var(--seat);
  }
  .seat.out {
    opacity: 0.45;
  }
  .id {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .name {
    display: flex;
    align-items: baseline;
    gap: 6px;
    font-size: var(--step-0);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .tr .name,
  .br .name {
    flex-direction: row-reverse;
  }
  small {
    font-size: 11px;
    color: #7c829e;
  }
  .stats {
    font-size: 12px;
    color: #9aa0ba;
    margin-top: 2px;
  }
  .stats b {
    font: 600 13px var(--font-silicon);
    color: #e6e8f2;
  }
  .state {
    margin-inline: 10px 0;
    font-size: 12px;
    color: #5c6280;
  }
  .tr .state,
  .br .state {
    margin-inline: 0 10px;
  }
  .clock {
    font: 600 16px var(--font-silicon);
    color: var(--seat);
    font-variant-numeric: tabular-nums;
  }
  .clock.low {
    color: var(--danger, #ff6b6b);
  }
  @container (max-width: 560px) {
    .seat {
      gap: 8px;
      padding: 8px 10px;
    }
    .seat :global(.avatar) {
      --size: 1.75rem !important;
    }
    .state {
      margin-inline: 4px 0;
    }
  }
</style>
```

- [ ] **Step 4: Swap the page's Critical Mass stage**

Replace the `{#if view}<div class="stage" …>…</div>{/if}` block with:

```svelte
      {#if view}
        <div class="stage cm">
          <div class="corners">
            {#each ordered as s, k (s.seat)}
              <SeatCard
                {s}
                color={colorOf(colors, s.seat)}
                you={s.seat === mySeat}
                onClock={match.toMove.includes(s.seat)}
                out={view.eliminated.includes(s.seat)}
                {secondsLeft}
                live={match.status === 'live'}
                count={view.counts[s.seat] ?? { cells: 0, orbs: 0 }}
                corner={(['tl', 'tr', 'bl', 'br'] as const)[k % 4]}
              />
            {/each}
          </div>
          <div class="boardwrap">
            <Board {view} {colors} legal={legalCells} interactive={myTurn && !busy} onMove={move} />
            {#if countdown !== null}<div class="countdown" aria-hidden="true">{countdown || 'Go'}</div>{/if}
          </div>
        </div>
      {/if}
```

In the script, import `SeatCard from '$lib/games/critical-mass/SeatCard.svelte'` and replace the `sides` derived with:

```ts
  /** You first, then the rest in seat order: top-left, top-right, bottom-left, bottom-right. */
  const ordered = $derived.by(() => {
    const seats = match?.seats ?? [];
    return [...seats.filter((s) => s.seat === mySeat), ...seats.filter((s) => s.seat !== mySeat)];
  });
```

Delete the `card` snippet, the `.side`, `.player*`, `.id`, `.name`, `.role`, `.orbs`, `.cells`, `.swatch`, `.pill` (CM card pill) rules that only the old cards used (keep anything Lightline or the verdict still uses — `bun run check` reports unused selectors), and Task 2's interim `.boardwrap` rule. Add:

```css
  /* Critical Mass: the board owns the stage; players float in its corners. */
  .stage.cm {
    position: relative;
    display: flex;
    flex-direction: column;
    padding: 0;
    min-height: 0;
    container-type: size;
  }
  .stage.cm .boardwrap {
    flex: 1;
    min-height: 0;
    display: block;
  }
  .corners {
    position: absolute;
    inset: 18px 18px 72px;
    z-index: 2;
    pointer-events: none;
  }
  .corners > :global(.seat) {
    position: absolute;
    max-width: calc(50% - 9px);
  }
  .corners > :global(.tl) { top: 0; left: 0; }
  .corners > :global(.tr) { top: 0; right: 0; }
  .corners > :global(.bl) { bottom: 0; left: 0; }
  .corners > :global(.br) { bottom: 0; right: 0; }
  @container (max-width: 560px) {
    .corners {
      position: static;
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
      padding: 10px 10px 0;
    }
    .corners > :global(.seat) {
      position: static;
      max-width: none;
    }
  }
```

In the `@media (max-width: 960px)` block add:

```css
    .stage.cm {
      height: clamp(30rem, min(85dvh, calc(100vw + 10rem)), 52rem);
    }
```

- [ ] **Step 5: Run to verify it passes, plus the suites that touch this page**

Run: `bun run check --prefix apps/web 2>/dev/null || (cd apps/web && bun run check)` then `bun run build && bunx playwright test e2e/cm-board.e2e.ts e2e/match.e2e.ts e2e/tables.e2e.ts e2e/play.e2e.ts`
Expected: check clean (no unused-selector warnings left from the old cards); all pass, including the spectator test and the 3-player resign test.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/lib/games/critical-mass/SeatCard.svelte apps/web/src/routes/t/\[id\]/+page.svelte e2e/cm-board.e2e.ts
git commit -m "Critical Mass: players move into corner cards — clock on the seat to move, the board owns the stage, cards fold above it on phones"
```

---

### Task 7: Texture pass, screenshot review, full verify

**Files:**
- Modify (tuning only): `apps/web/src/lib/games/critical-mass/Board.svelte`, `SeatCard.svelte`

- [ ] **Step 1: Screenshot set (throwaway spec)**

Write `e2e/zz-cm-review.e2e.ts` (delete before commit) that captures into the scratchpad:
1. 1400×900, a 2-player match after ~10 moves (click legal cells against Sprocket), Iso.
2. Same at 1024×768 and 400×860 (full page).
3. Top view and a 135° swivel.
4. A mid-chain frame: `test.use({ reducedMotion: 'no-preference' })`, play until a move's `view.lastMove.waves.length >= 2` is visible (poll `button[data-cell]` changes) and screenshot at +200 ms.
5. A 3-player table via the API pattern in `e2e/tables.e2e.ts:101` (host invites two guests, both accept, host starts), screenshot from the host's page.

- [ ] **Step 2: Review against the comp and tune**

Compare shot 1 with the comp screenshot. Check: slab colour and edge, cell recess depth, rim glass reads in both owner colours, orbs read as spheres from Top and 135°, grain is visible up close but doesn't muddy the soil (adjust the `--grain` alpha `.07` between `.04` and `.10`), corner cards match the comp's spacing, nothing overlaps the pill. Re-shoot after each tweak.

- [ ] **Step 3: Full verify**

Run: `bun run verify` (foreground).
Expected: typecheck clean, all unit tests pass, build ok, all e2e pass. `accounts.e2e.ts:4` is a known pre-existing flake: if it alone fails, rerun that file once and note it.

- [ ] **Step 4: Commit and clean up**

```bash
rm -f e2e/zz-cm-review.e2e.ts
git add apps/web/src/lib/games/critical-mass
git commit -m "Critical Mass: texture and spacing tuned against the comp"
```

Hand the Foreman the screenshot set (desktop, phone, mid-chain, 3-player) before merging.
