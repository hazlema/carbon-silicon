<script lang="ts">
  import { tick, untrack, type Snippet } from 'svelte';
  import { dmParticipants, type ChatMessage } from '@cs/shared/protocol';
  import { api } from '$lib/api';
  import { splitMessage } from '$lib/chat';
  import { parseMsgCommand } from '$lib/dms';
  import { untilText } from '$lib/format';
  import { applyRemoval, chatItems, hiddenLabel } from '$lib/hidden';
  import { live } from '$lib/live.svelte';
  import { runInviteCommand } from '$lib/table-actions';
  import { parseInviteCommand } from '$lib/tables';
  import Avatar from './Avatar.svelte';
  import IdentityChip from './IdentityChip.svelte';
  import MessageMenu from './MessageMenu.svelte';
  import PersonMenu from './PersonMenu.svelte';

  let {
    channel,
    title,
    about = '',
    header,
    readOnly = false,
    readOnlyNote = 'Only the Proprietor posts here.',
    placeholder = 'Say something',
    focusKey = 0,
  }: {
    channel: string;
    title: string;
    about?: string;
    /** Replaces the default title header, e.g. with channel tabs. */
    header?: Snippet;
    readOnly?: boolean;
    readOnlyNote?: string;
    placeholder?: string;
    /** Bumping it focuses the composer (a conversation someone asked to open). */
    focusKey?: number;
  } = $props();

  let messages = $state<ChatMessage[]>([]);
  let draft = $state('');
  let error = $state('');
  let notice = $state('');
  let sending = $state(false);
  let log: HTMLDivElement | undefined = $state();
  let pinned = true;
  const inputId = $derived(`say-${channel.replace(/[^a-z0-9-]/gi, '-')}`);
  let revealed = $state(new Set<number>());
  const items = $derived(chatItems(messages, live.hiddenAuthors, revealed));
  const canMenu = (m: ChatMessage) => !!live.me && !!m.author && m.author.id !== live.me.id && !m.removed;

  function merge(list: ChatMessage[]) {
    const byId = new Map(messages.map((m) => [m.id, m]));
    for (const m of list) byId.set(m.id, m);
    messages = [...byId.values()].sort((a, b) => a.id - b.id).slice(-300);
  }

  // A line another component left for this conversation's notice area.
  $effect(() => {
    const n = live.convNotice;
    if (n && n.channel === channel) {
      notice = n.text;
      live.convNotice = null;
    }
  });

  $effect(() => {
    const ch = channel;
    let alive = true;
    messages = [];
    revealed = new Set();
    error = '';
    notice = '';
    const off = live.onChat(ch, (m) => merge([m]));
    const isStaff = !!live.me && (live.me.role === 'mod' || live.me.role === 'admin');
    const offRemoved = live.onChatRemoved(ch, (r) => (messages = applyRemoval(messages, r.id, r.by, isStaff)));
    api<{ messages: ChatMessage[] }>('GET', `/api/chat/${encodeURIComponent(ch)}?limit=200`)
      .then((r) => alive && merge(r.messages))
      .catch((e) => alive && (error = (e as Error).message));
    return () => {
      alive = false;
      off();
      offRemoved();
    };
  });

  $effect(() => {
    const ch = channel;
    const generation = live.reconnects;
    if (generation === 0) return;
    const since = untrack(() => messages.at(-1)?.id ?? 0);
    let alive = true;
    api<{ messages: ChatMessage[] }>('GET', `/api/chat/${encodeURIComponent(ch)}?since=${since}&limit=200`)
      .then((r) => alive && merge(r.messages))
      .catch((e) => alive && (error = (e as Error).message));
    return () => {
      alive = false;
    };
  });

  $effect(() => {
    void messages.length;
    if (!pinned || !log) return;
    void tick().then(() => log && (log.scrollTop = log.scrollHeight));
  });

  $effect(() => {
    if (focusKey === 0) return;
    untrack(() => void tick().then(() => document.getElementById(inputId)?.focus()));
  });

  function onScroll() {
    if (log) pinned = log.scrollHeight - log.scrollTop - log.clientHeight < 48;
  }

  const flat = (text: string) => text.replace(/\s*[\r\n]+\s*/g, ' ');
  let lastSubmitAt = 0;
  /** One press sends once, whichever of keydown (desktop) or beforeinput (Android soft keyboards) sees it. */
  function submitOnce(form: HTMLFormElement | null) {
    const now = Date.now();
    if (now - lastSubmitAt < 300) return;
    lastSubmitAt = now;
    form?.requestSubmit();
  }
  /** Enter sends; Shift+Enter inserts nothing (the box stays one line). */
  function onComposerKey(e: KeyboardEvent) {
    // Gboard reports the Enter that commits a composing word as key "Unidentified" / keyCode 229: beforeinput handles it.
    if (e.key !== 'Enter' || e.isComposing || e.keyCode === 229) return;
    e.preventDefault();
    if (!e.shiftKey) submitOnce((e.currentTarget as HTMLTextAreaElement).form);
  }
  /** A line break typed on a soft keyboard (no usable keydown) sends instead of inserting. */
  function onComposerBeforeInput(e: InputEvent) {
    if (e.inputType !== 'insertLineBreak' && e.inputType !== 'insertParagraph') return;
    e.preventDefault();
    submitOnce((e.currentTarget as HTMLTextAreaElement).form);
  }
  /** A paste with line breaks becomes one line, the caret staying where it was. */
  function flattenPaste(e: Event) {
    const t = e.currentTarget as HTMLTextAreaElement;
    if (!/[\r\n]/.test(t.value)) return;
    const caret = flat(t.value.slice(0, t.selectionStart)).length;
    t.value = flat(t.value);
    t.setSelectionRange(caret, caret);
    draft = t.value;
  }

  async function send(e: SubmitEvent) {
    e.preventDefault();
    const text = draft.trim();
    if (!text) return;
    const dm = parseMsgCommand(text);
    if (dm) {
      error = '';
      notice = '';
      if (!dm.handle || !dm.text) {
        error = 'Try /msg @name hello.';
        return;
      }
      if (sending) return;
      sending = true;
      try {
        await live.sendDm(dm.handle, dm.text);
        if (draft.trim() === text) draft = '';
      } catch (err) {
        error = (err as Error).message;
      } finally {
        sending = false;
      }
      return;
    }
    const words = parseInviteCommand(text);
    if (words) {
      error = '';
      notice = '';
      try {
        notice = await runInviteCommand(words, channel);
        if (draft.trim() === text) draft = '';
      } catch (err) {
        error = (err as Error).message;
      }
      return;
    }
    sending = true;
    error = '';
    try {
      await api('POST', `/api/chat/${encodeURIComponent(channel)}`, { text });
      if (draft.trim() === text) draft = '';
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
  {#if header}
    {@render header()}
  {:else}
    <header class="head">
      <h2>{title}</h2>
      {#if about}<p class="about">{about}</p>{/if}
    </header>
  {/if}
  <div class="log" bind:this={log} onscroll={onScroll} role="log" aria-live="polite" aria-relevant="additions">
    {#each items as item (item.kind === 'message' ? item.message.id : `hidden-${item.key}`)}
      {#if item.kind === 'hidden'}
        <p class="hidden-run">
          <button type="button" class="link" onclick={() => (revealed = new Set([...revealed, ...item.ids]))}
            >{hiddenLabel(item.ids.length)} · show</button
          >
        </p>
      {:else}
        {@const m = item.message}
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
            {#if m.author}<Avatar kind={m.author.kind} />{:else}<span></span>{/if}
            <div class="body">
              <div class="meta">
                {#if m.author}{#if canMenu(m)}<PersonMenu identity={m.author} />{:else}<IdentityChip identity={m.author} badge={false} />{/if}{/if}
                <span class="right">
                  <time datetime={m.createdAt}>{time(m.createdAt)}</time>
                  {#if canMenu(m)}<MessageMenu message={m} />{/if}
                </span>
              </div>
              {#if m.removed}
                <p class="removed">message removed by @{m.removed.by}</p>
                {#if m.text}<p class="removed-text">{m.text}</p>{/if}
              {:else}
                <p class="text">
                  {#each splitMessage(m.text) as p}{#if p.kind === 'mention'}{@const who = live.presence.find((x) => `@${x.identity.handle}`.toLowerCase() === p.value.toLowerCase())?.identity}{#if who && who.id !== live.me?.id}<PersonMenu
                          identity={who}
                          inline
                        />{:else}<span class="at">{p.value}</span>{/if}{:else if p.kind === 'link'}<a href={p.value}>{p.value}</a
                      >{:else}{p.value}{/if}{/each}
                </p>
              {/if}
            </div>
          </article>
        {/if}
      {/if}
    {:else}
      <p class="empty">{readOnly ? 'Nothing posted yet.' : dmParticipants(channel) ? 'No messages yet. Say hello.' : 'Quiet in here. Say hello.'}</p>
    {/each}
  </div>
  {#if readOnly}
    <p class="note">{readOnlyNote}</p>
  {:else if live.me && live.sanction}
    <p class="note">
      {live.sanction.kind === 'mute'
        ? `You're muted ${untilText(live.sanction.endsAt)}, so chat is off. You can still play.`
        : `Your account is suspended ${untilText(live.sanction.endsAt)}. You can read, but not chat.`}
    </p>
  {:else if live.me}
    <form onsubmit={send}>
      <label class="visually-hidden" for={inputId}>Message {title}</label>
      <!-- A one-line textarea, not an <input>: a lone text input in a form makes Chrome Android offer its password/autofill row. -->
      <textarea id={inputId} rows="1" bind:value={draft} maxlength="500" {placeholder} autocomplete="off" {...{ autocorrect: "on" }} spellcheck="true" enterkeyhint="send" onkeydown={onComposerKey} onbeforeinput={onComposerBeforeInput} oninput={flattenPaste}></textarea>
      <button class="btn light" type="submit" disabled={sending || !draft.trim()}>Send</button>
    </form>
  {/if}
  {#if notice}<p class="note pad" role="status">{notice}</p>{/if}
  {#if error}<p class="error pad" role="alert">{error}</p>{/if}
</section>

<style>
  .chat {
    display: grid;
    /* A header with many tabs must scroll inside the panel, never widen it. */
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: auto minmax(0, 1fr) auto auto;
    min-height: 0;
    height: 100%;
  }
  .head {
    padding: 1rem 1.25rem 0.9rem;
    border-bottom: 1px solid var(--lattice);
  }
  h2 {
    margin: 0;
    font-size: var(--step--1);
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--fog);
  }
  .about {
    margin: 0.15rem 0 0;
    color: var(--fog);
    font-size: var(--step--1);
  }
  .log {
    /* The containing block for absolutely positioned bits inside messages (screen-reader labels,
       menus), so they scroll and clip with the log instead of stretching the page. */
    position: relative;
    overflow-y: auto;
    padding: 1rem 1.25rem;
    display: flex;
    flex-direction: column;
    gap: 1.1rem;
    overscroll-behavior: contain;
  }
  /* A short conversation sits at the bottom, next to the input, like a chat should. */
  .log > :first-child {
    margin-top: auto;
  }
  .msg {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    gap: 0.8rem;
    margin-left: -0.6rem;
    padding-left: 0.6rem;
    border-left: 2px solid transparent;
  }
  .msg.mention {
    border-left-color: var(--chalk);
  }
  .meta {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 0.6rem;
    min-width: 0;
  }
  time {
    flex: none;
    color: var(--dust);
    font-family: var(--font-silicon);
    font-size: var(--step--1);
    font-variant-numeric: tabular-nums;
  }
  .text {
    margin: 0.15rem 0 0;
    max-width: 72ch;
    font-family: var(--font-carbon);
    font-size: 1.08rem;
    line-height: 1.45;
    overflow-wrap: anywhere;
  }
  .machine .text {
    font-family: var(--font-silicon);
    font-size: 0.9rem;
    line-height: 1.6;
  }
  .at {
    color: var(--dust);
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
    gap: 0.6rem;
    padding: 0.9rem 1.25rem;
    border-top: 1px solid var(--lattice);
    /* When a phone keyboard opens, the browser scrolls the composer into view with room to spare
       (Gboard's toolbar row isn't counted as keyboard by the visual viewport). */
    scroll-margin-bottom: 4rem;
  }
  textarea {
    scroll-margin-bottom: 4rem;
  }
  textarea {
    flex: 1;
    min-width: 0;
    resize: none;
    overflow: hidden; /* one line, no scrollbar */
  }
  textarea::placeholder {
    color: var(--dust);
  }
  .pad {
    margin: 0 1.25rem 0.75rem;
  }
  .right {
    display: inline-flex;
    align-items: baseline;
    gap: 0.3rem;
    flex: none;
  }
  .removed {
    margin: 0.15rem 0 0;
    color: var(--dust);
    font-style: italic;
    font-size: var(--step--1);
  }
  /* Only a mod or admin viewer ever gets text back on a removed message (S145-146); shown dimmed,
     under the "removed by" line, so it reads as evidence rather than as a normal message. */
  .removed-text {
    margin: 0.15rem 0 0;
    color: var(--fog);
    font-size: var(--step--1);
    opacity: 0.75;
  }
  .hidden-run {
    margin: 0;
    font-size: var(--step--1);
  }
  .link {
    background: none;
    border: 0;
    padding: 0;
    color: var(--dust);
    text-decoration: underline;
    text-decoration-color: var(--lattice);
    text-underline-offset: 0.2em;
  }
  .link:hover {
    color: var(--fog);
  }
</style>
