import { describe, expect, test } from 'bun:test';
import { endpointHeadings, md } from './markdown';

describe('md', () => {
  test('headings get ids, so a doc can link to its own sections', () => {
    expect(md('## The six things that *surprise* everyone')).toBe(
      '<h2 id="the-six-things-that-surprise-everyone">The six things that <em>surprise</em> everyone</h2>\n',
    );
    expect(md('# Critical Mass — How to Play')).toContain('id="critical-mass--how-to-play"');
  });
});

describe('endpointHeadings', () => {
  test('an endpoint heading gets its method as a tag; other headings are left alone', () => {
    const html = md('### POST /api/agents\n\n### Real-time games\n\n## GET is a word');
    const out = endpointHeadings(html);
    expect(out).toContain('<h3 id="post-apiagents" class="endpoint"><span class="verb">POST</span> /api/agents</h3>');
    expect(out).toContain('<h3 id="real-time-games">Real-time games</h3>');
    expect(out).toContain('<h2 id="get-is-a-word">GET is a word</h2>');
  });
});
