<script lang="ts">
  import type { IdentityPublic } from '@cs/shared/protocol';
  import { api } from '$lib/api';
  import { live } from '$lib/live.svelte';

  const me = $derived(live.me);

  // ── bio ──
  let bio = $state(live.me?.tagline ?? '');
  let bioNote = $state('');
  let bioError = $state('');
  async function saveBio(e: SubmitEvent) {
    e.preventDefault();
    bioNote = '';
    bioError = '';
    try {
      const r = await api<{ identity: IdentityPublic }>('PATCH', '/api/me', { tagline: bio });
      live.me = r.identity;
      bio = r.identity.tagline ?? '';
      bioNote = 'Saved.';
    } catch (err) {
      bioError = (err as Error).message;
    }
  }

  // ── lock, then change password ──
  let pw = $state('');
  let pw2 = $state('');
  let current = $state('');
  let pwError = $state('');
  let pwNote = $state('');
  let code = $state('');
  async function lock(e: SubmitEvent) {
    e.preventDefault();
    pwError = '';
    if (pw !== pw2) {
      pwError = "The passwords don't match.";
      return;
    }
    try {
      const r = await api<{ identity: IdentityPublic; recoveryCode: string }>('POST', '/api/me/lock', { password: pw });
      live.me = r.identity;
      code = r.recoveryCode;
      pw = '';
      pw2 = '';
    } catch (err) {
      pwError = (err as Error).message;
    }
  }
  async function changePassword(e: SubmitEvent) {
    e.preventDefault();
    pwError = '';
    pwNote = '';
    if (pw !== pw2) {
      pwError = "The new passwords don't match.";
      return;
    }
    try {
      await api('POST', '/api/me/password', { current, next: pw });
      current = '';
      pw = '';
      pw2 = '';
      pwNote = 'Password changed. Every other browser has been signed out.';
    } catch (err) {
      pwError = (err as Error).message;
    }
  }

  // ── delete ──
  let confirmHandle = $state('');
  let deletePassword = $state('');
  let deleteError = $state('');
  const canDelete = $derived(!!me && confirmHandle.trim().toLowerCase() === me.handle.toLowerCase());
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
  <section class="settings panel" aria-labelledby="bio-title">
    <h2 id="bio-title">Bio</h2>
    <form onsubmit={saveBio}>
      <label for="bio">Bio</label>
      <div class="row">
        <input id="bio" bind:value={bio} maxlength="80" placeholder="One line about you" />
        <button class="btn" type="submit">Save bio</button>
      </div>
      {#if bioNote}<p class="note" role="status">{bioNote}</p>{/if}
      {#if bioError}<p class="error" role="alert">{bioError}</p>{/if}
    </form>
  </section>

  {#if me.kind === 'human'}
    <section class="settings panel" aria-labelledby="pw-title">
      {#if code}
        <h2 id="pw-title">Your recovery code</h2>
        <p>
          Save this somewhere safe. It's the only way back in if you forget your password, since the parlor has no
          email. It's shown only once.
        </p>
        <code class="code" data-testid="recovery-code">{code}</code>
        <button class="btn primary" type="button" onclick={() => (code = '')}>I saved it</button>
      {:else if !me.locked}
        <h2 id="pw-title">Lock your name</h2>
        <p>
          Right now @{me.handle} lives in this browser only. Set a password to keep it for good, sign in from anywhere,
          and put your wins on the leaderboard.
        </p>
        <form onsubmit={lock}>
          <label for="lock-pw">New password</label>
          <input id="lock-pw" type="password" bind:value={pw} autocomplete="new-password" minlength="10" maxlength="200" required />
          <label for="lock-pw2">Confirm password</label>
          <input id="lock-pw2" type="password" bind:value={pw2} autocomplete="new-password" minlength="10" maxlength="200" required />
          <button class="btn primary" type="submit">Lock my name</button>
          {#if pwError}<p class="error" role="alert">{pwError}</p>{/if}
        </form>
      {:else}
        <h2 id="pw-title">Change password</h2>
        <form onsubmit={changePassword}>
          <label for="cur-pw">Current password</label>
          <input id="cur-pw" type="password" bind:value={current} autocomplete="current-password" maxlength="200" required />
          <label for="new-pw">New password</label>
          <input id="new-pw" type="password" bind:value={pw} autocomplete="new-password" minlength="10" maxlength="200" required />
          <label for="new-pw2">Confirm new password</label>
          <input id="new-pw2" type="password" bind:value={pw2} autocomplete="new-password" minlength="10" maxlength="200" required />
          <button class="btn" type="submit">Change password</button>
          {#if pwNote}<p class="note" role="status">{pwNote}</p>{/if}
          {#if pwError}<p class="error" role="alert">{pwError}</p>{/if}
        </form>
        <div class="signout">
          <button class="btn quiet" type="button" onclick={() => live.signOut()}>Sign out of this browser</button>
        </div>
      {/if}
    </section>
  {/if}

  <section class="settings danger panel" aria-labelledby="delete-title">
    <h2 id="delete-title">Delete account</h2>
    <p>Your name, bio and sign-ins are erased. Your past matches stay, credited to “a former player”.</p>
    <form onsubmit={remove}>
      <label for="del-handle">Type your handle to confirm</label>
      <input id="del-handle" bind:value={confirmHandle} autocomplete="off" placeholder={me.handle} />
      {#if me.locked}
        <label for="del-pw">Password</label>
        <input id="del-pw" type="password" bind:value={deletePassword} autocomplete="current-password" maxlength="200" />
      {/if}
      <button class="btn" type="submit" disabled={!canDelete}>Delete my account</button>
      {#if deleteError}<p class="error" role="alert">{deleteError}</p>{/if}
    </form>
  </section>
{/if}

<style>
  .settings {
    padding: 1.1rem 1.25rem 1.25rem;
  }
  h2 {
    margin: 0 0 0.8rem;
    font-size: var(--step--1);
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--fog);
  }
  p {
    margin: 0 0 0.9rem;
    color: var(--fog);
  }
  form {
    display: grid;
    gap: 0.4rem;
    justify-items: start;
  }
  form > input {
    width: min(100%, 24rem);
  }
  label {
    font-weight: 600;
    margin-top: 0.4rem;
  }
  .row {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
    width: 100%;
  }
  .row input {
    flex: 1 1 14rem;
  }
  button[type='submit'] {
    margin-top: 0.6rem;
  }
  .row button[type='submit'] {
    margin-top: 0;
  }
  .note {
    margin: 0.4rem 0 0;
    color: var(--ready);
    font-size: var(--step--1);
  }
  .code {
    display: block;
    margin: 0 0 0.9rem;
    padding: 0.8rem 1rem;
    border: 1px solid var(--lattice);
    border-radius: var(--r-control);
    background: var(--ink-deep);
    font-family: var(--font-silicon);
    overflow-wrap: anywhere;
    user-select: all;
  }
  .signout {
    margin-top: 1rem;
  }
  .danger {
    border-color: color-mix(in oklab, var(--danger) 35%, var(--lattice));
  }
</style>
