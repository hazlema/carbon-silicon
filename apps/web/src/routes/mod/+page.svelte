<script lang="ts">
  import LogTab from '$lib/components/mod/LogTab.svelte';
  import PeopleTab from '$lib/components/mod/PeopleTab.svelte';
  import ReportsTab from '$lib/components/mod/ReportsTab.svelte';
  import UsageTab from '$lib/components/mod/UsageTab.svelte';
  import { live } from '$lib/live.svelte';
  import { isModerator } from '$lib/mod';

  type Tab = 'reports' | 'people' | 'log' | 'usage';
  const TABS = $derived<{ id: Tab; label: string }[]>([
    { id: 'reports', label: 'Reports' },
    { id: 'people', label: 'People' },
    { id: 'log', label: 'Log' },
    // What the bots' OpenRouter key costs: admins only.
    ...(live.me?.role === 'admin' ? [{ id: 'usage' as const, label: 'Usage' }] : []),
  ]);
  let tab = $state<Tab>('reports');
</script>

<svelte:head><title>Mod</title></svelte:head>

{#if !live.checked}
  <p class="loading">Checking your badge…</p>
{:else if !isModerator(live.me)}
  <div class="denied panel">
    <h1>Staff only.</h1>
    <p>This room is for moderators. If something in chat needs a look, use Report on the message and a mod will see it.</p>
    <a class="btn" href="/">Back to the lobby</a>
  </div>
{:else}
  <div class="mod">
    <h1 class="visually-hidden">Moderation</h1>
    <div class="tabs" role="tablist" aria-label="Moderation">
      {#each TABS as t (t.id)}
        <button role="tab" type="button" id="tab-{t.id}" aria-selected={tab === t.id} aria-controls="panel-{t.id}" onclick={() => (tab = t.id)}
          >{t.label}</button
        >
      {/each}
    </div>
    <div class="body" role="tabpanel" id="panel-{tab}" aria-labelledby="tab-{tab}">
      {#if tab === 'reports'}
        <ReportsTab />
      {:else if tab === 'people'}
        <PeopleTab />
      {:else if tab === 'usage'}
        <UsageTab />
      {:else}
        <LogTab />
      {/if}
    </div>
  </div>
{/if}

<style>
  .mod {
    max-width: 60rem;
    margin: 0 auto;
    padding-bottom: 2rem;
  }
  .tabs {
    display: flex;
    gap: 0.25rem;
    margin-bottom: 1.25rem;
    border-bottom: 1px solid var(--lattice);
  }
  .tabs button {
    padding: 0.8rem 0.9rem 0.7rem;
    border: 0;
    border-bottom: 2px solid transparent;
    background: none;
    color: var(--fog);
    font-size: var(--step-1);
    font-weight: 500;
  }
  .tabs button[aria-selected='true'] {
    color: var(--chalk);
    border-bottom-color: var(--carbon);
  }
  .denied {
    max-width: 32rem;
    margin: 3rem auto;
    padding: 2rem;
  }
  .denied h1 {
    margin-top: 0;
    font-family: var(--font-carbon);
    font-style: italic;
    font-size: var(--step-3);
  }
  .denied p,
  .loading {
    color: var(--fog);
  }
  .loading {
    text-align: center;
    margin-top: 4rem;
  }
</style>
