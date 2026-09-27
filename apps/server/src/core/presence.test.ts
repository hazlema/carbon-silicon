import { describe, expect, test } from 'bun:test';
import type { IdentityPublic, PresenceInfo } from '@cs/shared/protocol';
import { FakeClock } from '../lib/clock';
import { EventBus } from './bus';
import { PresenceManager } from './presence';

const ident = (id: string, handle: string, kind: 'human' | 'agent'): IdentityPublic => ({
  id, handle, kind, tagline: null, color: '#ffffff', model: null, isHouse: false, locked: false,
  role: 'user', ownerHandle: null, released: false,
});
const ada = ident('h1', 'Ada', 'human');
const bot = ident('a1', 'ByteEater', 'agent');

function setup() {
  const clock = new FakeClock(0);
  const bus = new EventBus();
  const events: PresenceInfo[] = [];
  bus.on('presence.changed', (p) => events.push(p));
  return { clock, events, presence: new PresenceManager(bus, clock) };
}

describe('humans', () => {
  test('connect makes them ready; disconnect goes offline only after the grace period', () => {
    const { clock, events, presence } = setup();
    presence.humanConnected(ada);
    expect(presence.get('h1')?.status).toBe('ready');
    presence.humanDisconnected('h1');
    clock.advance(14_999);
    expect(presence.get('h1')?.status).toBe('ready');
    clock.advance(1);
    expect(presence.get('h1')).toBeNull();
    expect(events.at(-1)?.status).toBe('offline');
  });
  test('reconnecting within the grace period cancels going offline', () => {
    const { clock, presence } = setup();
    presence.humanConnected(ada);
    presence.humanDisconnected('h1');
    clock.advance(10_000);
    presence.humanConnected(ada);
    clock.advance(60_000);
    expect(presence.get('h1')?.status).toBe('ready');
  });
  test('two tabs: offline only when both close', () => {
    const { clock, presence } = setup();
    presence.humanConnected(ada);
    presence.humanConnected(ada);
    presence.humanDisconnected('h1');
    clock.advance(20_000);
    expect(presence.get('h1')?.status).toBe('ready');
  });
  test('10 idle minutes make them afk; activity brings them back', () => {
    const { clock, presence } = setup();
    presence.humanConnected(ada);
    clock.advance(600_000);
    expect(presence.get('h1')?.status).toBe('afk');
    presence.humanActivity('h1');
    expect(presence.get('h1')?.status).toBe('ready');
  });
  test('a manual afk is not undone by activity', () => {
    const { presence } = setup();
    presence.humanConnected(ada);
    presence.setManualStatus(ada, 'afk');
    presence.humanActivity('h1');
    expect(presence.get('h1')?.status).toBe('afk');
    expect(presence.isReady('h1')).toBe(false);
  });
});

describe('agents', () => {
  test('any API call keeps them online for 90 seconds', () => {
    const { clock, presence } = setup();
    presence.agentSeen(bot);
    clock.advance(60_000);
    presence.agentSeen(bot);
    clock.advance(60_000);
    expect(presence.get('a1')?.status).toBe('ready');
    clock.advance(30_000);
    expect(presence.get('a1')).toBeNull();
  });
});

describe('playing', () => {
  test('playing is automatic and restores the previous status', () => {
    const { presence } = setup();
    presence.humanConnected(ada);
    presence.setManualStatus(ada, 'afk');
    presence.setPlaying('h1', true);
    expect(presence.get('h1')?.status).toBe('playing');
    presence.setManualStatus(ada, 'ready');
    expect(presence.get('h1')?.status).toBe('playing');
    presence.setPlaying('h1', false);
    expect(presence.get('h1')?.status).toBe('ready');
  });
  test('setPlaying on someone offline is harmless', () => {
    const { presence } = setup();
    presence.setPlaying('nobody', true);
    presence.setPlaying('nobody', false);
    expect(presence.list()).toEqual([]);
  });
  test('setManualStatus creates an entry if needed and list is sorted', () => {
    const { presence } = setup();
    presence.setManualStatus(bot, 'ready');
    presence.humanConnected(ada);
    expect(presence.list().map((p) => p.identity.handle)).toEqual(['Ada', 'ByteEater']);
  });
});
