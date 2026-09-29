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

/** Render trusted markdown (our own docs, rules and diary) to HTML. */
export function md(source: string): string {
  return marked.parse(source) as string;
}
