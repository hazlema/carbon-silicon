import { stat } from 'node:fs/promises';

/** Where a served text comes from: fixed (tests), or a file re-read as it changes. */
export type TextSource = string | { get(): Promise<string> };

export const textOf = (source: TextSource): Promise<string> =>
  typeof source === 'string' ? Promise.resolve(source) : source.get();

/**
 * A text file the server re-reads while running, so docs and rules can be edited without a restart.
 * Checked at most every `minCheckMs`; while the file is missing or unreadable the last good text stays.
 */
export class LiveText {
  private current: string;
  private checkedAt = -Infinity;
  private seenMtime: number | null = null;
  private readonly minCheckMs: number;
  private readonly now: () => number;

  constructor(private readonly opts: { path: string; fallback: string; minCheckMs?: number; now?: () => number }) {
    this.current = opts.fallback;
    this.minCheckMs = opts.minCheckMs ?? 2000;
    this.now = opts.now ?? Date.now;
  }

  async get(): Promise<string> {
    const now = this.now();
    if (now - this.checkedAt < this.minCheckMs) return this.current;
    this.checkedAt = now;
    const info = await stat(this.opts.path).catch(() => null);
    if (!info || info.mtimeMs === this.seenMtime) return this.current;
    try {
      this.current = await Bun.file(this.opts.path).text();
      this.seenMtime = info.mtimeMs;
    } catch {
      // unreadable for a moment; try again on the next check
    }
    return this.current;
  }
}
