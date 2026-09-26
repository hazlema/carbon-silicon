<script lang="ts">
  const W = 40;
  const GAP = 4;
  const STEP = W + GAP;
  type Cell = { x: number; y: number; el?: 'C' | 'Si' };

  const cells: Cell[] = [];
  const add = (period: number, group: number) =>
    cells.push({
      x: group - 1,
      y: period - 1,
      el: group === 14 && period === 2 ? 'C' : group === 14 && period === 3 ? 'Si' : undefined,
    });
  add(1, 1);
  add(1, 18);
  for (const period of [2, 3]) for (const group of [1, 2, 13, 14, 15, 16, 17, 18]) add(period, group);
  for (const period of [4, 5, 6, 7]) for (let group = 1; group <= 18; group++) add(period, group);
  for (const y of [7.5, 8.5]) for (let group = 3; group <= 17; group++) cells.push({ x: group - 1, y });
</script>

<svg class="lattice" viewBox="0 0 {18 * STEP} {9.5 * STEP}" aria-hidden="true" focusable="false">
  {#each cells as cell}
    <rect x={cell.x * STEP} y={cell.y * STEP} width={W} height={W} rx="4" class={cell.el ?? ''} />
    {#if cell.el}
      <text x={cell.x * STEP + W / 2} y={cell.y * STEP + W / 2 + 6} text-anchor="middle" class="sym {cell.el}">{cell.el}</text>
    {/if}
  {/each}
</svg>

<style>
  .lattice {
    position: fixed;
    right: -3vw;
    bottom: -4vh;
    width: min(1100px, 110vw);
    opacity: 0.55;
    pointer-events: none;
    z-index: 0;
  }
  rect {
    fill: none;
    stroke: var(--lattice);
    stroke-width: 1;
  }
  rect.C {
    stroke: var(--carbon);
    fill: color-mix(in oklab, var(--carbon) 10%, transparent);
  }
  rect.Si {
    stroke: var(--silicon);
    fill: color-mix(in oklab, var(--silicon) 10%, transparent);
  }
  .sym {
    font-size: 17px;
    font-weight: 600;
  }
  .sym.C {
    fill: var(--carbon);
    font-family: var(--font-carbon);
    font-style: italic;
  }
  .sym.Si {
    fill: var(--silicon);
    font-family: var(--font-silicon);
  }
</style>
