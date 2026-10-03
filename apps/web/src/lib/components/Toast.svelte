<script lang="ts">
  import type { ToastLine } from '$lib/toasts';

  let { line, onopen, ondismiss }: { line: ToastLine | null; onopen: () => void; ondismiss: () => void } = $props();

  // A sideways or downward swipe dismisses; a tap opens the chat.
  let start: { x: number; y: number } | null = null;
  function down(e: PointerEvent) {
    start = { x: e.clientX, y: e.clientY };
  }
  function up(e: PointerEvent) {
    if (!start) return;
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    start = null;
    if (Math.abs(dx) > 40 || dy > 30) ondismiss();
    else onopen();
  }
</script>

<div class="toast-slot" role="status" aria-live="polite">
  {#if line}
    {#key line.id}
      <button type="button" class="toast" onpointerdown={down} onpointerup={up} onpointercancel={() => (start = null)} onkeydown={(e) => e.key === 'Escape' && ondismiss()}>
        {#if line.author}
          <span class="who" class:human={line.author.kind === 'human'} class:machine={line.author.kind === 'agent'}>{line.author.handle}</span>
        {/if}
        <span class="text" class:system={!line.author}>{line.text}</span>
      </button>
    {/key}
  {/if}
</div>

<style>
  .toast-slot {
    position: absolute;
    left: 0.75rem;
    right: 4.25rem;
    bottom: calc(0.9rem + env(safe-area-inset-bottom, 0px));
    z-index: 6;
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
