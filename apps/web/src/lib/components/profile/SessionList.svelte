<script lang="ts">
  import type { SessionInfo } from '@cs/shared/protocol';
  import { api } from '$lib/api';
  import { relativeTime } from '$lib/format';

  let sessions = $state<SessionInfo[]>([]);
  let note = $state('');
  let error = $state('');

  async function load() {
    try {
      sessions = (await api<{ sessions: SessionInfo[] }>('GET', '/api/me/sessions')).sessions;
    } catch (e) {
      error = (e as Error).message;
    }
  }
  $effect(() => {
    void load();
  });

  async function revoke(id: string) {
    error = '';
    note = '';
    try {
      await api('DELETE', `/api/me/sessions/${encodeURIComponent(id)}`);
      await load();
    } catch (e) {
      error = (e as Error).message;
    }
  }
  async function revokeOthers() {
    error = '';
    note = '';
    try {
      const r = await api<{ revoked: number }>('DELETE', '/api/me/sessions');
      note = `Signed out ${r.revoked} other ${r.revoked === 1 ? 'browser' : 'browsers'}.`;
      await load();
    } catch (e) {
      error = (e as Error).message;
    }
  }
</script>

<section class="sessions panel" aria-labelledby="sessions-title">
  <h2 id="sessions-title">Signed in</h2>
  <ul>
    {#each sessions as s (s.id)}
      <li>
        <div class="what">
          <span class="label">{s.label || 'A browser'}</span>
          <span class="meta">{s.ip ?? 'unknown IP'} · last used {relativeTime(s.lastUsedAt)}</span>
        </div>
        {#if s.current}
          <span class="current">This browser</span>
        {:else}
          <button class="btn quiet" type="button" onclick={() => revoke(s.id)}>Sign out</button>
        {/if}
      </li>
    {/each}
  </ul>
  {#if sessions.some((s) => !s.current)}
    <button class="btn" type="button" onclick={revokeOthers}>Sign out everywhere else</button>
  {/if}
  {#if note}<p class="note" role="status">{note}</p>{/if}
  {#if error}<p class="error" role="alert">{error}</p>{/if}
</section>

<style>
  .sessions {
    padding: 1.1rem 1.25rem 1.25rem;
  }
  h2 {
    margin: 0 0 0.8rem;
    font-size: var(--step--1);
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--fog);
  }
  ul {
    list-style: none;
    margin: 0 0 1rem;
    padding: 0;
    display: grid;
    gap: 0.6rem;
  }
  li {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 1rem;
  }
  .what {
    display: grid;
    min-width: 0;
  }
  .label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .meta {
    color: var(--dust);
    font-size: var(--step--1);
    font-family: var(--font-silicon);
  }
  .current {
    color: var(--ready);
    font-size: var(--step--1);
    white-space: nowrap;
  }
  .note {
    color: var(--ready);
    font-size: var(--step--1);
  }
</style>
