import { testDatabaseUrl } from '@cs/server/testing';
import { afterAll, describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import type { IdentityPublic } from '@cs/shared/protocol';
import { FakeClock } from '../lib/clock';
import type { AppError } from '../lib/errors';
import { randomTag } from '../lib/testing';
import { createCore } from './core';
import { ModerationManager } from './moderation';
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
const PASSWORD = 'correct horse battery';
const CONSOLE: Actor = { kind: 'console' };
const as = (identity: IdentityPublic): Actor => ({ kind: 'identity', identity });
const signUp = (prefix = 'p') => core.identities.createHuman(`${prefix}${randomTag()}`, meta);
const person = async (prefix = 'p') => (await signUp(prefix)).identity;
const locked = async (prefix = 'lk') => (await core.accounts.lock(await person(prefix), PASSWORD)).identity;
async function staff(role: 'mod' | 'admin', house = false): Promise<IdentityPublic> {
  const base = house ? (await core.identities.registerAgent({ name: `bouncer${randomTag()}` }, 'hk')).identity : await locked(role);
  return core.identities.setRole(base.id, role);
}
async function agent(): Promise<IdentityPublic> {
  const a = (await core.identities.registerAgent({ name: `bot${randomTag()}` }, null)).identity;
  core.presence.agentSeen(a);
  return a;
}
async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return (e as AppError).code;
  }
  throw new Error('expected a rejection');
}

