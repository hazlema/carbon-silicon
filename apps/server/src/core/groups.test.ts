import { testDatabaseUrl } from '@cs/server/testing';
import { afterAll, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { fileURLToPath } from 'node:url';
import { groupChannel } from '@cs/shared/protocol';
import { groupBans } from '../db/schema';
import { FakeClock } from '../lib/clock';
import type { AppError } from '../lib/errors';
import { randomTag } from '../lib/testing';
import { createCore } from './core';
import { GroupManager, clampGroupMax } from './groups';

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

async function messageOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return (e as AppError).message;
  }
  throw new Error('expected a rejection');
}

describe('groups', () => {
  test('start: the starter owns it, everyone is a member, a system line opens it', async () => {
    const [ann, ben, cal] = [await person('ann'), await person('ben'), await person('cal')];
    const g = await core.groups.create(ann, [ben.handle, `@${cal.handle}`]);
    expect(g.ownerId).toBe(ann.id);
    expect(g.members.map((m) => m.identity.id).sort()).toEqual([ann.id, ben.id, cal.id].sort());
    expect(g.members.find((m) => m.owner)?.identity.id).toBe(ann.id);
    expect(g.maxMembers).toBe(8);
    expect(g.channel).toBe(groupChannel(g.id));
    const opening = (await core.comms.history(g.channel, { viewer: ann, limit: 5 })).find((m) => m.system);
    expect(opening?.text).toBe(`@${ann.handle} started a group with @${ben.handle} and @${cal.handle}.`);
    expect((await core.groups.list(ben)).map((x) => x.id)).toContain(g.id);
  });

  test('with: duplicates collapse, yourself is refused, released names and nobody are refused', async () => {
    const [ann, ben] = [await person('ann'), await person('ben')];
    const g = await core.groups.create(ann, [ben.handle, ben.handle]);
    expect(g.members).toHaveLength(2);
    const opening = (await core.comms.history(g.channel, { viewer: ann, limit: 5 })).find((m) => m.system);
    expect(opening?.text).toBe(`@${ann.handle} started a group with @${ben.handle}.`);
    expect(await codeOf(core.groups.create(ann, [ann.handle]))).toBe('SELF');
    expect(await codeOf(core.groups.create(ann, ['nobody_here_xyz']))).toBe('NO_USER');
    expect(await codeOf(core.groups.create(ann, []))).toBe('BAD_FIELD');
  });

  test('add: any member adds; the cap; already a member; blocks either way; the Bouncer', async () => {
    const [ann, ben, cal, dee] = [await person('ann'), await person('ben'), await person('cal'), await person('dee')];
    const g = await core.groups.create(ann, [ben.handle]);
    const after = await core.groups.add(ben, g.id, cal.handle);
    expect(after.members).toHaveLength(3);
    expect(await codeOf(core.groups.add(ann, g.id, cal.handle))).toBe('ALREADY_MEMBER');
    await core.relations.set(dee, ann.handle, 'block'); // dee blocks ann
    expect(await codeOf(core.groups.add(ann, g.id, dee.handle))).toBe('BLOCKED');
  });

  test('a group holds at most GROUP_MAX_MEMBERS people', async () => {
    const small = new GroupManager(core.database.db, clock, { comms: core.comms, identities: core.identities, relations: core.relations }, { maxMembers: 2 });
    const [ann, ben, cal] = [await person('ann'), await person('ben'), await person('cal')];
    const g = await small.create(ann, [ben.handle]);
    expect(await messageOf(small.add(ann, g.id, cal.handle))).toBe('This group is full (2 people).');
    expect(await codeOf(small.add(ann, g.id, cal.handle))).toBe('GROUP_FULL');
    expect(await codeOf(small.create(ann, [ben.handle, cal.handle]))).toBe('GROUP_FULL');
  });

  test('clampGroupMax: default 8, held to 2–50, nonsense warned about', () => {
    const warnings: string[] = [];
    const warn = (m: string) => void warnings.push(m);
    expect(clampGroupMax(undefined, warn)).toBe(8);
    expect(clampGroupMax('12', warn)).toBe(12);
    expect(clampGroupMax('1', warn)).toBe(2);
    expect(clampGroupMax('500', warn)).toBe(50);
    expect(clampGroupMax('lots', warn)).toBe(8);
    expect(warnings).toHaveLength(3);
  });

  test('rename: any member; 1–32 characters; slurs and profanity refused; a system line says who', async () => {
    const [ann, ben] = [await person('ann'), await person('ben')];
    const g = await core.groups.create(ann, [ben.handle]);
    expect((await core.groups.rename(ben, g.id, '  P0wn th3 mach1n3s ')).name).toBe('P0wn th3 mach1n3s');
    expect(await codeOf(core.groups.rename(ben, g.id, ''))).toBe('BAD_NAME');
    expect(await codeOf(core.groups.rename(ben, g.id, 'x'.repeat(33)))).toBe('BAD_NAME');
    expect(await codeOf(core.groups.rename(ben, g.id, 'shit crew'))).toBe('NAME_FILTERED');
    const lines = await core.comms.history(g.channel, { viewer: ann, limit: 10 });
    expect(lines.some((m) => m.system && m.text === `@${ben.handle} named this group "P0wn th3 mach1n3s".`)).toBe(true);
  });

  test('remove bans; re-adding is refused until un-ban; only the owner removes or un-bans', async () => {
    const [ann, ben, cal] = [await person('ann'), await person('ben'), await person('cal')];
    const g = await core.groups.create(ann, [ben.handle, cal.handle]);
    expect(await messageOf(core.groups.remove(ben, g.id, cal.handle))).toBe("Only the group's owner can do that.");
    expect(await codeOf(core.groups.remove(ben, g.id, cal.handle))).toBe('NOT_OWNER');
    await core.groups.remove(ann, g.id, cal.handle);
    expect((await core.groups.get(ann, g.id)).bans.map((b) => b.id)).toEqual([cal.id]);
    expect((await core.groups.get(ben, g.id)).bans).toEqual([]);
    expect(await codeOf(core.groups.get(cal, g.id))).toBe('NOT_MEMBER');
    expect(await messageOf(core.groups.add(ben, g.id, cal.handle))).toBe(`@${cal.handle} was removed from this group.`);
    expect(await codeOf(core.groups.add(ben, g.id, cal.handle))).toBe('GROUP_BANNED');
    expect(await codeOf(core.groups.unban(ben, g.id, cal.handle))).toBe('NOT_OWNER');
    await core.groups.unban(ann, g.id, cal.handle);
    expect((await core.groups.add(ben, g.id, cal.handle)).members).toHaveLength(3);
  });

  test('the owner leaves: the longest member owns it; the last one out ends it and its bans', async () => {
    const [ann, ben, cal, dee] = [await person('ann'), await person('ben'), await person('cal'), await person('dee')];
    const g = await core.groups.create(ann, [ben.handle]);
    clock.advance(1000);
    await core.groups.add(ann, g.id, cal.handle);
    await core.groups.add(ann, g.id, dee.handle);
    await core.groups.remove(ann, g.id, dee.handle); // dee banned
    await core.groups.remove(ann, g.id, ann.handle); // the owner leaves
    expect((await core.groups.get(ben, g.id)).ownerId).toBe(ben.id);
    const lines = await core.comms.history(g.channel, { viewer: ben, limit: 20 });
    expect(lines.some((m) => m.system && m.text === `@${ben.handle} is the owner now.`)).toBe(true);
    await core.groups.remove(cal, g.id, cal.handle);
    expect(await core.groups.remove(ben, g.id, ben.handle)).toBeNull(); // the last one out
    expect(await codeOf(core.groups.get(ben, g.id))).toBe('NO_GROUP');
    expect(await codeOf(core.groups.add(ben, g.id, dee.handle))).toBe('NO_GROUP');
    expect(await core.database.db.select().from(groupBans).where(eq(groupBans.groupId, g.id))).toEqual([]);
  });

  test('releasing a name takes it out of its groups', async () => {
    const [ann, ben] = [await person('ann'), await person('ben')];
    const g = await core.groups.create(ann, [ben.handle]);
    await core.groups.forget(ben.id);
    expect((await core.groups.get(ann, g.id)).members.map((m) => m.identity.id)).toEqual([ann.id]);
  });

  test('history: members only, from where they joined on; info counts what others said', async () => {
    const [ann, ben, cal] = [await person('ann'), await person('ben'), await person('cal')];
    const g = await core.groups.create(ann, [ben.handle]);
    await core.comms.postSystem(g.channel, 'before cal');
    await core.groups.add(ann, g.id, cal.handle);
    const texts = async (who: typeof ann) => (await core.comms.history(g.channel, { viewer: who, limit: 20 })).map((m) => m.text);
    expect((await texts(ben)).includes('before cal')).toBe(true);
    expect((await texts(cal)).includes('before cal')).toBe(false);
    expect(await codeOf(core.comms.history(g.channel, { viewer: await person('dee'), limit: 5 }))).toBe('NOT_MEMBER');
    expect(await codeOf(core.comms.history(g.channel, { limit: 5 }))).toBe('NOT_MEMBER');
    expect((await core.groups.read(ben, g.id)).unread).toBe(0);
  });

  test('the Bouncer (a house mod) is refused; a human moderator can be added', async () => {
    const [ann, ben] = [await person('ann'), await person('ben')];
    const bouncer = await core.identities.setRole((await core.identities.registerAgent({ name: `bouncer${randomTag()}` }, 'hk')).identity.id, 'mod');
    const human = await core.identities.setRole((await person('hm')).id, 'mod');
    const g = await core.groups.create(ann, [ben.handle]);
    expect(await codeOf(core.groups.add(ann, g.id, bouncer.handle))).toBe('HOUSE_AGENT');
    expect(await messageOf(core.groups.add(ann, g.id, bouncer.handle))).toBe('The Bouncer reads reports, not chats.');
    expect((await core.groups.add(ann, g.id, human.handle)).members).toHaveLength(3);
  });

  test('lines by someone you ignore stay hidden after they leave, and a page is still full', async () => {
    const [ann, ben, cal] = [await person('ann'), await person('ben'), await person('cal')];
    const g = await core.groups.create(ann, [ben.handle, cal.handle]);
    await core.relations.set(ann, ben.handle, 'ignore');
    const say = async (who: typeof ann, text: string) => {
      clock.advance(2100);
      return core.comms.post(who, g.channel, text);
    };
    await say(cal, 'visible one');
    for (let i = 0; i < 6; i++) await say(ben, `noise ${i}`);
    await say(cal, 'visible two');
    await core.groups.remove(ben, g.id, ben.handle); // the muted author leaves
    const page = await core.comms.history(g.channel, { viewer: ann, limit: 3 });
    expect(page).toHaveLength(3);
    expect(page.some((m) => m.text.startsWith('noise'))).toBe(false);
    expect(page.some((m) => m.text === 'visible two')).toBe(true);
    expect((await core.comms.history(g.channel, { viewer: ann, limit: 50 })).some((m) => m.text.startsWith('noise'))).toBe(false);
    expect((await core.comms.history(g.channel, { viewer: cal, limit: 50 })).some((m) => m.text.startsWith('noise'))).toBe(true);
  });
});
