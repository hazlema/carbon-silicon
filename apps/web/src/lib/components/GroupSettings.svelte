<script lang="ts">
  import type { GroupInfo } from '@cs/shared/protocol';
  import { api } from '$lib/api';
  import { live } from '$lib/live.svelte';

  /** A group's settings (spec M2d §2): its name, who is in it, and for the owner, who is out. */
  let { open = $bindable(false), group, leaving = false }: { open: boolean; group: GroupInfo; leaving?: boolean } = $props();

  let dialog: HTMLDialogElement | undefined = $state();
  let name = $state('');
  let nameError = $state('');
  let error = $state('');
  let busy = $state(false);
  /** The one thing being confirmed: removing a handle, or leaving. */
  let confirm = $state<{ kind: 'remove'; handle: string } | { kind: 'leave' } | null>(null);
  const meId = $derived(live.me?.id ?? '');
  const isOwner = $derived(group.ownerId === meId);

  $effect(() => {
    if (!dialog) return;
    if (open && !dialog.open) {
      name = group.name ?? '';
      nameError = error = '';
      confirm = leaving ? { kind: 'leave' } : null;
      dialog.showModal();
    }
    if (!open && dialog.open) dialog.close();
  });

  /** Runs a call and lands the group it returns; a failure shows under `where`. */
  async function run(where: 'name' | 'general', fn: () => Promise<{ group: GroupInfo | null }>) {
    nameError = error = '';
    busy = true;
    try {
      const r = await fn();
      if (r.group) live.putGroup(r.group);
      else {
        live.dropGroup(group.id);
        open = false;
      }
    } catch (e) {
      if (where === 'name') nameError = (e as Error).message;
      else error = (e as Error).message;
    } finally {
      busy = false;
      confirm = null;
    }
  }
  const base = $derived(`/api/groups/${group.id}`);
  const save = (e: SubmitEvent) => {
    e.preventDefault();
    return run('name', () => api('PATCH', base, { name }));
  };
</script>

<dialog
  bind:this={dialog}
  class="settings"
  aria-labelledby="settings-title"
  onclose={() => (open = false)}
  onclick={(e) => {
    if (e.target === dialog) open = false;
  }}
