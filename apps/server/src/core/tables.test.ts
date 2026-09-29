import { testDatabaseUrl } from '@cs/server/testing';
import { afterAll, describe, expect, test } from 'bun:test';
import { criticalMassGame } from '@cs/critical-mass';
import { lightlineGame } from '@cs/lightline';
import { PUBLIC_CHANNELS, tableChannel, type IdentityPublic, type InboxEvent } from '@cs/shared/protocol';
import { openDatabase } from '../db';
import { FakeClock } from '../lib/clock';
import type { AppError } from '../lib/errors';
import { randomTag, waitFor } from '../lib/testing';
import { EventBus } from './bus';
import { CommunicationManager } from './communication';
import { GameManager } from './games';
import { Guard } from './guard';
import { IdentityManager } from './identity';
import { PresenceManager } from './presence';
import { RelationManager } from './relations';
import { TableManager } from './tables';

const database = await openDatabase(await testDatabaseUrl());
afterAll(() => database.close());

async function setup(guard = new Guard()) {
  const clock = new FakeClock();
  const bus = new EventBus();
  const identities = new IdentityManager(database.db, clock, { houseKey: 'hk' });
  const comms = new CommunicationManager(database.db, bus, clock, identities, { publicChannels: PUBLIC_CHANNELS, guard });
  // humanIdleMs is well past the table's idleMs so a host's auto-AFK never races the table's own idle close.
  const presence = new PresenceManager(bus, clock, { agentTimeoutMs: 90_000, humanGraceMs: 15_000, humanIdleMs: 3_600_000 });
  const games = new GameManager(database.db, bus, clock, comms, presence, [criticalMassGame, lightlineGame], guard, { countdownMs: 0 });
  const relations = new RelationManager(database.db, identities);
  const tables = new TableManager({ games, presence, comms, identities, relations, guard, bus, clock }, { shuffle: (xs) => [...xs] });
  const tag = randomTag();
  const human = async (name: string) => {
    const who = (await identities.createHuman(`${name}${tag}`)).identity;
    presence.humanConnected(who);
    return who;
  };
  const ann = await human('ann');
  const ben = await human('ben');
  const cat = await human('cat');
  const dan = await human('dan');
  const eve = await human('eve');
  const house = (await identities.registerAgent({ name: `house${tag}` }, 'hk')).identity;
  presence.agentSeen(house);
  const agent = (await identities.registerAgent({ name: `bot${tag}` }, null)).identity;
  presence.agentSeen(agent);
  return { clock, bus, comms, presence, games, relations, tables, ann, ben, cat, dan, eve, house, agent };
}
type Ctx = Awaited<ReturnType<typeof setup>>;
type Offer = Extract<InboxEvent, { type: 'invite.received' }>;

async function errorOf(fn: () => unknown): Promise<AppError> {
  try {
    await fn();
  } catch (e) {
    return e as AppError;
  }
  throw new Error('expected a rejection');
}
const events = async <T extends InboxEvent['type']>(ctx: Ctx, who: IdentityPublic, type: T) =>
  (await ctx.comms.poll(who.id, 0, 0)).events.filter((e): e is Extract<InboxEvent, { type: T }> => e.type === type);
async function inviteOf(ctx: Ctx, who: IdentityPublic): Promise<string> {
  const last = (await events(ctx, who, 'invite.received')).at(-1) as Offer | undefined;
  if (!last) throw new Error(`no invite for ${who.handle}`);
  return last.invite.id;
}
const said = (ctx: Ctx, tableId: string, text: string) =>
  waitFor(async () => (await ctx.comms.history(tableChannel(tableId))).some((m) => m.system && m.text === text));

