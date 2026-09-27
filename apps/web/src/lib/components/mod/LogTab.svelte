<script lang="ts">
  import type { ModLogEntry } from '@cs/shared/protocol';
  import { api } from '$lib/api';
  import { relativeTime } from '$lib/format';
  import { logLine } from '$lib/mod';

  const PAGE = 50;
  let entries = $state<ModLogEntry[]>([]);
  let more = $state(false);
  let error = $state('');

  async function load(before?: number) {
    error = '';
    try {
      const q = before === undefined ? '' : `?before=${before}`;
      const page = (await api<{ entries: ModLogEntry[] }>('GET', `/api/mod/log${q}`)).entries;
      entries = before === undefined ? page : [...entries, ...page];
      more = page.length >= PAGE;
    } catch (e) {
      error = (e as Error).message;
    }
  }
  $effect(() => {
    void load();
  });
</script>

{#if error}<p class="error" role="alert">{error}</p>{/if}
<ol class="log">
  {#each entries as e (e.id)}
    <li>
      <span class="what">{logLine(e)}</span>
      <span class="why">“{e.reason}”</span>
      <time datetime={e.createdAt}>{relativeTime(e.createdAt)}</time>
    </li>
  {:else}
    <li class="empty">Nothing logged yet.</li>
  {/each}
</ol>
{#if more}
  <button class="btn" type="button" onclick={() => load(entries.at(-1)?.id)}>Older</button>
{/if}

<style>
  .log {
    list-style: none;
    margin: 0 0 1rem;
    padding: 0;
    display: grid;
    gap: 0.5rem;
  }
  li {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 0.2rem 1rem;
    padding: 0.6rem 0.8rem;
    border: 1px solid var(--lattice);
    border-radius: var(--r-control);
    background: var(--panel);
  }
  .why {
    grid-column: 1;
    color: var(--fog);
    font-size: var(--step--1);
  }
  time {
    grid-row: 1;
    grid-column: 2;
    color: var(--dust);
    font-size: var(--step--1);
    white-space: nowrap;
  }
  .empty {
    display: block;
    color: var(--dust);
  }
</style>
