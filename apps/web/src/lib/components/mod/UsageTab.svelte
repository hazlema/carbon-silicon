<script lang="ts">
  import type { UsageReport } from '@cs/shared/protocol';
  import { api } from '$lib/api';
  import { relativeTime } from '$lib/format';

  let usage = $state<UsageReport | null>(null);
  let error = $state('');

  async function load() {
    error = '';
    try {
      usage = (await api<{ usage: UsageReport }>('GET', '/api/mod/usage')).usage;
    } catch (e) {
      error = (e as Error).message;
    }
  }
  $effect(() => {
    void load();
  });

  const dollars = (n: number) => `$${n < 10 ? n.toFixed(2) : n.toFixed(0)}`;
</script>

<section class="usage" aria-labelledby="usage-title">
  <h2 id="usage-title">OpenRouter spend</h2>
  <p class="note">What the bots' key has cost: their voices and the Bouncer's judge. Refreshed at most once a minute.</p>
  {#if error}<p class="error" role="alert">{error}</p>{/if}
  {#if usage?.status === 'ok'}
    <dl class="tiles">
      <div><dt>Today</dt><dd>{dollars(usage.today)}</dd></div>
      <div><dt>This week</dt><dd>{dollars(usage.week)}</dd></div>
      <div><dt>This month</dt><dd>{dollars(usage.month)}</dd></div>
      <div><dt>All time</dt><dd>{dollars(usage.total)}</dd></div>
    </dl>
    <p class="note">
      {#if usage.limit !== null}Limit {dollars(usage.limit)}{#if usage.limitRemaining !== null}, {dollars(usage.limitRemaining)} left{/if}.{:else}No spending limit on this key.{/if}
      {#if usage.freeRequests}Free-model requests today: {usage.freeRequests.used} of {usage.freeRequests.limit}.{/if}
      Checked {relativeTime(usage.checkedAt)}.
    </p>
  {:else if usage}
    <p class="message">{usage.message}</p>
  {/if}
  <button class="btn quiet" type="button" onclick={load}>Refresh</button>
</section>

<style>
  h2 {
    margin: 0 0 0.3rem;
    font-size: var(--step--1);
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--fog);
  }
  .note,
  .message {
    color: var(--fog);
    margin: 0 0 1rem;
  }
  .message {
    color: var(--chalk);
  }
  .tiles {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(8rem, 1fr));
    gap: 0.75rem;
    margin: 0 0 1rem;
  }
  .tiles div {
    padding: 0.8rem 1rem;
    border: 1px solid var(--lattice);
    border-radius: var(--r-panel);
    background: color-mix(in oklab, var(--panel) 92%, transparent);
  }
  dt {
    color: var(--fog);
    font-size: var(--step--1);
  }
  dd {
    margin: 0.2rem 0 0;
    font-family: var(--font-silicon);
    font-size: var(--step-2);
    font-variant-numeric: tabular-nums;
  }
</style>