describe('gathering', () => {
  test('hosting seats the host at a closed table sized by the game', async () => {
    const ctx = await setup();
    const t = await ctx.tables.host(ctx.ann, 'critical-mass');
    expect(t).toMatchObject({ gameId: 'critical-mass', status: 'forming', open: false, size: 4, minPlayers: 2, matchId: null });
    expect(t.host.id).toBe(ctx.ann.id);
    expect(t.seated.map((s) => s.id)).toEqual([ctx.ann.id]);
    expect(ctx.tables.atTable(ctx.ann.id)).toBe(t.id);
    expect(ctx.tables.tableFor(ctx.ann.id)?.id).toBe(t.id);
    await said(ctx, t.id, `@${ctx.ann.handle} opened a table for Critical Mass.`);
  });
  test('an invite reaches the invitee with the table; accepting seats them and tells the host', async () => {
    const ctx = await setup();
    const t = await ctx.tables.host(ctx.ann, 'critical-mass', { invite: [ctx.ben.handle] });
    expect(t.invites.map((i) => i.to.id)).toEqual([ctx.ben.id]);
    const offer = (await events(ctx, ctx.ben, 'invite.received'))[0] as Offer;
    expect(offer.from.id).toBe(ctx.ann.id);
    expect(offer.table.id).toBe(t.id);
    expect(ctx.tables.offersFor(ctx.ben.id).map((o) => o.invite.id)).toEqual([offer.invite.id]);
    const after = ctx.tables.accept(ctx.ben, offer.invite.id);
    expect(after.seated.map((s) => s.id)).toEqual([ctx.ann.id, ctx.ben.id]);
    expect(after.invites).toEqual([]);
    const answered = await events(ctx, ctx.ann, 'invite.answered');
    expect(answered.at(-1)).toMatchObject({ inviteId: offer.invite.id, answer: 'accepted' });
    expect((await events(ctx, ctx.ann, 'table.updated')).at(-1)?.table.seated).toHaveLength(2);
    await said(ctx, t.id, `@${ctx.ben.handle} sat down.`);
    expect((await errorOf(() => ctx.tables.accept(ctx.ben, offer.invite.id))).status).toBe(410);
  });
  test('an invite nobody answers expires after 60 s and the seat is empty again', async () => {
    const ctx = await setup();
    const t = await ctx.tables.host(ctx.ann, 'critical-mass', { invite: [ctx.ben.handle] });
    const id = await inviteOf(ctx, ctx.ben);
    ctx.clock.advance(59_999);
    expect(ctx.tables.get(t.id, ctx.ann.id).invites).toHaveLength(1);
    ctx.clock.advance(1);
    expect(ctx.tables.get(t.id, ctx.ann.id).invites).toHaveLength(0);
    expect((await events(ctx, ctx.ann, 'invite.answered')).at(-1)).toMatchObject({ answer: 'expired' });
    expect((await events(ctx, ctx.ben, 'invite.cancelled')).at(-1)).toMatchObject({ inviteId: id, reason: 'expired' });
    await said(ctx, t.id, `@${ctx.ben.handle}'s invite expired — the seat is empty.`);
    const err = await errorOf(() => ctx.tables.accept(ctx.ben, id));
    expect([err.status, err.code]).toEqual([410, 'INVITE_GONE']);
  });
  test('a decline empties the seat and keeps the host from re-inviting that person for 2 minutes', async () => {
    const ctx = await setup();
    const t = await ctx.tables.host(ctx.ann, 'critical-mass', { invite: [ctx.ben.handle] });
    ctx.tables.decline(ctx.ben, await inviteOf(ctx, ctx.ben));
    expect(ctx.tables.get(t.id, ctx.ann.id).invites).toHaveLength(0);
    expect((await events(ctx, ctx.ann, 'invite.answered')).at(-1)).toMatchObject({ answer: 'declined' });
    await said(ctx, t.id, `@${ctx.ben.handle} declined.`);
    const err = await errorOf(() => ctx.tables.invite(ctx.ann, t.id, [ctx.ben.handle]));
    expect([err.status, err.code]).toEqual([429, 'SLOW_DOWN']);
    ctx.clock.advance(120_000);
    expect((await ctx.tables.invite(ctx.ann, t.id, [ctx.ben.handle])).invites).toHaveLength(1);
  });
  test('the table holds the game’s maximum; the full line is said when the last seat fills', async () => {
    const ctx = await setup();
    const t = await ctx.tables.host(ctx.ann, 'critical-mass', { invite: [ctx.ben.handle, ctx.cat.handle, ctx.dan.handle] });
    const full = await errorOf(() => ctx.tables.invite(ctx.ann, t.id, [ctx.eve.handle]));
    expect([full.status, full.code, full.message]).toEqual([409, 'TABLE_FULL', `The table is full — @${ctx.ann.handle}, start when you're ready.`]);
    for (const who of [ctx.ben, ctx.cat, ctx.dan]) ctx.tables.accept(who, await inviteOf(ctx, who));
    await said(ctx, t.id, `The table is full — @${ctx.ann.handle}, start when you're ready.`);
  });
  test('refusals: not the host, unknown names, yourself, twice, house hosts, a second table, a player mid-match', async () => {
    const ctx = await setup();
    const t = await ctx.tables.host(ctx.ann, 'critical-mass', { invite: [ctx.ben.handle] });
    expect((await errorOf(() => ctx.tables.invite(ctx.cat, t.id, [ctx.dan.handle]))).code).toBe('NOT_HOST');
    expect((await errorOf(() => ctx.tables.invite(ctx.ann, t.id, ['nobody_here_x']))).code).toBe('NO_USER');
    expect((await errorOf(() => ctx.tables.invite(ctx.ann, t.id, [ctx.ann.handle]))).code).toBe('SELF');
    expect((await errorOf(() => ctx.tables.invite(ctx.ann, t.id, [ctx.ben.handle]))).code).toBe('ALREADY_INVITED');
    expect((await errorOf(() => ctx.tables.invite(ctx.ann, t.id, []))).code).toBe('BAD_HANDLES');
    expect((await errorOf(() => ctx.tables.host(ctx.house, 'critical-mass'))).code).toBe('HOUSE_WAITS');
    expect((await errorOf(() => ctx.tables.host(ctx.ann, 'critical-mass'))).code).toBe('AT_TABLE');
    expect((await errorOf(() => ctx.tables.host(ctx.cat, 'chess'))).code).toBe('NO_GAME');
    await ctx.games.createMatch('critical-mass', [ctx.dan, ctx.eve]);
    expect((await errorOf(() => ctx.tables.host(ctx.dan, 'critical-mass'))).code).toBe('IN_MATCH');
    expect((await errorOf(() => ctx.tables.get('t_nope', null))).code).toBe('NO_TABLE');
  });
  test('an AFK person, and someone who blocked the host, are equally "not available"', async () => {
    const ctx = await setup();
    const t = await ctx.tables.host(ctx.ann, 'critical-mass');
    ctx.presence.setManualStatus(ctx.ben, 'afk');
    const afk = await errorOf(() => ctx.tables.invite(ctx.ann, t.id, [ctx.ben.handle]));
    await ctx.relations.set(ctx.cat, ctx.ann.handle, 'block');
    const blocked = await errorOf(() => ctx.tables.invite(ctx.ann, t.id, [ctx.cat.handle]));
    expect([afk.status, afk.code]).toEqual([409, 'NOT_AVAILABLE']);
    expect([blocked.status, blocked.code]).toEqual([409, 'NOT_AVAILABLE']);
    expect(blocked.message).toBe(`@${ctx.cat.handle} can't take an invite right now.`);
  });
  test('accepting while seated elsewhere moves you, disbanding the table you hosted', async () => {
    const ctx = await setup();
    const mine = await ctx.tables.host(ctx.ben, 'critical-mass');
    const theirs = await ctx.tables.host(ctx.ann, 'critical-mass', { invite: [ctx.ben.handle] });
    ctx.tables.accept(ctx.ben, await inviteOf(ctx, ctx.ben));
    expect(ctx.tables.atTable(ctx.ben.id)).toBe(theirs.id);
    expect((await errorOf(() => ctx.tables.get(mine.id, null))).code).toBe('NO_TABLE');
  });
  test('when the host leaves a forming table it disbands: seats get table.closed, invitees invite.cancelled', async () => {
    const ctx = await setup();
    const t = await ctx.tables.host(ctx.ann, 'critical-mass', { invite: [ctx.ben.handle, ctx.cat.handle] });
    ctx.tables.accept(ctx.ben, await inviteOf(ctx, ctx.ben));
    ctx.tables.leave(ctx.ann, t.id);
    expect((await events(ctx, ctx.ben, 'table.closed')).at(-1)).toMatchObject({ tableId: t.id, reason: 'host-left' });
    expect((await events(ctx, ctx.cat, 'invite.cancelled')).at(-1)).toMatchObject({ tableId: t.id, reason: 'host-left' });
    expect(ctx.tables.atTable(ctx.ben.id)).toBeNull();
  });
  test('a guest who leaves is told, and the seat empties', async () => {
    const ctx = await setup();
    const t = await ctx.tables.host(ctx.ann, 'critical-mass', { invite: [ctx.ben.handle] });
    ctx.tables.accept(ctx.ben, await inviteOf(ctx, ctx.ben));
    ctx.tables.leave(ctx.ben, t.id);
    expect(ctx.tables.get(t.id, null).seated).toHaveLength(1);
    expect((await events(ctx, ctx.ben, 'table.closed')).at(-1)).toMatchObject({ reason: 'left' });
    await said(ctx, t.id, `@${ctx.ben.handle} left the table.`);
  });
  test('going AFK loses a seat; an invitee going AFK loses the invite', async () => {
    const ctx = await setup();
    const t = await ctx.tables.host(ctx.ann, 'critical-mass', { invite: [ctx.ben.handle, ctx.cat.handle] });
    ctx.tables.accept(ctx.ben, await inviteOf(ctx, ctx.ben));
    ctx.presence.setManualStatus(ctx.ben, 'afk');
    ctx.presence.setManualStatus(ctx.cat, 'afk');
    const now = ctx.tables.get(t.id, ctx.ann.id);
    expect(now.seated.map((s) => s.id)).toEqual([ctx.ann.id]);
    expect(now.invites).toEqual([]);
    expect((await events(ctx, ctx.ben, 'table.closed')).at(-1)).toMatchObject({ reason: 'away' });
    expect((await events(ctx, ctx.cat, 'invite.cancelled')).at(-1)).toMatchObject({ reason: 'unavailable' });
  });
  test('open tables: sitting needs the table open; the public list shows them and never shows invites', async () => {
    const ctx = await setup();
    const t = await ctx.tables.host(ctx.ann, 'critical-mass', { invite: [ctx.cat.handle] });
    expect((await errorOf(() => ctx.tables.sit(ctx.ben, t.id))).code).toBe('NOT_OPEN');
    expect(ctx.tables.list().some((x) => x.id === t.id)).toBe(false);
    ctx.tables.setOpen(ctx.ann, t.id, true);
    const listed = ctx.tables.list().find((x) => x.id === t.id);
    expect(listed?.invites).toEqual([]);
    expect((await ctx.tables.sit(ctx.ben, t.id)).seated).toHaveLength(2);
    expect(ctx.tables.get(t.id, null).invites).toEqual([]);
    expect(ctx.tables.get(t.id, ctx.cat.id).invites).toHaveLength(1);
  });
  test('the host removes a guest or withdraws an invite', async () => {
    const ctx = await setup();
    const t = await ctx.tables.host(ctx.ann, 'critical-mass', { invite: [ctx.ben.handle, ctx.cat.handle] });
    ctx.tables.accept(ctx.ben, await inviteOf(ctx, ctx.ben));
    ctx.tables.remove(ctx.ann, t.id, ctx.ben.handle);
    ctx.tables.remove(ctx.ann, t.id, `@${ctx.cat.handle}`);
    const now = ctx.tables.get(t.id, ctx.ann.id);
    expect([now.seated.length, now.invites.length]).toEqual([1, 0]);
    expect((await events(ctx, ctx.ben, 'table.closed')).at(-1)).toMatchObject({ reason: 'removed' });
    expect((await events(ctx, ctx.cat, 'invite.cancelled')).at(-1)).toMatchObject({ reason: 'withdrawn' });
    const notSeated = await errorOf(() => ctx.tables.remove(ctx.ann, t.id, ctx.dan.handle));
    expect([notSeated.status, notSeated.code]).toEqual([403, 'NOT_SEATED']);
  });
  test('two concurrent sits for the same person only seat them once', async () => {
    const ctx = await setup();
    const t = await ctx.tables.host(ctx.ann, 'critical-mass', { open: true });
    const [a, b] = await Promise.all([ctx.tables.sit(ctx.ben, t.id), ctx.tables.sit(ctx.ben, t.id)]);
    expect(a.seated.filter((s) => s.id === ctx.ben.id)).toHaveLength(1);
    expect(b.seated.filter((s) => s.id === ctx.ben.id)).toHaveLength(1);
    const now = ctx.tables.get(t.id, null);
    expect(now.seated.filter((s) => s.id === ctx.ben.id)).toHaveLength(1);
    expect(now.seated).toHaveLength(2);
  });
  test('ten invites a minute, then SLOW_DOWN', async () => {
    const ctx = await setup();
    const t = await ctx.tables.host(ctx.ann, 'critical-mass');
    for (let i = 0; i < 10; i++) {
      await ctx.tables.invite(ctx.ann, t.id, [ctx.ben.handle]);
      ctx.tables.remove(ctx.ann, t.id, ctx.ben.handle);
    }
    expect((await errorOf(() => ctx.tables.invite(ctx.ann, t.id, [ctx.ben.handle]))).code).toBe('SLOW_DOWN');
  });
  test('ten tables a minute, then SLOW_DOWN (vs house and the invite shorthand count too)', async () => {
    const ctx = await setup();
    for (let i = 0; i < 10; i++) {
      const t = await ctx.tables.host(ctx.ann, 'critical-mass');
      ctx.tables.disband(ctx.ann, t.id);
    }
    const err = await errorOf(() => ctx.tables.host(ctx.ann, 'critical-mass'));
    expect([err.status, err.code]).toEqual([429, 'SLOW_DOWN']);
    expect((await errorOf(() => ctx.tables.vsHouse(ctx.ann, 'critical-mass'))).code).toBe('SLOW_DOWN');
    expect(ctx.tables.atTable(ctx.ann.id)).toBeNull();
    ctx.clock.advance(6_000);
    expect((await ctx.tables.host(ctx.ann, 'critical-mass')).host.id).toBe(ctx.ann.id);
  });
  test('ten sits and leaves a minute, then SLOW_DOWN', async () => {
    const ctx = await setup();
    const t = await ctx.tables.host(ctx.ann, 'critical-mass', { open: true, invite: [ctx.cat.handle] });
    for (let i = 0; i < 5; i++) {
      await ctx.tables.sit(ctx.ben, t.id);
      ctx.tables.leave(ctx.ben, t.id);
    }
    const sit = await errorOf(() => ctx.tables.sit(ctx.ben, t.id));
    expect([sit.status, sit.code]).toEqual([429, 'SLOW_DOWN']);
    ctx.tables.accept(ctx.cat, await inviteOf(ctx, ctx.cat)); // an invite accepted isn't a seat move
    for (let i = 0; i < 5; i++) {
      ctx.tables.leave(ctx.cat, t.id);
      await ctx.tables.sit(ctx.cat, t.id);
    }
    const leave = await errorOf(() => ctx.tables.leave(ctx.cat, t.id));
    expect([leave.status, leave.code]).toEqual([429, 'SLOW_DOWN']);
    expect(ctx.tables.get(t.id, null).seated.map((p) => p.id)).toEqual([ctx.ann.id, ctx.cat.id]);
  });
  test('a forgotten table closes after 10 quiet minutes', async () => {
    const ctx = await setup();
    const t = await ctx.tables.host(ctx.ann, 'critical-mass');
    ctx.clock.advance(600_000);
    expect((await errorOf(() => ctx.tables.get(t.id, null))).code).toBe('NO_TABLE');
    expect((await events(ctx, ctx.ann, 'table.closed')).at(-1)).toMatchObject({ reason: 'idle' });
    expect(ctx.tables.atTable(ctx.ann.id)).toBeNull();
  });
});

