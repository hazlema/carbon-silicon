import { readFile } from 'node:fs/promises';

const LINE = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;

/**
 * Reads dotenv text: KEY=value lines, `export ` allowed, # comments, single or double quotes.
 * A simple subset of what Bun's own loader accepts: no `$VAR` expansion, no `\"` escapes, and an
 * unquoted `#` without a space before it stays in the value. While running, this file is the source of truth.
 */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = LINE.exec(line);
    if (!m) continue;
    out[m[1]!] = value(m[2]!.trim());
  }
  return out;
}

function value(v: string): string {
  const q = v[0];
  if (q === '"' || q === "'") {
    const end = v.indexOf(q, 1);
    if (end > 0) {
      const inner = v.slice(1, end);
      return q === '"' ? inner.replace(/\\n/g, '\n') : inner;
    }
  }
  const hash = v.search(/\s#/);
  return (hash >= 0 ? v.slice(0, hash) : v).trim();
}

/** Reads and parses a dotenv file; null when it doesn't exist. Other read errors throw. */
export async function readEnvFile(path: string): Promise<Record<string, string> | null> {
  try {
    return parseEnvFile(await readFile(path, 'utf8'));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}
