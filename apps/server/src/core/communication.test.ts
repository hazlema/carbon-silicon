import { testDatabaseUrl } from '@cs/server/testing';
import { afterAll, describe, expect, test } from 'bun:test';
import { PUBLIC_CHANNELS, type ChatMessage } from '@cs/shared/protocol';
import { openDatabase } from '../db';
import { FakeClock } from '../lib/clock';
import type { AppError } from '../lib/errors';
import { randomTag } from '../lib/testing';
import { EventBus } from './bus';
import { CommunicationManager } from './communication';
import { Guard } from './guard';
import { IdentityManager } from './identity';

const database = await openDatabase(await testDatabaseUrl());
afterAll(() => database.close());

async function setup() {
  const clock = new FakeClock();
  const bus = new EventBus();
  const ids = new IdentityManager(database.db, clock, { houseKey: null });
  const comms = new CommunicationManager(database.db, bus, clock, ids, { publicChannels: PUBLIC_CHANNELS, guard: new Guard() });
  const tag = randomTag();
  const ada = (await ids.createHuman(`ada${tag}`)).identity;
  const bob = (await ids.registerAgent({ name: `bob${tag}` }, null)).identity;
  return { clock, bus, ids, comms, ada, bob, tag };
}

async function errorOf(p: Promise<unknown>): Promise<AppError> {
  try {
    await p;
  } catch (e) {
    return e as AppError;
  }
  throw new Error('expected a rejection');
}

describe('chat', () => {
  test('post then read history, oldest first, with authors; the bus hears it', async () => {
    const { comms, bus, ada, bob } = await setup();
    const heard: ChatMessage[] = [];
    bus.on('chat.message', (m) => heard.push(m));
    await comms.post(ada, 'lobby', 'hello');
    const second = await comms.post(bob, 'lobby', '  hi ada  ');
    expect(second.text).toBe('hi ada');
    const history = await comms.history('lobby', { limit: 50 });
    const mine = history.filter((m) => m.author?.id === ada.id || m.author?.id === bob.id);
    expect(mine.map((m) => m.text)).toEqual(['hello', 'hi ada']);
    expect(mine[1].author?.kind).toBe('agent');
    expect(heard).toHaveLength(2);
    const after = await comms.history('lobby', { since: mine[0].id });
    expect(after.map((m) => m.text)).toContain('hi ada');
    expect(after.map((m) => m.text)).not.toContain('hello');
  });
  test('public channels are censored; unknown channels 404; empty and long messages 400', async () => {
    const { comms, ada } = await setup();
    const m = await comms.post(ada, 'lobby', 'well fuck');
    expect(m.text).not.toContain('fuck');
    expect((await errorOf(comms.post(ada, 'nowhere', 'x'))).status).toBe(404);
    expect((await errorOf(comms.post(ada, 'lobby', '   '))).code).toBe('EMPTY');
    expect((await errorOf(comms.post(ada, 'lobby', 'x'.repeat(501)))).code).toBe('TOO_LONG');
  });
  test('diary is read-only for everyone but admins', async () => {
    const { comms, ada } = await setup();
    expect((await errorOf(comms.post(ada, 'diary', 'hi'))).status).toBe(403);
    const sys = await comms.postSystem('diary', 'New entry');
    expect(sys).toMatchObject({ system: true, author: null, channel: 'diary' });
  });
  test('table channels: only the posters talk; table chat is uncensored and reaches the other posters', async () => {
    const { comms, ada, bob } = await setup();
    comms.setTableAccess((id) => (id === 't_t1' ? { posters: [ada.id, bob.id] } : null));
    const m = await comms.post(ada, 'table:t_t1', 'you are fucking toast');
    expect(m.text).toBe('you are fucking toast');
    const inbox = await comms.poll(bob.id, 0, 0);
    expect(inbox.events.some((e) => e.type === 'chat.table' && e.message.id === m.id)).toBe(true);
    expect((await errorOf(comms.post(ada, 'table:t_other', 'hi'))).status).toBe(403);
  });
  test('rail channels: anyone signed in posts while the table exists; it is censored; a cleared table is 404', async () => {
    const { comms, ada, bob } = await setup();
    comms.setTableAccess((id) => (id === 't_r1' ? { posters: [ada.id] } : null));
    const line = await comms.post(bob, 'rail:t_r1', 'this is fucking great');
    expect(line.text).not.toContain('fucking');
    const err = await errorOf(comms.post(bob, 'rail:t_gone', 'hello?'));
    expect([err.status, err.code]).toEqual([404, 'NO_TABLE']);
    expect((await comms.history('rail:t_r1')).map((x) => x.id)).toContain(line.id);
  });
  test('match:<id> is an alias for its table channel, for posts and history', async () => {
    const { comms, ada, bob } = await setup();
    comms.setTableAccess((id) => (id === 't_a1' ? { posters: [ada.id, bob.id] } : null));
    comms.setMatchTable(async (matchId) => (matchId === 'm_a1' ? 't_a1' : null));
    const m = await comms.post(ada, 'match:m_a1', 'gg in advance');
    expect(m.channel).toBe('table:t_a1');
    expect((await comms.history('match:m_a1')).map((x) => x.id)).toContain(m.id);
    expect(await comms.resolve('match:m_a1')).toBe('table:t_a1');
    expect(await comms.resolve('lobby')).toBe('lobby');
  });
  test('a tableless match keeps its own channel: players post through the match hook, others are refused', async () => {
    const { comms, ada, bob } = await setup();
    comms.setMatchAccess((id) => (id === 'm_l1' ? { posters: [ada.id, bob.id] } : null));
    const m = await comms.post(ada, 'match:m_l1', 'old school');
    expect(m.channel).toBe('match:m_l1');
    expect((await comms.poll(bob.id, 0, 0)).events.some((e) => e.type === 'chat.table' && e.message.id === m.id)).toBe(true);
    const err = await errorOf(comms.post(ada, 'match:m_ended', 'anyone?'));
    expect([err.status, err.code]).toEqual([403, 'NOT_AT_TABLE']);
  });
  test('flood control: burst of 5 then 429', async () => {
    const { comms, ada, clock } = await setup();
    for (let i = 0; i < 5; i++) await comms.post(ada, 'lobby', `m${i}`);
    const err = await errorOf(comms.post(ada, 'lobby', 'm5'));
    expect([err.status, err.code]).toEqual([429, 'SLOW_DOWN']);
    clock.advance(2000);
    await comms.post(ada, 'lobby', 'm6');
  });
  test('@mentions reach the mentioned inbox (case-insensitive), not the author', async () => {
    const { comms, ada, bob, tag } = await setup();
    await comms.post(ada, 'lobby', `hey @BOB${tag} and @ada${tag}`);
    const bobPoll = await comms.poll(bob.id, 0, 0);
    expect(bobPoll.events).toHaveLength(1);
    expect(bobPoll.events[0].type).toBe('chat.mention');
    expect((await comms.poll(ada.id, 0, 0)).events).toHaveLength(0);
  });
});