async function played(ctx: Ctx, a: IdentityPublic, b: IdentityPublic) {
  const t = await ctx.tables.host(a, 'critical-mass', { invite: [b.handle] });
  ctx.tables.accept(b, await inviteOf(ctx, b));
  const match = await ctx.tables.start(a, t.id);
  ctx.clock.advance(0);
  await ctx.games.resign(match.id, b);
  return { t, match };
}

describe('rematch', () => {
  test('a player calls it: they host, the others are invited; the other player pressing Rematch too sits down', async () => {
    const ctx = await setup();
    const { t, match } = await played(ctx, ctx.ann, ctx.ben);
    const again = await ctx.tables.rematch(ctx.ben, t.id);
    expect(again).toMatchObject({ status: 'forming', host: { id: ctx.ben.id } });
    expect(again.invites.map((i) => i.to.id)).toEqual([ctx.ann.id]);
    await said(ctx, t.id, `@${ctx.ben.handle} wants a rematch.`);
    const both = await ctx.tables.rematch(ctx.ann, t.id);
    expect(both.seated.map((p) => p.id)).toEqual([ctx.ben.id, ctx.ann.id]);
    const next = await ctx.tables.start(ctx.ben, t.id);
    expect(next.tableId).toBe(t.id);
    expect(next.id).not.toBe(match.id);
  });
  test('only the last players may call it, and not while the match is on', async () => {
    const ctx = await setup();
    const { t } = await played(ctx, ctx.ann, ctx.ben);
    expect((await errorOf(() => ctx.tables.rematch(ctx.cat, t.id))).code).toBe('NOT_SEATED');
    await ctx.tables.rematch(ctx.ann, t.id);
    ctx.tables.accept(ctx.ben, await inviteOf(ctx, ctx.ben));
    await ctx.tables.start(ctx.ann, t.id);
    expect((await errorOf(() => ctx.tables.rematch(ctx.ann, t.id))).code).toBe('TABLE_BUSY');
  });
  test('a last player who isn’t around gets no invite, and the table says so', async () => {
    const ctx = await setup();
    const { t } = await played(ctx, ctx.ann, ctx.ben);
    ctx.presence.setManualStatus(ctx.ben, 'afk');
    const again = await ctx.tables.rematch(ctx.ann, t.id);
    expect(again.invites).toEqual([]);
    await said(ctx, t.id, `@${ctx.ben.handle} isn't around for a rematch.`);
  });
  test('rematch re-checks freedom after its await: sitting elsewhere mid-call is caught, not silently overridden', async () => {
    const ctx = await setup();
    const { t } = await played(ctx, ctx.ann, ctx.ben);
    const real = ctx.relations.blocks.bind(ctx.relations);
    let elsewhere = '';
    ctx.relations.blocks = (async (ownerId: string, targetId: string) => {
      if (!elsewhere) elsewhere = (await ctx.tables.host(ctx.ann, 'critical-mass')).id;
      return real(ownerId, targetId);
    }) as typeof ctx.relations.blocks;
    try {
      expect((await errorOf(() => ctx.tables.rematch(ctx.ann, t.id))).code).toBe('AT_TABLE');
    } finally {
      ctx.relations.blocks = real;
    }
    // The table ann hosts elsewhere must survive untouched: rematch() must not have silently
    // seated her at `t` and, as a side effect, closed the table she hosts as 'host-left'.
    expect(ctx.tables.atTable(ctx.ann.id)).toBe(elsewhere);
    expect(ctx.tables.get(elsewhere, null).status).toBe('forming');
  });
  test('overlapping rematch presses from both last players both end up seated, no leftover invite', async () => {
    const ctx = await setup();
    const { t } = await played(ctx, ctx.ann, ctx.ben);
    const [a, b] = await Promise.all([ctx.tables.rematch(ctx.ann, t.id), ctx.tables.rematch(ctx.ben, t.id)]);
    expect(a.status).toBe('forming');
    expect(b.status).toBe('forming');
    const now = ctx.tables.get(t.id, null);
    expect(now.seated.map((p) => p.id).sort()).toEqual([ctx.ann.id, ctx.ben.id].sort());
    expect(now.invites).toEqual([]);
  });
  test('a house bot among the last players never becomes host via rematch', async () => {
    const ctx = await setup();
    const t = await ctx.tables.host(ctx.ann, 'critical-mass', { invite: [ctx.house.handle] });
    ctx.tables.accept(ctx.house, await inviteOf(ctx, ctx.house));
    const match = await ctx.tables.start(ctx.ann, t.id);
    ctx.clock.advance(0);
    await ctx.games.resign(match.id, ctx.house);
    expect((await errorOf(() => ctx.tables.rematch(ctx.house, t.id))).code).toBe('HOUSE_WAITS');
  });
});

