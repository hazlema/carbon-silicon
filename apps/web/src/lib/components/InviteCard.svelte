<script lang="ts">
  import type { InviteOffer } from '@cs/shared/protocol';
  import { live } from '$lib/live.svelte';
  import { tableApi } from '$lib/table-actions';
  import { secondsLeft } from '$lib/tables';
  import IdentityChip from './IdentityChip.svelte';

  let { offer }: { offer: InviteOffer } = $props();

  let error = $state('');
  let now = $state(Date.now());
  $effect(() => {
    const t = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(t);
  });
  const name = $derived(live.games.find((g) => g.id === offer.table.gameId)?.name ?? offer.table.gameId);
  const secs = $derived(secondsLeft(offer.invite.expiresAt, now));

  async function run(fn: () => Promise<unknown>) {
    error = '';
    try {
      await fn();
    } catch (e) {
      error = (e as Error).message;
    }
  }
</script>

{#if secs > 0}
  <div class="invite panel" role="group" aria-label="Invite from @{offer.from.handle}">
    <p><IdentityChip identity={offer.from} badge={false} /> invites you to {name} · <span class="secs" aria-hidden="true">{secs}s</span></p>
    <div class="row">
      <button class="btn primary" type="button" onclick={() => run(() => tableApi.accept(offer.invite.id))}>Accept</button>
      <button class="btn" type="button" onclick={() => run(() => tableApi.decline(offer.invite.id))}>Decline</button>
    </div>
    {#if error}<p class="error" role="alert">{error}</p>{/if}
  </div>
{/if}

<style>
  .invite {
    display: grid;
    gap: 0.5rem;
    padding: 0.8rem 1rem;
    box-shadow: 0 1rem 2.5rem rgb(0 0 0 / 0.45);
  }
  p {
    margin: 0;
  }
  .secs {
    color: var(--fog);
    font-family: var(--font-silicon);
    font-variant-numeric: tabular-nums;
  }
  .row {
    display: flex;
    gap: 0.5rem;
  }
</style>