describe('suspension and mute at the checkpoint', () => {
  test('a suspension resigns a live match, tells the player, and makes them read-only', async () => {
    const admin = await staff('admin');
    const p = await person('sus');
    const bot = await agent();
    core.presence.humanConnected(p);
    const match = await core.games.createMatch('critical-mass', [p, bot]);
    clock.advance(1);

    const sanction = await core.moderation.suspend(as(admin), p.id, 'spamming the lobby', 60);
    expect(sanction).toMatchObject({ kind: 'suspend', reason: 'spamming the lobby' });
    expect(core.games.summary(match.id).status).toBe('over');
    expect(core.games.activeMatchOf(p.id)).toBeNull();
    const inbox = await core.comms.poll(p.id, 0, 0);
    expect(inbox.events.find((e) => e.type === 'moderation')).toMatchObject({ kind: 'suspend', reason: 'spamming the lobby' });

    expect(await codeOf(core.comms.post(p, 'lobby', 'let me back in'))).toBe('SUSPENDED');
    expect(await codeOf(core.invites.quickMatch(p, 'critical-mass'))).toBe('SUSPENDED');
    expect(await codeOf(core.accounts.setBio(p, 'reformed'))).toBe('SUSPENDED');

    // A match started for them anyway can be resigned, never played.
    const again = await core.games.createMatch('critical-mass', [p, bot]);
    clock.advance(1);
    const revision = core.games.summary(again.id).revision;
    expect(await codeOf(core.games.move(again.id, p, revision, { cell: 'a1' }))).toBe('SUSPENDED');
    expect((await core.games.resign(again.id, p)).match.status).toBe('over');
  });

  test('a suspension takes a queued player out of the queue', async () => {
    const mod = await staff('mod');
    const q = await person('queued');
    core.presence.humanConnected(q);
    expect(await core.invites.quickMatch(q, 'critical-mass')).toEqual({ status: 'queued' });
    await core.moderation.suspend(as(mod), q.id, 'abusive table talk', 30);
    expect(core.invites.queuedFor(q.id)).toBeNull();
  });

  test('sanctions end on their own when their time passes', async () => {
    const mod = await staff('mod');
    const p = await person('mute');
    await core.moderation.mute(as(mod), p.id, 'cool off', 5);
    expect(core.moderation.sanctionOf(p.id)).toMatchObject({ kind: 'mute', reason: 'cool off' });
    expect(await codeOf(core.comms.post(p, 'lobby', 'still here'))).toBe('MUTED');
    core.presence.humanConnected(p);
    expect((await core.invites.quickMatch(p, 'critical-mass')).status).toBe('queued'); // a mute never stops play
    core.invites.leave(p.id);

    clock.advance(5 * 60_000);
    expect(core.moderation.sanctionOf(p.id)).toBeNull();
    expect((await core.comms.post(p, 'lobby', 'back again')).text).toBe('back again');

    await core.moderation.suspend(as(mod), p.id, 'again', 10);
    clock.advance(10 * 60_000);
    expect(core.moderation.sanctionOf(p.id)).toBeNull();
    expect((await core.comms.post(p, 'lobby', 'and back')).text).toBe('and back');
  });

  test('a lift ends a sanction early and says so', async () => {
    const mod = await staff('mod');
    const p = await person('lift');
    await core.moderation.suspend(as(mod), p.id, 'heated', 60);
    await core.moderation.lift(as(mod), p.id, 'apologised');
    expect(core.moderation.sanctionOf(p.id)).toBeNull();
    expect((await core.comms.post(p, 'lobby', 'thanks')).text).toBe('thanks');
    const kinds = (await core.comms.poll(p.id, 0, 0)).events.flatMap((e) => (e.type === 'moderation' ? [e.kind] : []));
    expect(kinds).toEqual(['suspend', 'lift']);
    expect(await codeOf(core.moderation.lift(as(mod), p.id, 'again'))).toBe('NOT_SANCTIONED');
  });

  test('a new sanction of the same kind replaces the old one', async () => {
    const mod = await staff('mod');
    const p = await person('twice');
    await core.moderation.mute(as(mod), p.id, 'first', 600);
    await core.moderation.mute(as(mod), p.id, 'second', 5);
    expect(core.moderation.sanctionOf(p.id)?.reason).toBe('second');
    clock.advance(5 * 60_000);
    expect(core.moderation.sanctionOf(p.id)).toBeNull();
  });

  test('active sanctions and IP bans survive a restart', async () => {
    const admin = await staff('admin');
    const p = await person('restart');
    await core.moderation.suspend(as(admin), p.id, 'long one', null);
    await core.moderation.banIp(as(admin), '198.51.100.23', 'botnet');
    const again = new ModerationManager(core.database.db, core.bus, clock, {
      identities: core.identities,
      accounts: core.accounts,
      profiles: core.profiles,
      comms: core.comms,
      games: core.games,
      invites: core.invites,
      tables: core.tables,
    });
    await again.load();
    expect(again.sanctionOf(p.id)).toEqual(core.moderation.sanctionOf(p.id));
    expect(again.sanctionOf(p.id)?.endsAt).toBeNull();
    expect(again.isIpBanned('198.51.100.23')).toBe(true);
  });
});