describe('vs house and quick match', () => {
  test('vs house invites a ready house bot, or the one you name', async () => {
    const ctx = await setup();
    const t = await ctx.tables.vsHouse(ctx.ann, 'critical-mass');
    expect(t.invites.map((i) => i.to.id)).toEqual([ctx.house.id]);
    ctx.tables.disband(ctx.ann, t.id);
    const named = await ctx.tables.vsHouse(ctx.ben, 'critical-mass', `@${ctx.house.handle}`);
    expect(named.invites.map((i) => i.to.id)).toEqual([ctx.house.id]);
  });
  test('the house is full when every house bot is busy, invited or AFK', async () => {
    const ctx = await setup();
    await ctx.tables.vsHouse(ctx.ann, 'critical-mass'); // the only house bot is now invited
    const err = await errorOf(() => ctx.tables.vsHouse(ctx.ben, 'critical-mass'));
    expect([err.status, err.code, err.message]).toEqual([409, 'HOUSE_FULL', 'The house is full — try quick match.']);
    expect((await errorOf(() => ctx.tables.vsHouse(ctx.ben, 'chess'))).code).toBe('NO_GAME');
  });
  test('startNow seats a pair at a new table and starts at once', async () => {
    const ctx = await setup();
    const match = await ctx.tables.startNow('critical-mass', [ctx.ann, ctx.ben]);
    expect(match.tableId).not.toBeNull();
    expect(ctx.tables.get(match.tableId!, null)).toMatchObject({ status: 'playing', matchId: match.id });
    expect(ctx.tables.atTable(ctx.ann.id)).toBe(match.tableId);
  });
  test('a player out of a running 3-player match is no longer at its table', async () => {
    const ctx = await setup();
    const t = await ctx.tables.host(ctx.ann, 'critical-mass', { invite: [ctx.ben.handle, ctx.cat.handle] });
    ctx.tables.accept(ctx.ben, await inviteOf(ctx, ctx.ben));
    ctx.tables.accept(ctx.cat, await inviteOf(ctx, ctx.cat));
    const match = await ctx.tables.start(ctx.ann, t.id);
    ctx.clock.advance(0);
    await ctx.games.resign(match.id, ctx.cat);
    expect(ctx.tables.atTable(ctx.cat.id)).toBeNull();
    expect(ctx.tables.atTable(ctx.ann.id)).toBe(t.id);
    expect((await ctx.tables.host(ctx.cat, 'critical-mass')).host.id).toBe(ctx.cat.id);
  });
  test('a player knocked out of a running 3-player match is no longer at its table', async () => {
    const ctx = await setup();
    const t = await ctx.tables.host(ctx.ann, 'critical-mass', { invite: [ctx.ben.handle, ctx.cat.handle] });
    ctx.tables.accept(ctx.ben, await inviteOf(ctx, ctx.ben));
    ctx.tables.accept(ctx.cat, await inviteOf(ctx, ctx.cat));
    const match = await ctx.tables.start(ctx.ann, t.id); // seats red ann, blue ben, green cat
    ctx.clock.advance(0);
    const play = async (who: IdentityPublic, cell: string) =>
      ctx.games.move(match.id, who, ctx.games.summary(match.id).revision, { cell });
    await play(ctx.ann, 'a1');
    await play(ctx.ben, 'b1');
    await play(ctx.cat, 'h10');
    await play(ctx.ann, 'a1'); // ben's only cell is captured: he's out
    expect(ctx.games.summary(match.id).status).toBe('live');
    expect(ctx.tables.atTable(ctx.ben.id)).toBeNull();
    expect(ctx.tables.atTable(ctx.ann.id)).toBe(t.id);
    expect(ctx.tables.get(t.id, null).status).toBe('playing');
    expect((await ctx.tables.host(ctx.ben, 'critical-mass')).host.id).toBe(ctx.ben.id);
  });
});

