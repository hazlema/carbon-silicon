import { testDatabaseUrl } from '@cs/server/testing';
import { afterAll, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { fileURLToPath } from 'node:url';
import { dmChannel, type IdentityPublic } from '@cs/shared/protocol';
import { dmState } from '../db/schema';
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
const person = async (prefix = 'p') => (await core.identities.createHuman(`${prefix}${randomTag()}`, meta)).identity;
async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return (e as AppError).code;
  }
  throw new Error('expected a rejection');
}
/** Posts go through the flood limit: move the clock so a test can send as many as it likes. */
async function send(from: IdentityPublic, to: IdentityPublic, text: string) {
  clock.advance(2100);
  return core.dms.send(from, to.handle, text);
}
const summaryOf = async (me: IdentityPublic, other: IdentityPublic) => (await core.dms.list(me)).find((d) => d.with.id === other.id);

describe('conversations', () => {
  test('unread counts the other person\'s lines; reading clears it everywhere; your own lines are read', async () => {
    const [ada, bob] = [await person('ada'), await person('bob')];
    await send(ada, bob, 'one');
    const second = await send(ada, bob, 'two');
    expect(await summaryOf(bob, ada)).toMatchObject({ unread: 2, hidden: false, channel: dmChannel(ada.id, bob.id), last: { id: second.id } });
    expect(await summaryOf(ada, bob)).toMatchObject({ unread: 0 });

    const read = await core.dms.read(bob, ada.handle);
    expect(read.unread).toBe(0);
    const events = (await core.comms.poll(bob.id, 0, 0)).events;
    expect(events.some((e) => e.type === 'dm.read' && e.channel === read.channel)).toBe(true);
  });

  test('closing hides the tab until the next message; your own send reopens it too', async () => {
    const [ada, bob] = [await person('ada'), await person('bob')];
    await send(ada, bob, 'hello');
    expect((await core.dms.close(bob, ada.handle)).hidden).toBe(true);
    await send(ada, bob, 'you there?');
    expect(await summaryOf(bob, ada)).toMatchObject({ hidden: false, unread: 2 });
    await core.dms.close(ada, bob.handle);
    await send(ada, bob, 'never mind');
    expect((await summaryOf(ada, bob))?.hidden).toBe(false);
  });

  test('the list is newest first and history pages backwards', async () => {
    const [ada, bob, cy] = [await person('ada'), await person('bob'), await person('cy')];
    await send(bob, ada, 'from bob');
    await send(cy, ada, 'from cy');
    expect((await core.dms.list(ada)).map((d) => d.with.id)).toEqual([cy.id, bob.id]);
    const lines = [];
    for (let i = 0; i < 3; i++) lines.push(await send(ada, bob, `n${i}`));
    const page = await core.dms.history(ada, bob.handle, lines[2].id);
    expect(page.with.id).toBe(bob.id);
    expect(page.messages.map((m) => m.text)).toEqual(['from bob', 'n0', 'n1']);
  });

  test('reading or closing a conversation with no messages yet does not add it to your list', async () => {
    const [ada, bob, cy] = [await person('ada'), await person('bob'), await person('cy')];
    expect((await core.dms.read(ada, bob.handle)).unread).toBe(0);
    expect((await core.dms.close(ada, cy.handle)).with.id).toBe(cy.id);
    expect(await summaryOf(ada, bob)).toBeUndefined();
    expect(await summaryOf(ada, cy)).toBeUndefined();
  });
});

