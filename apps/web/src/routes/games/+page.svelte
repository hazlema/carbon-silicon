<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { replaceState } from '$app/navigation';
  import type { GameInfo } from '@cs/shared/protocol';
  import { api } from '$lib/api';
  import { md, outline } from '$lib/markdown';

  type Rules = { game: GameInfo; rulesMarkdown: string };
  let games = $state<GameInfo[]>([]);
  let selected = $state<string | null>(null);
  /** Guides fetched so far, by game id: switching back to one doesn't fetch it again. */
  let guides = $state<Record<string, string>>({});
  let error = $state('');
  let tocOpen = $state(false);
  let article: HTMLElement | undefined = $state();

  const game = $derived(games.find((g) => g.id === selected) ?? null);
  const source = $derived(selected ? guides[selected] : undefined);
  const html = $derived(source === undefined ? '' : md(source));
  const sections = $derived(source === undefined ? [] : outline(source));

  const players = (g: GameInfo) => (g.minPlayers === g.maxPlayers ? `${g.minPlayers} players` : `${g.minPlayers}–${g.maxPlayers} players`);
  const fromHash = () => {
    const id = decodeURIComponent(location.hash.slice(1));
    return games.some((g) => g.id === id) ? id : null;
  };

  async function show(id: string) {
    selected = id;
    tocOpen = false;
    if (guides[id] !== undefined) return;
    try {
      const r = await api<Rules>('GET', `/api/games/${id}/rules`);
      guides[id] = r.rulesMarkdown;
    } catch (e) {
      error = (e as Error).message;
    }
  }

  function pick(e: MouseEvent, id: string) {
    e.preventDefault();
    if (id === selected) return;
    replaceState(`#${id}`, {});
    void show(id);
  }

  async function jump(id: string) {
    // On a phone the open index sits above the guide: fold it first, or the scroll aims at where the heading was.
    tocOpen = false;
    await tick();
    article?.querySelector(`#${CSS.escape(id)}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  onMount(() => {
    // Another page's "Rules" link names a game in the hash; anything else (a section link inside a guide) leaves the choice alone.
    const onHash = () => {
      const id = fromHash();
      if (id && id !== selected) void show(id);
    };
    window.addEventListener('hashchange', onHash);
    (async () => {
      try {
        games = (await api<{ games: GameInfo[] }>('GET', '/api/games')).games;
        const linked = fromHash();
        const first = linked ?? games[0]?.id;
        if (first) await show(first);
        // Arrived through a game's "Rules" link: bring its guide into view.
        await tick();
        if (linked) article?.scrollIntoView();
      } catch (e) {
        error = (e as Error).message;
      }
    })();
    return () => window.removeEventListener('hashchange', onHash);
  });
</script>

<svelte:head><title>{game ? `${game.name} rules` : 'Game Rules'}</title></svelte:head>

<div class="page">
  <nav class="games" aria-label="Games">
    {#each games as g (g.id)}
      <a class="game" href="#{g.id}" aria-current={g.id === selected ? 'true' : undefined} onclick={(e) => pick(e, g.id)}>
        <span class="thumb">{#if g.thumbnail}<img src={g.thumbnail} alt="" />{/if}</span>
        <span class="text">
          <span class="name">{g.name}</span>
          <span class="meta">{players(g)} · {g.mode === 'turn' ? 'turn-based' : 'real-time'}</span>
        </span>
      </a>
    {/each}
  </nav>

  {#if game && source !== undefined}
    <div class="layout">
      {#if sections.length}
        <nav class="toc" aria-label="On this page">
          <button type="button" class="toc-toggle" aria-expanded={tocOpen} onclick={() => (tocOpen = !tocOpen)}>On this page</button>
          <p class="toc-title" aria-hidden="true">On this page</p>
          <ol class:open={tocOpen}>
            {#each sections as s (s.id)}
              <li><button type="button" onclick={() => jump(s.id)}>{@html s.html}</button></li>
            {/each}
          </ol>
        </nav>
      {/if}
      <article class="panel prose sheet" id={game.id} bind:this={article}>
        {@html html}
        <p><a class="btn primary" href="/">Play it from the lobby</a></p>
      </article>
    </div>
  {/if}
  {#if error}<p class="error" role="alert">{error}</p>{/if}
</div>

<style>
  .page {
    display: grid;
    gap: 1.25rem;
    padding-top: 1rem;
  }
  .games {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 15rem), 1fr));
    gap: 0.75rem;
  }
  .game {
    display: grid;
    grid-template-columns: 5.5rem minmax(0, 1fr);
    align-items: center;
    gap: 0.9rem;
    padding: 0.6rem;
    border: 1px solid var(--lattice);
    border-radius: var(--r-panel);
    background: color-mix(in oklab, var(--panel) 92%, transparent);
    color: var(--chalk);
    text-decoration: none;
    transition: border-color 120ms;
  }
  /* The carbon edge marks the guide you're reading, or the card under your hand. */
  .game[aria-current='true'],
  .game:hover,
  .game:focus-visible {
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
  .text {
    display: grid;
    gap: 0.15rem;
    min-width: 0;
  }
  .name {
    font-family: var(--font-carbon);
    font-size: var(--step-1);
    font-weight: 600;
    line-height: 1.15;
  }
  .meta {
    color: var(--fog);
    font-size: var(--step--1);
  }
  .layout {
    display: grid;
    gap: 1rem;
    align-items: start;
  }
  article {
    scroll-margin-top: calc(var(--nav-h) + 1rem);
  }
  article :global(:is(h2, h3)) {
    scroll-margin-top: calc(var(--nav-h) + 1rem);
  }
  .toc ol {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .toc li button {
    display: block;
    width: 100%;
    padding: 0.35rem 0.6rem;
    border: 0;
    border-left: 2px solid var(--lattice);
    background: none;
    color: var(--fog);
    font: inherit;
    font-size: var(--step--1);
    line-height: 1.35;
    text-align: left;
    cursor: pointer;
  }
  .toc li button:hover,
  .toc li button:focus-visible {
    color: var(--chalk);
    border-left-color: var(--carbon);
  }
  .toc :global(code) {
    font-family: var(--font-silicon);
    font-size: 0.92em;
  }
  .toc-title {
    margin: 0 0 0.5rem;
    font-size: var(--step--1);
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--fog);
  }
  @media (max-width: 40rem) {
    .game {
      grid-template-columns: 4.25rem minmax(0, 1fr);
      padding: 0.45rem;
    }
  }
  /* Narrow: the index folds into a button above the guide. */
  @media (max-width: 63.99rem) {
    .toc-title {
      display: none;
    }
    .toc-toggle {
      width: 100%;
      padding: 0.6rem 0.9rem;
      border: 1px solid var(--lattice);
      border-radius: var(--r-control);
      background: color-mix(in oklab, var(--panel) 92%, transparent);
      color: var(--chalk);
      font: inherit;
      text-align: left;
      cursor: pointer;
    }
    .toc-toggle::after {
      content: '▾';
      float: right;
      color: var(--fog);
    }
    .toc-toggle[aria-expanded='true']::after {
      content: '▴';
    }
    .toc ol {
      display: none;
      margin-top: 0.5rem;
    }
    .toc ol.open {
      display: block;
    }
  }
  /* Wide: the index sits beside the guide and stays put while you read. */
  @media (min-width: 64rem) {
    /* Index and guide side by side, centred as a pair: the guide keeps its reading width. */
    .layout {
      grid-template-columns: 15rem minmax(0, calc(72ch + 4rem));
      justify-content: center;
      column-gap: 1.5rem;
    }
    .toc {
      position: sticky;
      top: calc(var(--nav-h) + 1rem);
      max-height: calc(100dvh - var(--nav-h) - 2rem);
      overflow-y: auto;
    }
    .toc-toggle {
      display: none;
    }
    article {
      grid-column: 2;
    }
  }
</style>
