import { GameRuleError } from './errors';
import type { Action, Condition, Doctrine, DoctrineCatalog, Rule, When } from './types';

export const MAX_RULES = 32;
export const MAX_DEPTH = 8;
export const MAX_LABEL = 40;
const OPS = ['lt', 'lte', 'gt', 'gte', 'eq', 'ne'] as const;
const NUMERIC = ['lt', 'lte', 'gt', 'gte'];

type Senses = Record<string, number | string | boolean>;
type Obj = Record<string, unknown>;

const bad = (path: string, why: string) => new GameRuleError('BAD_DOCTRINE', `${path}: ${why}`);
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Edit distance, for "did you mean". */
export function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const next = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = row[j];
      row[j] = next;
    }
  }
  return row[b.length];
}

function suggest(word: string, options: string[]): string {
  let best: string | null = null;
  let bestD = 3;
  for (const o of options) {
    const d = distance(word, o);
    if (d < bestD) [best, bestD] = [o, d];
  }
  return best ? `; did you mean "${best}"?` : '';
}

/**
 * Checks a doctrine against a game's catalog and returns it cleaned (unknown fields refused, not
 * dropped). Throws GameRuleError BAD_DOCTRINE naming the first problem by its path.
 */
export function validateDoctrine(input: unknown, catalog: DoctrineCatalog): Doctrine {
  if (!isObj(input) || !Array.isArray(input.rules)) throw bad('doctrine', 'send {"rules": [...]}');
  if (input.rules.length < 1 || input.rules.length > MAX_RULES) throw bad('rules', `a doctrine has 1–${MAX_RULES} rules`);
  return { rules: input.rules.map((r, i) => rule(r, `rules[${i}]`, catalog)) };
}

function rule(r: unknown, path: string, cat: DoctrineCatalog): Rule {
  if (!isObj(r)) throw bad(path, 'a rule is an object with "do", and optionally "when" and "label"');
  for (const k of Object.keys(r)) if (k !== 'when' && k !== 'do' && k !== 'label') throw bad(`${path}.${k}`, `unknown field "${k}"`);
  const out: Rule = { do: action(r.do, `${path}.do`, cat) };
  if (r.when !== undefined) out.when = when(r.when, `${path}.when`, cat, 1);
  if (r.label !== undefined) {
    if (typeof r.label !== 'string' || r.label.length > MAX_LABEL || /[\u0000-\u001f]/.test(r.label)) {
      throw bad(`${path}.label`, `a label is plain text of at most ${MAX_LABEL} characters`);
    }
    out.label = r.label;
  }
  return out;
}

function when(w: unknown, path: string, cat: DoctrineCatalog, depth: number): When {
  if (depth > MAX_DEPTH) throw bad(path, `conditions nest at most ${MAX_DEPTH} deep`);
  if (!isObj(w)) throw bad(path, 'a condition is an object');
  if ('all' in w || 'any' in w) {
    const key = 'all' in w ? 'all' : 'any';
    const list = w[key];
    if (!Array.isArray(list) || list.length === 0) throw bad(`${path}.${key}`, 'a non-empty list of conditions');
    const inner = list.map((x, i) => when(x, `${path}.${key}[${i}]`, cat, depth + 1));
    return key === 'all' ? { all: inner } : { any: inner };
  }
  if ('not' in w) return { not: when(w.not, `${path}.not`, cat, depth + 1) };
  return condition(w, path, cat);
}

function senseOf(name: unknown, path: string, cat: DoctrineCatalog) {
  if (typeof name !== 'string') throw bad(path, 'name a sense');
  const s = cat.senses[name];
  if (!s) throw bad(path, `unknown sense "${name}"${suggest(name, Object.keys(cat.senses))}`);
  return s;
}

function condition(w: Obj, path: string, cat: DoctrineCatalog): Condition {
  const sense = senseOf(w.sense, `${path}.sense`, cat);
  const name = w.sense as string;
  if (typeof w.op !== 'string' || !(OPS as readonly string[]).includes(w.op)) throw bad(`${path}.op`, `op is one of ${OPS.join(', ')}`);
  const op = w.op as Condition['op'];
  if (NUMERIC.includes(op) && sense.type !== 'number') throw bad(`${path}.op`, `"${op}" compares numbers; "${name}" is a ${sense.type}`);
  const v = w.value;
  if (isObj(v)) {
    const other = senseOf(v.sense, `${path}.value.sense`, cat);
    if (other.type !== sense.type) throw bad(`${path}.value`, `"${v.sense as string}" is a ${other.type}, "${name}" is a ${sense.type}`);
    return { sense: name, op, value: { sense: v.sense as string } };
  }
  if (typeof v !== sense.type) throw bad(`${path}.value`, `"${name}" is a ${sense.type}`);
  if (sense.values && !sense.values.includes(v as string)) throw bad(`${path}.value`, `"${name}" is one of ${sense.values.join(', ')}`);
  return { sense: name, op, value: v as number | string | boolean };
}

function action(a: unknown, path: string, cat: DoctrineCatalog): Action {
  if (!isObj(a)) throw bad(path, 'an action is an object like {"act": "straight"}');
  if (typeof a.act !== 'string') throw bad(`${path}.act`, 'name an action');
  const spec = cat.actions[a.act];
  if (!spec) throw bad(`${path}.act`, `unknown action "${a.act}"${suggest(a.act, Object.keys(cat.actions))}`);
  for (const [k, v] of Object.entries(a)) {
    if (k === 'act') continue;
    const p = spec.params[k];
    if (!p) throw bad(`${path}.${k}`, `"${a.act}" has no parameter "${k}"${suggest(k, Object.keys(spec.params))}`);
    if (typeof v !== p.type) throw bad(`${path}.${k}`, `"${k}" is a ${p.type}`);
    if (p.values && !p.values.includes(v as string)) throw bad(`${path}.${k}`, `"${k}" is one of ${p.values.join(', ')}`);
  }
  for (const [k, p] of Object.entries(spec.params)) if (p.required && !(k in a)) throw bad(`${path}.${k}`, `"${a.act}" needs "${k}"`);
  return { ...a } as Action;
}

/** Does a (validated) condition hold for these senses? */
export function holds(w: When, senses: Senses): boolean {
  if ('all' in w) return w.all.every((x) => holds(x, senses));
  if ('any' in w) return w.any.some((x) => holds(x, senses));
  if ('not' in w) return !holds(w.not, senses);
  const a = senses[w.sense];
  const b = typeof w.value === 'object' ? senses[w.value.sense] : w.value;
  switch (w.op) {
    case 'eq':
      return a === b;
    case 'ne':
      return a !== b;
    case 'lt':
      return (a as number) < (b as number);
    case 'lte':
      return (a as number) <= (b as number);
    case 'gt':
      return (a as number) > (b as number);
    case 'gte':
      return (a as number) >= (b as number);
  }
}

/** The first rule that holds (or has no `when`) decides; null when none does. */
export function evaluate(doctrine: Doctrine, senses: Senses): { action: Action | null; fired: number | null } {
  for (let i = 0; i < doctrine.rules.length; i++) {
    const r = doctrine.rules[i];
    if (!r.when || holds(r.when, senses)) return { action: r.do, fired: i };
  }
  return { action: null, fired: null };
}
