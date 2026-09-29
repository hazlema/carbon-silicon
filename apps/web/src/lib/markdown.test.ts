import { describe, expect, test } from 'bun:test';
import { md } from './markdown';

describe('md', () => {
  test('headings get ids, so a doc can link to its own sections', () => {
    expect(md('## The six things that *surprise* everyone')).toBe(
      '<h2 id="the-six-things-that-surprise-everyone">The six things that <em>surprise</em> everyone</h2>\n',
    );
    expect(md('# Critical Mass — How to Play')).toContain('id="critical-mass--how-to-play"');
  });
});
