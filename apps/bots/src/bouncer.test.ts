import { afterAll, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ReportInfo } from '@cs/shared/protocol';
import { createCore } from '@cs/server/core';
import { createApp } from '@cs/server/http';
import { startServer } from '@cs/server/server';
import { decide, runBouncer } from './bouncer';
import type { Judge, Verdict } from './judge';

describe('decide', () => {
  test('only dismiss, delete and short mutes become actions', () => {
    expect(decide({ action: 'dismiss', reason: 'banter' })).toEqual({ resolve: 'dismiss', reason: 'banter' });
    expect(decide({ action: 'delete', reason: 'threat' })).toEqual({ resolve: 'delete', reason: 'threat' });
    expect(decide({ action: 'mute', reason: 'spam', minutes: 90 })).toEqual({ resolve: 'mute', reason: 'spam', minutes: 60 });
    expect(decide({ action: 'escalate', reason: 'unsure' })).toEqual({ note: 'escalate: unsure' });
    expect(decide({ action: 'suspend', reason: 'bad' } as unknown as Verdict)).toEqual({ note: 'escalate: bad' });
    expect(decide(null)).toEqual({ note: 'no opinion' });
  });
});

const root = fileURLToPath(new URL('../../../', import.meta.url));
const core = await createCore({ databaseUrl: 'pglite:memory', houseKey: 'hk', diaryDir: join(root, 'no-diary'), countdownMs: 0, houseFallbackMs: 60_000, sweepEveryMs: 0 });
const running = startServer(core, createApp(core, { apiDocs: '', llmsTxt: '', trustProxy: true }), { port: 0, hostname: '127.0.0.1', webDir: null, allowedOrigins: [] });
const controller = new AbortController();
afterAll(async () => {
  controller.abort();
  await done;
  await running.stop();
  await core.close();
});

const verdicts: Record<string, Verdict | null> = {
  'this one is fine': { action: 'dismiss', reason: 'banter' },
  'delete me please': { action: 'delete', reason: 'over the line' },
  'mute me please': { action: 'mute', reason: 'spam', minutes: 90 },
  'suspend me please': { action: 'suspend', reason: 'repeat offender' } as unknown as Verdict,
  'garbage please': null,
};
const stub: Judge = { judge: async (r: ReportInfo) => verdicts[r.snapshot.text] ?? null };
const logs: string[] = [];
const done = runBouncer({
  base: running.url,
  houseKey: 'hk',
  tokenFile: join(root, `.data/test-bots/${crypto.randomUUID()}.token`),
  judge: stub,
  pollWaitMs: 200,
  signal: controller.signal,
  log: (m) => logs.push(m),
});

const tag = () => String(Math.floor(Math.random() * 1e9)).padStart(9, '0');
async function until(check: () => boolean | Promise<boolean>, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await Bun.sleep(25);
  }
  throw new Error('timed out');
}
const human = async (prefix: string) => (await core.identities.createHuman(`${prefix}${tag()}`, { label: 'test', ip: null })).identity;

test('the Bouncer waits for its powers, then works the queue within its limits', async () => {
  await until(() => logs.some((l) => l.includes('no powers yet')));
  const bouncer = (await core.identities.getByHandle('Bouncer'))!;
  expect(bouncer.isHouse).toBe(true);
  expect(core.presence.get(bouncer.id)?.status).toBe('afk'); // never picked as a quick-match opponent

  const reporter = await human('rep');
  const reports: Record<string, { report: ReportInfo; authorId: string; messageId: number }> = {};
  for (const text of Object.keys(verdicts)) {
    const author = await human('auth');
    const message = await core.comms.post(author, 'lobby', text);
    reports[text] = { report: await core.reports.create(reporter, message.id, 'please look'), authorId: author.id, messageId: message.id };
  }

  await core.moderation.setRole({ kind: 'console' }, bouncer.id, 'mod', 'test grant');
  const get = (text: string) => core.reports.get(reports[text].report.id);
  await until(async () => {
    const all = await Promise.all(Object.keys(verdicts).map(get));
    return all.every((r) => r.status === 'resolved' || r.notes.length > 0);
  });

  expect(await get('this one is fine')).toMatchObject({ status: 'resolved', resolution: 'dismiss', resolvedBy: 'Bouncer' });
  expect(await get('delete me please')).toMatchObject({ status: 'resolved', resolution: 'delete', resolvedBy: 'Bouncer' });
  expect((await core.comms.message(reports['delete me please'].messageId))?.removed).toEqual({ by: 'Bouncer' });

  expect(await get('mute me please')).toMatchObject({ status: 'resolved', resolution: 'mute' });
  const mute = core.moderation.sanctionOf(reports['mute me please'].authorId)!;
  expect(mute.kind).toBe('mute');
  expect(Date.parse(mute.endsAt!) - Date.parse(mute.since)).toBe(60 * 60_000);

  const escalated = await get('suspend me please');
  expect(escalated.status).toBe('open');
  expect(escalated.notes.map((n) => [n.by, n.text])).toEqual([['Bouncer', 'escalate: repeat offender']]);
  expect(core.moderation.sanctionOf(reports['suspend me please'].authorId)).toBeNull();

  const shrug = await get('garbage please');
  expect(shrug.status).toBe('open');
  expect(shrug.notes.map((n) => n.text)).toEqual(['no opinion']);

  // A fresh report makes it sweep the queue again; the two open reports are not noted twice.
  const late = await core.comms.post(await human('late'), 'lobby', 'this one is fine');
  const lateReport = await core.reports.create(reporter, late.id, 'again');
  await until(async () => (await core.reports.get(lateReport.id)).status === 'resolved');
  expect((await get('suspend me please')).notes).toHaveLength(1);
  expect((await get('garbage please')).notes).toHaveLength(1);
  expect(logs.filter((l) => l.includes('no powers yet'))).toHaveLength(1);
});
