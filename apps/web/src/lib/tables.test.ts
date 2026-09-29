import { describe, expect, test } from 'bun:test';
import type { GameInfo, IdentityPublic, TableInfo } from '@cs/shared/protocol';
import { gameFor, gatherNote, inviteChoice, parseInviteCommand, secondsLeft, splitGame } from './tables';

const person = (id: string, handle = id): IdentityPublic => ({
  id, handle, kind: 'human', tagline: null, color: '#fff', model: null, isHouse: false, locked: false, role: 'user', ownerHandle: null, released: false,
});
const cm: GameInfo = { id: 'critical-mass', name: 'Critical Mass', tagline: '', mode: 'turn', minPlayers: 2, maxPlayers: 4, seats: [], humans: true };
const table = (over: Partial<TableInfo> = {}): TableInfo => ({
  id: 't_1', gameId: 'critical-mass', host: person('me'), status: 'forming', open: false, size: 4, minPlayers: 2,
  seated: [person('me')], invites: [], lastPlayers: [], matchId: null, watching: 0, ...over,
});

describe('gatherNote', () => {
  test('says how many more are needed, then when to start', () => {
    expect(gatherNote(table(), 'Critical Mass')).toBe('Critical Mass needs at least 2 players — invite 1 more to start.');
    const invite = (h: string) => ({ id: `i_${h}`, to: person(h), expiresAt: '2026-09-29T12:00:00.000Z' });
    expect(gatherNote(table({ invites: [invite('bob')] }), 'Critical Mass')).toBe('Waiting for @bob to accept.');
    expect(gatherNote(table({ size: 4, minPlayers: 3, invites: [invite('bob')] }), 'Critical Mass')).toBe('Critical Mass needs at least 3 players — invite 1 more to start.');
    expect(gatherNote(table({ invites: [invite('bob'), invite('cy')] }), 'Critical Mass')).toBe('Waiting for an invite to be accepted.');
    expect(gatherNote(table({ seated: [person('me'), person('b')] }), 'Critical Mass')).toBe("Enough to play — @me, start when you're ready.");
    const full = table({ seated: [person('me'), person('b'), person('c'), person('d')] });
    expect(gatherNote(full, 'Critical Mass')).toBe("The table is full — @me, start when you're ready.");
  });
});

describe('secondsLeft', () => {
  test('rounds up and never goes below zero', () => {
    expect(secondsLeft(new Date(10_500).toISOString(), 0)).toBe(11);
    expect(secondsLeft(new Date(0).toISOString(), 5000)).toBe(0);
  });
});

describe('/invite', () => {
  test('parses names with or without @ and commas', () => {
    expect(parseInviteCommand('/invite @DiceRoller, bob  cat')).toEqual(['DiceRoller', 'bob', 'cat']);
    expect(parseInviteCommand('/INVITE')).toEqual([]);
    expect(parseInviteCommand('hello /invite bob')).toBeNull();
  });
  test('a trailing game id picks the game; otherwise the channel or the only game does', () => {
    expect(splitGame(['bob', 'critical-mass'], [cm])).toEqual({ handles: ['bob'], game: cm });
    expect(splitGame(['bob'], [cm])).toEqual({ handles: ['bob'], game: null });
    expect(gameFor(null, 'critical-mass', [cm, { ...cm, id: 'lightline' }])?.id).toBe('critical-mass');
    expect(gameFor(null, 'lobby', [cm])?.id).toBe('critical-mass');
    expect(gameFor(null, 'lobby', [cm, { ...cm, id: 'lightline' }])).toBeNull();
  });
});

describe('inviteChoice', () => {
  const me = person('me');
  const bob = person('bob');
  test('while hosting: invite, greyed out with the reason when it cannot go', () => {
    expect(inviteChoice(bob, { me, status: 'ready', myTable: table(), catalog: [cm] })).toEqual({ kind: 'invite', label: 'Invite to Critical Mass', disabled: null });
    expect(inviteChoice(bob, { me, status: 'afk', myTable: table(), catalog: [cm] })).toMatchObject({ disabled: 'AFK right now' });
    expect(inviteChoice(bob, { me, status: 'playing', myTable: table(), catalog: [cm] })).toMatchObject({ disabled: 'In a match' });
    const full = table({ seated: [me, person('b'), person('c'), person('d')] });
    expect(inviteChoice(bob, { me, status: 'ready', myTable: full, catalog: [cm] })).toMatchObject({ disabled: 'Your table is full' });
    const invited = table({ invites: [{ id: 'i_1', to: bob, expiresAt: '' }] });
    expect(inviteChoice(bob, { me, status: 'ready', myTable: invited, catalog: [cm] })).toMatchObject({ disabled: 'Already at your table' });
  });
  test('not hosting: host a game with them; at someone else’s table or for yourself: nothing', () => {
    expect(inviteChoice(bob, { me, status: 'ready', myTable: null, catalog: [cm] })).toEqual({ kind: 'host', games: [cm] });
    expect(inviteChoice(me, { me, status: 'ready', myTable: null, catalog: [cm] })).toBeNull();
    expect(inviteChoice(bob, { me, status: 'ready', myTable: table({ host: bob }), catalog: [cm] })).toBeNull();
  });
});
