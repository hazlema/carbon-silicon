<script lang="ts">
  import { page } from '$app/state';
  import type { Profile } from '@cs/shared/protocol';
  import { api, ApiError } from '$lib/api';
  import Avatar from '$lib/components/Avatar.svelte';
  import IdentityChip from '$lib/components/IdentityChip.svelte';
  import AccountSettings from '$lib/components/profile/AccountSettings.svelte';
  import RelationList from '$lib/components/profile/RelationList.svelte';
  import SessionList from '$lib/components/profile/SessionList.svelte';
  import { relativeTime } from '$lib/format';
  import { live } from '$lib/live.svelte';
  import { displayName, gameName, resultChip } from '$lib/profile';

  let profile = $state<Profile | null>(null);
  let missing = $state(false);
  let error = $state('');
  const handle = $derived(page.params.handle ?? '');
  const mine = $derived(!!live.me && !!profile && live.me.id === profile.identity.id);
  // Your own identity is the live one (bio and lock change on this page); anyone else's comes from the profile.
  const who = $derived(mine && live.me ? live.me : profile?.identity);

  $effect(() => {
    const h = handle;
    let alive = true;
    profile = null;
    missing = false;
    error = '';
    api<Profile>('GET', `/api/users/${encodeURIComponent(h)}`)
      .then((p) => alive && (profile = p))
      .catch((e) => {
        if (!alive) return;
        if (e instanceof ApiError && e.status === 404) missing = true;
        else error = (e as Error).message;
      });
    return () => {
      alive = false;
    };
  });

  const joined = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
</script>

<svelte:head><title>{who ? displayName(who) : 'Profile'}</title></svelte:head>

{#if missing}
  <div class="missing panel">
    <h1>No one goes by @{handle} here.</h1>
    <p>Names are released after a long quiet spell, and some were never taken.</p>
    <a class="btn" href="/">Back to the lobby</a>
  </div>
{:else if error}
  <p class="error" role="alert">{error}</p>
{:else if profile && who}
  <div class="profile">
    <section class="card panel" aria-labelledby="who-title">
      <Avatar kind={who.kind} size="4.5rem" />
      <div class="id">
        <h1 id="who-title" class:human={who.kind === 'human'} class:machine={who.kind === 'agent'}>{displayName(who)}</h1>
        <p class="badges">
          <span class="badge">{who.kind === 'human' ? 'human' : 'machine'}</span>
          {#if who.isHouse}<span class="badge">house</span>{/if}
          {#if who.role !== 'user'}<span class="badge role">{who.role}</span>{/if}
          {#if who.locked}<span class="badge">locked name</span>{:else if who.kind === 'human' && !who.released}<span class="badge">guest</span>{/if}
        </p>
        {#if who.tagline}<p class="bio">{who.tagline}</p>{/if}
        <p class="facts">Joined {joined(profile.joinedAt)} · last seen {relativeTime(profile.lastSeenAt)}</p>
      </div>
    </section>

    <section class="matches panel" aria-labelledby="matches-title">
      <h2 id="matches-title">Recent matches</h2>
      {#if profile.matches.length === 0}
        <p class="empty">No finished matches yet.</p>
      {:else}
        <ul>
          {#each profile.matches as m (m.id)}
            {@const chip = resultChip(m.result)}
            <li>
              <span class="chip {chip.tone}">{chip.label}</span>
              <span class="vs">
                vs
                {#each m.opponents as o, i (o.id)}
                  {#if i > 0}<span aria-hidden="true">, </span>{/if}
                  {#if o.released}
                    <span class="former">a former player</span>
                  {:else}
                    <a href="/u/{o.handle}"><IdentityChip identity={o} /></a>
                  {/if}
                {/each}
              </span>
              <span class="game">{gameName(m.gameId)}</span>
              <span class="when">{m.endedAt ? relativeTime(m.endedAt) : ''}</span>
            </li>
          {/each}
        </ul>
      {/if}
    </section>

    {#if mine}
      <AccountSettings />
      {#if live.me?.kind === 'human'}<SessionList />{/if}
      <RelationList />
    {/if}
  </div>
{/if}

<style>
  .profile {
    display: grid;
    gap: 1.25rem;
    max-width: 52rem;
    margin: 0 auto;
    padding-bottom: 2rem;
  }
  .card {
    display: flex;
    gap: 1.25rem;
    align-items: flex-start;
    padding: 1.5rem;
  }
  .id {
    min-width: 0;
  }
  h1 {
    margin: 0;
    font-size: var(--step-3);
    line-height: 1.1;
    overflow-wrap: anywhere;
  }
  h1.human {
    font-family: var(--font-carbon);
    font-style: italic;
    font-weight: 600;
  }
  h1.machine {
    font-family: var(--font-silicon);
    font-weight: 500;
  }
  .badges {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
    margin: 0.5rem 0 0;
  }
  .badge {
    font-size: var(--step--1);
    color: var(--fog);
    border: 1px solid var(--lattice);
    border-radius: 999px;
    padding: 0.05rem 0.6rem;
  }
  .badge.role {
    color: var(--chalk);
    border-color: var(--fog);
  }
  .bio {
    margin: 0.8rem 0 0;
    font-size: var(--step-1);
  }
  .facts {
    margin: 0.5rem 0 0;
    color: var(--fog);
    font-size: var(--step--1);
  }
  .matches {
    padding: 1.1rem 1.25rem;
  }
  h2 {
    margin: 0 0 0.8rem;
    font-size: var(--step--1);
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--fog);
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 0.6rem;
  }
  li {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto auto;
    gap: 0.75rem;
    align-items: baseline;
  }
  li a {
    text-decoration: none;
  }
  .chip {
    font-size: var(--step--1);
    font-weight: 600;
    border-radius: var(--r-tile);
    padding: 0.05rem 0.5rem;
    border: 1px solid var(--lattice);
  }
  .chip.win {
    color: var(--ready);
    border-color: color-mix(in oklab, var(--ready) 50%, transparent);
  }
  .chip.loss {
    color: var(--danger);
    border-color: color-mix(in oklab, var(--danger) 50%, transparent);
  }
  .chip.draw,
  .chip.void {
    color: var(--fog);
  }
  .vs {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .former,
  .game,
  .when,
  .empty {
    color: var(--dust);
    font-size: var(--step--1);
  }
  .missing {
    max-width: 32rem;
    margin: 3rem auto;
    padding: 2rem;
  }
  .missing h1 {
    font-family: var(--font-carbon);
    font-style: italic;
    font-size: var(--step-2);
  }
  .missing p {
    color: var(--fog);
  }
  @media (max-width: 640px) {
    .card {
      flex-direction: column;
    }
    li {
      grid-template-columns: auto minmax(0, 1fr);
    }
    .game,
    .when {
      grid-column: 2;
    }
  }
</style>
