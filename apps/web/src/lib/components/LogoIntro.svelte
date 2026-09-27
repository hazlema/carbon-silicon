<script lang="ts">
  /**
   * The wordmark's intro: the periodic table assembles, carbon and silicon hop out and chat, then
   * the camera closes on their corner while the name builds above it. A port of the Foreman's
   * Claude Design mock; the motion is ../intro-timeline.ts, the sound ../intro-audio.ts.
   * Any click, Escape, Enter or Space ends it; `onend` fires once, however it ends.
   * `still` (for reduced motion) shows the finished frame, silent, until it is dismissed.
   */
  import { onMount } from 'svelte';
  import { fade } from 'svelte/transition';
  import { BRAND } from '@cs/shared/brand';
  import { IntroSound, loadSoundPref, saveSoundPref } from '$lib/intro-audio';
  import {
    CELL,
    CELLS,
    HOME,
    INTRO_SECONDS,
    SILICON,
    STAGE_H,
    STAGE_W,
    TABLE_IN_END,
    introFrame,
    stageScale,
    tileIn,
    type Card,
    type Cell,
  } from '$lib/intro-timeline';

  let { onend, still = false }: { onend: () => void; still?: boolean } = $props();

  // svelte-ignore state_referenced_locally
  let T = $state(still ? INTRO_SECONDS : 0);
  const f = $derived(introFrame(T));
  // The table's fade-in is done early; pinning its clock lets the tiles stop re-rendering.
  const tableT = $derived(Math.min(T, TABLE_IN_END));

  let width = $state(1280);
  let height = $state(720);
  const k = $derived(stageScale(width, height));

  const soundAtStart = loadSoundPref();
  let sound = $state(soundAtStart);
  let root: HTMLDivElement;
  let soundButton: HTMLButtonElement | undefined = $state();
  // svelte-ignore state_referenced_locally
  const audio = still ? null : new IntroSound(!soundAtStart);
  let done = false;

  function end() {
    if (done) return;
    done = true;
    audio?.close();
    onend();
  }

  function toggleSound() {
    sound = !sound;
    saveSoundPref(sound);
    audio?.setMuted(!sound, T);
    soundButton?.focus();
  }

  function onKey(e: KeyboardEvent) {
    if (done) return;
    if (e.key === 'Tab') {
      // Two stops inside the dialog: the dialog itself and the sound button.
      e.preventDefault();
      (document.activeElement === soundButton || !soundButton ? root : soundButton).focus();
      return;
    }
    const onButton = e.target === soundButton;
    if (e.key === 'Escape' || (!onButton && (e.key === 'Enter' || e.key === ' '))) {
      e.preventDefault();
      end();
    }
  }

  onMount(() => {
    root.focus();
    // Clicks are listened for here rather than with an onclick attribute: the whole overlay is
    // the click target, and the keyboard equivalents live in onKey on the window.
    const onClick = (e: MouseEvent) => {
      if (!(e.target instanceof Element && e.target.closest('.sound'))) end();
    };
    root.addEventListener('click', onClick);
    window.addEventListener('keydown', onKey);

    if (still) {
      return () => {
        root.removeEventListener('click', onClick);
        window.removeEventListener('keydown', onKey);
      };
    }
    const start = performance.now();
    audio?.play(0);
    let raf = requestAnimationFrame(function tick() {
      T = Math.min(INTRO_SECONDS, (performance.now() - start) / 1000);
      if (T >= INTRO_SECONDS) end();
      else raf = requestAnimationFrame(tick);
    });

    return () => {
      cancelAnimationFrame(raf);
      root.removeEventListener('click', onClick);
      window.removeEventListener('keydown', onKey);
      audio?.close();
    };
  });

  /** Mount the overlay on <body>, above every other layer (banners, the handle gate). */
  function portal(node: HTMLElement) {
    document.body.appendChild(node);
    return { destroy: () => node.remove() };
  }

  const px = (n: number) => `${n.toFixed(2)}px`;
</script>

<svelte:window bind:innerWidth={width} bind:innerHeight={height} />

