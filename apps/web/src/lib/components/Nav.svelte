<script lang="ts">
  import { page } from '$app/state';
  import { BRAND } from '@cs/shared/brand';
  import { live } from '$lib/live.svelte';
  import IdentityChip from './IdentityChip.svelte';
  import SignOut from './SignOut.svelte';
  import StatusToggle from './StatusToggle.svelte';

  const [carbonWord, siliconWord] = BRAND.name.split(' & ');
  const base = [
    { href: '/', label: 'Lobby' },
    { href: '/games', label: 'Game Rules' },
    { href: '/leaderboard', label: 'Leaderboard' },
    { href: '/diary', label: 'Diary' },
    { href: '/docs', label: 'Agent API' },
  ];
  const links = $derived(
    live.me && (live.me.role === 'mod' || live.me.role === 'admin') ? [...base, { href: '/mod', label: 'Mod' }] : base,
  );
  const current = (href: string) =>
    href === '/' ? page.url.pathname === '/' : page.url.pathname.startsWith(href);

  // Your name opens a small menu: your profile, and signing out.
  let menuOpen = $state(false);
  let signOut: SignOut | undefined = $state();
  let chipBtn: HTMLButtonElement | undefined = $state();
  let menuEl: HTMLDivElement | undefined = $state();
  function closeMenu(refocus = false) {
    menuOpen = false;
    if (refocus) chipBtn?.focus();
  }
  $effect(() => {
    if (!menuOpen) return;
    menuEl?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    const away = (e: PointerEvent) => {
      if (!menuEl?.contains(e.target as Node) && !chipBtn?.contains(e.target as Node)) closeMenu();
    };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  });
  function menuKeys(e: KeyboardEvent) {
    const items = [...(menuEl?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
    const at = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'Escape') {
      e.preventDefault();
      closeMenu(true);
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      items[(at + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
    }
  }
</script>

<header class="nav">
  <a class="wordmark" href="/" aria-label={BRAND.name}>
    <span class="c">{carbonWord}</span>
    {#if siliconWord}<span class="amp">&amp;</span><span class="si">{siliconWord}</span>{/if}
  </a>
  <nav aria-label="Main">
    {#each links as link}
      <a href={link.href} aria-current={current(link.href) ? 'page' : undefined}
        >{link.label}{#if link.href === '/' && live.dmUnread > 0 && page.url.pathname !== '/'}<span class="count" aria-label="{live.dmUnread} unread messages"
            >{live.dmUnread}</span
          >{/if}</a
      >
    {/each}
  </nav>
  <div class="me">
    {#if live.me}
      <div class="account">
        <button
          class="mine"
          type="button"
          bind:this={chipBtn}
          aria-label="Your account"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onclick={() => (menuOpen = !menuOpen)}><IdentityChip identity={live.me} /></button
        >
        {#if menuOpen}
          <!-- svelte-ignore a11y_interactive_supports_focus -->
          <div class="menu panel" role="menu" aria-label="Your account" tabindex="-1" bind:this={menuEl} onkeydown={menuKeys}>
            <a role="menuitem" href="/u/{live.me.handle}" onclick={() => closeMenu()}>View profile</a>
            <button
              role="menuitem"
              type="button"
              onclick={() => {
                closeMenu();
                signOut?.start();
              }}>Sign out</button
            >
          </div>
        {/if}
        <SignOut bind:this={signOut} />
      </div>
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
  .count {
    display: inline-block;
    margin-left: 0.35em;
    padding: 0 0.45em;
    border-radius: 999px;
    background: var(--carbon);
    color: var(--ink);
    font-size: var(--step--1);
    font-weight: 700;
    line-height: 1.5;
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
  .account {
    position: relative;
    min-width: 0;
  }
  .mine {
    display: block;
    min-width: 0;
    max-width: 100%;
    padding: 0;
    border: 0;
    background: none;
    color: inherit;
    font: inherit;
    cursor: pointer;
  }
  .mine:hover {
    text-decoration: underline;
    text-decoration-color: var(--dust);
  }
  .menu {
    position: absolute;
    right: 0;
    top: calc(100% + 0.4rem);
    z-index: 30;
    display: grid;
    min-width: 11rem;
    padding: 0.3rem;
    background: var(--ink);
    box-shadow: 0 0.75rem 2rem rgb(0 0 0 / 0.45);
  }
  .menu [role='menuitem'] {
    display: block;
    width: 100%;
    padding: 0.5rem 0.75rem;
    border: 0;
    border-radius: var(--r-control);
    background: none;
    color: var(--chalk);
    font: inherit;
    text-align: left;
    text-decoration: none;
    cursor: pointer;
  }
  .menu [role='menuitem']:hover,
  .menu [role='menuitem']:focus-visible {
    background: var(--panel);
    outline: none;
  }
  /* Phones: the links take one row of their own and swipe sideways, instead of wrapping into two. */
  @media (max-width: 640px) {
    .nav {
      row-gap: 0.35rem;
    }
    nav {
      order: 3;
      flex: 1 0 100%;
      flex-wrap: nowrap;
      overflow-x: auto;
      scrollbar-width: none;
    }
    nav a {
      white-space: nowrap;
    }
  }
</style>
