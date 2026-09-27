import { testDatabaseUrl } from '@cs/server/testing';
import { afterAll, describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import type { IdentityPublic } from '@cs/shared/protocol';
import { FakeClock } from '../lib/clock';
import type { AppError } from '../lib/errors';
import { randomTag } from '../lib/testing';
import { createCore } from './core';
import type { Actor } from './powers';

const diaryDir = fileURLToPath(new URL('../__fixtures__/diary', import.meta.url));
const clock = new FakeClock();
const core = await createCore({
  databaseUrl: await testDatabaseUrl(),
  clock,
  houseKey: 'hk',
  diaryDir,
  countdownMs: 0,
  houseFallbackMs: 60_000,
  sweepEveryMs: 0,
});
afterAll(() => core.close());

const meta = { label: 'test', ip: null };
const CONSOLE: Actor = { kind: 'console' };
const as = (identity: IdentityPublic): Actor => ({ kind: 'identity', identity });
const person = async (prefix = 'p') => (await core.identities.createHuman(`${prefix}${randomTag()}`, meta)).identity;
async function staff(role: 'mod' | 'admin', house = false): Promise<IdentityPublic> {
  const base = house
    ? (await core.identities.registerAgent({ name: `bouncer${randomTag()}` }, 'hk')).identity
    : (await core.accounts.lock(await person(role), 'correct horse battery')).identity;
  return core.identities.setRole(base.id, role);
}
async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return (e as AppError).code;
  }
  throw new Error('expected a rejection');
}

describe('ignore and block', () => {
  test("ignoring someone stops their @mentions reaching your inbox; clearing restores them", async () => {
    const ann = await person('ann');
    const bob = await person('bob');
    expect((await core.relations.set(ann, bob.handle, 'ignore')).ignores.map((i) => i.id)).toEqual([bob.id]);
    const start = (await core.comms.poll(ann.id, 0, 0)).cursor;
    await core.comms.post(bob, 'lobby', `hey @${ann.handle}`);
    expect((await core.comms.poll(ann.id, start, 0)).events).toHaveLength(0);
    await core.relations.clear(ann, bob.handle, 'ignore');
    await core.comms.post(bob, 'lobby', `again @${ann.handle}`);
    expect((await core.comms.poll(ann.id, start, 0)).events.map((e) => e.type)).toEqual(['chat.mention']);
  });

  test('block covers ignore; one relation per pair; precise errors', async () => {
    const ann = await person('ann');
    const bob = await person('bob');
    await core.relations.set(ann, bob.handle, 'block');
    expect(await core.relations.mutes(ann.id, bob.id)).toBe(true);
    expect(await core.relations.mutes(bob.id, ann.id)).toBe(false);
    const switched = await core.relations.set(ann, bob.handle.toUpperCase(), 'ignore');
    expect([switched.ignores.map((i) => i.id), switched.blocks]).toEqual([[bob.id], []]);
    expect(await codeOf(core.relations.set(ann, ann.handle, 'block'))).toBe('SELF');
    expect(await codeOf(core.relations.set(ann, `nobody${randomTag()}`, 'block'))).toBe('NO_USER');
  });

  test('releasing someone forgets every relation that points at them', async () => {
    const ann = await person('ann');
    const bob = await person('bob');
    await core.relations.set(ann, bob.handle, 'ignore');
    await core.moderation.release(CONSOLE, bob.id, 'deleted their account');
    expect((await core.relations.list(ann.id)).ignores).toEqual([]);
  });
});

