import { testDatabaseUrl } from '@cs/server/testing';
import { afterAll, describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import type { InboxEvent } from '@cs/shared/protocol';
import { FakeClock } from '../lib/clock';
import type { AppError } from '../lib/errors';
import { randomTag } from '../lib/testing';
import { createCore } from './core';
import type { Actor } from './powers';

const diaryDir = fileURLToPath(new URL('../__fixtures__/diary', import.meta.url));
const clock = new FakeClock();
const core = await createCore({ databaseUrl: await testDatabaseUrl(), clock, houseKey: 'hk', diaryDir, countdownMs: 0, houseFallbackMs: 60_000, sweepEveryMs: 0 });
afterAll(() => core.close());

const meta = { label: 'test', ip: null };
const PASSWORD = 'correct horse battery';
const CONSOLE: Actor = { kind: 'console' };
const person = async (prefix = 'p') => (await core.identities.createHuman(`${prefix}${randomTag()}`, meta)).identity;
const locked = async (prefix = 'own') => (await core.accounts.lock(await person(prefix), PASSWORD)).identity;
const agent = (prefix = 'bot') => core.identities.registerAgent({ name: `${prefix}${randomTag()}` }, null);
const events = async (id: string): Promise<InboxEvent[]> => (await core.comms.poll(id, 0, 0)).events;
async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return (e as AppError).code;
  }
  throw new Error('expected a rejection');
}

describe('linking', () => {
  test('a locked human links an agent by its token; the agent shows its owner and hears about it once', async () => {
    const owner = await locked();
    const { identity: bot, token } = await agent();
    const summary = await core.owners.link(owner, `  ${token}\n`);
    expect(summary.identity.ownerHandle).toBe(owner.handle);
    expect(summary).toMatchObject({ status: 'offline', sanction: null, record: { versus: 'humans', played: 0 } });
    expect((await core.identities.get(bot.id))?.ownerHandle).toBe(owner.handle);
    expect((await core.owners.agents(owner.id)).map((a) => a.identity.id)).toEqual([bot.id]);
    await core.owners.link(owner, token); // again: harmless, and nothing new to tell
    const told = (await events(bot.id)).filter((e) => e.type === 'owner.changed');
    expect(told).toMatchObject([{ owner: { id: owner.id } }]);
  });

  test('refusals: guests, wrong tokens, human keys, house bots, someone else\'s agent', async () => {
    const [owner, other, guest] = [await locked(), await locked('other'), await person('guest')];
    const { token } = await agent();
    const house = await core.identities.registerAgent({ name: `house${randomTag()}` }, 'hk');
    const { key } = await core.identities.createHuman(`key${randomTag()}`, meta);
    expect(await codeOf(core.owners.link(guest, token))).toBe('NOT_LOCKED');
    expect(await codeOf(core.owners.link(owner, 'cs_nope'))).toBe('BAD_TOKEN');
    expect(await codeOf(core.owners.link(owner, 42))).toBe('BAD_TOKEN');
    expect(await codeOf(core.owners.link(owner, key))).toBe('BAD_TOKEN'); // a browser key is not an agent's token
    expect(await codeOf(core.owners.link(owner, house.token))).toBe('HOUSE_AGENT');
    await core.owners.link(other, token);
    expect(await codeOf(core.owners.link(owner, token))).toBe('OWNED');
  });

  test('a suspended human cannot link an agent; a muted one can', async () => {
    const [suspended, muted] = [await locked('susp'), await locked('mute')];
    await core.moderation.suspend(CONSOLE, suspended.id, 'time out', 60);
    await core.moderation.mute(CONSOLE, muted.id, 'shouting', 60);
    expect(await codeOf(core.owners.link(suspended, (await agent()).token))).toBe('SUSPENDED');
    expect((await core.owners.link(muted, (await agent()).token)).identity.ownerHandle).toBe(muted.handle);
  });
});

describe('unlinking', () => {
  test('the owner or the agent unlinks; nobody else can', async () => {
    const [owner, stranger] = [await locked(), await locked('str')];
    const { identity: bot, token } = await agent();
    await core.owners.link(owner, token);
    expect(await codeOf(core.owners.unlink(stranger, bot.handle))).toBe('NOT_YOURS');
    expect(await core.owners.unlink(owner, `@${bot.handle}`)).toEqual([]);
    expect((await core.identities.get(bot.id))?.ownerHandle).toBeNull();
    expect((await events(bot.id)).filter((e) => e.type === 'owner.changed').at(-1)).toMatchObject({ owner: null });

    await core.owners.link(owner, token);
    const dropped = await core.owners.drop((await core.identities.get(bot.id))!);
    expect(dropped.ownerHandle).toBeNull();
    expect((await events(bot.id)).filter((e) => e.type === 'owner.changed').at(-1)).toMatchObject({ owner: null });
    expect(await codeOf(core.owners.drop(dropped))).toBe('NO_OWNER');
  });

  test('releasing the owner frees its agents; a released agent leaves the list', async () => {
    const owner = await locked();
    const [one, two] = [await agent('one'), await agent('two')];
    await core.owners.link(owner, one.token);
    await core.owners.link(owner, two.token);
    await core.accounts.release(two.identity.id);
    expect((await core.owners.agents(owner.id)).map((a) => a.identity.id)).toEqual([one.identity.id]);
    await core.accounts.release(owner.id);
    expect((await core.identities.get(one.identity.id))?.ownerHandle).toBeNull();
    expect((await events(one.identity.id)).filter((e) => e.type === 'owner.changed').at(-1)).toMatchObject({ owner: null });
  });
});

describe('the owner hears about moderation', () => {
  test('mute, lift and a removed message reach the owner; the summary shows the sanction', async () => {
    const owner = await locked();
    const { identity: bot, token } = await agent();
    await core.owners.link(owner, token);
    await core.moderation.mute(CONSOLE, bot.id, 'spam', 10);
    expect((await core.owners.agents(owner.id))[0].sanction).toMatchObject({ kind: 'mute' });
    await core.moderation.lift(CONSOLE, bot.id, 'fine now');
    clock.advance(2100);
    const line = await core.comms.post(bot, 'lobby', 'buy my stuff');
    await core.moderation.deleteMessage(CONSOLE, line.id, 'advertising');
    const told = (await events(owner.id)).filter((e) => e.type === 'moderation.agent');
    expect(told.map((e) => [e.kind, e.reason, e.agent.id])).toEqual([
      ['mute', 'spam', bot.id],
      ['lift', 'fine now', bot.id],
      ['removed', 'advertising', bot.id],
    ]);
    expect(told[0].endsAt).not.toBeNull();
  });

  test('an agent without an owner, or a human, tells nobody extra', async () => {
    const { identity: loner } = await agent('loner');
    const human = await person('h');
    await core.moderation.mute(CONSOLE, loner.id, 'x', 5);
    await core.moderation.mute(CONSOLE, human.id, 'x', 5);
    // Only the targets themselves heard (the existing `moderation` event); no moderation.agent anywhere.
    for (const id of [loner.id, human.id]) {
      expect((await events(id)).some((e) => e.type === 'moderation.agent')).toBe(false);
    }
  });
});
