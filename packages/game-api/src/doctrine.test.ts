import { describe, expect, test } from 'bun:test';
import { distance, evaluate, validateDoctrine } from './doctrine';
import { GameRuleError } from './errors';
import type { DoctrineCatalog, Doctrine } from './types';

const CAT: DoctrineCatalog = {
  senses: {
    wall_ahead: { type: 'number', doc: 'cells to the wall' },
    open_left: { type: 'number', doc: 'space left' },
    open_right: { type: 'number', doc: 'space right' },
    bearing: { type: 'string', doc: 'where', values: ['ahead', 'left', 'right', 'behind', 'none'] },
    boosting: { type: 'boolean', doc: 'boosting' },
  },
  actions: {
    straight: { doc: 'go on', params: { boost: { type: 'boolean', doc: 'boost' } } },
    turn: { doc: 'turn', params: { dir: { type: 'string', doc: 'dir', values: ['left', 'right'], required: true }, boost: { type: 'boolean', doc: 'boost' } } },
  },
};
const why = (input: unknown): string => {
  try {
    validateDoctrine(input, CAT);
  } catch (e) {
    expect(e).toBeInstanceOf(GameRuleError);
    expect((e as GameRuleError).code).toBe('BAD_DOCTRINE');
    return (e as Error).message;
  }
  throw new Error('expected BAD_DOCTRINE');
};
const nest = (depth: number): unknown => (depth === 0 ? { sense: 'boosting', op: 'eq', value: true } : { not: nest(depth - 1) });

describe('validateDoctrine', () => {
  test('a good doctrine comes back as given', () => {
    const d: Doctrine = {
      rules: [
        { label: 'dodge', when: { all: [{ sense: 'wall_ahead', op: 'lte', value: 2 }, { sense: 'open_left', op: 'gte', value: { sense: 'open_right' } }] }, do: { act: 'turn', dir: 'left' } },
        { do: { act: 'straight', boost: true } },
      ],
    };
    const result = validateDoctrine(d as unknown, CAT);
    expect(result).toEqual(d);
  });

  test('errors name the path, and suggest a near miss', () => {
    expect(why({ rules: [{ do: { act: 'straight' } }, { do: { act: 'straight' } }, { when: { sense: 'wal_ahead', op: 'lt', value: 2 }, do: { act: 'straight' } }] })).toBe(
      'rules[2].when.sense: unknown sense "wal_ahead"; did you mean "wall_ahead"?',
    );
    expect(why({ rules: [{ do: { act: 'trun', dir: 'left' } }] })).toBe('rules[0].do.act: unknown action "trun"; did you mean "turn"?');
    expect(why({ rules: [{ do: { act: 'turn' } }] })).toBe('rules[0].do.dir: "turn" needs "dir"');
    expect(why({ rules: [{ do: { act: 'turn', dir: 'up' } }] })).toBe('rules[0].do.dir: "dir" is one of left, right');
    expect(why({ rules: [{ do: { act: 'straight', speed: 2 } }] })).toBe('rules[0].do.speed: "straight" has no parameter "speed"');
    expect(why({ rules: [{ do: { act: 'straight' }, colour: 'red' }] })).toBe('rules[0].colour: unknown field "colour"');
  });

  test('types: numbers compare with numbers, strings keep to their values, senses compare with their own kind', () => {
    expect(why({ rules: [{ when: { sense: 'bearing', op: 'lt', value: 'left' }, do: { act: 'straight' } }] })).toBe('rules[0].when.op: "lt" compares numbers; "bearing" is a string');
    expect(why({ rules: [{ when: { sense: 'wall_ahead', op: 'eq', value: 'far' }, do: { act: 'straight' } }] })).toBe('rules[0].when.value: "wall_ahead" is a number');
    expect(why({ rules: [{ when: { sense: 'bearing', op: 'eq', value: 'up' }, do: { act: 'straight' } }] })).toBe('rules[0].when.value: "bearing" is one of ahead, left, right, behind, none');
    expect(why({ rules: [{ when: { sense: 'wall_ahead', op: 'gt', value: { sense: 'bearing' } }, do: { act: 'straight' } }] })).toBe('rules[0].when.value: "bearing" is a string, "wall_ahead" is a number');
    expect(why({ rules: [{ when: { sense: 'wall_ahead', op: 'like', value: 1 }, do: { act: 'straight' } }] })).toBe('rules[0].when.op: op is one of lt, lte, gt, gte, eq, ne');
  });

  test('limits: 1–32 rules, 8 levels, 40-character plain labels, a real object', () => {
    expect(why({ rules: [] })).toBe('rules: a doctrine has 1–32 rules');
    expect(why({ rules: Array.from({ length: 33 }, () => ({ do: { act: 'straight' } })) })).toBe('rules: a doctrine has 1–32 rules');
    expect(() => validateDoctrine({ rules: [{ when: nest(7), do: { act: 'straight' } }] }, CAT)).not.toThrow();
    expect(why({ rules: [{ when: nest(8), do: { act: 'straight' } }] })).toContain('conditions nest at most 8 deep');
    expect(why({ rules: [{ label: 'x'.repeat(41), do: { act: 'straight' } }] })).toBe('rules[0].label: a label is plain text of at most 40 characters');
    expect(why('go left')).toBe('doctrine: send {"rules": [...]}');
    expect(why({ rules: [{ when: { all: [] }, do: { act: 'straight' } }] })).toBe('rules[0].when.all: a non-empty list of conditions');
  });

  test('a condition is exactly one shape: all, any, not, or a leaf; any other key is refused, not dropped', () => {
    const leaf = { sense: 'boosting', op: 'eq', value: true };
    const w = (when: unknown) => why({ rules: [{ when, do: { act: 'straight' } }] });
    expect(w({ all: [leaf], any: [leaf] })).toBe('rules[0].when.any: unknown field "any"');
    expect(w({ any: [leaf], all: [leaf] })).toBe('rules[0].when.any: unknown field "any"');
    expect(w({ not: leaf, sense: 'boosting' })).toBe('rules[0].when.sense: unknown field "sense"');
    expect(w({ ...leaf, or: [leaf] })).toBe('rules[0].when.or: unknown field "or"');
    expect(w({ all: [leaf], colour: 1 })).toBe('rules[0].when.colour: unknown field "colour"');
    expect(w({ all: [{ ...leaf, colour: 1 }] })).toBe('rules[0].when.all[0].colour: unknown field "colour"');
    expect(w({ sense: 'wall_ahead', op: 'lt', value: { sense: 'open_left', op: 'eq' } })).toBe('rules[0].when.value.op: unknown field "op"');
  });

  test('prototype pollution resistance: inherited Object members are rejected', () => {
    expect(why({ rules: [{ do: { act: 'constructor' } }] })).toBe('rules[0].do.act: unknown action "constructor"');
    expect(why({ rules: [{ when: { sense: 'toString', op: 'eq', value: true }, do: { act: 'straight' } }] })).toBe('rules[0].when.sense: unknown sense "toString"');
    expect(why({ rules: [{ do: { act: 'straight', hasOwnProperty: true } }] })).toBe('rules[0].do.hasOwnProperty: "straight" has no parameter "hasOwnProperty"');
  });
});

