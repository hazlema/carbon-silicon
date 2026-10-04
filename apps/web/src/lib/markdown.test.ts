import { describe, expect, test } from 'bun:test';
import { apiOutline, endpointHeadings, guideParts, md, outline } from './markdown';

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
    expect(out).toContain('<h3 id="post-apiagents" class="endpoint"><span class="verb post">POST</span> <span class="path">/api/agents</span></h3>');
    expect(out).toContain('<h3 id="real-time-games">Real-time games</h3>');
    expect(out).toContain('<h2 id="get-is-a-word">GET is a word</h2>');
  });
});

describe('outline', () => {
  test('lists the ## sections with the ids md() gives them, skipping the title and sub-sections', () => {
    const source = '# Crown & Steel — How to Play\n\nIntro.\n\n## What kind of *game* is this?\n\n### Example 1\n\n## The `legal` array\n';
    const html = md(source);
    expect(outline(source)).toEqual([
      { id: 'what-kind-of-game-is-this', html: 'What kind of <em>game</em> is this?' },
      { id: 'the-legal-array', html: 'The <code>legal</code> array' },
    ]);
    for (const { id } of outline(source)) expect(html).toContain(`<h2 id="${id}">`);
  });
  test('ignores a ## inside a code block', () => {
    expect(outline('```\n## not a heading\n```\n\n## Real')).toEqual([{ id: 'real', html: 'Real' }]);
  });
});

describe('apiOutline', () => {
  test('sections carry their endpoints; a plain ### heading is not one', () => {
    const src = '# API\n\n### GET /api/early\n\n## Tables\n\n### GET /api/tables/:id\n\n### How seats work\n\n## Humans\' door\n\n### POST /api/chat/:channel';
    expect(apiOutline(src)).toEqual([
      { id: 'tables', text: 'Tables', endpoints: [{ id: 'get-apitablesid', verb: 'GET', path: '/api/tables/:id' }] },
      { id: 'humans-door', text: "Humans' door", endpoints: [{ id: 'post-apichatchannel', verb: 'POST', path: '/api/chat/:channel' }] },
    ]);
    expect(endpointHeadings(md('### GET /api/tables/:id'))).toContain('<span class="path">/api/tables/<i>:id</i></span>');
  });
});

describe('guideParts', () => {
  test('lifts the title, cover and pitch off a guide and leaves the rest', () => {
    const src = '# Critical Mass — How to Play\n\n![The board](/files/hero.jpg)\n\n*Stack orbs.*\n\nThis guide assumes nothing.\n\n## The board\n';
    expect(guideParts(src)).toEqual({
      title: 'Critical Mass — How to Play',
      cover: { src: '/files/hero.jpg', alt: 'The board' },
      tagline: 'Stack orbs.',
      body: 'This guide assumes nothing.\n\n## The board\n',
    });
  });
  test('a guide with no cover, or no opening at all, still reads', () => {
    expect(guideParts('# Lightline — How to Play\n\n*Neon.*\n\nText')).toEqual({ title: 'Lightline — How to Play', cover: null, tagline: 'Neon.', body: 'Text' });
    expect(guideParts('Just *text* here\n')).toEqual({ title: null, cover: null, tagline: null, body: 'Just *text* here\n' });
  });
});
