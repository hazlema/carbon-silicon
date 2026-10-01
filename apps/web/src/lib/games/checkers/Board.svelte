<script lang="ts">
  import { onMount, type Snippet } from 'svelte';
  import type { CheckersCommand, CheckersView } from '@cs/checkers';
  import type { BoardProps, mountCheckers } from './board';

  let {
    view,
    legal,
    interactive,
    onMove,
    players,
    actions,
  }: {
    view: CheckersView;
    legal: unknown[];
    interactive: boolean;
    onMove: (command: CheckersCommand) => void | Promise<void>;
    players?: BoardProps['players'];
    /** The table's own controls (Resign, errors), shown at the end of the battlefield's footer. */
    actions?: Snippet;
  } = $props();

  let host: HTMLDivElement;
  let board = $state<ReturnType<typeof mountCheckers>>();

  // The board simulates marches with structuredClone, which cannot clone $state proxies:
  // hand it plain data, never Svelte's reactive wrappers.
  const plain = () => ({
    view: $state.snapshot(view) as CheckersView,
    legal: $state.snapshot(legal) as unknown[],
    interactive,
    onMove,
    players: $state.snapshot(players),
  });

  onMount(() => {
    let cancelled = false;
    // Dynamic import keeps three.js out of every other page's bundle (and out of SSR).
    void import('./board').then(({ mountCheckers: mount }) => {
      if (cancelled) return;
      board = mount(host, plain(), {
        stylesheetUrl: '/games/checkers/style.css',
        backdropUrl: '/games/checkers/citadel.png',
      });
    });
    return () => {
      cancelled = true;
      board?.destroy();
    };
  });

  $effect(() => {
    board?.update(plain());
  });
</script>

<!-- Light-DOM children stay styled by the page; the slot attribute projects them into the shadow footer. -->
<div class="crown" bind:this={host}>
  {#if actions}<div class="actions" {...{ slot: 'actions' }}>{@render actions()}</div>{/if}
</div>

<style>
  .crown {
    width: 100%;
    height: 100%;
  }
  .actions {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }
</style>
