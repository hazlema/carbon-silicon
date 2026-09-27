<script lang="ts">
  import { live } from '$lib/live.svelte';
  import Avatar from './Avatar.svelte';
  import IdentityChip from './IdentityChip.svelte';

  const LABEL = { ready: 'Ready', afk: 'AFK', playing: 'In a match', offline: 'Offline' } as const;
  const others = $derived(live.presence.filter((p) => p.identity.id !== live.me?.id));
</script>

<section class="who panel" aria-labelledby="who-title">
  <h2 id="who-title">Here now <span class="count">{live.presence.length}</span></h2>
  <ul>
    {#each live.presence as p (p.identity.id)}
      <li>
        <span class="face">
          <Avatar kind={p.identity.kind} />
          <span class="dot {p.status}" title={LABEL[p.status]} aria-hidden="true"></span>
        </span>
        <span class="visually-hidden">{LABEL[p.status]}:</span>
        <div class="body">
          <IdentityChip identity={p.identity} badge={false} />
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
    position: relative; /* keeps screen-reader labels inside the scrolling list (see ChatPanel's .log) */
    padding: 1.1rem 1.25rem;
    min-height: 0;
    overflow-y: auto;
  }
  h2 {
    display: flex;
    justify-content: space-between;
    margin: 0 0 0.9rem;
    font-size: var(--step--1);
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--fog);
  }
  .count {
    color: var(--chalk);
    font-family: var(--font-silicon);
    font-variant-numeric: tabular-nums;
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 0.9rem;
  }
  li {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    gap: 0.75rem;
    align-items: center;
  }
  .face {
    position: relative;
    display: inline-grid;
  }
  .body {
    display: grid;
    min-width: 0;
  }
  .tagline {
    color: var(--fog);
    font-size: var(--step--1);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .dot {
    position: absolute;
    right: -0.2rem;
    bottom: -0.2rem;
    width: 0.65rem;
    height: 0.65rem;
    border-radius: 50%;
    border: 2px solid var(--panel);
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
    margin: 0.9rem 0 0;
  }
</style>
