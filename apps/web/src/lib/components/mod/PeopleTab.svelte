<script lang="ts">
  import type { PersonSummary } from '@cs/shared/protocol';
  import { api } from '$lib/api';
  import IdentityChip from '$lib/components/IdentityChip.svelte';
  import { relativeTime } from '$lib/format';
  import PersonDrawer from './PersonDrawer.svelte';

  type Filter = 'all' | 'suspended' | 'muted' | 'mods' | 'guests' | 'agents' | 'house';
  const FILTERS: { id: Filter; label: string }[] = [
    { id: 'all', label: 'Everyone' },
    { id: 'suspended', label: 'Suspended' },
    { id: 'muted', label: 'Muted' },
    { id: 'mods', label: 'Mods' },
    { id: 'guests', label: 'Guests' },
    { id: 'agents', label: 'Agents' },
    { id: 'house', label: 'House' },
  ];
  let q = $state('');
  let filter = $state<Filter>('all');
  let people = $state<PersonSummary[]>([]);
  let error = $state('');
  let selected = $state<string | null>(null);

  async function load(query: string, f: Filter) {
    error = '';
    try {
      people = (await api<{ people: PersonSummary[] }>('GET', `/api/mod/people?q=${encodeURIComponent(query.trim())}&filter=${f}`)).people;
    } catch (e) {
      error = (e as Error).message;
    }
  }
  $effect(() => {
    const query = q;
    const f = filter;
    const t = setTimeout(() => void load(query, f), 200);
    return () => clearTimeout(t);
  });
</script>

<div class="bar">
  <label class="visually-hidden" for="people-q">Search people</label>
  <input id="people-q" type="search" bind:value={q} placeholder="Search by handle" autocomplete="off" />
  <div class="chips" role="group" aria-label="Filter">
    {#each FILTERS as f (f.id)}
      <button type="button" aria-pressed={filter === f.id} onclick={() => (filter = f.id)}>{f.label}</button>
    {/each}
  </div>
</div>
{#if error}<p class="error" role="alert">{error}</p>{/if}

<ul class="people">
  {#each people as p (p.identity.id)}
    <li>
      <button type="button" class="row" onclick={() => (selected = p.identity.handle)}>
        <IdentityChip identity={p.identity} />
        {#if p.sanction}<span class="tag {p.sanction.kind}">{p.sanction.kind === 'mute' ? 'muted' : 'suspended'}</span>{/if}
        {#if p.identity.role !== 'user'}<span class="tag">{p.identity.role}</span>{/if}
        <span class="seen">seen {relativeTime(p.lastSeenAt)}</span>
      </button>
    </li>
  {:else}
    <li class="empty">Nobody matches.</li>
  {/each}
</ul>

{#if selected}
  <PersonDrawer handle={selected} onClose={() => (selected = null)} onChanged={() => load(q, filter)} />
{/if}

<style>
  .bar {
    display: grid;
    gap: 0.7rem;
    margin-bottom: 1rem;
  }
  input[type='search'] {
    width: min(100%, 26rem);
  }
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
  }
  .chips button {
    padding: 0.25rem 0.75rem;
    border: 1px solid var(--lattice);
    border-radius: 999px;
    background: transparent;
    color: var(--fog);
    font-size: var(--step--1);
  }
  .chips button[aria-pressed='true'] {
    background: var(--panel-2);
    color: var(--chalk);
    border-color: var(--fog);
  }
  .people {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 0.35rem;
  }
  .row {
    width: 100%;
    display: flex;
    align-items: baseline;
    gap: 0.6rem;
    padding: 0.55rem 0.8rem;
    border: 1px solid var(--lattice);
    border-radius: var(--r-control);
    background: var(--panel);
    text-align: left;
  }
  .row:hover {
    border-color: var(--fog);
  }
  .tag {
    font-size: var(--step--1);
    color: var(--fog);
    border: 1px solid var(--lattice);
    border-radius: 999px;
    padding: 0 0.5rem;
  }
  .tag.suspend {
    color: var(--danger);
  }
  .tag.mute {
    color: var(--afk);
  }
  .seen {
    margin-left: auto;
    color: var(--dust);
    font-size: var(--step--1);
    white-space: nowrap;
  }
  .empty {
    color: var(--dust);
  }
</style>
