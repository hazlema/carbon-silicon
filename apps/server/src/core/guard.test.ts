import { describe, expect, test } from 'bun:test';
import type { IdentityPublic } from '@cs/shared/protocol';
import { forbidden } from '../lib/errors';
import { Guard } from './guard';

const who = { id: 'id_x', handle: 'x' } as IdentityPublic;

describe('Guard', () => {
  test('lets everything through until a check is installed', () => {
    expect(() => new Guard().assert(who, 'chat')).not.toThrow();
  });
  test('runs the installed check with the identity and the action', () => {
    const guard = new Guard();
    const seen: string[] = [];
    guard.install((identity, action) => {
      seen.push(`${identity.id}:${action}`);
      if (action === 'play') throw forbidden('SUSPENDED', 'no');
    });
    guard.assert(who, 'chat');
    expect(() => guard.assert(who, 'play')).toThrow('no');
    expect(seen).toEqual(['id_x:chat', 'id_x:play']);
  });
});