describe('chat filters and removal', () => {
  test('slurs are refused in every channel; public profanity is still only censored', async () => {
    const p = await person('filt');
    const bot = (await core.identities.registerAgent({ name: `bot${randomTag()}` }, null)).identity;
    const match = await core.games.createMatch('critical-mass', [p, bot]);
    const table = `match:${match.id}`;
    expect(await codeOf(core.comms.post(p, 'lobby', 'you ch1nk'))).toBe('FILTERED');
    expect(await codeOf(core.comms.post(p, table, 'ch1nk move'))).toBe('FILTERED');
    expect((await core.comms.post(p, table, 'holy shit')).text).toBe('holy shit');
    expect((await core.comms.post(p, 'lobby', 'holy shit')).text).not.toContain('shit');
    await core.games.resign(match.id, p);
  });

  test('a removed message keeps its place, loses its words, and is announced', async () => {
    const mod = await staff('mod');
    const p = await person('rude');
    const m = await core.comms.post(p, 'lobby', 'something rude');
    const seen: unknown[] = [];
    const off = core.bus.on('chat.removed', (e) => seen.push(e));
    const removed = await core.moderation.deleteMessage(as(mod), m.id, 'rude');
    off();
    expect(removed).toMatchObject({ id: m.id, text: '', removed: { by: mod.handle } });
    const history = await core.comms.history('lobby', { since: m.id - 1 });
    expect(history.find((x) => x.id === m.id)).toMatchObject({ text: '', removed: { by: mod.handle } });
    expect(seen).toEqual([{ channel: 'lobby', id: m.id, by: mod.handle }]);

    // its text stays visible to mods (S145-146): a normal user's read is still blank, staff's isn't
    expect((await core.comms.message(m.id))?.text).toBe('');
    expect((await core.comms.message(m.id, p))?.text).toBe('');
    expect((await core.comms.message(m.id, mod))?.text).toBe('something rude');
    const modHistory = await core.comms.history('lobby', { since: m.id - 1, viewer: mod });
    expect(modHistory.find((x) => x.id === m.id)).toMatchObject({ text: 'something rude', removed: { by: mod.handle } });
    const userHistory = await core.comms.history('lobby', { since: m.id - 1, viewer: p });
    expect(userHistory.find((x) => x.id === m.id)).toMatchObject({ text: '', removed: { by: mod.handle } });
    expect((await core.moderation.log({ targetId: p.id }))[0]).toMatchObject({ action: 'delete-message', detail: { messageId: m.id, channel: 'lobby' } });

    const sys = await core.comms.postSystem('lobby', 'a notice');
    expect(await codeOf(core.moderation.deleteMessage(as(mod), sys.id, 'no'))).toBe('NO_MESSAGE');
    expect(await codeOf(core.moderation.deleteMessage(as(mod), 987_654_321, 'no'))).toBe('NO_MESSAGE');
    expect(await codeOf(core.moderation.deleteMessage(as(await person('nobody')), m.id, 'no'))).toBe('FORBIDDEN_ROLE');
  });
});

