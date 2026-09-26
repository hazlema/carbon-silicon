<script lang="ts">
  import { onMount } from 'svelte';
  import type { GameInfo } from '@cs/shared/protocol';
  import { api } from '$lib/api';
  import { live } from '$lib/live.svelte';

  let games = $state<GameInfo[]>([]);
  let gameId = $state('critical-mass');
  let error = $state('');
  let busy = $state(false);

  onMount(async () => {
    try {
      games = (await api<{ games: GameInfo[] }>('GET', '/api/games')).games;
      if (games.length > 0 && !games.some((g) => g.id === gameId)) gameId = games[0].id;
    } catch (e) {
      error = (e as Error).message;
    }
  });

  const game = $derived(games.find((g) => g.id === gameId));

  async function find() {
    error = '';
    busy = true;
    try {
      await live.quickMatch(gameId);
    } catch (e) {
      error = (e as Error).message;
    } finally {
      busy = false;
    }
  }

  async function stop() {
    error = '';
    try {
      await live.leaveQueue();
    } catch (e) {
      error = (e as Error).message;
    }
  }
</script>

<section class="play panel" aria-labelledby="play-title">
  <h2 id="play-title">Play</h2>
  {#if games.length > 1}
    <label class="pick">Game
      <select bind:value={gameId}>
        {#each games as g}<option value={g.id}>{g.name}</option>{/each}
      </select>
    </label>
  {/if}
  {#if game}
    <h3>{game.name}</h3>
    <p class="tagline">{game.tagline}</p>
    <p class="facts">{game.mode === 'turn' ? 'Turn-based' : 'Real-time'}, {game.minPlayers}–{game.maxPlayers} players. <a href="/games">Rules</a></p>
  {/if}
  {#if live.activeMatch}
    <a class="btn primary" href="/play/{live.activeMatch}">Back to your table</a>
  {:else if live.queued}
    <p class="waiting" role="status">Looking for an opponent. If nobody turns up in a few seconds, a house machine sits down.</p>
    <button class="btn" type="button" onclick={stop}>Stop looking</button>
  {:else}
    <button class="btn primary" type="button" onclick={find} disabled={busy || !live.me || live.myStatus !== 'ready'}>Find a match</button>
    {#if live.myStatus === 'afk'}<p class="hint">You're set to AFK. Switch to Ready to play.</p>{/if}
  {/if}
  {#if error}<p class="error" role="alert">{error}</p>{/if}
</section>

<style>
  .play {
    padding: 1rem;
  }
  h2 {
    margin: 0 0 0.6rem;
    font-size: var(--step-0);
    font-weight: 600;
    color: var(--fog);
  }
  h3 {
    margin: 0;
    font-family: var(--font-carbon);
    font-weight: 600;
    font-size: var(--step-2);
  }
  .tagline {
    margin: 0.2rem 0 0.4rem;
  }
  .facts,
  .hint,
  .waiting {
    color: var(--fog);
    font-size: var(--step--1);
    margin: 0 0 0.9rem;
  }
  .pick {
    display: grid;
    gap: 0.3rem;
    margin-bottom: 0.75rem;
    font-size: var(--step--1);
  }
  .btn {
    width: 100%;
  }
</style>
