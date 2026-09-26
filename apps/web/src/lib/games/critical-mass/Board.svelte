<script lang="ts">
  import { cellIndex, neighbors, type CMBoardCell, type CMView } from '@cs/critical-mass';
  import { seatColor } from '$lib/seats';
  import { burstDuration, cellOrigin, layout, orbOffsets, rgba, waveSchedule } from './render';

  let {
    view,
    legal,
    interactive,
    onMove,
  }: { view: CMView; legal: string[]; interactive: boolean; onMove: (cell: string) => void } = $props();

  const WAVE_MS = 150;
  const BURST_MS = 420;
  const reduced = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

  let box: HTMLDivElement | undefined = $state();
  let canvas: HTMLCanvasElement | undefined = $state();
  let size = $state({ w: 0, h: 0 });
  let hover = $state<number | null>(null);
  const legalSet = $derived(new Set(legal));

  let bursts: { index: number; start: number }[] = [];
  let burstsAt = 0;
  let burstsUntil = 0;
  let seenMove = -1;

  $effect(() => {
    if (!box) return;
    const ro = new ResizeObserver(([entry]) => {
      size = { w: entry.contentRect.width, h: entry.contentRect.height };
    });
    ro.observe(box);
    return () => ro.disconnect();
  });

  // A new move arrived: schedule its explosion waves (skipped on first paint and with reduced motion).
  $effect(() => {
    const key = view.moveCount;
    if (key === seenMove) return;
    const firstPaint = seenMove === -1;
    seenMove = key;
    const waves = view.lastMove?.waves ?? [];
    if (firstPaint || reduced || waves.length === 0) return;
    const indices = waves.map((w) => w.map((c) => cellIndex(view.cols, view.rows, c)).filter((i): i is number => i !== null));
    bursts = waveSchedule(indices, WAVE_MS);
    burstsAt = performance.now();
    burstsUntil = burstsAt + burstDuration(indices.length, WAVE_MS, BURST_MS);
  });

  function drawOrb(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, color: string, loaded: boolean) {
    const g = ctx.createRadialGradient(x - r * 0.35, y - r * 0.35, r * 0.1, x, y, r);
    g.addColorStop(0, '#ffffff');
    g.addColorStop(0.3, color);
    g.addColorStop(1, rgba(color, 0.55));
    ctx.save();
    ctx.shadowColor = color;
    ctx.shadowBlur = loaded ? r * 2.4 : r * 1.1;
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  function draw(now: number) {
    if (!canvas || size.w === 0) return;
    const l = layout(view.cols, view.rows, size.w, size.h);
    const dpr = window.devicePixelRatio || 1;
    const pw = Math.round(l.width * dpr);
    const ph = Math.round(l.height * dpr);
    if (canvas.width !== pw || canvas.height !== ph) {
      canvas.width = pw;
      canvas.height = ph;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, l.width, l.height);
    const mine = seatColor(view.you);
    const pad = l.cell * 0.06;

    view.board.forEach((b, i) => {
      const o = cellOrigin(l, i);
      const isLegal = interactive && legalSet.has(b.cell);
      ctx.beginPath();
      ctx.roundRect(o.x + pad, o.y + pad, l.cell - 2 * pad, l.cell - 2 * pad, l.cell * 0.14);
      ctx.fillStyle = isLegal && hover === i ? rgba(mine, 0.22) : b.owner ? rgba(seatColor(b.owner), 0.09) : 'rgba(255,255,255,0.025)';
      ctx.fill();
      ctx.lineWidth = 1;
      ctx.strokeStyle = isLegal ? rgba(mine, 0.4) : '#262a52';
      ctx.stroke();
    });

    view.board.forEach((b, i) => {
      if (!b.owner || b.orbs === 0) return;
      const o = cellOrigin(l, i);
      const cx = o.x + l.cell / 2;
      const cy = o.y + l.cell / 2;
      const loaded = b.orbs >= b.critical - 1;
      const spin = reduced ? 0 : now * 0.0007 * (loaded ? 2.5 : 1);
      const shake = loaded && !reduced ? Math.sin(now * 0.045 + i) * l.cell * 0.018 : 0;
      for (const off of orbOffsets(b.orbs, l.cell * 0.15)) {
        const x = cx + off.x * Math.cos(spin) - off.y * Math.sin(spin) + shake;
        const y = cy + off.x * Math.sin(spin) + off.y * Math.cos(spin);
        drawOrb(ctx, x, y, l.cell * 0.12, seatColor(b.owner), loaded);
      }
    });

    if (bursts.length > 0 && now <= burstsUntil) {
      const mover = seatColor(view.lastMove?.seat);
      for (const burst of bursts) {
        const p = (now - burstsAt - burst.start) / BURST_MS;
        if (p < 0 || p > 1) continue;
        const o = cellOrigin(l, burst.index);
        const cx = o.x + l.cell / 2;
        const cy = o.y + l.cell / 2;
        ctx.beginPath();
        ctx.arc(cx, cy, l.cell * (0.18 + 0.55 * p), 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(255,255,255,${0.9 * (1 - p)})`;
        ctx.lineWidth = 1 + 3 * (1 - p);
        ctx.stroke();
        const ease = 1 - (1 - p) ** 3;
        for (const n of neighbors(view.cols, view.rows, burst.index)) {
          const no = cellOrigin(l, n);
          const x = cx + (no.x + l.cell / 2 - cx) * ease;
          const y = cy + (no.y + l.cell / 2 - cy) * ease;
          drawOrb(ctx, x, y, l.cell * 0.07 * (1 - p * 0.5), mover, true);
        }
      }
    } else if (bursts.length > 0) {
      bursts = [];
    }
  }

  // Continuous animation loop, or a redraw only when something changes if reduced motion is on.
  $effect(() => {
    if (reduced) return;
    let raf = requestAnimationFrame(function loop(t) {
      draw(t);
      raf = requestAnimationFrame(loop);
    });
    return () => cancelAnimationFrame(raf);
  });
  $effect(() => {
    if (!reduced) return;
    void [view, size, hover, legalSet, interactive, canvas];
    draw(0);
  });

  function label(b: CMBoardCell): string {
    const state = b.owner ? `${b.orbs} ${b.owner} ${b.orbs === 1 ? 'orb' : 'orbs'}` : 'empty';
    return `${b.cell}, ${state}, explodes at ${b.critical}`;
  }

  const order = $derived(
    Array.from({ length: view.rows }, (_, k) => view.rows - 1 - k).flatMap((r) =>
      Array.from({ length: view.cols }, (_, c) => r * view.cols + c),
    ),
  );
</script>

<div
  class="board"
  bind:this={box}
  style:aspect-ratio="{view.cols} / {view.rows}"
  style:width="min(100%, calc(68dvh * {view.cols} / {view.rows}))"
>
  <canvas bind:this={canvas} aria-hidden="true"></canvas>
  <div class="cells" role="group" aria-label="Board" style:grid-template-columns="repeat({view.cols}, 1fr)">
    {#each order as i (i)}
      {@const b = view.board[i]}
      {@const ok = interactive && legalSet.has(b.cell)}
      <button
        type="button"
        data-cell={b.cell}
        data-legal={ok ? 'true' : 'false'}
        disabled={!ok}
        aria-label={label(b)}
        onclick={() => onMove(b.cell)}
        onpointerenter={() => (hover = i)}
        onpointerleave={() => hover === i && (hover = null)}
        onfocus={() => (hover = i)}
        onblur={() => hover === i && (hover = null)}
      ></button>
    {/each}
  </div>
</div>

<style>
  .board {
    position: relative;
    margin: 0 auto;
    max-width: 100%;
  }
  canvas {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
  }
  .cells {
    position: absolute;
    inset: 0;
    display: grid;
  }
  button {
    background: transparent;
    border: 0;
    padding: 0;
    border-radius: 12%;
  }
  button:disabled {
    cursor: default;
  }
  button:focus-visible {
    outline: 2px solid var(--chalk);
    outline-offset: -4px;
  }
</style>
