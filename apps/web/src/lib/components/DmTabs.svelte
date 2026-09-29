<script lang="ts">
  import { tick } from 'svelte';
  import { dmTabs } from '$lib/dms';
  import { live } from '$lib/live.svelte';
  import { portal } from '$lib/portal';

  /** The conversations row under a chat header's own tabs (spec M2c §5): buttons marked aria-current.
   *  Renders nothing until a conversation is visible. `onpick(null)` means "back to where you were":
   *  the open tab closed. */
  let { active, onpick }: { active: string | null; onpick: (channel: string | null) => void } = $props();

  const row = $derived(dmTabs(live.dms, active));
  let moreOpen = $state(false);
  let moreButton: HTMLButtonElement | undefined = $state();
  let pop: HTMLDivElement | undefined = $state();
  let pos = $state<{ left: number; top: number } | null>(null);

  function close(channel: string) {
    void live.closeDm(channel);
    if (active === channel) onpick(null);
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

{#snippet label(handle: string, color: string, unread: number, showDot: boolean)}
  <span class="at" style:color>@{handle}</span>{#if showDot && unread > 0}<span class="dot" role="img" aria-label="{unread} unread"></span>{/if}
{/snippet}

{#if row.shown.length > 0}
  <div class="dmrow" aria-label="Conversations" role="group">
    {#each row.shown as d (d.channel)}
      <span class="dm">
        <button
          type="button"
          class="pick"
          title="@{d.with.handle}"
          aria-current={active === d.channel ? 'true' : undefined}
          onclick={() => onpick(d.channel)}>{@render label(d.with.handle, d.with.color, d.unread, active !== d.channel)}</button
        >
        <button type="button" class="x" aria-label="Close the conversation with @{d.with.handle}" onclick={() => close(d.channel)}>×</button>
      </span>
    {/each}
    {#if row.more.length > 0}
      <button bind:this={moreButton} type="button" class="pick more" aria-haspopup="menu" aria-expanded={moreOpen} onclick={toggleMore}
        >More<span aria-hidden="true"> ▾</span>{#if row.more.some((d) => d.unread > 0)}<span class="dot" role="img" aria-label="unread in More"></span>{/if}</button
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
          {#each row.more as d (d.channel)}
            <button
              role="menuitem"
              type="button"
              title="@{d.with.handle}"
              onclick={() => {
                closeMore();
                onpick(d.channel);
              }}>{@render label(d.with.handle, d.with.color, d.unread, true)}</button
            >
          {/each}
        </div>
      {/if}
    {/if}
  </div>
{/if}

<style>
  .dmrow {
    display: flex;
    align-items: stretch;
    min-width: 0;
    padding: 0 0.75rem;
    border-bottom: 1px solid var(--lattice);
    overflow-x: auto;
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
