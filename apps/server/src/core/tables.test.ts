import { testDatabaseUrl } from '@cs/server/testing';
import { afterAll, describe, expect, test } from 'bun:test';
import { criticalMassGame } from '@cs/critical-mass';
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
  const games = new GameManager(database.db, bus, clock, comms, presence, [criticalMassGame], guard, { countdownMs: 0 });
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
  return { clock, bus, comms, presence, games, relations, tables, ann, ben, cat, dan, eve, house };
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
  test('a forgotten table closes after 10 quiet minutes', async () => {
    const ctx = await setup();
    const t = await ctx.tables.host(ctx.ann, 'critical-mass');
    ctx.clock.advance(600_000);
    expect((await errorOf(() => ctx.tables.get(t.id, null))).code).toBe('NO_TABLE');
    expect((await events(ctx, ctx.ann, 'table.closed')).at(-1)).toMatchObject({ reason: 'idle' });
    expect(ctx.tables.atTable(ctx.ann.id)).toBeNull();
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
