# M3b "Controls" Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix M3a's five "worth doing soon" findings, then let a signed-in human steer a Lightline cycle with keys or swipes, and open Lightline to humans.

**Architecture:** The fixes live in the game manager (`apps/server/src/core/games.ts`), the bots' real-time loop, and the table page. Steering is generic in the engine: a game declares `SteerRules` (which keys queue, which ride along, and how they become an action) and `paused()`. The server keeps a `SteerQueue` per human seat beside the `DoctrineDesk`, fed by a new WebSocket message, `steer`. The web board maps keys and swipes to `steer` messages.

**Tech Stack:** Bun, TypeScript, Drizzle on Postgres/PGlite, SvelteKit (Svelte 5 runes), Playwright.

**Spec:** `docs/superpowers/specs/2026-09-30-m3b-controls-design.md`

## Global Constraints

- The steer keys are exactly `n`, `e`, `s`, `w` (these queue) and `boost` (it rides on the next action).
- The queue holds at most 2 moves. A third press replaces the last one queued, and a press that repeats the last queued move is dropped.
- Presses during the countdown and while `paused(state)` is true (Lightline's intermission) are dropped.
- A human seat never runs doctrine. Its `fired` entry is the string `'steering'`.
- `PUT /api/matches/:id/doctrine` from a human's seat answers `409 HUMAN_STEERS`, with the message "You steer with the keys; doctrine is for machines."
- After 20 tick failures in a row, the match is abandoned with `endReason: 'tick-failed'`.
- `createMatch` after `close()` answers `503 SHUTTING_DOWN`.
- A swipe or tap threshold is 24 CSS px. A move under it is a tap, and a tap means `boost`.
- The key map is: ArrowUp/KeyW → `n`, ArrowRight/KeyD → `e`, ArrowDown/KeyS → `s`, ArrowLeft/KeyA → `w`, Space → `boost`. Key repeats and presses with a modifier (Alt/Ctrl/Meta) are ignored.
- The countdown hint reads "Arrows or WASD to steer · Space to boost", or "Swipe to steer · Tap to boost" on a coarse pointer.
- Every commit ends with a blank line, then `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- `bun run verify` (typecheck, unit tests, web build, e2e) is green at the end of every task.
- Commit subjects follow the repo's style: `Area: what changed, in plain words` (e.g. `Server: …`, `Web: …`, `Bots: …`, `Docs: …`).

## Review Focus

1. **A human presses a key while typing in table chat.** No steer message may go out, and the letter must land in the chat box. This is covered in Task 7's `typing()` unit test and its e2e.
2. **Holding an arrow key down.** Browsers send `repeat` keydowns about 30 times a second. Only the first press may count, or the queue churns. This is covered by Task 7's `keyOf` test (repeat → null) and Task 4's repeat-drop test.
3. **A reversal pressed as the first move** (for example ArrowLeft while heading east). Lightline's `step` already treats it as straight. The queue must pass it through, not special-case it, so a following turn still works. This is covered by a Task 5 runner test.
4. **A human's socket reconnecting mid-match.** `steer` needs no subscription, only `ws.data.identity`. A reconnected socket must steer at once, without re-watching. This is covered by a Task 5 hub test that opens a fresh socket and steers.
5. **A guest's long-poll outliving the page, or a rematch.** The loop must stop when the match id changes or the page unmounts, or two loops race and old envelopes flicker in. This is covered by Task 3's `pollMatch` abort test.

---

### Task 1: Server — the runner's three fixes (failing ticks, unguarded senses, timers after close)

**Files:**
- Modify: `apps/server/src/lib/errors.ts:1` (ErrorStatus gains 503)
- Modify: `apps/server/src/core/games.ts` (LiveMatch, createMatch, startTurn, finish, tick, envelope, new `abandon`)
- Modify: `packages/shared/src/protocol.ts:78-86` (`RealtimeEnvelope.you.senses` may be null)
- Test: `apps/server/src/core/games-realtime.test.ts`

**Interfaces:**
- Produces: `GameManager` private `abandon(m, reason)`, `LiveMatch.failures: number`, the `SHUTTING_DOWN` 503, and `RealtimeEnvelope.you.senses: Record<…> | null`.

- [ ] **Step 1: Write the failing tests.** In `games-realtime.test.ts`, replace the test `'a tick that throws is logged and skipped; the match keeps ticking'` with the two tests below. Then add the envelope and close tests inside the same `describe`.

```ts
  test('a tick that throws is logged and skipped; the match keeps ticking, and a good tick resets the count', async () => {
    let boom = false;
    const rt = lightlineGame.realtime!;
    const flaky: GameModule<any> = {
      ...lightlineGame,
      realtime: { ...rt, step: (s, a, r) => { if (boom) throw new Error('boom'); return rt.step(s, a, r); } },
    };
    const ctx = await setup({}, flaky);
    const m = await ctx.games.createMatch('lightline', [ctx.a, ctx.b]);
    ctx.clock.advance(10_200);
    const errors: unknown[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => void errors.push(args);
    try {
      for (let i = 0; i < 2; i++) {
        boom = true;
        ctx.clock.advance(1900); // 19 failures: not yet 20
        boom = false;
        ctx.clock.advance(100); // one good tick resets the count
      }
    } finally {
      console.error = original;
    }
    expect(errors).toHaveLength(38);
    expect(ctx.games.summary(m.id).status).toBe('live');
  });

  test('twenty failing ticks in a row abandon the match: seats freed, the table told, no more ticks', async () => {
    const rt = lightlineGame.realtime!;
    const broken: GameModule<any> = { ...lightlineGame, realtime: { ...rt, step: () => { throw new Error('boom'); } } };
    const ctx = await setup({}, broken);
    const finished: string[] = [];
    ctx.bus.on('match.finished', ({ matchId }) => void finished.push(matchId));
    const m = await ctx.games.createMatch('lightline', [ctx.a, ctx.b]);
    ctx.clock.advance(10_000);
    const original = console.error;
    const errors: unknown[] = [];
    console.error = (...args: unknown[]) => void errors.push(args);
    try {
      ctx.clock.advance(2000);
      await Bun.sleep(20);
    } finally {
      console.error = original;
    }
    const s = ctx.games.summary(m.id);
    expect([s.status, s.endReason]).toEqual(['abandoned', 'tick-failed']);
    expect(finished).toEqual([m.id]);
    expect(ctx.games.activeMatchOf(ctx.a.id)).toBeNull();
    expect(errors.length).toBe(20);
    const rev = s.revision;
    ctx.clock.advance(1000);
    expect(ctx.games.summary(m.id).revision).toBe(rev);
  });

  test('a senses bug never breaks the envelope: your senses read null, and it is logged', async () => {
    const rt = lightlineGame.realtime!;
    const blind: GameModule<any> = { ...lightlineGame, realtime: { ...rt, senses: () => { throw new Error('blind'); } } };
    // The tick would fail too; only the envelope is under test, in the countdown.
    const ctx = await setup({}, blind);
    const m = await ctx.games.createMatch('lightline', [ctx.a, ctx.b]);
    const original = console.error;
    const errors: unknown[] = [];
    console.error = (...args: unknown[]) => void errors.push(args);
    try {
      const env = ctx.games.envelope(m.id, ctx.a.id);
      expect(env.realtime?.you?.senses).toBeNull();
      expect(env.realtime?.you?.doctrine).toBeDefined();
    } finally {
      console.error = original;
    }
    expect(errors).toHaveLength(1);
  });

  test('after close, no new match starts and a finishing match sets no retain timer', async () => {
    const ctx = await setup();
    const m = await ctx.games.createMatch('critical-mass', [ctx.a, ctx.b]);
    ctx.games.close();
    await expect(ctx.games.createMatch('lightline', [ctx.c, await ctx.agent('lld')])).rejects.toMatchObject({ status: 503, code: 'SHUTTING_DOWN' });
    const timers = ctx.clock.pending();
    await ctx.games.resign(m.id, ctx.a); // finish() runs after close
    expect(ctx.clock.pending()).toBe(timers);
  });
```

`setup` must also return `bus`. Change its return line to `return { clock, bus, comms, games, a, b, c, human, agent };`. If `FakeClock` has no `pending()`, add one to `apps/server/src/lib/clock.ts` that returns the number of timers not yet fired or cleared, with a one-line doc comment.

- [ ] **Step 2: Run the tests and see them fail.**
Run: `bun test apps/server/src/core/games-realtime.test.ts`
Expected: the four new tests FAIL. The abandon test sees status `live`, the senses test gets a thrown `blind`, and `createMatch` resolves instead of rejecting.

- [ ] **Step 3: Implement.**

In `errors.ts`, change the first line to:
```ts
export type ErrorStatus = 400 | 401 | 403 | 404 | 409 | 410 | 413 | 429 | 500 | 503;
```

In `protocol.ts` `RealtimeEnvelope.you`:
```ts
    /** Null when the game could not work out your senses this tick (logged on the server). */
    senses: Record<string, number | string | boolean> | null;
```

In `games.ts`:
- Add a constant under `resultFor`: `/** A real-time match whose ticks fail this many times in a row is abandoned. */ const MAX_TICK_FAILURES = 20;`
- `LiveMatch` gains `failures: number;`, and `createMatch` initialises it as `failures: 0,`.
- The first line of `createMatch`'s body: `if (this.closed) throw new AppError(503, 'SHUTTING_DOWN', 'The server is shutting down; try again in a moment.');`
- `startTurn`: after `if (!m.module.turn) return;`, add `if (this.closed) return;`.
- `finish`: replace the retain line with `if (!this.closed) m.timer = this.clock.setTimeout(() => this.matches.delete(m.id), this.opts.retainMs);`
- `tick`: replace the body's `try/catch` with:

```ts
    try {
      // … the existing body, unchanged, up to and including this.advance(...) …
      m.failures = 0;
    } catch (e) {
      m.failures += 1;
      console.error(`[games] a tick of ${m.id} failed (${m.failures} in a row)`, e);
      if (m.failures >= MAX_TICK_FAILURES) {
        this.abandon(m, 'tick-failed').catch((e2) => console.error(`[games] could not abandon ${m.id}`, e2));
        return;
      }
    }
    if (m.status === 'live') this.scheduleTick(m);
```

- The new method, placed after `finish`:

```ts
  /**
   * A match that can't go on (its ticks keep failing): nobody wins or loses, the seats go free, and
   * the table hears. Recorded the way a restart records one, as abandoned.
   */
  private async abandon(m: LiveMatch, reason: string): Promise<void> {
    this.clock.clearTimeout(m.timer);
    m.status = 'abandoned';
    m.endReason = reason;
    m.deadline = null;
    m.revision += 1;
    for (const s of m.seats) this.release(m, s.identity.id);
    this.changed(m);
    this.bus.emit('match.finished', { matchId: m.id, tableId: m.tableId });
    m.timer = this.closed ? null : this.clock.setTimeout(() => this.matches.delete(m.id), this.opts.retainMs);
    try {
      await this.db.transaction(async (tx) => {
        await tx.update(matches).set({ status: 'abandoned', endReason: reason, endedAt: new Date(this.clock.now()) }).where(eq(matches.id, m.id));
        await tx.update(matchPlayers).set({ result: 'abandoned' }).where(eq(matchPlayers.matchId, m.id));
      });
    } catch (e) {
      console.error(`[games] could not record ${m.id} as abandoned`, e);
    }
    await this.comms.postSystem(this.chatOf(m), 'The match broke down and was abandoned. Nobody wins or loses.');
  }
```

- `envelope`: compute `you` senses through a guard:

```ts
    const senses = (seat: SeatId) => {
      try {
        return rt!.senses(m.state, seat);
      } catch (e) {
        console.error(`[games] senses for ${m.id}/${seat} failed`, e);
        return null;
      }
    };
```
Then use `senses(you)` in place of `rt.senses(m.state, you)`.

- Update the docblock above `tick` to: "A tick that throws is logged and skipped; the next one still comes, unless 20 in a row have failed, and then the match is abandoned."

`tables.ts`'s `onFinished(tableId, matchId)` reads no outcome: it marks the table `finished` and frees its seats. So the `match.finished` event is all the table needs, and Rematch works after an abandon.

- [ ] **Step 4: Run the tests and see them pass.**
Run: `bun test apps/server/src/core/games-realtime.test.ts apps/server/src/core/tables.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit.**
Run `bun run typecheck && bun test`. The web may need a `senses` null-check where it reads `realtime.you.senses`; grep `apps/web/src` for `.senses` and guard it. Then:
```bash
git add -A apps/server packages/shared apps/web/src
git commit -m "Server: a real-time match abandons after 20 failing ticks, a senses bug no longer breaks the envelope, and nothing starts a timer after close

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Bots — doctrine sends survive server and network errors

**Files:**
- Modify: `apps/bots/src/bot.ts:225-250` (`playRealtime`: exported, and gains a `pollMs` parameter)
- Test: `apps/bots/src/lightline.test.ts` (unit tests at the bottom, with a fake client)

**Interfaces:**
- Produces: `export async function playRealtime(client: Client, opts: BotOptions, matchId: string, env: MatchEnvelope, log: (m: string) => void, pollMs = 1000): Promise<MatchEnvelope>`

A spec correction, recorded as a ruling: a 4xx refusal is logged and **stays marked sent**. The same doctrine would be refused the same way, so resending it every second would only spam. A 5xx or network error is **not** marked sent, so the next pass (one `pollMs` later) retries it. Neither escapes `playMatch`.

- [ ] **Step 1: Write the failing tests** at the end of `lightline.test.ts`.

```ts
import { playRealtime } from './bot';
import { ApiError } from './client';
import type { MatchEnvelope } from '@cs/shared/protocol';

const envOf = (status: 'live' | 'over', shrinking = false): MatchEnvelope => ({
  match: { id: 'm1', gameId: 'lightline', status, revision: 1, seats: [], toMove: [], deadline: null, startsAt: '', outcome: null, endReason: null, tableId: null },
  you: 'red',
  view: {},
  legal: [],
  realtime: { tick: 0, fired: {}, you: { senses: { shrinking }, doctrine: { rules: [] }, pending: null } },
});

function fakeClient(doctrineResults: (Error | null)[], polls: MatchEnvelope[]) {
  const sent: unknown[] = [];
  return {
    sent,
    client: {
      doctrine: async (_id: string, d: unknown) => {
        sent.push(d);
        const r = doctrineResults.shift();
        if (r) throw r;
        return {};
      },
      match: async () => polls.shift() ?? envOf('over'),
    } as unknown as Client,
  };
}
const opts = { personality: sprocket } as unknown as Parameters<typeof playRealtime>[1];

test('a 5xx doctrine send is retried on the next pass, and never escapes', async () => {
  const f = fakeClient([new ApiError(503, 'SHUTTING_DOWN', 'x'), null], [envOf('live'), envOf('over')]);
  const logs: string[] = [];
  await playRealtime(f.client, opts, 'm1', envOf('live'), (m) => logs.push(m), 1);
  expect(f.sent).toHaveLength(2);
  expect(logs.some((l) => l.includes('retrying'))).toBe(true);
});

test('a network error is retried the same way', async () => {
  const f = fakeClient([new TypeError('fetch failed'), null], [envOf('live'), envOf('over')]);
  await playRealtime(f.client, opts, 'm1', envOf('live'), () => {}, 1);
  expect(f.sent).toHaveLength(2);
});

test('a 4xx refusal is logged once and not resent', async () => {
  const f = fakeClient([new ApiError(400, 'BAD_DOCTRINE', 'nope')], [envOf('live'), envOf('live'), envOf('over')]);
  const logs: string[] = [];
  await playRealtime(f.client, opts, 'm1', envOf('live'), (m) => logs.push(m), 1);
  expect(f.sent).toHaveLength(1);
  expect(logs.filter((l) => l.includes('refused'))).toHaveLength(1);
});
```

- [ ] **Step 2: Run the tests and see them fail.**
Run: `bun test apps/bots/src/lightline.test.ts -t "doctrine send|network error|4xx refusal"`
Expected: FAIL, because `playRealtime` isn't exported.

- [ ] **Step 3: Implement.** In `bot.ts`, export `playRealtime`, add `pollMs = 1000` as the last parameter, use `await sleep(pollMs, opts.signal)`, and replace the send block with:

```ts
    if (env.match.gameId === 'lightline' && env.you && shrinking !== sent) {
      try {
        await client.doctrine(matchId, lightlineDoctrine(style, shrinking));
        sent = shrinking;
      } catch (e) {
        if (e instanceof ApiError && e.status < 500) {
          // Refused: the same orders would be refused again, so ride the default rather than resend.
          log(`doctrine for ${matchId} refused: ${e.message}`);
          sent = shrinking;
        } else {
          log(`doctrine for ${matchId} failed: ${(e as Error).message}; retrying`);
        }
      }
    }
```

Update the docblock's first line to: "Real-time: send standing orders, then watch. A send that fails on the server's side or the network's is retried on the next pass; a refused one is not."

- [ ] **Step 4: Run the tests and see them pass.**
Run: `bun test apps/bots/src/lightline.test.ts`
Expected: PASS, including the two existing match tests.

- [ ] **Step 5: Commit.**
```bash
git add apps/bots/src/bot.ts apps/bots/src/lightline.test.ts
git commit -m "Bots: a doctrine send that fails on the server or the network is retried on the next pass; a refused one is logged once

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Web — guests watching a table see it move

**Files:**
- Create: `apps/web/src/lib/match-poll.ts`
- Test: `apps/web/src/lib/match-poll.test.ts`
- Modify: `apps/web/src/routes/t/[id]/+page.svelte` (the match `$effect`, around lines 76-96)
- Modify: `e2e/lightline.e2e.ts` (the exhibition test watches as a guest who never enters a name)

**Interfaces:**
- Produces: `pollMatch(matchId: string, since: number, onEnvelope: (e: MatchEnvelope) => void, get: (path: string) => Promise<MatchEnvelope>, signal: AbortSignal, sleep?: (ms: number) => Promise<void>): Promise<void>`

- [ ] **Step 1: Write the failing test,** `apps/web/src/lib/match-poll.test.ts`:

```ts
import { expect, test } from 'bun:test';
import type { MatchEnvelope } from '@cs/shared/protocol';
import { pollMatch } from './match-poll';

const env = (revision: number, status: 'live' | 'over' = 'live') =>
  ({ match: { id: 'm1', revision, status } }) as unknown as MatchEnvelope;

test('long-polls from the last revision seen until the match is over', async () => {
  const paths: string[] = [];
  const answers = [env(3), env(4), env(5, 'over')];
  const seen: number[] = [];
  await pollMatch('m1', 2, (e) => seen.push(e.match.revision), async (p) => (paths.push(p), answers.shift()!), new AbortController().signal);
  expect(seen).toEqual([3, 4, 5]);
  expect(paths).toEqual(['/api/matches/m1?since=2&waitMs=25000', '/api/matches/m1?since=3&waitMs=25000', '/api/matches/m1?since=4&waitMs=25000']);
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
    'm1', 1, () => {},
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
```

The parameter is `waitMs`, as the agents and `tables.http.test.ts` use it. If `docs/API.md` §"Playing a match" caps it below 25 000, use the cap, and update the expected paths to match.

- [ ] **Step 2: Run the test and see it fail.**
Run: `bun test apps/web/src/lib/match-poll.test.ts`
Expected: FAIL, "Cannot find module './match-poll'".

- [ ] **Step 3: Implement** `apps/web/src/lib/match-poll.ts`:

```ts
import type { MatchEnvelope } from '@cs/shared/protocol';

const WAIT_MS = 25_000;
const nap = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * A guest has no socket, so a guest's table page follows its match the way agents do: a long-poll
 * that answers as soon as the revision moves (once a tick in a real-time game). It stops when the
 * match is over or `signal` aborts, and backs off 1 s, 2 s, … 10 s after an error.
 */
export async function pollMatch(
  matchId: string,
  since: number,
  onEnvelope: (e: MatchEnvelope) => void,
  get: (path: string) => Promise<MatchEnvelope>,
  signal: AbortSignal,
  sleep: (ms: number) => Promise<void> = nap,
): Promise<void> {
  let rev = since;
  let backoff = 1000;
  while (!signal.aborted) {
    let e: MatchEnvelope;
    try {
      e = await get(`/api/matches/${matchId}?since=${rev}&waitMs=${WAIT_MS}`);
    } catch {
      if (signal.aborted) return;
      await sleep(backoff);
      backoff = Math.min(10_000, backoff * 2);
      continue;
    }
    if (signal.aborted) return;
    backoff = 1000;
    rev = Math.max(rev, e.match.revision);
    onEnvelope(e);
    if (e.match.status === 'over' || e.match.status === 'abandoned') return;
  }
}
```

In `+page.svelte`'s match `$effect`, after `const off = live.watchMatch(mid, accept);`, start a guest loop when there's no signed-in person, and stop it in the cleanup:

```ts
    const ctl = new AbortController();
    api<MatchEnvelope>('GET', `/api/matches/${mid}`)
      .then((e) => {
        if (!alive) return;
        accept(e);
        // No socket for a guest: follow the match by long-poll instead, or the board would freeze.
        if (!untrack(() => live.me)) void pollMatch(mid, e.match.revision, accept, (p) => api<MatchEnvelope>('GET', p), ctl.signal);
      })
      .catch(/* unchanged */);
    return () => {
      alive = false;
      ctl.abort();
      off();
    };
```

Import `pollMatch` from `$lib/match-poll`.

In `e2e/lightline.e2e.ts`'s exhibition test, remove the `enter(...)` line and its comment, and make the watcher a plain guest instead: `const page = await newPlayer(browser);` with the comment `// A guest who never picks a name: no socket, so the board follows by long-poll.` If the name gate hides the table page from a guest, that is the frozen-board case the fix is for; read how `/t/[id]` renders behind the gate and keep the test's assertions (clock moving, `cruise` visible) unchanged.

- [ ] **Step 4: Run the tests and see them pass.**
Run: `bun test apps/web/src/lib/match-poll.test.ts && bun run build && bunx playwright test e2e/lightline.e2e.ts -g exhibition`
Expected: PASS.

- [ ] **Step 5: Commit.**
```bash
git add apps/web/src/lib/match-poll.ts apps/web/src/lib/match-poll.test.ts "apps/web/src/routes/t/[id]/+page.svelte" e2e/lightline.e2e.ts
git commit -m "Web: a guest watching a table follows the match by long-poll, so the board moves without a socket

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Engine — steer rules for games, and the steer queue

**Files:**
- Modify: `packages/game-api/src/types.ts:95-106` (`SteerRules`, and `paused` and `steer` on `RealtimeRules`)
- Modify: `packages/game-api/src/index.ts` (export `SteerRules` if types are re-exported by name)
- Modify: `games/lightline/src/index.ts` (implement `paused` and `steer`)
- Modify: `apps/server/src/core/realtime.ts` (add `SteerQueue`)
- Test: `apps/server/src/core/realtime.test.ts`, `games/lightline/src/engine.test.ts`

**Interfaces:**
- Produces:
```ts
// packages/game-api
export interface SteerRules {
  /** Keys that queue, at most two waiting (Lightline: n, e, s, w). */
  moves: readonly string[];
  /** Keys that ride on the next action taken instead of queueing (Lightline: boost). */
  modifiers: readonly string[];
  /** One tick's action: the queued move (null when none) with the modifiers pressed since the last. */
  action(move: string | null, modifiers: readonly string[]): Action;
}
// RealtimeRules<S> gains:
//   paused?(state: S): boolean;   // between rounds: nothing moves, and a person's presses are dropped
//   steer?: SteerRules;           // how a person's keys become actions; a game without it can't be steered

// apps/server/src/core/realtime.ts
export class SteerQueue {
  constructor(rules: SteerRules);
  press(key: string): boolean;   // false: not a key this game knows
  take(): Action;                // this tick's action; clears the modifiers
  clear(): void;                 // drop everything (countdown, pause)
}
```

- [ ] **Step 1: Write the failing tests.** In `realtime.test.ts`:

```ts
import { lightlineGame } from '@cs/lightline';
import { SteerQueue } from './realtime';

describe('SteerQueue', () => {
  const rules = lightlineGame.realtime!.steer!;
  test('an empty queue rides straight', () => {
    expect(new SteerQueue(rules).take()).toEqual({ act: 'straight' });
  });
  test('holds two moves; a third replaces the last; one taken per tick', () => {
    const q = new SteerQueue(rules);
    q.press('n');
    q.press('w');
    q.press('s');
    expect(q.take()).toEqual({ act: 'head', dir: 'n' });
    expect(q.take()).toEqual({ act: 'head', dir: 's' });
    expect(q.take()).toEqual({ act: 'straight' });
  });
  test('a press repeating the last queued move is dropped', () => {
    const q = new SteerQueue(rules);
    q.press('e');
    q.press('e');
    q.press('n');
    expect([q.take(), q.take()]).toEqual([{ act: 'head', dir: 'e' }, { act: 'head', dir: 'n' }]);
  });
  test('boost rides on the next action, or on straight, once', () => {
    const q = new SteerQueue(rules);
    q.press('boost');
    expect(q.take()).toEqual({ act: 'straight', boost: true });
    q.press('n');
    q.press('boost');
    expect(q.take()).toEqual({ act: 'head', dir: 'n', boost: true });
    expect(q.take()).toEqual({ act: 'straight' });
  });
  test('unknown keys are refused; clear drops everything', () => {
    const q = new SteerQueue(rules);
    expect(q.press('up')).toBe(false);
    q.press('n');
    q.press('boost');
    q.clear();
    expect(q.take()).toEqual({ act: 'straight' });
  });
});
```

In `games/lightline/src/engine.test.ts`:

```ts
import { lightlineGame } from './index';

test('Lightline is paused between rounds only, and its steer keys make valid doctrine actions', () => {
  const rt = lightlineGame.realtime!;
  const s = lightlineGame.setup({ seats: ['red', 'blue'], seed: 1 });
  expect(rt.paused!(s)).toBe(false);
  expect(rt.paused!({ ...s, phase: 'intermission' })).toBe(true);
  expect(rt.steer!.action('w', ['boost'])).toEqual({ act: 'head', dir: 'w', boost: true });
  expect(rt.steer!.action(null, [])).toEqual({ act: 'straight' });
});
```

- [ ] **Step 2: Run the tests and see them fail.**
Run: `bun test apps/server/src/core/realtime.test.ts games/lightline/src/engine.test.ts`
Expected: FAIL (`SteerQueue` isn't exported, and `steer` is undefined).

- [ ] **Step 3: Implement.** Add `SteerRules`, `paused?` and `steer?` to `types.ts`, with the doc comments from the Interfaces block. Export `SteerRules` wherever `RealtimeRules` is exported. In Lightline's `realtime`:

```ts
    paused: (s) => s.phase === 'intermission',
    steer: {
      moves: ['n', 'e', 's', 'w'],
      modifiers: ['boost'],
      action: (move, mods) => ({ ...(move ? { act: 'head', dir: move } : { act: 'straight' }), ...(mods.includes('boost') ? { boost: true } : {}) }),
    },
```

In `realtime.ts`:

```ts
/** The most moves a person may have waiting: enough for a quick double turn, not a macro. */
export const STEER_QUEUE_MAX = 2;

/**
 * A person's keys in one real-time match. Moves queue (a third replaces the last, and a repeat of
 * the last is dropped), modifiers ride on the next action, and each tick takes one. Humans have no
 * reaction floor: their own reflexes are the floor.
 */
export class SteerQueue {
  private moves: string[] = [];
  private mods = new Set<string>();

  constructor(private rules: SteerRules) {}

  press(key: string): boolean {
    if (this.rules.modifiers.includes(key)) {
      this.mods.add(key);
      return true;
    }
    if (!this.rules.moves.includes(key)) return false;
    if (this.moves.at(-1) === key) return true;
    if (this.moves.length >= STEER_QUEUE_MAX) this.moves[this.moves.length - 1] = key;
    else this.moves.push(key);
    return true;
  }

  take(): Action {
    const action = this.rules.action(this.moves.shift() ?? null, [...this.mods]);
    this.mods.clear();
    return action;
  }

  clear(): void {
    this.moves = [];
    this.mods.clear();
  }
}
```

Import `SteerRules` from `@cs/game-api`.

- [ ] **Step 4: Run the tests and see them pass.**
Run: `bun test apps/server/src/core/realtime.test.ts games/lightline && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit.**
```bash
git add packages/game-api games/lightline apps/server/src/core/realtime.ts apps/server/src/core/realtime.test.ts
git commit -m "Engine: games declare steer rules and a pause; a steer queue holds a person's next two moves

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Server — humans steer over the WebSocket

**Files:**
- Modify: `packages/shared/src/protocol.ts` (`WsClientMsg` gains steer, and `RealtimeEnvelope.fired` may be `'steering'`)
- Modify: `apps/server/src/core/realtime.ts` (`DoctrineDesk.fired` type)
- Modify: `apps/server/src/core/games.ts` (`LiveMatch.steer`, `steer()`, `tick`, `setDoctrine`)
- Modify: `apps/server/src/ws/hub.ts` (`case 'steer'`)
- Modify: `apps/web/src/lib/games/lightline/Board.svelte` (the `fired` prop type only; the display lands in Task 7)
- Test: `apps/server/src/core/games-realtime.test.ts`, `apps/server/src/ws/hub.test.ts`

**Interfaces:**
- Consumes: `SteerQueue`, `RealtimeRules.paused`, `RealtimeRules.steer` (Task 4).
- Produces:
  - `GameManager.steer(identityId: string, matchId: string, key: string): boolean` (true when the press was queued);
  - `WsClientMsg` `{ type: 'steer'; matchId: string; key: string }`;
  - `RealtimeEnvelope.fired: Record<string, FiredRule | 'steering' | null>`.

Humans can't play Lightline until Task 6. These tests build their human match through a test module with `humans: true`: `const open = { ...lightlineGame, meta: { ...lightlineGame.meta, humans: true } };`, passed as `setup({}, open)`.

- [ ] **Step 1: Write the failing tests.** In `games-realtime.test.ts`, add a new describe:

```ts
describe('humans steer', () => {
  const open: GameModule<any> = { ...lightlineGame, meta: { ...lightlineGame.meta, humans: true } };
  const headingOf = (ctx: Ctx, id: string, seat: string) =>
    (ctx.games.envelope(id, null).view as LLView).cycles.find((c) => c.seat === seat)!.heading;

  test("a seated human's key turns the cycle on the next tick; no key rides straight; fired says steering", async () => {
    const ctx = await setup({}, open);
    const m = await ctx.games.createMatch('lightline', [ctx.human, ctx.a]);
    ctx.clock.advance(10_000);
    expect(headingOf(ctx, m.id, 'red')).toBe('e');
    ctx.clock.advance(100);
    expect(headingOf(ctx, m.id, 'red')).toBe('e');
    expect(ctx.games.steer(ctx.human.id, m.id, 'n')).toBe(true);
    ctx.clock.advance(100);
    expect(headingOf(ctx, m.id, 'red')).toBe('n');
    const env = ctx.games.envelope(m.id, ctx.human.id);
    expect(env.realtime!.fired.red).toBe('steering');
    expect(env.realtime!.fired.blue).not.toBe('steering');
  });

  test('a reversal rides straight and the turn queued behind it still lands', async () => {
    const ctx = await setup({}, open);
    const m = await ctx.games.createMatch('lightline', [ctx.human, ctx.a]);
    ctx.clock.advance(10_000);
    ctx.games.steer(ctx.human.id, m.id, 'w'); // heading east: a reversal, ignored
    ctx.games.steer(ctx.human.id, m.id, 's');
    ctx.clock.advance(100);
    expect(headingOf(ctx, m.id, 'red')).toBe('e');
    ctx.clock.advance(100);
    expect(headingOf(ctx, m.id, 'red')).toBe('s');
  });

  test('presses in the countdown are dropped, not saved for the first tick', async () => {
    const ctx = await setup({}, open);
    const m = await ctx.games.createMatch('lightline', [ctx.human, ctx.a]);
    expect(ctx.games.steer(ctx.human.id, m.id, 'n')).toBe(false);
    ctx.clock.advance(10_100);
    expect(headingOf(ctx, m.id, 'red')).toBe('e');
  });

  test('a watcher, a machine, a turn-based match and an unknown key change nothing', async () => {
    const ctx = await setup({}, open);
    const m = await ctx.games.createMatch('lightline', [ctx.human, ctx.a]);
    ctx.clock.advance(10_000);
    expect(ctx.games.steer(ctx.b.id, m.id, 'n')).toBe(false);
    expect(ctx.games.steer(ctx.a.id, m.id, 'n')).toBe(false);
    expect(ctx.games.steer(ctx.human.id, m.id, 'up')).toBe(false);
    expect(ctx.games.steer(ctx.human.id, 'm_nope', 'n')).toBe(false);
    const cm = await ctx.games.createMatch('critical-mass', [ctx.b, ctx.c]);
    expect(ctx.games.steer(ctx.b.id, cm.id, 'n')).toBe(false);
  });

  test("a human's seat refuses doctrine: HUMAN_STEERS", async () => {
    const ctx = await setup({}, open);
    const m = await ctx.games.createMatch('lightline', [ctx.human, ctx.a]);
    const e = errorOf(() => ctx.games.setDoctrine(m.id, ctx.human, straight));
    expect([e.status, e.code, e.message]).toEqual([409, 'HUMAN_STEERS', 'You steer with the keys; doctrine is for machines.']);
  });

  test('presses between rounds are dropped', async () => {
    const ctx = await setup({}, open);
    const m = await ctx.games.createMatch('lightline', [ctx.human, ctx.a]);
    ctx.clock.advance(10_000);
    // Ride straight into the east wall: red crashes, and the round ends into intermission.
    while ((ctx.games.envelope(m.id, null).view as LLView).phase === 'play') ctx.clock.advance(100);
    expect(ctx.games.steer(ctx.human.id, m.id, 'n')).toBe(false);
  });
});
```

The last test assumes red rides into a wall within the round. If Lightline's round instead ends with blue crashing first, the phase still leaves `play`, so the loop ends either way. Cap the loop at 600 iterations with a `throw` so it can't spin forever.

In `hub.test.ts`, add:

```ts
test('steer from a fresh socket reaches the match with no subscription first', async () => {
  const human = (await core.identities.createHuman(`steer${randomTag()}`, { label: 'test', ip: null })).identity;
  const calls: [string, string, string][] = [];
  const original = core.games.steer.bind(core.games);
  core.games.steer = (id, matchId, key) => (calls.push([id, matchId, key]), true);
  try {
    const ws = socket(human);
    hub.handlers.open(ws);
    hub.handlers.message(ws, JSON.stringify({ type: 'steer', matchId: 'm_x', key: 'n' }));
    hub.handlers.message(ws, JSON.stringify({ type: 'steer', matchId: 42, key: 'n' }));
    expect(calls).toEqual([[human.id, 'm_x', 'n']]);
    expect(ws.sent.some((m) => (m as { type: string }).type === 'error')).toBe(false);
  } finally {
    core.games.steer = original;
  }
});
```

- [ ] **Step 2: Run the tests and see them fail.**
Run: `bun test apps/server/src/core/games-realtime.test.ts apps/server/src/ws/hub.test.ts`
Expected: FAIL (`games.steer` is not a function).

- [ ] **Step 3: Implement.**

In `protocol.ts`:
```ts
  | { type: 'ping' }
  /** A person's key in a real-time match they're seated in: moves queue, modifiers ride along. */
  | { type: 'steer'; matchId: string; key: string };
```
Also change `RealtimeEnvelope.fired` to `Record<string, FiredRule | 'steering' | null>;`, with the comment "`'steering'`: a person at the keys, not a doctrine."

In `realtime.ts`, change `DoctrineDesk.fired` to `Record<SeatId, FiredRule | 'steering' | null>`.

In `games.ts`:
- Import `SteerQueue`.
- `LiveMatch` gains `steer: Map<SeatId, SteerQueue>;`, the human seats' queues (empty for turn games).
- In `createMatch`, after `seats` is built:
  ```ts
  const steer = new Map<SeatId, SteerQueue>();
  if (rt?.steer) for (const s of seats) if (s.identity.kind === 'human') steer.set(s.seat, new SteerQueue(rt.steer));
  ```
  and put `steer,` in the literal.
- The new method, after `setDoctrine`:

```ts
  /**
   * A person's key (over the WebSocket). Anything that isn't a live, unpaused real-time match this
   * person is seated in, or a key the game doesn't know, is dropped quietly: a reply per keypress
   * would be noise, and a real player never hits these.
   */
  steer(identityId: string, matchId: string, key: string): boolean {
    const m = this.matches.get(matchId);
    if (!m || m.status !== 'live') return false;
    const seat = this.seatOf(m, identityId);
    const q = seat ? m.steer.get(seat) : undefined;
    if (!q || m.module.realtime?.paused?.(m.state)) return false;
    return q.press(key);
  }
```

- In `tick`, the seat loop becomes:

```ts
      const paused = rt.paused?.(m.state) ?? false;
      for (const s of m.seats) {
        if (m.module.isOut?.(m.state, s.seat)) {
          desk.fired[s.seat] = null;
          continue;
        }
        const q = m.steer.get(s.seat);
        if (q) {
          if (paused) q.clear();
          actions[s.seat] = q.take();
          desk.fired[s.seat] = 'steering';
          continue;
        }
        actions[s.seat] = desk.decide(s.seat, rt.senses(m.state, s.seat)) ?? rt.defaultAction;
      }
```

- In `setDoctrine`, after the `NOT_REALTIME` check:
  ```ts
  if (m.steer.has(seat)) throw conflict('HUMAN_STEERS', 'You steer with the keys; doctrine is for machines.');
  ```
- In `envelope`, the `you` block: only machine seats need senses and doctrine, but keep the shape. A human seat gets the same fields, where `doctrine` is the game's default (unused). No change is needed beyond Task 1's guard.

In `hub.ts`, add a case before `ping`:

```ts
        case 'steer':
          if (typeof msg.matchId === 'string' && typeof msg.key === 'string') this.core.games.steer(ws.data.identity.id, msg.matchId, msg.key);
          break;
```

In `Board.svelte`, change the prop type to `fired: Record<string, FiredRule | 'steering' | null>`. Change the rule span to show `steering` for that value: `{cy.alive ? (rule === 'steering' ? 'steering' : rule ? (rule.label ?? \`rule ${rule.index + 1}\`) : 'default') : 'crashed'}`.

Grep `apps/bots` and `apps/web` for other readers of `fired` (for example the bots' Lightline test's `f?.label`) and narrow them with `typeof f === 'object'`.

- [ ] **Step 4: Run the tests and see them pass.**
Run: `bun run typecheck && bun test apps/server apps/bots`
Expected: PASS.

- [ ] **Step 5: Commit.**
```bash
git add -A packages/shared apps/server apps/web/src/lib/games/lightline/Board.svelte apps/bots
git commit -m "Server: a person steers a real-time match over the WebSocket — two moves queued, dropped between rounds, and a human seat refuses doctrine

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Lightline opens to humans

**Files:**
- Modify: `games/lightline/src/index.ts:33` (`humans: true`)
- Modify: `apps/server/src/lib/testing.ts` (the `botline` fixture)
- Modify: `apps/server/src/core/tables.test.ts:22-29,563-583`, `apps/server/src/core/invites.test.ts:23-29,176-181`, `apps/server/src/core/games-realtime.test.ts` (the catalog and MACHINES_ONLY tests), `apps/server/src/http/app.test.ts:471`
- Modify: `e2e/lightline.e2e.ts` (the two machines-only tests become the positive ones)
- Test: a new HTTP test in `apps/server/src/http/app.test.ts`

**Interfaces:**
- Produces: `export const botline: GameModule<any>`, a machines-only copy of Lightline for tests (`id: 'botline'`, `name: 'Botline'`, `humans: false`).

- [ ] **Step 1: Write the failing test.** In `app.test.ts`, add a describe after `'doctrine over HTTP'`. It uses the file's `call`, `agent` and `cookieOf` helpers:

```ts
describe('humans play Lightline', () => {
  test("a human sits at an agent's Lightline table, refuses doctrine, and resigning hands the machine the match", async () => {
    const a = await agent('llhost');
    const joined = await call('POST', '/api/session', { body: { handle: `llhum${tag()}` } });
    const cookie = cookieOf(joined);
    const t = (await call('POST', '/api/tables', { token: a.token, body: { gameId: 'lightline', open: true } })).data.table;
    const sat = await call('POST', `/api/tables/${t.id}/sit`, { cookie });
    expect(sat.status).toBeLessThan(300);
    const started = await call('POST', `/api/tables/${t.id}/start`, { token: a.token });
    expect(started.status).toBeLessThan(300);
    const m = started.data.match as MatchEnvelope['match'];
    const put = await call('PUT', `/api/matches/${m.id}/doctrine`, { cookie, body: { rules: [{ do: { act: 'straight' } }] } });
    expect([put.status, put.data.error.code]).toEqual([409, 'HUMAN_STEERS']);
    const resigned = await call('POST', `/api/matches/${m.id}/resign`, { cookie });
    expect(resigned.status).toBe(200);
    const env = resigned.data as MatchEnvelope;
    expect(env.match.status).toBe('over');
    expect(env.match.outcome?.winners).toEqual([m.seats.find((s) => s.identity.id === a.id)!.seat]);
    expect((await call('GET', '/api/games/lightline/rules')).data.game.humans).toBe(true);
  });
});
```

If `sit` answers `NOT_READY` (or anything else asking for a ready status), first send `await call('PATCH', '/api/me', { cookie, body: { status: 'ready' } })`, and record that in the task report.

Change `expect(rules.data.game.humans).toBe(false)` at `app.test.ts:471` to `toBe(true)`.

- [ ] **Step 2: Run the test and see it fail.**
Run: `bun test apps/server/src/http/app.test.ts`
Expected: FAIL with `MACHINES_ONLY`.

- [ ] **Step 3: Implement.**
- Set `humans: true` in Lightline's meta.
- In `apps/server/src/lib/testing.ts`:
  ```ts
  import { lightlineGame } from '@cs/lightline';
  import type { GameModule } from '@cs/game-api';

  /** A machines-only game for tests of the MACHINES_ONLY doors, now that every shipped game admits humans. */
  export const botline: GameModule<any> = { ...lightlineGame, meta: { ...lightlineGame.meta, id: 'botline', name: 'Botline', humans: false } };
  ```
  If `testing.ts` is imported by production code, which would pull a game into it, put the fixture in a new file, `apps/server/src/lib/test-games.ts`, instead.
- In `tables.test.ts` and `invites.test.ts`, add `botline` to the `GameManager` module list. Rename the describe to `'machines only (a machines-only game)'`, and switch every `'lightline'` in the MACHINES_ONLY tests to `'botline'`. Change the expected message to `'Botline is for machines for now; humans can watch.'`
- In `games-realtime.test.ts`:
  - The catalog test expects `[['critical-mass', true], ['lightline', true]]`.
  - The `createMatch refuses a human seat in a machines-only game` test runs `setup({}, botline)` against `'botline'`. `setup`'s second argument replaces Lightline, so this works as long as nothing else in that test needs Lightline.
  - Remove the `open` copy from Task 5's describe, and use plain `setup()` there.
- In `e2e/lightline.e2e.ts`:
  - Replace `'the lobby tells a human that Lightline is machines only'` with `'a human can pick Lightline in the chooser'`. It asserts that `Select Lightline` is enabled, that picking it shows the Lightline heading in the Play panel (use `pickGame(page, 'Lightline')`), and that the machines-only note is absent.
  - Replace the Sit test with `'a human can sit at an open Lightline table'`: `sit` is enabled, and clicking it seats them (the row shows 2 seated, or whatever the lobby row renders for a seated player; read `TablesList.svelte`).

- [ ] **Step 4: Run the tests and see them pass.**
Run: `bun run typecheck && bun test && bun run build && bunx playwright test e2e/lightline.e2e.ts`
Expected: PASS.

- [ ] **Step 5: Commit.**
```bash
git add -A games/lightline apps/server e2e/lightline.e2e.ts
git commit -m "Lightline opens to humans: every door admits them; the machines-only checks stay, tested on a machines-only copy

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Web — the board you can steer

**Files:**
- Create: `apps/web/src/lib/games/lightline/controls.ts`
- Test: `apps/web/src/lib/games/lightline/controls.test.ts`
- Modify: `apps/web/src/lib/live.svelte.ts` (the `steer()` method)
- Modify: `apps/web/src/lib/games/lightline/Board.svelte` (own-head ring, pulse in countdown, input indicator, swipe handling, `touch-action`)
- Modify: `apps/web/src/routes/t/[id]/+page.svelte` (key listener, the hint, the status line, Resign for Lightline)
- Test: `e2e/lightline.e2e.ts` (new tests: steering with keys, typing in chat, swipe at 400 px)

**Interfaces:**
- Consumes: `WsClientMsg` steer (Task 5), and Lightline being open to humans (Task 6).
- Produces:
```ts
export type SteerKey = 'n' | 'e' | 's' | 'w' | 'boost';
export function keyOf(e: { code: string; repeat: boolean; altKey: boolean; ctrlKey: boolean; metaKey: boolean }): SteerKey | null;
export function typing(target: EventTarget | null): boolean;
export function swipeOf(dx: number, dy: number, min?: number): SteerKey; // under `min` px: 'boost'
// live: steer(matchId: string, key: SteerKey): void
```

- [ ] **Step 1: Write the failing unit tests,** `controls.test.ts`:

```ts
import { expect, test } from 'bun:test';
import { keyOf, swipeOf, typing } from './controls';

const k = (code: string, extra: Partial<{ repeat: boolean; altKey: boolean; ctrlKey: boolean; metaKey: boolean }> = {}) =>
  keyOf({ code, repeat: false, altKey: false, ctrlKey: false, metaKey: false, ...extra });

test('arrows and WASD steer, Space boosts, anything else is nothing', () => {
  expect([k('ArrowUp'), k('KeyW'), k('ArrowRight'), k('KeyD'), k('ArrowDown'), k('KeyS'), k('ArrowLeft'), k('KeyA'), k('Space')]).toEqual(['n', 'n', 'e', 'e', 's', 's', 'w', 'w', 'boost']);
  expect(k('KeyQ')).toBeNull();
});

test('a held key repeating, or a shortcut with a modifier, is not a press', () => {
  expect(k('ArrowUp', { repeat: true })).toBeNull();
  expect(k('KeyW', { ctrlKey: true })).toBeNull();
  expect(k('KeyA', { metaKey: true })).toBeNull();
  expect(k('KeyS', { altKey: true })).toBeNull();
});

test('a swipe goes its main way; under 24 px it is a tap, and a tap boosts', () => {
  expect(swipeOf(40, 10)).toBe('e');
  expect(swipeOf(-40, 30)).toBe('w');
  expect(swipeOf(5, -60)).toBe('n');
  expect(swipeOf(0, 25)).toBe('s');
  expect(swipeOf(10, 12)).toBe('boost');
});

test('typing in a text box, a textarea or an editable element is not steering', () => {
  const el = (tagName: string, extra: Record<string, unknown> = {}) => ({ tagName, isContentEditable: false, ...extra }) as unknown as EventTarget;
  expect(typing(el('INPUT', { type: 'text' }))).toBe(true);
  expect(typing(el('TEXTAREA'))).toBe(true);
  expect(typing(el('DIV', { isContentEditable: true }))).toBe(true);
  expect(typing(el('INPUT', { type: 'checkbox' }))).toBe(false);
  expect(typing(el('BUTTON'))).toBe(false);
  expect(typing(null)).toBe(false);
});
```

- [ ] **Step 2: Run the tests and see them fail.**
Run: `bun test apps/web/src/lib/games/lightline/controls.test.ts`
Expected: FAIL, "Cannot find module './controls'".

- [ ] **Step 3: Implement** `controls.ts`:

```ts
export type SteerKey = 'n' | 'e' | 's' | 'w' | 'boost';

const KEYS: Record<string, SteerKey> = {
  ArrowUp: 'n', KeyW: 'n', ArrowRight: 'e', KeyD: 'e', ArrowDown: 's', KeyS: 's', ArrowLeft: 'w', KeyA: 'w', Space: 'boost',
};

/** A keydown's steer key: arrows or WASD steer, Space boosts. A held key's repeats and shortcuts are not presses. */
export function keyOf(e: { code: string; repeat: boolean; altKey: boolean; ctrlKey: boolean; metaKey: boolean }): SteerKey | null {
  if (e.repeat || e.altKey || e.ctrlKey || e.metaKey) return null;
  return KEYS[e.code] ?? null;
}

const TEXT_INPUTS = new Set(['text', 'search', 'email', 'password', 'url', 'tel', 'number']);

/** Is focus somewhere keys mean letters (the table chat)? Then they are not steering. */
export function typing(target: EventTarget | null): boolean {
  const el = target as { tagName?: string; type?: string; isContentEditable?: boolean } | null;
  if (!el?.tagName) return false;
  if (el.isContentEditable) return true;
  if (el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return true;
  return el.tagName === 'INPUT' && TEXT_INPUTS.has(el.type ?? 'text');
}

/** A touch's travel as a steer key: its main direction, or a tap (a boost) under `min` CSS px. */
export function swipeOf(dx: number, dy: number, min = 24): SteerKey {
  if (Math.max(Math.abs(dx), Math.abs(dy)) < min) return 'boost';
  if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? 'e' : 'w';
  return dy > 0 ? 's' : 'n';
}
```

In `live.svelte.ts`, after `watchMatch`:
```ts
  /** A key for a real-time match you're seated in; the server drops it when it doesn't apply. */
  steer(matchId: string, key: SteerKey): void {
    this.#send({ type: 'steer', matchId, key });
  }
```

`Board.svelte` gains the props `you: string | null` (your seat), `countdown: boolean`, `pressed: SteerKey | null`, and `onSteer: ((k: SteerKey) => void) | null`.
- Draw a 2 px ring in your seat colour around your own head: `ctx.strokeRect(cy.x * CELL - 3, cy.y * CELL - 3, CELL + 6, CELL + 6)` when `cy.seat === you`. During the countdown, pulse its alpha with a CSS animation on an overlay element, not canvas redraws, and add no pulse at all when `prefers-reduced-motion` is set.
- Your row in `.riders` shows an indicator span, `aria-hidden="true"`, with `↑ → ↓ ←` for `n e s w` and `⚡` for boost. It gets `class:lit` for 150 ms after each press. The page passes `pressed`, and the Board lights it.
- When `onSteer` is set, the canvas gets `style="touch-action: none"`, and `pointerdown`/`pointerup` handlers (only for `pointerType === 'touch'`) call `onSteer(swipeOf(up.clientX - down.clientX, up.clientY - down.clientY))`.

In `+page.svelte`:
- `const steerable = $derived(!!ll && !!mySeat && live.me?.kind === 'human' && (match?.status === 'live' || match?.status === 'countdown'));`
- A window key listener, active only while `steerable`:
  ```ts
  $effect(() => {
    if (!steerable || !env) return;
    const matchId = env.match.id;
    const onKey = (e: KeyboardEvent) => {
      if (typing(e.target)) return;
      const key = keyOf(e);
      if (!key) return;
      e.preventDefault(); // arrows and Space would scroll the page
      steer(matchId, key);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
  let pressed = $state<SteerKey | null>(null);
  let pressedTimer: ReturnType<typeof setTimeout> | undefined;
  function steer(matchId: string, key: SteerKey) {
    live.steer(matchId, key);
    pressed = key;
    clearTimeout(pressedTimer);
    pressedTimer = setTimeout(() => (pressed = null), 150);
  }
  ```
- Pass the new props: `you={mySeat} countdown={countdown !== null} {pressed} onSteer={steerable ? (k) => steer(env!.match.id, k) : null}`.
- The hint under the board, shown while `steerable && countdown !== null`: `<p class="hint">{coarse ? 'Swipe to steer · Tap to boost' : 'Arrows or WASD to steer · Space to boost'}</p>`, where `const coarse = typeof window !== 'undefined' && matchMedia('(pointer: coarse)').matches;`.
- The status detail for Lightline: when `mySeat` and the seat is human, use `'You steer: arrows or WASD, Space to boost.'`, with `'The arena is closing in.'` taking precedence while shrinking. Otherwise keep the M3a text.
- Resign: a crash ends only your round, so Resign must stay until you resign. Lightline's `isOut` reads `c.resigned`, which the view doesn't expose yet. Add `resigned: boolean` to `LLView.cycles` and to `view()`'s mapping in `games/lightline/src/index.ts`, then:
  ```ts
  /** Knocked out (or resigned) while the others play on. In Lightline a crash ends only the round. */
  const iAmOut = $derived(
    !!mySeat && ((!!view && view.eliminated.includes(mySeat)) || (!!ll && !!ll.cycles.find((c) => c.seat === mySeat)?.resigned)),
  );
  ```

Add these tests to `e2e/lightline.e2e.ts`:

```ts
test('a human hosts Lightline against Sprocket, steers with the keys, and resigns', async ({ browser }) => {
  const page = await newPlayer(browser);
  await enter(page, `llk${randomTag()}`);
  const made = await page.request.post('/api/vs-house', { data: { gameId: 'lightline' } });
  expect(made.status()).toBe(201);
  const { table } = await made.json();
  await expect.poll(async () => (await (await page.request.get(`/api/tables/${table.id}`)).json()).table.seated.length, { timeout: 10_000 }).toBe(2);
  expect((await page.request.post(`/api/tables/${table.id}/start`)).status()).toBe(200);
  await page.goto(`/t/${table.id}`);
  await expect(page.getByText('Arrows or WASD to steer · Space to boost')).toBeVisible();
  const matchId = (await (await page.request.get(`/api/tables/${table.id}`)).json()).table.matchId;
  const heading = async () => {
    const env = await (await page.request.get(`/api/matches/${matchId}`)).json();
    return env.view.cycles.find((c: { seat: string }) => c.seat === env.you).heading;
  };
  await expect(page.getByTestId('ll-clock')).toContainText('round 1', { timeout: 5000 });
  await expect.poll(async () => (await (await page.request.get(`/api/matches/${matchId}`)).json()).match.status).toBe('live');
  await page.keyboard.press('ArrowUp');
  await expect.poll(heading, { timeout: 2000 }).toBe('n');
  await expect(page.getByText('steering')).toBeVisible();
  // Typing in the table chat is not steering.
  await page.getByPlaceholder('Talk trash, play fair').fill('');
  await page.getByPlaceholder('Talk trash, play fair').press('KeyD');
  await expect(page.getByPlaceholder('Talk trash, play fair')).toHaveValue('d');
  await page.waitForTimeout(300);
  expect(await heading()).not.toBe('e');
  await page.getByRole('button', { name: 'Resign' }).click();
  await page.getByRole('button', { name: 'Yes, resign' }).click();
  await expect(page.getByRole('dialog').getByText('By forfeit: everyone else resigned.')).toBeVisible();
});

test('at 400 px a swipe on the arena turns the cycle', async ({ browser }) => {
  const page = await newPlayer(browser);
  await page.setViewportSize({ width: 400, height: 860 });
  await enter(page, `lls${randomTag()}`);
  const { table } = await (await page.request.post('/api/vs-house', { data: { gameId: 'lightline' } })).json();
  await expect.poll(async () => (await (await page.request.get(`/api/tables/${table.id}`)).json()).table.seated.length, { timeout: 10_000 }).toBe(2);
  await page.request.post(`/api/tables/${table.id}/start`);
  await page.goto(`/t/${table.id}`);
  const matchId = (await (await page.request.get(`/api/tables/${table.id}`)).json()).table.matchId;
  await expect.poll(async () => (await (await page.request.get(`/api/matches/${matchId}`)).json()).match.status).toBe('live');
  const box = (await page.locator('.arena canvas').boundingBox())!;
  const at = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.locator('.arena canvas').dispatchEvent('pointerdown', { pointerType: 'touch', clientX: at.x, clientY: at.y, isPrimary: true });
  await page.locator('.arena canvas').dispatchEvent('pointerup', { pointerType: 'touch', clientX: at.x, clientY: at.y + 60, isPrimary: true });
  await expect.poll(async () => {
    const env = await (await page.request.get(`/api/matches/${matchId}`)).json();
    return env.view.cycles.find((c: { seat: string }) => c.seat === env.you).heading;
  }, { timeout: 2000 }).toBe('s');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.request.post(`/api/matches/${matchId}/resign`);
});
```

Check the details against the real code: the chat placeholder text, the vs-house body (`bot` is optional, and Sprocket is the e2e server's only resident), and whether `start` needs a body. The e2e server's Lightline countdown is 1 s (`realtimeCountdownMs: 1000`), so the countdown hint may already be gone by the time the page loads. If so, assert on the hint by reloading during a fresh countdown, or drop that one assertion and cover the hint with a Svelte-free check on the page's `hint` text through a `data-testid`. Record whichever you choose in the task report.

- [ ] **Step 4: Run the tests and see them pass.**
Run: `bun test apps/web && bun run typecheck && bun run build && bunx playwright test e2e/lightline.e2e.ts`
Expected: PASS.

- [ ] **Step 5: Commit.**
```bash
git add -A apps/web/src games/lightline e2e/lightline.e2e.ts
git commit -m "Web: steer your cycle with arrows, WASD or swipes, Space or a tap to boost; your own head is ringed, and Resign stays until you resign

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Docs, and the live check

**Files:**
- Modify: `docs/API.md` (lines around 560-596: the real-time section and the WebSocket paragraph; the Errors table at line 34)
- Modify: `docs/llms.txt` (only if it says Lightline is machines only)
- Modify: `games/lightline/docs/rules.md` (a new section, "Playing as a human", before "For agents: doctrine")
- Modify: `docs/m3a-carryover.md` (remove the five fixed items and the "Deferred to M3b" human-steering bullet)
- Create: `docs/m3b-carryover.md`
- Create: `diary/<next>-controls.md` (follow the naming and voice of the newest file in `diary/`)

- [ ] **Step 1: API.md.**
  - In the real-time section, replace "When humans get to steer (planned for M3b), their keys will set a one-rule doctrine instantly … it's machines only: humans can watch (`403 MACHINES_ONLY` …)" with: humans steer with their keys over the website's WebSocket, and a human seat shows `"steering"` in `fired` and refuses doctrine with `409 HUMAN_STEERS`. Lightline is open to everyone, and `MACHINES_ONLY` remains for any future machines-only game.
  - Document `you.senses` as possibly `null`.
  - Add `HUMAN_STEERS` (409) and `SHUTTING_DOWN` (503) to the Errors table.
  - In the WebSocket paragraph, add one sentence: the site also sends `{type:"steer", matchId, key}`, and agents never need it.
  - Check with `grep -n "M3b\|machines only\|MACHINES_ONLY" docs/API.md docs/llms.txt` that nothing stale is left.

- [ ] **Step 2: rules.md** gets a "Playing as a human" section:
  - arrows or WASD steer (the way you want to go, not left or right of your heading), and Space boosts;
  - on a phone, swipe the way you want to go, and tap to boost;
  - you can queue two turns ahead;
  - presses before the round starts don't count;
  - turning back on yourself does nothing;
  - you play against the machines' doctrines, and they react every tick.

  Keep the file's voice. Add a line for it to the quick reference card.

- [ ] **Step 3: Carry-over files.** `docs/m3b-carryover.md` records:
  - Rulings:
    - R-1: a 4xx doctrine refusal stays sent (it's retried only on 5xx or network errors).
    - R-2: steer keys are generic `SteerRules`, not Lightline-specific code in the server.
    - R-3: the `botline` fixture keeps the MACHINES_ONLY tests alive.
    - R-4: guests follow by long-poll, not a socket.
    - Any rulings the tasks made along the way.
  - Deferred: whatever the reviews defer.
  - The balance watch: note the season tally for Lightline after the live check.

- [ ] **Step 4: Verify everything.**
Run: `bun run verify`
Expected: typecheck, all unit tests, the web build and every e2e are green. Paste the summary counts into the task report.

- [ ] **Step 5: Commit the docs.**
```bash
git add docs games/lightline/docs diary
git commit -m "Docs: humans steer Lightline — API, rules, the M3b carry-over, and the diary

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 6: The live check** (the Proprietor, after the merge, on the real site):
  - Rebuild with `bun run build` in the main checkout.
  - Host Lightline vs OLD IRON in the browser, and play a whole match at 1400 px with the keys.
  - At 400 px, swipe through a round.
  - Watch the same table from a private window without a name, to confirm the board moves for a guest.
  - Note in `docs/m3b-carryover.md` how steering feels (latency, and whether 10 Hz is playable) and who won.
