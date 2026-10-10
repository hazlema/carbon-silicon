<script lang="ts">
  import type { GameInfo } from '@cs/shared/protocol';

  let {
    open = $bindable(false),
    games,
    current = null,
    onpick,
    unavailable,
  }: {
    open: boolean;
    games: GameInfo[];
    current?: string | null;
    onpick: (game: GameInfo) => void;
    /** A reason this game can't be picked right now, shown in place of the "Machines only" note. */
    unavailable?: (g: GameInfo) => string | null;
  } = $props();

  let dialog: HTMLDialogElement | undefined = $state();

  // A native modal dialog: focus stays inside, Esc closes it, and it sits above everything.
  $effect(() => {
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  });

  const players = (g: GameInfo) => (g.minPlayers === g.maxPlayers ? `${g.minPlayers} players` : `${g.minPlayers}–${g.maxPlayers} players`);
</script>

<dialog
  bind:this={dialog}
  class="chooser"
  aria-labelledby="chooser-title"
  onclose={() => (open = false)}
  onclick={(e) => {
    // A click on the backdrop lands on the dialog itself; clicks inside land on its children.
    if (e.target === dialog) open = false;
  }}
>
  <header>
    <h2 id="chooser-title">Choose a game</h2>
    <p>Humans and machines play by the same rules.</p>
    <button class="close" type="button" aria-label="Close" onclick={() => (open = false)}>×</button>
  </header>
  <!-- A shelf of game boxes: the art is the tile, and the whole tile picks the game. -->
  <ul class="shelf">
    {#each games as g (g.id)}
      {@const why = unavailable?.(g) ?? (g.humans ? null : 'Machines only for now. You can watch any table playing it.')}
      <li class="game" class:current={g.id === current} class:off={!!why}>
        <div class="art" class:empty={!g.thumbnail}>
          {#if g.thumbnail}<img src={g.thumbnail} alt="" loading="lazy" />{/if}
        </div>
        <div class="words">
          <h3>{g.name}</h3>
          <p class="tagline" id="about-{g.id}">{g.tagline}</p>
        </div>
        <!-- Stretched over the whole box (the Rules link sits above it), so the box is the button. -->
        <button
          class="pick"
          type="button"
          disabled={!!why}
          aria-label="Select {g.name}"
          aria-describedby={why ? `only-${g.id}` : `about-${g.id}`}
          onclick={() => onpick(g)}
        ></button>
        <p class="meta">
          <span class="facts"><span>{players(g)},</span> <span>{g.mode === 'turn' ? 'turn-based' : 'real-time'}</span></span>
          <a href="/games#{g.id}" onclick={() => (open = false)}>Rules</a>
        </p>
        {#if why}<p class="only" id="only-{g.id}">{why}</p>{/if}
      </li>
    {/each}
  </ul>
</dialog>

<style>
  .chooser {
    /* Two boxes a row; as wide as the screen's height lets two rows of them fit (a laptop never scrolls). */
    width: max(min(52rem, calc(100vw - 2rem), calc(2 * (100dvh - 25rem))), min(30rem, calc(100vw - 2rem)));
    max-height: calc(100dvh - 2rem);
    padding: 0;
    border: 1px solid var(--lattice);
    border-radius: var(--r-panel);
    background: var(--ink);
    color: var(--chalk);
    box-shadow: 0 1.5rem 4rem rgb(0 0 0 / 0.5);
    /* One scroll at most, the dialog's own, and only when the screen is too short for the shelf. */
    overflow-y: auto;
  }
  .chooser::backdrop {
    background: color-mix(in oklab, var(--ink-deep) 72%, transparent);
    backdrop-filter: blur(3px);
  }
  .chooser[open] {
    animation: arrive 160ms ease-out;
  }
  @keyframes arrive {
    from {
      opacity: 0;
      transform: translateY(0.5rem) scale(0.985);
    }
  }
  header {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: baseline;
    column-gap: 1rem;
    padding: 1.15rem 1.25rem 0;
  }
  h2 {
    margin: 0;
    font-family: var(--font-carbon);
    font-size: var(--step-3);
    font-weight: 600;
    line-height: 1.1;
  }
  header p {
    grid-row: 2;
    margin: 0.3rem 0 0;
    color: var(--fog);
  }
  .close {
    grid-row: 1 / span 2;
    grid-column: 2;
    align-self: start;
    width: 2.5rem;
    height: 2.5rem;
    border: 0;
    border-radius: var(--r-control);
    background: transparent;
    color: var(--fog);
    font-size: 1.6rem;
    line-height: 1;
    cursor: pointer;
  }
  .close:hover {
    color: var(--chalk);
    background: var(--panel);
  }
  .shelf {
    list-style: none;
    margin: 0;
    padding: 1.1rem 1.25rem 1.25rem;
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 1rem;
  }
  .game {
    position: relative;
    display: flex;
    flex-direction: column;
    min-width: 0;
    border: 1px solid var(--lattice);
    border-radius: var(--r-panel);
    background: var(--panel);
    overflow: hidden;
    transition: border-color 120ms;
  }
  /* The carbon edge marks where you are: the game you picked, or the one under your hand. */
  .game.current,
  .game:not(.off):hover,
  .game:focus-within {
    border-color: var(--carbon);
  }
  .pick {
    position: absolute;
    inset: 0;
    z-index: 1;
    padding: 0;
    border: 0;
    border-radius: inherit;
    background: none;
    cursor: pointer;
  }
  .pick:focus-visible {
    outline: 2px solid var(--carbon);
    outline-offset: -2px;
  }
  .pick:disabled {
    cursor: not-allowed;
  }
  .art {
    display: block;
    aspect-ratio: 2 / 1;
    overflow: hidden;
    background: var(--ink-deep);
  }
  .art img {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: cover;
    filter: brightness(0.82) saturate(0.95);
    transition:
      filter 160ms ease-out,
      transform 220ms ease-out;
  }
  /* The one flourish: the box lights up under your hand. */
  .game:not(.off):hover img,
  .game:has(.pick:focus-visible) img,
  .current .art img {
    filter: none;
  }
  .game:not(.off):hover img,
  .game:has(.pick:focus-visible) img {
    transform: scale(1.03);
  }
  .off .art img {
    filter: grayscale(0.85) brightness(0.55);
  }
  .art.empty {
    background: repeating-linear-gradient(135deg, var(--ink-deep) 0 10px, var(--panel-2) 10px 20px);
  }
  .words {
    display: block;
    padding: 0.75rem 0.9rem 0;
  }
  h3 {
    margin: 0;
    font-family: var(--font-carbon);
    font-size: var(--step-2);
    font-weight: 600;
    line-height: 1.15;
  }
  .tagline {
    margin: 0.3rem 0 0;
    color: color-mix(in oklab, var(--chalk) 85%, var(--fog));
    line-height: 1.45;
  }
  .meta {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: 1rem;
    margin: auto 0 0;
    padding: 0.6rem 0.9rem 0.8rem;
    color: var(--fog);
    font-size: var(--step--1);
  }
  .facts {
    font-family: var(--font-silicon);
  }
  /* On a narrow box the count and the pace wrap as two whole phrases, never mid-word. */
  .facts > span {
    white-space: nowrap;
  }
  .meta a {
    position: relative;
    z-index: 2;
    color: var(--fog);
  }
  .meta a:hover {
    color: var(--chalk);
  }
  .only {
    margin: 0;
    padding: 0 0.9rem 0.8rem;
    color: var(--silicon);
    font-size: var(--step--1);
  }
  @media (prefers-reduced-motion: reduce) {
    .chooser[open] {
      animation: none;
    }
    .art img {
      transition: none;
    }
    .game img {
      transform: none !important;
    }
  }
  /* A phone: two boxes a row, the art squarer and the words smaller, so all four fit on one screen. */
  @media (max-width: 36rem) {
    header {
      padding: 1rem 1rem 0;
    }
    .shelf {
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 0.65rem;
      padding: 0.9rem 1rem 1rem;
    }
    .art {
      aspect-ratio: 4 / 3;
    }
    .words {
      padding: 0.55rem 0.65rem 0;
    }
    h3 {
      font-size: var(--step-1);
    }
    .tagline {
      font-size: var(--step--1);
    }
    .meta {
      flex-wrap: wrap;
      gap: 0.2rem 0.6rem;
      padding: 0.45rem 0.65rem 0.65rem;
    }
  }
</style>
