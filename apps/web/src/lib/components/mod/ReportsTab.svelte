<script lang="ts">
  import type { ReportInfo, ReportResolution } from '@cs/shared/protocol';
  import { api } from '$lib/api';
  import IdentityChip from '$lib/components/IdentityChip.svelte';
  import { relativeTime } from '$lib/format';
  import { live } from '$lib/live.svelte';
  import { allowedActions, contextLines, limits, reportAbout } from '$lib/mod';
  import { displayName } from '$lib/profile';
  import ActionForm from './ActionForm.svelte';

  type Acting = { id: string; kind: ReportResolution | 'reopen' };
  let status = $state<'open' | 'resolved'>('open');
  let resolvedBy = $state('');
  let reports = $state<ReportInfo[]>([]);
  let loading = $state(true);
  let error = $state('');
  let acting = $state<Acting | null>(null);
  const lim = $derived(live.me ? limits(live.me) : { muteMax: 0, suspendMax: 0, permanent: false });

  async function load(s: 'open' | 'resolved', by: string) {
    loading = true;
    error = '';
    try {
      const q = `status=${s}${s === 'resolved' && by.trim() ? `&resolvedBy=${encodeURIComponent(by.trim())}` : ''}`;
      const list = (await api<{ reports: ReportInfo[] }>('GET', `/api/mod/reports?${q}`)).reports;
      // The open queue reads oldest first; resolved reports newest first.
      reports = [...list].sort((a, b) => (s === 'open' ? 1 : -1) * a.createdAt.localeCompare(b.createdAt));
    } catch (e) {
      error = (e as Error).message;
    } finally {
      loading = false;
    }
  }
  $effect(() => {
    const s = status;
    const by = resolvedBy;
    const t = setTimeout(() => void load(s, by), s === 'resolved' ? 250 : 0);
    return () => clearTimeout(t);
  });
  // New reports arrive while you watch the queue.
  $effect(() =>
    live.onInbox((e) => {
      if (e.type === 'report.opened' && status === 'open') void load(status, resolvedBy);
    }),
  );

  async function resolve(r: ReportInfo, kind: ReportResolution, v: { reason: string; minutes?: number }) {
    await api('POST', `/api/mod/reports/${encodeURIComponent(r.id)}/resolve`, { resolution: kind, reason: v.reason, ...(v.minutes ? { minutes: v.minutes } : {}) });
    acting = null;
    await load(status, resolvedBy);
  }
  async function reopen(r: ReportInfo, v: { reason: string }) {
    await api('POST', `/api/mod/reports/${encodeURIComponent(r.id)}/reopen`, { reason: v.reason });
    acting = null;
    await load(status, resolvedBy);
  }

  const canSanction = (r: ReportInfo) => !!live.me && !!r.target && allowedActions(live.me, r.target).length > 0;
  const who = (r: ReportInfo) => reportAbout(r);
  const LABEL: Record<ReportResolution, string> = { dismiss: 'Dismiss', delete: 'Delete message', mute: 'Mute', suspend: 'Suspend' };
  const SUBMIT: Record<ReportResolution, string> = { dismiss: 'Dismiss it', delete: 'Delete it', mute: 'Mute them', suspend: 'Suspend them' };
</script>

