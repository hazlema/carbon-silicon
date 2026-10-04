<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { replaceState } from '$app/navigation';
  import type { GameInfo } from '@cs/shared/protocol';
  import { api } from '$lib/api';
  import { guideParts, md, outline } from '$lib/markdown';
  import { watchSections } from '$lib/spy';

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
  const parts = $derived(source === undefined ? null : guideParts(source));
  const html = $derived(parts ? md(parts.body) : '');
  /** "Critical Mass — How to Play": the name leads, the rest follows it quietly. */
  const title = $derived.by(() => {
    const [name, ...rest] = (parts?.title ?? game?.name ?? '').split(' — ');
    return { name, rest: rest.join(' — ') };
  });
  let current = $state<string | null>(null);
  const sections = $derived(source === undefined ? [] : outline(source));

  const players = (g: GameInfo) => (g.minPlayers === g.maxPlayers ? `${g.minPlayers} players` : `${g.minPlayers}–${g.maxPlayers} players`);
  const pace = (g: GameInfo) => (g.mode === 'turn' ? 'turn-based' : 'real-time');
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
    const stopSpy = watchSections(() => article?.querySelectorAll<HTMLElement>('.body > h2') ?? [], (id) => (current = id));
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
    return () => {
      window.removeEventListener('hashchange', onHash);
      stopSpy();
    };
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
          <span class="meta">{players(g)}, {pace(g)}</span>
        </span>
      </a>
    {/each}
  </nav>

  {#if game && parts}
    <div class="layout">
      {#if sections.length}
        <nav class="toc" aria-label="On this page">
          <button type="button" class="toc-toggle" aria-expanded={tocOpen} onclick={() => (tocOpen = !tocOpen)}>On this page</button>
          <p class="toc-title" aria-hidden="true">On this page</p>
          <ol class:open={tocOpen}>
            {#each sections as s (s.id)}
              <li><button type="button" aria-current={s.id === current ? 'true' : undefined} onclick={() => jump(s.id)}>{@html s.html}</button></li>
            {/each}
          </ol>
        </nav>
      {/if}
      <article class="panel prose sheet" id={game.id} bind:this={article}>
        <header class="cover">
          {#if parts.cover}<img src={parts.cover.src} alt={parts.cover.alt} />{/if}
          <div class="masthead">
            <div>
              <h1>{title.name}{#if title.rest}{' '}<span class="rest">— {title.rest}</span>{/if}</h1>
              {#if parts.tagline}<p class="pitch">{parts.tagline}</p>{/if}
              <p class="facts">For {players(game)}, {pace(game)}{game.humans ? '' : ', machines only'}.</p>
            </div>
            <a class="btn primary" href="/">Play it from the lobby</a>
          </div>
        </header>
        <div class="body">{@html html}</div>
        <p class="outro"><a class="btn primary" href="/">Play it from the lobby</a></p>
      </article>
    </div>
  {/if}
  {#if error}<p class="error" role="alert">{error}</p>{/if}
</div>

<style>
  .page {
    /* The picker, the index and the guide share one centred width, so their edges line up. */
    --toc: 15rem;
    --gap: 1.5rem;
    --guide: calc(72ch + 4rem);
    display: grid;
    gap: 1.25rem;
    padding-top: 1rem;
  }
  .games {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 0.5rem;
    width: 100%;
    max-width: calc(var(--toc) + var(--gap) + var(--guide));
    margin-inline: auto;
  }
  .game {
    display: grid;
    grid-template-columns: 4.5rem minmax(0, 1fr);
    align-items: center;
    gap: 0.8rem;
    padding: 0.45rem;
    border: 1px solid var(--lattice);
    border-radius: var(--r-control);
    color: var(--fog);
    text-decoration: none;
    transition: border-color 120ms, background-color 120ms;
  }
  .game:hover,
  .game:focus-visible {
    border-color: var(--fog);
    color: var(--chalk);
  }
  /* The guide you're reading: lit like the panel below it, with the carbon edge. */
  .game[aria-current='true'] {
    border-color: var(--carbon);
    background: color-mix(in oklab, var(--panel) 92%, transparent);
    color: var(--chalk);
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
  .game:not([aria-current='true']) .thumb img {
    opacity: 0.7;
  }
  .text {
    display: grid;
    gap: 0.1rem;
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
    scroll-margin-top: 1rem;
    overflow: hidden;
  }
  article :global(:is(h2, h3)) {
    scroll-margin-top: 1rem;
  }

  /* The guide opens like the lid of the game's box: its picture edge to edge, then its name. */
  .cover {
    margin: calc(-1 * var(--pad)) calc(-1 * var(--pad)) 0;
  }
  .cover img {
    width: 100%;
    max-width: none;
    border-radius: 0;
  }
  .masthead {
    display: flex;
    flex-wrap: wrap;
    align-items: end;
    justify-content: space-between;
    gap: 1rem 1.5rem;
    padding: var(--pad) var(--pad) 1.5rem;
    border-bottom: 1px solid var(--lattice);
  }
  .masthead h1 {
    margin: 0;
    font-size: clamp(2rem, 6vw, 2.75rem);
    line-height: 1.05;
    letter-spacing: -0.01em;
  }
  .rest {
    margin-left: 0.3em;
    color: var(--fog);
    font-size: 0.5em;
    font-weight: 400;
    letter-spacing: 0;
    white-space: nowrap;
  }
  .pitch {
    margin: 0.5rem 0 0;
    font-family: var(--font-carbon);
    font-style: italic;
    font-size: var(--step-1);
    line-height: 1.35;
  }
  .facts {
    margin: 0.35rem 0 0;
    color: var(--fog);
    font-size: var(--step--1);
  }
  .masthead .btn {
    flex: none;
  }
  .body {
    padding-top: 1.5rem;
  }
  /* A picture in a guide sits a little apart from the words around it. */
  .body :global(p:has(> img)) {
    margin-block: 1.6em;
  }
  .outro {
    margin: 2.5rem 0 0;
    padding-top: 1.5rem;
    border-top: 1px solid var(--lattice);
  }

  .toc ol {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .toc li button {
    display: block;
    width: 100%;
    padding: 0.35rem 0.75rem;
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
  }
  .toc li button[aria-current='true'] {
    color: var(--chalk);
    font-weight: 600;
    border-left-color: var(--carbon);
  }
  .toc :global(code) {
    font-family: var(--font-silicon);
    font-size: 0.92em;
  }
  .toc-title {
    margin: 0 0 0.5rem;
    padding-left: 0.75rem;
    font-family: var(--font-carbon);
    font-size: var(--step-0);
    font-weight: 600;
    color: var(--chalk);
  }
  /* A phone: three small lids in a row, picture over name. */
  @media (max-width: 40rem) {
    .game {
      grid-template-columns: minmax(0, 1fr);
      gap: 0.4rem;
      padding: 0.35rem 0.35rem 0.5rem;
      text-align: center;
    }
    .name {
      font-size: var(--step-0);
    }
    .meta {
      display: none;
    }
    .masthead .btn {
      width: 100%;
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
    .layout {
      grid-template-columns: var(--toc) minmax(0, var(--guide));
      justify-content: center;
      column-gap: var(--gap);
    }
    .toc {
      position: sticky;
      top: 1rem;
      max-height: calc(100dvh - 2rem);
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
