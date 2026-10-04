import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DIARY_CHANNEL, type DiaryEntry, type DiaryEntrySummary } from '@cs/shared/protocol';
import type { CommunicationManager } from './communication';

export function parseEntry(file: string, raw: string): DiaryEntry {
  const slug = file.replace(/\.md$/, '');
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  const front = m ? m[1] : '';
  const body = (m ? m[2] : raw).trim();
  const field = (key: string) =>
    new RegExp(`^${key}:\\s*(.+)$`, 'm')
      .exec(front)?.[1]
      ?.trim()
      .replace(/^["']|["']$/g, '');
  return { slug, title: field('title') ?? slug, date: field('date') ?? slug.slice(0, 10), excerpt: excerpt(body), words: words(body), markdown: body };
}

/** Markdown as the plain words a reader sees: links keep their text, marks and code ticks go. */
const plain = (markdown: string) =>
  markdown
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

const EXCERPT_MAX = 240;

/** An entry's opening paragraph in plain words, cut at a word when it runs long: what the diary's index shows under a title. */
export function excerpt(markdown: string): string {
  const first = markdown.split(/\r?\n\s*\r?\n/).find((block) => block.trim() && !/^\s*(#|>|```|[-*] |\d+\. |\||!\[)/.test(block));
  const text = plain(first ?? '');
  if (text.length <= EXCERPT_MAX) return text;
  const cut = text.slice(0, EXCERPT_MAX);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), 1)).replace(/[\s,;:.]+$/, '')}…`;
}

const words = (markdown: string) => plain(markdown).split(' ').filter(Boolean).length;

export class DiaryService {
  entries: DiaryEntry[] = [];

  constructor(private dir: string) {}

  async load(): Promise<void> {
    if (!existsSync(this.dir)) {
      this.entries = [];
      return;
    }
    const list: DiaryEntry[] = [];
    for await (const file of new Bun.Glob('*.md').scan({ cwd: this.dir })) {
      list.push(parseEntry(file, await Bun.file(join(this.dir, file)).text()));
    }
    list.sort((a, b) => (a.date === b.date ? b.slug.localeCompare(a.slug) : b.date.localeCompare(a.date)));
    this.entries = list;
  }

  get(slug: string): DiaryEntry | null {
    return this.entries.find((e) => e.slug === slug) ?? null;
  }

  summaries(): DiaryEntrySummary[] {
    return this.entries.map(({ slug, title, date, excerpt, words }) => ({ slug, title, date, excerpt, words }));
  }

  /** Post entries that #diary hasn't seen yet, oldest first: #diary keeps the record, and #lobby gets a line where people are. */
  async announce(comms: CommunicationManager): Promise<number> {
    const seen = await comms.history(DIARY_CHANNEL, { limit: 200 });
    let posted = 0;
    for (const entry of [...this.entries].reverse()) {
      const link = `/diary/${entry.slug}`;
      if (seen.some((m) => m.text.endsWith(link))) continue;
      await comms.postSystem(DIARY_CHANNEL, `New diary entry — "${entry.title}" ${link}`);
      await comms.postSystem('lobby', `New diary entry: "${entry.title}" ${link}`);
      posted += 1;
    }
    return posted;
  }
}
