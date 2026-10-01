<script lang="ts">
  import { live } from '$lib/live.svelte';
  import { tableApi } from '$lib/table-actions';
  import InviteCard from './InviteCard.svelte';

  // Soonest-to-expire in front, so the one you must answer first sits on top.
  const offers = $derived([...live.offers].sort((a, b) => Date.parse(a.invite.expiresAt) - Date.parse(b.invite.expiresAt)));

  // A shared clock, ticked a few times a second, so the rings sweep smoothly
  // instead of jumping once a second.
  let now = $state(Date.now());
  $effect(() => {
    let raf = 0;
    let last = 0;
    const loop = (t: number) => {
      if (t - last > 90) {
        now = Date.now();
        last = t;
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  });

  function onkeydown(e: KeyboardEvent) {
    if (e.key === 'Escape' && offers.length > 0) {
      e.preventDefault();
      void tableApi.decline(offers[0].invite.id);
    }
  }
</script>

<svelte:window {onkeydown} />

{#if offers.length > 0}
  <!-- Backdrop is a deliberate dead zone: answering an invite is a choice, so a stray
       click outside the card does nothing. -->
  <div class="overlay" role="dialog" aria-modal="true" aria-label="Game invite">
    <div class="stack">
      {#each offers as offer, i (offer.invite.id)}
        <InviteCard {offer} {now} primaryFocus={i === 0} />
      {/each}
    </div>
  </div>
{/if}

<style>
  .overlay {
    position: fixed;
    inset: 0;
    z-index: 60;
    display: grid;
    place-items: center;
    padding: 1rem;
    background: color-mix(in oklab, var(--ink-deep) 72%, transparent);
    backdrop-filter: blur(5px);
    animation: overlay-in 0.18s ease-out;
  }
  .stack {
    display: grid;
    gap: 0.75rem;
    justify-items: center;
    max-height: 100dvh;
    overflow-y: auto;
  }
  @keyframes overlay-in {
    from {
      opacity: 0;
    }
    to {
      opacity: 1;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .overlay {
      animation: none;
    }
  }
</style>
