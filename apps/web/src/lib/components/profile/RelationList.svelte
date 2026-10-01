<script lang="ts">
  import IdentityChip from '$lib/components/IdentityChip.svelte';
  import { live } from '$lib/live.svelte';

  let error = $state('');
  async function undo(handle: string, kind: 'ignore' | 'block') {
    error = '';
    try {
      await live.setRelation(handle, kind, false);
    } catch (e) {
      error = (e as Error).message;
    }
  }
  const groups = $derived([
    { kind: 'ignore' as const, title: 'Ignored', people: live.relations.ignores, action: 'Stop ignoring' },
    { kind: 'block' as const, title: 'Blocked', people: live.relations.blocks, action: 'Unblock' },
  ]);
</script>

<section class="relations panel" aria-labelledby="relations-title">
  <h2 id="relations-title">Ignored &amp; blocked</h2>
  <p class="about">Ignore hides messages and mentions; block also stops invites and private chats.</p>
  {#each groups as g (g.kind)}
    <h3>{g.title}</h3>
    {#if g.people.length === 0}
      <p class="empty">Nobody.</p>
    {:else}
      <ul>
        {#each g.people as person (person.id)}
          <li>
            <IdentityChip identity={person} />
            <button class="btn quiet" type="button" onclick={() => undo(person.handle, g.kind)}>{g.action}</button>
          </li>
        {/each}
      </ul>
    {/if}
  {/each}
  {#if error}<p class="error" role="alert">{error}</p>{/if}
</section>

<style>
  .relations {
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
  h3 {
    margin: 1rem 0 0.4rem;
    font-size: var(--step-0);
    font-weight: 600;
  }
  .about,
  .empty {
    margin: 0;
    color: var(--fog);
    font-size: var(--step--1);
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 0.5rem;
  }
  li {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 1rem;
  }
</style>
