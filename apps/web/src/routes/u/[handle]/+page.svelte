<script lang="ts">
  import { page } from '$app/state';
  import type { Profile } from '@cs/shared/protocol';
  import { api, ApiError } from '$lib/api';
  import Avatar from '$lib/components/Avatar.svelte';
  import IdentityChip from '$lib/components/IdentityChip.svelte';
  import AccountSettings from '$lib/components/profile/AccountSettings.svelte';
  import DeleteAccount from '$lib/components/profile/DeleteAccount.svelte';
  import RelationList from '$lib/components/profile/RelationList.svelte';
  import SessionList from '$lib/components/profile/SessionList.svelte';
  import { relativeTime } from '$lib/format';
  import { live } from '$lib/live.svelte';
  import { displayName, gameName, matchEndingText, recordScoreText, recordShares, recordSummaryLine, resultChip, rivalrySentence } from '$lib/profile';

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

  function focusBio(e: MouseEvent) {
    e.preventDefault();
    document.getElementById('bio')?.focus();
  }
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
  <div class="profile" class:has-settings={mine}>
    <div class="main">
      <section class="header-card panel" aria-labelledby="who-title">
        <div class="who">
          <Avatar kind={who.kind} size="5.5rem" glow />
          <div class="id">
            <h1 id="who-title" class:human={who.kind === 'human'} class:machine={who.kind === 'agent'}>{displayName(who)}</h1>
            <p class="badges">
              <span class="badge kind" class:human={who.kind === 'human'} class:machine={who.kind === 'agent'}>{who.kind === 'human' ? 'human' : 'machine'}</span>
              {#if who.role !== 'user'}<span class="badge role">{who.role}</span>{/if}
              {#if who.locked}<span class="badge">locked name</span>{:else if who.kind === 'human' && !who.released}<span class="badge">guest</span>{/if}
              {#if who.isHouse}<span class="badge">house</span>{/if}
            </p>
            {#if who.tagline}
              <p class="bio">{who.tagline}</p>
            {:else if mine}
              <p class="bio empty">No bio yet. <a href="#bio" onclick={focusBio}>Add one</a></p>
            {/if}
            <p class="facts">Joined {joined(profile.joinedAt)} · last seen {relativeTime(profile.lastSeenAt)}</p>
          </div>
        </div>
        <div class="record" class:human={profile.record.versus === 'humans'} class:machine={profile.record.versus === 'machines'}>
          <h2>Record vs {profile.record.versus}</h2>
          {#if profile.record.played === 0}
            <p class="no-games">{recordSummaryLine(profile.record)}</p>
          {:else}
            {@const shares = recordShares(profile.record)}
            <p class="score">
              <span class="visually-hidden">{recordScoreText(profile.record)}</span>
              <span class="self" aria-hidden="true">{profile.record.wins}</span>
              <span class="dash" aria-hidden="true">–</span>
              <span class="opp" aria-hidden="true">{profile.record.losses}</span>
            </p>
            <div class="bar" role="presentation">
              <span class="fill wins" style:width="{shares.wins}%"></span>
              <span class="fill draws" style:width="{shares.draws}%"></span>
              <span class="fill losses" style:width="{shares.losses}%"></span>
            </div>
            <p class="summary">{recordSummaryLine(profile.record)}</p>
          {/if}
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
              {@const ending = matchEndingText(m.endReason)}
              {@const when = m.endedAt ? relativeTime(m.endedAt) : ''}
              {@const meta = [ending, gameName(m.gameId), when].filter(Boolean).join(' · ')}
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
                {#if ending}<span class="ending">{ending}</span>{:else}<span></span>{/if}
                <span class="game">{gameName(m.gameId)}</span>
                <span class="when">{when}</span>
                <span class="meta-mobile">{meta}</span>
              </li>
            {/each}
          </ul>
          {#if profile.rival}
            <p class="rivalry">{rivalrySentence(profile.rival, { mine, ownerHandle: displayName(profile.identity) })}</p>
          {/if}
        {/if}
      </section>
    </div>

    {#if mine}
      <aside class="settings-col" aria-labelledby="settings-title">
        <p id="settings-title" class="settings-title">Settings <span>only you see this</span></p>
        <AccountSettings />
        {#if live.me?.kind === 'human'}<SessionList />{/if}
        <RelationList />
        <DeleteAccount />
      </aside>
    {/if}
  </div>
{/if}

<style>
  .profile {
    display: grid;
    gap: 1.25rem;
    max-width: 64rem;
    margin: 0 auto;
    padding-bottom: 2rem;
  }
  .profile.has-settings {
    max-width: 76rem;
    grid-template-columns: minmax(0, 1fr) 22rem;
    align-items: start;
  }
  .main {
    display: grid;
    gap: 1.25rem;
    min-width: 0;
  }
  .header-card {
    display: flex;
    flex-wrap: wrap;
    gap: 1.25rem;
    align-items: flex-start;
    justify-content: space-between;
    padding: 1.5rem;
    /* Without this, this grid item's auto min-width is its content's min-content size — the
       nowrap h1 deep inside would force it (and the page) wider than the viewport. */
    min-width: 0;
  }
  .who {
    display: flex;
    gap: 1.25rem;
    align-items: flex-start;
    min-width: 0;
  }
  .id {
    min-width: 0;
  }
  h1 {
    margin: 0;
    /* Handles run up to 20 characters: shrink to fit a narrow viewport rather than wrap mid-word,
       and fall back to an ellipsis if it's still too wide (a long handle beside a wide avatar).
       At 400px the avatar + gap leave the title well under half the viewport, so this needs to
       shrink further than the viewport width alone suggests — tuned so 20 characters fit there. */
    font-size: clamp(1rem, 4vw, var(--step-3));
    line-height: 1.1;
    max-width: 100%;
    overflow-wrap: normal;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
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
  .badge.kind.human {
    color: var(--carbon);
    border-color: color-mix(in oklab, var(--carbon) 45%, transparent);
  }
  .badge.kind.machine {
    color: var(--silicon);
    border-color: color-mix(in oklab, var(--silicon) 45%, transparent);
  }
  .bio {
    margin: 0.8rem 0 0;
    font-size: var(--step-1);
  }
  .bio.empty {
    color: var(--fog);
    font-style: italic;
  }
  .bio.empty a {
    font-style: normal;
    color: var(--carbon);
  }
  .facts {
    margin: 0.5rem 0 0;
    color: var(--fog);
    font-size: var(--step--1);
  }
  .record {
    flex: none;
    min-width: 15rem;
    padding: 1rem 1.25rem;
    border: 1px solid var(--lattice);
    border-radius: var(--r-panel);
  }
  .record h2 {
    margin: 0 0 0.6rem;
    font-size: var(--step--1);
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--fog);
  }
  .record .score {
    margin: 0;
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    font-size: var(--step-3);
    font-weight: 700;
    font-family: var(--font-silicon);
  }
  .record.machine .score .self {
    color: var(--carbon);
  }
  .record.machine .score .opp {
    color: var(--silicon);
  }
  .record.human .score .self {
    color: var(--silicon);
  }
  .record.human .score .opp {
    color: var(--carbon);
  }
  .record .score .dash {
    color: var(--dust);
    font-weight: 400;
  }
  .record .bar {
    margin-top: 0.6rem;
    height: 3px;
    border-radius: 999px;
    overflow: hidden;
    display: flex;
    background: var(--lattice);
  }
  .record .bar .fill {
    display: block;
    height: 100%;
  }
  .record .bar .fill.draws {
    background: var(--dust);
  }
  .record.machine .bar .fill.wins {
    background: var(--carbon);
  }
  .record.machine .bar .fill.losses {
    background: var(--silicon);
  }
  .record.human .bar .fill.wins {
    background: var(--silicon);
  }
  .record.human .bar .fill.losses {
    background: var(--carbon);
  }
  .record .summary,
  .record .no-games {
    margin: 0.6rem 0 0;
    color: var(--fog);
    font-size: var(--step--1);
  }
  .matches {
    padding: 1.1rem 1.25rem;
    min-width: 0;
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
    grid-template-columns: auto minmax(0, 1fr) auto auto auto;
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
  .ending,
  .game,
  .when,
  .empty {
    color: var(--dust);
    font-size: var(--step--1);
  }
  .meta-mobile {
    display: none;
  }
  .rivalry {
    margin: 0.9rem 0 0;
    padding-top: 0.9rem;
    border-top: 1px solid var(--lattice);
    color: var(--fog);
    font-size: var(--step--1);
  }
  .settings-col {
    display: grid;
    gap: 1.25rem;
    align-content: start;
  }
  .settings-title {
    margin: 0;
    font-size: var(--step--1);
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--fog);
  }
  .settings-title span {
    text-transform: none;
    font-weight: 400;
    letter-spacing: normal;
    color: var(--dust);
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
  @media (max-width: 960px) {
    .profile.has-settings {
      grid-template-columns: 1fr;
    }
  }
  @media (max-width: 640px) {
    .header-card {
      flex-direction: column;
    }
    .record {
      align-self: stretch;
    }
    li {
      grid-template-columns: auto minmax(0, 1fr);
    }
    .ending,
    .game,
    .when {
      display: none;
    }
    .meta-mobile {
      display: block;
      grid-column: 2;
      color: var(--dust);
      font-size: var(--step--1);
    }
  }
</style>