describe('inbox', () => {
  test('poll returns buffered events immediately with increasing cursors', async () => {
    const { comms, bob } = await setup();
    comms.deliver(bob.id, { type: 'system', text: 'one' });
    comms.deliver(bob.id, { type: 'system', text: 'two' });
    const all = await comms.poll(bob.id, 0, 25_000);
    expect(all.events.map((e) => e.cursor)).toEqual([1, 2]);
    expect(all.cursor).toBe(2);
    expect((await comms.poll(bob.id, 1, 0)).events.map((e) => e.cursor)).toEqual([2]);
  });
  test('poll waits for the next event', async () => {
    const { comms, bob } = await setup();
    const pending = comms.poll(bob.id, 0, 25_000);
    comms.deliver(bob.id, { type: 'system', text: 'wake up' });
    const got = await pending;
    expect(got.events).toHaveLength(1);
  });
  test('poll times out empty after waitMs', async () => {
    const { comms, clock, bob } = await setup();
    const pending = comms.poll(bob.id, 0, 25_000);
    clock.advance(25_000);
    const got = await pending;
    expect(got).toEqual({ cursor: 0, events: [], gap: false });
  });
  test('a cursor from before a restart (ahead of ours) still receives new events, flagged as a gap', async () => {
    const { comms, bob } = await setup();
    const pending = comms.poll(bob.id, 999, 25_000);
    comms.deliver(bob.id, { type: 'system', text: 'after restart' });
    const got = await pending;
    expect(got.events.map((e) => e.type)).toEqual(['system']);
    expect(got.gap).toBe(true);
  });
  test('the ring buffer keeps 500 events and reports gaps', async () => {
    const { comms, bob } = await setup();
    for (let i = 0; i < 510; i++) comms.deliver(bob.id, { type: 'system', text: `e${i}` });
    const got = await comms.poll(bob.id, 0, 0);
    expect(got.events).toHaveLength(500);
    expect(got.events[0].cursor).toBe(11);
    expect(got.gap).toBe(true);
    expect((await comms.poll(bob.id, 10, 0)).gap).toBe(false);
  });
  test('deliver publishes on the bus', async () => {
    const { comms, bus, bob } = await setup();
    const seen: string[] = [];
    bus.on('inbox', ({ identityId, event }) => seen.push(`${identityId}:${event.type}`));
    comms.deliver(bob.id, { type: 'system', text: 'x' });
    expect(seen).toEqual([`${bob.id}:system`]);
  });
});
