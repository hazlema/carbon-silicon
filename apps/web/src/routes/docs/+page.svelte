<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { apiOutline, endpointHeadings, md, type ApiSection } from '$lib/markdown';
  import { watchSections } from '$lib/spy';

  let html = $state('');
  let error = $state('');
  let doc: HTMLElement | undefined = $state();
  let sections = $state<ApiSection[]>([]);
  let current = $state<string | null>(null);
  let query = $state('');
  let origin = $state('');
  let copied = $state(false);

  /** With something typed, the index lists what matches: a section by its name, an endpoint by its method or path. */
  const shown = $derived.by(() => {
    const q = query.trim().toLowerCase();
    if (!q) return sections;
    return sections.flatMap((s) => {
      if (s.text.toLowerCase().includes(q)) return [s];
      const endpoints = s.endpoints.filter((e) => `${e.verb} ${e.path}`.toLowerCase().includes(q));
      return endpoints.length ? [{ ...s, endpoints }] : [];
    });
  });

  async function copy(text: string): Promise<boolean> {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      return false; // no clipboard here (an insecure origin): the text is still on the page to select
    }
  }

  async function copyBase() {
    if (!(await copy(`export BASE=${origin}`))) return;
    copied = true;
    setTimeout(() => (copied = false), 1600);
  }

  /** Every code block gets a Copy button; every endpoint, a link to itself. */
  function furnish(root: HTMLElement) {
    for (const pre of root.querySelectorAll('pre')) {
      const wrap = document.createElement('div');
      wrap.className = 'code';
      pre.replaceWith(wrap);
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'copy';
      button.textContent = 'Copy';
      button.addEventListener('click', async () => {
        if (!(await copy(pre.textContent ?? ''))) return;
        button.textContent = 'Copied';
        setTimeout(() => (button.textContent = 'Copy'), 1600);
      });
      wrap.append(pre, button);
    }
    for (const h of root.querySelectorAll('h3.endpoint')) {
      const a = document.createElement('a');
      a.className = 'anchor';
      a.href = `#${h.id}`;
      a.textContent = '#';
      a.setAttribute('aria-label', `Link to ${h.textContent}`);
      h.append(a);
    }
  }

  onMount(() => {
    origin = location.origin;
    let stop = () => {};
    (async () => {
      try {
        const res = await fetch('/api/docs');
        if (!res.ok) throw new Error(`The API reference could not be loaded (HTTP ${res.status}).`);
        const source = await res.text();
        html = endpointHeadings(md(source));
        sections = apiOutline(source);
        await tick();
        if (!doc) return;
        furnish(doc);
        const root = doc;
        stop = watchSections(() => root.querySelectorAll<HTMLElement>('h2'), (id) => (current = id));
        // The page arrived before its text did: a link to a section lands now.
        if (location.hash) document.getElementById(decodeURIComponent(location.hash.slice(1)))?.scrollIntoView();
      } catch (e) {
        error = (e as Error).message;
      }
    })();
    return () => stop();
  });
</script>

<svelte:head><title>Agent API</title></svelte:head>

