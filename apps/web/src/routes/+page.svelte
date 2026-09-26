<script lang="ts">
  import ChatPanel from '$lib/components/ChatPanel.svelte';
  import QuickMatch from '$lib/components/QuickMatch.svelte';
  import Scoreboard from '$lib/components/Scoreboard.svelte';
  import WhoList from '$lib/components/WhoList.svelte';

  const channels = [
    { id: 'lobby', about: 'Everyone, everything' },
    { id: 'critical-mass', about: 'Chain reactions and excuses' },
    { id: 'diary', about: 'Notes from the Proprietor' },
  ];
  let channel = $state('lobby');
  let tab = $state<'chat' | 'who'>('chat');
</script>

<div class="lobby">
  <aside class="left">
    <Scoreboard />
    <nav class="channels panel" aria-label="Channels">
      <ul>
        {#each channels as c}
          <li>
            <button
              type="button"
              aria-current={channel === c.id ? 'true' : undefined}
              onclick={() => {
                channel = c.id;
                tab = 'chat';
              }}
            >
              <span class="name"><span class="hash" aria-hidden="true">#</span>{c.id}</span>
              <span class="about">{c.about}</span>
            </button>
          </li>
        {/each}
      </ul>
    </nav>
  </aside>

  <div class="tabs" role="tablist" aria-label="Lobby">
    <button role="tab" type="button" aria-selected={tab === 'chat'} onclick={() => (tab = 'chat')}>Chat</button>
    <button role="tab" type="button" aria-selected={tab === 'who'} onclick={() => (tab = 'who')}>Here now</button>
  </div>

  <div class="center" class:hide={tab !== 'chat'}>
    <ChatPanel {channel} title={`#${channel}`} readOnly={channel === 'diary'} />
  </div>

  <aside class="right">
    <QuickMatch />
    <div class="whowrap" class:hide={tab !== 'who'}><WhoList /></div>
  </aside>
</div>

<style>
  .lobby {
    display: grid;
    grid-template-columns: 15.5rem minmax(0, 1fr) 19rem;
    grid-template-areas: 'left center right';
    gap: 1rem;
    height: calc(100dvh - var(--nav-h) - 1.5rem);
    min-height: 34rem;
  }
  .left {
    grid-area: left;
  }
  .center {
    grid-area: center;
    min-height: 0;
  }
  .right {
    grid-area: right;
  }
  .left,
  .right {
    display: flex;
    flex-direction: column;
    gap: 1rem;
    min-height: 0;
  }
  .whowrap {
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
  .channels ul {
    list-style: none;
    margin: 0;
    padding: 0.4rem;
  }
  .channels button {
    width: 100%;
    display: grid;
    text-align: left;
    background: none;
    border: 0;
    border-radius: var(--r-control);
    padding: 0.5rem 0.6rem;
  }
  .channels button:hover {
    background: var(--panel-2);
  }
  .channels button[aria-current='true'] {
    background: var(--panel-2);
  }
  .name {
    font-weight: 600;
  }
  .hash {
    color: var(--dust);
    margin-right: 0.1rem;
  }
  .about {
    color: var(--dust);
    font-size: var(--step--1);
  }
  .tabs {
    display: none;
  }
  @media (max-width: 960px) {
    .lobby {
      grid-template-columns: minmax(0, 1fr);
      grid-template-areas: 'left' 'right' 'tabs' 'center';
      height: auto;
    }
    .tabs {
      grid-area: tabs;
      display: flex;
      gap: 0.4rem;
    }
    .tabs button {
      flex: 1;
      padding: 0.55rem;
      border-radius: var(--r-control);
      border: 1px solid var(--lattice);
      background: transparent;
      font-weight: 600;
      color: var(--fog);
    }
    .tabs button[aria-selected='true'] {
      background: var(--panel-2);
      color: var(--chalk);
    }
    .center {
      height: 70dvh;
    }
    .channels ul {
      display: flex;
      gap: 0.3rem;
      overflow-x: auto;
    }
    .about {
      display: none;
    }
    .hide {
      display: none;
    }
  }
</style>
