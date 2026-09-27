<script lang="ts">
  import { tick } from 'svelte';
  import type { ChatMessage } from '@cs/shared/protocol';
  import { api, ApiError } from '$lib/api';
  import { live } from '$lib/live.svelte';

  let { message }: { message: ChatMessage } = $props();

  let open = $state(false);
  let mode = $state<'menu' | 'report' | 'done'>('menu');
  let reason = $state('');
  let note = $state('');
  let error = $state('');
  let busy = $state(false);
  let root: HTMLDivElement | undefined = $state();
  let trigger: HTMLButtonElement | undefined = $state();
  let firstItem: HTMLButtonElement | HTMLInputElement | undefined = $state();
  const handle = $derived(message.author?.handle ?? '');

  function close() {
    open = false;
    mode = 'menu';
    reason = '';
    error = '';
    trigger?.focus();
  }
  async function show(next: 'menu' | 'report') {
    open = true;
    mode = next;
    note = '';
    error = '';
    await tick();
    firstItem?.focus();
  }
  function toggle() {
    if (open) close();
    else void show('menu');
  }

  // Clicking anywhere else closes the menu.
  $effect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (root && !root.contains(e.target as Node)) close();
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  });
  function onKey(e: KeyboardEvent) {
    if (open && e.key === 'Escape') close();
  }

  async function report(e: SubmitEvent) {
    e.preventDefault();
    error = '';
    busy = true;
    try {
      await api('POST', '/api/report', { messageId: message.id, ...(reason.trim() ? { reason: reason.trim() } : {}) });
      mode = 'done';
      note = 'Reported. A mod will take a look.';
    } catch (err) {
      // One report per person per message, ever: say so plainly rather than as an error.
      if (err instanceof ApiError && err.code === 'DUPLICATE_REPORT') {
        mode = 'done';
        note = 'You already reported this.';
      } else {
        error = (err as Error).message;
      }
    } finally {
      busy = false;
    }
  }
  async function relate(kind: 'ignore' | 'block') {
    error = '';
    try {
      await live.setRelation(handle, kind, true);
      mode = 'done';
      note = kind === 'ignore' ? `Ignoring @${handle}. Undo it on your profile.` : `Blocked @${handle}. Undo it on your profile.`;
    } catch (err) {
      error = (err as Error).message;
    }
  }
</script>

<svelte:window onkeydown={onKey} />

<div class="mm" bind:this={root}>
  <button
    bind:this={trigger}
    type="button"
    class="dots"
    aria-label="Options for @{handle}'s message"
    aria-haspopup="menu"
    aria-expanded={open}
    onclick={toggle}>…</button
  >
  {#if open}
    <div class="pop panel">
      {#if mode === 'menu'}
        <div role="menu" aria-label="Message options">
          <button bind:this={firstItem} role="menuitem" type="button" onclick={() => show('report')}>Report</button>
          <button role="menuitem" type="button" onclick={() => relate('ignore')}>Ignore @{handle}</button>
          <button role="menuitem" type="button" onclick={() => relate('block')}>Block @{handle}</button>
        </div>
      {:else if mode === 'report'}
        <form onsubmit={report}>
          <label for="why-{message.id}">What's wrong? (optional)</label>
          <input id="why-{message.id}" bind:this={firstItem} bind:value={reason} maxlength="300" autocomplete="off" />
          <div class="row">
            <button class="btn" type="submit" disabled={busy}>Send report</button>
            <button class="btn quiet" type="button" onclick={close}>Cancel</button>
          </div>
        </form>
      {:else}
        <p role="status">{note}</p>
      {/if}
      {#if error}<p class="error" role="alert">{error}</p>{/if}
    </div>
  {/if}
</div>

<style>
  .mm {
    position: relative;
    display: inline-block;
  }
  .dots {
    padding: 0 0.45rem;
    border: 1px solid transparent;
    border-radius: var(--r-tile);
    background: none;
    color: var(--fog);
    line-height: 1.3;
    opacity: 0;
  }
  :global(.msg:hover) .dots,
  :global(.msg:focus-within) .dots,
  .dots[aria-expanded='true'] {
    opacity: 1;
  }
  .dots:hover,
  .dots[aria-expanded='true'] {
    border-color: var(--lattice);
    color: var(--chalk);
  }
  @media (hover: none) {
    .dots {
      opacity: 1;
    }
  }
  .pop {
    position: absolute;
    right: 0;
    top: calc(100% + 0.3rem);
    z-index: 5;
    width: min(17rem, 80vw);
    padding: 0.4rem;
    background: var(--panel-2);
    box-shadow: 0 0.8rem 2rem rgb(0 0 0 / 0.4);
  }
  [role='menu'] {
    display: grid;
  }
  [role='menuitem'] {
    text-align: left;
    padding: 0.5rem 0.65rem;
    border: 0;
    border-radius: var(--r-control);
    background: none;
  }
  [role='menuitem']:hover,
  [role='menuitem']:focus-visible {
    background: var(--panel);
  }
  form {
    display: grid;
    gap: 0.4rem;
    padding: 0.4rem;
  }
  label {
    font-size: var(--step--1);
    color: var(--fog);
  }
  .row {
    display: flex;
    gap: 0.4rem;
  }
  p {
    margin: 0;
    padding: 0.5rem;
    font-size: var(--step--1);
  }
</style>
