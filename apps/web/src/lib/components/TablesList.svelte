<script lang="ts">
  import type { TableInfo } from '@cs/shared/protocol';
  import { live } from '$lib/live.svelte';
  import { tableApi } from '$lib/table-actions';

  let error = $state('');
  const mine = (t: TableInfo) => t.id === live.myTable?.id;
  /** Tables gathering that anyone may join (and yours, once you open it, so you can see it's listed). */
  const open = $derived(live.tables.filter((t) => t.status === 'forming' && t.open && (mine(t) || t.seated.length < t.size)));
  const playing = $derived(live.tables.filter((t) => t.status === 'playing'));
  const gameOf = (t: TableInfo) => live.games.find((g) => g.id === t.gameId);
  const nameOf = (t: TableInfo) => gameOf(t)?.name ?? t.gameId;
  const handles = (t: TableInfo, joiner: string) => t.seated.map((p) => `@${p.handle}`).join(joiner);
  const seatsFree = (t: TableInfo) => `${t.size - t.seated.length} of ${t.size} ${t.size === 1 ? 'seat' : 'seats'} free`;
  /** Why you can't sit at this table right now, or null when you can. */
  const blocked = (t: TableInfo): string | null => {
    if (gameOf(t)?.humans === false && live.me?.kind === 'human') return `${nameOf(t)} is machines only for now. Watch any table playing it.`;
    if (live.myTable) return 'Leave your table to sit here.';
    if (live.myStatus !== 'ready') return 'Set yourself Ready to sit.';
    return null;
  };

  async function sit(id: string) {
    error = '';
    try {
      await tableApi.sit(id);
    } catch (e) {
      error = (e as Error).message;
    }
  }
</script>

<section class="tables panel" aria-labelledby="tables-title">
  <h2 id="tables-title">Current games</h2>
  {#if open.length === 0 && playing.length === 0}
    <p class="empty">No open tables. Host a game and tick <em>Open to anyone</em> to list it here.</p>
  {/if}
  {#if open.length > 0}
    <h3>Open</h3>
    <ul>
      {#each open as t (t.id)}
        {@const why = blocked(t)}
        <li>
          {#snippet row()}
            <span class="body">
              <span class="line1"><span class="game">{nameOf(t)}</span>{#if mine(t)}<span class="yours">your table</span>{/if}</span>
              <span class="who">{handles(t, ', ')}</span>
              <span class="meta">{seatsFree(t)}{gameOf(t)?.houseFill ? ' · house bots fill the rest at Start' : ''}</span>
              {#if why && !mine(t)}<span class="why">{why}</span>{/if}
            </span>
          {/snippet}
          {#if mine(t)}
            <div class="row own">{@render row()}</div>
          {:else}
            <button
              class="row"
              type="button"
              disabled={!!why}
              title={why ?? undefined}
              aria-label="Sit at {nameOf(t)} with {handles(t, ', ')}, {seatsFree(t)}"
              onclick={() => sit(t.id)}
              >{@render row()}{#if !why}<span class="go" aria-hidden="true">Sit →</span>{/if}</button
            >
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
  {#if playing.length > 0}
    <h3>Playing now</h3>
    <ul>
      {#each playing as t (t.id)}
        <li>
          <a class="row" href="/t/{t.id}" aria-label="Watch {nameOf(t)}: {handles(t, ' vs ')}">
            <span class="body">
              <span class="line1"><span class="game">{nameOf(t)}</span></span>
              <span class="who">{handles(t, ' vs ')}</span>
            </span>
            <span class="go" aria-hidden="true">Watch →</span>
          </a>
        </li>
      {/each}
    </ul>
  {/if}
  {#if error}<p class="error" role="alert">{error}</p>{/if}
</section>

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
  .empty {
    margin: 0;
    color: var(--dust);
    font-size: var(--step--1);
  }
  ul {
    list-style: none;
    margin: 0 0 0.6rem;
    padding: 0;
    display: grid;
    gap: 0.5rem;
  }
  /* The whole row is the way in: sit at a gathering table, watch one that's playing. */
  .row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: center;
    gap: 0.6rem;
    width: 100%;
    padding: 0.55rem 0.7rem;
    border: 1px solid var(--lattice);
    border-radius: var(--r-control);
    background: var(--panel-2);
    color: var(--chalk);
    font: inherit;
    text-align: left;
    text-decoration: none;
    cursor: pointer;
    transition:
      border-color 0.15s,
      background 0.15s;
  }
  button.row:not(:disabled):hover,
  a.row:hover,
  .row:focus-visible {
    border-color: var(--silicon);
    background: color-mix(in oklab, var(--panel-2) 85%, var(--silicon));
  }
  button.row:disabled {
    cursor: not-allowed;
    opacity: 0.7;
  }
  .row.own {
    cursor: default;
    border-style: dashed;
  }
  .body {
    display: grid;
    gap: 0.1rem;
    min-width: 0;
  }
  .line1 {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
  }
  .game {
    font-weight: 600;
  }
  .yours {
    font-size: var(--step--1);
    color: var(--ready);
  }
  .who,
  .meta,
  .why {
    color: var(--fog);
    font-size: var(--step--1);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .meta {
    color: var(--dust);
    white-space: normal;
  }
  .why {
    color: var(--afk);
    white-space: normal;
  }
  .go {
    font-size: var(--step--1);
    white-space: nowrap;
    color: var(--silicon);
  }
  .error {
    margin: 0;
  }
</style>