describe('imposer rank: only equal or senior can shorten, replace or lift', () => {
  // 'a new sanction of the same kind replaces the old one' (above, same-rank actor both times)
  // already covers the equal-rank case; it stays valid unchanged under the new rank check.

  test('a house mod cannot replace a human mod\'s mute', async () => {
    const mod = await staff('mod');
    const house = await staff('mod', true);
    const p = await person('housecap');
    await core.moderation.mute(as(mod), p.id, 'human mod sets it', 600);
    expect(await codeOf(core.moderation.mute(as(house), p.id, 'house tries to downgrade', 5))).toBe('FORBIDDEN_ROLE');
    expect(core.moderation.sanctionOf(p.id)?.reason).toBe('human mod sets it');
  });

  test('a mod cannot replace or lift a suspension an admin imposed', async () => {
    const admin = await staff('admin');
    const mod = await staff('mod');
    const p = await person('senior');
    await core.moderation.suspend(as(admin), p.id, 'admin sets it', null);
    expect(await codeOf(core.moderation.suspend(as(mod), p.id, 'mod tries to shorten', 60))).toBe('FORBIDDEN_ROLE');
    expect(await codeOf(core.moderation.lift(as(mod), p.id, 'mod tries to lift'))).toBe('FORBIDDEN_ROLE');
    expect(core.moderation.sanctionOf(p.id)?.reason).toBe('admin sets it');
  });

  test('an admin can lift a mod\'s suspension', async () => {
    const mod = await staff('mod');
    const admin = await staff('admin');
    const p = await person('adminlifts');
    await core.moderation.suspend(as(mod), p.id, 'mod sets it', 60);
    await core.moderation.lift(as(admin), p.id, 'admin lifts it');
    expect(core.moderation.sanctionOf(p.id)).toBeNull();
  });

  test('the console can replace or lift anything', async () => {
    const admin = await staff('admin');
    const p = await person('console');
    await core.moderation.suspend(as(admin), p.id, 'admin sets it', null);
    const replaced = await core.moderation.suspend(CONSOLE, p.id, 'console overrides', 10);
    expect(replaced.reason).toBe('console overrides');
    await core.moderation.lift(CONSOLE, p.id, 'console lifts it');
    expect(core.moderation.sanctionOf(p.id)).toBeNull();
  });

  test('the imposer rank survives a restart', async () => {
    const admin = await staff('admin');
    const mod = await staff('mod');
    const p = await person('restartrank');
    await core.moderation.suspend(as(admin), p.id, 'admin sets it', null);
    const again = new ModerationManager(core.database.db, core.bus, clock, {
      identities: core.identities,
      accounts: core.accounts,
      profiles: core.profiles,
      comms: core.comms,
      games: core.games,
      invites: core.invites,
      tables: core.tables,
    });
    await again.load();
    expect(await codeOf(again.lift(as(mod), p.id, 'mod tries after restart'))).toBe('FORBIDDEN_ROLE');
  });
});

