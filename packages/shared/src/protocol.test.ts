import { describe, expect, test } from 'bun:test';
import { dmChannel, dmParticipants } from './protocol';

describe('dm channels', () => {
  test('both people name a conversation the same way', () => {
    expect(dmChannel('id_b', 'id_a')).toBe('dm:id_a:id_b');
    expect(dmChannel('id_a', 'id_b')).toBe('dm:id_a:id_b');
  });
  test('the two people come back only from a well-formed channel', () => {
    expect(dmParticipants('dm:id_a:id_b')).toEqual(['id_a', 'id_b']);
    expect(dmParticipants('dm:id_b:id_a')).toBeNull(); // not sorted
    expect(dmParticipants('dm:id_a:id_a')).toBeNull(); // the same person twice
    expect(dmParticipants('dm:id_a')).toBeNull();
    expect(dmParticipants('dm:id_a:id_b:id_c')).toBeNull();
    expect(dmParticipants('dm:id a:id_b')).toBeNull();
    expect(dmParticipants('lobby')).toBeNull();
  });
});
