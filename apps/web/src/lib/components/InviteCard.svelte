<script lang="ts">
  import type { InviteOffer } from '@cs/shared/protocol';
  import { untrack } from 'svelte';
  import { live } from '$lib/live.svelte';
  import { tableApi } from '$lib/table-actions';
  import { secondsLeft } from '$lib/tables';
  import CountdownRing from './CountdownRing.svelte';
  import IdentityChip from './IdentityChip.svelte';

  // `now` is driven by the overlay so every open invite sweeps on the same clock.
  let { offer, now, primaryFocus = false }: { offer: InviteOffer; now: number; primaryFocus?: boolean } = $props();

  let error = $state('');
  let busy = $state(false);
  let acceptBtn = $state<HTMLButtonElement | null>(null);

  // The invite's full window, captured when this card first appears, so the ring
  // fills from (near) empty to full over however long is actually left.
  const total = untrack(() => Math.max(1, secondsLeft(offer.invite.expiresAt, now)));
  const name = $derived(live.games.find((g) => g.id === offer.table.gameId)?.name ?? offer.table.gameId);
  const secs = $derived(secondsLeft(offer.invite.expiresAt, now));
  const remaining = $derived(Math.max(0, Math.min(1, secs / total)));

  $effect(() => {
    if (primaryFocus) acceptBtn?.focus();
  });

  async function run(fn: () => Promise<unknown>) {
    error = '';
    busy = true;
    try {
      await fn();
    } catch (e) {
      error = (e as Error).message;
    } finally {
      busy = false;
    }
  }
</script>

{#if secs > 0}
  <div class="invite panel" role="group" aria-label="Invite from @{offer.from.handle}">
    <CountdownRing {remaining} {secs} />
    <p class="headline"><IdentityChip identity={offer.from} badge={false} /> invites you to <strong>{name}</strong></p>
    <div class="row">
      <button class="btn primary" type="button" disabled={busy} bind:this={acceptBtn} onclick={() => run(() => tableApi.accept(offer.invite.id))}>Accept</button>
      <button class="btn" type="button" disabled={busy} onclick={() => run(() => tableApi.decline(offer.invite.id))}>Decline</button>
    </div>
    {#if error}<p class="error" role="alert">{error}</p>{/if}
  </div>
{/if}

<style>
  .invite {
    display: grid;
    justify-items: center;
    gap: 0.9rem;
    padding: 1.6rem 1.8rem;
    width: min(22rem, calc(100vw - 2rem));
    text-align: center;
    box-shadow: 0 1.5rem 3.5rem rgb(0 0 0 / 0.55);
  }
  .headline {
    margin: 0;
    font-size: 1.05rem;
  }
  .headline strong {
    white-space: nowrap;
  }
  .row {
    display: flex;
    gap: 0.6rem;
  }
  .error {
    margin: 0;
    color: var(--danger);
    font-size: 0.85rem;
  }
</style>