>
  <div class="frame">
    <header>
      <h2 id="settings-title">Group settings</h2>
      <button class="close" type="button" aria-label="Close" onclick={() => (open = false)}>×</button>
    </header>

    <form onsubmit={save}>
      <label for="settings-name">Name</label>
      <div class="row">
        <input id="settings-name" bind:value={name} maxlength="40" autocomplete="off" placeholder="Name this group" />
        <button class="btn primary" type="submit" disabled={busy}>Save</button>
      </div>
      {#if nameError}<p class="error" role="alert">{nameError}</p>{/if}
    </form>

    <fieldset disabled>
      <legend>Visibility</legend>
      <label><input type="radio" name="visibility" checked /> Private</label>
      <label><input type="radio" name="visibility" /> Public</label>
      <p class="note">Public rooms are coming.</p>
    </fieldset>

    <section aria-labelledby="settings-members">
      <h3 id="settings-members">Members</h3>
      <ul>
        {#each group.members as m (m.identity.id)}
          <li>
            <span class="who">
              {#if m.owner}<span class="crown" role="img" aria-label="owner">♛</span>{/if}@{m.identity.handle}{#if m.identity.id === meId}
                <span class="you">(you)</span>{/if}
            </span>
            {#if isOwner && m.identity.id !== meId}
              {#if confirm?.kind === 'remove' && confirm.handle === m.identity.handle}
                <span class="ask" role="group" aria-label="Confirm removing @{m.identity.handle}">
                  <span>Remove @{m.identity.handle}? They can't be added back unless you un-ban them.</span>
                  <button class="btn" type="button" disabled={busy} onclick={() => run('general', () => api('DELETE', `${base}/members/${m.identity.handle}`))}
                    >Yes, remove</button
                  >
                  <button class="btn quiet" type="button" onclick={() => (confirm = null)}>Cancel</button>
                </span>
              {:else}
                <button class="btn quiet" type="button" aria-label="Remove @{m.identity.handle}" onclick={() => (confirm = { kind: 'remove', handle: m.identity.handle })}
                  >Remove</button
                >
              {/if}
            {/if}
          </li>
        {/each}
      </ul>
    </section>

    {#if isOwner && group.bans.length > 0}
      <section aria-labelledby="settings-bans">
        <h3 id="settings-bans">Removed</h3>
        <ul>
          {#each group.bans as b (b.id)}
            <li>
              <span class="who">@{b.handle}</span>
              <button class="btn quiet" type="button" aria-label="Un-ban @{b.handle}" disabled={busy} onclick={() => run('general', () => api('DELETE', `${base}/bans/${b.handle}`))}
                >Un-ban</button
              >
            </li>
          {/each}
        </ul>
      </section>
    {/if}

    {#if error}<p class="error" role="alert">{error}</p>{/if}

    <footer>
      {#if confirm?.kind === 'leave'}
        <span class="ask" role="group" aria-label="Confirm leaving">
          <span>Leave this group?</span>
          <button class="btn" type="button" disabled={busy} onclick={() => run('general', () => api('DELETE', `${base}/members/${live.me?.handle}`))}>Yes, leave</button>
          <button class="btn quiet" type="button" onclick={() => (confirm = null)}>Cancel</button>
        </span>
      {:else}
        <button class="btn" type="button" onclick={() => (confirm = { kind: 'leave' })}>Leave group</button>
      {/if}
    </footer>
  </div>
</dialog>

<style>
  .settings {
    width: min(30rem, calc(100vw - 2rem));
    max-height: calc(100dvh - 2rem);
    padding: 0;
    border: 1px solid var(--lattice);
    border-radius: var(--r-panel);
    background: var(--ink);
    color: var(--chalk);
    box-shadow: 0 1.5rem 4rem rgb(0 0 0 / 0.5);
  }
  .settings::backdrop {
    background: color-mix(in oklab, var(--ink-deep) 72%, transparent);
    backdrop-filter: blur(3px);
  }
  .frame {
    display: grid;
    gap: 1rem;
    padding: 1.1rem 1.25rem 1.25rem;
  }
  header {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  h2 {
    margin: 0;
    font-family: var(--font-carbon);
    font-size: var(--step-2);
    font-weight: 600;
  }
  h3 {
    margin: 0 0 0.4rem;
    font-size: var(--step-0);
    color: var(--fog);
  }
  .close {
    width: 2.5rem;
    height: 2.5rem;
    border: 0;
    border-radius: var(--r-control);
    background: transparent;
    color: var(--fog);
    font-size: 1.6rem;
    line-height: 1;
    cursor: pointer;
  }
  .close:hover {
    color: var(--chalk);
    background: var(--panel);
  }
  form {
    display: grid;
    gap: 0.4rem;
  }
  .row {
    display: flex;
    gap: 0.6rem;
  }
  .row input {
    flex: 1;
    min-width: 0;
  }
  fieldset {
    margin: 0;
    padding: 0;
    border: 0;
    min-width: 0;
    display: grid;
    gap: 0.3rem;
    color: var(--fog);
  }
  legend {
    padding: 0;
    margin-bottom: 0.3rem;
    color: var(--fog);
  }
  fieldset label {
    display: flex;
    gap: 0.5rem;
    align-items: center;
  }
  p {
    margin: 0;
  }
  .note {
    color: var(--dust);
    font-size: var(--step--1);
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 0.4rem;
  }
  li {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 0.4rem 0.8rem;
    min-width: 0;
  }
  .who {
    overflow-wrap: anywhere;
  }
  .crown {
    margin-right: 0.3rem;
    color: var(--carbon);
  }
  .you {
    color: var(--dust);
  }
  .ask {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.4rem 0.6rem;
    min-width: 0;
  }
  footer {
    display: flex;
    justify-content: flex-end;
    padding-top: 0.6rem;
    border-top: 1px solid var(--lattice);
  }
</style>
