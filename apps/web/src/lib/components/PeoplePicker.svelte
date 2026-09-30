<script lang="ts">
  import { live } from '$lib/live.svelte';

  /** Pick a person for a conversation: a field with suggestions from who's here now. `onsubmit` throws to show a message under the field. */
  let {
    open = $bindable(false),
    exclude = [],
    onsubmit,
  }: { open: boolean; exclude?: string[]; onsubmit: (handle: string) => Promise<void> } = $props();

  let dialog: HTMLDialogElement | undefined = $state();
  let value = $state('');
  let error = $state('');
  let busy = $state(false);
  const suggestions = $derived(
    live.presence.map((p) => p.identity.handle).filter((h) => h !== live.me?.handle && !exclude.includes(h)),
  );

  $effect(() => {
    if (!dialog) return;
    if (open && !dialog.open) {
      value = '';
      error = '';
      dialog.showModal();
    }
    if (!open && dialog.open) dialog.close();
  });

  async function submit(e: SubmitEvent) {
    e.preventDefault();
    const handle = value.trim().replace(/^@/, '');
    if (!handle) {
      error = 'Type a handle.';
      return;
    }
    error = '';
    busy = true;
    try {
      await onsubmit(handle);
      open = false;
    } catch (err) {
      error = (err as Error).message;
    } finally {
      busy = false;
    }
  }
</script>

<dialog
  bind:this={dialog}
  class="picker"
  aria-labelledby="picker-title"
  onclose={() => (open = false)}
  onclick={(e) => {
    if (e.target === dialog) open = false;
  }}
>
  <form onsubmit={submit}>
    <header>
      <h2 id="picker-title">Add someone</h2>
      <button class="close" type="button" aria-label="Close" onclick={() => (open = false)}>×</button>
    </header>
    <label for="picker-who">Who?</label>
    <input id="picker-who" list="picker-list" autocomplete="off" spellcheck="false" autocapitalize="off" bind:value placeholder="a handle" />
    <datalist id="picker-list">
      {#each suggestions as h (h)}<option value={h}></option>{/each}
    </datalist>
    {#if error}<p class="error" role="alert">{error}</p>{/if}
    <div class="row">
      <button class="btn" type="button" onclick={() => (open = false)}>Cancel</button>
      <button class="btn primary" type="submit" disabled={busy}>Add</button>
    </div>
  </form>
</dialog>

<style>
  .picker {
    width: min(26rem, calc(100vw - 2rem));
    padding: 0;
    border: 1px solid var(--lattice);
    border-radius: var(--r-panel);
    background: var(--ink);
    color: var(--chalk);
    box-shadow: 0 1.5rem 4rem rgb(0 0 0 / 0.5);
  }
  .picker::backdrop {
    background: color-mix(in oklab, var(--ink-deep) 72%, transparent);
    backdrop-filter: blur(3px);
  }
  form {
    display: grid;
    gap: 0.6rem;
    padding: 1.1rem 1.25rem 1.25rem;
  }
  header {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  h2 {
    margin: 0;
    font-family: var(--font-carbon);
    font-size: var(--step-2);
    font-weight: 600;
  }
  .close {
    width: 2.5rem;
    height: 2.5rem;
    border: 0;
    border-radius: var(--r-control);
    background: transparent;
    color: var(--fog);
    font-size: 1.6rem;
    line-height: 1;
    cursor: pointer;
  }
  .close:hover {
    color: var(--chalk);
    background: var(--panel);
  }
  input {
    min-width: 0;
  }
  .error,
  p {
    margin: 0;
  }
  .row {
    display: flex;
    justify-content: flex-end;
    gap: 0.6rem;
    margin-top: 0.3rem;
  }
</style>
