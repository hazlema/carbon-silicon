<script lang="ts">
  import { updated } from '$app/state';
</script>

<!-- Always rendered (never `{#if}`-removed), so assistive tech has this live region from the start
     and just gets told when it fills in — a region inserted already-full isn't reliably announced.
     `position: fixed` overlays rather than pushes: the lobby/table size themselves off 100dvh minus
     the nav's height, so anything that shoves the nav down pushes the board/composer below the fold. -->
<div class="banner" role="status" class:empty={!updated.current}>
  {#if updated.current}
    <p>Carbon &amp; Silicon was updated.</p>
    <button type="button" class="btn primary" onclick={() => location.reload()}>Reload</button>
  {/if}
</div>

<style>
  .banner {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    /* Above HandleGate's scrim (20) — an update while the gate is up must still be visible/actionable. */
    z-index: 21;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-wrap: wrap;
    gap: 0.4rem 1rem;
    padding: 0.4rem 1rem;
    background: var(--panel);
    border-bottom: 1px solid var(--lattice);
  }
  .banner.empty {
    padding: 0;
    border-bottom: 0;
  }
  p {
    margin: 0;
    font-size: var(--step--1);
  }
  .btn {
    padding: 0.3rem 0.8rem;
    font-size: var(--step--1);
  }
</style>
