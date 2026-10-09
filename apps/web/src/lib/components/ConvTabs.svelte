<script lang="ts">
  import { tick, untrack } from 'svelte';
  import { BUBBLE_MS, bubbleArrival, bubbleText, withArrival, type Arrival } from '$lib/bubble';
  import { convTabs, convUnread, groupTitle, type Conv } from '$lib/groups';
  import ChatBubble from './ChatBubble.svelte';
  import { live } from '$lib/live.svelte';
  import { portal } from '$lib/portal';

  /** The conversations inline with a chat header's own tabs (spec M2c §5, M2d §1): buttons marked aria-current.
   *  Renders nothing until a conversation is visible. `onpick(null)` means "back to where you were":
   *  the open tab closed.
   *  `hide`: conversations kept off the row (a table's residents during a match: their lines show inline), unless on screen.
   *  A line from someone else in a conversation you aren't looking at pops a speech balloon at its tab ("💬 New message
   *  from @x!"), until you open it or BUBBLE_MS pass. `seen`: whether the chat is on screen at all (a phone's closed
   *  sheet, the lobby's Here now); `bubbleAt`: point the balloon there instead (the chat button, the Chat tab), with
   *  `bubbleSide`; `onbubble`: what a click on the balloon does (defaults to picking the tab). */
  let {
    active,
    onpick,
    hide,
    seen = true,
    bubbleAt,
    bubbleSide = 'below',
    onbubble,
  }: {
    active: string | null;
    onpick: (channel: string | null) => void;
    hide?: ReadonlySet<string>;
    seen?: boolean;
    bubbleAt?: HTMLElement | null;
    bubbleSide?: 'below' | 'left';
    onbubble?: (channel: string) => void;
  } = $props();

  const row = $derived(convTabs(hide?.size ? live.dms.filter((d) => d.channel === active || !hide.has(d.channel)) : live.dms, live.groups, active));
  const titleOf = (c: Conv) => (c.kind === 'dm' ? `@${c.dm.with.handle}` : groupTitle(c.group, live.me?.id ?? ''));
  let moreOpen = $state(false);
  let moreButton: HTMLButtonElement | undefined = $state();
  let pop: HTMLDivElement | undefined = $state();
  let pos = $state<{ left: number; top: number } | null>(null);

  function close(c: Conv) {
    void (c.kind === 'dm' ? live.closeDm(c.channel) : live.closeGroup(c.channel));
    if (active === c.channel) onpick(null);
  }
  function closeMore(refocus = false) {
    moreOpen = false;
    if (refocus) moreButton?.focus();
  }
  const items = () => [...(pop?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
  function onMenuKey(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeMore(true);
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const list = items();
      if (list.length === 0) return;
      const i = list.indexOf(document.activeElement as HTMLElement);
      const next = e.key === 'ArrowDown' ? (i + 1) % list.length : (i - 1 + list.length) % list.length;
      list[next].focus();
    }
  }
  // Nothing left to fold: nothing to show.
  $effect(() => {
    if (moreOpen && row.more.length === 0) moreOpen = false;
  });
  async function toggleMore() {
    moreOpen = !moreOpen;
    pos = null;
    if (!moreOpen) return;
    await tick();
    if (!moreButton || !pop) return;
    // The lobby's channel row scrolls sideways, which would clip a dropdown: it lives on <body>.
    const b = moreButton.getBoundingClientRect();
    const p = pop.getBoundingClientRect();
    pos = { left: Math.max(8, Math.min(b.left, window.innerWidth - p.width - 8)), top: b.bottom + 4 };
    await tick(); // the popover turns visible once `pos` lands; a hidden item can't take focus
    items()[0]?.focus();
  }
  // ── The "new message" balloon.
  let arrivals = $state<Arrival[]>([]);
  const target = $derived(arrivals.at(-1)?.channel ?? null);
  const groupLabel = (ch: string) => {
    const g = live.groups.find((x) => x.channel === ch);
    return g ? `#${g.name ?? groupTitle(g, live.me?.id ?? '').replace(/^you, /, '')}` : null;
  };
  $effect(() =>
    live.onConversation((m) => {
      const a = bubbleArrival(m, { meId: live.me?.id ?? null, hidden: live.hiddenAuthors, open: seen ? active : null, hide, groupLabel });
      if (a) arrivals = withArrival(untrack(() => arrivals), a);
    }),
  );
  // Ten seconds from the latest line it tells of.
  $effect(() => {
    if (arrivals.length === 0) return;
    const t = setTimeout(() => (arrivals = []), BUBBLE_MS);
    return () => clearTimeout(t);
  });
  // Opening a conversation (its tab, a toast, a name menu) settles its lines.
  $effect(() => {
    const open = seen ? active : null;
    if (open && untrack(() => arrivals).some((a) => a.channel === open)) arrivals = untrack(() => arrivals).filter((a) => a.channel !== open);
  });
  let row_: HTMLDivElement | undefined = $state();
  /** What the balloon points at: the given spot, else its conversation's tab, else More (it's folded there). Found
   *  after the row has rendered (a tab that just opened is in the DOM by then). */
  let bubbleAnchor = $state<HTMLElement | null>(null);
  $effect(() => {
    const ch = target;
    const { shown, more } = row;
    void shown;
    bubbleAnchor = !ch
      ? null
      : (bubbleAt ?? row_?.querySelector<HTMLElement>(`[data-channel="${CSS.escape(ch)}"]`) ?? (more.some((c) => c.channel === ch) ? (moreButton ?? null) : null));
  });
  function openBubble() {
    const ch = target;
    arrivals = [];
    if (ch) (onbubble ?? onpick)(ch);
  }
  $effect(() => {
    if (!moreOpen) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!moreButton?.contains(t) && !pop?.contains(t)) moreOpen = false;
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  });
</script>

