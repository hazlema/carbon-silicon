import { marked } from 'marked';

/** Render trusted markdown (our own docs and diary) to HTML. */
export function md(source: string): string {
  return marked.parse(source, { async: false, gfm: true }) as string;
}
