<script lang="ts">
  import { onMount } from 'svelte';
  import type { Tally } from '@cs/shared/protocol';
  import { api } from '$lib/api';
  import { live } from '$lib/live.svelte';

  let tally = $state<Tally | null>(null);

  async function load() {
    try {
      tally = await api<Tally>('GET', '/api/tally');
    } catch {
      // The scoreboard is decoration-grade; the lobby works without it.
    }
  }

  onMount(() => {
    void load();
    const off = live.onInbox((e) => {
      if (e.type === 'match.over') void load();
    });
    const timer = setInterval(load, 60_000);
    return () => {
      off();
      clearInterval(timer);
    };
  });

  const month = $derived(
    tally ? new Date(`${tally.season}-01T00:00:00Z`).toLocaleString(undefined, { month: 'long', timeZone: 'UTC' }) : '',
  );
  const carbon = $derived(tally?.carbon ?? 0);
  const silicon = $derived(tally?.silicon ?? 0);
  // Nobody has won yet: an even split, drawn quietly.
  const share = $derived(carbon + silicon === 0 ? 50 : (carbon / (carbon + silicon)) * 100);
  const wins = (n: number) => `${n} ${n === 1 ? 'win' : 'wins'}`;
</script>

<section
  class="score"
  class:even={carbon + silicon === 0}
  aria-label="Humans versus machines, {month} season: humans {wins(carbon)}, machines {wins(silicon)}{tally?.draws
    ? `, ${tally.draws} ${tally.draws === 1 ? 'draw' : 'draws'}`
    : ''}"
>
  <span class="side c" aria-hidden="true">Humans <b>{tally ? carbon : '–'}</b></span>
  <span class="bar" aria-hidden="true">
    <span class="fill c" style:flex-basis="{share}%"></span>
    <span class="fill si"></span>
  </span>
  <span class="side si" aria-hidden="true"><b>{tally ? silicon : '–'}</b> Machines</span>
  {#if tally}
    <span class="season" aria-hidden="true">
      {month} season{#if tally.draws} · {tally.draws} {tally.draws === 1 ? 'draw' : 'draws'}{/if}
    </span>
  {/if}
</section>

<style>
  .score {
    display: flex;
    align-items: center;
    gap: 0.9rem;
    padding: 0.8rem 1.25rem;
    border-bottom: 1px solid var(--lattice);
  }
  .side {
    flex: none;
    font-size: var(--step-1);
    white-space: nowrap;
  }
  .side b {
    font-variant-numeric: tabular-nums;
  }
  .side.c {
    color: var(--carbon);
    font-family: var(--font-carbon);
    font-style: italic;
    font-weight: 600;
  }
  .side.c b {
    font-family: var(--font-silicon);
    font-style: normal;
    font-weight: 500;
  }
  .side.si {
    color: var(--silicon);
    font-family: var(--font-silicon);
    font-weight: 500;
  }
  .bar {
    flex: 1;
    min-width: 3rem;
    display: flex;
    gap: 3px;
    height: 0.4rem;
  }
  .fill {
    border-radius: 999px;
    transition: flex-basis 700ms cubic-bezier(0.2, 0.9, 0.2, 1);
  }
  .fill.c {
    flex: 0 0 auto;
    min-width: 0.4rem;
    background: var(--carbon);
  }
  .fill.si {
    flex: 1;
    min-width: 0.4rem;
    background: var(--silicon);
  }
  .even .fill {
    opacity: 0.35;
  }
  .season {
    flex: none;
    color: var(--dust);
    font-size: var(--step--1);
  }
  @media (max-width: 640px) {
    .season {
      display: none;
    }
  }
</style>
