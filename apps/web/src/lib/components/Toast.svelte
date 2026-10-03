<script lang="ts">
  import { fade } from 'svelte/transition';
  import type { ToastLine } from '$lib/toasts';

  /** Up to a few toasts stacked, oldest first, so the newest sits nearest the bottom (the thumb, the status line).
   *  Each is its own button: a tap opens the chat on that line's channel, a swipe or Escape dismisses only that one.
   *  `bottom`: how far above the bottom edge it sits (clear of the game's own pill or banner); `top`: sit under the
   *  header instead (after the match, when the verdict owns the bottom); `passthrough`: never take pointer input
   *  (Lightline's arena below is being steered), so swipes and taps reach the game and the chat button opens the chat. */
  let { lines, onopen, ondismiss, bottom = '7rem', top = false, passthrough = false, compact = false }: { lines: ToastLine[]; onopen: (line: ToastLine) => void; ondismiss: (id: number) => void; bottom?: string; top?: boolean; passthrough?: boolean; compact?: boolean } = $props();

  // A tap or the keyboard (Enter/Space) fires `click` and opens the chat. Pointer events only
  // detect a swipe (sideways or downward), which dismisses and swallows the click that follows.
  let start: { x: number; y: number } | null = null;
  let swallow = false;
  const leave = () => (globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 0 : 180);
  function down(e: PointerEvent) {
    start = { x: e.clientX, y: e.clientY };
    swallow = false;
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
  }
  function up(e: PointerEvent, line: ToastLine) {
    if (!start) return;
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    start = null;
    if (Math.abs(dx) > 40 || dy > 30) {
      swallow = true;
      ondismiss(line.id);
    } else if (Math.hypot(dx, dy) >= 10) {
      swallow = true; // a drag that is neither a tap nor a swipe does nothing
    }
    // The click fires right after pointerup; if there is none, do not leave the flag behind.
    if (swallow) setTimeout(() => (swallow = false), 0);
  }
  function click(line: ToastLine) {
    if (swallow) {
      swallow = false;
      return;
    }
    onopen(line);
  }
</script>

<div class="toast-slot" class:top class:compact={compact && !top} role="status" aria-live="polite" style:--toast-bottom={bottom}>
  {#each lines as line (line.id)}
    <button type="button" class="toast" class:passthrough tabindex={passthrough ? -1 : undefined} out:fade={{ duration: leave() }} onpointerdown={down} onpointerup={(e) => up(e, line)} onclick={() => click(line)} onpointercancel={() => (start = null)} onkeydown={(e) => e.key === 'Escape' && ondismiss(line.id)}>
      {#if line.author}
        <span class="who" class:human={line.author.kind === 'human'} class:machine={line.author.kind === 'agent'}>{line.author.handle}</span>
      {/if}
      <span class="text" class:system={!line.author}>{line.text}</span>
    </button>
  {/each}
</div>

<style>
  .toast-slot {
    position: absolute;
    left: 0.75rem;
    right: 4.25rem;
    /* above the status line and the game's own pill (per game, set by the page) */
    bottom: calc(var(--toast-bottom, 7rem) + env(safe-area-inset-bottom, 0px));
    z-index: 6;
    pointer-events: none;
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }
  .toast-slot.top {
    z-index: 11; /* above the verdict, which owns the bottom after the match */
    bottom: auto;
    top: calc(3.5rem + env(safe-area-inset-top, 0px));
  }
  /* One line, name inline: sized to sit over a status line without covering anything else. */
  .compact .toast {
    display: flex;
    gap: 0.5rem;
    align-items: baseline;
    padding: 0.3rem 0.75rem;
    background: var(--panel); /* opaque: it covers the status line, whose text must not show through */
  }
  .compact .who {
    margin: 0;
    flex: none;
  }
  .compact .text {
    -webkit-line-clamp: 1;
    line-clamp: 1;
  }
  .toast.passthrough {
    pointer-events: none;
  }
  .toast {
    pointer-events: auto;
    display: block;
    width: 100%;
    text-align: left;
    background: color-mix(in oklab, var(--panel) 94%, transparent);
    border: 1px solid var(--lattice);
    border-radius: 12px;
    padding: 0.55rem 0.75rem;
    color: var(--chalk);
    font: inherit;
    font-size: var(--step--1);
    line-height: 1.35;
    touch-action: none;
    animation: rise 180ms ease-out;
  }
  .who {
    display: block;
    margin-bottom: 0.15rem;
  }
  .who.human {
    color: var(--carbon);
    font-family: var(--font-carbon);
    font-style: italic;
  }
  .who.machine {
    color: var(--silicon);
    font-family: var(--font-silicon);
  }
  .text {
    display: -webkit-box;
    -webkit-line-clamp: 3;
    line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .text.system {
    color: var(--fog);
  }
  @keyframes rise {
    from { transform: translateY(0.5rem); opacity: 0; }
    to { transform: none; opacity: 1; }
  }
  @media (prefers-reduced-motion: reduce) {
    .toast { animation: none; }
  }
</style>