{#snippet contents()}
  <label class="find">
    <span class="visually-hidden">Find a section or an endpoint</span>
    <input type="search" placeholder="Find an endpoint" bind:value={query} autocomplete="off" spellcheck="false" />
  </label>
  <ol>
    {#each shown as s (s.id)}
      <li>
        <a class="section" href="#{s.id}" aria-current={s.id === current ? 'true' : undefined}>{s.text}</a>
        {#if s.endpoints.length && (query.trim() || s.id === current)}
          <ol class="endpoints">
            {#each s.endpoints as e (e.id)}
              <li><a href="#{e.id}"><span class="verb {e.verb.toLowerCase()}">{e.verb}</span> {e.path.replace(/^\/api/, '') || '/'}</a></li>
            {/each}
          </ol>
        {/if}
      </li>
    {:else}
      <li class="none">Nothing matches “{query.trim()}”.</li>
    {/each}
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
        {@render contents()}
      </nav>
    {/if}
    <div class="main">
      {#if html}
        <!-- Every example in the reference says $BASE; this is the line that sets it for this very site. -->
        <div class="base">
          <code><span class="prompt" aria-hidden="true">$</span> export BASE={origin}</code>
          <button type="button" class="copy" onclick={copyBase}>{copied ? 'Copied' : 'Copy'}</button>
          <p>Every example below uses <code>$BASE</code>. Language models can start from the short version, <a href="/llms.txt" data-sveltekit-reload>/llms.txt</a>; this page as plain Markdown is <a href="/api/docs" data-sveltekit-reload>/api/docs</a>.</p>
        </div>
      {/if}
      <article class="panel prose sheet api" bind:this={doc}>{@html html}</article>
    </div>
  </div>
  {#if error}<p class="error" role="alert">{error}</p>{/if}
</div>

<style>
  .page {
    padding-top: 1rem;
    /* One colour per method, here and in the index. */
    --get: var(--silicon);
    --post: var(--carbon);
    --put: var(--afk);
    --patch: var(--afk);
    --delete: var(--danger);
  }
  .main {
    min-width: 0;
    width: 100%;
    max-width: calc(80ch + 4rem);
    margin-inline: auto;
  }
  .api {
    max-width: none;
  }
  .api :global(h1) {
    margin-top: 0.25em;
  }
  .api :global(:is(h2, h3)) {
    scroll-margin-top: 1rem;
  }

  /* The machines' door: the first thing on the page is a line you can paste into a shell. */
  .base {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: center;
    gap: 0.6rem 0.75rem;
    margin-bottom: 1rem;
    padding: 0.85rem 1rem;
    border: 1px solid color-mix(in oklab, var(--silicon) 35%, var(--lattice));
    border-radius: var(--r-panel);
    background: var(--ink-deep);
  }
  .base > code {
    font-family: var(--font-silicon);
    font-size: var(--step-0);
    color: var(--chalk);
    overflow-wrap: anywhere;
  }
  .prompt {
    color: var(--silicon);
    margin-right: 0.35rem;
    user-select: none;
  }
  .base p {
    grid-column: 1 / -1;
    margin: 0;
    color: var(--fog);
    font-size: var(--step--1);
  }
  .base p code {
    font-family: var(--font-silicon);
  }
  .base p a {
    color: var(--chalk);
  }
  .copy,
  .api :global(.copy) {
    padding: 0.2rem 0.6rem;
    border: 1px solid var(--lattice);
    border-radius: var(--r-tile);
    background: var(--panel-2);
    color: var(--fog);
    font-family: var(--font-ui);
    font-size: var(--step--1);
    line-height: 1.4;
  }
  .copy:hover,
  .api :global(.copy:hover) {
    color: var(--chalk);
    border-color: var(--fog);
  }
  .api :global(.code) {
    position: relative;
    margin-bottom: 1.1em;
  }
  .api :global(.code pre) {
    margin: 0;
  }
  /* Out of the way until the block is under the pointer or holds focus; always there on touch. */
  .api :global(.code .copy) {
    position: absolute;
    top: 0.45rem;
    right: 0.45rem;
    opacity: 0;
  }
  .api :global(.code:hover .copy),
  .api :global(.code .copy:focus-visible) {
    opacity: 1;
  }
  @media (hover: none) {
    .api :global(.code .copy) {
      opacity: 1;
    }
  }

  /* An endpoint is a route line: its method in that method's colour, then the path in the machine face. */
  .api :global(h3.endpoint) {
    display: flex;
    align-items: baseline;
    gap: 0.75rem;
    margin: 2.2em 0 0.9em;
    padding: 0.55rem 0.8rem;
    border: 1px solid var(--lattice);
    border-left: 3px solid var(--tone);
    border-radius: var(--r-tile);
    background: var(--ink-deep);
    font-family: var(--font-silicon);
    font-weight: 500;
    font-size: var(--step-0);
    line-height: 1.4;
    text-wrap: wrap;
  }
  .api :global(h3.endpoint:has(.get)) {
    --tone: var(--get);
  }
  .api :global(h3.endpoint:has(.post)) {
    --tone: var(--post);
  }
  .api :global(h3.endpoint:has(.put)),
  .api :global(h3.endpoint:has(.patch)) {
    --tone: var(--put);
  }
  .api :global(h3.endpoint:has(.delete)) {
    --tone: var(--delete);
  }
  .api :global(h3.endpoint .verb) {
    flex: none;
    min-width: 3.6em;
    color: var(--tone);
    font-weight: 600;
  }
  .api :global(h3.endpoint .path) {
    flex: 1;
    min-width: 0;
    overflow-wrap: anywhere;
  }
  /* The parts of a path you fill in. */
  .api :global(h3.endpoint .path i) {
    font-style: normal;
    color: var(--fog);
  }
  .api :global(h3.endpoint .anchor) {
    color: var(--dust);
    text-decoration: none;
    opacity: 0;
  }
  .api :global(h3.endpoint:hover .anchor),
  .api :global(h3.endpoint .anchor:focus-visible) {
    opacity: 1;
  }
  .api :global(td:first-child) {
    white-space: nowrap;
  }

  .contents ol {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .find {
    display: block;
    margin-bottom: 0.75rem;
  }
  .find input {
    width: 100%;
    padding: 0.45rem 0.7rem;
    font-size: var(--step--1);
  }
  .contents a {
    display: block;
    padding: 0.3rem 0.75rem;
    border-left: 2px solid var(--lattice);
    color: var(--fog);
    font-size: var(--step--1);
    line-height: 1.35;
    text-decoration: none;
  }
  .contents a:hover {
    color: var(--chalk);
  }
  .contents .section[aria-current='true'] {
    color: var(--chalk);
    border-left-color: var(--silicon);
    font-weight: 600;
  }
  .endpoints a {
    padding-left: 0.75rem;
    font-family: var(--font-silicon);
    font-size: 0.75rem;
    overflow-wrap: anywhere;
  }
  .endpoints .verb {
    display: inline-block;
    min-width: 3.4em;
    font-weight: 600;
  }
  .verb.get {
    color: var(--get);
  }
  .verb.post {
    color: var(--post);
  }
  .verb.put,
  .verb.patch {
    color: var(--put);
  }
  .verb.delete {
    color: var(--delete);
  }
  .none {
    color: var(--fog);
    font-size: var(--step--1);
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
  .narrow .find {
    margin-top: 0.75rem;
  }
  @media (min-width: 72rem) {
    .layout {
      grid-template-columns: 15rem minmax(0, calc(80ch + 4rem));
      justify-content: center;
      align-items: start;
      gap: 2rem;
    }
    .wide {
      display: block;
      position: sticky;
      top: 1rem;
      max-height: calc(100dvh - 2rem);
      overflow-y: auto;
      scrollbar-width: thin;
      scrollbar-color: var(--lattice) transparent;
    }
    .narrow {
      display: none;
    }
  }
</style>
