<script lang="ts">
  import { tick } from 'svelte';
  import type { IdentityPublic } from '@cs/shared/protocol';
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

  const status = $derived(live.presence.find((p) => p.identity.id === identity.id)?.status ?? null);
  const choice = $derived(inviteChoice(identity, { me: live.me, status, myTable: live.myTable, catalog: live.games }));
  /** While you host, names you could invite show a small + on hover. */
  const hint = $derived(choice?.kind === 'invite' && !choice.disabled);
  const isMe = $derived(live.me?.id === identity.id);
  /** You block them: say so rather than offering a message that will bounce. */
  const blocking = $derived(live.relations.blocks.some((b) => b.id === identity.id));
  function message() {
    open = false; // no refocus on the name: the composer takes focus
    live.openDm(identity);
  }

  async function show() {
    if (isMe || !live.me) return;
    open = true;
    pos = null;
    note = '';
    error = '';
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
  }
  function close() {
    open = false;
    trigger?.focus();
  }
  $effect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!root?.contains(t) && !pop?.contains(t)) open = false;
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
  function onKey(e: KeyboardEvent) {
    if (open && e.key === 'Escape') close();
  }
  /** An invite shows up on your gathering card, so the menu just gets out of the way; ignore and
   *  block have nothing else to show, so the menu turns into their confirmation (like MessageMenu). */
  async function run(fn: () => Promise<unknown>, done: string | null) {
    error = '';
    try {
      await fn();
      if (done === null) close();
      else note = done;
    } catch (e) {
      error = (e as Error).message;
    }
  }
</script>

<svelte:window onkeydown={onKey} />

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
      {#if note}
        <p role="status">{note}</p>
      {:else}
      <div role="menu" aria-label="@{identity.handle}">
        {#if choice?.kind === 'invite'}
          <button bind:this={firstItem} role="menuitem" type="button" disabled={!!choice.disabled} onclick={() => run(() => inviteHandle(identity.handle), null)}
            >{choice.label}{#if choice.disabled}<span class="why"> — {choice.disabled}</span>{/if}</button
          >
        {:else if choice?.kind === 'host'}
          {#each choice.games as g, i (g.id)}
            {#if i === 0}
              <button bind:this={firstItem} role="menuitem" type="button" onclick={() => run(() => hostWith(g.id, [identity.handle]), null)}
                >Host {g.name} with @{identity.handle}</button
              >
            {:else}
              <button role="menuitem" type="button" onclick={() => run(() => hostWith(g.id, [identity.handle]), null)}
                >Host {g.name} with @{identity.handle}</button
              >
            {/if}
          {/each}
        {/if}
        {#snippet messageLabel()}Message @{identity.handle}{#if blocking}<span class="why"> — you block them</span>{/if}{/snippet}
        {#if !identity.released}
          {#if choice}
            <button role="menuitem" type="button" disabled={blocking} onclick={message}>{@render messageLabel()}</button>
          {:else}
            <button bind:this={firstItem} role="menuitem" type="button" disabled={blocking} onclick={message}>{@render messageLabel()}</button>
          {/if}
        {/if}
        <a role="menuitem" href="/u/{identity.handle}">Profile</a>
        <button role="menuitem" type="button" onclick={() => run(() => live.setRelation(identity.handle, 'ignore', true), `Ignoring @${identity.handle}.`)}
          >Ignore @{identity.handle}</button
        >
        <button role="menuitem" type="button" onclick={() => run(() => live.setRelation(identity.handle, 'block', true), `Blocked @${identity.handle}.`)}
          >Block @{identity.handle}</button
        >
      </div>
      {/if}
      {#if error}<p class="error" role="alert">{error}</p>{/if}
    </div>
  {/if}
</span>

<style>
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
