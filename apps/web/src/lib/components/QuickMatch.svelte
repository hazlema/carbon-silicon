<script lang="ts">
  import { onMount } from 'svelte';
  import type { GameInfo } from '@cs/shared/protocol';
  import { live } from '$lib/live.svelte';
  import { loadPick, playable, randomGame, remembered, savePick } from '$lib/play';
  import { tableApi } from '$lib/table-actions';
  import GameChooser from './GameChooser.svelte';
  import GatheringCard from './GatheringCard.svelte';

  const games = $derived(live.games);
  let pickId = $state<string | null>(null);
  onMount(() => (pickId = loadPick()));
  const game = $derived(remembered(games, pickId));
  // A match of yours started (here or anywhere): the pick was for it, so the panel starts fresh.
  $effect(() => {
    if (live.activeMatch) pickId = null;
  });
  let choosing = $state(false);
  let error = $state('');
  let busy = $state(false);

  function choose(g: GameInfo | null) {
    pickId = g?.id ?? null;
    savePick(pickId);
    error = '';
  }

  async function act(fn: () => Promise<unknown>) {
    error = '';
    busy = true;
    try {
      await fn();
    } catch (e) {
      error = (e as Error).message;
    } finally {
      busy = false;
    }
  }

  const find = (g: GameInfo) => act(() => live.quickMatch(g.id));
  const hostTable = (g: GameInfo) => act(() => tableApi.host(g.id));

  function randomMatch() {
    const g = randomGame(games);
    if (!g) {
      error = 'No game is open to people right now.';
      return;
    }
    choose(g);
    void find(g);
  }

  async function stop() {
    error = '';
    try {
      await live.leaveQueue();
    } catch (e) {
      error = (e as Error).message;
    }
  }

  const players = (g: GameInfo) => (g.minPlayers === g.maxPlayers ? `${g.minPlayers} players` : `${g.minPlayers}–${g.maxPlayers} players`);
</script>

{#if live.myTable?.status === 'forming'}
  <GatheringCard table={live.myTable} />
{:else}
  <section class="play panel" aria-labelledby="play-title">
    <h2 id="play-title">Play</h2>
    {#if game}
      <div class="picked">
        <div class="thumb">{#if game.thumbnail}<img src={game.thumbnail} alt="" />{/if}</div>
        <div>
          <h3>{game.name}</h3>
          <p class="meta">{players(game)}, {game.mode === 'turn' ? 'turn-based' : 'real-time'}. <a href="/games#{game.id}">Rules</a></p>
        </div>
      </div>
    {/if}
    {#if live.activeMatch}
      <a class="btn primary" href={live.myTable ? `/t/${live.myTable.id}` : `/play/${live.activeMatch}`}>Back to your table</a>
    {:else if live.queued}
      <p class="waiting" role="status">Looking for an opponent. If nobody turns up in a few seconds, a house machine sits down.</p>
      <button class="btn" type="button" onclick={stop}>Stop looking</button>
    {:else}
      {@const off = busy || !live.me || live.myStatus !== 'ready'}
      {#if game}
        <div class="actions">
          <button class="btn" type="button" onclick={() => hostTable(game)} disabled={off}>Host a table</button>
          <button class="btn primary" type="button" onclick={() => find(game)} disabled={off}>Find a match</button>
          <button class="btn quiet cancel" type="button" onclick={() => choose(null)} disabled={busy}>Cancel game</button>
        </div>
      {:else}
        <div class="actions">
          <button class="btn primary" type="button" onclick={() => (choosing = true)} disabled={games.length === 0}>Select game</button>
          <button class="btn" type="button" onclick={randomMatch} disabled={off || playable(games).length === 0}>Random match</button>
        </div>
      {/if}
      {#if live.myStatus === 'afk'}<p class="hint">You're set to AFK. Switch to Ready to play.</p>{/if}
    {/if}
    {#if error}<p class="error" role="alert">{error}</p>{/if}
  </section>
{/if}

<GameChooser
  bind:open={choosing}
  {games}
  current={game?.id ?? null}
  onpick={(g) => {
    choose(g);
    choosing = false;
  }}
/>

<style>
  .play {
    padding: 1.1rem 1.25rem 1.25rem;
  }
  h2 {
    margin: 0 0 0.75rem;
    font-size: var(--step--1);
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--fog);
  }
  .picked {
    display: grid;
    grid-template-columns: 5.5rem minmax(0, 1fr);
    align-items: center;
    gap: 0.9rem;
    margin-bottom: 1rem;
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
  h3 {
    margin: 0;
    font-family: var(--font-carbon);
    font-weight: 600;
    font-size: var(--step-2);
    line-height: 1.1;
  }
  .meta {
    margin: 0.25rem 0 0;
    color: var(--fog);
    font-size: var(--step--1);
  }
  .hint,
  .waiting {
    color: var(--fog);
    font-size: var(--step--1);
    margin: 0 0 0.9rem;
  }
  .actions + .hint {
    margin: 0.7rem 0 0;
  }
  .btn {
    width: 100%;
    padding: 0.8rem 1rem;
  }
  .actions {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(8rem, 1fr));
    gap: 0.5rem;
  }
  /* Cancel sits under the two ways to play, across the panel. */
  .actions .cancel {
    grid-column: 1 / -1;
    padding: 0.55rem 1rem;
  }
</style>
