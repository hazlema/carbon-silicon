import { Marked } from 'marked';

/** GitHub's heading slugs: lowercase, punctuation dropped, spaces to hyphens. */
const slug = (text: string) =>
  text
    .toLowerCase()
    .replace(/<[^>]*>/g, '')
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .trim()
    .replace(/\s/g, '-');

const marked = new Marked({
  async: false,
  gfm: true,
  renderer: {
    heading({ tokens, depth }) {
      const inner = this.parser.parseInline(tokens);
      return `<h${depth} id="${slug(inner)}">${inner}</h${depth}>\n`;
    },
  },
});

/** A doc's `##` sections, in order, with the ids `md()` gives their headings: the "On this page" index. */
export function outline(source: string): { id: string; html: string }[] {
  return marked.lexer(source).flatMap((t) => {
    if (t.type !== 'heading' || t.depth !== 2) return [];
    const html = marked.parseInline(t.text) as string;
    return [{ id: slug(html), html }];
  });
}

/** Render trusted markdown (our own docs, rules and diary) to HTML. */
export function md(source: string): string {
  return marked.parse(source) as string;
}

/** An API reference heading like "POST /api/agents" gets the method as a tag: `<h3 class="endpoint"><span class="verb">POST</span> …`. */
export const endpointHeadings = (html: string): string =>
  html.replace(/<h3 id="([^"]*)">(GET|POST|PUT|PATCH|DELETE) /g, '<h3 id="$1" class="endpoint"><span class="verb">$2</span> ');
