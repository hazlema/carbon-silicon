<script lang="ts">
  import { page } from '$app/state';
  import { BRAND } from '@cs/shared/brand';
  import { live } from '$lib/live.svelte';
  import IdentityChip from './IdentityChip.svelte';
  import SignOut from './SignOut.svelte';
  import StatusToggle from './StatusToggle.svelte';

  const [carbonWord, siliconWord] = BRAND.name.split(' & ');
  const main = [
    { href: '/', label: 'Lobby' },
    { href: '/leaderboard', label: 'Leaderboard' },
    { href: '/games', label: 'Game Rules' },
  ];
  // The rest sit behind ⋯ on wide screens (flat in the ☰ drawer on phones).
  const moreLinks = $derived([
    { href: '/diary', label: 'Diary' },
    { href: '/docs', label: 'Agent API' },
    { href: 'https://frostyscorner.info/', label: 'FrostysCorner.info', external: true },
    ...(live.me && (live.me.role === 'mod' || live.me.role === 'admin') ? [{ href: '/mod', label: 'Mod' }] : []),
  ]);
  const current = (href: string) =>
    href === '/' ? page.url.pathname === '/' : page.url.pathname.startsWith(href);
  const moreCurrent = $derived(moreLinks.some((l) => !l.external && current(l.href)));

  let moreOpen = $state(false);
  let moreBtn: HTMLButtonElement | undefined = $state();
  let moreEl: HTMLDivElement | undefined = $state();
  function closeMore(refocus = false) {
    moreOpen = false;
    if (refocus) moreBtn?.focus();
  }
  $effect(() => {
    if (!moreOpen) return;
    moreEl?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    const away = (e: PointerEvent) => {
      if (!moreEl?.contains(e.target as Node) && !moreBtn?.contains(e.target as Node)) closeMore();
    };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  });
  function moreKeys(e: KeyboardEvent) {
    const items = [...(moreEl?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
    const at = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'Escape') {
      e.preventDefault();
      closeMore(true);
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      items[(at + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
    } else if (e.key === 'Tab') closeMore();
  }

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
  // Phones: the links and your status fold into a panel behind ☰ (the header is one row there).
  let drawerOpen = $state(false);
  let burgerBtn: HTMLButtonElement | undefined = $state();
  let drawerEl: HTMLDivElement | undefined = $state();
  function closeDrawer(refocus = false) {
    drawerOpen = false;
    if (refocus) burgerBtn?.focus();
  }
  // Following a link (or any navigation) closes it.
  $effect(() => {
    void page.url.pathname;
    drawerOpen = false;
    moreOpen = false;
  });
  $effect(() => {
    if (!drawerOpen) return;
    const away = (e: PointerEvent) => {
      if (!drawerEl?.contains(e.target as Node) && !burgerBtn?.contains(e.target as Node)) closeDrawer();
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeDrawer(true);
    };
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('pointerdown', away);
      document.removeEventListener('keydown', esc);
    };
  });
  /** Unread DMs while you're away from the lobby: the Lobby link counts them, and ☰ shows a dot. */
  const unreadAway = $derived(live.dmUnread > 0 && page.url.pathname !== '/');

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
  <div class="drawer" class:open={drawerOpen} id="site-menu" bind:this={drawerEl}>
  <nav aria-label="Main">
    {#each main as link}
      <a href={link.href} aria-current={current(link.href) ? 'page' : undefined}
        >{link.label}{#if link.href === '/' && unreadAway}<span class="count" aria-label="{live.dmUnread} unread messages"
            >{live.dmUnread}</span
          >{/if}</a
      >
    {/each}
    <div class="more">
      <button
        class="more-btn"
        class:here={moreCurrent}
        type="button"
        bind:this={moreBtn}
        aria-label="More pages"
        aria-haspopup="menu"
        aria-expanded={moreOpen}
        onclick={() => (moreOpen = !moreOpen)}
        ><svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true"
          ><circle cx="5" cy="12" r="1.8" /><circle cx="12" cy="12" r="1.8" /><circle cx="19" cy="12" r="1.8" /></svg
        ></button
      >
      {#if moreOpen}
        <!-- svelte-ignore a11y_interactive_supports_focus -->
        <div class="menu panel more-menu" role="menu" aria-label="More pages" tabindex="-1" bind:this={moreEl} onkeydown={moreKeys}>
          {#each moreLinks as link}
            {#if link.external}
              <a role="menuitem" href={link.href} target="_blank" rel="noopener" onclick={() => closeMore()}
                >{link.label} <span class="ext" aria-hidden="true">↗</span><span class="sr-only"> (opens in a new tab)</span></a
              >
            {:else}
              <a role="menuitem" href={link.href} aria-current={current(link.href) ? 'page' : undefined} onclick={() => closeMore()}
                >{link.label}</a
              >
            {/if}
          {/each}
        </div>
      {/if}
    </div>
    {#each moreLinks as link}
      {#if link.external}
        <a class="flat" href={link.href} target="_blank" rel="noopener"
          >{link.label} <span class="ext" aria-hidden="true">↗</span><span class="sr-only"> (opens in a new tab)</span></a
        >
      {:else}
        <a class="flat" href={link.href} aria-current={current(link.href) ? 'page' : undefined}>{link.label}</a>
      {/if}
    {/each}
  </nav>
  {#if live.me}<div class="status"><StatusToggle /></div>{/if}
  </div>
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
      {#if !live.connected}<span class="offline" title="Reconnecting">Reconnecting…</span>{/if}
    {/if}
  </div>
  <button
    class="burger"
    type="button"
    aria-label={unreadAway ? `Menu (${live.dmUnread} unread messages)` : 'Menu'}
    aria-expanded={drawerOpen}
    aria-controls="site-menu"
    bind:this={burgerBtn}
    onclick={() => (drawerOpen = !drawerOpen)}
  >
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"
      >{#if drawerOpen}<path d="M6 6l12 12M18 6L6 18" />{:else}<path d="M4 7h16M4 12h16M4 17h16" />{/if}</svg
    >
    {#if unreadAway && !drawerOpen}<span class="dot" aria-hidden="true"></span>{/if}
  </button>
</header>

<style>
  .nav {
    position: relative;
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
  .ext {
    color: var(--dust);
  }
  nav {
    align-items: center;
  }
  .flat {
    display: none;
  }
  .more {
    position: relative;
    display: flex;
  }
  .more-btn {
    display: grid;
    place-items: center;
    padding: 0 0.2rem;
    border: 0;
    border-radius: var(--r-control);
    background: none;
    color: var(--fog);
    cursor: pointer;
  }
  .more-btn:hover,
  .more-btn[aria-expanded='true'] {
    color: var(--chalk);
  }
  .more-btn.here {
    color: var(--chalk);
    box-shadow: inset 0 -1px 0 var(--dust);
  }
  .more-menu {
    left: 0;
    right: auto;
  }
  .menu [role='menuitem'][aria-current='page'] {
    background: var(--panel);
  }
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
  .menu [role='menuitem']:hover,
  .menu [role='menuitem']:focus-visible {
    background: var(--panel);
    outline: none;
  }
  /* Wide screens: the drawer is no box at all; the links sit after the wordmark, your status after your name. */
  .drawer {
    display: contents;
  }
  .status {
    order: 2;
  }
  .me {
    order: 1;
  }
  .burger {
    display: none;
    order: 3;
  }
  /* Phones: one row (wordmark, your name, ☰); the links and your status fold into a panel under it. */
  @media (max-width: 640px) {
    .nav {
      flex-wrap: nowrap;
      gap: 0.75rem;
      min-height: 0;
    }
    .wordmark {
      font-size: var(--step-0);
    }
    .me {
      min-width: 0;
    }
    .burger {
      position: relative;
      display: grid;
      place-items: center;
      flex: none;
      width: 2.5rem;
      height: 2.5rem;
      padding: 0;
      border: 1px solid var(--lattice);
      border-radius: var(--r-control);
      background: none;
      color: var(--chalk);
      cursor: pointer;
    }
    .burger .dot {
      position: absolute;
      top: 0.3rem;
      right: 0.3rem;
      width: 0.5rem;
      height: 0.5rem;
      border-radius: 50%;
      background: var(--carbon);
    }
    .drawer {
      display: none;
      position: absolute;
      top: 100%;
      left: 0.75rem;
      right: 0.75rem;
      z-index: 30;
      padding: 0.5rem;
      border: 1px solid var(--lattice);
      border-radius: 12px;
      background: var(--ink);
      box-shadow: 0 0.75rem 2rem rgb(0 0 0 / 0.45);
    }
    .drawer.open {
      display: grid;
      gap: 0.5rem;
    }
    nav {
      display: grid;
      gap: 0;
    }
    .more {
      display: none;
    }
    .flat {
      display: block;
    }
    nav a {
      padding: 0.6rem 0.75rem;
      border-radius: var(--r-control);
    }
    nav a[aria-current='page'] {
      background: var(--panel);
      text-decoration: none;
    }
    .status {
      padding: 0.5rem 0.75rem 0.25rem;
      border-top: 1px solid var(--lattice);
    }
  }
</style>