describe('who may write', () => {
  test('not yourself, not a name that is not here', async () => {
    const ada = await person('ada');
    expect(await codeOf(core.dms.send(ada, ada.handle, 'me'))).toBe('SELF');
    expect(await codeOf(core.dms.send(ada, `nobody${randomTag()}`, 'hi'))).toBe('NO_USER');
  });

  test('a block stops DMs both ways, with the right message for each side', async () => {
    const [ada, bob] = [await person('ada'), await person('bob')];
    await send(ada, bob, 'hi');
    await core.relations.set(bob, ada.handle, 'block');
    let e: AppError | null = null;
    try {
      await send(ada, bob, 'hello?');
    } catch (x) {
      e = x as AppError;
    }
    expect(e?.code).toBe('BLOCKED');
    expect(e?.message).toBe(`@${bob.handle} isn't taking messages from you.`);
    try {
      await send(bob, ada, 'sorry');
    } catch (x) {
      e = x as AppError;
    }
    expect(e?.message).toBe(`You block @${ada.handle}. Unblock them to message them.`);
    await core.relations.clear(bob, ada.handle, 'block');
    expect((await send(ada, bob, 'again')).text).toBe('again');
  });

  test('an ignored author is stored but not delivered: no chat.dm, no unread, the conversation leaves the list', async () => {
    const [ada, bob] = [await person('ada'), await person('bob')];
    await send(ada, bob, 'first');
    await core.dms.close(bob, ada.handle);
    await core.relations.set(bob, ada.handle, 'ignore');
    const before = (await core.comms.poll(bob.id, 0, 0)).cursor;
    const m = await send(ada, bob, 'can you hear me');
    expect(m.text).toBe('can you hear me');
    const later = (await core.comms.poll(bob.id, before, 0)).events;
    expect(later.some((e) => e.type === 'chat.dm')).toBe(false);
    expect(await summaryOf(bob, ada)).toBeUndefined();
    const [row] = await core.database.db.select().from(dmState).where(eq(dmState.identityId, bob.id));
    expect(row.hidden).toBe(true); // the ignored line did not reopen the tab
  });

  test('a muted person cannot send DMs', async () => {
    const [ada, bob] = [await person('ada'), await person('bob')];
    await core.moderation.mute({ kind: 'console' }, ada.id, 'shouting', 10);
    expect(await codeOf(send(ada, bob, 'let me out'))).toBe('MUTED');
  });

  test('releasing a name forgets its side of every conversation; nobody can write to it', async () => {
    const [ada, bob] = [await person('ada'), await person('bob')];
    await send(ada, bob, 'bye');
    await core.accounts.release(bob.id);
    expect(await core.database.db.select().from(dmState).where(eq(dmState.identityId, bob.id))).toEqual([]);
    expect(await codeOf(core.comms.post(ada, dmChannel(ada.id, bob.id), 'hello?'))).toBe('NO_USER');
  });

  test('a conversation with a released name leaves the other person\'s list', async () => {
    const [ada, bob] = [await person('ada'), await person('bob')];
    await send(ada, bob, 'see you');
    expect(await summaryOf(ada, bob)).toBeDefined();
    await core.accounts.release(bob.id);
    expect(await summaryOf(ada, bob)).toBeUndefined();
  });
});

describe('reports', () => {
  test('only the two can report a DM line; to anyone else it does not exist', async () => {
    const [ada, bob, cy] = [await person('ada'), await person('bob'), await person('cy')];
    const m = await send(ada, bob, 'rude words');
    expect(await codeOf(core.reports.create(cy, m.id, 'nosy'))).toBe('NO_MESSAGE');
    const report = await core.reports.create(bob, m.id, 'rude');
    expect(report.snapshot.channel).toBe(dmChannel(ada.id, bob.id));
  });

  test('a mod can delete a DM line only once it is reported', async () => {
    const [ada, bob] = [await person('ada'), await person('bob')];
    const mod = { kind: 'identity', identity: await core.identities.setRole((await person('mod')).id, 'mod') } satisfies Actor;
    const quiet = await send(ada, bob, 'just between us');
    expect(await codeOf(core.moderation.deleteMessage(mod, quiet.id, 'curious'))).toBe('NO_MESSAGE');
    expect((await core.comms.message(quiet.id))?.removed).toBeNull();

    const rude = await send(ada, bob, 'rude words');
    const report = await core.reports.create(bob, rude.id, 'rude');
    await core.reports.resolve(mod, report.id, 'delete', 'not ok');
    expect((await core.comms.message(rude.id))?.removed).toEqual({ by: mod.identity.handle });
  });
});
