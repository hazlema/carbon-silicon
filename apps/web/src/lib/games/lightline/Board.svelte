<script lang="ts">
  import type { LLView } from '@cs/lightline';
  import type { FiredRule, SeatInfo } from '@cs/shared/protocol';
  import { colorOf, type TableColors } from '$lib/seats';
  import { swipeOf, type SteerKey } from './controls';

  let {
    view,
    colors,
    seats,
    fired,
    you = null,
    countdown = false,
    pressed = null,
    onSteer = null,
    fit = false,
  }: {
    view: LLView;
    colors: TableColors;
    seats: SeatInfo[];
    fired: Record<string, FiredRule | 'steering' | null>;
    /** Your seat, when you're playing: your cycle gets a ring. */
    you?: string | null;
    countdown?: boolean;
    /** The key just pressed, for the indicator on your row. */
    pressed?: SteerKey | null;
    /** Set when you can steer: a swipe on the arena steers and a tap boosts. */
    onSteer?: ((k: SteerKey) => void) | null;
    /** Fill the height the parent gives (a phone's table): the arena shrinks so the whole ledger fits below it. */
    fit?: boolean;
  } = $props();

  const ARROW: Record<SteerKey, string> = { n: '↑', e: '→', s: '↓', w: '←', boost: '⚡' };
  // One entry per finger: a thumb swiping while the other taps must not lose the swipe.
  const downs = new Map<number, { x: number; y: number }>();
  function onDown(e: PointerEvent) {
    if (e.pointerType === 'touch') downs.set(e.pointerId, { x: e.clientX, y: e.clientY });
  }
  function onUp(e: PointerEvent) {
    const start = downs.get(e.pointerId);
    downs.delete(e.pointerId);
    if (e.pointerType !== 'touch' || !start || !onSteer) return;
    onSteer(swipeOf(e.clientX - start.x, e.clientY - start.y));
  }
  function onCancel(e: PointerEvent) {
    downs.delete(e.pointerId);
  }
  const mine = $derived(view.cycles.find((c) => c.seat === you && c.alive));

  const SEAT_OF: Record<string, string> = { R: 'red', B: 'blue', G: 'green', Y: 'gold' };
  const CELL = 10;
  let canvas: HTMLCanvasElement | undefined = $state();
  const cols = $derived(view.grid[0]?.length ?? 0);
  const rows = $derived(view.grid.length);
  const handleOf = (seat: string) => seats.find((s) => s.seat === seat)?.identity.handle ?? seat;

  // The arena is drawn, not built from elements: 2,560 cells, redrawn up to ten times a second.
  $effect(() => {
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = cols * CELL * dpr;
    canvas.height = rows * CELL * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const css = getComputedStyle(canvas);
    const floor = css.getPropertyValue('--ink-deep').trim() || '#07080f';
    const wall = css.getPropertyValue('--fog').trim() || '#6b7194';
    ctx.fillStyle = floor;
    ctx.fillRect(0, 0, cols * CELL, rows * CELL);
    for (let y = 0; y < rows; y++) {
      const row = view.grid[y];
      for (let x = 0; x < cols; x++) {
        const c = row[x];
        if (c === '.') continue;
        ctx.fillStyle = c === '#' ? wall : colorOf(colors, SEAT_OF[c]);
        ctx.globalAlpha = c === '#' ? 0.5 : 0.55;
        ctx.fillRect(x * CELL + 1, y * CELL + 1, CELL - 2, CELL - 2);
      }
    }
    ctx.globalAlpha = 1;
    for (const cy of view.cycles) {
      if (!cy.alive) continue;
      const color = colorOf(colors, cy.seat);
      ctx.shadowColor = color;
      ctx.shadowBlur = cy.boosting ? 14 : 8;
      ctx.fillStyle = color;
      ctx.fillRect(cy.x * CELL, cy.y * CELL, CELL, CELL);
    }
    ctx.shadowBlur = 0;
    // Your own head, ringed in your colour, so you can find yourself at a glance.
    const me = view.cycles.find((c) => c.alive && c.seat === you);
    if (me) {
      ctx.lineWidth = 2;
      ctx.strokeStyle = colorOf(colors, me.seat);
      ctx.strokeRect(me.x * CELL - 3, me.y * CELL - 3, CELL + 6, CELL + 6);
    }
  });
</script>

