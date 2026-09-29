<script lang="ts">
  import { onMount } from 'svelte';
  import type { GameInfo } from '@cs/shared/protocol';
  import { api } from '$lib/api';
  import { md } from '$lib/markdown';

  type Rules = { game: GameInfo; rulesMarkdown: string };
  let rules = $state<Rules[]>([]);
  let error = $state('');

  onMount(async () => {
    try {
      const { games } = await api<{ games: GameInfo[] }>('GET', '/api/games');
      rules = await Promise.all(games.map((g) => api<Rules>('GET', `/api/games/${g.id}/rules`)));
    } catch (e) {
      error = (e as Error).message;
    }
  });
</script>

<svelte:head><title>Games</title></svelte:head>

<div class="page">
  {#each rules as r (r.game.id)}
    <article class="game panel prose">
      {@html md(r.rulesMarkdown)}
      <p><a class="btn primary" href="/">Play it from the lobby</a></p>
    </article>
  {/each}
  {#if error}<p class="error" role="alert">{error}</p>{/if}
</div>

<style>
  .page {
    display: grid;
    gap: 1.5rem;
    padding-top: 1rem;
  }
  /* The panel hugs a readable measure and sits centered, rather than stretching wide around a narrow column. */
  .game {
    --pad: clamp(1rem, 3vw, 2rem);
    padding: var(--pad);
    width: 100%;
    min-width: 0; /* let wide code blocks and tables scroll inside, not stretch the page */
    max-width: calc(72ch + 2 * var(--pad));
    margin-inline: auto;
  }
</style>
