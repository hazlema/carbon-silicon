export type Part = { kind: 'text' | 'mention' | 'link'; value: string };

const TOKEN = /(@[A-Za-z0-9_-]{3,20})|(\/diary\/[a-z0-9-]+)/g;

/** Split a chat message into plain text, @mentions and internal diary links. */
export function splitMessage(text: string): Part[] {
  const parts: Part[] = [];
  let last = 0;
  for (const m of text.matchAll(TOKEN)) {
    const at = m.index ?? 0;
    if (at > last) parts.push({ kind: 'text', value: text.slice(last, at) });
    parts.push({ kind: m[1] ? 'mention' : 'link', value: m[0] });
    last = at + m[0].length;
  }
  if (last < text.length) parts.push({ kind: 'text', value: text.slice(last) });
  return parts;
}
