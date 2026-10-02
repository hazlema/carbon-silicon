<script lang="ts">
  import { live } from '$lib/live.svelte';
  import SignOut from '../SignOut.svelte';

  let signOut: SignOut | undefined = $state();
</script>

{#if live.me}
  <section class="settings panel" aria-labelledby="signout-row-title">
    <div class="row">
      <div>
        <h2 id="signout-row-title">Sign out</h2>
        <p>{live.me.locked ? 'This browser only; your other sessions stay signed in.' : 'Without a password, signing out gives this name up.'}</p>
      </div>
      <button class="btn" type="button" onclick={() => signOut?.start()}>Sign out</button>
    </div>
    <SignOut bind:this={signOut} />
  </section>
{/if}

<style>
  .settings {
    padding: 1.1rem 1.25rem 1.25rem;
  }
  h2 {
    margin: 0 0 0.3rem;
    font-size: var(--step--1);
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--fog);
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
</style>
