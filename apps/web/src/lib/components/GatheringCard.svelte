<script lang="ts">
  import type { TableInfo } from '@cs/shared/protocol';
  import { live } from '$lib/live.svelte';
  import { tableApi } from '$lib/table-actions';
  import { gatherNote, secondsLeft } from '$lib/tables';
  import IdentityChip from './IdentityChip.svelte';

  let { table, compact = false }: { table: TableInfo; compact?: boolean } = $props();

  let error = $state('');
  let busy = $state(false);
  let now = $state(Date.now());
  $effect(() => {
    const t = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(t);
  });

  const game = $derived(live.games.find((g) => g.id === table.gameId));
  const name = $derived(game?.name ?? table.gameId);
  /** Lightline and its kind: Start fills the empty seats with house bots, so a host alone can start. */
  const fills = $derived(!!game?.houseFill);
  const amHost = $derived(live.me?.id === table.host.id);
  const canStart = $derived(amHost && table.status === 'forming' && (fills || table.seated.length >= table.minPlayers));
  const room = $derived(table.seated.length + table.invites.length < table.size);

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
</script>

<section class="card panel" class:compact aria-labelledby="gather-{table.id}">
  <h2 id="gather-{table.id}">{name} <span class="state">· gathering</span></h2>
  {#if compact}
    <p class="count">{table.seated.length}/{table.size} seated</p>
  {:else}
    <ul>
      {#each table.seated as p (p.id)}
        <li>
          <IdentityChip identity={p} badge={false} />
          <span class="state">{p.id === table.host.id ? 'host' : 'seated'}</span>
          {#if amHost && p.id !== table.host.id}
            <button class="x" type="button" aria-label="Remove @{p.handle}" onclick={() => act(() => tableApi.remove(table.id, p.handle))}>×</button>
          {/if}
        </li>
      {/each}
      {#each table.invites as i (i.id)}
        <li>
          <IdentityChip identity={i.to} badge={false} />
          <span class="state">invited {secondsLeft(i.expiresAt, now)}s</span>
          {#if amHost}
            <button class="x" type="button" aria-label="Withdraw @{i.to.handle}'s invite" onclick={() => act(() => tableApi.remove(table.id, i.to.handle))}>×</button>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
  <p class="note" role="status">{gatherNote(table, name)}</p>
  {#if amHost && room && !compact}<p class="hint">Click a name to invite them.{#if fills} Empty seats fill with house bots when you start.{/if}</p>{/if}
  <div class="row">
    {#if amHost}
      <button class="btn primary" type="button" disabled={!canStart || busy} onclick={() => act(() => tableApi.start(table.id))}>Start</button>
      {#if !compact}
        <label class="open">
          <input type="checkbox" checked={table.open} onchange={(e) => act(() => tableApi.setOpen(table.id, e.currentTarget.checked))} />
          Open to anyone
        </label>
      {/if}
      <button class="btn quiet" type="button" disabled={busy} onclick={() => act(() => tableApi.disband(table.id))}>Cancel</button>
    {:else}
      <button class="btn quiet" type="button" disabled={busy} onclick={() => act(() => tableApi.leave(table.id))}>Leave</button>
    {/if}
  </div>
  {#if error}<p class="error" role="alert">{error}</p>{/if}
</section>

<style>
  .card {
    display: grid;
    gap: 0.6rem;
    padding: 1.1rem 1.25rem 1.25rem;
  }
  .card.compact {
    padding: 0.8rem 1rem;
    gap: 0.4rem;
  }
  h2 {
    margin: 0;
    font-size: var(--step-0);
    font-weight: 600;
  }
  .state,
  .count,
  .hint {
    color: var(--fog);
    font-size: var(--step--1);
    font-weight: 400;
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 0.45rem;
  }
  li {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto auto;
    align-items: baseline;
    gap: 0.5rem;
  }
  .x {
    padding: 0 0.4rem;
    border: 1px solid transparent;
    border-radius: var(--r-tile);
    background: none;
    color: var(--fog);
  }
  .x:hover,
  .x:focus-visible {
    border-color: var(--lattice);
    color: var(--chalk);
  }
  .note,
  .hint,
  .count {
    margin: 0;
  }
  .row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
  }
  .open {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    color: var(--fog);
    font-size: var(--step--1);
  }
  .error {
    margin: 0;
  }
</style>