{#snippet slot(card: Card, appear: number, color: string, num: number, sym: string, cls: string)}
  {@const S = card.size}
  {@const g = f.lit}
  {@const grow = 0.96 + 0.04 * appear}
  <div
    class="slot {cls}"
    style:--c={color}
    style:left={px(card.x)}
    style:top={px(card.y)}
    style:width={px(S)}
    style:height={px(S)}
    style:opacity={appear}
    style:transform="translate(-50%, -50%) rotate({card.rot.toFixed(3)}deg) scale({(f.squash * grow).toFixed(4)}, {(
      (2 - f.squash) *
      grow
    ).toFixed(4)})"
  >
    {#if f.land > 0 && f.land < 1}
      <div class="ring" style:border-radius={px(S * 0.07)} style:transform="scale({1 + f.land * 0.7})" style:opacity={1 - f.land}></div>
    {/if}
    <div
      class="face"
      style:border-radius={px(S * 0.07)}
      style:border-width={px(Math.max(1, S * 0.02))}
      style:border-color="color-mix(in oklab, var(--c) {g * 100}%, var(--tile-line))"
      style:background="color-mix(in oklab, var(--c) {g * 9}%, var(--slot-fill))"
      style:box-shadow="0 0 {px(S * 0.35 * g)} color-mix(in oklab, var(--c) {g * 45 + f.land * (1 - f.land) * 80}%, transparent)"
      style:padding="{px(S * 0.09)} {px(S * 0.1)}"
      style:color="color-mix(in oklab, var(--c) {g * 100}%, var(--tile-ink))"
    >
      <div class="num" style:font-size={px(S * 0.16)}>{num}</div>
      <div class="sym" style:font-size={px(S * 0.4)} style:margin-top={px(S * 0.1)}>{sym}</div>
    </div>
  </div>
{/snippet}

<div
  bind:this={root}
  use:portal
  class="intro"
  role="dialog"
  aria-modal="true"
  aria-label={BRAND.name}
  tabindex="-1"
  out:fade={{ duration: 260 }}
>
  <div class="stage" aria-hidden="true" style:transform="translate(-50%, -50%) scale({k})">
    <div
      class="camera"
      style:transform="translate({px(STAGE_W / 2 - f.focusX * f.zoom)}, {px(STAGE_H / 2 - f.focusY * f.zoom)}) scale({f.zoom.toFixed(4)})"
    >
      <div class="table" style:opacity={f.othersOpacity}>
        {#each CELLS as cell (cell.z)}
          {#if !cell.keep}{@render tile(cell, tileIn(cell, tableT))}{/if}
        {/each}
      </div>
      <div class="table" style:opacity={f.keepOpacity}>
        {#each CELLS as cell (cell.z)}
          {#if cell.keep}{@render tile(cell, tileIn(cell, tableT))}{/if}
        {/each}
      </div>
      {#if f.ghost > 0}
        <div class="ghost c" style:left={px(HOME.C[0] - CELL / 2)} style:top={px(HOME.C[1] - CELL / 2)} style:opacity={f.ghost}></div>
        <div class="ghost si" style:left={px(HOME.Si[0] - CELL / 2)} style:top={px(HOME.Si[1] - CELL / 2)} style:opacity={f.ghost}></div>
      {/if}
    </div>

    {@render slot(f.c, f.cAppear, 'var(--carbon)', 6, 'C', 'c')}
    {@render slot(f.si, f.siAppear, 'var(--silicon)', 14, 'Si', 'si')}

    <div class="wordmark">
      <span class="w-c" style:opacity={f.wordmark} style:transform="translateY({px((1 - f.wordmark) * 14)})">Carbon</span>
      <span class="w-amp" style:opacity={f.wordmark}>&amp;</span>
      <span class="w-si" style:opacity={f.silicon} style:transform="translateY({px((1 - f.silicon) * 14)})"
        >{SILICON.slice(0, f.letters)}<span class="unset">{SILICON.slice(f.letters)}</span></span
      >
    </div>

    {#if f.cBubble > 0.001}
      <div class="bubble left" style:left={px(f.c.x - 60)} style:top={px(f.c.y - 100)} style:transform="translateY(-100%) scale({f.cBubble})">
        <div class="say c">wanna play?</div>
      </div>
    {/if}
    {#if f.typing > 0.001}
      <div class="bubble right" style:right={px(STAGE_W - f.si.x - 60)} style:top={px(f.si.y - 100)} style:transform="translateY(-100%) scale({f.typing})">
        <div class="say typing">
          {#each [0, 1, 2] as i}
            <span class="dot" style:transform="translateY({px(Math.sin(T * 14 - i * 0.9) * 3)})"></span>
          {/each}
        </div>
      </div>
    {/if}
    {#if f.siBubble > 0.001}
      <div class="bubble right" style:right={px(STAGE_W - f.si.x - 60)} style:top={px(f.si.y - 100)} style:transform="translateY(-100%) scale({f.siBubble})">
        <div class="say si">ALWAYS.</div>
      </div>
    {/if}
  </div>

  {#if !still}<button
    bind:this={soundButton}
    type="button"
    class="sound"
    aria-label="Sound"
    aria-pressed={sound}
    title={sound ? 'Sound on' : 'Sound off'}
    onclick={toggleSound}
  >
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <path d="M4 9h4l5-4v14l-5-4H4z" fill="currentColor" />
      {#if sound}
        <path d="M16 9a4 4 0 0 1 0 6M18.5 6.5a7.5 7.5 0 0 1 0 11" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
      {:else}
        <path d="M16.5 9.5l5 5m0-5l-5 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
      {/if}
    </svg>
  </button>{/if}
</div>

{#snippet tile(cell: Cell, a: number)}
  <div class="tile" style:left="{cell.x}px" style:top="{cell.y}px" style:opacity={a} style:transform="translateY({px((1 - a) * 8)})">
    <div class="num">{cell.z}</div>
    <div class="sym">{cell.sym}</div>
  </div>
{/snippet}

<style>
  .intro {
    /* The dim tile, in the site's palette (the mock's slate greys, retinted to --dust/--panel). */
    --tile-line: color-mix(in oklab, var(--fog) 13%, transparent);
    --tile-fill: color-mix(in oklab, var(--panel) 55%, transparent);
    --slot-fill: color-mix(in oklab, var(--panel) 90%, transparent);
    --tile-ink: color-mix(in oklab, var(--dust) 70%, var(--ink-deep));

    position: fixed;
    inset: 0;
    z-index: 100;
    overflow: hidden;
    background: radial-gradient(ellipse at 50% 45%, color-mix(in oklab, var(--panel) 60%, var(--ink-deep)) 0%, var(--ink-deep) 70%);
    cursor: pointer;
    user-select: none;
    -webkit-user-select: none;
  }
  .intro:focus {
    outline: none;
  }
  .stage {
    position: absolute;
    left: 50%;
    top: 50%;
    width: 1280px;
    height: 720px;
    font-family: var(--font-silicon);
  }
  .camera {
    position: absolute;
    left: 0;
    top: 0;
    transform-origin: 0 0;
  }
  .table {
    position: absolute;
    inset: 0;
  }
  .tile,
  .ghost {
    position: absolute;
    width: 58px;
    height: 58px;
    border-radius: 4px;
  }
  .tile {
    padding: 5px 6px;
    border: 1px solid var(--tile-line);
    background: var(--tile-fill);
    color: var(--tile-ink);
    line-height: 1;
  }
  .tile .num {
    font-size: 9px;
  }
  .tile .sym {
    font-size: 20px;
    margin-top: 7px;
  }
  .ghost {
    border: 1px dashed var(--carbon);
  }
  .ghost.si {
    border-color: var(--silicon);
  }

  .slot {
    position: absolute;
  }
  .ring {
    position: absolute;
    inset: 0;
    border: 2px solid var(--c);
  }
  .face {
    position: absolute;
    inset: 0;
    border-style: solid;
    line-height: 1;
  }
  .slot .sym {
    font-weight: 600;
  }
  .slot.c .sym {
    font-family: var(--font-carbon);
    font-style: italic;
  }

  .wordmark {
    position: absolute;
    left: 0;
    right: 0;
    top: 150px;
    display: flex;
    justify-content: center;
    align-items: baseline;
    gap: 14px;
    white-space: nowrap;
    line-height: 1.2;
  }
  .wordmark span {
    display: inline-block;
  }
  .w-c {
    font-family: var(--font-carbon);
    font-style: italic;
    font-weight: 500;
    font-size: 64px;
    color: var(--carbon);
  }
  .w-amp {
    font-family: var(--font-ui);
    font-size: 34px;
    color: var(--dust);
  }
  .w-si {
    font-family: var(--font-silicon);
    font-weight: 600;
    font-size: 56px;
    color: var(--silicon);
  }
  .unset {
    opacity: 0;
  }

  .bubble {
    position: absolute;
  }
  .bubble.left {
    transform-origin: 0 100%;
  }
  .bubble.right {
    transform-origin: 100% 100%;
  }
  .say {
    white-space: nowrap;
    padding: 14px 22px;
    border-radius: 22px;
    line-height: 1.2;
  }
  .say.c {
    background: var(--carbon);
    color: color-mix(in oklab, var(--carbon) 16%, black);
    font-family: var(--font-carbon);
    font-style: italic;
    font-weight: 500;
    font-size: 34px;
    border-bottom-left-radius: 4px;
  }
  .say.si,
  .say.typing {
    border-bottom-right-radius: 4px;
  }
  .say.si {
    background: var(--silicon);
    color: color-mix(in oklab, var(--silicon) 14%, black);
    font-weight: 600;
    font-size: 28px;
    letter-spacing: 0.04em;
  }
  .say.typing {
    display: flex;
    gap: 6px;
    padding: 18px 24px;
    background: color-mix(in oklab, var(--silicon) 14%, transparent);
    border: 1.5px solid var(--silicon);
  }
  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--silicon);
  }

  .sound {
    position: absolute;
    top: max(0.75rem, env(safe-area-inset-top));
    right: max(0.75rem, env(safe-area-inset-right));
    display: grid;
    place-items: center;
    width: 2.5rem;
    height: 2.5rem;
    padding: 0;
    border-radius: 50%;
    border: 1px solid var(--lattice);
    background: color-mix(in oklab, var(--panel) 80%, transparent);
    color: var(--fog);
  }
  .sound:hover,
  .sound[aria-pressed='true'] {
    color: var(--chalk);
  }
  .sound:hover {
    border-color: var(--fog);
  }
</style>
