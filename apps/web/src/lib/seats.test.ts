import { describe, expect, test } from 'bun:test';
import { clock, colorOf, tableColors, TABLE_PALETTE } from './seats';

const human = { kind: 'human' as const };
const agent = { kind: 'agent' as const };

describe('tableColors', () => {
  test('one human against one machine plays carbon against silicon, whatever the seat', () => {
    expect(tableColors([{ seat: 'red', identity: agent }, { seat: 'blue', identity: human }])).toEqual({
      red: '#4fe3ff',
      blue: '#ff8a3d',
    });
  });
  test('any other table takes the palette in seat order', () => {
    expect(tableColors([{ seat: 'red', identity: human }, { seat: 'blue', identity: human }])).toEqual({
      red: TABLE_PALETTE[0],
      blue: TABLE_PALETTE[1],
    });
    const four = tableColors(['red', 'blue', 'green', 'gold'].map((seat) => ({ seat, identity: agent })));
    expect(Object.values(four)).toEqual(TABLE_PALETTE);
  });
  test('unknown seats fall back to a neutral', () => {
    expect(colorOf({}, 'red')).toBe('#9aa1cf');
    expect(colorOf({ red: '#ff8a3d' }, null)).toBe('#9aa1cf');
  });
});

describe('clock', () => {
  test('minutes and zero-padded seconds', () => {
    expect(clock(87)).toBe('1:27');
    expect(clock(60)).toBe('1:00');
    expect(clock(9)).toBe('0:09');
    expect(clock(0)).toBe('0:00');
  });
});
