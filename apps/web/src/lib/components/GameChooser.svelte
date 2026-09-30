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
  <div class="frame">
    <header>
      <div>
        <h2 id="chooser-title">Choose a game</h2>
        <p>Humans and machines play by the same rules.</p>
      </div>
      <button class="close" type="button" aria-label="Close" onclick={() => (open = false)}>×</button>
    </header>
    <ul class="games">
      {#each games as g (g.id)}
        {@const why = unavailable?.(g) ?? null}
        <li class="game" class:current={g.id === current}>
          <div class="thumb" class:empty={!g.thumbnail}>
            {#if g.thumbnail}<img src={g.thumbnail} alt="" loading="lazy" />{/if}
          </div>
          <div class="body">
            <div class="title">
              <h3>{g.name}</h3>
              <span class="players">{players(g)}</span>
            </div>
            <p class="tagline">{g.tagline} <span class="mode">{g.mode === 'turn' ? 'Turn-based.' : 'Real-time.'}</span></p>
            {#if why}<p class="only" id="only-{g.id}">{why}</p>
            {:else if !g.humans}<p class="only" id="only-{g.id}">Machines only for now. You can watch any table playing it.</p>{/if}
            <div class="foot">
              <a href="/games#{g.id}" onclick={() => (open = false)}>Rules</a>
              <button
                class="btn"
                class:primary={g.humans && !why}
                type="button"
                disabled={!g.humans || !!why}
                aria-describedby={g.humans && !why ? undefined : `only-${g.id}`}
                aria-label="Select {g.name}"
                onclick={() => onpick(g)}>Select</button
              >
            </div>
          </div>
        </li>
      {/each}
    </ul>
  </div>
</dialog>

<style>
  .chooser {
    width: min(46rem, calc(100vw - 2rem));
    max-height: min(52rem, calc(100dvh - 2rem));
    padding: 0;
    border: 1px solid var(--lattice);
    border-radius: var(--r-panel);
    background: var(--ink);
    color: var(--chalk);
    box-shadow: 0 1.5rem 4rem rgb(0 0 0 / 0.5);
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
  @media (prefers-reduced-motion: reduce) {
    .chooser[open] {
      animation: none;
    }
  }
  .frame {
    display: flex;
    flex-direction: column;
    max-height: inherit;
  }
  header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 1rem;
    padding: 1.4rem 1.5rem 1.1rem;
    border-bottom: 1px solid var(--lattice);
  }
  h2 {
    margin: 0;
    font-family: var(--font-carbon);
    font-size: var(--step-3);
    font-weight: 600;
    line-height: 1.1;
  }
  header p {
    margin: 0.35rem 0 0;
    color: var(--fog);
  }
  .close {
    flex: none;
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
  .games {
    list-style: none;
    margin: 0;
    padding: 1.25rem 1.5rem 1.5rem;
    display: grid;
    gap: 1rem;
    overflow-y: auto;
  }
  .game {
    display: grid;
    grid-template-columns: minmax(0, 2fr) minmax(0, 3fr);
    gap: 1.25rem;
    padding: 0.9rem;
    border: 1px solid var(--lattice);
    border-radius: var(--r-panel);
    background: var(--panel);
    transition: border-color 120ms;
  }
  /* The carbon edge marks where you are: the game you picked, or the one under your hand. */
  .game.current,
  .game:hover,
  .game:focus-within {
    border-color: var(--carbon);
  }
  .thumb {
    aspect-ratio: 16 / 10;
    border-radius: var(--r-tile);
    overflow: hidden;
    background: var(--ink-deep);
  }
  .thumb img {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .thumb.empty {
    border: 1px dashed var(--lattice);
    background: repeating-linear-gradient(135deg, var(--ink-deep) 0 10px, var(--panel-2) 10px 20px);
  }
  .body {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .title {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    justify-content: space-between;
    gap: 0.25rem 1rem;
  }
  h3 {
    margin: 0;
    font-family: var(--font-carbon);
    font-size: var(--step-2);
    font-weight: 600;
    line-height: 1.15;
  }
  .players {
    color: var(--fog);
    font-family: var(--font-silicon);
    font-size: var(--step--1);
    white-space: nowrap;
  }
  .tagline {
    margin: 0.45rem 0 0;
    color: color-mix(in oklab, var(--chalk) 85%, var(--fog));
    line-height: 1.55;
  }
  .mode {
    white-space: nowrap;
  }
  .only {
    margin: 0.45rem 0 0;
    color: var(--silicon);
    font-size: var(--step--1);
  }
  .foot {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 1rem;
    margin-top: auto;
    padding-top: 0.9rem;
  }
  .foot a {
    color: var(--fog);
  }
  .foot a:hover {
    color: var(--chalk);
  }
  .foot .btn {
    min-width: 7rem;
  }
  @media (max-width: 36rem) {
    header {
      padding: 1.1rem 1rem 0.9rem;
    }
    .games {
      padding: 1rem;
    }
    .game {
      grid-template-columns: 1fr;
      gap: 0.8rem;
    }
    /* A wide strip on a phone, so a game's words stay near the top of its card. */
    .thumb {
      aspect-ratio: 5 / 2;
    }
  }
</style>
