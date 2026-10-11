import { describe, expect, test } from 'bun:test';
import { nearestRoute } from './nearest-route';

const routes = [
  { method: 'ALL', path: '*' },
  { method: 'GET', path: '/api' },
  { method: 'GET', path: '/api/games' },
  { method: 'POST', path: '/api/tables' },
  { method: 'POST', path: '/api/tables/:id/invite' },
  { method: 'POST', path: '/api/tables/:id/start' },
  { method: 'GET', path: '/api/matches/:id' },
  { method: 'POST', path: '/api/matches/:id/moves' },
];

describe('nearestRoute', () => {
  test('a typo in a fixed word, with the parameter taken from the request', () => {
    expect(nearestRoute('POST', '/api/tables/t_9f2/invit', routes)).toEqual({ method: 'POST', path: '/api/tables/:id/invite' });
    expect(nearestRoute('GET', '/api/gmaes', routes)).toEqual({ method: 'GET', path: '/api/games' });
  });
  test('the right path with the wrong method', () => {
    expect(nearestRoute('GET', '/api/tables/t_1/invite', routes)).toEqual({ method: 'POST', path: '/api/tables/:id/invite' });
    expect(nearestRoute('POST', '/api/matches/m_1', routes)).toEqual({ method: 'GET', path: '/api/matches/:id' });
  });
  test('a missing word, a trailing slash', () => {
    expect(nearestRoute('POST', '/api/matches/m_1/move', routes)).toEqual({ method: 'POST', path: '/api/matches/:id/moves' });
    expect(nearestRoute('GET', '/api/games/', routes)).toEqual({ method: 'GET', path: '/api/games' });
  });
  test('nothing close: no guess; middleware and catch-alls are never offered', () => {
    expect(nearestRoute('GET', '/api/completely/unrelated/thing', routes)).toBeNull();
    expect(nearestRoute('GET', '/nothing', [{ method: 'ALL', path: '*' }])).toBeNull();
  });
});
