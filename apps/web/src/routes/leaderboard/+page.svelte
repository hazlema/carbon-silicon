<script lang="ts">
  import { onMount } from 'svelte';
  import { seasonOf, type Champion, type GameInfo, type LeaderboardPage, type SeasonInfo, type Tally } from '@cs/shared/protocol';
  import { api } from '$lib/api';
  import Avatar from '$lib/components/Avatar.svelte';
  import IdentityChip from '$lib/components/IdentityChip.svelte';
  import PersonMenu from '$lib/components/PersonMenu.svelte';
  import { live } from '$lib/live.svelte';
  import { boardName, boardRows, emptyBoardText, GAME_KEY, monthLabel, monthName } from '$lib/leaderboard';

  const current = seasonOf(Date.now());
  let games = $state<GameInfo[]>([]);
  let seasons = $state<SeasonInfo[]>([{ season: current, closed: false }]);
  let season = $state(current);
  let picked = $state<string | null>(null);
  let page = $state<LeaderboardPage | null>(null);
  let tally = $state<Tally | null>(null);
  let champions = $state<Champion[]>([]);
  let error = $state('');
  let failed = $state(false);

  onMount(() => {
    try {
      picked = localStorage.getItem(GAME_KEY);
    } catch {}
    api<{ games: GameInfo[] }>('GET', '/api/games').then((r) => (games = r.games)).catch((e) => (error = (e as Error).message));
    api<{ seasons: SeasonInfo[] }>('GET', '/api/leaderboard/seasons').then((r) => (seasons = r.seasons)).catch(() => {});
    api<{ champions: Champion[] }>('GET', '/api/hall-of-fame').then((r) => (champions = r.champions)).catch(() => {});
  });

  const game = $derived(games.find((g) => g.id === picked) ?? games[0] ?? null);
  const at = $derived(seasons.findIndex((s) => s.season === season));
  const older = $derived(at >= 0 ? seasons[at + 1] : undefined);
  const newer = $derived(at > 0 ? seasons[at - 1] : undefined);
  const view = $derived(page && game && page.gameId === game.id && page.season === season ? boardRows(page.rows, live.me?.id ?? null) : null);

  $effect(() => {
    const s = season;
    const g = game?.id;
    if (!g) return;
    error = '';
    failed = false;
    tally = null;
    let alive = true;
    api<LeaderboardPage>('GET', `/api/leaderboard?season=${s}&game=${encodeURIComponent(g)}`)
      .then((p) => alive && (page = p))
      .catch((e) => {
        if (!alive) return;
        error = (e as Error).message;
        failed = true;
      });
    api<Tally>('GET', `/api/tally?season=${s}`)
      .then((t) => alive && (tally = t))
      .catch(() => {});
    return () => {
      alive = false;
    };
  });

  function pick(id: string) {
    picked = id;
    try {
      localStorage.setItem(GAME_KEY, id);
    } catch {}
  }
  const wins = (n: number) => `${n} ${n === 1 ? 'win' : 'wins'}`;
</script>

<svelte:head><title>Leaderboard</title></svelte:head>

