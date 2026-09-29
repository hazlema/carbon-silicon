<script lang="ts">
  import { tick } from 'svelte';
  import { dmTabs } from '$lib/dms';
  import { live } from '$lib/live.svelte';
  import { portal } from '$lib/portal';

  /** Conversation tabs after a chat header's own tabs (spec M2c §5). `tabs` renders them as ARIA
   *  tabs for the table page's tablist; otherwise they're buttons marked aria-current, like the
   *  lobby's channel buttons. `onpick(null)` means "back to where you were": the open tab closed. */
  let { active, onpick, tabs = false }: { active: string | null; onpick: (channel: string | null) => void; tabs?: boolean } = $props();

  const row = $derived(dmTabs(live.dms, active));
  let moreOpen = $state(false);
  let moreButton: HTMLButtonElement | undefined = $state();
  let pop: HTMLDivElement | undefined = $state();
  let pos = $state<{ left: number; top: number } | null>(null);

  function close(channel: string) {
    void live.closeDm(channel);
    if (active === channel) onpick(null);
  }
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
  <span class="at" style:color>@{handle}</span>{#if showDot && unread > 0}<span class="dot" aria-label="{unread} unread"></span>{/if}
{/snippet}

{#each row.shown as d (d.channel)}
  <span class="dm" class:big={!tabs}>
    {#if tabs}
      <button type="button" class="pick" role="tab" aria-selected={active === d.channel} onclick={() => onpick(d.channel)}
        >{@render label(d.with.handle, d.with.color, d.unread, active !== d.channel)}</button
      >
    {:else}
      <button type="button" class="pick" aria-current={active === d.channel ? 'true' : undefined} onclick={() => onpick(d.channel)}
        >{@render label(d.with.handle, d.with.color, d.unread, active !== d.channel)}</button
      >
    {/if}
    <button type="button" class="x" aria-label="Close the conversation with @{d.with.handle}" onclick={() => close(d.channel)}>×</button>
  </span>
{/each}
{#if row.more.length > 0}
  <button bind:this={moreButton} type="button" class="pick more" class:big={!tabs} aria-haspopup="menu" aria-expanded={moreOpen} onclick={toggleMore}
    >More ▾{#if row.more.some((d) => d.unread > 0)}<span class="dot" aria-label="unread in More"></span>{/if}</button
  >
  {#if moreOpen}
    <div class="pop panel" role="menu" aria-label="More conversations" use:portal bind:this={pop} style={pos ? `left: ${pos.left}px; top: ${pos.top}px` : 'visibility: hidden'}>
      {#each row.more as d (d.channel)}
        <button
          role="menuitem"
          type="button"
          onclick={() => {
            moreOpen = false;
            onpick(d.channel);
          }}>{@render label(d.with.handle, d.with.color, d.unread, true)}</button
        >
      {/each}
    </div>
  {/if}
{/if}

<style>
  .dm {
    display: inline-flex;
    align-items: stretch;
    flex: none;
  }
  .pick {
    padding: 0.5rem 0.2rem 0.55rem 0.75rem;
    background: none;
    border: 0;
    border-bottom: 2px solid transparent;
    color: var(--fog);
    font-weight: 500;
    white-space: nowrap;
  }
  .big .pick,
  .pick.big {
    padding-top: 1rem;
    padding-bottom: 0.85rem;
    font-size: var(--step-1);
  }
  .pick.more {
    padding-right: 0.75rem;
  }
  .pick:hover {
    color: var(--chalk);
  }
  .pick[aria-current='true'],
  .pick[aria-selected='true'] {
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