<div class="bar">
  <div class="seg" role="group" aria-label="Which reports">
    <button type="button" aria-pressed={status === 'open'} onclick={() => (status = 'open')}>Open</button>
    <button type="button" aria-pressed={status === 'resolved'} onclick={() => (status = 'resolved')}>Resolved</button>
  </div>
  {#if status === 'resolved'}
    <label class="by">Resolved by <input bind:value={resolvedBy} placeholder="any handle" /></label>
  {/if}
</div>

{#if error}<p class="error" role="alert">{error}</p>{/if}
{#if !loading && reports.length === 0}
  <p class="empty">{status === 'open' ? 'The queue is empty. Quiet night.' : 'No resolved reports match.'}</p>
{/if}

<div class="list">
  {#each reports as r (r.id)}
    <article class="report panel" aria-label="Report about {who(r)}">
      <header>
        <span class="about">Report about <strong>{who(r)}</strong> in <span class="chan">{(/^(match|table):/).test(r.snapshot.channel) ? 'a table' : r.snapshot.channel.startsWith('rail:') ? 'a rail' : `#${r.snapshot.channel}`}</span></span>
        <span class="when">{relativeTime(r.createdAt)}</span>
      </header>
      <ol class="context">
        {#each contextLines(r) as line (line.messageId)}
          <li class:reported={line.reported}>
            <span class="who">{line.author ? displayName(line.author) : 'system'}</span>
            <span class="text">{line.text}</span>
          </li>
        {/each}
      </ol>
      <p class="meta">
        Reported by <IdentityChip identity={r.reporter} badge={false} />{#if r.reason}: “{r.reason}”{/if}
      </p>
      {#if r.notes.length > 0}
        <ul class="notes">
          {#each r.notes as n, i (i)}
            <li><strong>@{n.by}</strong> {n.text} <span class="when">{relativeTime(n.at)}</span></li>
          {/each}
        </ul>
      {/if}

      {#if r.status === 'open'}
        {#if acting?.id === r.id && acting.kind !== 'reopen'}
          {@const kind = acting.kind}
          <ActionForm
            title="{LABEL[kind]} — report about {who(r)}"
            submitLabel={SUBMIT[kind]}
            minutes={kind === 'mute' || kind === 'suspend'}
            maxMinutes={kind === 'mute' ? lim.muteMax : lim.suspendMax}
            allowPermanent={kind === 'suspend' && lim.permanent}
            onSubmit={(v) => resolve(r, kind, v)}
            onCancel={() => (acting = null)}
          />
        {:else}
          <div class="actions">
            <button class="btn" type="button" onclick={() => (acting = { id: r.id, kind: 'dismiss' })}>Dismiss</button>
            <button class="btn" type="button" onclick={() => (acting = { id: r.id, kind: 'delete' })}>Delete message</button>
            {#if canSanction(r)}
              <button class="btn" type="button" onclick={() => (acting = { id: r.id, kind: 'mute' })}>Mute</button>
              <button class="btn" type="button" onclick={() => (acting = { id: r.id, kind: 'suspend' })}>Suspend</button>
            {/if}
          </div>
        {/if}
      {:else}
        <p class="resolved">
          Resolved: {r.resolution} by @{r.resolvedBy}{#if r.resolvedAt}, {relativeTime(r.resolvedAt)}{/if}
        </p>
        {#if acting?.id === r.id && acting.kind === 'reopen'}
          <ActionForm title="Reopen this report" submitLabel="Reopen it" onSubmit={(v) => reopen(r, v)} onCancel={() => (acting = null)} />
        {:else}
          <div class="actions"><button class="btn quiet" type="button" onclick={() => (acting = { id: r.id, kind: 'reopen' })}>Reopen</button></div>
        {/if}
      {/if}
    </article>
  {/each}
</div>

<style>
  .bar {
    display: flex;
    flex-wrap: wrap;
    gap: 1rem;
    align-items: center;
    margin-bottom: 1rem;
  }
  .seg {
    display: inline-flex;
    border: 1px solid var(--lattice);
    border-radius: var(--r-control);
    overflow: hidden;
  }
  .seg button {
    padding: 0.4rem 0.9rem;
    border: 0;
    background: transparent;
    color: var(--fog);
    font-weight: 600;
  }
  .seg button[aria-pressed='true'] {
    background: var(--panel-2);
    color: var(--chalk);
  }
  .by {
    display: inline-flex;
    gap: 0.5rem;
    align-items: center;
    color: var(--fog);
    font-size: var(--step--1);
  }
  .list {
    display: grid;
    gap: 1rem;
  }
  .report {
    padding: 1rem 1.25rem;
  }
  header {
    display: flex;
    justify-content: space-between;
    gap: 1rem;
    flex-wrap: wrap;
  }
  .chan {
    font-family: var(--font-silicon);
  }
  .when,
  .empty {
    color: var(--dust);
    font-size: var(--step--1);
  }
  .context {
    list-style: none;
    margin: 0.8rem 0;
    padding: 0.6rem 0.8rem;
    border-radius: var(--r-control);
    background: var(--ink-deep);
    display: grid;
    gap: 0.25rem;
    font-size: var(--step--1);
  }
  .context li {
    display: grid;
    grid-template-columns: 9rem minmax(0, 1fr);
    gap: 0.6rem;
    color: var(--fog);
  }
  .context li.reported {
    color: var(--chalk);
    font-weight: 600;
  }
  .who {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--dust);
  }
  .text {
    overflow-wrap: anywhere;
  }
  .meta,
  .resolved {
    margin: 0;
    color: var(--fog);
    font-size: var(--step--1);
  }
  .notes {
    margin: 0.6rem 0 0;
    padding-left: 1.1rem;
    font-size: var(--step--1);
    color: var(--fog);
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    margin-top: 0.8rem;
  }
  @media (max-width: 640px) {
    .context li {
      grid-template-columns: minmax(0, 1fr);
      gap: 0;
    }
  }
</style>
