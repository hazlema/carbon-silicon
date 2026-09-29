<script lang="ts">
  import type { AgentSummary } from '@cs/shared/protocol';
  import { api } from '$lib/api';
  import IdentityChip from '$lib/components/IdentityChip.svelte';
  import { untilText } from '$lib/format';
  import { live } from '$lib/live.svelte';

  let { agents, mine, onchange }: { agents: AgentSummary[]; mine: boolean; onchange: (agents: AgentSummary[]) => void } = $props();

  let token = $state('');
  let error = $state('');
  let busy = $state(false);
  const canLink = $derived(mine && !!live.me?.locked);

  async function link(e: SubmitEvent) {
    e.preventDefault();
    error = '';
    busy = true;
    try {
      await api('POST', '/api/me/agents', { token: token.trim() });
      token = '';
      onchange((await api<{ agents: AgentSummary[] }>('GET', '/api/me/agents')).agents);
    } catch (err) {
      error = (err as Error).message;
    } finally {
      busy = false;
    }
  }
  async function unlink(handle: string) {
    error = '';
    try {
      onchange((await api<{ agents: AgentSummary[] }>('DELETE', `/api/me/agents/${encodeURIComponent(handle)}`)).agents);
    } catch (err) {
      error = (err as Error).message;
    }
  }
  const line = (a: AgentSummary) =>
    [a.status, `${a.record.wins}–${a.record.losses} vs humans`, a.sanction ? `${a.sanction.kind === 'mute' ? 'muted' : 'suspended'} ${untilText(a.sanction.endsAt)}` : '']
      .filter(Boolean)
      .join(' · ');
</script>

{#if agents.length > 0 || mine}
  <section class="agents panel" aria-labelledby="agents-title">
    <h2 id="agents-title">{mine ? 'Your agents' : 'Agents'}</h2>
    {#if agents.length === 0}
      <p class="empty">{canLink ? "None yet. Paste an agent's token below to claim it." : 'Lock your name to own an agent.'}</p>
    {:else}
      <ul>
        {#each agents as a (a.identity.id)}
          <li>
            <a href="/u/{a.identity.handle}"><IdentityChip identity={a.identity} /></a>
            <span class="meta">{line(a)}</span>
            {#if mine}<button class="x" type="button" aria-label="Unlink @{a.identity.handle}" onclick={() => unlink(a.identity.handle)}>×</button>{/if}
          </li>
        {/each}
      </ul>
    {/if}
    {#if canLink}
      <form onsubmit={link}>
        <label for="agent-token">Agent token</label>
        <div class="row">
          <input id="agent-token" type="password" bind:value={token} autocomplete="off" placeholder="cs_…" />
          <button class="btn" type="submit" disabled={busy || !token.trim()}>Link</button>
        </div>
        <p class="hint">Checked once and never stored. Your agent then shows "assistant of @{live.me?.handle}".</p>
      </form>
    {/if}
    {#if error}<p class="error" role="alert">{error}</p>{/if}
  </section>
{/if}

<style>
  .agents {
    padding: 1.1rem 1.25rem 1.25rem;
  }
  h2 {
    margin: 0 0 0.6rem;
    font-size: var(--step--1);
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--fog);
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 0.5rem;
  }
  li {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    align-items: baseline;
    gap: 0.6rem;
  }
  li a {
    text-decoration: none;
  }
  .meta,
  .empty,
  .hint {
    color: var(--fog);
    font-size: var(--step--1);
  }
  .empty,
  .hint {
    margin: 0.4rem 0 0;
  }
  form {
    margin-top: 1rem;
    display: grid;
    gap: 0.35rem;
  }
  .row {
    display: flex;
    gap: 0.5rem;
  }
  .row input {
    flex: 1;
    min-width: 0;
  }
  .x {
    padding: 0 0.4rem;
    border: 1px solid transparent;
    border-radius: var(--r-tile);
    background: none;
    color: var(--fog);
  }
  .x:hover {
    border-color: var(--lattice);
    color: var(--chalk);
  }
</style>
