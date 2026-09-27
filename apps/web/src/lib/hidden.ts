import type { ChatMessage } from '@cs/shared/protocol';

export type ChatItem = { kind: 'message'; message: ChatMessage } | { kind: 'hidden'; key: number; ids: number[] };

/** Messages from people you ignore or block collapse into runs of "N hidden messages". Revealed
 *  messages and system lines always show. */
export function chatItems(messages: ChatMessage[], hiddenAuthors: Set<string>, revealed: Set<number>): ChatItem[] {
  const items: ChatItem[] = [];
  for (const message of messages) {
    const hide = !message.system && !!message.author && hiddenAuthors.has(message.author.id) && !revealed.has(message.id);
    if (!hide) {
      items.push({ kind: 'message', message });
      continue;
    }
    const last = items.at(-1);
    if (last?.kind === 'hidden') last.ids.push(message.id);
    else items.push({ kind: 'hidden', key: message.id, ids: [message.id] });
  }
  return items;
}

export const hiddenLabel = (n: number) => `${n} hidden ${n === 1 ? 'message' : 'messages'}`;

/**
 * Apply a live removal pushed by the server. `keepText` is true for a mod or admin viewer: the
 * text is already sitting in `messages` from before the removal, so it stays, dimmed by `removed`
 * (S145-146). Everyone else's copy is blanked, matching what a fresh history read would give them.
 */
export function applyRemoval(messages: ChatMessage[], id: number, by: string, keepText = false): ChatMessage[] {
  return messages.map((m) => (m.id === id ? { ...m, text: keepText ? m.text : '', removed: { by } } : m));
}
