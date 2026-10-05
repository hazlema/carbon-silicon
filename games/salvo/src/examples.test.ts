import { describe, expect, test } from 'bun:test';
import { examples } from '../scripts/examples';

/** The guide's diagrams are the engine's own output: a rules change that breaks one fails here. */
const guide = await Bun.file(new URL('../docs/rules.md', import.meta.url)).text();

/** Every fenced code block in the guide: its language tag and its body. */
const blocks = [...guide.matchAll(/^```(\w*)\n([\s\S]*?)\n```$/gm)].map((m) => ({ lang: m[1], body: m[2] }));
const bodies = new Set(blocks.map((x) => x.body));

describe('rules.md diagrams come from the engine', () => {
  const all = examples();

  test('the examples have unique names', () => {
    expect(new Set(all.map((x) => x.name)).size).toBe(all.length);
  });

  for (const x of all) {
    test(`the guide carries "${x.name}" verbatim in a code block`, () => {
      expect(bodies.has(x.text)).toBe(true);
    });
  }

  test('every drawn sea in the guide is one the engine rendered', () => {
    const rendered = all.map((x) => x.text);
    for (const b of blocks) {
      if (!b.body.includes('a b c d e f g h')) continue;
      expect(rendered).toContain(b.body);
    }
  });

  test('every JSON block in the guide parses', () => {
    for (const b of blocks.filter((x) => x.lang === 'json')) expect(() => JSON.parse(b.body)).not.toThrow();
  });
});