<div class="lightline" class:fit>
  <div class="arena" role="img" aria-label="Lightline arena, round {view.round}: {view.cycles.map((c) => `@${handleOf(c.seat)} ${c.alive ? 'riding' : 'crashed'}`).join(', ')}">
    <div class="field" style:--cols={cols} style:--rows={rows}>
    <canvas
      bind:this={canvas}
      aria-hidden="true"
      style:aspect-ratio="{cols} / {rows}"
      style={onSteer ? 'touch-action: none' : undefined}
      onpointerdown={onDown}
      onpointerup={onUp}
      onpointercancel={onCancel}
    ></canvas>
    {#if countdown && mine}
      <span
        class="pulse"
        aria-hidden="true"
        style:--seat={colorOf(colors, mine.seat)}
        style:left="{((mine.x + 0.5) / cols) * 100}%"
        style:top="{((mine.y + 0.5) / rows) * 100}%"
      ></span>
    {/if}
    </div>
  </div>
  <ol class="riders">
    {#each view.cycles as cy (cy.seat)}
      {@const rule = fired[cy.seat]}
      <li class:down={!cy.alive} style:--seat={colorOf(colors, cy.seat)}>
        <span class="who">@{handleOf(cy.seat)}</span>
        <span class="score" aria-label="{view.score[cy.seat] ?? 0} rounds won">{view.score[cy.seat] ?? 0}</span>
        <span class="boosts" aria-label="{cy.boosts} boosts left">{'▮'.repeat(cy.boosts)}</span>
        {#if cy.seat === you}
          <span class="keys" class:lit={pressed !== null} aria-hidden="true">{pressed ? ARROW[pressed] : '↑ → ↓ ←'}</span>
        {/if}
        <span class="rule">{cy.alive ? (rule === 'steering' ? 'steering' : rule ? (rule.label ?? `rule ${rule.index + 1}`) : 'default') : 'crashed'}</span>
      </li>
    {/each}
  </ol>
</div>

<style>
  .lightline {
    display: grid;
    gap: 0.75rem;
    width: 100%;
  }
  .arena {
    position: relative;
  }
  .field {
    position: relative;
  }
  /* Fitting: the arena is the leftover box (a size container) and the field is the biggest board that fits it. */
  .lightline.fit {
    height: 100%;
    grid-template-rows: minmax(0, 1fr) auto;
    gap: 0.4rem;
  }
  .fit .arena {
    container-type: size;
    min-height: 0;
    display: grid;
    place-items: center;
  }
  .fit .field {
    width: min(100cqw, calc(100cqh * var(--cols) / var(--rows)));
  }
  .fit canvas {
    max-height: none;
  }
  .fit .riders {
    gap: 0.1rem 1rem;
    font-size: var(--step--1);
    padding-right: 4.25rem; /* room for the chat button, as the toast keeps */
  }
  /* A soft halo on your head while the countdown runs; a CSS animation, not canvas redraws. */
  .pulse {
    position: absolute;
    width: 8%;
    aspect-ratio: 1;
    transform: translate(-50%, -50%);
    border-radius: 50%;
    border: 2px solid var(--seat);
    pointer-events: none;
    animation: ping 0.9s ease-in-out infinite alternate;
  }
  @keyframes ping {
    from { opacity: 0.2; }
    to { opacity: 0.9; }
  }
  @media (prefers-reduced-motion: reduce) {
    .pulse {
      animation: none;
      opacity: 0.6;
    }
  }
  .keys {
    font-family: var(--font-silicon);
    font-size: var(--step--1);
    color: var(--fog);
    letter-spacing: 0.15em;
    display: inline-block;
    min-width: 7.5ch;
    transition: color 0.1s;
  }
  .keys.lit {
    color: var(--seat);
  }
  canvas {
    display: block;
    width: 100%;
    max-height: 68dvh;
    border-radius: var(--r-tile);
    background: var(--ink-deep);
  }
  .riders {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem 1.25rem;
  }
  .riders li {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    border-left: 3px solid var(--seat);
    padding-left: 0.5rem;
  }
  .riders li.down {
    opacity: 0.5;
  }
  .who {
    font-weight: 600;
  }
  .score {
    font-family: var(--font-silicon);
    color: var(--seat);
  }
  .boosts {
    color: var(--seat);
    letter-spacing: 0.1em;
    font-size: var(--step--1);
  }
  /* The rule that just fired: the doctrine at work, in the machines' own voice. */
  .rule {
    font-family: var(--font-silicon);
    font-size: var(--step--1);
    color: var(--fog);
  }
</style>
