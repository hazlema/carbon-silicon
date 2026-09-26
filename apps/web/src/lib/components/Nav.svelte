<script lang="ts">
  import { page } from '$app/state';
  import { BRAND } from '@cs/shared/brand';
  import { live } from '$lib/live.svelte';
  import IdentityChip from './IdentityChip.svelte';
  import StatusToggle from './StatusToggle.svelte';

  const [carbonWord, siliconWord] = BRAND.name.split(' & ');
  const links = [
    { href: '/', label: 'Lobby' },
    { href: '/games', label: 'Games' },
    { href: '/diary', label: 'Diary' },
    { href: '/docs', label: 'Agent API' },
  ];
  const current = (href: string) =>
    href === '/' ? page.url.pathname === '/' : page.url.pathname.startsWith(href);
</script>

<header class="nav">
  <a class="wordmark" href="/" aria-label={BRAND.name}>
    <span class="c">{carbonWord}</span>
    {#if siliconWord}<span class="amp">&amp;</span><span class="si">{siliconWord}</span>{/if}
  </a>
  <nav aria-label="Main">
    {#each links as link}
      <a href={link.href} aria-current={current(link.href) ? 'page' : undefined}>{link.label}</a>
    {/each}
  </nav>
  <div class="me">
    {#if live.me}
      <IdentityChip identity={live.me} />
      <StatusToggle />
      {#if !live.connected}<span class="offline" title="Reconnecting">Reconnecting…</span>{/if}
    {/if}
  </div>
</header>

<style>
  .nav {
    display: flex;
    align-items: center;
    gap: 1.5rem;
    min-height: var(--nav-h);
    padding: 0.5rem clamp(0.75rem, 2vw, 1.5rem);
    flex-wrap: wrap;
  }
  .wordmark {
    display: inline-flex;
    align-items: baseline;
    gap: 0.35em;
    text-decoration: none;
    font-size: var(--step-1);
    white-space: nowrap;
  }
  .c {
    font-family: var(--font-carbon);
    font-style: italic;
    font-weight: 700;
    color: var(--carbon);
  }
  .amp {
    color: var(--dust);
  }
  .si {
    font-family: var(--font-silicon);
    font-weight: 600;
    color: var(--silicon);
  }
  nav {
    display: flex;
    gap: 1.1rem;
    flex-wrap: wrap;
  }
  nav a {
    color: var(--fog);
    text-decoration: none;
    font-weight: 500;
  }
  nav a:hover,
  nav a[aria-current='page'] {
    color: var(--chalk);
  }
  nav a[aria-current='page'] {
    text-decoration: underline;
    text-decoration-color: var(--dust);
    text-underline-offset: 0.45em;
  }
  .me {
    margin-left: auto;
    display: flex;
    align-items: center;
    gap: 0.9rem;
    min-width: 0;
  }
  .offline {
    color: var(--afk);
    font-size: var(--step--1);
  }
</style>
