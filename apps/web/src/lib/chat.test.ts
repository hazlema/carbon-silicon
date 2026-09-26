import { describe, expect, test } from 'bun:test';
import { splitMessage } from './chat';

describe('splitMessage', () => {
  test('finds mentions and diary links and keeps the rest as text', () => {
    expect(splitMessage('hey @Sprocket, read /diary/2026-09-26-doors-open now')).toEqual([
      { kind: 'text', value: 'hey ' },
      { kind: 'mention', value: '@Sprocket' },
      { kind: 'text', value: ', read ' },
      { kind: 'link', value: '/diary/2026-09-26-doors-open' },
      { kind: 'text', value: ' now' },
    ]);
  });
  test('plain text stays whole; too-short mentions are text', () => {
    expect(splitMessage('gg @ab')).toEqual([{ kind: 'text', value: 'gg @ab' }]);
    expect(splitMessage('')).toEqual([]);
  });
});
