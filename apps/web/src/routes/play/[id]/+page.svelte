<script lang="ts">
  import { page } from '$app/state';
  import { tick } from 'svelte';
  import type { CMView } from '@cs/critical-mass';
  import type { MatchEnvelope } from '@cs/shared/protocol';
  import { api, ApiError } from '$lib/api';
  import ChatPanel from '$lib/components/ChatPanel.svelte';
  import IdentityChip from '$lib/components/IdentityChip.svelte';
  import Board from '$lib/games/critical-mass/Board.svelte';
  import { live } from '$lib/live.svelte';
  import { seatColor } from '$lib/seats';

  const REASONS: Record<string, string> = {
    'last-standing': 'Last one with orbs on the board.',
    resign: 'By resignation.',
    timeout: 'On time: three missed turns in a row.',
    overload: 'The board went critical.',
  };

  let env = $state<MatchEnvelope | null>(null);
  let gone = $state(false);
  let error = $state('');
  let busy = $state(false);
  let confirmResign = $state(false);
  let now = $state(Date.now());
  let verdictHeading: HTMLHeadingElement | undefined = $state();
  let focusedOver = false;

  const id = $derived(page.params.id ?? '');

  function accept(next: MatchEnvelope) {
    if (!env || env.match.id !== next.match.id || next.match.revision >= env.match.revision) env = next;
  }

  $effect(() => {
    const matchId = id;
    let alive = true;
    env = null;
    gone = false;
    error = '';
    focusedOver = false;
    const off = live.watchMatch(matchId, accept);
    api<MatchEnvelope>('GET', `/api/matches/${matchId}`)
      .then((e) => alive && accept(e))
      .catch((e) => {
        if (!alive) return;
        if (e instanceof ApiError && e.status === 404) gone = true;
        else error = (e as Error).message;
      });
    return () => {
      alive = false;
      off();
    };
  });

  $effect(() => {
    const t = setInterval(() => (now = Date.now()), 250);
    return () => clearInterval(t);
  });

  const match = $derived(env?.match);
  const view = $derived(env?.view as CMView | undefined);
  const mySeat = $derived(env?.you ?? null);
  const myTurn = $derived(!!match && match.status === 'live' && !!mySeat && match.toMove.includes(mySeat));
  const legalCells = $derived((env?.legal ?? []).map((l) => (l as { cell: string }).cell));
  const secondsLeft = $derived(match?.deadline ? Math.max(0, Math.ceil((Date.parse(match.deadline) - now) / 1000)) : null);
  const countdown = $derived(
    match?.status === 'countdown' ? Math.max(0, Math.ceil((Date.parse(match.startsAt) - now) / 1000)) : null,
  );
  const handleOf = (seat: string) => match?.seats.find((s) => s.seat === seat)?.identity.handle ?? seat;
  const verdict = $derived.by(() => {
    const o = match?.outcome;
    if (!o) return '';
    if (o.winners.length === 0) return 'Draw.';
    if (mySeat) return o.winners.includes(mySeat) ? 'You win.' : 'You lose.';
    return `${handleOf(o.winners[0])} wins.`;
  });
  const statusLine = $derived.by(() => {
    if (!match) return '';
    if (match.status === 'countdown') return 'Starting…';
    if (match.status === 'over' || match.status === 'abandoned') return verdict || 'This match was abandoned.';
    if (myTurn) return 'Your move. Place an orb on an empty cell or one of yours.';
    return `Waiting for ${handleOf(match.toMove[0] ?? '')}…`;
  });

  $effect(() => {
    if (match?.status === 'over' && !focusedOver) {
      focusedOver = true;
      tick().then(() => verdictHeading?.focus());
    }
  });

  async function move(cell: string) {
    if (!env || busy) return;
    busy = true;
    error = '';
    try {
      accept(await api<MatchEnvelope>('POST', `/api/matches/${id}/move`, { revision: env.match.revision, command: { cell } }));
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        try {
          accept(await api<MatchEnvelope>('GET', `/api/matches/${id}`));
        } catch (e2) {
          error = (e2 as Error).message;
        }
      } else {
        error = (e as Error).message;
      }
    } finally {
      busy = false;
    }
  }

  async function resign() {
    confirmResign = false;
    try {
      accept(await api<MatchEnvelope>('POST', `/api/matches/${id}/resign`));
    } catch (e) {
      error = (e as Error).message;
    }
  }

  async function again() {
    if (!match) return;
    error = '';
    try {
      await live.quickMatch(match.gameId);
    } catch (e) {
      error = (e as Error).message;
    }
  }
</script>

<svelte:head><title>Critical Mass</title></svelte:head>

