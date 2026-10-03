<script lang="ts">
  import type { Snippet } from 'svelte';

  let { open, onclose, tapToClose, children }: { open: boolean; onclose: () => void; tapToClose: boolean; children: Snippet } = $props();

  let sheet: HTMLDivElement | undefined = $state();
  let kb = $state(0);
  let vvh = $state<number | null>(null);
  let drag = $state<{ y: number; dy: number } | null>(null);

  // On open, put the cursor in the chat box; the page returns focus to its chat button on close.
  $effect(() => {
    if (!open) return;
    // No composer (a read-only tab, a muted person): the dialog itself takes focus, so it isn't lost on the page behind.
    const t = setTimeout(() => (sheet?.querySelector<HTMLElement>('textarea, input') ?? sheet)?.focus({ preventScroll: true }), 50);
    return () => clearTimeout(t);
  });

  // The on-screen keyboard shrinks the visual viewport; lift the sheet by the part it covers.
  $effect(() => {
    if (!open) {
      kb = 0;
      vvh = null;
      return;
    }
    const vv = window.visualViewport;
    if (!vv) return;
    // Lift only for the keyboard: a pinched-in page (scale ≠ 1) also shrinks the visual viewport.
    const update = () => {
      vvh = Math.round(vv.height);
      kb = vv.scale === 1 ? Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop)) : 0;
    };
    update();
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
    };
  });

  function keydown(e: KeyboardEvent) {
    if (open && e.key === 'Escape') onclose();
  }
  function hdown(e: PointerEvent) {
    drag = { y: e.clientY, dy: 0 };
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
  }
  function hmove(e: PointerEvent) {
    if (drag) drag.dy = Math.max(0, e.clientY - drag.y);
  }
  function hup() {
    if (drag && drag.dy > 40) onclose();
    drag = null;
  }
  // The overlay stays up until the whole tap (down, up, click) has landed on it, so the click
  // never reaches the board cell underneath; it closes on that click.
  function overlayDown(e: PointerEvent) {
    e.preventDefault();
    e.stopPropagation();
  }
  function overlayClick(e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    onclose();
  }
</script>

<svelte:window onkeydown={keydown} />

{#if open && tapToClose}
  <div class="overlay" onpointerdown={overlayDown} onclick={overlayClick} aria-hidden="true" style:bottom="calc(55dvh + {kb}px)"></div>
{/if}
<div
  class="sheet"
  class:open
  class:dragging={drag !== null}
  role="dialog"
  aria-label="Chat"
  tabindex="-1"
  inert={!open}
  bind:this={sheet}
  style:--kb="{kb}px"
  style:--vvh={vvh === null ? undefined : `${vvh}px`}
  style:--drag="{drag?.dy ?? 0}px"
>
  <button
    type="button"
    class="handle"
    aria-label="Close chat"
    onclick={onclose}
    onpointerdown={hdown}
    onpointermove={hmove}
    onpointerup={hup}
    onpointercancel={() => (drag = null)}><span></span></button
  >
  <div class="body">{@render children()}</div>
</div>

<style>
  .overlay {
    position: fixed;
    inset: 0 0 auto 0;
    z-index: 19;
    background: transparent;
  }
  .sheet {
    position: fixed;
    left: 0;
    right: 0;
    bottom: var(--kb, 0px);
    height: min(55dvh, calc(var(--vvh, 100dvh) - 1rem));
    z-index: 20;
    outline: none;
    overscroll-behavior: contain;
    display: flex;
    flex-direction: column;
    background: var(--panel);
    border-top: 1px solid var(--lattice);
    border-radius: 16px 16px 0 0;
    box-shadow: 0 -0.75rem 2rem rgb(0 0 0 / 0.4);
    transform: translateY(calc(100% + var(--kb, 0px) + 2rem));
    transition: transform 200ms ease-out;
  }
  .sheet.open {
    transform: translateY(var(--drag, 0px));
  }
  .sheet:not(.open) {
    box-shadow: none;
  }
  .sheet.dragging {
    transition: none;
  }
  .handle {
    flex: none;
    display: grid;
    place-items: center;
    width: 100%;
    height: 1.75rem;
    padding: 0;
    background: none;
    border: 0;
    touch-action: none;
    cursor: grab;
  }
  .handle span {
    width: 2.5rem;
    height: 0.25rem;
    border-radius: 999px;
    background: var(--lattice);
  }
  .body {
    flex: 1;
    min-height: 0;
    overscroll-behavior: contain;
  }
  .body :global([role='log']),
  .body :global(.tabs) {
    overscroll-behavior: contain;
  }
  @media (prefers-reduced-motion: reduce) {
    .sheet {
      transition: none;
    }
  }
</style>
