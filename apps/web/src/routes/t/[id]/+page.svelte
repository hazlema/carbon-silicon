<script lang="ts">
  import { page } from '$app/state';
  import { tick, untrack } from 'svelte';
  import type { CMView } from '@cs/critical-mass';
  import type { LLView } from '@cs/lightline';
  import { dmParticipants, railChannel, tableChannel, type MatchEnvelope, type SeatInfo, type TableInfo } from '@cs/shared/protocol';
  import { api, ApiError } from '$lib/api';
  import Avatar from '$lib/components/Avatar.svelte';
  import ChatPanel from '$lib/components/ChatPanel.svelte';
  import DmTabs from '$lib/components/DmTabs.svelte';
  import GatheringCard from '$lib/components/GatheringCard.svelte';
  import IdentityChip from '$lib/components/IdentityChip.svelte';
  import Board from '$lib/games/critical-mass/Board.svelte';
  import LightlineBoard from '$lib/games/lightline/Board.svelte';
  import { keyOf, typing, type SteerKey } from '$lib/games/lightline/controls';
  import { live } from '$lib/live.svelte';
  import { pollMatch } from '$lib/match-poll';
  import { clock, colorOf, tableColors } from '$lib/seats';

  const REASONS: Record<string, string> = {
    'last-standing': 'Last one with orbs on the board.',
    resign: 'By resignation.',
    timeout: 'On time: three missed turns in a row.',
    overload: 'The board went critical.',
    rounds: 'On rounds: two round wins, or the best after three.',
    forfeit: 'By forfeit: everyone else resigned.',
  };

  let table = $state<TableInfo | null>(null);
  let env = $state<MatchEnvelope | null>(null);
  let gone = $state(false);
  let error = $state('');
  let busy = $state(false);
  let confirmResign = $state(false);
  let now = $state(Date.now());
  let verdictHeading: HTMLHeadingElement | undefined = $state();
  let focusedOver = false;
  /** 'table', 'rail', or a dm: channel. */
  let tab = $state<string>('table');
  let focusKey = $state(0);
  let railUnread = $state(0);

  const id = $derived(page.params.id ?? '');

  function accept(next: MatchEnvelope) {
    if (!env || env.match.id !== next.match.id || next.match.revision >= env.match.revision) env = next;
  }

  // The table: seats, status, watchers; pushed while the page is open.
  $effect(() => {
    const tableId = id;
    let alive = true;
    table = null;
    env = null;
    gone = false;
    error = '';
    const off = live.watchTable(tableId, (t) => {
      if (!alive) return;
      if (t) table = t;
      else gone = true;
    });
    api<{ table: TableInfo }>('GET', `/api/tables/${tableId}`)
      .then((r) => alive && (table = r.table))
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

  // Its current (or last) match.
  const matchId = $derived(table?.matchId ?? null);
  $effect(() => {
    const mid = matchId;
    if (!mid) return;
    let alive = true;
    // Never show an envelope for a match other than the table's current one: a rematch's new
    // match id lands here before its envelope does, and the previous (finished) match's board
    // and verdict must not linger in that gap.
    if (untrack(() => env?.match.id) !== mid) env = null;
    focusedOver = false;
    const off = live.watchMatch(mid, accept);
    const ctl = new AbortController();
    api<MatchEnvelope>('GET', `/api/matches/${mid}`)
      .then((e) => {
        if (!alive) return;
        accept(e);
        // No socket for a guest: follow the match by long-poll instead, or the board would freeze.
        if (!untrack(() => live.me)) void pollMatch(mid, e.match.revision, accept, (p) => api<MatchEnvelope>('GET', p), ctl.signal);
      })
      .catch((e) => {
        if (alive && !(e instanceof ApiError && e.status === 404)) error = (e as Error).message;
      });
    return () => {
      alive = false;
      ctl.abort();
      off();
    };
  });

  $effect(() => {
    const t = setInterval(() => (now = Date.now()), 250);
    return () => clearInterval(t);
  });

  /** Players (seated now, or in the last match) talk at the table; everyone else is a spectator. */
  const isPlayer = $derived(!!live.me && !!table && [...table.seated, ...table.lastPlayers].some((p) => p.id === live.me!.id));
  // Spectators land on the rail; players at the table, with the rail out of sight (no coaching).
  $effect(() => {
    tab = isPlayer ? 'table' : 'rail';
  });
  $effect(() => {
    const t = table?.id;
    if (!t) return;
    return live.onChat(railChannel(t), () => {
      if (tab !== 'rail') railUnread += 1;
    });
  });
  $effect(() => {
    if (tab === 'rail') railUnread = 0;
  });
  const dmTab = $derived(dmParticipants(tab) ? (live.dms.find((d) => d.channel === tab) ?? null) : null);
  $effect(() => {
    const r = live.dmRequest;
    if (!r) return;
    tab = r.channel;
    focusKey += 1;
    live.dmRequest = null;
  });
  // A conversation that left the list (closed elsewhere, the name released): back to where you were.
  $effect(() => {
    if (dmParticipants(tab) && !dmTab) tab = isPlayer ? 'table' : 'rail';
  });
  $effect(() => {
    if (dmTab && dmTab.unread > 0) void live.readDm(dmTab.channel);
  });

  const match = $derived(env?.match);
  const gameId = $derived(match?.gameId ?? table?.gameId ?? null);
  /** The catalog's name for the game; the catalog loads only once signed in, so fall back to the id, title-cased. */
  const gameName = $derived(
    live.games.find((g) => g.id === gameId)?.name ??
      (gameId ? gameId.split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ') : 'Table'),
  );
  const view = $derived(env?.match.gameId === 'critical-mass' ? (env.view as CMView) : undefined);
  const ll = $derived(env?.match.gameId === 'lightline' ? (env.view as LLView) : undefined);
  const mySeat = $derived(env?.you ?? null);
  /** Knocked out (or resigned) while the others play on. In Lightline a crash ends only the round. */
  const iAmOut = $derived(
    !!mySeat && ((!!view && view.eliminated.includes(mySeat)) || (!!ll && !!ll.cycles.find((c) => c.seat === mySeat)?.resigned)),
  );
  const steerable = $derived(
    !!ll && !!mySeat && live.me?.kind === 'human' && (match?.status === 'live' || match?.status === 'countdown') && !iAmOut,
  );
  const coarse = typeof window !== 'undefined' && matchMedia('(pointer: coarse)').matches;
  let pressed = $state<SteerKey | null>(null);
  let pressedTimer: ReturnType<typeof setTimeout> | undefined;
  function steer(matchId: string, key: SteerKey) {
    live.steer(matchId, key);
    pressed = key;
    clearTimeout(pressedTimer);
    pressedTimer = setTimeout(() => (pressed = null), 150);
  }
  $effect(() => {
    if (!steerable || !env) return;
    const id = env.match.id;
    const onKey = (e: KeyboardEvent) => {
      if (typing(e.target)) return;
      const key = keyOf(e);
      if (!key) return;
      e.preventDefault(); // arrows and Space would scroll the page
      steer(id, key);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
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
  const status = $derived.by((): { lead: string; detail?: string } => {
    if (!match) return { lead: '' };
    if (match.status === 'countdown') return { lead: 'Starting…' };
    if (match.status === 'over' || match.status === 'abandoned') return { lead: verdict || 'This match was abandoned.' };
    if (ll) {
      const human = !!mySeat && match.seats.find((s) => s.seat === mySeat)?.identity.kind === 'human';
      return {
        lead: `Round ${ll.round}`,
        detail: ll.shrinking ? 'The arena is closing in.' : human ? 'You steer: arrows or WASD, Space to boost.' : 'Machines at work: each rides its own doctrine.',
      };
    }
    if (myTurn) return { lead: 'Your move.', detail: 'Place an orb on an empty cell or one of yours.' };
    return { lead: `Waiting for ${handleOf(match.toMove[0] ?? '')}…` };
  });
  const colors = $derived(tableColors(match?.seats ?? []));
  // You sit on the left; everyone else fills in after you, half a table per side.
  const sides = $derived.by(() => {
    const seats = match?.seats ?? [];
    const ordered = [...seats.filter((s) => s.seat === mySeat), ...seats.filter((s) => s.seat !== mySeat)];
    const half = Math.ceil(ordered.length / 2);
    return { left: ordered.slice(0, half), right: ordered.slice(half) };
  });
  /** A rematch is gathering and you're in it: the card sits where the verdict was. */
  const regathering = $derived(table?.status === 'forming' && !!live.me && table.seated.some((p) => p.id === live.me!.id));

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
      accept(await api<MatchEnvelope>('POST', `/api/matches/${env.match.id}/move`, { revision: env.match.revision, command: { cell } }));
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        try {
          accept(await api<MatchEnvelope>('GET', `/api/matches/${env.match.id}`));
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
    if (!env) return;
    try {
      accept(await api<MatchEnvelope>('POST', `/api/matches/${env.match.id}/resign`));
      // In a match that plays on, you're free now: the Play panel and invites should know.
      void live.refreshMe().catch((e) => console.error(e));
    } catch (e) {
      error = (e as Error).message;
    }
  }

  async function rematch() {
    if (!table) return;
    error = '';
    try {
      table = (await api<{ table: TableInfo }>('POST', `/api/tables/${table.id}/rematch`)).table;
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

  async function stopLooking() {
    error = '';
    try {
      await live.leaveQueue();
    } catch (e) {
      error = (e as Error).message;
    }
  }
</script>

<svelte:head><title>{gameName}</title></svelte:head>

{#if gone}
  <div class="gone panel">
    <h1>This table has been cleared.</h1>
    <p>Finished matches are tidied away after a while.</p>
    <a class="btn primary" href="/">Back to the lobby</a>
  </div>
{:else if table && !table.matchId}
  <div class="gone panel">
    <h1>This table is still gathering.</h1>
    <p>@{table.host.handle} is inviting players from the lobby.</p>
    <a class="btn primary" href="/">Back to the lobby</a>
  </div>
{:else if table && env && match && (view || ll)}
  <div class="table">
    <section class="game panel" aria-labelledby="game-title">
      <header class="bar top">
        <h1 id="game-title">{gameName}</h1>
        {#if ll}
          <span class="meta" data-testid="ll-clock">round {ll.round}, {(ll.roundTick / 10).toFixed(1)} s</span>
        {:else if view}
          <span class="meta">turn {view.moveCount + 1} · {view.cols}×{view.rows}</span>
        {/if}
        <span class="meta watching">Watching: {table.watching}</span>
        <a class="rules" href="/games">Rules</a>
      </header>

      {#if ll}
        <div class="stage ll">
          <div class="boardwrap">
            <LightlineBoard view={ll} {colors} seats={match.seats} fired={env.realtime?.fired ?? {}} you={mySeat} countdown={countdown !== null} {pressed} onSteer={steerable ? (k) => steer(env!.match.id, k) : null} />
            {#if countdown !== null}<div class="countdown" aria-hidden="true">{countdown || 'Go'}</div>{/if}
          </div>
          {#if steerable && countdown !== null}
            <p class="hint" data-testid="steer-hint">{coarse ? 'Swipe to steer · Tap to boost' : 'Arrows or WASD to steer · Space to boost'}</p>
          {/if}
        </div>
      {/if}
      {#if view}
      <div class="stage" style:--board-w="calc(68dvh * {view.cols} / {view.rows})">
        {#snippet card(s: SeatInfo, side: 'left' | 'right')}
          {@const out = view.eliminated.includes(s.seat)}
          {@const onClock = match.toMove.includes(s.seat)}
          {@const count = view.counts[s.seat] ?? { cells: 0, orbs: 0 }}
          {@const human = s.identity.kind === 'human'}
          <div class="player {side}" class:out class:onclock={onClock} style:--seat={colorOf(colors, s.seat)}>
            <Avatar kind={s.identity.kind} size="4.5rem" glow={onClock && !out} />
            <div class="id">
              <span class="name"><IdentityChip identity={s.identity} badge={false} tag={false} /></span>
              <span class="role">
                {[s.seat === mySeat ? 'you' : s.identity.isHouse ? 'house' : '', human ? 'human' : 'machine'].filter(Boolean).join(' · ')}
              </span>
            </div>
            <p class="orbs"><span class="swatch" aria-hidden="true"></span><b>{count.orbs}</b> {count.orbs === 1 ? 'orb' : 'orbs'}</p>
            <p class="cells">{count.cells} {count.cells === 1 ? 'cell' : 'cells'} held</p>
            {#if out}
              <span class="pill">out</span>
            {:else if onClock && secondsLeft !== null}
              <span class="pill clock" class:low={secondsLeft <= 15} aria-label="{secondsLeft} seconds left">
                <span class="tick" aria-hidden="true"></span>{clock(secondsLeft)}
              </span>
            {:else if match.status === 'live'}
              <span class="pill">waiting</span>
            {/if}
          </div>
        {/snippet}

        <div class="side left">
          {#each sides.left as s (s.seat)}{@render card(s, 'left')}{/each}
        </div>
        <div class="boardwrap">
          <Board {view} {colors} legal={legalCells} interactive={myTurn && !busy} onMove={move} />
          {#if countdown !== null}<div class="countdown" aria-hidden="true">{countdown || 'Go'}</div>{/if}
        </div>
        <div class="side right">
          {#each sides.right as s (s.seat)}{@render card(s, 'right')}{/each}
        </div>
      </div>
      {/if}

      <footer class="bar bottom">
        <p class="status" role="status">
          <span class="lead">{status.lead}</span>
          {#if status.detail}<span class="detail">{status.detail}</span>{/if}
        </p>
        {#if error}<p class="error" role="alert">{error}</p>{/if}
        {#if mySeat && !iAmOut && (match.status === 'live' || match.status === 'countdown')}
          <div class="actions">
            {#if confirmResign}
              <span>Resign this match?</span>
              <button class="btn" type="button" onclick={resign}>Yes, resign</button>
              <button class="btn quiet" type="button" onclick={() => (confirmResign = false)}>Keep playing</button>
            {:else}
              <button class="btn quiet" type="button" onclick={() => (confirmResign = true)}>Resign</button>
            {/if}
          </div>
        {/if}
      </footer>
    </section>

    <div class="talk">
      <ChatPanel
        channel={tab === 'table' ? tableChannel(table.id) : tab === 'rail' ? railChannel(table.id) : tab}
        title={tab === 'table' ? 'Table talk' : tab === 'rail' ? 'The rail' : `@${dmTab?.with.handle ?? ''}`}
        readOnly={(tab === 'table' && !isPlayer) || !!dmTab?.with.released}
        readOnlyNote={dmTab ? 'This name was given back; nobody will read this.' : 'Only the players can talk at this table.'}
        placeholder={tab === 'table' ? 'Talk trash, play fair' : tab === 'rail' ? 'Cheer, heckle, speculate' : `Message @${dmTab?.with.handle ?? ''}`}
        {focusKey}
      >
        {#snippet header()}
          <div>
            <div class="tabs" role="tablist" aria-label="Chat">
              <button role="tab" type="button" aria-selected={tab === 'table'} onclick={() => (tab = 'table')}>Table</button>
              <button role="tab" type="button" aria-selected={tab === 'rail'} onclick={() => (tab = 'rail')}
                >{railUnread > 0 ? `Rail (${railUnread})` : 'Rail'}</button
              >
            </div>
            <DmTabs active={dmTab ? tab : null} onpick={(c) => (tab = c ?? (isPlayer ? 'table' : 'rail'))} />
          </div>
        {/snippet}
      </ChatPanel>
    </div>
  </div>

  {#if match.status === 'over'}
    <div class="verdict panel" role="dialog" aria-labelledby="verdict-title">
      <h2 id="verdict-title" bind:this={verdictHeading} tabindex="-1">{verdict}</h2>
      <p>{REASONS[match.endReason ?? ''] ?? match.endReason}</p>
      {#if regathering && table.status === 'forming'}
        <GatheringCard {table} />
      {/if}
      {#if mySeat && live.me && live.me.kind === 'human' && !live.me.locked && verdict === 'You win.'}
        <p class="note">Lock in @{live.me.handle} to put this win on the board. <a href="/u/{live.me.handle}">Lock your name</a></p>
      {/if}
      {#if live.queued}
        <p class="waiting" role="status">Looking for an opponent. If nobody turns up in a few seconds, a house machine sits down.</p>
      {/if}
      {#if !regathering}<div class="row">
        {#if live.queued}
          <button class="btn" type="button" onclick={stopLooking}>Stop looking</button>
        {:else}
          {#if isPlayer && table.status === 'finished'}
            <button class="btn primary" type="button" onclick={rematch}>Rematch</button>
          {/if}
          <button class="btn" type="button" onclick={again}>Find a match</button>
        {/if}
        <!-- Leaving the table calls off a search started here, so no match starts behind your back. -->
        <a class="btn" href="/" onclick={() => live.queued && void stopLooking()}>Back to the lobby</a>
      </div>{/if}
      {#if table.status === 'forming' && !regathering}
        <p class="note">@{table.host.handle} called a rematch.</p>
      {/if}
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
    gap: 1.25rem;
    height: calc(100dvh - var(--nav-h) - 1.5rem);
    min-height: 34rem;
  }
  .game {
    display: grid;
    grid-template-rows: auto minmax(0, 1fr) auto;
    min-width: 0;
  }
  .bar {
    display: flex;
    align-items: center;
    gap: 1rem;
    padding: 0.8rem 1.5rem;
  }
  .top {
    border-bottom: 1px solid var(--lattice);
  }
  h1 {
    margin: 0;
    font-size: var(--step-1);
    font-weight: 600;
  }
  .meta {
    color: var(--dust);
    font-family: var(--font-silicon);
    font-size: var(--step--1);
    font-variant-numeric: tabular-nums;
  }
  .rules {
    margin-left: auto;
    color: var(--fog);
    font-size: var(--step--1);
  }
  .stage.ll {
    display: block;
  }
  .stage.ll .boardwrap {
    width: 100%;
    max-width: calc(68dvh * 64 / 40);
    margin-inline: auto;
  }
  .stage {
    display: grid;
    /* The board's column is as wide as the board (Board.svelte sizes itself to 68dvh tall). */
    grid-template-columns: minmax(8rem, 1fr) minmax(0, var(--board-w)) minmax(8rem, 1fr);
    grid-template-areas: 'left board right';
    align-items: center;
    gap: 2rem;
    padding: 1.5rem;
    min-height: 0;
  }
  .side {
    display: flex;
    flex-direction: column;
    gap: 2.5rem;
    min-width: 0;
  }
  .side.left {
    grid-area: left;
  }
  .side.right {
    grid-area: right;
  }
  .player {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    min-width: 0;
  }
  .player.left {
    align-items: flex-end;
    text-align: right;
  }
  .player.right {
    align-items: flex-start;
  }
  .player.out {
    opacity: 0.45;
  }
  .player.out .name {
    text-decoration: line-through;
  }
  .id {
    display: grid;
    margin-top: 0.4rem;
    min-width: 0;
    max-width: 100%;
  }
  .name {
    font-size: var(--step-2);
    line-height: 1.2;
    min-width: 0;
    overflow: hidden;
  }
  .role {
    color: var(--fog);
    font-size: var(--step--1);
  }
  .orbs,
  .cells {
    margin: 0;
    color: var(--fog);
    font-size: var(--step--1);
  }
  .orbs {
    display: flex;
    align-items: baseline;
    gap: 0.4rem;
    margin-top: 0.6rem;
  }
  .orbs b {
    color: var(--chalk);
    font-family: var(--font-silicon);
    font-size: var(--step-3);
    font-weight: 500;
    line-height: 1;
    font-variant-numeric: tabular-nums;
  }
  .swatch {
    align-self: center;
    width: 0.6rem;
    height: 0.6rem;
    border-radius: 50%;
    background: var(--seat);
    box-shadow: 0 0 0.5rem var(--seat);
  }
  .pill {
    display: inline-flex;
    align-items: center;
    gap: 0.45rem;
    margin-top: 0.6rem;
    padding: 0.3rem 0.8rem;
    border: 1px solid var(--lattice);
    border-radius: var(--r-control);
    color: var(--dust);
    font-size: var(--step--1);
  }
  .pill.clock {
    border-color: var(--seat);
    color: var(--chalk);
    font-family: var(--font-silicon);
    font-size: var(--step-1);
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }
  .pill.clock.low {
    border-color: var(--danger);
    color: var(--danger);
  }
  .tick {
    width: 0.45rem;
    height: 0.45rem;
    border-radius: 50%;
    background: currentColor;
    animation: pulse 1s ease-in-out infinite;
  }
  .pill.clock:not(.low) .tick {
    background: var(--seat);
  }
  @keyframes pulse {
    50% {
      opacity: 0.3;
    }
  }
  .boardwrap {
    grid-area: board;
    position: relative;
    display: grid;
    place-items: center;
    min-width: 0;
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
  .hint {
    margin: 0.5rem 0 0;
    text-align: center;
    color: var(--fog);
    font-size: var(--step--1);
  }
  .bottom {
    flex-wrap: wrap;
    min-height: 4.5rem;
    border-top: 1px solid var(--lattice);
  }
  .status {
    margin: 0;
    flex: 1;
    min-width: 12rem;
  }
  .lead {
    font-weight: 500;
    margin-right: 0.8rem;
  }
  .detail {
    color: var(--fog);
  }
  .bottom .error {
    margin: 0;
  }
  .actions {
    display: flex;
    gap: 0.5rem;
    align-items: center;
    margin-left: auto;
  }
  .actions .btn.quiet {
    border-color: var(--lattice);
  }
  .talk {
    min-height: 0;
    padding-bottom: var(--lattice-room);
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
  .verdict .waiting {
    color: var(--chalk);
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
    font-size: var(--step-3);
    margin-top: 0;
  }
  .loading {
    color: var(--fog);
    text-align: center;
    margin-top: 4rem;
  }
  @media (max-width: 1180px) {
    .stage {
      gap: 1.25rem;
    }
    .name {
      font-size: var(--step-1);
    }
  }
  @media (max-width: 960px) {
    .table {
      grid-template-columns: minmax(0, 1fr);
      height: auto;
    }
    .bar {
      padding: 0.75rem 1rem;
    }
    .stage {
      grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
      grid-template-areas: 'left right' 'board board';
      padding: 1rem;
      gap: 1rem;
    }
    .side {
      gap: 0.75rem;
    }
    /* Compact cards: tile beside the name, stats underneath. */
    .player {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr);
      column-gap: 0.6rem;
      row-gap: 0.1rem;
      align-items: center;
    }
    .player.left {
      text-align: left;
    }
    .player :global(.avatar) {
      --size: 2.75rem !important;
    }
    .id {
      margin: 0;
    }
    .orbs,
    .cells,
    .pill {
      grid-column: 1 / -1;
      margin: 0;
    }
    .orbs {
      margin-top: 0.3rem;
    }
    .orbs b {
      font-size: var(--step-2);
    }
    .pill {
      justify-self: start;
    }
    .talk {
      height: 55dvh;
      padding-bottom: 0;
    }
  }
  .watching {
    margin-left: 0.25rem;
  }
  .tabs {
    display: flex;
    gap: 0.25rem;
    padding: 0.6rem 0.75rem 0;
    border-bottom: 1px solid var(--lattice);
  }
  .tabs button {
    padding: 0.5rem 0.75rem 0.55rem;
    background: none;
    border: 0;
    border-bottom: 2px solid transparent;
    color: var(--fog);
    font-weight: 500;
  }
  .tabs button[aria-selected='true'] {
    color: var(--chalk);
    border-bottom-color: var(--carbon);
  }
</style>
