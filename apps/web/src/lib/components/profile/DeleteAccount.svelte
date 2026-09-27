<script lang="ts">
  import { api } from '$lib/api';
  import { live } from '$lib/live.svelte';

  const me = $derived(live.me);

  let open = $state(false);
  let confirmHandle = $state('');
  let deletePassword = $state('');
  let deleteError = $state('');
  const canDelete = $derived(!!me && confirmHandle.trim().toLowerCase() === me.handle.toLowerCase());

  // The toggle button stays in the DOM in both states (never `{#if}`-removed) so focus always has
  // somewhere reliable to land: the handle field on open, back to this button on cancel.
  let toggleBtn: HTMLButtonElement | undefined = $state();
  let handleInput: HTMLInputElement | undefined = $state();

  $effect(() => {
    if (open) handleInput?.focus();
  });

  function toggle() {
    if (open) {
      open = false;
      toggleBtn?.focus();
    } else {
      open = true;
    }
  }

  async function remove(e: SubmitEvent) {
    e.preventDefault();
    deleteError = '';
    try {
      await api('DELETE', '/api/me', me?.locked ? { password: deletePassword } : {});
      location.assign('/');
    } catch (err) {
      deleteError = (err as Error).message;
    }
  }
</script>

{#if me}
  <section class="settings danger panel" aria-labelledby="delete-title">
    <div class="row">
      <div>
        <h2 id="delete-title">Delete account</h2>
        <p>Matches stay, credited to &ldquo;a former player&rdquo;.</p>
      </div>
      <button class="btn danger" type="button" bind:this={toggleBtn} aria-expanded={open} aria-controls="delete-form" onclick={toggle}>
        {open ? 'Cancel' : 'Delete…'}
      </button>
    </div>
    {#if open}
      <form id="delete-form" onsubmit={remove}>
        <label for="del-handle">Type your handle to confirm</label>
        <input id="del-handle" bind:this={handleInput} bind:value={confirmHandle} autocomplete="off" placeholder={me.handle} />
        {#if me.locked}
          <label for="del-pw">Password</label>
          <input id="del-pw" type="password" bind:value={deletePassword} autocomplete="current-password" maxlength="200" />
        {/if}
        <div class="actions">
          <button class="btn" type="submit" disabled={!canDelete}>Delete my account</button>
        </div>
        {#if deleteError}<p class="error" role="alert">{deleteError}</p>{/if}
      </form>
    {/if}
  </section>
{/if}

<style>
  .settings {
    padding: 1.1rem 1.25rem 1.25rem;
  }
  .danger {
    border-color: color-mix(in oklab, var(--danger) 35%, var(--lattice));
  }
  h2 {
    margin: 0 0 0.3rem;
    font-size: var(--step--1);
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--danger);
  }
  p {
    margin: 0;
    color: var(--fog);
    font-size: var(--step--1);
  }
  .row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 1rem;
  }
  form {
    display: grid;
    gap: 0.4rem;
    justify-items: start;
    margin-top: 1rem;
  }
  form > input {
    width: min(100%, 24rem);
  }
  label {
    font-weight: 600;
    margin-top: 0.4rem;
  }
  .actions {
    display: flex;
    gap: 0.5rem;
    margin-top: 0.6rem;
  }
  .btn.danger {
    background: transparent;
    color: var(--danger);
    border-color: color-mix(in oklab, var(--danger) 50%, transparent);
  }
  .btn.danger:hover:not(:disabled) {
    border-color: var(--danger);
  }
</style>
