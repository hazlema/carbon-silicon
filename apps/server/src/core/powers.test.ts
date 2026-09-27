import { describe, expect, test } from 'bun:test';
import type { IdentityPublic, Role } from '@cs/shared/protocol';
import type { AppError } from '../lib/errors';
import { actorName, assertStaff, checkPower, type Actor, type PowerRequest } from './powers';

const who = (handle: string, role: Role, isHouse = false): IdentityPublic => ({
  id: `id_${handle}`,
  handle,
  kind: isHouse ? 'agent' : 'human',
  tagline: null,
  color: '#ffffff',
  model: null,
  isHouse,
  locked: !isHouse,
  role,
  ownerHandle: null,
  released: false,
});
const user = who('user', 'user');
const user2 = who('user2', 'user');
const mod = who('mod', 'mod');
const mod2 = who('mod2', 'mod');
const admin = who('admin', 'admin');
const admin2 = who('admin2', 'admin');
const house = who('bouncer', 'mod', true);
const as = (identity: IdentityPublic): Actor => ({ kind: 'identity', identity });
const CONSOLE: Actor = { kind: 'console' };

// [name, actor, request, target, true = allowed | a fragment of the refusal message]
type Row = [string, Actor, PowerRequest, IdentityPublic | null, true | string];
const rows: Row[] = [
  ['a player cannot delete messages', as(user), { action: 'delete-message' }, user2, 'Only moderators and admins'],
  ['a mod deletes a player message', as(mod), { action: 'delete-message' }, user, true],
  ['a mod cannot delete another mod message', as(mod), { action: 'delete-message' }, mod2, 'you can only moderate people below you'],
  ['a mod cannot act on an admin', as(mod), { action: 'mute', minutes: 5 }, admin, 'you can only moderate people below you'],
  ['nobody moderates themselves', as(admin), { action: 'mute', minutes: 5 }, admin, 'cannot moderate yourself'],
  ['an admin cannot act on another admin', as(admin), { action: 'suspend', minutes: null }, admin2, 'you can only moderate people below you'],
  ['a mod mutes for a day', as(mod), { action: 'mute', minutes: 1440 }, user, true],
  ['a mod cannot mute past a day', as(mod), { action: 'mute', minutes: 1441 }, user, 'at most 1440 minutes'],
  ['an admin cannot mute past a day either', as(admin), { action: 'mute', minutes: 1441 }, user, 'at most 1440 minutes'],
  ['a mod suspends for 7 days', as(mod), { action: 'suspend', minutes: 10080 }, user, true],
  ['a mod cannot suspend past 7 days', as(mod), { action: 'suspend', minutes: 10081 }, user, 'at most 7 days'],
  ['a mod cannot suspend permanently', as(mod), { action: 'suspend', minutes: null }, user, 'Only admins can suspend permanently'],
  ['an admin suspends permanently', as(admin), { action: 'suspend', minutes: null }, user, true],
  ['an admin suspends a mod', as(admin), { action: 'suspend', minutes: 60 }, mod, true],
  ['a mod lifts', as(mod), { action: 'lift' }, user, true],
  ['a mod reopens a report', as(mod), { action: 'reopen-report' }, null, true],
  ['a mod notes a report', as(mod), { action: 'note' }, null, true],
  ['a mod cannot change roles', as(mod), { action: 'role', role: 'mod' }, user, 'Only admins'],
  ['an admin makes a mod', as(admin), { action: 'role', role: 'mod' }, user, true],
  ['an admin demotes a mod', as(admin), { action: 'role', role: 'user' }, mod, true],
  ['an admin cannot make an admin', as(admin), { action: 'role', role: 'admin' }, user, 'Only the server console'],
  ['a mod cannot reset passwords', as(mod), { action: 'reset-password' }, user, 'Only admins'],
  ['an admin resets a password', as(admin), { action: 'reset-password' }, user, true],
  ['a mod cannot release', as(mod), { action: 'release' }, user, 'Only admins'],
  ['an admin releases', as(admin), { action: 'release' }, user, true],
  ['a mod cannot ban an IP', as(mod), { action: 'ip-ban' }, null, 'Only admins'],
  ['an admin bans an IP', as(admin), { action: 'ip-ban' }, null, true],
  ['an admin unbans an IP', as(admin), { action: 'ip-unban' }, null, true],
  ['a mod dismisses a report about an admin (no target)', as(mod), { action: 'resolve-report', resolution: 'dismiss' }, null, true],
  ['a mod resolves with a mute', as(mod), { action: 'resolve-report', resolution: 'mute', minutes: 30 }, user, true],
  ['a mod resolves with a too-long mute', as(mod), { action: 'resolve-report', resolution: 'mute', minutes: 2000 }, user, 'at most 1440 minutes'],
  ['a mod resolves with a permanent suspension', as(mod), { action: 'resolve-report', resolution: 'suspend' }, user, 'Only admins can suspend permanently'],
  ['the house deletes a message', as(house), { action: 'delete-message' }, user, true],
  ['the house mutes for an hour', as(house), { action: 'mute', minutes: 60 }, user, true],
  ['the house cannot mute past an hour', as(house), { action: 'mute', minutes: 61 }, user, 'at most 60 minutes'],
  ['the house cannot suspend', as(house), { action: 'suspend', minutes: 10 }, user, 'House moderators can only'],
  ['the house cannot lift', as(house), { action: 'lift' }, user, 'House moderators can only'],
  ['the house cannot reopen', as(house), { action: 'reopen-report' }, null, 'House moderators can only'],
  ['the house notes a report', as(house), { action: 'note' }, null, true],
  ['the house dismisses a report', as(house), { action: 'resolve-report', resolution: 'dismiss' }, null, true],
  ['the house resolves with a delete', as(house), { action: 'resolve-report', resolution: 'delete' }, user, true],
  ['the house resolves with an hour mute', as(house), { action: 'resolve-report', resolution: 'mute', minutes: 60 }, user, true],
  ['the house cannot resolve with a suspension', as(house), { action: 'resolve-report', resolution: 'suspend', minutes: 10 }, user, 'House moderators can only'],
  ['the house cannot ban IPs', as(house), { action: 'ip-ban' }, null, 'House moderators can only'],
  ['the console can make an admin', CONSOLE, { action: 'role', role: 'admin' }, user, true],
  ['the console can act on an admin', CONSOLE, { action: 'suspend', minutes: null }, admin, true],
  ['the console can mute for a week', CONSOLE, { action: 'mute', minutes: 10080 }, user, true],
];

describe('checkPower', () => {
  for (const [name, actor, req, target, want] of rows) {
    test(name, () => {
      if (want === true) {
        expect(() => checkPower(actor, req, target)).not.toThrow();
        return;
      }
      let err: AppError | null = null;
      try {
        checkPower(actor, req, target);
      } catch (e) {
        err = e as AppError;
      }
      expect(err?.status).toBe(403);
      expect(err?.code).toBe('FORBIDDEN_ROLE');
      expect(err?.message).toContain(want);
    });
  }
});

describe('assertStaff and actorName', () => {
  test('only the console, mods and admins are staff', () => {
    expect(() => assertStaff(as(user))).toThrow('Only moderators and admins');
    expect(() => assertStaff(as(mod))).not.toThrow();
    expect(() => assertStaff(as(house))).not.toThrow();
    expect(() => assertStaff(CONSOLE)).not.toThrow();
  });
  test('actors are named by handle, or "console"', () => {
    expect(actorName(as(mod))).toBe('mod');
    expect(actorName(CONSOLE)).toBe('console');
  });
});
