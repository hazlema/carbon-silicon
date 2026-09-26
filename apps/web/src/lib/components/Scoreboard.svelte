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
</script>

<section class="score" aria-labelledby="score-title">
  <h2 id="score-title" class="visually-hidden">Humans versus machines this season</h2>
  <div class="tiles">
    <div class="tile c" role="img" aria-label="Humans have {tally?.carbon ?? 0} {tally?.carbon === 1 ? 'win' : 'wins'} this season">
      <span class="n">{tally?.carbon ?? '–'}</span>
      <span class="sym">C</span>
      <span class="who">Humans</span>
    </div>
    <div class="tile si" role="img" aria-label="Machines have {tally?.silicon ?? 0} {tally?.silicon === 1 ? 'win' : 'wins'} this season">
      <span class="n">{tally?.silicon ?? '–'}</span>
      <span class="sym">Si</span>
      <span class="who">Machines</span>
    </div>
  </div>
  {#if tally}
    <p class="caption">
      Wins in human-versus-machine games, {month} season{#if tally.draws}, plus {tally.draws}
        {tally.draws === 1 ? 'draw' : 'draws'}{/if}.
    </p>
  {/if}
</section>

<style>
  .tiles {
    display: grid;
    grid-template-rows: auto auto;
    gap: 0.4rem;
    justify-content: start;
  }
  .tile {
    position: relative;
    width: 8.5rem;
    aspect-ratio: 1;
    border-radius: var(--r-tile);
    padding: 0.55rem 0.7rem;
    display: grid;
    grid-template-rows: auto 1fr auto;
    color: var(--ink);
  }
  .c {
    background: var(--carbon);
    animation: from-above 700ms cubic-bezier(0.2, 0.9, 0.2, 1) both;
  }
  .si {
    background: var(--silicon);
    animation: from-below 700ms cubic-bezier(0.2, 0.9, 0.2, 1) both;
  }
  .n {
    font-size: var(--step-1);
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }
  .sym {
    align-self: center;
    justify-self: center;
    font-size: var(--step-4);
    line-height: 1;
    font-weight: 700;
  }
  .c .sym {
    font-family: var(--font-carbon);
    font-style: italic;
  }
  .si .sym {
    font-family: var(--font-silicon);
    font-weight: 600;
  }
  .who {
    font-size: var(--step--1);
    font-weight: 600;
  }
  .caption {
    margin: 0.6rem 0 0;
    font-size: var(--step--1);
    color: var(--fog);
    max-width: 17rem;
  }
  @keyframes from-above {
    from {
      transform: translateY(-1.5rem);
      opacity: 0;
    }
  }
  @keyframes from-below {
    from {
      transform: translateY(1.5rem);
      opacity: 0;
    }
  }
  @media (max-width: 960px) {
    .tiles {
      grid-template-rows: none;
      grid-auto-flow: column;
    }
    .tile {
      width: 6.5rem;
    }
    .sym {
      font-size: var(--step-3);
    }
  }
</style>
