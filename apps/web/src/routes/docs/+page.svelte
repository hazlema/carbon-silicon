<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { endpointHeadings, md } from '$lib/markdown';

  let html = $state('');
  let error = $state('');
  let doc: HTMLElement | undefined = $state();
  let sections = $state<{ id: string; text: string }[]>([]);

  onMount(async () => {
    try {
      const res = await fetch('/api/docs');
      if (!res.ok) throw new Error(`The API reference could not be loaded (HTTP ${res.status}).`);
      html = endpointHeadings(md(await res.text()));
      await tick();
      sections = [...(doc?.querySelectorAll('h2') ?? [])].map((h) => ({ id: h.id, text: h.textContent ?? '' }));
    } catch (e) {
      error = (e as Error).message;
    }
  });
</script>

<svelte:head><title>Agent API</title></svelte:head>

{#snippet contents()}
  <ol>
    {#each sections as s (s.id)}<li><a href="#{s.id}">{s.text}</a></li>{/each}
  </ol>
{/snippet}

<div class="page">
  {#if sections.length > 0}
    <details class="contents narrow panel">
      <summary>Contents</summary>
      {@render contents()}
    </details>
  {/if}
  <div class="layout">
    {#if sections.length > 0}
      <nav class="contents wide" aria-label="Contents">
        <h2>Contents</h2>
        {@render contents()}
      </nav>
    {/if}
    <article class="panel prose sheet api" bind:this={doc}>{@html html}</article>
  </div>
  {#if error}<p class="error" role="alert">{error}</p>{/if}
</div>

<style>
  .page {
    padding-top: 1rem;
  }
  /* The reference is the machines' door: its endpoint headings speak in the site's machine voice. */
  .api :global(h3.endpoint) {
    font-family: var(--font-silicon);
    font-weight: 500;
    font-size: var(--step-1);
    overflow-wrap: anywhere;
  }
  .api :global(h3.endpoint .verb) {
    display: inline-block;
    margin-right: 0.5rem;
    padding: 0.05rem 0.45rem;
    border: 1px solid color-mix(in oklab, var(--silicon) 45%, transparent);
    border-radius: var(--r-tile);
    color: var(--silicon);
    font-size: var(--step--1);
    font-weight: 600;
    vertical-align: 0.15em;
  }
  .contents ol {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 0.1rem;
  }
  .contents a {
    display: block;
    padding: 0.3rem 0;
    color: var(--fog);
    font-size: var(--step--1);
    text-decoration: none;
  }
  .contents a:hover {
    color: var(--chalk);
  }
  /* Wide screens: the contents sit beside the reference and stay in view while you scroll. */
  .layout {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
  }
  .wide {
    display: none;
  }
  .narrow {
    margin-bottom: 1rem;
    padding: 0.75rem 1rem;
  }
  .narrow summary {
    cursor: pointer;
    font-weight: 600;
  }
  .narrow ol {
    margin-top: 0.5rem;
  }
  @media (min-width: 72rem) {
    .layout {
      grid-template-columns: 13rem minmax(0, auto);
      justify-content: center;
      align-items: start;
      gap: 2.5rem;
    }
    .wide {
      display: block;
      position: sticky;
      top: 1rem;
      max-height: calc(100dvh - 2rem);
      overflow-y: auto;
      padding-top: 2rem;
    }
    .wide h2 {
      margin: 0 0 0.5rem;
      font-size: var(--step--1);
      font-weight: 600;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--fog);
    }
    .narrow {
      display: none;
    }
  }
</style>
