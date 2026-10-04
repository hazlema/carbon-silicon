import { Marked } from 'marked';

const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" };
/** Rendered inline HTML back to the words it shows. */
const plainText = (html: string) => html.replace(/<[^>]*>/g, '').replace(/&(?:amp|lt|gt|quot|#39);/g, (e) => ENTITIES[e]);

/** GitHub's heading slugs: lowercase, punctuation dropped, spaces to hyphens. */
const slug = (html: string) =>
  plainText(html)
    .toLowerCase()
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

const VERBS = 'GET|POST|PUT|PATCH|DELETE';

/**
 * An API reference heading like "POST /api/tables/:id/sit" becomes a route line: the method as a tag and each
 * `:param` marked, `<h3 class="endpoint"><span class="verb post">POST</span> <span class="path">/api/tables/<i>:id</i>/sit</span>`.
 */
export const endpointHeadings = (html: string): string =>
  html.replace(new RegExp(`<h3 id="([^"]*)">(${VERBS}) ([^<]*)</h3>`, 'g'), (_, id: string, verb: string, path: string) => {
    const marked = path.replace(/:[A-Za-z]+/g, '<i>$&</i>');
    return `<h3 id="${id}" class="endpoint"><span class="verb ${verb.toLowerCase()}">${verb}</span> <span class="path">${marked}</span></h3>`;
  });

export interface ApiSection {
  id: string;
  text: string;
  endpoints: { id: string; verb: string; path: string }[];
}

/** The API reference's `##` sections, each with the endpoints (`### VERB /path`) under it: the page's index. */
export function apiOutline(source: string): ApiSection[] {
  const sections: ApiSection[] = [];
  for (const t of marked.lexer(source)) {
    if (t.type !== 'heading') continue;
    const html = marked.parseInline(t.text) as string;
    if (t.depth === 2) sections.push({ id: slug(html), text: plainText(html), endpoints: [] });
    const m = t.depth === 3 ? new RegExp(`^(${VERBS}) (\\S+)$`).exec(t.text) : null;
    if (m && sections.length) sections.at(-1)!.endpoints.push({ id: slug(html), verb: m[1], path: m[2] });
  }
  return sections;
}

export interface GuideParts {
  /** The guide's `#` title, e.g. "Critical Mass — How to Play". */
  title: string | null;
  /** The picture right under the title, when there is one. */
  cover: { src: string; alt: string } | null;
  /** The one-line italic pitch that opens the guide. */
  tagline: string | null;
  /** Everything after those, as markdown. */
  body: string;
}

/** Lift a rules guide's opening (title, cover picture, italic pitch) off its markdown, so the page can set them as a header. */
export function guideParts(source: string): GuideParts {
  let body = source.trimStart();
  const take = (re: RegExp) => {
    const m = re.exec(body);
    if (m) body = body.slice(m[0].length).trimStart();
    return m;
  };
  const title = take(/^# (.+)\r?\n/)?.[1].trim() ?? null;
  const img = take(/^!\[([^\]]*)\]\(([^)\s]+)\)[^\S\n]*\r?\n/);
  const tagline = take(/^\*([^*\n]+)\*[^\S\n]*\r?\n/)?.[1].trim() ?? null;
  return { title, cover: img ? { alt: img[1], src: img[2] } : null, tagline, body };
}
