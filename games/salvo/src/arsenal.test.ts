import { describe, expect, test } from 'bun:test';
import { clusterCells, dealCrate, ITEMS, lanesFor, torpedoLane } from './arsenal';

describe('arsenal geometry', () => {
  test('a cluster is the plus around its cell, clipped to the sea', () => {
    expect(clusterCells('c4')).toEqual(['c4', 'c3', 'b4', 'd4', 'c5']);
    expect(clusterCells('a1')).toEqual(['a1', 'b1', 'a2']);
  });
  test('torpedoes run away from the shooter', () => {
    expect(torpedoLane('north', 'c')).toEqual(['c8', 'c7', 'c6', 'c5', 'c4', 'c3', 'c2', 'c1']);
    expect(torpedoLane('south', 'c')).toEqual(['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8']);
    expect(torpedoLane('east', '3')).toEqual(['h3', 'g3', 'f3', 'e3', 'd3', 'c3', 'b3', 'a3']);
    expect(torpedoLane('west', '3')).toEqual(['a3', 'b3', 'c3', 'd3', 'e3', 'f3', 'g3', 'h3']);
    expect(torpedoLane('north', '3')).toBeNull();
    expect(lanesFor('east')).toEqual(['1', '2', '3', '4', '5', '6', '7', '8']);
  });
  test('a crate is three different items, the same for the same seed and draw', () => {
    const c = dealCrate(7, 0);
    expect(new Set(c).size).toBe(3);
    expect(c.every((x) => ITEMS.includes(x))).toBe(true);
    expect(dealCrate(7, 0)).toEqual(c);
    expect(new Set(Array.from({ length: 20 }, (_, i) => dealCrate(7, i).join())).size).toBeGreaterThan(1);
  });
});