describe('the rest of the parlor', () => {
  test('a match starting elsewhere withdraws your pending invites', async () => {
    const ctx = await setup();
    const waiting = await ctx.tables.host(ctx.cat, 'critical-mass', { invite: [ctx.ann.handle] });
    await ctx.tables.startNow('critical-mass', [ctx.ann, ctx.ben]);
    expect(ctx.tables.get(waiting.id, ctx.cat.id).invites).toEqual([]);
    expect((await events(ctx, ctx.ann, 'invite.cancelled')).at(-1)).toMatchObject({ reason: 'unavailable' });
  });
  test('bench: a suspended or released person loses a forming seat and their invites', async () => {
    const ctx = await setup();
    const t = await ctx.tables.host(ctx.ann, 'critical-mass', { invite: [ctx.ben.handle, ctx.cat.handle] });
    ctx.tables.accept(ctx.ben, await inviteOf(ctx, ctx.ben));
    ctx.tables.bench(ctx.ben.id);
    ctx.tables.bench(ctx.cat.id);
    const now = ctx.tables.get(t.id, ctx.ann.id);
    expect([now.seated.length, now.invites.length]).toEqual([1, 0]);
  });
  test('setWatching changes the count and announces it once', async () => {
    const ctx = await setup();
    const t = await ctx.tables.host(ctx.ann, 'critical-mass');
    let heard = 0;
    ctx.bus.on('table.changed', () => (heard += 1));
    ctx.tables.setWatching(t.id, 2);
    ctx.tables.setWatching(t.id, 2);
    ctx.tables.setWatching('t_gone', 1);
    expect(ctx.tables.get(t.id, null).watching).toBe(2);
    expect(heard).toBe(1);
  });
});