{#snippet label(c: Conv, showDot: boolean)}
  {@const unread = convUnread(c)}
  {#if c.kind === 'dm'}<span class="at" style:color={c.dm.with.color}>@{c.dm.with.handle}</span>{:else}<span class="grp" aria-hidden="true">⁂</span><span class="at"
      >{groupTitle(c.group, live.me?.id ?? '')}</span
    >{/if}{#if showDot && unread > 0}<span class="dot" role="img" aria-label="{unread} unread"></span>{/if}
{/snippet}

{#if row.shown.length > 0}
  <div class="dmrow" aria-label="Conversations" role="group" bind:this={row_}>
    {#each row.shown as c (c.channel)}
      <span class="dm">
        <button
          type="button"
          class="pick"
          data-channel={c.channel}
          title={titleOf(c)}
          aria-current={active === c.channel ? 'true' : undefined}
          onclick={() => onpick(c.channel)}>{@render label(c, active !== c.channel)}</button
        >
        <button
          type="button"
          class="x"
          aria-label={c.kind === 'dm' ? `Close the conversation with @${c.dm.with.handle}` : `Close the group ${titleOf(c)}`}
          onclick={() => close(c)}>×</button
        >
      </span>
    {/each}
    {#if row.more.length > 0}
      <button bind:this={moreButton} type="button" class="pick more" aria-haspopup="menu" aria-expanded={moreOpen} onclick={toggleMore}
        >More<span aria-hidden="true"> ▾</span>{#if row.more.some((c) => convUnread(c) > 0)}<span class="dot" role="img" aria-label="unread in More"></span>{/if}</button
      >
      {#if moreOpen}
        <div
          class="pop panel"
          role="menu"
          tabindex="-1"
          aria-label="More conversations"
          use:portal
          bind:this={pop}
          onkeydown={onMenuKey}
          style={pos ? `left: ${pos.left}px; top: ${pos.top}px` : 'visibility: hidden'}
        >
          {#each row.more as c (c.channel)}
            <button
              role="menuitem"
              type="button"
              title={titleOf(c)}
              onclick={() => {
                closeMore();
                onpick(c.channel);
              }}>{@render label(c, true)}</button
            >
          {/each}
        </div>
      {/if}
    {/if}
  </div>
{/if}
<ChatBubble text={bubbleText(arrivals)} anchor={bubbleAnchor} place={bubbleAt ? bubbleSide : 'below'} onopen={openBubble} />

<style>
  .dmrow {
    display: flex;
    flex: none;
    align-items: stretch;
  }
  .dm {
    display: inline-flex;
    align-items: stretch;
    flex: none;
  }
  .at {
    display: inline-block;
    max-width: 14ch;
    overflow: hidden;
    text-overflow: ellipsis;
    vertical-align: bottom;
  }
  .grp {
    margin-right: 0.3rem;
    color: var(--dust);
  }
  .pick {
    padding: 0.45rem 0.2rem 0.5rem 0.25rem;
    font-size: var(--step--1);
    background: none;
    border: 0;
    border-bottom: 2px solid transparent;
    color: var(--fog);
    font-weight: 500;
    white-space: nowrap;
  }
  .pick.more {
    flex: none;
    padding-left: 0.5rem;
    padding-right: 0.5rem;
  }
  .pick:hover {
    color: var(--chalk);
  }
  .pick[aria-current='true'] {
    color: var(--chalk);
    border-bottom-color: var(--carbon);
  }
  .dot {
    display: inline-block;
    width: 0.45rem;
    height: 0.45rem;
    margin-left: 0.35rem;
    border-radius: 50%;
    background: var(--carbon);
    vertical-align: middle;
  }
  .x {
    padding: 0 0.5rem 0 0.15rem;
    background: none;
    border: 0;
    color: var(--dust);
    font-size: var(--step-0);
  }
  .x:hover {
    color: var(--chalk);
  }
  .pop {
    position: fixed;
    z-index: 30;
    display: grid;
    min-width: 12rem;
    padding: 0.4rem;
    background: var(--panel-2);
    box-shadow: 0 0.8rem 2rem rgb(0 0 0 / 0.4);
  }
  [role='menuitem'] {
    padding: 0.5rem 0.65rem;
    border: 0;
    border-radius: var(--r-control);
    background: none;
    text-align: left;
    font: inherit;
  }
  [role='menuitem']:hover,
  [role='menuitem']:focus-visible {
    background: var(--panel);
  }
</style>
