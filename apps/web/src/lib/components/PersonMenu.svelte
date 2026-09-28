<script lang="ts">
  import { tick } from 'svelte';
  import type { IdentityPublic } from '@cs/shared/protocol';
  import { live } from '$lib/live.svelte';
  import { hostWith, inviteHandle } from '$lib/table-actions';
  import { inviteChoice } from '$lib/tables';
  import IdentityChip from './IdentityChip.svelte';

  /** `inline`: an @mention inside a chat line rather than a name chip. */
  let { identity, inline = false }: { identity: IdentityPublic; inline?: boolean } = $props();

  let open = $state(false);
  /** True when the popover would overflow the right edge at its default left-anchor, so it's flipped to hang from the right instead. */
  let flip = $state(false);
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

  async function show() {
    if (isMe || !live.me) return;
    open = true;
    flip = false;
    note = '';
    error = '';
    await tick();
    // A mention late in a wrapped chat line can sit near the right edge; keep the popover on-screen
    // at phone width by hanging it from the right instead when it would overflow.
    if (pop && pop.getBoundingClientRect().right > window.innerWidth - 8) flip = true;
    firstItem?.focus();
  }
  function close() {
    open = false;
    flip = false;
    trigger?.focus();
  }
  $effect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (root && !root.contains(e.target as Node)) {
        open = false;
        flip = false;
      }
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  });
  function onKey(e: KeyboardEvent) {
    if (open && e.key === 'Escape') close();
  }
  async function run(fn: () => Promise<unknown>, done: string) {
    error = '';
    try {
      await fn();
      note = done;
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
    <div class="pop panel" class:flip bind:this={pop}>
      <div role="menu" aria-label="@{identity.handle}">
        {#if choice?.kind === 'invite'}
          <button bind:this={firstItem} role="menuitem" type="button" disabled={!!choice.disabled} onclick={() => run(() => inviteHandle(identity.handle), `Invited @${identity.handle}.`)}
            >{choice.label}{#if choice.disabled}<span class="why"> — {choice.disabled}</span>{/if}</button
          >
        {:else if choice?.kind === 'host'}
          {#each choice.games as g, i (g.id)}
            {#if i === 0}
              <button bind:this={firstItem} role="menuitem" type="button" onclick={() => run(() => hostWith(g.id, [identity.handle]), `Invited @${identity.handle} to ${g.name}.`)}
                >Host {g.name} with @{identity.handle}</button
              >
            {:else}
              <button role="menuitem" type="button" onclick={() => run(() => hostWith(g.id, [identity.handle]), `Invited @${identity.handle} to ${g.name}.`)}
                >Host {g.name} with @{identity.handle}</button
              >
            {/if}
          {/each}
        {/if}
        <a role="menuitem" href="/u/{identity.handle}">Profile</a>
        <button role="menuitem" type="button" onclick={() => run(() => live.setRelation(identity.handle, 'ignore', true), `Ignoring @${identity.handle}.`)}
          >Ignore @{identity.handle}</button
        >
        <button role="menuitem" type="button" onclick={() => run(() => live.setRelation(identity.handle, 'block', true), `Blocked @${identity.handle}.`)}
          >Block @{identity.handle}</button
        >
      </div>
      {#if note}<p role="status">{note}</p>{/if}
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
    position: absolute;
    left: 0;
    top: calc(100% + 0.3rem);
    z-index: 6;
    width: min(17rem, 80vw);
    padding: 0.4rem;
    background: var(--panel-2);
    box-shadow: 0 0.8rem 2rem rgb(0 0 0 / 0.4);
  }
  .pop.flip {
    left: auto;
    right: 0;
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
