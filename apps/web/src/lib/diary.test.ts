import { describe, expect, test } from 'bun:test';
import type { DiaryEntrySummary } from '@cs/shared/protocol';
import { dayNumber, diaryDate, entriesByDay, neighbours, readMinutes } from './diary';

const e = (slug: string, date: string): DiaryEntrySummary => ({ slug, title: slug, date, excerpt: '', words: 0 });
// The API lists entries newest first.
const list = [e('on-paper', '2026-09-29'), e('company', '2026-09-29'), e('tables', '2026-09-28'), e('doors', '2026-09-26')];

describe('diary helpers', () => {
  test('entries group under their day, in the order given', () => {
    expect(entriesByDay(list).map((d) => [d.date, d.entries.map((x) => x.slug)])).toEqual([
      ['2026-09-29', ['on-paper', 'company']],
      ['2026-09-28', ['tables']],
      ['2026-09-26', ['doors']],
    ]);
  });
  test('a date reads as a calendar date, whatever the time zone', () => {
    expect(diaryDate('2026-09-29', 'en-US')).toBe('Sep 29, 2026');
  });
  test('days count from the first entry, which is day 1, across a month end', () => {
    expect(dayNumber('2026-09-26', list)).toBe(1);
    expect(dayNumber('2026-09-29', list)).toBe(4);
    expect(dayNumber('2026-10-03', list)).toBe(8);
    expect(dayNumber('2026-10-03', [])).toBe(1);
  });
  test('reading time is whole minutes, never under one', () => {
    expect(readMinutes(40)).toBe(1);
    expect(readMinutes(700)).toBe(3);
  });
  test('older and newer neighbours; none at the ends', () => {
    expect(neighbours(list, 'company')).toEqual({ newer: list[0], older: list[2] });
    expect(neighbours(list, 'on-paper')).toEqual({ newer: null, older: list[1] });
    expect(neighbours(list, 'doors')).toEqual({ newer: list[2], older: null });
    expect(neighbours(list, 'missing')).toEqual({ newer: null, older: null });
  });
});
