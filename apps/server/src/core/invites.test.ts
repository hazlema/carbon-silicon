import { testDatabaseUrl } from '@cs/server/testing';
import { afterAll, describe, expect, test } from 'bun:test';
import { criticalMassGame } from '@cs/critical-mass';
import { PUBLIC_CHANNELS } from '@cs/shared/protocol';
import { openDatabase } from '../db';
import { FakeClock } from '../lib/clock';
import { forbidden, type AppError } from '../lib/errors';
import { randomTag, waitFor } from '../lib/testing';
import { EventBus } from './bus';
import { CommunicationManager } from './communication';
import { GameManager } from './games';
import { Guard } from './guard';
import { IdentityManager } from './identity';
import { InviteManager } from './invites';
import { PresenceManager } from './presence';

const database = await openDatabase(await testDatabaseUrl());
afterAll(() => database.close());

async function setup(guard = new Guard()) {
  const clock = new FakeClock();
  const bus = new EventBus();
  const ids = new IdentityManager(database.db, clock, { houseKey: 'hk' });
  const comms = new CommunicationManager(database.db, bus, clock, ids, { publicChannels: PUBLIC_CHANNELS, guard: new Guard() });
  const presence = new PresenceManager(bus, clock);
  const games = new GameManager(database.db, bus, clock, comms, presence, [criticalMassGame], new Guard());
  const invites = new InviteManager(games, presence, bus, clock, guard, { houseFallbackMs: 8000 });
  const tag = randomTag();
  const ann = (await ids.createHuman(`ann${tag}`)).identity;
  const ben = (await ids.createHuman(`ben${tag}`)).identity;
  const house = (await ids.registerAgent({ name: `house${tag}` }, 'hk')).identity;
  presence.humanConnected(ann);
  presence.humanConnected(ben);
  return { clock, presence, games, invites, ann, ben, house };
}

async function errorOf(p: Promise<unknown>): Promise<AppError> {
  try {
    await p;
  } catch (e) {
    return e as AppError;
  }
  throw new Error('expected a rejection');
}

describe('quick match', () => {
  test('two ready players are paired immediately', async () => {
    const { invites, games, ann, ben } = await setup();
    expect(await invites.quickMatch(ann, 'critical-mass')).toEqual({ status: 'queued' });
    expect(invites.queuedFor(ann.id)).toBe('critical-mass');
    expect(await invites.quickMatch(ann, 'critical-mass')).toEqual({ status: 'queued' });
    const r = await invites.quickMatch(ben, 'critical-mass');
    expect(r.status).toBe('matched');
    if (r.status !== 'matched') return;
    expect(r.match.seats.map((s) => s.identity.id).sort()).toEqual([ann.id, ben.id].sort());
    expect(invites.queuedFor(ann.id)).toBeNull();
    expect(games.activeMatchOf(ann.id)).toBe(r.match.id);
  });
  test('after 8 seconds alone, a ready house bot steps in', async () => {
    const { invites, games, presence, clock, ann, house } = await setup();
    presence.agentSeen(house);
    await invites.quickMatch(ann, 'critical-mass');
    clock.advance(7999);
    expect(games.activeMatchOf(ann.id)).toBeNull();
    clock.advance(1);
    await waitFor(() => games.activeMatchOf(ann.id) !== null);
    expect(games.activeMatchOf(house.id)).toBe(games.activeMatchOf(ann.id));
  });
  test('with no house bot around, the player keeps waiting until one shows up', async () => {
    const { invites, games, presence, clock, ann, house } = await setup();
    await invites.quickMatch(ann, 'critical-mass');
    clock.advance(8000);
    expect(invites.queuedFor(ann.id)).toBe('critical-mass');
    presence.agentSeen(house);
    clock.advance(8000);
    await waitFor(() => games.activeMatchOf(ann.id) !== null);
  });
  test('a suspended house bot is never seated by the fallback; once lifted, it is', async () => {
    const suspended = new Set<string>();
    const guard = new Guard();
    guard.install((who, action) => {
      if (suspended.has(who.id) && action !== 'chat') throw forbidden('SUSPENDED', 'Suspended.');
    });
    const { invites, games, presence, clock, ann, house } = await setup(guard);
    presence.agentSeen(house);
    suspended.add(house.id);
    await invites.quickMatch(ann, 'critical-mass');
    clock.advance(8000);
    await Bun.sleep(20);
    expect(games.activeMatchOf(ann.id)).toBeNull();
    expect(games.activeMatchOf(house.id)).toBeNull();
    expect(invites.queuedFor(ann.id)).toBe('critical-mass');
    suspended.delete(house.id);
    clock.advance(8000);
    await waitFor(() => games.activeMatchOf(ann.id) !== null);
    expect(games.activeMatchOf(house.id)).toBe(games.activeMatchOf(ann.id));
  });
  test('refusals: not ready, already playing, house bots, unknown games', async () => {
    const { invites, presence, ann, ben, house } = await setup();
    presence.setManualStatus(ann, 'afk');
    expect((await errorOf(invites.quickMatch(ann, 'critical-mass'))).code).toBe('NOT_READY');
    presence.agentSeen(house);
    expect((await errorOf(invites.quickMatch(house, 'critical-mass'))).status).toBe(403);
    expect((await errorOf(invites.quickMatch(ben, 'chess'))).status).toBe(404);
    presence.setManualStatus(ann, 'ready');
    await invites.quickMatch(ann, 'critical-mass');
    await invites.quickMatch(ben, 'critical-mass');
    expect((await errorOf(invites.quickMatch(ben, 'critical-mass'))).code).toBe('IN_MATCH');
  });
  test('going afk leaves the queue; leave() reports whether you were queued', async () => {
    const { invites, presence, ann, ben } = await setup();
    await invites.quickMatch(ann, 'critical-mass');
    presence.setManualStatus(ann, 'afk');
    expect(invites.queuedFor(ann.id)).toBeNull();
    await invites.quickMatch(ben, 'critical-mass');
    expect(invites.leave(ben.id)).toBe(true);
    expect(invites.leave(ben.id)).toBe(false);
  });
  test('if createMatch fails during pairing, partner is restored to queue', async () => {
    const { invites, games, ann, ben } = await setup();
    await invites.quickMatch(ann, 'critical-mass');
    expect(invites.queuedFor(ann.id)).toBe('critical-mass');

    // Spy on createMatch to make it fail on the first call (during pairing)
    const originalCreateMatch = games.createMatch.bind(games);
    let callCount = 0;
    games.createMatch = (async (gameId: string, players: any[]) => {
      callCount++;
      if (callCount === 1) {
        throw new Error('Simulated createMatch failure');
      }
      return originalCreateMatch(gameId, players);
    }) as any;

    try {
      const error = await errorOf(invites.quickMatch(ben, 'critical-mass'));
      expect(error.message).toBe('Simulated createMatch failure');

      // Partner should still be queued after the failure
      expect(invites.queuedFor(ann.id)).toBe('critical-mass');
    } finally {
      // Restore original
      games.createMatch = originalCreateMatch;
    }
  });
});
