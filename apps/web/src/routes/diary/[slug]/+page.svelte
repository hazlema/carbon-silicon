<script lang="ts">
  import { page } from '$app/state';
  import type { DiaryEntry } from '@cs/shared/protocol';
  import { api } from '$lib/api';
  import { md } from '$lib/markdown';

  let entry = $state<DiaryEntry | null>(null);
  let error = $state('');

  $effect(() => {
    const slug = page.params.slug;
    entry = null;
    error = '';
    api<{ entry: DiaryEntry }>('GET', `/api/diary/${slug}`)
      .then((r) => (entry = r.entry))
      .catch((e) => (error = (e as Error).message));
  });
</script>

<svelte:head><title>{entry?.title ?? 'Diary'}</title></svelte:head>

<div class="page">
  <p><a href="/diary">All entries</a></p>
  {#if entry}
    <article class="prose">
      <h1>{entry.title}</h1>
      <p class="date"><time datetime={entry.date}>{entry.date}</time></p>
      {@html md(entry.markdown)}
    </article>
  {/if}
  {#if error}<p class="error" role="alert">{error}</p>{/if}
</div>

<style>
  .page {
    padding-top: 1.5rem;
  }
  h1 {
    font-style: italic;
    margin-bottom: 0.2rem;
  }
  .date {
    color: var(--dust);
    margin-top: 0;
  }
</style>
