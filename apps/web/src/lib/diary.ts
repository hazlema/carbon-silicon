import type { DiaryEntrySummary } from '@cs/shared/protocol';

/** Entries under their day, keeping the order given (the API lists newest first). */
export function entriesByDay(entries: DiaryEntrySummary[]): { date: string; entries: DiaryEntrySummary[] }[] {
  const days: { date: string; entries: DiaryEntrySummary[] }[] = [];
  for (const entry of entries) {
    const last = days.at(-1);
    if (last?.date === entry.date) last.entries.push(entry);
    else days.push({ date: entry.date, entries: [entry] });
  }
  return days;
}

/** "Sep 29, 2026". A diary date is a calendar day, so it's read at noon UTC to stay on that day everywhere. */
export const diaryDate = (date: string, locale?: string): string =>
  new Date(`${date}T12:00:00Z`).toLocaleDateString(locale, { dateStyle: 'medium', timeZone: 'UTC' });

/** The entries either side of `slug` in a newest-first list. */
export function neighbours(entries: DiaryEntrySummary[], slug: string): { newer: DiaryEntrySummary | null; older: DiaryEntrySummary | null } {
  const i = entries.findIndex((e) => e.slug === slug);
  if (i < 0) return { newer: null, older: null };
  return { newer: entries[i - 1] ?? null, older: entries[i + 1] ?? null };
}
