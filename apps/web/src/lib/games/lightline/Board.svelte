<script lang="ts">
  import type { LLView } from '@cs/lightline';
  import type { FiredRule, SeatInfo } from '@cs/shared/protocol';
  import { colorOf, type TableColors } from '$lib/seats';

  let {
    view,
    colors,
    seats,
    fired,
  }: { view: LLView; colors: TableColors; seats: SeatInfo[]; fired: Record<string, FiredRule | null> } = $props();

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
  });
</script>

<div class="lightline">
  <div class="arena" role="img" aria-label="Lightline arena, round {view.round}: {view.cycles.map((c) => `@${handleOf(c.seat)} ${c.alive ? 'riding' : 'crashed'}`).join(', ')}">
    <canvas bind:this={canvas} aria-hidden="true" style:aspect-ratio="{cols} / {rows}"></canvas>
  </div>
  <ol class="riders">
    {#each view.cycles as cy (cy.seat)}
      {@const rule = fired[cy.seat]}
      <li class:down={!cy.alive} style:--seat={colorOf(colors, cy.seat)}>
        <span class="who">@{handleOf(cy.seat)}</span>
        <span class="score" aria-label="{view.score[cy.seat] ?? 0} rounds won">{view.score[cy.seat] ?? 0}</span>
        <span class="boosts" aria-label="{cy.boosts} boosts left">{'▮'.repeat(cy.boosts)}</span>
        <span class="rule">{cy.alive ? (rule ? (rule.label ?? `rule ${rule.index + 1}`) : 'default') : 'crashed'}</span>
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
