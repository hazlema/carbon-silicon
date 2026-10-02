<script lang="ts">
  import { cellIndex, type CMBoardCell, type CMView } from '@cs/critical-mass';
  import { colorOf, type TableColors } from '$lib/seats';
  import { boardSize, captured, cellCenter, cellOrder, changedCells, clampTilt, DRAG_THRESHOLD, EMPTY, fitScale, flightPlan, ISO, nearestTurn, orbSpots, popTimes, shades, TOP, type Flight } from './iso';
  import { createSound } from './sound';
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
  /** The angle the fit is computed for: only updated at rest, so the board doesn't breathe while you drag. */
  let rest = $state({ spin: ISO.spin, tilt: ISO.tilt });
  let drag: { x: number; y: number; spin: number; tilt: number; touch: boolean; moved: boolean } | null = null;
  let dragging = $state(false);
  /** Set for the click that ends a swivel, so it never places an orb. */
  let suppress = false;

  function aim(next: { spin: number; tilt: number }) {
    spin = nearestTurn(spin, next.spin);
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
    if (!drag.moved && Math.abs(dx) + (drag.touch ? 0 : Math.abs(dy)) > DRAG_THRESHOLD) {
      drag.moved = true;
      dragging = true;
    }
    if (!drag.moved) return;
    // The board's near edge follows the pointer, like turning a lazy Susan by its front rim.
    spin = drag.spin - dx * 0.4;
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
  let stage: HTMLDivElement | undefined = $state();
  let stageSize = $state({ w: 0, h: 0 });
  const size = $derived(boardSize(view.cols, view.rows));
  const scale = $derived(fitScale(size, stageSize, rest.spin, rest.tilt));
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

  const reduced = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  type Plain = { owner: string | null; orbs: number };
  type Anim = {
    move: number;
    last: number | null;
    hits: Map<number, number>;
    changed: Set<number>;
    flights: Flight[];
    bursts: { index: number; delay: number }[];
    total: number;
    flightMs: number;
    mover: string | null;
  };
  let anim = $state<Anim | null>(null);
  let seenMove = -1;
  let prev: Plain[] = [];
  let clearFx: ReturnType<typeof setTimeout> | undefined;

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
    const waves = (view.lastMove?.waves ?? []).map((w) =>
      w.map((c) => cellIndex(view.cols, view.rows, c)).filter((i): i is number => i !== null),
    );
    const plan = flightPlan(waves, view.cols, view.rows);
    onNewMove(before, board, waves.length, plan);
    if (reduced) return;
    const last = view.lastMove ? cellIndex(view.cols, view.rows, view.lastMove.cell) : null;
    anim = { move, last, changed: new Set(changedCells(before, board)), mover: view.lastMove?.seat ?? null, ...plan };
    clearTimeout(clearFx);
    clearFx = setTimeout(() => anim && (anim = { ...anim, flights: [], bursts: [] }), plan.total + 500);
  });
  $effect(() => () => clearTimeout(clearFx));

  const sound = typeof window === 'undefined' ? null : createSound();
  let soundOn = $state(sound?.enabled ?? false);
  $effect(() => () => sound?.close());

  /** A move seen live: a clink, a pop per explosion wave, a thud if it took an opponent's cell. */
  function onNewMove(before: Plain[], after: Plain[], waveCount: number, plan: { flightMs: number; total: number }) {
    if (!sound?.enabled) return;
    sound.clink();
    // Sound keeps the picture's (compressed) pace, and a long chain pops a capped number of times.
    popTimes(waveCount, plan.flightMs).forEach((ms, k) => sound.pop(k, ms / 1000));
    const mover = view.lastMove?.seat;
    if (mover && captured(before, after, mover)) sound.thud(plan.total / 1000);
  }

  /** Orbs re-mount (and so re-animate) only in cells this move touched. */
  const animKey = (i: number) => (anim && (anim.changed.has(i) || i === anim.last) ? anim.move : -1);

  const tone = (b: CMBoardCell) => (b.owner && b.orbs > 0 ? shades(colorOf(colors, b.owner)) : EMPTY);
  const hot = (b: CMBoardCell) => !!b.owner && b.orbs > 0 && b.orbs === b.critical - 1;

  /** Arrow keys move focus across the grid; every cell is focusable, legal or not. */
  function step(e: KeyboardEvent, k: number) {
    const d = ({ ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] } as Record<string, [number, number]>)[e.key];
    if (!d || !cellsEl) return;
    e.preventDefault();
    const col = Math.min(view.cols - 1, Math.max(0, (k % view.cols) + d[0]));
    const row = Math.min(view.rows - 1, Math.max(0, Math.floor(k / view.cols) + d[1]));
    (cellsEl.querySelectorAll<HTMLElement>(':scope > button')[row * view.cols + col] as HTMLElement | undefined)?.focus();
  }

  function label(b: CMBoardCell): string {
    const state = b.owner ? `${b.orbs} ${b.owner} ${b.orbs === 1 ? 'orb' : 'orbs'}` : 'empty';
    return `${b.cell}, ${state}, explodes at ${b.critical}`;
  }
</script>

<div
  class="stage3d"
  role="presentation"
  class:dragging
  bind:this={stage}
  onpointerdown={down}
  data-spin={spin}
  data-tilt={tilt}
  style:--spin="{spin}deg"
  style:--tilt="{tilt}deg"
  style:--mine={mine ? rgba(mine, 0.14) : 'transparent'}