describe('starting', () => {
  test('Start needs the minimum; it drops pending invites and starts a match at the table', async () => {
    const ctx = await setup();
    const t = await ctx.tables.host(ctx.ann, 'critical-mass', { invite: [ctx.ben.handle, ctx.cat.handle] });
    const early = await errorOf(() => ctx.tables.start(ctx.ann, t.id));
    expect([early.status, early.code, early.message]).toEqual([409, 'NOT_ENOUGH', 'Critical Mass needs at least 2 players — invite 1 more to start.']);
    ctx.tables.accept(ctx.ben, await inviteOf(ctx, ctx.ben));
    expect((await errorOf(() => ctx.tables.start(ctx.ben, t.id))).code).toBe('NOT_HOST');
    const match = await ctx.tables.start(ctx.ann, t.id);
    expect(match.tableId).toBe(t.id);
    expect(match.seats.map((s) => s.identity.id)).toEqual([ctx.ann.id, ctx.ben.id]);
    expect(ctx.tables.get(t.id, null)).toMatchObject({ status: 'playing', matchId: match.id });
    expect(ctx.tables.get(t.id, null).lastPlayers.map((p) => p.id)).toEqual([ctx.ann.id, ctx.ben.id]);
    expect((await events(ctx, ctx.cat, 'invite.cancelled')).at(-1)).toMatchObject({ reason: 'started' });
    expect(ctx.games.activeMatchOf(ctx.ann.id)).toBe(match.id);
    expect((await errorOf(() => ctx.tables.sit(ctx.cat, t.id))).code).toBe('TABLE_BUSY');
    expect((await errorOf(() => ctx.tables.disband(ctx.ann, t.id))).code).toBe('TABLE_BUSY');
  });
  test('while starting the table is locked; if the match cannot be created it goes back to forming', async () => {
    const ctx = await setup();
    const t = await ctx.tables.host(ctx.ann, 'critical-mass', { invite: [ctx.ben.handle] });
    ctx.tables.accept(ctx.ben, await inviteOf(ctx, ctx.ben));
    const real = ctx.games.createMatch.bind(ctx.games);
    let during = '';
    ctx.games.createMatch = (async () => {
      during = ctx.tables.get(t.id, null).status;
      throw new Error('database went away');
    }) as typeof ctx.games.createMatch;
    await expect(ctx.tables.start(ctx.ann, t.id)).rejects.toThrow('database went away');
    ctx.games.createMatch = real;
    expect(during).toBe('starting');
    expect(ctx.tables.get(t.id, null)).toMatchObject({ status: 'forming', matchId: null });
    expect(ctx.tables.get(t.id, null).seated).toHaveLength(2);
  });
  test('a match that ends before Start has finished still finishes the table', async () => {
    const ctx = await setup();
    const t = await ctx.tables.host(ctx.ann, 'critical-mass', { invite: [ctx.ben.handle] });
    ctx.tables.accept(ctx.ben, await inviteOf(ctx, ctx.ben));
    const real = ctx.games.createMatch.bind(ctx.games);
    ctx.games.createMatch = (async (...args: Parameters<typeof real>) => {
      const match = await real(...args);
      await ctx.games.resign(match.id, ctx.ben); // lands while the table is still 'starting'
      return match;
    }) as typeof ctx.games.createMatch;
    try {
      const match = await ctx.tables.start(ctx.ann, t.id);
      expect(ctx.tables.get(t.id, null)).toMatchObject({ status: 'finished', matchId: match.id, seated: [] });
      expect(ctx.tables.atTable(ctx.ann.id)).toBeNull();
    } finally {
      ctx.games.createMatch = real;
    }
  });
  test('while starting, a late accept of a dropped invite is gone; so is one after the invitee went AFK', async () => {
    const ctx = await setup();
    const t = await ctx.tables.host(ctx.ann, 'critical-mass', { invite: [ctx.ben.handle, ctx.cat.handle] });
    ctx.tables.accept(ctx.ben, await inviteOf(ctx, ctx.ben));
    const catInvite = await inviteOf(ctx, ctx.cat);
    const real = ctx.games.createMatch.bind(ctx.games);
    let late: AppError | null = null;
    ctx.games.createMatch = (async (...args: Parameters<typeof real>) => {
      late = await errorOf(() => ctx.tables.accept(ctx.cat, catInvite));
      return real(...args);
    }) as typeof ctx.games.createMatch;
    try {
      await ctx.tables.start(ctx.ann, t.id);
    } finally {
      ctx.games.createMatch = real;
    }
    expect([late!.status, late!.code]).toEqual([410, 'INVITE_GONE']);
    expect(ctx.tables.get(t.id, null).seated.map((p) => p.id)).toEqual([ctx.ann.id, ctx.ben.id]);

    const other = await ctx.tables.host(ctx.dan, 'critical-mass', { invite: [ctx.eve.handle] });
    const eveInvite = await inviteOf(ctx, ctx.eve);
    ctx.presence.setManualStatus(ctx.eve, 'afk');
    ctx.presence.setManualStatus(ctx.eve, 'ready');
    const gone = await errorOf(() => ctx.tables.accept(ctx.eve, eveInvite));
    expect([gone.status, gone.code]).toEqual([410, 'INVITE_GONE']);
    expect(ctx.tables.get(other.id, null).seated.map((p) => p.id)).toEqual([ctx.dan.id]);
  });
  test('when the match ends the table is finished, the seats free up, and it closes 30 minutes later', async () => {
    const ctx = await setup();
    const t = await ctx.tables.host(ctx.ann, 'critical-mass', { invite: [ctx.ben.handle] });
    ctx.tables.accept(ctx.ben, await inviteOf(ctx, ctx.ben));
    const match = await ctx.tables.start(ctx.ann, t.id);
    ctx.clock.advance(0);
    await ctx.games.resign(match.id, ctx.ben);
    const done = ctx.tables.get(t.id, null);
    expect(done).toMatchObject({ status: 'finished', matchId: match.id, seated: [] });
    expect(done.lastPlayers.map((p) => p.id)).toEqual([ctx.ann.id, ctx.ben.id]);
    expect(ctx.tables.atTable(ctx.ann.id)).toBeNull();
    ctx.clock.advance(1_800_000);
    expect((await errorOf(() => ctx.tables.get(t.id, null))).code).toBe('NO_TABLE');
  });
  test('the players (seated and last) may post at the table; nobody else', async () => {
    const ctx = await setup();
    const t = await ctx.tables.host(ctx.ann, 'critical-mass', { invite: [ctx.ben.handle] });
    ctx.tables.accept(ctx.ben, await inviteOf(ctx, ctx.ben));
    await ctx.comms.post(ctx.ben, tableChannel(t.id), 'ready when you are');
    expect((await errorOf(() => ctx.comms.post(ctx.cat, tableChannel(t.id), 'hi'))).code).toBe('NOT_AT_TABLE');
  });
});