describe('the power table, enforced by the manager', () => {
  test('ranks, limits and inputs are checked', async () => {
    const mod = await staff('mod');
    const admin = await staff('admin');
    const house = await staff('mod', true);
    const plain = await person('plain');
    const p = await person('target');
    expect(await codeOf(core.moderation.suspend(as(plain), p.id, 'nope', 5))).toBe('FORBIDDEN_ROLE');
    expect(await codeOf(core.moderation.suspend(as(mod), admin.id, 'nope', 5))).toBe('FORBIDDEN_ROLE');
    expect(await codeOf(core.moderation.suspend(as(mod), p.id, 'too long', 10_081))).toBe('FORBIDDEN_ROLE');
    expect(await codeOf(core.moderation.suspend(as(mod), p.id, 'forever', undefined))).toBe('FORBIDDEN_ROLE');
    expect(await codeOf(core.moderation.mute(as(house), p.id, 'too long', 61))).toBe('FORBIDDEN_ROLE');
    expect(await codeOf(core.moderation.suspend(as(house), p.id, 'no', 5))).toBe('FORBIDDEN_ROLE');
    expect(await codeOf(core.moderation.mute(as(mod), p.id, '   ', 5))).toBe('BAD_REASON');
    expect(await codeOf(core.moderation.mute(as(mod), p.id, 'x'.repeat(301), 5))).toBe('BAD_REASON');
    expect(await codeOf(core.moderation.mute(as(mod), p.id, 'why', 0))).toBe('BAD_MINUTES');
    expect(await codeOf(core.moderation.mute(as(mod), p.id, 'why', 1.5))).toBe('BAD_MINUTES');
    expect(await codeOf(core.moderation.mute(as(mod), p.id, 'why', undefined))).toBe('BAD_MINUTES');
    expect(await codeOf(core.moderation.mute(as(mod), 'id_nobody', 'why', 5))).toBe('NO_USER');
    expect((await core.moderation.mute(as(house), p.id, 'an hour', 60)).kind).toBe('mute');
    expect((await core.moderation.suspend(as(admin), p.id, 'for good', undefined)).endsAt).toBeNull();
  });

  test('roles need a locked human (or an agent for mod); only the console makes admins', async () => {
    const admin = await staff('admin');
    const guest = await person('guest');
    const lockedOne = await locked('lockd');
    const bot = await agent();
    expect(await codeOf(core.moderation.setRole(as(admin), guest.id, 'mod', 'helper'))).toBe('NOT_LOCKED');
    expect(await codeOf(core.moderation.setRole(as(admin), lockedOne.id, 'admin', 'boss'))).toBe('FORBIDDEN_ROLE');
    expect(await codeOf(core.moderation.setRole(as(admin), lockedOne.id, 'emperor', 'x'))).toBe('BAD_ROLE');
    expect((await core.moderation.setRole(as(admin), lockedOne.id, 'mod', 'helper')).role).toBe('mod');
    expect((await core.identities.get(lockedOne.id))?.role).toBe('mod');
    expect((await core.moderation.setRole(as(admin), bot.id, 'mod', 'bouncer duty')).role).toBe('mod');
    expect(await codeOf(core.moderation.setRole(CONSOLE, bot.id, 'admin', 'no'))).toBe('BAD_ROLE');
    expect((await core.moderation.setRole(CONSOLE, lockedOne.id, 'admin', 'console grant')).role).toBe('admin');
  });

  test('a password reset hands back a code and signs every session out', async () => {
    const admin = await staff('admin');
    const mod = await staff('mod');
    const { identity, key } = await signUp('reset');
    const lockedOne = (await core.accounts.lock(identity, PASSWORD)).identity;
    expect(await core.identities.authenticate(key)).not.toBeNull();
    expect(await codeOf(core.moderation.resetPassword(as(mod), lockedOne.id, 'forgot'))).toBe('FORBIDDEN_ROLE');
    const code = await core.moderation.resetPassword(as(admin), lockedOne.id, 'forgot');
    expect(code.startsWith('csr_')).toBe(true);
    expect(await core.identities.authenticate(key)).toBeNull();
    expect(await codeOf(core.moderation.resetPassword(as(admin), (await person('nopw')).id, 'x'))).toBe('NOT_LOCKED');
  });

  test('IP bans refuse loopback addresses: behind nginx every request is loopback', async () => {
    const admin = await staff('admin');
    for (const ip of ['127.0.0.1', '127.8.9.10', '::1', '::ffff:127.0.0.1', '::FFFF:127.1.2.3']) {
      expect([ip, await codeOf(core.moderation.banIp(as(admin), ip, 'oops'))]).toEqual([ip, 'BAD_IP']);
      expect(core.moderation.isIpBanned(ip)).toBe(false);
    }
    expect(await codeOf(core.moderation.banIp(CONSOLE, '127.0.0.1', 'oops'))).toBe('BAD_IP');
  });

  test('IP bans: admins only, validated, and reversible', async () => {
    const admin = await staff('admin');
    const mod = await staff('mod');
    expect(await codeOf(core.moderation.banIp(as(mod), '203.0.113.5', 'spam'))).toBe('FORBIDDEN_ROLE');
    expect(await codeOf(core.moderation.banIp(as(admin), 'not an ip', 'spam'))).toBe('BAD_IP');
    await core.moderation.banIp(as(admin), '203.0.113.5', 'spam');
    expect(core.moderation.isIpBanned('203.0.113.5')).toBe(true);
    expect(core.moderation.isIpBanned(null)).toBe(false);
    await core.moderation.unbanIp(as(admin), '203.0.113.5', 'mistake');
    expect(core.moderation.isIpBanned('203.0.113.5')).toBe(false);
    expect(await codeOf(core.moderation.unbanIp(as(admin), '203.0.113.5', 'again'))).toBe('NO_BAN');
  });

  test('release tombstones the player and drops their sanctions', async () => {
    const admin = await staff('admin');
    const p = await person('gone');
    await core.moderation.mute(as(admin), p.id, 'noisy', 30);
    await core.moderation.release(as(admin), p.id, 'asked to be deleted');
    expect((await core.identities.get(p.id))?.released).toBe(true);
    expect(core.moderation.sanctionOf(p.id)).toBeNull();
    expect(await codeOf(core.moderation.mute(as(admin), p.id, 'again', 5))).toBe('NO_USER');
    // the mute is lifted in storage too, not just forgotten from memory, so a restart's load()
    // (a boot-time reload of active sanctions) doesn't reinstate it as still active
    await core.moderation.load();
    expect(core.moderation.sanctionOf(p.id)).toBeNull();
  });
});

