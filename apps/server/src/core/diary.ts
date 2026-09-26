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
  return { slug, title: field('title') ?? slug, date: field('date') ?? slug.slice(0, 10), markdown: body };
}

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
    return this.entries.map(({ slug, title, date }) => ({ slug, title, date }));
  }

  /** Post entries that #diary hasn't seen yet, oldest first. */
  async announce(comms: CommunicationManager): Promise<number> {
    const seen = await comms.history(DIARY_CHANNEL, { limit: 200 });
    let posted = 0;
    for (const entry of [...this.entries].reverse()) {
      const link = `/diary/${entry.slug}`;
      if (seen.some((m) => m.text.endsWith(link))) continue;
      await comms.postSystem(DIARY_CHANNEL, `New diary entry — "${entry.title}" ${link}`);
      posted += 1;
    }
    return posted;
  }
}
