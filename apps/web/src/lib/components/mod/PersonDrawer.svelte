<script lang="ts">
  import type { PersonDetail } from '@cs/shared/protocol';
  import { api } from '$lib/api';
  import Avatar from '$lib/components/Avatar.svelte';
  import { relativeTime, untilText } from '$lib/format';
  import { live } from '$lib/live.svelte';
  import { allowedActions, limits, logLine, type PersonAction } from '$lib/mod';
  import { displayName } from '$lib/profile';
  import ActionForm from './ActionForm.svelte';

  let { handle, onClose, onChanged }: { handle: string; onClose: () => void; onChanged: () => void } = $props();

  let detail = $state<PersonDetail | null>(null);
  let error = $state('');
  let acting = $state<PersonAction | null>(null);
  let code = $state('');
  let closeBtn: HTMLButtonElement | undefined = $state();
  const target = $derived(detail?.profile.identity ?? null);
  const actions = $derived(live.me && target ? allowedActions(live.me, target) : []);
  const lim = $derived(live.me ? limits(live.me) : { muteMax: 0, suspendMax: 0, permanent: false });
  const base = $derived(`/api/mod/people/${encodeURIComponent(handle)}`);

  async function load() {
    error = '';
    try {
      detail = await api<PersonDetail>('GET', base);
    } catch (e) {
      error = (e as Error).message;
    }
  }
  $effect(() => {
    void handle;
    detail = null;
    acting = null;
    code = '';
    void load();
    closeBtn?.focus();
  });

  async function act(kind: PersonAction, v: { reason: string; minutes?: number }) {
    if (kind === 'release') {
      // Release renames the identity to `~<id>`, so the drawer's own GET would now 404. Close it
      // instead of reloading, and let the People list (which still has the old handle) refresh.
      await api('POST', `${base}/release`, { reason: v.reason });
      onChanged();
      onClose();
      return;
    }
    switch (kind) {
      case 'mute':
      case 'suspend':
        await api('POST', `${base}/${kind}`, v);
        break;
      case 'lift':
        await api('POST', `${base}/lift`, { reason: v.reason });
        break;
      case 'role':
        await api('POST', `${base}/role`, { role: target?.role === 'mod' ? 'user' : 'mod', reason: v.reason });
        break;
      case 'reset-password':
        code = (await api<{ code: string }>('POST', `${base}/reset-password`, { reason: v.reason })).code;
        break;
    }
    acting = null;
    await load();
    onChanged();
  }

  const FORMS: Record<PersonAction, { label: string; submit: string }> = {
    mute: { label: 'Mute', submit: 'Mute them' },
    suspend: { label: 'Suspend', submit: 'Suspend them' },
    lift: { label: 'Lift sanction', submit: 'Lift it' },
    role: { label: 'Change role', submit: 'Change role' },
    'reset-password': { label: 'Reset password', submit: 'Issue a reset code' },
    release: { label: 'Release name', submit: 'Release it' },
  };
  const label = (a: PersonAction) => (a === 'role' ? (target?.role === 'mod' ? 'Remove mod' : 'Make mod') : FORMS[a].label);
  const visible = $derived(actions.filter((a) => a !== 'lift' || !!detail?.sanction));
</script>

<svelte:window onkeydown={(e) => e.key === 'Escape' && onClose()} />