describe('machines only (Lightline)', () => {
  test('a human cannot host, sit, be invited, accept, or play vs house; nothing is left behind', async () => {
    const ctx = await setup();
    const host = await errorOf(() => ctx.tables.host(ctx.ann, 'lightline'));
    expect([host.status, host.code, host.message]).toEqual([403, 'MACHINES_ONLY', 'Lightline is for machines for now; humans can watch.']);
    expect((await errorOf(() => ctx.tables.vsHouse(ctx.ann, 'lightline'))).code).toBe('MACHINES_ONLY');
    expect(ctx.tables.list()).toHaveLength(0);
    const t = await ctx.tables.host(ctx.agent, 'lightline', { open: true });
    expect((await errorOf(() => ctx.tables.sit(ctx.ann, t.id))).code).toBe('MACHINES_ONLY');
    expect((await errorOf(() => ctx.tables.invite(ctx.agent, t.id, [ctx.ann.handle]))).code).toBe('MACHINES_ONLY');
    const after = ctx.tables.get(t.id, ctx.agent.id);
    expect(after.seated.map((p) => p.id)).toEqual([ctx.agent.id]);
    expect(after.invites).toHaveLength(0);
  });

  test('vs house is refused before any bot is picked, even when no house bot is free', async () => {
    const ctx = await setup();
    const e = await errorOf(() => ctx.tables.vsHouse(ctx.ann, 'lightline', 'nobody'));
    expect([e.status, e.code]).toEqual([403, 'MACHINES_ONLY']);
    expect(ctx.tables.list()).toHaveLength(0);
  });
});
