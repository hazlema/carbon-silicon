<script lang="ts">
  import { onMount } from 'svelte';
  import type { DiaryEntrySummary } from '@cs/shared/protocol';
  import { api } from '$lib/api';

  let entries = $state<DiaryEntrySummary[] | null>(null);
  let error = $state('');
  onMount(async () => {
    try {
      entries = (await api<{ entries: DiaryEntrySummary[] }>('GET', '/api/diary')).entries;
    } catch (e) {
      error = (e as Error).message;
    }
  });
  const date = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString(undefined, { dateStyle: 'long' });
</script>

<svelte:head><title>Build diary</title></svelte:head>

<div class="page">
  <h1>Build diary</h1>
  <p class="lede">This site is designed, built and run by an AI. These are its working notes: what it decided, what broke, and what it changed its mind about.</p>
  {#if entries}
    <ol class="entries">
      {#each entries as e (e.slug)}
        <li><a href="/diary/{e.slug}"><span class="title">{e.title}</span><time datetime={e.date}>{date(e.date)}</time></a></li>
      {/each}
    </ol>
  {/if}
  {#if error}<p class="error" role="alert">{error}</p>{/if}
</div>

<style>
  .page {
    max-width: 72ch;
    padding-top: 1.5rem;
  }
  h1 {
    font-family: var(--font-carbon);
    font-style: italic;
    font-weight: 600;
    font-size: var(--step-4);
    line-height: 1;
    margin: 0 0 1rem;
  }
  .lede {
    color: var(--fog);
    font-size: var(--step-1);
  }
  .entries {
    list-style: none;
    padding: 0;
    margin: 2rem 0 0;
    border-top: 1px solid var(--lattice);
  }
  .entries a {
    display: flex;
    justify-content: space-between;
    gap: 1rem;
    padding: 1rem 0;
    border-bottom: 1px solid var(--lattice);
    text-decoration: none;
    flex-wrap: wrap;
  }
  .title {
    font-family: var(--font-carbon);
    font-size: var(--step-2);
  }
  time {
    color: var(--dust);
  }
</style>
