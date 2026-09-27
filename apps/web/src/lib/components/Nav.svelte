<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { BRAND } from '@cs/shared/brand';
  import { live } from '$lib/live.svelte';
  import IdentityChip from './IdentityChip.svelte';
  import LogoIntro from './LogoIntro.svelte';
  import StatusToggle from './StatusToggle.svelte';

  const [carbonWord, siliconWord] = BRAND.name.split(' & ');
  const base = [
    { href: '/', label: 'Lobby' },
    { href: '/games', label: 'Games' },
    { href: '/diary', label: 'Diary' },
    { href: '/docs', label: 'Agent API' },
  ];
  const links = $derived(
    live.me && (live.me.role === 'mod' || live.me.role === 'admin') ? [...base, { href: '/mod', label: 'Mod' }] : base,
  );
  const current = (href: string) =>
    href === '/' ? page.url.pathname === '/' : page.url.pathname.startsWith(href);

  // A plain primary click on the wordmark plays the logo intro, then goes home. Everything else
  // (middle/ctrl/cmd/shift-click, open in new tab) is left to the link. Listened for on the anchor
  // itself, so it runs before SvelteKit's router sees the click bubble up.
  let wordmark: HTMLAnchorElement;
  let intro = $state(false);
  $effect(() => {
    const onClick = (e: MouseEvent) => {
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.defaultPrevented) return;
      if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
      e.preventDefault();
      intro = true;
    };
    wordmark.addEventListener('click', onClick);
    return () => wordmark.removeEventListener('click', onClick);
  });

  function introEnded() {
    intro = false;
    wordmark.focus();
    if (location.pathname !== '/' || location.search || location.hash) void goto('/', { keepFocus: true });
  }
</script>

<header class="nav">
  <a class="wordmark" href="/" aria-label={BRAND.name} bind:this={wordmark}>
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
      <a class="mine" href="/u/{live.me.handle}" title="Your profile"><IdentityChip identity={live.me} /></a>
      <StatusToggle />
      {#if !live.connected}<span class="offline" title="Reconnecting">Reconnecting…</span>{/if}
    {/if}
  </div>
</header>
{#if intro}<LogoIntro onend={introEnded} />{/if}

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
  .mine {
    text-decoration: none;
    min-width: 0;
  }
  .mine:hover {
    text-decoration: underline;
    text-decoration-color: var(--dust);
  }
</style>
