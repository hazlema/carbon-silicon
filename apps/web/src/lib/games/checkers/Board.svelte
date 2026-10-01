<script lang="ts">
  import { onMount } from 'svelte';
  import type { CheckersCommand, CheckersView } from '@cs/checkers';
  import type { mountCheckers } from './board';

  let {
    view,
    legal,
    interactive,
    onMove,
  }: {
    view: CheckersView;
    legal: unknown[];
    interactive: boolean;
    onMove: (command: CheckersCommand) => void | Promise<void>;
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
      // The standalone page chrome stays behind — the table page brings its own.
      const trim = document.createElement('style');
      trim.textContent =
        '.masthead,.page-heading,footer{display:none}' +
        '.app-shell{max-width:none;padding:0 1.5rem 1.5rem}' +
        '.board-root{min-height:0;background-attachment:scroll}';
      host.shadowRoot?.append(trim);
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

<div class="crown" bind:this={host}></div>

<style>
  .crown {
    width: 100%;
  }
</style>
