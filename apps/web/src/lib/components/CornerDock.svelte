<script lang="ts">
  import { page } from '$app/state';
  import { live } from '$lib/live.svelte';
  import AgentNotice from './AgentNotice.svelte';
  import GatheringCard from './GatheringCard.svelte';
  import InviteCard from './InviteCard.svelte';

  // The lobby shows your card in the Play panel and the table page shows it in place; elsewhere it
  // shrinks into this corner, so an acceptance is never missed. Bottom-left: the Lattice owns bottom-right.
  const mine = $derived(live.myTable?.status === 'forming' ? live.myTable : null);
  const showMine = $derived(!!mine && page.url.pathname !== '/' && page.url.pathname !== `/t/${mine.id}`);
</script>

{#if live.offers.length > 0 || showMine || live.agentNotices.length > 0}
  <aside class="dock" aria-label="Invites and notices" aria-live="polite">
    {#each live.agentNotices as notice (notice.cursor)}<AgentNotice {notice} />{/each}
    {#each live.offers as offer (offer.invite.id)}<InviteCard {offer} />{/each}
    {#if showMine && mine}<GatheringCard table={mine} compact />{/if}
  </aside>
{/if}

<style>
  .dock {
    position: fixed;
    left: 1rem;
    bottom: 1rem;
    z-index: 20;
    width: min(22rem, calc(100% - 2rem));
    display: grid;
    gap: 0.5rem;
  }
  @media (max-width: 960px) {
    .dock {
      left: 0.5rem;
      right: 0.5rem;
      bottom: 0.5rem;
      width: auto;
    }
  }
</style>
