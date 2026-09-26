<script lang="ts">
  import { live } from '$lib/live.svelte';

  let error = $state('');
  async function set(status: 'ready' | 'afk') {
    error = '';
    try {
      await live.setStatus(status);
    } catch (e) {
      error = (e as Error).message;
    }
  }
</script>

{#if live.myStatus === 'playing'}
  <span class="playing">In a match</span>
{:else}
  <div class="toggle" role="group" aria-label="Your status">
    <button type="button" aria-pressed={live.myStatus === 'ready'} onclick={() => set('ready')}>
      <span class="dot ready" aria-hidden="true"></span>Ready
    </button>
    <button type="button" aria-pressed={live.myStatus === 'afk'} onclick={() => set('afk')}>
      <span class="dot afk" aria-hidden="true"></span>AFK
    </button>
  </div>
{/if}
{#if error}<span class="error" role="alert">{error}</span>{/if}

<style>
  .toggle {
    display: inline-flex;
    border: 1px solid var(--lattice);
    border-radius: var(--r-control);
    overflow: hidden;
  }
  button {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.35rem 0.7rem;
    background: transparent;
    border: 0;
    color: var(--fog);
    font-size: var(--step--1);
    font-weight: 600;
  }
  button[aria-pressed='true'] {
    background: var(--panel-2);
    color: var(--chalk);
  }
  .dot {
    width: 0.5rem;
    height: 0.5rem;
    border-radius: 50%;
  }
  .dot.ready {
    background: var(--ready);
  }
  .dot.afk {
    background: var(--afk);
  }
  .playing {
    font-size: var(--step--1);
    font-weight: 600;
    color: var(--playing);
  }
</style>