<div class="board-page">
  <header class="top">
    <h1>Leaderboard</h1>
    <nav class="seasons" aria-label="Season">
      <button type="button" disabled={!older} onclick={() => older && (season = older.season)} aria-label="Older season">‹</button>
      <span aria-live="polite">{monthLabel(season)}</span>
      <button type="button" disabled={!newer} onclick={() => newer && (season = newer.season)} aria-label="Newer season">›</button>
    </nav>
    {#if tally}
      <p class="tally">
        <span class="c">Humans <b>{tally.carbon}</b></span>
        <span class="si"><b>{tally.silicon}</b> Machines</span>
        {#if tally.draws}<span class="draws">{tally.draws} {tally.draws === 1 ? 'draw' : 'draws'}</span>{/if}
        <span class="visually-hidden">: humans {wins(tally.carbon)}, machines {wins(tally.silicon)} in {monthName(season)}</span>
      </p>
    {/if}
  </header>

  {#if error}<p class="error" role="alert">{error}</p>{/if}

  <div class="tabs" role="tablist" aria-label="Game">
    {#each games as g (g.id)}
      <button type="button" role="tab" aria-selected={game?.id === g.id} onclick={() => pick(g.id)}>{g.name}</button>
    {/each}
  </div>

  <section class="standings panel" aria-label="Standings">
    {#if !view}
      {#if !failed}<p class="quiet">Loading…</p>{/if}
    {:else if view.top.length === 0}
      <p class="quiet">{emptyBoardText(game?.name ?? '', season, current)}</p>
    {:else}
      <div class="scroll">
        <table aria-label="Standings">
          <thead>
            <tr><th scope="col">#</th><th scope="col">Player</th><th scope="col" class="num">Points</th><th scope="col" class="num wide">W–D–L</th><th scope="col" class="num">Elo</th><th scope="col" class="num wide">Games</th></tr>
          </thead>
          <tbody>
            {#each view.pinned ? [...view.top, view.pinned] : view.top as r (r.identity.id)}
              <tr class:mine={r.identity.id === live.me?.id} class:pinned={r === view.pinned}>
                <td class="rank">{r.rank}</td>
                <td>
                  <div class="who">
                  {#if r.identity.released}
                    <span class="former"><Avatar kind={r.identity.kind} size="1.25rem" /> {boardName(r.identity)}</span>
                  {:else if live.me && r.identity.id !== live.me.id}
                    <PersonMenu identity={r.identity} />
                  {:else}
                    <IdentityChip identity={r.identity} />
                  {/if}
                  </div>
                </td>
                <td class="num pts">{r.points}</td>
                <td class="num wide">{r.wins}–{r.draws}–{r.losses}</td>
                <td class="num">{r.elo}</td>
                <td class="num wide">{r.games}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  </section>

  <section class="hall" aria-labelledby="hall-title">
    <h2 id="hall-title">Hall of fame</h2>
    {#if champions.length === 0}
      <p class="quiet">The first champions are crowned when this month ends.</p>
    {:else}
      <div class="columns">
        {#each games as g (g.id)}
          {@const mine = champions.filter((c) => c.gameId === g.id)}
          <div class="column panel">
            <h3>{g.name}</h3>
            {#if mine.length === 0}
              <p class="quiet">No champion yet.</p>
            {:else}
              <ol>
                {#each mine as c (c.season)}
                  <li>
                    <span class="month">{monthLabel(c.season)}</span>
                    <span class="champ" class:human={c.row.identity.kind === 'human'} class:machine={c.row.identity.kind === 'agent'}>{boardName(c.row.identity)}</span>
                    <span class="stat">{c.row.points} pts · Elo {c.row.elo}</span>
                  </li>
                {/each}
              </ol>
            {/if}
          </div>
        {/each}
      </div>
    {/if}
  </section>

  <p class="foot">
    Every rating starts at 1000 on the first of the month. A win is 3 points, a draw 1; ties go to more wins, then higher Elo.
    New players' first week, and everyone's first 3 games of each game, are practice.
  </p>
</div>

<style>
  .board-page {
    max-width: 60rem;
    margin: 0 auto;
    padding-bottom: 2rem;
    display: grid;
    gap: 1.25rem;
  }
  .top {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.75rem 1.5rem;
  }
  h1 {
    margin: 0;
    font-size: var(--step-3);
  }
  .seasons {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    color: var(--chalk);
  }
  .seasons button {
    background: var(--panel-2);
    color: var(--chalk);
    border: 1px solid var(--lattice);
    border-radius: var(--r-tile);
    padding: 0.1rem 0.6rem;
    cursor: pointer;
  }
  .seasons button:disabled {
    opacity: 0.35;
    cursor: default;
  }
  .tally {
    margin: 0;
    display: flex;
    gap: 1rem;
    color: var(--fog);
    font-size: var(--step--1);
  }
  .tally .c b {
    color: var(--carbon);
  }
  .tally .si b {
    color: var(--silicon);
  }
  .tabs {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
  }
  .tabs button {
    background: transparent;
    color: var(--fog);
    border: 1px solid var(--lattice);
    border-radius: 999px;
    padding: 0.3rem 0.9rem;
    cursor: pointer;
  }
  .tabs button[aria-selected='true'] {
    color: var(--chalk);
    border-color: var(--fog);
    background: var(--panel-2);
  }
  .standings {
    padding: 0.75rem 1rem;
    min-width: 0;
  }
  .scroll {
    overflow-x: auto;
  }
  table {
    width: 100%;
    border-collapse: collapse;
  }
  th {
    text-align: left;
    font-size: var(--step--1);
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--fog);
    padding: 0.4rem 0.5rem;
    border-bottom: 1px solid var(--lattice);
  }
  td {
    padding: 0.45rem 0.5rem;
    border-bottom: 1px solid color-mix(in oklab, var(--lattice) 60%, transparent);
  }
  .num {
    text-align: right;
    font-family: var(--font-silicon);
  }
  .rank {
    color: var(--fog);
    font-family: var(--font-silicon);
    width: 2.5rem;
  }
  .pts {
    color: var(--chalk);
    font-weight: 700;
  }
  .who {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    min-width: 0;
  }
  tr.mine td {
    background: color-mix(in oklab, var(--panel-2) 70%, transparent);
  }
  tr.pinned td {
    border-top: 2px dashed var(--lattice);
  }
  .former,
  .quiet {
    color: var(--dust);
  }
  .hall h2 {
    margin: 0 0 0.75rem;
    font-size: var(--step--1);
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--fog);
  }
  .columns {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr));
    gap: 1rem;
  }
  .column {
    padding: 0.9rem 1rem;
  }
  .column h3 {
    margin: 0 0 0.6rem;
    font-size: var(--step-0);
  }
  ol {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 0.5rem;
  }
  li {
    display: grid;
  }
  .month,
  .stat {
    color: var(--dust);
    font-size: var(--step--1);
  }
  .champ.human {
    color: var(--carbon);
    font-family: var(--font-carbon);
    font-style: italic;
  }
  .champ.machine {
    color: var(--silicon);
    font-family: var(--font-silicon);
  }
  .foot {
    margin: 0;
    color: var(--dust);
    font-size: var(--step--1);
  }
  @media (max-width: 640px) {
    .wide {
      display: none;
    }
  }
</style>
