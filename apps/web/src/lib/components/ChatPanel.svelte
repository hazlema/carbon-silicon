<script lang="ts">
  import { tick } from 'svelte';
  import type { ChatMessage } from '@cs/shared/protocol';
  import { api } from '$lib/api';
  import { splitMessage } from '$lib/chat';
  import { live } from '$lib/live.svelte';
  import IdentityChip from './IdentityChip.svelte';

  let {
    channel,
    title,
    readOnly = false,
    readOnlyNote = 'Only the Proprietor posts here.',
    placeholder = 'Say something',
  }: { channel: string; title: string; readOnly?: boolean; readOnlyNote?: string; placeholder?: string } = $props();

  let messages = $state<ChatMessage[]>([]);
  let draft = $state('');
  let error = $state('');
  let sending = $state(false);
  let log: HTMLDivElement | undefined = $state();
  let pinned = true;
  const inputId = $derived(`say-${channel.replace(/[^a-z0-9-]/gi, '-')}`);

  function merge(list: ChatMessage[]) {
    const byId = new Map(messages.map((m) => [m.id, m]));
    for (const m of list) byId.set(m.id, m);
    messages = [...byId.values()].sort((a, b) => a.id - b.id).slice(-300);
  }

  $effect(() => {
    const ch = channel;
    let alive = true;
    messages = [];
    error = '';
    const off = live.onChat(ch, (m) => merge([m]));
    api<{ messages: ChatMessage[] }>('GET', `/api/chat/${encodeURIComponent(ch)}?limit=100`)
      .then((r) => alive && merge(r.messages))
      .catch((e) => alive && (error = (e as Error).message));
    return () => {
      alive = false;
      off();
    };
  });

  $effect(() => {
    void messages.length;
    if (!pinned || !log) return;
    void tick().then(() => log && (log.scrollTop = log.scrollHeight));
  });

  function onScroll() {
    if (log) pinned = log.scrollHeight - log.scrollTop - log.clientHeight < 48;
  }

  async function send(e: SubmitEvent) {
    e.preventDefault();
    const text = draft.trim();
    if (!text) return;
    sending = true;
    error = '';
    try {
      await api('POST', `/api/chat/${encodeURIComponent(channel)}`, { text });
      draft = '';
      pinned = true;
    } catch (err) {
      error = (err as Error).message;
    } finally {
      sending = false;
    }
  }

  const mentionsMe = (m: ChatMessage) =>
    !!live.me && m.text.toLowerCase().includes(`@${live.me.handle.toLowerCase()}`);
  const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
</script>

<section class="chat panel" aria-label={title}>
  <header><h2>{title}</h2></header>
  <div class="log" bind:this={log} onscroll={onScroll} role="log" aria-live="polite" aria-relevant="additions">
    {#each messages as m (m.id)}
      {#if m.system}
        <p class="sys">
          {#each splitMessage(m.text) as p}{#if p.kind === 'link'}<a href={p.value}>{p.value}</a>{:else}{p.value}{/if}{/each}
        </p>
      {:else}
        <article
          class="msg"
          class:mine={m.author?.id === live.me?.id}
          class:mention={mentionsMe(m)}
          class:machine={m.author?.kind === 'agent'}
        >
          <div class="meta">
            {#if m.author}<IdentityChip identity={m.author} />{/if}
            <time datetime={m.createdAt}>{time(m.createdAt)}</time>
          </div>
          <p class="text">
            {#each splitMessage(m.text) as p}{#if p.kind === 'mention'}<strong>{p.value}</strong>{:else if p.kind === 'link'}<a
                  href={p.value}>{p.value}</a
                >{:else}{p.value}{/if}{/each}
          </p>
        </article>
      {/if}
    {:else}
      <p class="empty">{readOnly ? 'Nothing posted yet.' : 'Quiet in here. Say hello.'}</p>
    {/each}
  </div>
  {#if readOnly}
    <p class="note">{readOnlyNote}</p>
  {:else if live.me}
    <form onsubmit={send}>
      <label class="visually-hidden" for={inputId}>Message {title}</label>
      <input id={inputId} bind:value={draft} maxlength="500" {placeholder} autocomplete="off" />
      <button class="btn" type="submit" disabled={sending || !draft.trim()}>Send</button>
    </form>
  {/if}
  {#if error}<p class="error pad" role="alert">{error}</p>{/if}
</section>

<style>
  .chat {
    display: grid;
    grid-template-rows: auto minmax(0, 1fr) auto auto;
    min-height: 0;
    height: 100%;
  }
  header {
    padding: 0.8rem 1rem 0.4rem;
  }
  h2 {
    margin: 0;
    font-size: var(--step-0);
    font-weight: 600;
    color: var(--fog);
  }
  .log {
    overflow-y: auto;
    padding: 0.25rem 1rem 0.75rem;
    display: flex;
    flex-direction: column;
    gap: 0.7rem;
    overscroll-behavior: contain;
  }
  .msg {
    max-width: 72ch;
    padding-left: 0.75rem;
    border-left: 2px solid transparent;
  }
  .msg.mention {
    border-left-color: var(--chalk);
  }
  .meta {
    display: flex;
    align-items: baseline;
    gap: 0.6rem;
    font-size: var(--step--1);
  }
  time {
    color: var(--dust);
    font-size: 0.85em;
  }
  .text {
    margin: 0.1rem 0 0;
    font-family: var(--font-carbon);
    font-size: 1.02rem;
    line-height: 1.45;
    overflow-wrap: anywhere;
  }
  .machine .text {
    font-family: var(--font-silicon);
    font-size: 0.9rem;
  }
  .text strong {
    font-weight: 700;
  }
  .sys {
    margin: 0.2rem 0;
    color: var(--fog);
    font-size: var(--step--1);
    text-align: center;
  }
  .empty,
  .note {
    color: var(--dust);
    margin: 1rem;
  }
  form {
    display: flex;
    gap: 0.5rem;
    padding: 0.75rem;
    border-top: 1px solid var(--lattice);
  }
  input {
    flex: 1;
    min-width: 0;
  }
  .pad {
    margin: 0 1rem 0.75rem;
  }
</style>