describe('sanctions end with the name, however it is given back', () => {
  const fresh = async () => {
    const again = new ModerationManager(core.database.db, core.bus, clock, {
      identities: core.identities,
      accounts: core.accounts,
      profiles: core.profiles,
      comms: core.comms,
      games: core.games,
      invites: core.invites,
      tables: core.tables,
    });
    await again.load();
    return again;
  };

  test('a muted player who deletes themselves leaves no sanction to reload at boot', async () => {
    const admin = await staff('admin');
    const p = await person('quitter');
    await core.moderation.mute(as(admin), p.id, 'noisy', 30);
    await core.accounts.deleteSelf(p, undefined);
    expect(core.moderation.sanctionOf(p.id)).toBeNull();
    expect((await fresh()).sanctionOf(p.id)).toBeNull();
  });

  test('an idle guest swept while suspended leaves no sanction behind either', async () => {
    const admin = await staff('admin');
    const p = await person('swept');
    await core.moderation.suspend(as(admin), p.id, 'long one', null);
    await core.accounts.release(p.id);
    expect(core.moderation.sanctionOf(p.id)).toBeNull();
    expect((await fresh()).sanctionOf(p.id)).toBeNull();
  });
});

describe('the log and the people pages', () => {
  test('every action is logged with its actor; people and person read it back', async () => {
    const mod = await staff('mod');
    const p = await person('logged');
    await core.moderation.mute(as(mod), p.id, 'first warning', 10);
    await core.moderation.lift(CONSOLE, p.id, 'console mercy');
    await core.moderation.suspend(as(mod), p.id, 'second warning', 20);

    const entries = await core.moderation.log({ targetId: p.id });
    expect(entries.map((e) => [e.action, e.actor, e.reason])).toEqual([
      ['suspend', mod.handle, 'second warning'],
      ['lift', 'console', 'console mercy'],
      ['mute', mod.handle, 'first warning'],
    ]);
    expect(entries[0].target?.id).toBe(p.id);
    expect(entries[0].detail).toEqual({ minutes: 20 });
    const older = await core.moderation.log({ targetId: p.id, before: entries[0].id });
    expect(older.map((e) => e.action)).toEqual(['lift', 'mute']);

    const suspended = await core.moderation.people('', 'suspended');
    expect(suspended.some((s) => s.identity.id === p.id && s.sanction?.kind === 'suspend')).toBe(true);
    const found = await core.moderation.people(p.handle.slice(0, 8).toUpperCase(), 'all');
    expect(found.some((s) => s.identity.id === p.id)).toBe(true);
    expect((await core.moderation.people('', 'mods')).some((s) => s.identity.id === mod.id)).toBe(true);
    expect((await core.moderation.people('', 'guests')).every((s) => s.identity.kind === 'human' && !s.identity.locked)).toBe(true);

    const detail = await core.moderation.person(p.handle);
    expect(detail.profile.identity.id).toBe(p.id);
    expect(detail.sanction?.kind).toBe('suspend');
    expect(detail.sessions).toBe(1);
    expect(detail.history).toHaveLength(3);
  });
});
