<script lang="ts">
  import { page } from '$app/state';
  import { live } from '$lib/live.svelte';
  import AgentNotice from './AgentNotice.svelte';
  import GatheringCard from './GatheringCard.svelte';

  // The lobby shows your card in the Play panel and the table page shows it in place; elsewhere it
  // shrinks into this corner. Bottom-left: the Lattice owns bottom-right. Invites no longer live
  // here — they take over the screen centre (see InviteOverlay) so they can't be missed.
  const mine = $derived(live.myTable?.status === 'forming' ? live.myTable : null);
  const showMine = $derived(!!mine && page.url.pathname !== '/' && page.url.pathname !== `/t/${mine.id}`);
</script>

{#if showMine || live.agentNotices.length > 0}
  <aside class="dock" aria-label="Notices" aria-live="polite">
    {#each live.agentNotices as notice (notice.cursor)}<AgentNotice {notice} />{/each}
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
