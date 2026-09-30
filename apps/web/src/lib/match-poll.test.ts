import { expect, test } from 'bun:test';
import type { MatchEnvelope } from '@cs/shared/protocol';
import { pollMatch } from './match-poll';

const env = (revision: number, status: 'live' | 'over' = 'live') =>
  ({ match: { id: 'm1', revision, status } }) as unknown as MatchEnvelope;

test('reads the match plainly every 200 ms, handing on only newer revisions, until it is over', async () => {
  const paths: string[] = [];
  const answers = [env(3), env(3), env(4), env(5, 'over')];
  const seen: number[] = [];
  const waits: number[] = [];
  await pollMatch(
    'm1',
    2,
    (e) => seen.push(e.match.revision),
    async (p) => (paths.push(p), answers.shift()!),
    new AbortController().signal,
    async (ms) => void waits.push(ms),
  );
  expect(seen).toEqual([3, 4, 5]);
  expect(paths).toEqual(Array(4).fill('/api/matches/m1'));
  expect(waits).toEqual([200, 200, 200]);
});

test('stops when aborted, and hands nothing on after the abort', async () => {
  const ctl = new AbortController();
  const seen: number[] = [];
  await pollMatch('m1', 1, (e) => seen.push(e.match.revision), async () => (ctl.abort(), env(2)), ctl.signal);
  expect(seen).toEqual([]);
});

test('backs off after an error, doubling to at most 10 s', async () => {
  const waits: number[] = [];
  let calls = 0;
  await pollMatch(
    'm1',
    1,
    () => {},
    async () => {
      calls += 1;
      if (calls <= 5) throw new Error('down');
      return env(2, 'over');
    },
    new AbortController().signal,
    async (ms) => void waits.push(ms),
  );
  expect(waits).toEqual([1000, 2000, 4000, 8000, 10000]);
});
