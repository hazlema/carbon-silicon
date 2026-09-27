<script lang="ts">
  /** A corner of the periodic table: carbon sits directly above silicon, group 14. */
  const tiles = [
    { n: 5, sym: 'B' },
    { n: 6, sym: 'C', el: 'c' },
    { n: 7, sym: 'N' },
    { n: 13, sym: 'Al' },
    { n: 14, sym: 'Si', el: 'si' },
    { n: 15, sym: 'P' },
  ];
</script>

<div class="lattice" aria-hidden="true">
  {#each tiles as t}
    <div class="tile {t.el ?? ''}">
      <span class="n">{t.n}</span>
      <span class="sym">{t.sym}</span>
    </div>
  {/each}
</div>

<style>
  .lattice {
    position: fixed;
    right: clamp(0.75rem, 2vw, 1.5rem);
    bottom: 1.5rem;
    display: grid;
    grid-template-columns: repeat(3, 4rem);
    gap: 0.4rem;
    pointer-events: none;
    z-index: 0;
  }
  .tile {
    height: 4rem;
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
