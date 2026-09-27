<script lang="ts">
  import '@fontsource-variable/fraunces';
  import '@fontsource-variable/fraunces/wght-italic.css';
  import '@fontsource/ibm-plex-sans/400.css';
  import '@fontsource/ibm-plex-sans/500.css';
  import '@fontsource/ibm-plex-sans/600.css';
  import '@fontsource/ibm-plex-mono/400.css';
  import '@fontsource/ibm-plex-mono/500.css';
  import '@fontsource/ibm-plex-mono/600.css';
  import '../app.css';
  import { onMount, type Snippet } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { BRAND } from '@cs/shared/brand';
  import HandleGate from '$lib/components/HandleGate.svelte';
  import Lattice from '$lib/components/Lattice.svelte';
  import Nav from '$lib/components/Nav.svelte';
  import SanctionBanner from '$lib/components/SanctionBanner.svelte';
  import { live } from '$lib/live.svelte';

  let { children }: { children: Snippet } = $props();

  onMount(() => {
    void live.init();
    return live.onInbox((event) => {
      if (event.type === 'match.started') void goto(`/play/${event.match.id}`);
    });
  });

  const readingOnly = $derived(['/docs', '/diary', '/games'].some((p) => page.url.pathname.startsWith(p)));
  const gated = $derived(live.checked && !live.me && !readingOnly);
</script>

<svelte:head><title>{BRAND.name}</title></svelte:head>

<Lattice />
<div class="shell" inert={gated}>
  <Nav />
  <main>
    <SanctionBanner />
    {@render children()}
  </main>
</div>
{#if gated}<HandleGate />{/if}

<style>
  .shell {
    position: relative;
    z-index: 1;
    min-height: 100dvh;
    display: flex;
    flex-direction: column;
  }
  main {
    flex: 1;
    width: min(1440px, 100%);
    margin: 0 auto;
    padding: 0 clamp(0.75rem, 2vw, 1.5rem) 1.5rem;
    min-height: 0;
  }
</style>
