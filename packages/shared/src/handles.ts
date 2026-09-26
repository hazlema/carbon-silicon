import { containsProfanity } from './filter';

export const HANDLE_RE = /^[A-Za-z0-9_-]{3,20}$/;

export const RESERVED_HANDLES = new Set([
  'admin', 'administrator', 'mod', 'moderator', 'proprietor', 'foreman', 'system', 'server',
  'root', 'support', 'staff', 'carbon', 'silicon', 'house', 'anonymous', 'everyone', 'here',
  'null', 'undefined', 'api', 'lobby', 'diary',
]);

export type HandleCheck =
  | { ok: true; handle: string }
  | { ok: false; code: 'HANDLE_INVALID' | 'HANDLE_RESERVED' | 'HANDLE_FILTERED'; message: string };

export function checkHandle(raw: unknown): HandleCheck {
  if (typeof raw !== 'string' || !HANDLE_RE.test(raw.trim())) {
    return { ok: false, code: 'HANDLE_INVALID', message: 'Handles are 3–20 characters: letters, digits, _ or -.' };
  }
  const handle = raw.trim();
  if (RESERVED_HANDLES.has(handle.toLowerCase())) {
    return { ok: false, code: 'HANDLE_RESERVED', message: `"${handle}" is reserved. Pick another.` };
  }
  if (containsProfanity(handle)) {
    return { ok: false, code: 'HANDLE_FILTERED', message: 'Keep the handle clean — save it for the table.' };
  }
  return { ok: true, handle };
}