describe('evaluate', () => {
  const d = validateDoctrine(
    {
      rules: [
        { label: 'dodge-left', when: { all: [{ sense: 'wall_ahead', op: 'lte', value: 2 }, { sense: 'open_left', op: 'gte', value: { sense: 'open_right' } }] }, do: { act: 'turn', dir: 'left' } },
        { label: 'dodge-right', when: { sense: 'wall_ahead', op: 'lte', value: 2 }, do: { act: 'turn', dir: 'right' } },
        { when: { any: [{ sense: 'bearing', op: 'eq', value: 'behind' }, { not: { sense: 'boosting', op: 'eq', value: false } }] }, do: { act: 'straight', boost: true } },
      ],
    },
    CAT,
  );
  const s = (over: Record<string, number | string | boolean>) => ({ wall_ahead: 30, open_left: 10, open_right: 20, bearing: 'ahead', boosting: false, ...over });

  test('the first rule that holds fires', () => {
    expect(evaluate(d, s({ wall_ahead: 1, open_left: 50 }))).toEqual({ action: { act: 'turn', dir: 'left' }, fired: 0 });
    expect(evaluate(d, s({ wall_ahead: 2 }))).toEqual({ action: { act: 'turn', dir: 'right' }, fired: 1 });
    expect(evaluate(d, s({ bearing: 'behind' }))).toEqual({ action: { act: 'straight', boost: true }, fired: 2 });
    expect(evaluate(d, s({ boosting: true })).fired).toBe(2);
  });
  test('nothing holds: no action, so the game default applies', () => {
    expect(evaluate(d, s({}))).toEqual({ action: null, fired: null });
  });
  test('a rule without `when` always fires', () => {
    expect(evaluate({ rules: [{ do: { act: 'straight' } }] }, s({})).fired).toBe(0);
  });
});

test('distance is edit distance', () => {
  expect(distance('wal_ahead', 'wall_ahead')).toBe(1);
  expect(distance('trun', 'turn')).toBe(2);
  expect(distance('abc', 'abc')).toBe(0);
});
