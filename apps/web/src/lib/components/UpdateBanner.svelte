<script lang="ts">
  import { updated } from '$app/state';
</script>

{#if updated.current}
  <div class="banner" role="status">
    <p>Carbon &amp; Silicon was updated.</p>
    <button type="button" class="btn primary" onclick={() => location.reload()}>Reload</button>
  </div>
{/if}

<style>
  .banner {
    position: relative;
    z-index: 2;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-wrap: wrap;
    gap: 0.4rem 1rem;
    padding: 0.5rem 1rem;
    background: var(--panel);
    border-bottom: 1px solid var(--lattice);
  }
  p {
    margin: 0;
    font-size: var(--step--1);
  }
  .btn {
    padding: 0.35rem 0.9rem;
    font-size: var(--step--1);
  }
</style>
