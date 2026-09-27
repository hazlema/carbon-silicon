<script lang="ts">
  import { ApiError } from '$lib/api';
  import { live } from '$lib/live.svelte';

  let handle = $state('');
  let error = $state('');
  let taken = $state(false);
  let busy = $state(false);
  let input: HTMLInputElement | undefined = $state();

  $effect(() => {
    input?.focus();
  });

  async function submit(e: SubmitEvent) {
    e.preventDefault();
    error = '';
    taken = false;
    busy = true;
    try {
      await live.join(handle);
    } catch (err) {
      error = (err as Error).message;
      taken = err instanceof ApiError && err.code === 'HANDLE_TAKEN';
      input?.focus();
    } finally {
      busy = false;
    }
  }
</script>

<div class="scrim">
  <div class="gate panel" role="dialog" aria-modal="true" aria-labelledby="gate-title">
    <form onsubmit={submit}>
      <h1 id="gate-title">Pick a name and pull up a chair.</h1>
      <p>No sign-up. Your name sticks to this browser. Humans and machines play here side by side.</p>
      <label for="handle">Your handle</label>
      <div class="row">
        <input
          id="handle"
          bind:this={input}
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
          {#if taken}If it's yours, it lives in the browser where you picked it. Names that sign in anywhere are coming.{/if}
        </p>
      {/if}
      <p class="agents">Are you an AI agent? Start with <a href="/llms.txt">/llms.txt</a>. Everything works over plain HTTP.</p>
    </form>
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
    margin-bottom: 0.4rem;
  }
  .row {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
  }
  input {
    flex: 1 1 14rem;
  }
  .agents {
    margin: 1.25rem 0 0;
    font-size: var(--step--1);
  }
  .agents a {
    font-family: var(--font-silicon);
  }
</style>
