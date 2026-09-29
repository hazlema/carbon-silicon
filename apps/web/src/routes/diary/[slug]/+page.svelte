<script lang="ts">
  import { page } from '$app/state';
  import type { DiaryEntry, DiaryEntrySummary } from '@cs/shared/protocol';
  import { api } from '$lib/api';
  import { diaryDate, neighbours } from '$lib/diary';
  import { md } from '$lib/markdown';

  let entry = $state<DiaryEntry | null>(null);
  let all = $state<DiaryEntrySummary[]>([]);
  let error = $state('');

  $effect(() => {
    const slug = page.params.slug;
    entry = null;
    error = '';
    api<{ entry: DiaryEntry }>('GET', `/api/diary/${slug}`)
      .then((r) => (entry = r.entry))
      .catch((e) => (error = (e as Error).message));
  });
  $effect(() => {
    api<{ entries: DiaryEntrySummary[] }>('GET', '/api/diary')
      .then((r) => (all = r.entries))
      .catch(() => {}); // the older/newer links are a nicety; the entry reads fine without them
  });
  const near = $derived(entry ? neighbours(all, entry.slug) : { newer: null, older: null });
</script>

<svelte:head><title>{entry?.title ?? 'Diary'}</title></svelte:head>

<div class="page">
  <article class="panel prose sheet">
    <p class="back"><a href="/diary">All entries</a></p>
    {#if entry}
      <h1>{entry.title}</h1>
      <p class="date"><time datetime={entry.date}>{diaryDate(entry.date)}</time></p>
      {@html md(entry.markdown)}
      {#if near.older || near.newer}
        <nav class="neighbours" aria-label="More entries">
          {#if near.older}<a class="older" href="/diary/{near.older.slug}"><span>Older</span>{near.older.title}</a>{/if}
          {#if near.newer}<a class="newer" href="/diary/{near.newer.slug}"><span>Newer</span>{near.newer.title}</a>{/if}
        </nav>
      {/if}
    {/if}
    {#if error}<p class="error" role="alert">{error}</p>{/if}
  </article>
</div>

<style>
  .page {
    padding-top: 1rem;
  }
  .back {
    margin: 0 0 1.5rem;
    font-size: var(--step--1);
  }
  h1 {
    font-style: italic;
    margin: 0 0 0.2rem;
  }
  .date {
    color: var(--dust);
    margin-top: 0;
  }
  .neighbours {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr));
    gap: 0.75rem;
    margin-top: 2.5rem;
    padding-top: 1.5rem;
    border-top: 1px solid var(--lattice);
  }
  .neighbours a {
    display: grid;
    gap: 0.15rem;
    padding: 0.75rem 1rem;
    border: 1px solid var(--lattice);
    border-radius: var(--r-control);
    font-family: var(--font-carbon);
    font-size: var(--step-1);
    text-decoration: none;
  }
  .neighbours a:hover {
    border-color: var(--fog);
  }
  .neighbours span {
    color: var(--dust);
    font-family: var(--font-ui);
    font-size: var(--step--1);
  }
  .newer {
    text-align: right;
    grid-column: -2;
  }
</style>
