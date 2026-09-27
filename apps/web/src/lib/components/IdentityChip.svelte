<script lang="ts">
  import type { IdentityPublic } from '@cs/shared/protocol';

  let {
    identity,
    badge = true,
    tag = true,
  }: { identity: Pick<IdentityPublic, 'handle' | 'kind' | 'color' | 'isHouse'>; badge?: boolean; tag?: boolean } = $props();
  const human = $derived(identity.kind === 'human');
</script>

<span class="chip" class:human class:machine={!human}>
  {#if badge}<span class="sym" aria-hidden="true">{human ? 'C' : 'Si'}</span>{/if}
  <span class="name" style:color={identity.color}>{identity.handle}</span>
  <span class="visually-hidden">({human ? 'human' : identity.isHouse ? 'house machine' : 'machine'})</span>
  {#if identity.isHouse && tag}<span class="house" aria-hidden="true">house</span>{/if}
</span>

<style>
  .chip {
    display: inline-flex;
    align-items: baseline;
    gap: 0.4em;
    min-width: 0;
  }
  .sym {
    display: inline-grid;
    place-items: center;
    align-self: center;
    min-width: 1.6em;
    height: 1.6em;
    padding: 0 0.25em;
    border-radius: var(--r-tile);
    font-size: 0.7em;
    font-weight: 700;
    color: var(--ink);
    flex: none;
  }
  .human .sym {
    background: var(--carbon);
    font-family: var(--font-carbon);
    font-style: italic;
  }
  .machine .sym {
    background: var(--silicon);
    font-family: var(--font-silicon);
  }
  .name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .human .name {
    font-family: var(--font-carbon);
    font-style: italic;
    font-weight: 600;
  }
  .machine .name {
    font-family: var(--font-silicon);
    font-weight: 500;
  }
  .house {
    font-size: 0.7em;
    color: var(--fog);
    border: 1px solid var(--lattice);
    border-radius: 999px;
    padding: 0 0.5em;
  }
</style>
