<script lang="ts">
  import type { TableInfo } from '@cs/shared/protocol';
  import { live } from '$lib/live.svelte';
  import { tableApi } from '$lib/table-actions';

  let error = $state('');
  const open = $derived(live.tables.filter((t) => t.status === 'forming' && t.open && t.seated.length < t.size && t.id !== live.myTable?.id));
  const playing = $derived(live.tables.filter((t) => t.status === 'playing'));
  const nameOf = (t: TableInfo) => live.games.find((g) => g.id === t.gameId)?.name ?? t.gameId;
  const handles = (t: TableInfo, joiner: string) => t.seated.map((p) => `@${p.handle}`).join(joiner);

  async function sit(id: string) {
    error = '';
    try {
      await tableApi.sit(id);
    } catch (e) {
      error = (e as Error).message;
    }
  }
</script>

{#if open.length > 0 || playing.length > 0}
  <section class="tables panel" aria-labelledby="tables-title">
    <h2 id="tables-title">Tables</h2>
    {#if open.length > 0}
      <h3>Open</h3>
      <ul>
        {#each open as t (t.id)}
          <li>
            <div class="what"><span>{nameOf(t)} · {t.seated.length}/{t.size}</span><span class="who">{handles(t, ', ')}</span></div>
            <button class="btn" type="button" disabled={!!live.myTable || live.myStatus !== 'ready'} onclick={() => sit(t.id)}>Sit</button>
          </li>
        {/each}
      </ul>
    {/if}
    {#if playing.length > 0}
      <h3>Playing now</h3>
      <ul>
        {#each playing as t (t.id)}
          <li>
            <div class="what"><span>{nameOf(t)}</span><span class="who">{handles(t, ' vs ')}</span></div>
            <a class="btn" href="/t/{t.id}">Watch</a>
          </li>
        {/each}
      </ul>
    {/if}
    {#if error}<p class="error" role="alert">{error}</p>{/if}
  </section>
{/if}

<style>
  .tables {
    padding: 1.1rem 1.25rem;
  }
  h2,
  h3 {
    margin: 0 0 0.6rem;
    font-size: var(--step--1);
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--fog);
  }
  h3 {
    margin-top: 0.4rem;
    letter-spacing: 0.04em;
    color: var(--dust);
  }
  ul {
    list-style: none;
    margin: 0 0 0.6rem;
    padding: 0;
    display: grid;
    gap: 0.6rem;
  }
  li {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: center;
    gap: 0.6rem;
  }
  .what {
    display: grid;
    min-width: 0;
  }
  .who {
    color: var(--fog);
    font-size: var(--step--1);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .error {
    margin: 0;
  }
</style>
