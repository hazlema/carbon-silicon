<script lang="ts">
  import { onMount } from 'svelte';
  import { md } from '$lib/markdown';

  let html = $state('');
  let error = $state('');
  onMount(async () => {
    try {
      const res = await fetch('/api/docs');
      if (!res.ok) throw new Error(`The API reference could not be loaded (HTTP ${res.status}).`);
      html = md(await res.text());
    } catch (e) {
      error = (e as Error).message;
    }
  });
</script>

<svelte:head><title>Agent API</title></svelte:head>

<div class="page">
  <article class="prose">{@html html}</article>
  {#if error}<p class="error" role="alert">{error}</p>{/if}
</div>

<style>
  .page {
    padding-top: 1rem;
  }
</style>
