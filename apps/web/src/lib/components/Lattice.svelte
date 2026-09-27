<script lang="ts">
  /**
   * A corner of the periodic table: carbon sits directly above silicon, group 14. It is also the
   * way into the logo intro, which ends by closing in on these very tiles. The intro never
   * navigates, so playing it from a table doesn't pull anyone out of their match.
   */
  import { BRAND } from '@cs/shared/brand';
  import LogoIntro from './LogoIntro.svelte';

  const tiles = [
    { n: 5, sym: 'B' },
    { n: 6, sym: 'C', el: 'c' },
    { n: 7, sym: 'N' },
    { n: 13, sym: 'Al' },
    { n: 14, sym: 'Si', el: 'si' },
    { n: 15, sym: 'P' },
  ];

  let button: HTMLButtonElement;
  let intro = $state<'play' | 'still' | null>(null);

  function open() {
    intro = matchMedia('(prefers-reduced-motion: reduce)').matches ? 'still' : 'play';
  }

  function ended() {
    intro = null;
    button.focus();
  }
</script>

<button
  bind:this={button}
  type="button"
  class="lattice"
  aria-label="Play the {BRAND.name} intro"
  title="Play the intro"
  onclick={open}
>
  {#each tiles as t}
    <span class="tile {t.el ?? ''}" aria-hidden="true">
      <span class="n">{t.n}</span>
      <span class="sym">{t.sym}</span>
    </span>
  {/each}
</button>
{#if intro}<LogoIntro onend={ended} still={intro === 'still'} />{/if}

<style>
  .lattice {
    position: fixed;
    right: clamp(0.75rem, 2vw, 1.5rem);
    bottom: 1.5rem;
    display: grid;
    grid-template-columns: repeat(3, 4rem);
    gap: 0.4rem;
    /* Above the page shell, so it can be clicked; pages that show it keep this corner free. */
    z-index: 2;
    margin: 0;
    padding: 0;
    border: 0;
    background: none;
    color: inherit;
    font: inherit;
    cursor: pointer;
    border-radius: var(--r-tile);
  }
  .lattice:hover .tile,
  .lattice:focus-visible .tile {
    opacity: 1;
  }
  .lattice:hover .tile.c,
  .lattice:focus-visible .tile.c {
    box-shadow: 0 0 2rem color-mix(in oklab, var(--carbon) 45%, transparent);
  }
  .lattice:hover .tile.si,
  .lattice:focus-visible .tile.si {
    box-shadow: 0 0 2rem color-mix(in oklab, var(--silicon) 45%, transparent);
  }
  .lattice:focus-visible {
    outline: 2px solid var(--chalk);
    outline-offset: 4px;
  }
  .tile {
    height: 4rem;
    text-align: left;
    transition: opacity 150ms ease, box-shadow 150ms ease;
    display: grid;
    grid-template-rows: auto 1fr;
    padding: 0.35rem 0.45rem;
    border: 1px solid var(--lattice);
    border-radius: var(--r-tile);
    color: var(--dust);
    opacity: 0.7;
  }
  .n {
    font-family: var(--font-silicon);
    font-size: 0.65rem;
  }
  .sym {
    align-self: end;
    font-family: var(--font-silicon);
    font-size: var(--step-1);
    line-height: 1;
  }
  .tile.c,
  .tile.si {
    opacity: 1;
  }
  .tile.c {
    color: var(--carbon);
    border-color: var(--carbon);
    background: color-mix(in oklab, var(--carbon) 8%, transparent);
    box-shadow: 0 0 1.4rem color-mix(in oklab, var(--carbon) 25%, transparent);
  }
  .tile.c .sym {
    font-family: var(--font-carbon);
    font-style: italic;
    font-weight: 600;
    font-size: var(--step-2);
  }
  .tile.si {
    color: var(--silicon);
    border-color: var(--silicon);
    background: color-mix(in oklab, var(--silicon) 8%, transparent);
    box-shadow: 0 0 1.4rem color-mix(in oklab, var(--silicon) 25%, transparent);
  }
  .tile.si .sym {
    font-weight: 600;
    font-size: var(--step-2);
  }
  /* On narrow screens the page scrolls and the corner would sit on top of content. */
  @media (max-width: 960px) {
    .lattice {
      display: none;
    }
  }
</style>
