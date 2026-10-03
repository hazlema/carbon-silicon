import type { ChatMessage } from '@cs/shared/protocol';

/** How long a taunt stays over the game, from its own arrival (and the longest a queued one may wait). */
export const TOAST_MS = 6000;

/** On arriving at a table, lines from the last 10 s still toast: an opening line can land just before the page listens. */
export const CATCH_UP_MS = 10_000;

/** The lines of a channel's history worth toasting now: from people (never system lines, such as the table's intro), at most `max` of the last CATCH_UP_MS, oldest first. */
export function recentLines(history: ChatMessage[], now: number, max: number): ChatMessage[] {
  return history
    .filter((m) => m.author !== null && !m.system && now - Date.parse(m.createdAt) <= CATCH_UP_MS)
    .sort((a, b) => a.id - b.id)
    .slice(-max);
}

export interface ToastLine {
  id: number;
  /** Where the line was said, so a tap opens the chat on that conversation. */
  channel: string;
  text: string;
  /** null for a system line ("@ann dozed off …"). */
  author: { handle: string; kind: 'human' | 'agent' } | null;
}

interface Entry {
  line: ToastLine;
  /** When the line arrived (waiting lines expire after TOAST_MS) and, once visible, when it took its place. */
  at: number;
  timer?: unknown;
}

/**
 * Pocket tables (M5a): while the chat sheet is closed, every line from someone else shows as a toast — up to `max`
 * stacked, oldest first, each for TOAST_MS from its arrival — and counts towards the chat button's badge.
 * With `max: 1` and `minShowMs` (Lightline's one-line footer) a newer line waits until the one on screen has had
 * `minShowMs`, instead of cutting it short; waiting lines older than TOAST_MS are dropped.
 */
export class ToastQueue {
  /** On screen now, oldest first. */
  visible: ToastLine[] = [];
  unread = 0;
  open = false;
  onChange: (() => void) | null = null;
  /** Read-only here: change them with setLimits (the page switches them when the game changes). */
  max: number;
  minShowMs: number;
  #shown: Entry[] = [];
  #waiting: Entry[] = [];
  #seen = new Set<number>();
  #pumpTimer: unknown = null;
  readonly #set: (fn: () => void, ms: number) => unknown;
  readonly #clear: (h: unknown) => void;
  readonly #now: () => number;

  constructor(private readonly opts: { meId: () => string | null; /** Authors you ignore or block: their lines never toast or count. */ hidden?: () => Set<string>; max?: number; minShowMs?: number; now?: () => number; setTimeout?: (fn: () => void, ms: number) => unknown; clearTimeout?: (h: unknown) => void }) {
    this.max = opts.max ?? 3;
    this.minShowMs = opts.minShowMs ?? 0;
    this.#set = opts.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
    this.#clear = opts.clearTimeout ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    this.#now = opts.now ?? (() => Date.now());
  }

  /**
   * `count: false` toasts a line without adding to `unread` (DMs and groups have their own unread counts).
   * A line whose id was already shown or counted is ignored, so a history catch-up and the live feed can overlap.
   */
  push(m: ChatMessage, o: { count?: boolean } = {}): void {
    if (this.open || m.removed) return;
    if (m.author && m.author.id === this.opts.meId()) return;
    if (m.author && this.opts.hidden?.().has(m.author.id)) return;
    if (this.#seen.has(m.id)) return;
    this.#seen.add(m.id);
    if (o.count !== false) this.unread += 1;
    this.#waiting.push({ line: { id: m.id, channel: m.channel, text: m.text, author: m.author ? { handle: m.author.handle, kind: m.author.kind } : null }, at: this.#now() });
    this.#pump();
    this.onChange?.();
  }

  /** One toast by id, or (no id) all of them and the ones waiting. */
  dismiss(id?: number): void {
    if (id === undefined) {
      this.#clearAll();
    } else {
      this.#waiting = this.#waiting.filter((e) => e.line.id !== id);
      const e = this.#shown.find((x) => x.line.id === id);
      if (e) this.#remove(e);
      this.#pump();
    }
    this.onChange?.();
  }

  setOpen(open: boolean): void {
    this.open = open;
    if (open) {
      this.#clearAll();
      this.unread = 0;
    }
    this.onChange?.();
  }

  reset(): void {
    this.#clearAll();
    this.#seen.clear();
    this.unread = 0;
    this.onChange?.();
  }

  /** Change the stack size (and the minimum on-screen time) on the fly; a smaller stack keeps only the newest. */
  setLimits(max: number, minShowMs: number): void {
    if (max === this.max && minShowMs === this.minShowMs) return;
    this.max = max;
    this.minShowMs = minShowMs;
    while (this.#shown.length > max) this.#remove(this.#shown[0]!);
    this.#pump();
    this.onChange?.();
  }

  #clearAll() {
    for (const e of this.#shown) this.#clear(e.timer);
    this.#shown = [];
    this.#waiting = [];
    this.#clear(this.#pumpTimer);
    this.#pumpTimer = null;
    this.visible = [];
  }

  #remove(e: Entry) {
    this.#clear(e.timer);
    this.#shown = this.#shown.filter((x) => x !== e);
    this.visible = this.#shown.map((x) => x.line);
  }

  /** Move waiting lines onto the screen: into a free place, or in place of the oldest once it has had its minimum. */
  #pump(): void {
    this.#clear(this.#pumpTimer);
    this.#pumpTimer = null;
    const now = this.#now();
    this.#waiting = this.#waiting.filter((e) => now - e.at < TOAST_MS);
    while (this.#waiting.length) {
      if (this.#shown.length >= this.max) {
        const oldest = this.#shown[0]!;
        const left = oldest.at + this.minShowMs - now;
        if (left > 0) {
          this.#pumpTimer = this.#set(() => {
            this.#pumpTimer = null;
            this.#pump();
            this.onChange?.();
          }, left);
          break;
        }
        this.#remove(oldest);
      }
      const e = this.#waiting.shift()!;
      e.at = now;
      e.timer = this.#set(() => {
        this.#remove(e);
        this.#pump();
        this.onChange?.();
      }, TOAST_MS);
      this.#shown.push(e);
      this.visible = this.#shown.map((x) => x.line);
    }
  }
}
