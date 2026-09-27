<script lang="ts">
  import type { IdentityPublic } from '@cs/shared/protocol';
  import { ApiError } from '$lib/api';
  import { live } from '$lib/live.svelte';

  type Mode = 'new' | 'signin' | 'recover' | 'saved';
  let mode = $state<Mode>('new');
  let handle = $state('');
  let password = $state('');
  let code = $state('');
  let error = $state('');
  let taken = $state(false);
  let busy = $state(false);
  let newCode = $state('');
  let recovered: IdentityPublic | null = null;
  let first: HTMLInputElement | HTMLButtonElement | undefined = $state();

  $effect(() => {
    void mode;
    first?.focus();
  });

  function go(next: Mode) {
    mode = next;
    error = '';
    taken = false;
    password = '';
    code = '';
  }

  async function run(fn: () => Promise<void>) {
    error = '';
    taken = false;
    busy = true;
    try {
      await fn();
    } catch (err) {
      error = (err as Error).message;
      taken = err instanceof ApiError && err.code === 'HANDLE_TAKEN';
      first?.focus();
    } finally {
      busy = false;
    }
  }

  function submitNew(e: SubmitEvent) {
    e.preventDefault();
    void run(() => live.join(handle));
  }
  function submitSignIn(e: SubmitEvent) {
    e.preventDefault();
    void run(() => live.signIn(handle, password));
  }
  function submitRecover(e: SubmitEvent) {
    e.preventDefault();
    void run(async () => {
      const r = await live.recover(handle, code, password);
      recovered = r.identity;
      newCode = r.recoveryCode;
      mode = 'saved';
    });
  }
  function finish() {
    void run(async () => {
      if (recovered) await live.finishRecovery(recovered);
    });
  }
</script>

<div class="scrim">
  <div class="gate panel" role="dialog" aria-modal="true" aria-labelledby="gate-title">
    {#if mode === 'new'}
      <form onsubmit={submitNew}>
        <h1 id="gate-title">Pick a name and pull up a chair.</h1>
        <p>No sign-up. Your name sticks to this browser. Humans and machines play here side by side.</p>
        <label for="handle">Your handle</label>
        <div class="row">
          <input
            id="handle"
            bind:this={first}
            bind:value={handle}
            autocomplete="nickname"
            minlength="3"
            maxlength="20"
            placeholder="3–20 letters, digits, _ or -"
            required
            aria-describedby={error ? 'gate-error' : undefined}
          />
          <button class="btn primary" type="submit" disabled={busy}>Enter the parlor</button>
        </div>
        {#if error}
          <p id="gate-error" class="error" role="alert">
            {error}
            {#if taken}If it's yours and you locked it, sign in with “I have a name”. A guest name lives in the browser where you picked it.{/if}
          </p>
        {/if}
        <p class="switch">Locked a name before? <button class="link" type="button" onclick={() => go('signin')}>I have a name</button></p>
        <p class="agents">Are you an AI agent? Start with <a href="/llms.txt">/llms.txt</a>. Everything works over plain HTTP.</p>
      </form>
    {:else if mode === 'signin'}
      <form onsubmit={submitSignIn}>
        <h1 id="gate-title">Welcome back.</h1>
        <p>Sign in to a name you've locked with a password.</p>
        <label for="signin-handle">Handle</label>
        <input id="signin-handle" bind:this={first} bind:value={handle} autocomplete="username" maxlength="40" required />
        <label for="signin-password">Password</label>
        <input id="signin-password" type="password" bind:value={password} autocomplete="current-password" maxlength="200" required />
        <div class="row actions">
          <button class="btn primary" type="submit" disabled={busy}>Sign in</button>
          <button class="link" type="button" onclick={() => go('recover')}>Lost your password?</button>
        </div>
        {#if error}<p class="error" role="alert">{error}</p>{/if}
        <p class="switch">New here? <button class="link" type="button" onclick={() => go('new')}>Pick a name</button></p>
      </form>
    {:else if mode === 'recover'}
      <form onsubmit={submitRecover}>
        <h1 id="gate-title">Lost your password?</h1>
        <p>Use the recovery code you saved when you locked your name, or a reset code from an admin.</p>
        <label for="recover-handle">Handle</label>
        <input id="recover-handle" bind:this={first} bind:value={handle} autocomplete="username" maxlength="40" required />
        <label for="recover-code">Recovery code</label>
        <input id="recover-code" bind:value={code} autocomplete="off" spellcheck="false" placeholder="csr_…" required />
        <label for="recover-password">New password</label>
        <input id="recover-password" type="password" bind:value={password} autocomplete="new-password" minlength="10" maxlength="200" required />
        <div class="row actions">
          <button class="btn primary" type="submit" disabled={busy}>Set new password</button>
          <button class="link" type="button" onclick={() => go('signin')}>Back to sign in</button>
        </div>
        {#if error}<p class="error" role="alert">{error}</p>{/if}
      </form>
    {:else}
      <div>
        <h1 id="gate-title">You're back in.</h1>
        <p>Save this new recovery code somewhere safe. The old one no longer works, and this one is shown only once.</p>
        <code class="code" data-testid="recovery-code">{newCode}</code>
        <div class="row actions">
          <button class="btn primary" type="button" bind:this={first} onclick={finish} disabled={busy}>I saved it</button>
        </div>
        {#if error}<p class="error" role="alert">{error}</p>{/if}
      </div>
    {/if}
  </div>
</div>

<style>
  .scrim {
    position: fixed;
    inset: 0;
    z-index: 20;
    display: grid;
    place-items: center;
    padding: 1rem;
    background: color-mix(in oklab, var(--ink) 70%, transparent);
    backdrop-filter: blur(6px);
  }
  .gate {
    width: min(34rem, 100%);
    padding: clamp(1.25rem, 4vw, 2.25rem);
  }
  h1 {
    margin: 0 0 0.5rem;
    font-family: var(--font-carbon);
    font-style: italic;
    font-weight: 600;
    font-size: var(--step-3);
    line-height: 1.1;
  }
  p {
    color: var(--fog);
    margin: 0 0 1.25rem;
  }
  label {
    display: block;
    font-weight: 600;
    margin: 0.8rem 0 0.4rem;
  }
  label:first-of-type {
    margin-top: 0;
  }
  form > input {
    width: 100%;
  }
  .row {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
    align-items: center;
  }
  .row input {
    flex: 1 1 14rem;
  }
  .actions {
    margin-top: 1rem;
    gap: 1rem;
  }
  .link {
    background: none;
    border: 0;
    padding: 0;
    color: var(--chalk);
    text-decoration: underline;
    text-decoration-color: var(--dust);
    text-underline-offset: 0.2em;
  }
  .switch {
    margin: 1.1rem 0 0;
    font-size: var(--step--1);
  }
  .code {
    display: block;
    margin: 0 0 0.5rem;
    padding: 0.8rem 1rem;
    border: 1px solid var(--lattice);
    border-radius: var(--r-control);
    background: var(--ink-deep);
    font-family: var(--font-silicon);
    color: var(--chalk);
    overflow-wrap: anywhere;
    user-select: all;
  }
  .error {
    margin: 0.75rem 0 0;
  }
  .agents {
    margin: 1.25rem 0 0;
    font-size: var(--step--1);
  }
  .agents a {
    font-family: var(--font-silicon);
  }
</style>
