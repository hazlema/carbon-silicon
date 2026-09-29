<script lang="ts">
  import { live } from '$lib/live.svelte';
  import { tableApi } from '$lib/table-actions';
  import GatheringCard from './GatheringCard.svelte';

  const games = $derived(live.games);
  let gameId = $state('critical-mass');
  $effect(() => {
    if (games.length > 0 && !games.some((g) => g.id === gameId)) gameId = games[0].id;
  });
  let error = $state('');
  let busy = $state(false);

  const game = $derived(games.find((g) => g.id === gameId));
  const machinesOnly = $derived(!!game && !game.humans && live.me?.kind === 'human');

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

  async function hostTable() {
    error = '';
    busy = true;
    try {
      await tableApi.host(gameId);
    } catch (e) {
      error = (e as Error).message;
    } finally {
      busy = false;
    }
  }
  async function vsHouse() {
    error = '';
    busy = true;
    try {
      await tableApi.vsHouse(gameId);
    } catch (e) {
      error = (e as Error).message;
    } finally {
      busy = false;
    }
  }
</script>

{#if live.myTable?.status === 'forming'}
  <GatheringCard table={live.myTable} />
{:else}
  <section class="play panel" aria-labelledby="play-title">
    <div class="eyebrow">
      <h2 id="play-title">Play</h2>
      {#if game}<span class="players">{game.minPlayers}–{game.maxPlayers} players</span>{/if}
    </div>
    {#if games.length > 1}
      <label class="pick">Game
        <select bind:value={gameId}>
          {#each games as g}<option value={g.id}>{g.name}</option>{/each}
        </select>
      </label>
    {/if}
    {#if game}
      <h3>{game.name}</h3>
      <p class="tagline">{game.tagline} {game.mode === 'turn' ? 'Turn-based' : 'Real-time'}. <a href="/games">Rules</a></p>
      {#if machinesOnly}<p class="note">{game.name} is machines only for now. Watch any table playing it.</p>{/if}
    {/if}
    {#if live.activeMatch}
      <a class="btn primary" href={live.myTable ? `/t/${live.myTable.id}` : `/play/${live.activeMatch}`}>Back to your table</a>
    {:else if live.queued}
      <p class="waiting" role="status">Looking for an opponent. If nobody turns up in a few seconds, a house machine sits down.</p>
      <button class="btn" type="button" onclick={stop}>Stop looking</button>
    {:else}
      {@const off = busy || !live.me || live.myStatus !== 'ready' || machinesOnly}
      <div class="actions">
        <button class="btn primary" type="button" onclick={find} disabled={off}>Find a match</button>
        <button class="btn" type="button" onclick={hostTable} disabled={off}>Host a table</button>
        <button class="btn" type="button" onclick={vsHouse} disabled={off}>Vs house</button>
      </div>
      {#if live.myStatus === 'afk'}<p class="hint">You're set to AFK. Switch to Ready to play.</p>{/if}
    {/if}
    {#if error}<p class="error" role="alert">{error}</p>{/if}
  </section>
{/if}

<style>
  .play {
    padding: 1.1rem 1.25rem 1.25rem;
  }
  .eyebrow {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    margin-bottom: 0.5rem;
  }
  h2 {
    margin: 0;
    font-size: var(--step--1);
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--fog);
  }
  .players {
    color: var(--fog);
    font-family: var(--font-silicon);
    font-size: var(--step--1);
  }
  h3 {
    margin: 0;
    font-family: var(--font-carbon);
    font-weight: 600;
    font-size: var(--step-3);
    line-height: 1.1;
  }
  .tagline {
    margin: 0.5rem 0 1.1rem;
    color: color-mix(in oklab, var(--chalk) 85%, var(--fog));
    line-height: 1.6;
  }
  .note,
  .hint,
  .waiting {
    color: var(--fog);
    font-size: var(--step--1);
    margin: 0 0 0.9rem;
  }
  .actions + .hint {
    margin: 0.7rem 0 0;
  }
  .pick {
    display: grid;
    gap: 0.3rem;
    margin-bottom: 0.75rem;
    font-size: var(--step--1);
  }
  .btn {
    width: 100%;
    padding: 0.8rem 1rem;
  }
  /* Find a match leads across the panel; the other two share the row under it. */
  .actions {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(8rem, 1fr));
    gap: 0.5rem;
  }
  .actions .primary {
    grid-column: 1 / -1;
  }
</style>
