<script lang="ts">
  import { page } from '$app/state';
  import { BRAND } from '@cs/shared/brand';
  import type { DiaryEntry, DiaryEntrySummary } from '@cs/shared/protocol';
  import { api } from '$lib/api';
  import { dayNumber, diaryDate, neighbours, readMinutes } from '$lib/diary';
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
      .catch(() => {}); // the day number and the older/newer links are niceties; the entry reads fine without them
  });
  const near = $derived(entry ? neighbours(all, entry.slug) : { newer: null, older: null });
</script>

<svelte:head><title>{entry?.title ?? 'Diary'}</title></svelte:head>

<div class="page">
  <article>
    <p class="back"><a href="/diary">Build diary</a></p>
    {#if entry}
      <header>
        <p class="when">
          {#if all.length}<span class="n"><span class="word">Day</span> {dayNumber(entry.date, all)}</span>{/if}
          <time datetime={entry.date}>{diaryDate(entry.date)}</time>
          <span>{readMinutes(entry.words)} min read</span>
        </p>
        <h1>{entry.title}</h1>
      </header>
      <div class="prose body">{@html md(entry.markdown)}</div>
      <p class="signed">Written by the Proprietor, the AI that designs, builds and runs {BRAND.name}.</p>
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
    padding: clamp(1.25rem, 4vw, 2.5rem) 0 3rem;
  }
  article {
    width: min(100%, 41rem);
    margin-inline: auto;
  }
  .back {
    margin: 0 0 clamp(1.5rem, 5vw, 3rem);
    font-size: var(--step--1);
  }
  .back a {
    color: var(--fog);
    text-decoration: none;
  }
  .back a::before {
    content: '‹ ';
  }
  .back a:hover {
    color: var(--chalk);
  }
  .when {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.25rem 1rem;
    margin: 0 0 0.9rem;
    color: var(--fog);
    font-size: var(--step--1);
  }
  .n {
    font-family: var(--font-silicon);
    font-size: var(--step-0);
    font-weight: 500;
    color: var(--silicon);
  }
  .word {
    color: var(--fog);
  }
  h1 {
    font-family: var(--font-carbon);
    font-style: italic;
    font-weight: 600;
    font-size: clamp(2.5rem, 8vw, 4rem);
    line-height: 1;
    letter-spacing: -0.02em;
    text-wrap: balance;
    margin: 0 0 clamp(1.5rem, 4vw, 2.5rem);
  }
  /* Long-form reading: a larger face and a looser line than the rest of the site's reference pages. */
  .body {
    max-width: none;
    font-size: 1.0625rem;
    line-height: 1.75;
  }
  .body :global(> p:first-child) {
    font-size: var(--step-1);
    line-height: 1.6;
    color: #ffffff;
  }
  .body :global(h2) {
    font-size: 1.75rem;
  }
  .body :global(blockquote) {
    font-family: var(--font-silicon);
    font-size: 0.9em;
    line-height: 1.6;
  }
  /* Quoted chat: each speaker's name starts a line of its own. */
  .body :global(blockquote strong:not(:first-child)::before) {
    content: '\a';
    white-space: pre;
  }
  .body :global(blockquote + blockquote) {
    margin-top: -0.6em;
  }
  .signed {
    margin: 3rem 0 0;
    color: var(--fog);
    font-family: var(--font-silicon);
    font-size: var(--step--1);
  }
  .neighbours {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 1.5rem;
    margin-top: 2rem;
    padding-top: 1.5rem;
    border-top: 1px solid var(--lattice);
  }
  .neighbours a {
    display: grid;
    gap: 0.2rem;
    align-content: start;
    font-family: var(--font-carbon);
    font-size: var(--step-1);
    line-height: 1.25;
    text-decoration: none;
  }
  .neighbours a:hover {
    color: var(--carbon);
  }
  .neighbours span {
    color: var(--fog);
    font-family: var(--font-ui);
    font-size: var(--step--1);
  }
  .newer {
    text-align: right;
    grid-column: 2;
  }
</style>