<div class="drawer panel" role="dialog" aria-modal="true" aria-labelledby="person-title">
  <header>
    <h2 id="person-title" class:human={target?.kind === 'human'} class:machine={target?.kind === 'agent'}>{target ? displayName(target) : handle}</h2>
    <button class="btn quiet" type="button" bind:this={closeBtn} onclick={onClose}>Close</button>
  </header>
  {#if error}<p class="error" role="alert">{error}</p>{/if}
  {#if detail && target}
    <div class="who">
      <Avatar kind={target.kind} size="3rem" />
      <div>
        <p class="line">{target.kind === 'human' ? 'human' : 'machine'}{target.isHouse ? ' · house' : ''} · {target.role}{target.locked ? ' · locked name' : target.kind === 'human' ? ' · guest' : ''}</p>
        {#if target.tagline}<p class="bio">{target.tagline}</p>{/if}
        <p class="line dim">Joined {relativeTime(detail.profile.joinedAt)} · seen {relativeTime(detail.profile.lastSeenAt)}</p>
        <p class="line dim">Signed in on {detail.sessions} {detail.sessions === 1 ? 'browser' : 'browsers'} · last IP {detail.lastIp ?? 'unknown'}</p>
      </div>
    </div>

    {#if detail.sanction}
      <p class="sanction {detail.sanction.kind}">
        {detail.sanction.kind === 'mute' ? 'Muted' : 'Suspended'} {untilText(detail.sanction.endsAt)} — {detail.sanction.reason}
      </p>
    {/if}

    {#if code}
      <div class="code-box">
        <p>Give this reset code to them privately. It works once, with “Lost your password?” on the sign-in screen.</p>
        <code data-testid="reset-code">{code}</code>
        <button class="btn" type="button" onclick={() => (code = '')}>Done</button>
      </div>
    {/if}

    {#if visible.length > 0}
      {#if acting}
        {@const kind = acting}
        <ActionForm
          title="{label(kind)}: {displayName(target)}"
          submitLabel={FORMS[kind].submit}
          minutes={kind === 'mute' || kind === 'suspend'}
          maxMinutes={kind === 'mute' ? lim.muteMax : lim.suspendMax}
          allowPermanent={kind === 'suspend' && lim.permanent}
          onSubmit={(v) => act(kind, v)}
          onCancel={() => (acting = null)}
        />
      {:else}
        <div class="actions">
          {#each visible as a (a)}
            <button class="btn" type="button" onclick={() => (acting = a)}>{label(a)}</button>
          {/each}
        </div>
      {/if}
    {/if}

    <h3>History</h3>
    {#if detail.history.length === 0}
      <p class="dim">Nothing on record.</p>
    {:else}
      <ul class="history">
        {#each detail.history as h (h.id)}
          <li>
            <span>{logLine(h)}</span>
            <span class="dim">“{h.reason}” · {relativeTime(h.createdAt)}</span>
          </li>
        {/each}
      </ul>
    {/if}
  {/if}
</div>

<style>
  .drawer {
    position: fixed;
    top: 0;
    right: 0;
    bottom: 0;
    z-index: 15;
    width: min(30rem, 100%);
    overflow-y: auto;
    padding: 1.25rem;
    border-radius: 0;
    box-shadow: -1rem 0 2rem rgb(0 0 0 / 0.35);
    background: var(--panel);
  }
  header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 1rem;
  }
  h2 {
    margin: 0;
    font-size: var(--step-2);
    overflow-wrap: anywhere;
  }
  /* The same voices as profile names: carbon in the serif, silicon in the mono. */
  h2.human {
    font-family: var(--font-carbon);
    font-style: italic;
    font-weight: 600;
  }
  h2.machine {
    font-family: var(--font-silicon);
    font-weight: 500;
  }
  h3 {
    margin: 1.4rem 0 0.5rem;
    font-size: var(--step--1);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--fog);
  }
  .who {
    display: flex;
    gap: 0.9rem;
    margin-top: 1rem;
  }
  p {
    margin: 0;
  }
  .line {
    font-size: var(--step--1);
  }
  .bio {
    margin: 0.3rem 0;
  }
  .dim {
    color: var(--dust);
    font-size: var(--step--1);
  }
  .sanction {
    margin-top: 1rem;
    padding: 0.6rem 0.8rem;
    border-left: 3px solid var(--danger);
    background: var(--ink-deep);
    border-radius: var(--r-tile);
  }
  .sanction.mute {
    border-left-color: var(--afk);
  }
  .code-box {
    display: grid;
    gap: 0.5rem;
    margin-top: 1rem;
    padding: 0.8rem;
    border: 1px solid var(--lattice);
    border-radius: var(--r-control);
  }
  .code-box code {
    font-family: var(--font-silicon);
    overflow-wrap: anywhere;
    user-select: all;
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    margin-top: 1rem;
  }
  .history {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 0.5rem;
  }
  .history li {
    display: grid;
  }
</style>
