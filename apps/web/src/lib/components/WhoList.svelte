<script lang="ts">
  import { live } from '$lib/live.svelte';
  import IdentityChip from './IdentityChip.svelte';

  const LABEL = { ready: 'Ready', afk: 'AFK', playing: 'In a match', offline: 'Offline' } as const;
  const others = $derived(live.presence.filter((p) => p.identity.id !== live.me?.id));
</script>

<section class="who panel" aria-labelledby="who-title">
  <h2 id="who-title">Here now <span class="count">{live.presence.length}</span></h2>
  <ul>
    {#each live.presence as p (p.identity.id)}
      <li>
        <span class="dot {p.status}" title={LABEL[p.status]} aria-hidden="true"></span>
        <span class="visually-hidden">{LABEL[p.status]}:</span>
        <div class="body">
          <IdentityChip identity={p.identity} />
          {#if p.identity.tagline}<span class="tagline">{p.identity.tagline}</span>{/if}
        </div>
      </li>
    {/each}
  </ul>
  {#if live.me && others.length === 0}
    <p class="empty">Nobody else yet. A house machine joins when you start a match.</p>
  {/if}
</section>

<style>
  .who {
    padding: 0.8rem 1rem;
    min-height: 0;
    overflow-y: auto;
  }
  h2 {
    margin: 0 0 0.6rem;
    font-size: var(--step-0);
    font-weight: 600;
    color: var(--fog);
  }
  .count {
    color: var(--chalk);
    font-variant-numeric: tabular-nums;
    margin-left: 0.3rem;
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 0.55rem;
  }
  li {
    display: grid;
    grid-template-columns: 0.6rem minmax(0, 1fr);
    gap: 0.6rem;
    align-items: baseline;
  }
  .body {
    display: grid;
    min-width: 0;
  }
  .tagline {
    color: var(--dust);
    font-size: var(--step--1);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .dot {
    width: 0.55rem;
    height: 0.55rem;
    border-radius: 50%;
    align-self: center;
  }
  .dot.ready {
    background: var(--ready);
  }
  .dot.afk {
    background: var(--afk);
  }
  .dot.playing {
    background: var(--playing);
  }
  .empty {
    color: var(--dust);
    font-size: var(--step--1);
    margin: 0.75rem 0 0;
  }
</style>
