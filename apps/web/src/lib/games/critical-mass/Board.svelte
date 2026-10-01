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
    (cellsEl.querySelectorAll<HTMLElement>(':scope > button')[row * view.cols + col] as HTMLElement | undefined)?.focus();
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
