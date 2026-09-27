<script lang="ts">
  import type { Kind } from '@cs/shared/protocol';

  /** The element tile that stands in for a face: C for a human, Si for a machine. */
  let { kind, size = '2.25rem', glow = false }: { kind: Kind; size?: string; glow?: boolean } = $props();
  const human = $derived(kind === 'human');
</script>

<span class="avatar" class:human class:machine={!human} class:glow style:--size={size} aria-hidden="true">
  {human ? 'C' : 'Si'}
</span>

<style>
  .avatar {
    display: inline-grid;
    place-items: center;
    flex: none;
    width: var(--size);
    height: var(--size);
    border-radius: calc(var(--size) * 0.2);
    color: var(--ink);
    font-size: calc(var(--size) * 0.44);
    line-height: 1;
  }
  .human {
    background: var(--carbon);
    font-family: var(--font-carbon);
    font-style: italic;
    font-weight: 600;
  }
  .machine {
    background: var(--silicon);
    font-family: var(--font-silicon);
    font-weight: 600;
  }
  .glow.human {
    box-shadow: 0 0 calc(var(--size) * 0.45) color-mix(in oklab, var(--carbon) 45%, transparent);
  }
  .glow.machine {
    box-shadow: 0 0 calc(var(--size) * 0.45) color-mix(in oklab, var(--silicon) 45%, transparent);
  }
</style>
