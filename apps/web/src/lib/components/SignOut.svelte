<script lang="ts">
  import { live } from '$lib/live.svelte';

  /**
   * Signs this browser out: call start() from any Sign out control (bind:this). A locked name goes
   * straight to the gate; a guest name can't be signed back into, so the guest is warned first and
   * offered the way to keep it (a password). Mount it outside menus that close, or the warning goes too.
   */

  let dialog: HTMLDialogElement | undefined = $state();
  /** The warning's words exist only while it's open: closed, it sits in the header saying nothing. */
  let shown = $state(false);
  let busy = $state(false);
  let error = $state('');

  async function signOut() {
    busy = true;
    error = '';
    try {
      await live.signOut();
    } catch (e) {
      error = (e as Error).message;
      busy = false;
    }
  }

  export function start() {
    if (live.me?.locked) void signOut();
    else {
      shown = true;
      dialog?.showModal();
    }
  }
</script>

<dialog
  bind:this={dialog}
  class="signout panel"
  aria-labelledby="signout-title"
  onclose={() => (shown = false)}
  onclick={(e) => e.target === dialog && dialog?.close()}
>
  {#if shown && live.me}
    <h2 id="signout-title">Sign out?</h2>
    <p>You haven't set a password, so signing out gives up @{live.me.handle} for good. Nobody can sign back in to a guest name.</p>
    <div class="actions">
      <a class="btn primary" href="/u/{live.me.handle}" onclick={() => dialog?.close()}>Set a password</a>
      <button class="btn danger" type="button" disabled={busy} onclick={signOut}>Sign out anyway</button>
      <button class="btn quiet" type="button" onclick={() => dialog?.close()}>Cancel</button>
    </div>
    {#if error}<p class="error" role="alert">{error}</p>{/if}
  {/if}
</dialog>

<style>
  .signout {
    width: min(28rem, calc(100vw - 2rem));
    padding: 1.25rem 1.4rem;
    border: 1px solid var(--lattice);
    border-radius: var(--r-panel);
    background: var(--ink);
    color: var(--chalk);
  }
  .signout::backdrop {
    background: color-mix(in oklab, var(--ink-deep) 72%, transparent);
  }
  h2 {
    margin: 0 0 0.5rem;
    font-family: var(--font-carbon);
    font-size: var(--step-2);
  }
  p {
    margin: 0 0 1rem;
    color: var(--fog);
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }
  .btn.danger {
    background: transparent;
    color: var(--danger);
    border-color: color-mix(in oklab, var(--danger) 50%, transparent);
  }
</style>
