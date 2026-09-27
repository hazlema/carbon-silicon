import { testDatabaseUrl } from '@cs/server/testing';
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
const core = await createCore({ databaseUrl: await testDatabaseUrl(), houseKey: 'hk', diaryDir: join(root, 'no-diary'), countdownMs: 0, houseFallbackMs: 60_000, sweepEveryMs: 0 });
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
// Used only by the later fix-round tests, kept out of `verdicts` so the main test's loop over
// `Object.keys(verdicts)` doesn't pick up an extra report it makes no assertions about.
const extraVerdicts: Record<string, Verdict | null> = {
  'mute me please (release test)': { action: 'mute', reason: 'spam', minutes: 30 },
};
/** Every call the running Bouncer makes to the judge, by the reported message's text — lets a
 *  test count how many times a given report was actually judged, across every sweep it sees. */
const judgeCalls: string[] = [];
/** A test may install a gate for one message's text before its report exists, to hold the stub's
 *  judge() call open once the Bouncer reaches it — `judgeCalls` having recorded the text is the
 *  signal that it's now waiting. This lets a test interleave a mutation (e.g. releasing the
 *  target) strictly between "the Bouncer started judging" and "the Bouncer acts on the verdict",
 *  instead of racing the background sweep loop on relative timing (which real Postgres, with its
 *  own network and query latency, does not resolve the same way PGlite's in-process reads do). */
