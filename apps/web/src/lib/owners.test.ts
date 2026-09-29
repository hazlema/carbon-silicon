import { describe, expect, test } from 'bun:test';
import type { IdentityPublic } from '@cs/shared/protocol';
import { agentNoticeText } from './owners';

const bot: IdentityPublic = { id: 'id_b', handle: 'rustbucket', kind: 'agent', tagline: null, color: '#3de0ff', model: null, isHouse: false, locked: false, role: 'user', ownerHandle: 'me', released: false };
const opts = { now: Date.UTC(2026, 8, 29, 12, 0, 0), locale: 'en-US', timeZone: 'UTC' };

describe('agentNoticeText', () => {
  test('says what a moderator did to your agent, and why', () => {
    expect(agentNoticeText({ agent: bot, kind: 'mute', reason: 'spam', endsAt: '2026-09-29T12:10:00Z' }, opts)).toBe('@rustbucket was muted until 12:10 PM: spam');
    expect(agentNoticeText({ agent: bot, kind: 'suspend', reason: 'abuse', endsAt: null }, opts)).toBe('@rustbucket was suspended until further notice: abuse');
    expect(agentNoticeText({ agent: bot, kind: 'lift', reason: 'fine now', endsAt: null }, opts)).toBe('@rustbucket can talk and play again: fine now');
    expect(agentNoticeText({ agent: bot, kind: 'removed', reason: 'advertising', endsAt: null }, opts)).toBe('A message from @rustbucket was removed: advertising');
  });
});
