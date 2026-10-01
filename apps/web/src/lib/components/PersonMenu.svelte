<script lang="ts">
  import { tick } from 'svelte';
  import type { GroupInfo, IdentityPublic } from '@cs/shared/protocol';
  import { api } from '$lib/api';
  import { groupTitle } from '$lib/groups';
  import { live } from '$lib/live.svelte';
  import { portal } from '$lib/portal';
  import { hostWith, inviteHandle } from '$lib/table-actions';
  import { inviteChoice } from '$lib/tables';
  import IdentityChip from './IdentityChip.svelte';

  /** `inline`: an @mention inside a chat line rather than a name chip. */
  let { identity, inline = false }: { identity: IdentityPublic; inline?: boolean } = $props();

  let open = $state(false);
  /** Where the popover sits, in viewport pixels; null while it is measured. */
  let pos = $state<{ left: number; top: number } | null>(null);
  let note = $state('');
  let error = $state('');
  let root: HTMLSpanElement | undefined = $state();
  let trigger: HTMLButtonElement | undefined = $state();
  let pop: HTMLDivElement | undefined = $state();
  let firstItem: HTMLElement | undefined = $state();
  /** The open flyout, and where it sits (beside the menu; in place of it on a phone). */
  let sub = $state<'chat' | 'game' | null>(null);
  let subPos = $state<{ left: number; top: number } | null>(null);
  let subPop: HTMLDivElement | undefined = $state();
  /** A phone has no room beside the menu: a flyout replaces it, with a way back. */
  let inPlace = $state(false);
  const subTriggers: Record<'chat' | 'game', HTMLElement | undefined> = $state({ chat: undefined, game: undefined });

  const status = $derived(live.presence.find((p) => p.identity.id === identity.id)?.status ?? null);
  const choice = $derived(inviteChoice(identity, { me: live.me, status, myTable: live.myTable, catalog: live.games }));
  /** While you host, names you could invite show a small + on hover. */
  const hint = $derived(choice?.kind === 'invite' && !choice.disabled);
  const isMe = $derived(live.me?.id === identity.id);
  /** You block them: say so rather than offering a chat that will bounce. */
  const blocking = $derived(live.relations.blocks.some((b) => b.id === identity.id));
  const ignoring = $derived(live.relations.ignores.some((b) => b.id === identity.id));

  type ChatTarget = { channel: string; label: string; full: string | null; invite: () => Promise<void> };
  /** Your chats they could join: groups they're not in (full ones say so) and 1-on-1s with anyone else, which become a
   *  group of three. The one on screen leads. */
  const chats = $derived.by((): ChatTarget[] => {
    const me = live.me;
    if (!me) return [];
    const handle = identity.handle;
    const groups = live.groups
      .filter((g) => !g.members.some((m) => m.identity.id === identity.id))
      .map((g) => ({
        channel: g.channel,
        label: groupTitle(g, me.id),
        full: g.members.length >= g.maxMembers ? `Full (${g.members.length}/${g.maxMembers})` : null,
        invite: async () => live.putGroup((await api<{ group: GroupInfo }>('POST', `/api/groups/${g.id}/members`, { handle })).group),
      }));
    const dms = live.dms
      .filter((d) => !d.hidden && d.with.id !== identity.id && !d.with.released)
      .map((d) => ({
        channel: d.channel,
        label: `@${d.with.handle}`,
        full: null,
        invite: async () => live.openGroup((await api<{ group: GroupInfo }>('POST', '/api/groups', { with: [d.with.handle, handle] })).group),
      }));
    const all = [...groups, ...dms];
    const here = all.findIndex((c) => c.channel === live.openConv);
    return here > 0 ? [all[here], ...all.slice(0, here), ...all.slice(here + 1)] : all;
  });
  /** Seated somewhere that isn't your gathering table: nothing to invite to until you're free. */
  const atTable = $derived(!choice && !!live.myTable && !identity.released);

  function chatWith() {
    open = false; // no refocus on the name: the composer takes focus
    live.openDm(identity);
  }

  async function show() {
    if (isMe || !live.me) return;
    open = true;
    pos = null;
    note = '';
    error = '';
    sub = null;
    inPlace = window.innerWidth < 560;
    await tick();
    place();
    firstItem?.focus();
  }
  /** The popover lives on <body>, fixed to the viewport, so neither a scrolling list (Here now) nor the
   *  page's stacking layer can cut it off or bury it under the corner dock. It hangs
   *  under the name, slides left to stay on screen, and opens upward when there's no room below. */
  function place() {
    if (!pop || !trigger) return;
    const t = trigger.getBoundingClientRect();
    const p = pop.getBoundingClientRect();
    const gap = 5;
    const left = Math.max(8, Math.min(t.left, window.innerWidth - p.width - 8));
    const fitsBelow = t.bottom + gap + p.height <= window.innerHeight - 8;
    pos = { left, top: fitsBelow ? t.bottom + gap : Math.max(8, t.top - gap - p.height) };
    placeSub();
  }
  /** Beside its item: to the right, or to the left when the right edge is too close. */
  function placeSub() {
    if (!sub || inPlace || !pop || !subPop) return;
    const item = subTriggers[sub]?.getBoundingClientRect();
    const menu = pop.getBoundingClientRect();
    const p = subPop.getBoundingClientRect();
    if (!item) return;
    const right = menu.right + 4;
    const left = right + p.width <= window.innerWidth - 8 ? right : Math.max(8, menu.left - 4 - p.width);
    subPos = { left, top: Math.max(8, Math.min(item.top - 6, window.innerHeight - p.height - 8)) };
  }
  async function openSub(which: 'chat' | 'game', focus: boolean) {
    if (sub === which && !focus) return;
    sub = which;
    subPos = null;
    await tick();
    placeSub();
    // Focus only once it's placed: until then it's visibility:hidden, and hidden elements can't take focus.
    await tick();
    if (focus) subPop?.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')?.focus();
  }
  function closeSub(refocus: boolean) {
    const was = sub;
    sub = null;
    if (refocus && was) void tick().then(() => subTriggers[was]?.focus());
  }
  function close() {
    open = false;
    sub = null;
    trigger?.focus();
  }
  $effect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!root?.contains(t) && !pop?.contains(t) && !subPop?.contains(t)) {
        open = false;
        sub = null;
      }
    };
    // The popover is fixed, so it follows its name when anything scrolls (the Here now list shifts as
    // people come and go) or the window resizes.
    let frame = 0;
    const onMove = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(place);
    };
    document.addEventListener('pointerdown', onDown);
    window.addEventListener('scroll', onMove, true);
    window.addEventListener('resize', onMove);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      window.removeEventListener('scroll', onMove, true);
      window.removeEventListener('resize', onMove);
      cancelAnimationFrame(frame);
    };
  });
  /** Arrow keys walk the menu that has focus; → opens a flyout, ← or Esc steps back out of one. */
  function onKey(e: KeyboardEvent) {
    if (!open) return;
    const inSub = !!subPop?.contains(document.activeElement);
    const menuEl = inSub ? subPop : pop;
    if (e.key === 'Escape') {
      e.preventDefault();
      if (sub) closeSub(true);
      else close();
    } else if (e.key === 'ArrowLeft' && inSub) {
      e.preventDefault();
      closeSub(true);
    } else if (e.key === 'ArrowRight' && !inSub) {
      const which = (Object.keys(subTriggers) as ('chat' | 'game')[]).find((k) => subTriggers[k] === document.activeElement);
      if (which) {
        e.preventDefault();
        void openSub(which, true);
      }
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const list = [...(menuEl?.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)') ?? [])];
      if (list.length === 0) return;
      e.preventDefault();
      const i = list.indexOf(document.activeElement as HTMLElement);
      list[e.key === 'ArrowDown' ? (i + 1) % list.length : (i - 1 + list.length) % list.length].focus();
    }
  }
  /** An invite shows up on your gathering card, so the menu just gets out of the way; ignore and
   *  block have nothing else to show, so the menu turns into their confirmation (like MessageMenu). */
  async function run(fn: () => Promise<unknown>, done: string | null) {
    error = '';
    try {
      await fn();
      if (done === null) close();
      else {
        sub = null;
        note = done;
      }
    } catch (e) {
      error = (e as Error).message;
    }
  }
</script>

<svelte:window onkeydown={onKey} />

{#snippet chatList()}
  {#each chats as c (c.channel)}
    <button role="menuitem" type="button" disabled={!!c.full} onclick={() => run(c.invite, null)}
      >{c.label}{#if c.channel === live.openConv}<span class="why"> · this chat</span>{/if}{#if c.full}<span class="why"> {c.full}</span>{/if}</button
    >
  {:else}
    <button role="menuitem" type="button" disabled>No chats yet</button>
  {/each}
{/snippet}
{#snippet gameList()}
  {#if choice?.kind === 'host'}
    {#each choice.games as g (g.id)}
      <button role="menuitem" type="button" onclick={() => run(() => hostWith(g.id, [identity.handle]), null)}>Host {g.name}</button>
    {/each}
  {/if}
{/snippet}

<span class="pm" bind:this={root}>
  <button
    bind:this={trigger}
    type="button"
    class="who"
    class:inline
    aria-haspopup="menu"
    aria-expanded={open}
    disabled={isMe}
    onclick={() => (open ? close() : void show())}
    oncontextmenu={(e) => {
      e.preventDefault();
      void show();
    }}
  >
    {#if inline}<span class="at">@{identity.handle}</span>{:else}<IdentityChip {identity} badge={false} />{/if}
    {#if hint}<span class="plus" aria-hidden="true">+</span>{/if}
  </button>
  {#if open}
    <div class="pop panel" use:portal bind:this={pop} style={pos ? `left: ${pos.left}px; top: ${pos.top}px` : 'visibility: hidden'}>
      {#if identity.ownerHandle}<p class="owner">assistant of <a href="/u/{identity.ownerHandle}">@{identity.ownerHandle}</a></p>{/if}
      {#if note}
        <p role="status">{note}</p>
      {:else if sub && inPlace}
        <!-- A phone: the flyout takes the menu's place. -->
        <div role="menu" aria-label={sub === 'chat' ? 'Chat invite' : 'Game invite'} bind:this={subPop}>
          <button role="menuitem" type="button" class="back" onclick={() => closeSub(true)}>‹ Back</button>
          {#if sub === 'chat'}{@render chatList()}{:else}{@render gameList()}{/if}
        </div>
      {:else}
      <div role="menu" aria-label="@{identity.handle}">
        {#if !identity.released}
          <button bind:this={firstItem} role="menuitem" type="button" disabled={blocking} onpointerenter={() => (sub = null)} onclick={chatWith}
            >Chat with @{identity.handle}{#if blocking}<span class="why"> — you block them</span>{/if}</button
          >
        {/if}
        <a role="menuitem" href="/u/{identity.handle}" onpointerenter={() => (sub = null)}>View @{identity.handle}'s profile</a>
        <div role="separator"></div>
        <button role="menuitem" type="button" onpointerenter={() => (sub = null)}
          onclick={() => run(() => live.setRelation(identity.handle, 'ignore', !ignoring), ignoring ? `Stopped ignoring @${identity.handle}.` : `Ignoring @${identity.handle}.`)}
          >{ignoring ? 'Stop ignoring' : 'Ignore'} @{identity.handle}</button
        >
        <button role="menuitem" type="button" onpointerenter={() => (sub = null)}
          onclick={() => run(() => live.setRelation(identity.handle, 'block', !blocking), blocking ? `Unblocked @${identity.handle}.` : `Blocked @${identity.handle}.`)}
          >{blocking ? 'Unblock' : 'Block'} @{identity.handle}</button
        >
        {#if !identity.released}
          <div role="separator"></div>
          <button role="menuitem" type="button" class="fly" aria-haspopup="menu" aria-expanded={sub === 'chat'} bind:this={subTriggers.chat}
            onpointerenter={() => !inPlace && openSub('chat', false)} onclick={() => openSub('chat', true)}>Chat invite</button
          >
          {#if choice?.kind === 'invite'}
            <button role="menuitem" type="button" disabled={!!choice.disabled} onpointerenter={() => (sub = null)} onclick={() => run(() => inviteHandle(identity.handle), null)}
              >{choice.label}{#if choice.disabled}<span class="why"> — {choice.disabled}</span>{/if}</button
            >
          {:else if choice?.kind === 'host'}
            <button role="menuitem" type="button" class="fly" aria-haspopup="menu" aria-expanded={sub === 'game'} bind:this={subTriggers.game}
              onpointerenter={() => !inPlace && openSub('game', false)} onclick={() => openSub('game', true)}>Game invite</button
            >
          {:else if atTable}
            <button role="menuitem" type="button" disabled>Game invite<span class="why"> — you're at a table</span></button>
          {/if}
        {/if}
      </div>
      {/if}
      {#if error}<p class="error" role="alert">{error}</p>{/if}
    </div>
    {#if sub && !inPlace && !note}
      <div class="pop panel sub" use:portal bind:this={subPop} role="menu" aria-label={sub === 'chat' ? 'Chat invite' : 'Game invite'}
        style={subPos ? `left: ${subPos.left}px; top: ${subPos.top}px` : 'visibility: hidden'}>
        {#if sub === 'chat'}{@render chatList()}{:else}{@render gameList()}{/if}
      </div>
    {/if}
  {/if}
</span>

<style>
  .owner {
    color: var(--fog);
    border-bottom: 1px solid var(--lattice);
  }
  .pm {
    position: relative;
    display: inline-block;
    min-width: 0;
  }
  .who {
    display: inline-flex;
    align-items: baseline;
    gap: 0.3rem;
    max-width: 100%;
    padding: 0;
    border: 0;
    background: none;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  .who:disabled {
    cursor: default;
  }
  .at {
    color: var(--carbon);
  }
  .plus {
    color: var(--fog);
    opacity: 0;
  }
  .who:hover .plus,
  .who:focus-visible .plus {
    opacity: 1;
  }
  .pop {
    position: fixed;
    left: 0;
    top: 0;
    z-index: 30; /* over the corner dock (20) and the update banner (21): a menu you just opened comes first */
    width: min(17rem, 80vw);
    padding: 0.4rem;
    background: var(--panel-2);
    box-shadow: 0 0.8rem 2rem rgb(0 0 0 / 0.4);
  }
  [role='menu'] {
    display: grid;
  }
  [role='separator'] {
    height: 1px;
    margin: 0.3rem 0.4rem;
    background: rgb(255 255 255 / 0.12); /* --lattice disappears against the menu's own panel */
  }
  .fly::after {
    content: '▸';
    float: right;
    color: var(--fog);
  }
  .fly[aria-expanded='true'] {
    background: var(--panel);
  }
  .back {
    color: var(--fog);
  }
  .sub {
    width: min(15rem, 80vw);
  }
  [role='menuitem'] {
    display: block;
    text-align: left;
    padding: 0.5rem 0.65rem;
    border: 0;
    border-radius: var(--r-control);
    background: none;
    color: var(--chalk);
    text-decoration: none;
    font: inherit;
  }
  [role='menuitem']:hover:not(:disabled),
  [role='menuitem']:focus-visible {
    background: var(--panel);
  }
  [role='menuitem']:disabled {
    color: var(--dust);
  }
  .why {
    font-size: var(--step--1);
  }
  p {
    margin: 0;
    padding: 0.5rem;
    font-size: var(--step--1);
  }
</style>
