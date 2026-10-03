<script lang="ts">
  import type { IdentityPublic, ProfileGlory } from '@cs/shared/protocol';
  import { api } from '$lib/api';
  import { standingOf } from '$lib/glory';

  let { identity, glory, mine, onranked }: { identity: IdentityPublic; glory: ProfileGlory; mine: boolean; onranked: (rankedAt: string) => void } = $props();

  let asking = $state(false);
  let busy = $state(false);
  let error = $state('');
  const standing = $derived(standingOf(identity, glory, Date.now()));

  async function goRanked() {
    busy = true;
    error = '';
    try {
      const r = await api<{ rankedAt: string }>('POST', '/api/me/ranked');
      asking = false;
      onranked(r.rankedAt);
    } catch (e) {
      error = (e as Error).message;
    } finally {
      busy = false;
    }
  }
</script>

<p class="standing">
  <span>Standing: {standing.text}</span>
  {#if mine && standing.canGoRanked && !asking}
    <button type="button" class="link" onclick={() => (asking = true)}>Go ranked now</button>
  {/if}
</p>
{#if asking}
  <div class="ask" role="group" aria-label="Go ranked now">
    <p>Go ranked now? Every game you play from now on counts. This can't be undone.</p>
    <div class="row">
      <button type="button" class="btn primary" disabled={busy} onclick={goRanked}>Go ranked</button>
      <button type="button" class="btn" disabled={busy} onclick={() => (asking = false)}>Not yet</button>
    </div>
    {#if error}<p class="error" role="alert">{error}</p>{/if}
  </div>
{/if}

<style>
  .standing {
    margin: 0.5rem 0 0;
    color: var(--fog);
    font-size: var(--step--1);
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    align-items: baseline;
  }
  .link {
    background: none;
    border: none;
    padding: 0;
    color: var(--carbon);
    cursor: pointer;
    font: inherit;
    text-decoration: underline;
  }
  .ask {
    margin-top: 0.6rem;
    padding: 0.75rem 1rem;
    border: 1px solid var(--lattice);
    border-radius: var(--r-panel);
    max-width: 28rem;
  }
  .ask p {
    margin: 0 0 0.6rem;
  }
  .row {
    display: flex;
    gap: 0.5rem;
  }
</style>
