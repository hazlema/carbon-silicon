<script lang="ts">
  import { page } from '$app/state';
  import { tick, untrack } from 'svelte';
  import type { CheckersView } from '@cs/checkers';
  import type { CMView } from '@cs/critical-mass';
  import type { LLView } from '@cs/lightline';
  import { dmParticipants, groupOf, railChannel, tableChannel, type MatchEnvelope, type TableInfo } from '@cs/shared/protocol';
  import { api, ApiError } from '$lib/api';
  import ChatPanel from '$lib/components/ChatPanel.svelte';
  import ConvMenu from '$lib/components/ConvMenu.svelte';
  import ConvTabs from '$lib/components/ConvTabs.svelte';
  import { groupTitle } from '$lib/groups';
  import GatheringCard from '$lib/components/GatheringCard.svelte';
  import Board from '$lib/games/critical-mass/Board.svelte';
  import SeatCard from '$lib/games/critical-mass/SeatCard.svelte';
  import CrownBoard from '$lib/games/checkers/Board.svelte';
  import LightlineBoard from '$lib/games/lightline/Board.svelte';
  import { keyOf, typing, type SteerKey } from '$lib/games/lightline/controls';
  import { live } from '$lib/live.svelte';
  import { pollMatch } from '$lib/match-poll';
  import { colorOf, tableColors } from '$lib/seats';

  const REASONS: Record<string, string> = {
    'last-standing': 'Last one with orbs on the board.',
    resign: 'By resignation.',
    timeout: 'On time: three missed turns in a row.',
    overload: 'The board went critical.',
    rounds: 'On rounds: two round wins, or the best after three.',
    forfeit: 'By forfeit: everyone else resigned.',
    'last-piece': 'Every enemy knight has fallen.',
    'no-moves': 'No legal march remained.',
    repetition: 'The same position arose three times: an honorable draw.',
    'quiet-moves': 'Eighty marches without a capture or a crown: an honorable draw.',
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
  // Name menus offer the chat on screen first.
  $effect(() => {
    const ch = tab;
    live.openConv = ch;
    return () => {
      if (live.openConv === ch) live.openConv = null;
    };
  });
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
        // No socket for a guest: follow the match by short-poll instead, or the board would freeze.
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
  const groupTab = $derived(groupOf(tab) ? (live.groups.find((g) => g.channel === tab) ?? null) : null);
  const convTitle = $derived(groupTab ? groupTitle(groupTab, live.me!.id) : `@${dmTab?.with.handle ?? ''}`);
  $effect(() => {
    const r = live.convRequest;
    if (!r) return;
    tab = r.channel;
    focusKey += 1;
    live.convRequest = null;
  });
  // A conversation that left the list (closed elsewhere, the name released): back to where you were.
  $effect(() => {
    if ((dmParticipants(tab) && !dmTab) || (groupOf(tab) && !groupTab)) tab = isPlayer ? 'table' : 'rail';
  });
  $effect(() => {
    if (dmTab && dmTab.unread > 0) void live.readDm(dmTab.channel);
    if (groupTab && groupTab.unread > 0) void live.readGroup(groupTab.channel);
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
  const ck = $derived(env?.match.gameId === 'checkers' ? (env.view as CheckersView) : undefined);
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
    // The server drops presses in the countdown and the intermission; the server decides, but don't light up.
    if (countdown !== null || ll?.phase === 'intermission') return;
    pressed = key;
    clearTimeout(pressedTimer);
    pressedTimer = setTimeout(() => (pressed = null), 150);
  }
  $effect(() => {
    if (!steerable || !env) return;
    const id = env.match.id;
    const onKey = (e: KeyboardEvent) => {
      // Esc leaves the composer, so steering resumes.
      if (e.key === 'Escape' && typing(e.target)) {
        (e.target as HTMLElement).blur();
        return;
      }
      if (typing(e.target)) return;
      const key = keyOf(e);
      if (!key) return;
      e.preventDefault(); // arrows and Space would scroll the page
      // A focused button (Resign, Cancel) would take Space as a click.
      if (document.activeElement instanceof HTMLButtonElement) document.activeElement.blur();
      steer(id, key);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
  // The chat composer keeps focus after a send; when the match goes live and at each round's start the keys
  // must steer, not move the text cursor. Keyed on primitives only: `match` and `ll` are new objects every
  // frame, and an effect reading them would blur the composer ten times a second.
  const matchStatus = $derived(match?.status);
  const llRound = $derived(ll?.round);
  const llPhase = $derived(ll?.phase);
  $effect(() => {
    const go = steerable && matchStatus === 'live' && llPhase === 'play';
    void llRound;
    if (!go) return;
    untrack(() => {
      const el = document.activeElement;
      if (typing(el)) (el as HTMLElement).blur();
    });
  });
  const myTurn = $derived(!!match && match.status === 'live' && !!mySeat && match.toMove.includes(mySeat));
  const legalCells = $derived((env?.legal ?? []).map((l) => (l as { cell: string }).cell));
  const secondsLeft = $derived(match?.deadline ? Math.max(0, Math.ceil((Date.parse(match.deadline) - now) / 1000)) : null);
  const countdown = $derived(
    match?.status === 'countdown' ? Math.max(0, Math.ceil((Date.parse(match.startsAt) - now) / 1000)) : null,
  );
  /** Crown & Steel's army cards carry the real commanders. */
  const ckPlayers = $derived(
    Object.fromEntries(
      (match?.seats ?? []).map((s) => [
        s.seat,
        { name: s.identity.handle, note: s.identity.isHouse ? 'house machine' : s.identity.kind === 'human' ? 'human' : 'machine' },
      ]),
    ),
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
      const anyHuman = match.seats.some((s) => s.identity.kind === 'human');
      const detail = ll.shrinking
        ? 'The arena is closing in.'
        : human && !iAmOut
          ? coarse ? 'You steer: swipe, tap to boost.' : 'You steer: arrows or WASD, Space to boost.'
          : anyHuman ? 'Humans steer; machines ride their doctrine.' : 'Machines at work: each rides its own doctrine.';
      return { lead: `Round ${ll.round}`, detail };
    }
    if (myTurn) return { lead: 'Your move.', detail: ck ? 'Select a knight, then a gold destination. Captures are mandatory.' : 'Place an orb on an empty cell or one of yours.' };
    return { lead: `Waiting for ${handleOf(match.toMove[0] ?? '')}…` };
  });
  const colors = $derived(tableColors(match?.seats ?? []));
  /** You first, then the rest in seat order: top-left, top-right, bottom-left, bottom-right. */
  const ordered = $derived.by(() => {
    const seats = match?.seats ?? [];
    return [...seats.filter((s) => s.seat === mySeat), ...seats.filter((s) => s.seat !== mySeat)];
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
    return moveCommand({ cell });
  }

  async function moveCommand(command: unknown) {
    if (!env || busy) return;
    busy = true;
    error = '';
    try {
      accept(await api<MatchEnvelope>('POST', `/api/matches/${env.match.id}/move`, { revision: env.match.revision, command }));
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
{:else if table && env && match && (view || ll || ck)}
  <div class="table">
    <section class="game panel" aria-labelledby="game-title">
      <header class="bar top">
        <h1 id="game-title">{gameName}</h1>
        {#if ll}
          <span class="meta" data-testid="ll-clock">round {ll.round}, {(ll.roundTick / 10).toFixed(1)} s</span>
        {:else if view}
          <span class="meta">turn {view.moveCount + 1} · {view.cols}×{view.rows}</span>
        {:else if ck}
          <span class="meta">march {ck.moveCount + 1} · {ck.cols}×{ck.rows}</span>
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
      {#if ck}
        <div class="stage ck">
          <div class="boardwrap">
            <CrownBoard view={ck} legal={env.legal} interactive={myTurn && !busy} onMove={moveCommand} players={ckPlayers} actions={tableActions} />
            {#if countdown !== null}<div class="countdown" aria-hidden="true">{countdown || 'Go'}</div>{/if}
          </div>
        </div>
      {/if}
      {#if view}
        <div class="stage cm">
          <div class="corners">
            {#each ordered as s, k (s.seat)}
              <SeatCard
                {s}
                color={colorOf(colors, s.seat)}
                you={s.seat === mySeat}
                onClock={match.toMove.includes(s.seat)}
                out={view.eliminated.includes(s.seat)}
                {secondsLeft}
                live={match.status === 'live'}
                count={view.counts[s.seat] ?? { cells: 0, orbs: 0 }}
                corner={(['tl', 'tr', 'bl', 'br'] as const)[k % 4]}
              />
            {/each}
          </div>
          <div class="boardwrap">
            <Board {view} {colors} legal={legalCells} interactive={myTurn && !busy} onMove={move} />
            {#if countdown !== null}<div class="countdown" aria-hidden="true">{countdown || 'Go'}</div>{/if}
          </div>
        </div>
      {/if}

      {#snippet tableActions()}
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
      {/snippet}
      <!-- Crown & Steel carries its own turn banner and takes these actions into its footer band. -->
      {#if !ck}
        <footer class="bar bottom">
          <p class="status" role="status">
            <span class="lead">{status.lead}</span>
            {#if status.detail}<span class="detail">{status.detail}</span>{/if}
          </p>
          {@render tableActions()}
        </footer>
      {/if}
    </section>

    <div class="talk">
      <ChatPanel
        channel={tab === 'table' ? tableChannel(table.id) : tab === 'rail' ? railChannel(table.id) : tab}
        title={tab === 'table' ? 'Table talk' : tab === 'rail' ? 'The rail' : convTitle}
        readOnly={(tab === 'table' && !isPlayer) || !!dmTab?.with.released}
        readOnlyNote={dmTab ? 'This name was given back; nobody will read this.' : 'Only the players can talk at this table.'}
        placeholder={tab === 'table' ? 'Talk trash, play fair' : tab === 'rail' ? 'Cheer, heckle, speculate' : `Message ${convTitle}`}
        {focusKey}
      >
        {#snippet header()}
          <div>
            <div class="tabbar">
            <div class="tabs" role="tablist" aria-label="Chat">
              <button role="tab" type="button" aria-selected={tab === 'table'} onclick={() => (tab = 'table')}>Table</button>
              <button role="tab" type="button" aria-selected={tab === 'rail'} onclick={() => (tab = 'rail')}
                >{railUnread > 0 ? `Rail (${railUnread})` : 'Rail'}</button
              >
              <ConvTabs active={dmTab || groupTab ? tab : null} onpick={(c) => (tab = c ?? (isPlayer ? 'table' : 'rail'))} />
            </div>
            <ConvMenu channel={tab} />
            </div>
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
  /* Crown & Steel stacks its own armies, field and footer; it fills the stage and the field takes the slack. */
  .stage.ck {
    display: block;
    padding: 0;
    overflow: hidden;
  }
  .stage.ck .boardwrap {
    display: block;
    width: 100%;
    height: 100%;
  }
  .stage {
    display: grid;
    align-items: center;
    gap: 2rem;
    padding: 1.5rem;
    min-height: 0;
  }
  /* Critical Mass: the board owns the stage; players float in its corners. */
  .stage.cm {
    position: relative;
    display: flex;
    flex-direction: column;
    align-items: stretch;
    padding: 0;
    min-height: 0;
    container-type: size;
  }
  .stage.cm .boardwrap {
    flex: 1;
    min-height: 0;
    display: block;
  }
  .corners {
    position: absolute;
    inset: 18px 18px 72px;
    z-index: 2;
    pointer-events: none;
  }
  .corners > :global(.seat) {
    position: absolute;
    max-width: calc(50% - 9px);
  }
  .corners > :global(.tl) { top: 0; left: 0; }
  .corners > :global(.tr) { top: 0; right: 0; }
  .corners > :global(.bl) { bottom: 0; left: 0; }
  .corners > :global(.br) { bottom: 0; right: 0; }
  @container (max-width: 560px) {
    .corners {
      position: static;
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
      padding: 10px 10px 0;
    }
    .corners > :global(.seat) {
      position: static;
      max-width: none;
    }
  }
  .boardwrap {
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
  @media (max-width: 960px) {
    .table {
      grid-template-columns: minmax(0, 1fr);
      height: auto;
    }
    .bar {
      padding: 0.75rem 1rem;
    }
    .stage.cm {
      height: clamp(30rem, min(85dvh, calc(100vw + 10rem)), 52rem);
    }
    /* Narrow, the board is width-bound: the stage is as tall as the width needs, plus the cards and footer. */
    .stage.ck {
      height: clamp(32rem, min(88dvh, calc(100vw + 16rem)), 60rem);
    }
    .talk {
      height: 55dvh;
      padding-bottom: 0;
    }
  }
  .watching {
    margin-left: 0.25rem;
  }
  /* The chat's tab line with the conversation's ⋯ at its end. */
  .tabbar {
    display: flex;
    align-items: stretch;
    border-bottom: 1px solid var(--lattice);
  }
  .tabbar .tabs {
    flex: 1;
    border-bottom: 0;
  }
  .tabs {
    display: flex;
    gap: 0.25rem;
    flex-wrap: nowrap;
    min-width: 0;
    overflow-x: auto;
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
