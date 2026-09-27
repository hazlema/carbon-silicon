import { describe, expect, test } from 'bun:test';
import type { IdentityPublic, ModLogEntry, ReportInfo, ReportSnapshot } from '@cs/shared/protocol';
import { allowedActions, contextLines, durationText, isModerator, limits, logLine } from './mod';

const who = (id: string, over: Partial<IdentityPublic> = {}): IdentityPublic => ({
  id,
  handle: id,
  kind: 'human',
  tagline: null,
  color: '#ff8a3d',
  model: null,
  isHouse: false,
  locked: true,
  role: 'user',
  ownerHandle: null,
  released: false,
  ...over,
});
const admin = who('boss', { role: 'admin' });
const mod = who('mo', { role: 'mod' });
const user = who('ann');

describe('isModerator', () => {
  test('mods and admins only', () => {
    expect([isModerator(admin), isModerator(mod), isModerator(user), isModerator(null)]).toEqual([true, true, false, false]);
  });
});

describe('allowedActions', () => {
  test('mods sanction users; admins also manage accounts and roles', () => {
    expect(allowedActions(mod, user)).toEqual(['mute', 'suspend', 'lift']);
    expect(allowedActions(admin, user)).toEqual(['mute', 'suspend', 'lift', 'role', 'reset-password', 'release']);
  });
  test('nobody acts on themselves, their equals or their seniors, or on a released name', () => {
    expect(allowedActions(mod, mod)).toEqual([]);
    expect(allowedActions(mod, who('mo2', { role: 'mod' }))).toEqual([]);
    expect(allowedActions(mod, admin)).toEqual([]);
    expect(allowedActions(admin, who('gone', { released: true }))).toEqual([]);
    expect(allowedActions(user, who('bob'))).toEqual([]);
  });
});

describe('limits', () => {
  test('mute and suspension ceilings by role', () => {
    expect(limits(mod)).toEqual({ muteMax: 1440, suspendMax: 10080, permanent: false });
    expect(limits(admin)).toEqual({ muteMax: 1440, suspendMax: null, permanent: true });
    expect(limits(who('Bouncer', { kind: 'agent', isHouse: true, role: 'mod' }))).toEqual({ muteMax: 60, suspendMax: 0, permanent: false });
  });
});

describe('durationText', () => {
  test('days, hours or minutes', () => {
    expect(durationText(15)).toBe('15 minutes');
    expect(durationText(60)).toBe('1 hour');
    expect(durationText(120)).toBe('2 hours');
    expect(durationText(1440)).toBe('1 day');
    expect(durationText(10080)).toBe('7 days');
  });
});

describe('logLine', () => {
  const entry = (over: Partial<ModLogEntry>): ModLogEntry => ({
    id: 1,
    actor: 'mo',
    target: user,
    action: 'mute',
    reason: 'spam',
    detail: {},
    createdAt: '2026-09-27T12:00:00Z',
    ...over,
  });
  test('reads as a sentence', () => {
    expect(logLine(entry({ detail: { minutes: 60 } }))).toBe('@mo muted @ann for 1 hour');
    expect(logLine(entry({ actor: 'console', action: 'role', detail: { role: 'mod' } }))).toBe('console changed the role of @ann to mod');
    expect(logLine(entry({ action: 'ip-ban', target: null, detail: { ip: '10.1.2.3' } }))).toBe('@mo banned an IP 10.1.2.3');
    expect(logLine(entry({ action: 'release', target: who('~x', { released: true }) }))).toBe('@mo released a former player');
  });
});

describe('contextLines', () => {
  const line = (messageId: number): ReportSnapshot => ({ messageId, channel: 'lobby', author: user, text: `t${messageId}`, createdAt: '2026-09-27T12:00:00Z' });
  test('merges the snapshot into its context, in order, marking the reported line', () => {
    const report = { snapshot: line(5), context: [line(4), line(6), line(3)] } as ReportInfo;
    expect(contextLines(report).map((l) => [l.messageId, l.reported])).toEqual([
      [3, false],
      [4, false],
      [5, true],
      [6, false],
    ]);
  });
  test('does not repeat the snapshot when the context already holds it', () => {
    const report = { snapshot: line(5), context: [line(5), line(6)] } as ReportInfo;
    expect(contextLines(report).map((l) => l.messageId)).toEqual([5, 6]);
  });
});
