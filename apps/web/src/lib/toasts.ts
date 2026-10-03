import type { ChatMessage } from '@cs/shared/protocol';

/** How long a taunt stays over the game. */
export const TOAST_MS = 5000;

export interface ToastLine {
  id: number;
  text: string;
  /** null for a system line ("@ann dozed off …"). */
  author: { handle: string; kind: 'human' | 'agent' } | null;
}

/**
 * Pocket tables (M5a): while the chat sheet is closed, every line from someone else shows as a toast —
 * one at a time, the newest replacing the last — and counts towards the chat button's badge.
 */
export class ToastQueue {
  current: ToastLine | null = null;
  unread = 0;
  open = false;
  onChange: (() => void) | null = null;
  #timer: unknown = null;
  readonly #set: (fn: () => void, ms: number) => unknown;
  readonly #clear: (h: unknown) => void;

  constructor(private readonly opts: { meId: () => string | null; setTimeout?: (fn: () => void, ms: number) => unknown; clearTimeout?: (h: unknown) => void }) {
    this.#set = opts.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
    this.#clear = opts.clearTimeout ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  push(m: ChatMessage): void {
    if (this.open || m.removed) return;
    if (m.author && m.author.id === this.opts.meId()) return;
    this.unread += 1;
    this.current = { id: m.id, text: m.text, author: m.author ? { handle: m.author.handle, kind: m.author.kind } : null };
    this.#clear(this.#timer);
    this.#timer = this.#set(() => {
      this.current = null;
      this.#timer = null;
      this.onChange?.();
    }, TOAST_MS);
    this.onChange?.();
  }

  dismiss(): void {
    this.#clear(this.#timer);
    this.#timer = null;
    this.current = null;
    this.onChange?.();
  }

  setOpen(open: boolean): void {
    this.open = open;
    if (open) {
      this.#clear(this.#timer);
      this.#timer = null;
      this.current = null;
      this.unread = 0;
    }
    this.onChange?.();
  }

  reset(): void {
    this.#clear(this.#timer);
    this.#timer = null;
    this.current = null;
    this.unread = 0;
    this.onChange?.();
  }
}
