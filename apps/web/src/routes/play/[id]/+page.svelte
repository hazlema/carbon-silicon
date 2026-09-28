<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import type { MatchEnvelope } from '@cs/shared/protocol';
  import { api } from '$lib/api';

  let gone = $state(false);

  // Old links: a match lives at its table now.
  $effect(() => {
    const matchId = page.params.id ?? '';
    let alive = true;
    gone = false;
    api<MatchEnvelope>('GET', `/api/matches/${matchId}`)
      .then((e) => {
        if (!alive) return;
        if (e.match.tableId) void goto(`/t/${e.match.tableId}`, { replaceState: true });
        else gone = true;
      })
      .catch(() => alive && (gone = true));
    return () => {
      alive = false;
    };
  });
</script>

<svelte:head><title>Critical Mass</title></svelte:head>

{#if gone}
  <div class="gone panel">
    <h1>This table has been cleared.</h1>
    <p>Finished matches are tidied away after a while.</p>
    <a class="btn primary" href="/">Back to the lobby</a>
  </div>
{:else}
  <p class="loading">Finding the table…</p>
{/if}

<style>
  .gone {
    max-width: 32rem;
    margin: 3rem auto;
    padding: 2rem;
  }
  .gone h1 {
    font-family: var(--font-carbon);
    font-style: italic;
    font-size: var(--step-3);
    margin-top: 0;
  }
  .loading {
    color: var(--fog);
    text-align: center;
    margin-top: 4rem;
  }
</style>
