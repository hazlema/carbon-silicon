import { describe, expect, test } from 'bun:test';
import type { Doctrine } from '@cs/game-api';
import { clampFloor, DoctrineDesk, floorTicks } from './realtime';

const d = (label: string): Doctrine => ({ rules: [{ label, do: { act: 'straight' } }] });
const FALLBACK = d('fallback');

describe('floor', () => {
  test('is counted in whole ticks, rounding up', () => {
    expect(floorTicks(300, 100)).toBe(3);
    expect(floorTicks(250, 100)).toBe(3);
    expect(floorTicks(100, 100)).toBe(1);
    expect(floorTicks(50, 100)).toBe(1);
  });
  test('DOCTRINE_FLOOR_MS: default 300, clamped to 100–2000, nonsense warned about', () => {
    const warned: string[] = [];
    const warn = (m: string) => warned.push(m);
    expect(clampFloor(undefined, warn)).toBe(300);
    expect(clampFloor('', warn)).toBe(300);
    expect(clampFloor('450', warn)).toBe(450);
    expect(warned).toEqual([]);
    expect(clampFloor('20', warn)).toBe(100);
    expect(clampFloor('9000', warn)).toBe(2000);
    expect(clampFloor('fast', warn)).toBe(300);
    expect(warned).toHaveLength(3);
  });
});

describe('DoctrineDesk', () => {
  test('before the first tick every change applies at once', () => {
    const desk = new DoctrineDesk(['red', 'blue'], FALLBACK, 3);
    expect(desk.doctrineOf('red')).toBe(FALLBACK);
    expect(desk.set('red', d('a'))).toEqual({ status: 'applied', appliesAtTick: 0 });
    expect(desk.set('red', d('b'))).toEqual({ status: 'applied', appliesAtTick: 0 });
    expect(desk.doctrineOf('red').rules[0].label).toBe('b');
    desk.live = true;
    // The countdown doesn't start the floor: the first live change applies at once too.
    expect(desk.set('red', d('c')).status).toBe('applied');
  });

  test('a script sending a doctrine every tick changes at most once per floor; the newest pending one wins', () => {
    const desk = new DoctrineDesk(['red'], FALLBACK, 3);
    desk.live = true;
    const applied: number[] = [];
    for (let t = 0; t < 12; t++) {
      if (desk.beginTick().includes('red')) applied.push(desk.tick);
      const ack = desk.set('red', d(`t${t}`));
      if (ack.status === 'applied') applied.push(desk.tick);
      else expect(ack.appliesAtTick).toBe(applied.at(-1)! + 3);
      desk.decide('red', {});
      desk.endTick();
    }
    expect(applied).toEqual([0, 3, 6, 9]);
    // Each applied change was the newest sent: tick 3's came from t2, not t1.
    const desk2 = new DoctrineDesk(['red'], FALLBACK, 3);
    desk2.live = true;
    desk2.set('red', d('t0'));
    desk2.endTick();
    desk2.set('red', d('t1'));
    desk2.endTick();
    desk2.set('red', d('t2'));
    desk2.endTick();
    expect(desk2.pendingOf('red')?.rules[0].label).toBe('t2');
    expect(desk2.beginTick()).toEqual(['red']);
    expect(desk2.doctrineOf('red').rules[0].label).toBe('t2');
    expect(desk2.pendingOf('red')).toBeNull();
  });

  test('decide records the rule that fired, by index and label', () => {
    const desk = new DoctrineDesk(['red'], FALLBACK, 3);
    desk.set('red', { rules: [{ when: { sense: 'x', op: 'gt', value: 1 }, do: { act: 'turn', dir: 'left' } }, { label: 'else', do: { act: 'straight' } }] });
    expect(desk.decide('red', { x: 5 })).toEqual({ act: 'turn', dir: 'left' });
    expect(desk.fired.red).toEqual({ index: 0, label: null });
    desk.decide('red', { x: 0 });
    expect(desk.fired.red).toEqual({ index: 1, label: 'else' });
    desk.set('red', { rules: [{ when: { sense: 'x', op: 'gt', value: 1 }, do: { act: 'straight' } }] });
    expect(desk.decide('red', { x: 0 })).toBeNull();
    expect(desk.fired.red).toBeNull();
  });
});