>
  <div class="slab" style:transform="rotateX({tilt}deg) rotateZ({spin}deg) scale3d({scale}, {scale}, {scale})">
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
          onclick={() => !suppress && ok && onMove(b.cell)}
          onkeydown={(e) => step(e, k)}
        >
          <span class="floor"></span>
          <span class="rim s"></span><span class="rim n"></span><span class="rim w"></span><span class="rim e"></span>
          {#if hot(b)}<span class="hot"></span>{/if}
          {#if anim && i === anim.last}{#key anim.move}<span class="ring" style:--ring={colorOf(colors, anim.mover)}></span>{/key}{/if}
          {#key animKey(i)}
            {#each orbSpots(b.owner ? b.orbs : 0) as [x, y], o (o)}
              {@const isDrop = !!anim && i === anim.last && !anim.hits.has(i) && o === Math.min(b.orbs, 3) - 1}
              {@const moving = animKey(i) !== -1}
              {@const delay = anim && moving ? (anim.hits.get(i) ?? 0) + o * 50 : 0}
              <span class="spot" class:drop={isDrop} class:pop={!isDrop && moving} style:left="{x}px" style:top="{y}px" style:--d="{delay}ms">
                <i class="contact"></i>
                <span class="bb"><i class="orb"></i></span>
              </span>
            {/each}
          {/key}
        </button>
      {/each}
      {#if anim}{#key anim.move}
        <div class="fx" aria-hidden="true">
          {#each anim.bursts as burst, n (n)}
            {@const c = cellCenter(burst.index, view.cols, view.rows)}
            <i class="burst" style:left="{c.x}px" style:top="{c.y}px" style:animation-delay="{burst.delay}ms" style:--burst={colorOf(colors, anim.mover)}></i>
          {/each}
          {#each anim.flights as f, n (n)}
            {@const a = cellCenter(f.from, view.cols, view.rows)}
            {@const z = cellCenter(f.to, view.cols, view.rows)}
            {@const t = shades(colorOf(colors, anim.mover))}
            <span class="flight" style:left="{a.x}px" style:top="{a.y}px" style:--dx="{z.x - a.x}px" style:--dy="{z.y - a.y}px" style:--flight="{anim.flightMs}ms" style:animation-delay="{f.delay}ms">
              <span class="bb"><i class="orb small" style:--orb-light={t.light} style:--orb={colorOf(colors, anim.mover)} style:--orb-dark={t.dark} style:--glow={t.glow}></i></span>
            </span>
          {/each}
        </div>
      {/key}{/if}
    </div>
  </div>
  <div class="pill" role="toolbar" aria-label="Board view">
    <button type="button" aria-label="Rotate left 90°" onclick={() => aim({ spin: spin - 90, tilt })}>⟲ 90°</button>
    <button type="button" aria-label="Isometric view" onclick={() => aim(ISO)}>Iso</button>
    <button type="button" aria-label="Top view" onclick={() => aim(TOP)}>Top</button>
    <button type="button" aria-label="Rotate right 90°" onclick={() => aim({ spin: spin + 90, tilt })}>90° ⟳</button>
    <button type="button" class="snd" aria-label="Sound" aria-pressed={soundOn} onclick={() => (soundOn = sound?.toggle() ?? false)}>♪</button>
    <span class="hint">drag to swivel</span>
  </div>
</div>

<style>
  .stage3d {
    --cell: 66px;
    --grain: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='120'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='1.1' numOctaves='2' stitchTiles='stitch'/%3E%3CfeColorMatrix values='0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 0 0 0 .1 0'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");
    position: relative;
    width: 100%;
    height: 100%;
    display: grid;
    /* Tracks sized by the stage, not the slab: the unscaled slab can be wider than a narrow stage, and
       a content-sized track would start at the left edge and push the scaled board off centre. */
    grid-template: minmax(0, 1fr) / minmax(0, 1fr);
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
    /* A hair above the face: coplanar with it, the face can win the hit test (z-fighting) and eat the click. */
    transform: translateZ(1px);
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
    /* Orbs stand above the floor and, at a steep tilt, are drawn over the cell behind: they take the
       click themselves so it bubbles to their own cell. (Flight orbs sit in .fx, which stays inert.) */
    pointer-events: auto;
    background: radial-gradient(circle at 35% 30%, var(--orb-light) 0%, var(--orb) 45%, var(--orb-dark) 100%);
    box-shadow: 0 0 12px var(--glow);
  }
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
    min-height: 0;
    padding: 6px 12px;
    border: 0;
    border-radius: 999px;
    background: none;
    box-shadow: none;
    color: inherit;
    font: inherit;
    white-space: nowrap;
    transform-style: flat;
  }
  .pill button:hover {
    background: #1a1f35;
    color: #e6e8f2;
  }
  .pill .snd[aria-pressed='true'] {
    color: #e6e8f2;
    background: #1a1f35;
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
  .drop .orb {
    animation: cm-drop 0.55s cubic-bezier(0.3, 0.7, 0.4, 1) var(--d) both;
  }
  .pop .orb {
    animation: cm-pop 0.42s ease-out var(--d) both;
  }
  /* The floor shadow arrives with its orb, or it reads as a hole. */
  .drop .contact,
  .pop .contact {
    animation: cm-shadow 0.42s ease-out var(--d) both;
  }
  @keyframes cm-shadow {
    0% { opacity: 0; }
    100% { opacity: 1; }
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
  .fx .orb {
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
    85% { opacity: 1; }
    100% { transform: translate(var(--dx), var(--dy)); opacity: 0; }
  }
  @media (prefers-reduced-motion: reduce) {
    .drop .orb,
    .pop .orb,
    .drop .contact,
    .pop .contact,
    .ring,
    .burst::after,
    .flight {
      animation: none;
    }
  }
</style>