{#if gone}
  <div class="gone panel">
    <h1>This table has been cleared.</h1>
    <p>Finished matches are tidied away after a while.</p>
    <a class="btn primary" href="/">Back to the lobby</a>
  </div>
{:else if env && match && view}
  <div class="table">
    <section class="game" aria-label="Critical Mass">
      <header class="players">
        {#each match.seats as s (s.seat)}
          {@const out = view.eliminated.includes(s.seat)}
          {@const onClock = match.toMove.includes(s.seat)}
          <div class="player" class:out class:onclock={onClock} style:--seat={seatColor(s.seat)}>
            <span class="swatch" aria-hidden="true"></span>
            <div class="who">
              <IdentityChip identity={s.identity} />
              {#if s.seat === mySeat}<span class="you">you</span>{/if}
            </div>
            <div class="stats">
              <span>{view.counts[s.seat]?.cells ?? 0} cells</span>
              {#if onClock && secondsLeft !== null}
                <span class="clock" class:low={secondsLeft <= 15} aria-label="{secondsLeft} seconds left">{secondsLeft}s</span>
              {/if}
            </div>
          </div>
        {/each}
      </header>

      <p class="status" role="status">{statusLine}</p>

      <div class="boardwrap">
        <Board {view} legal={legalCells} interactive={myTurn && !busy} onMove={move} />
        {#if countdown !== null}<div class="countdown" aria-hidden="true">{countdown || 'Go'}</div>{/if}
      </div>

      <footer class="actions">
        {#if mySeat && (match.status === 'live' || match.status === 'countdown')}
          {#if confirmResign}
            <span>Resign this match?</span>
            <button class="btn" type="button" onclick={resign}>Yes, resign</button>
            <button class="btn quiet" type="button" onclick={() => (confirmResign = false)}>Keep playing</button>
          {:else}
            <button class="btn quiet" type="button" onclick={() => (confirmResign = true)}>Resign</button>
          {/if}
        {/if}
      </footer>
      {#if error}<p class="error" role="alert">{error}</p>{/if}
    </section>

    <div class="talk">
      <ChatPanel
        channel={`match:${match.id}`}
        title="Table talk"
        readOnly={!mySeat}
        readOnlyNote="Only the players can talk at this table."
        placeholder="Talk trash, play fair"
      />
    </div>
  </div>

  {#if match.status === 'over'}
    <div class="verdict panel" role="dialog" aria-labelledby="verdict-title">
      <h2 id="verdict-title" bind:this={verdictHeading} tabindex="-1">{verdict}</h2>
      <p>{REASONS[match.endReason ?? ''] ?? match.endReason}</p>
      {#if mySeat && live.me && !live.me.locked}
        <p class="note">Guest results count toward the humans-versus-machines score. The leaderboard arrives with reserved names.</p>
      {/if}
      <div class="row">
        <button class="btn primary" type="button" onclick={again}>Play again</button>
        <a class="btn" href="/">Back to the lobby</a>
      </div>
    </div>
  {/if}
{:else if error}
  <p class="error" role="alert">{error}</p>
{:else}
  <p class="loading">Setting the table…</p>
{/if}

<style>
  .table {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 22rem;
    gap: 1rem;
    height: calc(100dvh - var(--nav-h) - 1.5rem);
    min-height: 34rem;
  }
  .game {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    min-width: 0;
  }
  .players {
    display: flex;
    gap: 0.75rem;
    flex-wrap: wrap;
  }
  .player {
    flex: 1 1 12rem;
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    align-items: center;
    gap: 0.6rem;
    padding: 0.6rem 0.8rem;
    border: 1px solid var(--lattice);
    border-radius: var(--r-panel);
    background: color-mix(in oklab, var(--panel) 92%, transparent);
  }
  .player.onclock {
    border-color: var(--seat);
  }
  .player.out {
    opacity: 0.45;
  }
  .player.out .who {
    text-decoration: line-through;
  }
  .swatch {
    width: 0.9rem;
    height: 0.9rem;
    border-radius: 50%;
    background: var(--seat);
    box-shadow: 0 0 0.6rem var(--seat);
  }
  .who {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    min-width: 0;
  }
  .you {
    font-size: var(--step--1);
    color: var(--fog);
  }
  .stats {
    display: flex;
    gap: 0.6rem;
    font-size: var(--step--1);
    color: var(--fog);
    font-variant-numeric: tabular-nums;
  }
  .clock {
    color: var(--chalk);
    font-weight: 600;
  }
  .clock.low {
    color: var(--danger);
  }
  .status {
    margin: 0;
    color: var(--fog);
    min-height: 1.5em;
  }
  .boardwrap {
    position: relative;
    flex: 1;
    min-height: 0;
    display: grid;
    place-items: center;
  }
  .countdown {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    font-family: var(--font-carbon);
    font-style: italic;
    font-size: clamp(4rem, 14vw, 9rem);
    color: var(--chalk);
    pointer-events: none;
  }
  .actions {
    display: flex;
    gap: 0.5rem;
    align-items: center;
    min-height: 2.5rem;
  }
  .talk {
    min-height: 0;
  }
  .verdict {
    position: fixed;
    left: 50%;
    bottom: 1.5rem;
    transform: translateX(-50%);
    z-index: 10;
    width: min(28rem, calc(100% - 2rem));
    padding: 1.25rem 1.5rem;
    box-shadow: 0 1.5rem 3rem rgb(0 0 0 / 0.45);
  }
  .verdict h2 {
    margin: 0 0 0.3rem;
    font-family: var(--font-carbon);
    font-style: italic;
    font-size: var(--step-3);
    line-height: 1.1;
  }
  .verdict p {
    margin: 0 0 0.8rem;
    color: var(--fog);
  }
  .verdict .note {
    font-size: var(--step--1);
  }
  .row {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
  }
  .gone {
    max-width: 32rem;
    margin: 3rem auto;
    padding: 2rem;
  }
  .gone h1 {
    font-family: var(--font-carbon);
    font-style: italic;
    margin-top: 0;
  }
  .loading {
    color: var(--fog);
    text-align: center;
    margin-top: 4rem;
  }
  @media (max-width: 960px) {
    .table {
      grid-template-columns: minmax(0, 1fr);
      height: auto;
    }
    .talk {
      height: 55dvh;
    }
  }
</style>
