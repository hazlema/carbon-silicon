import type { SanctionInfo } from '@cs/shared/protocol';

export interface TimeOpts {
  now?: number;
  locale?: string;
  timeZone?: string;
}

// Newer ICU data puts a narrow no-break space (U+202F) or no-break space (U+00A0) before AM/PM;
// plain spaces read and test the same everywhere. Written as escapes so they can't be lost again.
export const clean = (s: string) => s.replace(/[  ]/g, ' ');

/** "until 3:40 PM", "until Tue, Sep 29 at 3:40 PM", or "until further notice" for a permanent sanction. */
export function untilText(endsAt: string | null, opts: TimeOpts = {}): string {
  if (!endsAt) return 'until further notice';
  const { locale, timeZone } = opts;
  const end = new Date(endsAt);
  const now = new Date(opts.now ?? Date.now());
  const time = clean(new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit', timeZone }).format(end));
  const dayKey = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone }).format(d); // YYYY-MM-DD
  if (dayKey(end) === dayKey(now)) return `until ${time}`;
  const day = clean(new Intl.DateTimeFormat(locale, { weekday: 'short', month: 'short', day: 'numeric', timeZone }).format(end));
  return `until ${day} at ${time}`;
}

export function sanctionHeadline(s: Pick<SanctionInfo, 'kind'>): string {
  return s.kind === 'mute' ? "You're muted" : 'Your account is suspended';
}

/** "just now", "5 min ago", "3 h ago", "yesterday", "4 days ago", then a date. */
export function relativeTime(iso: string, opts: TimeOpts = {}): string {
  const min = Math.floor(((opts.now ?? Date.now()) - Date.parse(iso)) / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  return clean(
    new Intl.DateTimeFormat(opts.locale, { month: 'short', day: 'numeric', year: 'numeric', timeZone: opts.timeZone }).format(new Date(iso)),
  );
}
