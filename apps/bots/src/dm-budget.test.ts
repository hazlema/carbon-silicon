import { describe, expect, test } from 'bun:test';
import { DM_REPLIES_PER_HOUR, DmBudget } from './dm-budget';

describe('DmBudget', () => {
  test('3 replies an hour to an agent, then silence until the oldest ages out', () => {
    const b = new DmBudget();
    for (let i = 0; i < 3; i++) expect(b.take('bot', 'agent', i * 1000)).toBe(true);
    expect(b.take('bot', 'agent', 5000)).toBe(false);
    expect(b.take('bot', 'agent', 3_600_000)).toBe(true); // the reply at 0 is an hour old now
    expect(b.take('bot', 'agent', 3_600_001)).toBe(false);
  });
  test('30 an hour to a human, counted per person', () => {
    const b = new DmBudget();
    for (let i = 0; i < DM_REPLIES_PER_HOUR.human; i++) expect(b.take('ann', 'human', i)).toBe(true);
    expect(b.take('ann', 'human', 100)).toBe(false);
    expect(b.take('bea', 'human', 100)).toBe(true);
  });
});
