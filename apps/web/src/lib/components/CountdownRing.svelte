<script lang="ts">
  import { arcPath, ringColor, ringTone } from '$lib/invite-ring';

  // `remaining` is the fraction of the invite's life left (1 = just arrived, 0 = expiring).
  // The sweep draws the elapsed part, so it fills clockwise from the top as time runs out.
  let { remaining, secs, size = 84 }: { remaining: number; secs: number; size?: number } = $props();

  const R = 44;
  const elapsed = $derived(1 - Math.max(0, Math.min(1, remaining)));
  const d = $derived(arcPath(elapsed, 50, 50, R));
  const color = $derived(ringColor(remaining));
  const urgent = $derived(ringTone(remaining) === 'urgent');
</script>

<div
  class="ring"
  class:urgent
  style:width="{size}px"
  style:height="{size}px"
  style:--num-size="{Math.round(size * 0.34)}px"
  role="timer"
  aria-label="{secs} seconds left to answer"
>
  <svg viewBox="0 0 100 100" aria-hidden="true">
    <circle class="track" cx="50" cy="50" r={R} />
    {#if d}<path class="sweep" {d} style:stroke={color} />{/if}
  </svg>
  <span class="secs" style:color aria-hidden="true">{secs}</span>
</div>

<style>
  .ring {
    position: relative;
    display: inline-grid;
    place-items: center;
    flex: none;
  }
  svg {
    width: 100%;
    height: 100%;
  }
  .track {
    fill: none;
    stroke: var(--lattice);
    stroke-width: 7;
  }
  .sweep {
    fill: none;
    stroke-width: 7;
    stroke-linecap: round;
    transition: stroke 0.5s ease;
  }
  .secs {
    position: absolute;
    font-family: var(--font-silicon);
    font-variant-numeric: tabular-nums;
    font-weight: 600;
    font-size: var(--num-size);
    line-height: 1;
  }
  .ring.urgent {
    animation: ring-pulse 1s ease-in-out infinite;
  }
  @keyframes ring-pulse {
    0%,
    100% {
      transform: scale(1);
    }
    50% {
      transform: scale(1.07);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .ring.urgent {
      animation: none;
    }
  }
</style>