const judgeGates = new Map<string, Promise<void>>();
const stub: Judge = {
  judge: async (r: ReportInfo) => {
    judgeCalls.push(r.snapshot.text);
    await judgeGates.get(r.snapshot.text);
    return verdicts[r.snapshot.text] ?? extraVerdicts[r.snapshot.text] ?? null;
  },
};
const logs: string[] = [];
const bouncerTokenFile = join(root, `.data/test-bots/${crypto.randomUUID()}.token`);
const done = runBouncer({
  base: running.url,
  houseKey: 'hk',
  tokenFile: bouncerTokenFile,
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

test('a report the Bouncer resolved carries a note, so reopening it and restarting the Bouncer does not re-judge it', async () => {
  const reporter = await human('rep');
  const author = await human('auth');
  const message = await core.comms.post(author, 'lobby', 'this one is fine');
  const report = await core.reports.create(reporter, message.id, 'again');
  await until(async () => (await core.reports.get(report.id)).status === 'resolved');
  expect((await core.reports.get(report.id)).notes.map((n) => [n.by, n.text])).toEqual([['Bouncer', 'dismissed: banter']]);

  // A human mod overrules the Bouncer's dismissal. `reopen` clears status/resolution/resolvedBy
  // but never touches notes. A human must lock their name before holding a role.
  const modHuman = (await core.accounts.lock(await human('mod'), 'correct horse battery')).identity;
  const mod = await core.moderation.setRole({ kind: 'console' }, modHuman.id, 'mod', 'test grant');
  await core.reports.reopen({ kind: 'identity', identity: mod }, report.id, 'double check');
  expect(await core.reports.get(report.id)).toMatchObject({ status: 'open', resolution: null, resolvedBy: null });

  // A restarted Bouncer process has an empty in-memory `handled` set. It reuses the same saved
  // token (the same identity), so only the note left behind above — untouched by the reopen —
  // can stop it from judging the report all over again.
  const restartController = new AbortController();
  const restartLogs: string[] = [];
  const restarted = runBouncer({
    base: running.url,
    houseKey: 'hk',
    tokenFile: bouncerTokenFile,
    judge: stub,
    pollWaitMs: 200,
    signal: restartController.signal,
    log: (m) => restartLogs.push(m),
  });
  try {
    // A correctly-behaving restart logs nothing at all here (it already has powers, and the one
    // open report already carries its note, so there is nothing new to say) — so there is no log
    // line to wait for. Give it several sweeps at pollWaitMs=200 instead.
    await Bun.sleep(900);
  } finally {
    restartController.abort();
    await restarted;
  }
  const untouched = await core.reports.get(report.id);
  expect(untouched.status).toBe('open');
  expect(untouched.notes).toHaveLength(1);
}, 15_000);

test('a resolve that permanently fails (not 401/429) is noted instead of retried, and does not block the rest of the sweep', async () => {
  const reporter = await human('rep');
  const gone = await human('auth');
  const text = 'mute me please (release test)';
  // Hold the Bouncer's judge() call open once it reaches this report, so the release below is
  // guaranteed to land before `decide` chooses to act and `resolve` calls `moderation.mute` —
  // instead of hoping this statement outruns the Bouncer's background sweep.
  let releaseGate!: () => void;
  judgeGates.set(text, new Promise((resolve) => (releaseGate = resolve)));
  const message = await core.comms.post(gone, 'lobby', text);
  const report = await core.reports.create(reporter, message.id, 'please look');
  await until(() => judgeCalls.includes(text)); // the Bouncer is now blocked on our gate

  // The target leaves before the Bouncer gets to the report: its mute call now hits a target
  // that `moderation.mute` rejects with 404 NO_USER, after `decide` already chose to act.
  await core.moderation.release({ kind: 'console' }, gone.id, 'left before the Bouncer got to it');
  releaseGate();
  judgeGates.delete(text);

  const nextAuthor = await human('auth');
  const nextMessage = await core.comms.post(nextAuthor, 'lobby', 'this one is fine');
  const nextReport = await core.reports.create(reporter, nextMessage.id, 'again');

  await until(async () => (await core.reports.get(report.id)).notes.length > 0);
  const failed = await core.reports.get(report.id);
  expect(failed.status).toBe('open'); // never resolved: the mute could never actually happen
  expect(failed.notes.map((n) => n.text)).toEqual(['escalate: could not act (NO_USER)']);

  // The queue kept moving in the same sweep: the next report is still handled.
  await until(async () => (await core.reports.get(nextReport.id)).status === 'resolved');
  expect(await core.reports.get(nextReport.id)).toMatchObject({ status: 'resolved', resolution: 'dismiss' });
  expect(judgeCalls.filter((t) => t === 'mute me please (release test)')).toHaveLength(1);

  // The note is this report's durable mark: further sweeps never judge it again.
  await Bun.sleep(700);
  expect((await core.reports.get(report.id)).notes).toHaveLength(1);
  expect(judgeCalls.filter((t) => t === 'mute me please (release test)')).toHaveLength(1);
}, 15_000);

test('a suspended Bouncer says so and waits (it has its role, not its powers); lifted, it works again', async () => {
  const bouncer = (await core.identities.getByHandle('Bouncer'))!;
  const grantHints = logs.filter((l) => l.includes('grant-mod')).length;
  await core.moderation.suspend({ kind: 'console' }, bouncer.id, 'test suspension', 60);

  // While suspended, a new report wakes it; it notices it's suspended and does not act.
  const reporter = await human('rep');
  const message = await core.comms.post(await human('auth'), 'lobby', 'this one is fine');
  const report = await core.reports.create(reporter, message.id, 'while suspended');
  await until(() => logs.some((l) => l.includes('suspended — waiting')));
  expect(logs.filter((l) => l.includes('grant-mod'))).toHaveLength(grantHints);
  await Bun.sleep(600); // a few more sweeps: still one line, and the report untouched
  expect(logs.filter((l) => l.includes('suspended — waiting'))).toHaveLength(1);
  expect(await core.reports.get(report.id)).toMatchObject({ status: 'open', notes: [] });

  await core.moderation.lift({ kind: 'console' }, bouncer.id, 'test over');
  await until(async () => (await core.reports.get(report.id)).status === 'resolved');
  expect(logs.filter((l) => l.includes('grant-mod'))).toHaveLength(grantHints);
}, 15_000);
