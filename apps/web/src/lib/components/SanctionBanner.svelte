<script lang="ts">
  import { sanctionHeadline, untilText } from '$lib/format';
  import { live } from '$lib/live.svelte';

  const s = $derived(live.sanction);

  // Sanctions end by time alone, so refresh when this one runs out and the banner goes away by itself.
  $effect(() => {
    const endsAt = s?.endsAt;
    if (!endsAt) return;
    const ms = Math.min(Math.max(1000, Date.parse(endsAt) - Date.now() + 1000), 2 ** 31 - 1);
    const t = setTimeout(() => void live.refreshMe().catch((e) => console.error(e)), ms);
    return () => clearTimeout(t);
  });
</script>

{#if s}
  <div class="banner {s.kind}" role="status">
    <p class="head"><strong>{sanctionHeadline(s)}</strong> {untilText(s.endsAt)}.</p>
    <p class="reason">Reason: {s.reason}</p>
    <p class="what">
      {s.kind === 'mute'
        ? 'Chat is off for you, but you can still play.'
        : 'You can read and look around, but not chat, play or change your profile.'}
    </p>
  </div>
{/if}

<style>
  .banner {
    margin: 0 0 1rem;
    padding: 0.8rem 1.1rem;
    border: 1px solid var(--lattice);
    border-left: 4px solid var(--danger);
    border-radius: var(--r-panel);
    background: var(--panel);
  }
  .banner.mute {
    border-left-color: var(--afk);
  }
  p {
    margin: 0;
  }
  .head {
    font-size: var(--step-1);
  }
  .reason,
  .what {
    color: var(--fog);
    font-size: var(--step--1);
    margin-top: 0.2rem;
  }
</style>
