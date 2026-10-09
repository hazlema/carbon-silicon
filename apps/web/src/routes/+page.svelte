<script lang="ts">
  import { dmParticipants, groupOf } from '@cs/shared/protocol';
  import ChatPanel from '$lib/components/ChatPanel.svelte';
  import ConvMenu from '$lib/components/ConvMenu.svelte';
  import ConvTabs from '$lib/components/ConvTabs.svelte';
  import QuickMatch from '$lib/components/QuickMatch.svelte';
  import Scoreboard from '$lib/components/Scoreboard.svelte';
  import TablesList from '$lib/components/TablesList.svelte';
  import WhoList from '$lib/components/WhoList.svelte';
  import { groupTitle } from '$lib/groups';
  import { live } from '$lib/live.svelte';
  import { MediaQuery } from 'svelte/reactivity';

  const channels = [
    { id: 'lobby', about: 'Everyone, everything' },
  ];
  let channel = $state('lobby');
  // Name menus offer the chat on screen first.
  $effect(() => {
    const ch = channel;
    live.openConv = ch;
    return () => {
      if (live.openConv === ch) live.openConv = null;
    };
  });
  let tab = $state<'chat' | 'who'>('chat');
  let chatTabBtn: HTMLButtonElement | undefined = $state();
  /** The one-column layout, where `tab` decides between the chat and Here now; wider, the chat is always on screen. */
  const narrow = new MediaQuery('max-width: 960px');
  const chatSeen = $derived(tab === 'chat' || !narrow.current);
  let focusKey = $state(0);
  /** The conversation on screen, when the chat shows a DM. */
  const dm = $derived(dmParticipants(channel) ? (live.dms.find((d) => d.channel === channel) ?? null) : null);
  /** The group on screen, when the chat shows one. */
  const group = $derived(groupOf(channel) ? (live.groups.find((g) => g.channel === channel) ?? null) : null);
  const about = $derived(
    group ? `${group.members.length} people` : dm ? 'Just the two of you' : (channels.find((c) => c.id === channel)?.about ?? ''),
  );
  const title = $derived(group ? groupTitle(group, live.me!.id) : dm ? `@${dm.with.handle}` : `#${channel}`);

  // Message @x or /msg: show that conversation and put the cursor in its composer.
  $effect(() => {
    const r = live.convRequest;
    if (!r) return;
    channel = r.channel;
    tab = 'chat';
    focusKey += 1;
    live.convRequest = null;
  });
  // Looking at a conversation reads it, including a line that arrives while it's open.
  $effect(() => {
    if (dm && dm.unread > 0 && tab === 'chat') void live.readDm(dm.channel);
  });
  $effect(() => {
    if (group && group.unread > 0 && tab === 'chat') void live.readGroup(group.channel);
  });
  // A DM or group tab whose conversation left the list (closed elsewhere, the name released, you left): back to the lobby.
  $effect(() => {
    if ((dmParticipants(channel) && !dm) || (groupOf(channel) && !group)) channel = 'lobby';
  });
</script>