describe('reports', () => {
  test('odd reports are refused precisely', async () => {
    const ann = await person('ann');
    const bob = await person('bob');
    const cat = await person('cat');
    const sys = await core.comms.postSystem('lobby', 'the parlor opens');
    const line = await core.comms.post(bob, 'lobby', 'you are all bad at this');
    expect(await codeOf(core.reports.create(ann, sys.id, null))).toBe('CANT_REPORT');
    expect(await codeOf(core.reports.create(bob, line.id, null))).toBe('CANT_REPORT');
    expect(await codeOf(core.reports.create(ann, 987_654_321, null))).toBe('NO_MESSAGE');
    expect(await codeOf(core.reports.create(ann, String(line.id), null))).toBe('BAD_MESSAGE');
    expect(await codeOf(core.reports.create(ann, line.id, 'x'.repeat(301)))).toBe('BAD_REASON');
    const first = await core.reports.create(ann, line.id, 'rude');
    expect(first).toMatchObject({ status: 'open', reason: 'rude', reporter: { id: ann.id }, target: { id: bob.id } });
    expect(await codeOf(core.reports.create(ann, line.id, 'again'))).toBe('DUPLICATE_REPORT');
    expect((await core.reports.create(cat, line.id, null)).reason).toBeNull();
  });

  test('a report keeps its snapshot and context after the message is deleted', async () => {
    const mod = await staff('mod');
    const [a, b, c, d, reporter] = await Promise.all(['a', 'b', 'c', 'd', 'r'].map((x) => person(x)));
    const before = [await core.comms.post(a, 'critical-mass', 'good game'), await core.comms.post(b, 'critical-mass', 'rematch?')];
    const bad = await core.comms.post(c, 'critical-mass', 'you play like a toaster, idiot');
    const after = [await core.comms.post(d, 'critical-mass', 'harsh')];
    const report = await core.reports.create(reporter, bad.id, 'insult');
    await core.moderation.deleteMessage(as(mod), bad.id, 'insult');
    const again = await core.reports.get(report.id);
    expect(again.snapshot).toMatchObject({ messageId: bad.id, channel: 'critical-mass', text: 'you play like a toaster, idiot', author: { id: c.id } });
    const contextIds = again.context.map((x) => x.messageId);
    expect(contextIds).toEqual(expect.arrayContaining([...before, ...after].map((m) => m.id)));
    expect(contextIds).not.toContain(bad.id);
    expect(again.status).toBe('open');
  });

  test('staff hear about new reports; the reporter does not', async () => {
    const mod = await staff('mod');
    const reporter = await staff('mod');
    const bob = await person('bob');
    const cursor = (await core.comms.poll(mod.id, 0, 0)).cursor;
    const reporterCursor = (await core.comms.poll(reporter.id, 0, 0)).cursor;
    const line = await core.comms.post(bob, 'lobby', 'meh');
    const report = await core.reports.create(reporter, line.id, null);
    const events = (await core.comms.poll(mod.id, cursor, 0)).events;
    expect(events.find((e) => e.type === 'report.opened')).toMatchObject({ report: { id: report.id } });
    expect((await core.comms.poll(reporter.id, reporterCursor, 0)).events.some((e) => e.type === 'report.opened')).toBe(false);
  });

  test('resolving performs the action and closes the report; reopening and notes work', async () => {
    const mod = await staff('mod');
    const [reporter, bob] = [await person('rep'), await person('bob')];
    const line = await core.comms.post(bob, 'lobby', 'spam spam spam');
    const report = await core.reports.create(reporter, line.id, 'spam');
    expect(await codeOf(core.reports.resolve(as(mod), report.id, 'banish', 'spam'))).toBe('BAD_RESOLUTION');
    const done = await core.reports.resolve(as(mod), report.id, 'delete', 'spam');
    expect(done).toMatchObject({ status: 'resolved', resolution: 'delete', resolvedBy: mod.handle });
    expect((await core.comms.message(line.id))?.removed).toEqual({ by: mod.handle });
    expect(await codeOf(core.reports.resolve(as(mod), report.id, 'dismiss', 'twice'))).toBe('REPORT_CLOSED');
    expect((await core.reports.list('resolved', { resolvedBy: mod.handle })).some((r) => r.id === report.id)).toBe(true);
    // resolvedBy is case-insensitive: typing the handle in a different case still finds it
    expect((await core.reports.list('resolved', { resolvedBy: mod.handle.toUpperCase() })).some((r) => r.id === report.id)).toBe(true);

    const reopened = await core.reports.reopen(as(mod), report.id, 'second look');
    expect(reopened).toMatchObject({ status: 'open', resolution: null, resolvedBy: null, resolvedAt: null });
    expect(await codeOf(core.reports.reopen(as(mod), report.id, 'again'))).toBe('REPORT_OPEN');
    const noted = await core.reports.addNote(as(mod), report.id, 'already removed; watching them');
    expect(noted.notes).toEqual([{ by: mod.handle, text: 'already removed; watching them', at: expect.any(String) }]);
    expect(await codeOf(core.reports.addNote(as(mod), report.id, ''))).toBe('BAD_NOTE');
    expect((await core.reports.list('open')).some((r) => r.id === report.id)).toBe(true);

    const line2 = await core.comms.post(bob, 'lobby', 'more spam');
    const report2 = await core.reports.create(reporter, line2.id, null);
    await core.reports.resolve(as(mod), report2.id, 'mute', 'keeps spamming', 30);
    expect(core.moderation.sanctionOf(bob.id)).toMatchObject({ kind: 'mute', reason: 'keeps spamming' });
    expect(await codeOf(core.reports.create(reporter, line2.id, 'still there'))).toBe('DUPLICATE_REPORT');
    expect(await codeOf(core.reports.get('r_nope'))).toBe('NO_REPORT');
  });

  test('resolving as mute or suspend without minutes is refused the same way a direct mute/suspend is', async () => {
    const mod = await staff('mod');
    const [reporter, bob] = [await person('rep'), await person('bob')];
    const directMute = await codeOf(core.moderation.mute(as(mod), bob.id, 'no minutes', undefined));
    expect(directMute).toBe('BAD_MINUTES');

    const line = await core.comms.post(bob, 'lobby', 'spam once more');
    const report = await core.reports.create(reporter, line.id, 'spam');
    expect(await codeOf(core.reports.resolve(as(mod), report.id, 'mute', 'no minutes'))).toBe(directMute);
    // The report must still be open: checkPower's own recursive call defaults a missing minutes to
    // 0, which would otherwise sail past the mute cap instead of being refused.
    expect((await core.reports.get(report.id)).status).toBe('open');

    const line2 = await core.comms.post(bob, 'lobby', 'and again');
    const report2 = await core.reports.create(reporter, line2.id, 'spam');
    expect(await codeOf(core.reports.resolve(as(mod), report2.id, 'suspend', 'no minutes'))).toBe('FORBIDDEN_ROLE');
  });

  test('house moderators are capped by the server', async () => {
    const house = await staff('mod', true);
    const [reporter, bob] = [await person('rep'), await person('bob')];
    const report = await core.reports.create(reporter, (await core.comms.post(bob, 'lobby', 'grr')).id, null);
    expect(await codeOf(core.reports.resolve(as(house), report.id, 'suspend', 'no', 10))).toBe('FORBIDDEN_ROLE');
    expect(await codeOf(core.reports.resolve(as(house), report.id, 'mute', 'no', 61))).toBe('FORBIDDEN_ROLE');
    expect((await core.reports.addNote(as(house), report.id, 'recommend a warning')).notes).toHaveLength(1);
    expect((await core.reports.resolve(as(house), report.id, 'mute', 'cool off', 60)).resolvedBy).toBe(house.handle);
    expect(await codeOf(core.reports.reopen(as(house), report.id, 'no'))).toBe('FORBIDDEN_ROLE');
  });

  test('suspended people cannot report', async () => {
    const admin = await staff('admin');
    const [ann, bob] = [await person('ann'), await person('bob')];
    const line = await core.comms.post(bob, 'lobby', 'hello');
    await core.moderation.suspend(as(admin), ann.id, 'timeout', 10);
    expect(await codeOf(core.reports.create(ann, line.id, null))).toBe('SUSPENDED');
  });
});
