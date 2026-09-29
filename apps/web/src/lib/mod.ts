import type { IdentityPublic, ModLogEntry, ReportInfo, ReportSnapshot, Role } from '@cs/shared/protocol';
import { displayName } from './profile';

export type PersonAction = 'mute' | 'suspend' | 'lift' | 'role' | 'reset-password' | 'release';

const RANK: Record<Role, number> = { user: 0, mod: 1, admin: 2 };

export const isModerator = (i: IdentityPublic | null | undefined): i is IdentityPublic =>
  !!i && (i.role === 'mod' || i.role === 'admin');

/** What the viewer may do to this person. The server enforces the same rules (powers.ts); this only
 *  decides which buttons to show. */
export function allowedActions(viewer: IdentityPublic, target: IdentityPublic): PersonAction[] {
  if (!isModerator(viewer) || viewer.id === target.id || target.released) return [];
  if (RANK[viewer.role] <= RANK[target.role]) return [];
  const actions: PersonAction[] = ['mute', 'suspend', 'lift'];
  if (viewer.role === 'admin') actions.push('role', 'reset-password', 'release');
  return actions;
}

/** Longest mute and suspension (minutes) the viewer may give; `suspendMax: null` means no ceiling. */
export function limits(viewer: IdentityPublic): { muteMax: number; suspendMax: number | null; permanent: boolean } {
  if (viewer.isHouse) return { muteMax: 60, suspendMax: 0, permanent: false };
  if (viewer.role === 'admin') return { muteMax: 1440, suspendMax: null, permanent: true };
  return { muteMax: 1440, suspendMax: 10080, permanent: false };
}

export const MINUTE_PRESETS = [
  { label: '15 min', minutes: 15 },
  { label: '1 hour', minutes: 60 },
  { label: '1 day', minutes: 1440 },
  { label: '7 days', minutes: 10080 },
];

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function durationText(minutes: number): string {
  if (minutes % 1440 === 0) return plural(minutes / 1440, 'day');
  if (minutes % 60 === 0) return plural(minutes / 60, 'hour');
  return plural(minutes, 'minute');
}

const VERB: Record<ModLogEntry['action'], string> = {
  'delete-message': 'deleted a message from',
  mute: 'muted',
  suspend: 'suspended',
  lift: 'lifted the sanction on',
  role: 'changed the role of',
  'reset-password': 'issued a reset code for',
  release: 'released',
  'ip-ban': 'banned an IP',
  'ip-unban': 'unbanned an IP',
  'resolve-report': 'resolved a report about',
  'reopen-report': 'reopened a report about',
  note: 'added a note to a report about',
};

/** One log entry as a sentence: "@mo muted @ann for 1 hour". */
export function logLine(e: ModLogEntry): string {
  const actor = e.actor === 'console' ? 'console' : `@${e.actor}`;
  const target = e.target ? (e.target.released ? displayName(e.target) : `@${e.target.handle}`) : '';
  const parts = [actor, VERB[e.action]];
  if (target) parts.push(target);
  if (typeof e.detail.ip === 'string') parts.push(e.detail.ip);
  if (e.action === 'role' && typeof e.detail.role === 'string') parts.push(`to ${e.detail.role}`);
  if (typeof e.detail.minutes === 'number') parts.push(`for ${durationText(e.detail.minutes)}`);
  if (e.action === 'resolve-report' && typeof e.detail.resolution === 'string') parts.push(`(${e.detail.resolution})`);
  return parts.join(' ');
}

type ReportView = Pick<ReportInfo, 'snapshot' | 'context'> & { target?: ReportInfo['target'] };

/** A snapshot line's author as they are now: the snapshot froze the handle, but the report's live
 *  `target` knows if that person has since been released (their old handle is free to claim). */
function authorNow(r: ReportView, author: IdentityPublic | null): IdentityPublic | null {
  return author && r.target && r.target.id === author.id ? r.target : author;
}

/** Who a report is about: "@bob", "a former player" once released, or "system". */
export function reportAbout(r: ReportView): string {
  const author = authorNow(r, r.snapshot.author);
  if (!author) return 'system';
  return author.released ? displayName(author) : `@${author.handle}`;
}

/** The reported line inside its surrounding lines, oldest first, with the reported one marked. */
export function contextLines(r: ReportView): (ReportSnapshot & { reported: boolean })[] {
  const byId = new Map<number, ReportSnapshot>();
  for (const line of r.context) byId.set(line.messageId, line);
  byId.set(r.snapshot.messageId, r.snapshot);
  return [...byId.values()]
    .sort((a, b) => a.messageId - b.messageId)
    .map((line) => ({ ...line, author: authorNow(r, line.author), reported: line.messageId === r.snapshot.messageId }));
}

/** Where a reported line was said, for the report card. */
export function channelLabel(channel: string): string {
  if (/^(match|table):/.test(channel)) return 'a table';
  if (channel.startsWith('rail:')) return 'a rail';
  if (channel.startsWith('dm:')) return 'a direct message';
  return `#${channel}`;
}