<div class="lobby">
  <div class="tabs" role="tablist" aria-label="Lobby">
    <button role="tab" type="button" aria-selected={tab === 'chat'} bind:this={chatTabBtn} onclick={() => (tab = 'chat')}>Chat</button>
    <button role="tab" type="button" aria-selected={tab === 'who'} onclick={() => (tab = 'who')}>Here now</button>
  </div>

  <div class="center" class:hide={tab !== 'chat'}>
    <ChatPanel
      {channel}
      {title}
      {focusKey}
      placeholder={group || dm ? `Message ${title}` : `Say something in #${channel}`}
      readOnly={!!dm?.with.released}
      readOnlyNote={dm ? 'This name was given back; nobody will read this.' : undefined}
    >
      {#snippet header()}
        <div>
          <div class="head">
            <nav class="channels" aria-label="Channels">
              {#each channels as c}
                <button type="button" aria-current={channel === c.id ? 'true' : undefined} onclick={() => (channel = c.id)}>
                  <span class="hash" aria-hidden="true">#</span>{c.id}
                </button>
              {/each}
              <!-- On a phone showing Here now, the new-message balloon points at the Chat tab instead. -->
              <ConvTabs
                active={dm || group ? channel : null}
                onpick={(c) => (channel = c ?? 'lobby')}
                seen={chatSeen}
                bubbleAt={chatSeen ? undefined : chatTabBtn}
                onbubble={(c) => {
                  channel = c;
                  tab = 'chat';
                }}
              />
            </nav>
            <ConvMenu {channel} />
            <p class="about">{about}</p>
          </div>
          <div class="score"><Scoreboard /></div>
        </div>
      {/snippet}
    </ChatPanel>
  </div>

  <aside class="right">
    <QuickMatch />
    <TablesList />
    <div class="whowrap" class:hide={tab !== 'who'}><WhoList /></div>
  </aside>
</div>

<style>
  .lobby {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 21rem;
    grid-template-areas: 'center right';
    gap: 1.25rem;
    height: calc(100dvh - var(--nav-h) - 1.5rem);
    min-height: 34rem;
  }
  .center {
    grid-area: center;
    min-height: 0;
  }
  .right {
    grid-area: right;
    display: flex;
    flex-direction: column;
    gap: 1.25rem;
    min-height: 0;
    padding-bottom: var(--lattice-room);
  }
  .whowrap {
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
  .head {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0 1.25rem 0 0.75rem;
    border-bottom: 1px solid var(--lattice);
  }
  .channels {
    display: flex;
    gap: 0.25rem;
    flex-wrap: nowrap;
    min-width: 0;
    overflow-x: auto;
  }
  .channels button {
    padding: 1rem 0.75rem 0.85rem;
    background: none;
    border: 0;
    border-bottom: 2px solid transparent;
    color: var(--fog);
    font-size: var(--step-1);
    font-weight: 500;
    white-space: nowrap;
  }
  .channels button:hover {
    color: var(--chalk);
  }
  .channels button[aria-current='true'] {
    color: var(--chalk);
    border-bottom-color: var(--carbon);
  }
  .channels button[aria-current='true'] .hash {
    color: var(--carbon);
  }
  .hash {
    color: var(--dust);
    margin-right: 0.15rem;
  }
  .about {
    margin: 0 0 0 auto;
    color: var(--fog);
    font-size: var(--step--1);
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .tabs {
    display: none;
  }
  @media (max-width: 520px) {
    .about {
      display: none;
    }
  }
  @media (max-width: 960px) {
    /* One column: Play (and forming tables), the tabs, then the chat or Here now. */
    .lobby {
      display: flex;
      flex-direction: column;
      height: auto;
    }
    .right {
      display: contents;
    }
    .tabs {
      order: 1;
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
    .center,
    .whowrap {
      order: 2;
    }
    .center {
      height: 75dvh;
    }
    .hide {
      display: none;
    }
  }
  /* Phones: the lobby is exactly one screen tall, so the chat log (or Here now) is the only thing that
     scrolls. A log inside a scrolling page trapped the thumb: a swipe on the log never reached the page.
     Held sideways (short and wide) there is no room for that; the page scrolls as before. */
  @media (max-width: 960px) and (min-height: 521px) {
    :global(body .shell:has(.lobby)) {
      height: 100dvh;
      min-height: 0;
    }
    :global(body .shell:has(.lobby) > main) {
      display: flex;
      flex-direction: column;
      padding-bottom: 0.75rem;
    }
    .lobby {
      flex: 1;
      min-height: 0;
    }
    .center,
    .whowrap {
      flex: 1;
      height: auto;
      min-height: 12rem;
    }
  }
  /* The keyboard is up (the page shrinks above it): only the conversation, so it keeps its room. */
  @media (max-width: 960px) and (max-height: 520px) {
    :global(body .shell:has(.lobby textarea:focus)) {
      height: 100dvh;
      min-height: 0;
    }
    :global(body .shell:has(.lobby textarea:focus) > .nav) {
      display: none;
    }
    :global(body .shell:has(.lobby textarea:focus) > main) {
      display: flex;
      flex-direction: column;
      padding-bottom: 0.5rem;
    }
    .lobby:has(:global(textarea:focus)) {
      flex: 1;
      min-height: 0;
    }
    .lobby:has(:global(textarea:focus)) :is(.right, .tabs, .score) {
      display: none;
    }
    .lobby:has(:global(textarea:focus)) .center {
      flex: 1;
      height: auto;
      min-height: 0;
    }
  }
</style>
