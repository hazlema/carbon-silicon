<script lang="ts">
  import { tick } from 'svelte';
  import { dmParticipants, groupOf, type GameInfo } from '@cs/shared/protocol';
  import { api } from '$lib/api';
  import { live } from '$lib/live.svelte';
  import { portal } from '$lib/portal';
  import type { GroupInfo } from '@cs/shared/protocol';
  import GameChooser from './GameChooser.svelte';
  import GroupSettings from './GroupSettings.svelte';
  import PeoplePicker from './PeoplePicker.svelte';

  /** The ⋯ menu for the open DM or group (spec M2d §2): Add someone, and for a group, its settings, hosting for everyone, and Leave. */
  let { channel }: { channel: string } = $props();

  const dm = $derived(dmParticipants(channel) ? (live.dms.find((d) => d.channel === channel) ?? null) : null);
  const group = $derived(groupOf(channel) ? (live.groups.find((g) => g.channel === channel) ?? null) : null);
  const full = $derived(!!group && group.members.length >= group.maxMembers);

  let menuOpen = $state(false);
  let button: HTMLButtonElement | undefined = $state();
  let pop: HTMLDivElement | undefined = $state();
  let pos = $state<{ left: number; top: number } | null>(null);
  let picking = $state(false);
  let settings = $state(false);
  let leaving = $state(false);
  let choosing = $state(false);
  let hostError = $state('');

  const items = () => [...(pop?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
  function closeMenu(refocus = false) {
    menuOpen = false;
    if (refocus) button?.focus();
  }
  function onMenuKey(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeMenu(true);
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const list = items();
      if (list.length === 0) return;
      const i = list.indexOf(document.activeElement as HTMLElement);
      list[e.key === 'ArrowDown' ? (i + 1) % list.length : (i - 1 + list.length) % list.length].focus();
    } else if (e.key === 'Tab') closeMenu();
  }
  async function toggle() {
    menuOpen = !menuOpen;
    pos = null;
    if (!menuOpen) return;
    await tick();
    if (!button || !pop) return;
    const b = button.getBoundingClientRect();
    const p = pop.getBoundingClientRect();
    pos = { left: Math.max(8, Math.min(b.right - p.width, window.innerWidth - p.width - 8)), top: b.bottom + 4 };
    await tick();
    items()[0]?.focus();
  }
  $effect(() => {
    if (!menuOpen) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!button?.contains(t) && !pop?.contains(t)) menuOpen = false;
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  });
  // A dialog closing hands focus back to the ⋯ button that opened it (the menu item it came from is gone).
  $effect(() => {
    if (!picking && !settings && !choosing) return;
    return () => void tick().then(() => button?.focus());
  });
  $effect(() => {
    channel;
    menuOpen = false;
  });

  function pick(what: 'add' | 'settings' | 'leave' | 'host') {
    closeMenu();
    if (what === 'add') picking = true;
    else if (what === 'settings' || what === 'leave') {
      leaving = what === 'leave';
      settings = true;
    }
    else {
      hostError = '';
      choosing = true;
    }
  }

  async function add(handle: string) {
    if (group) live.putGroup((await api<{ group: GroupInfo }>('POST', `/api/groups/${group.id}/members`, { handle })).group);
    else if (dm) live.openGroup((await api<{ group: GroupInfo }>('POST', '/api/groups', { with: [dm.with.handle, handle] })).group);
  }

  const members = $derived(group?.members.length ?? 0);
  const hostable = $derived(live.games.filter((g) => g.humans));
  const unavailable = (g: GameInfo) => (members > g.maxPlayers ? `Too many for ${g.name} (${g.maxPlayers} seats)` : null);
  const reason = { away: 'away', playing: 'in a match', unavailable: 'unavailable' } as const;
  const list = (xs: string[]) => (xs.length < 2 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

  async function host(g: GameInfo) {
    if (!group) return;
    choosing = false;
    try {
      const r = await api<{ skipped: { handle: string; reason: keyof typeof reason }[] }>('POST', `/api/groups/${group.id}/host`, { gameId: g.id });
      if (r.skipped.length > 0) {
        const skipped = new Set(r.skipped.map((s) => s.handle));
        const invited = group.members.map((m) => m.identity.handle).filter((h) => h !== live.me?.handle && !skipped.has(h));
        const who = r.skipped.map((s) => `${s.handle} is ${reason[s.reason] ?? s.reason}.`).join(' ');
        live.convNotice = { channel, text: `${invited.length > 0 ? `Invited ${list(invited)}. ` : ''}${who}` };
      }
    } catch (e) {
      live.convNotice = { channel, text: (e as Error).message };
    }
  }
</script>

{#if dm || group}
  <button
    bind:this={button}
    type="button"
    class="dots"
    aria-label="Conversation options"
    aria-haspopup="menu"
    aria-expanded={menuOpen}
    onclick={toggle}><span aria-hidden="true">⋯</span></button
  >
  {#if menuOpen}
    <div
      class="pop panel"
      role="menu"
      tabindex="-1"
      aria-label="Conversation options"
      use:portal
      bind:this={pop}
      onkeydown={onMenuKey}
      style={pos ? `left: ${pos.left}px; top: ${pos.top}px` : 'visibility: hidden'}
    >
      {#if group}<button role="menuitem" type="button" onclick={() => pick('settings')}>Group settings</button>{/if}
      <button
        role="menuitem"
        type="button"
        aria-disabled={full}
        onclick={() => !full && pick('add')}>Add someone…{#if full}<span class="full"> Full ({members} of {group?.maxMembers})</span>{/if}</button
      >
      {#if group}
        <button role="menuitem" type="button" onclick={() => pick('host')}>Host a table with everyone</button>
        <button role="menuitem" type="button" onclick={() => pick('leave')}>Leave group</button>
      {/if}
    </div>
  {/if}
  <PeoplePicker bind:open={picking} exclude={group ? group.members.map((m) => m.identity.handle) : dm ? [dm.with.handle] : []} onsubmit={add} />
  {#if group}
    <GroupSettings bind:open={settings} {group} {leaving} />
    <GameChooser bind:open={choosing} games={hostable} onpick={host} {unavailable} />
  {/if}
{/if}

<style>
  .dots {
    flex: none;
    align-self: center;
    padding: 0.3rem 0.65rem;
    background: none;
    border: 0;
    border-radius: var(--r-control);
    color: var(--fog);
    font-size: var(--step-1);
    line-height: 1;
  }
  .dots:hover,
  .dots[aria-expanded='true'] {
    color: var(--chalk);
    background: var(--panel);
  }
  .pop {
    position: fixed;
    z-index: 30;
    display: grid;
    min-width: 12rem;
    max-width: calc(100vw - 16px);
    padding: 0.4rem;
    background: var(--panel-2);
    box-shadow: 0 0.8rem 2rem rgb(0 0 0 / 0.4);
  }
  [role='menuitem'] {
    padding: 0.5rem 0.65rem;
    border: 0;
    border-radius: var(--r-control);
    background: none;
    text-align: left;
    font: inherit;
  }
  [role='menuitem']:hover,
  [role='menuitem']:focus-visible {
    background: var(--panel);
  }
  [role='menuitem'][aria-disabled='true'] {
    color: var(--dust);
    cursor: not-allowed;
  }
  .full {
    color: var(--dust);
  }
</style>
