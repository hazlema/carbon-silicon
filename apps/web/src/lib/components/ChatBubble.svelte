<script lang="ts">
  import { bubbleSpot, type Spot } from '$lib/bubble';
  import { portal } from '$lib/portal';

  /** A comic-strip speech balloon pointing at `anchor` (a conversation's tab, or the phone's chat button). It lives on
   *  <body>, so neither a scrolling tab row nor a closed (inert) chat sheet hides it; its words are also said once,
   *  politely, through a live region that's always there. No anchor on screen: no balloon (the words are still said). */
  let { text, anchor, place = 'below', onopen }: { text: string; anchor: HTMLElement | null; place?: 'below' | 'left'; onopen: () => void } = $props();

  let el: HTMLButtonElement | undefined = $state();
  let spot = $state<Spot | null>(null);

  // Follow the anchor while the balloon is up: tabs shift as conversations come and go, the window turns.
  $effect(() => {
    if (!text || !anchor) {
      spot = null;
      return;
    }
    const a = anchor;
    const how = place;
    let raf = 0;
    let last = '';
    const step = () => {
      const r = a.getBoundingClientRect();
      const next = r.width === 0 && r.height === 0 ? null : bubbleSpot(r, el?.offsetWidth ?? 0, el?.offsetHeight ?? 0, innerWidth, innerHeight, how);
      const key = JSON.stringify(next);
      if (key !== last) {
        last = key;
        spot = next;
      }
      raf = requestAnimationFrame(step);
    };
    step();
    return () => cancelAnimationFrame(raf);
  });
</script>

<div class="bubble-host" use:portal>
  <p class="visually-hidden" aria-live="polite">{text}</p>
  {#if text && anchor}
    <button
      bind:this={el}
      type="button"
      class="bubble {spot?.side ?? 'top'}"
      data-testid="chat-bubble"
      style:left="{spot?.left ?? 0}px"
      style:top="{spot?.top ?? 0}px"
      style:--tail="{spot?.tail ?? 0}px"
      style:visibility={spot ? 'visible' : 'hidden'}
      onclick={onopen}>{text}</button
    >
  {/if}
</div>

<style>
  .bubble {
    --fill: color-mix(in srgb, var(--playing) 24%, var(--panel-2));
    --edge: color-mix(in srgb, var(--playing) 70%, var(--chalk));
    position: fixed;
    z-index: 25;
    width: max-content;
    max-width: min(20rem, calc(100vw - 1rem));
    padding: 0.55rem 0.95rem;
    border: 1.5px solid var(--edge);
    border-radius: 1.1rem;
    background: var(--fill);
    box-shadow:
      0 0.6rem 1.6rem rgb(0 0 0 / 0.45),
      0 0 0 3px color-mix(in srgb, var(--playing) 14%, transparent);
    color: var(--chalk);
    font: inherit;
    font-size: var(--step--1);
    font-weight: 600;
    line-height: 1.3;
    text-align: left;
    cursor: pointer;
  }
  .bubble:hover {
    --fill: color-mix(in srgb, var(--playing) 34%, var(--panel-2));
  }
  /* The tail: a square turned 45°, half out of the balloon, bordered on its two outer sides only, so its inner half
     covers the balloon's own border there and the two read as one shape. */
  .bubble::after {
    content: '';
    position: absolute;
    width: 0.8rem;
    height: 0.8rem;
    background: var(--fill);
    border: 0 solid var(--edge);
  }
  .bubble.top::after {
    top: -0.42rem;
    left: calc(var(--tail) - 0.4rem);
    border-top-width: 1.5px;
    border-left-width: 1.5px;
    transform: rotate(45deg);
  }
  .bubble.bottom::after {
    bottom: -0.42rem;
    left: calc(var(--tail) - 0.4rem);
    border-bottom-width: 1.5px;
    border-right-width: 1.5px;
    transform: rotate(45deg);
  }
  .bubble.right::after {
    right: -0.42rem;
    top: calc(var(--tail) - 0.4rem);
    border-top-width: 1.5px;
    border-right-width: 1.5px;
    transform: rotate(45deg);
  }
  @media (prefers-reduced-motion: no-preference) {
    .bubble {
      animation: pop 260ms cubic-bezier(0.34, 1.56, 0.64, 1);
    }
    .bubble.top {
      transform-origin: var(--tail) 0;
    }
    .bubble.bottom {
      transform-origin: var(--tail) 100%;
    }
    .bubble.right {
      transform-origin: 100% var(--tail);
    }
  }
  @keyframes pop {
    from {
      opacity: 0;
      transform: scale(0.6);
    }
    to {
      opacity: 1;
      transform: scale(1);
    }
  }
</style>
