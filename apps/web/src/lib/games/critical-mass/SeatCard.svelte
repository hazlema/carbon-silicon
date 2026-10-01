<script lang="ts">
  import type { SeatInfo } from '@cs/shared/protocol';
  import Avatar from '$lib/components/Avatar.svelte';
  import IdentityChip from '$lib/components/IdentityChip.svelte';
  import { clock } from '$lib/seats';

  let {
    s,
    color,
    you,
    onClock,
    out,
    secondsLeft,
    live,
    count,
    corner,
  }: {
    s: SeatInfo;
    color: string;
    you: boolean;
    onClock: boolean;
    out: boolean;
    secondsLeft: number | null;
    live: boolean;
    count: { cells: number; orbs: number };
    corner: 'tl' | 'tr' | 'bl' | 'br';
  } = $props();
  const note = $derived(you ? 'you' : s.identity.isHouse ? 'house' : '');
</script>

<div class="seat {corner}" class:onclock={onClock && !out} class:out style:--seat={color} data-seat={s.seat}>
  <Avatar kind={s.identity.kind} size="2.5rem" glow={onClock && !out} />
  <div class="id">
    <span class="name"><IdentityChip identity={s.identity} badge={false} tag={false} />{#if note}<small>{note}</small>{/if}</span>
    <span class="stats"><b>{count.orbs}</b> {count.orbs === 1 ? 'orb' : 'orbs'} · {count.cells} {count.cells === 1 ? 'cell' : 'cells'}</span>
  </div>
  <span class="state">
    {#if out}out{:else if onClock && secondsLeft !== null}<span class="clock" class:low={secondsLeft <= 15} aria-label="{secondsLeft} seconds left">{clock(secondsLeft)}</span>{:else if live}waiting{/if}
  </span>
</div>

<style>
  .seat {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px 14px;
    background: rgba(18, 22, 42, 0.85);
    border: 1px solid #1f2438;
    border-radius: 12px;
    pointer-events: none;
    min-width: 0;
  }
  .seat.tr,
  .seat.br {
    flex-direction: row-reverse;
    text-align: right;
  }
  .seat.onclock {
    border-color: var(--seat);
  }
  .seat.out {
    opacity: 0.45;
  }
  .id {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .name {
    display: flex;
    align-items: baseline;
    gap: 6px;
    font-size: var(--step-0);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .tr .name,
  .br .name {
    flex-direction: row-reverse;
  }
  small {
    font-size: 11px;
    color: #7c829e;
  }
  .stats {
    font-size: 12px;
    color: #9aa0ba;
    margin-top: 2px;
  }
  .stats b {
    font: 600 13px var(--font-silicon);
    color: #e6e8f2;
  }
  .state {
    margin-inline: 10px 0;
    font-size: 12px;
    color: #5c6280;
  }
  .tr .state,
  .br .state {
    margin-inline: 0 10px;
  }
  .clock {
    font: 600 16px var(--font-silicon);
    color: var(--seat);
    font-variant-numeric: tabular-nums;
  }
  .clock.low {
    color: var(--danger, #ff6b6b);
  }
  @container (max-width: 560px) {
    .seat {
      gap: 8px;
      padding: 8px 10px;
    }
    .seat :global(.avatar) {
      --size: 1.75rem !important;
    }
    .state {
      margin-inline: 4px 0;
      font-size: 11px;
    }
    .tr .state,
    .br .state {
      margin-inline: 0 4px;
    }
    /* Narrow: the name gets the room; "you"/"house" is already said by the tile and the order. */
    small {
      display: none;
    }
    .clock {
      font-size: 14px;
    }
  }
</style>
