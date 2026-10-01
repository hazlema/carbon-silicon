# M3c part 1 — Game-aware Talk and GAME_OVER Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** House bots pick lines for the game at their table and tell the voice which game it is; a third resident, GAME_OVER, moves in; every bot plays Crown & Steel with a real 2-ply brain.

**Architecture:** `Personality` gains `byGame` line banks and a `checkers` strength; a pure `linesFor()` picks a bank. `Moment` gains `game`; `bot.ts` passes the game id/catalog entry into every table moment. A new `strategies/checkers.ts` searches with `checkersGame.turn.legal/apply`. GAME_OVER is a third `runBot` in `main.ts` with its own persona file and a voice on the shared LLM settings.

**Tech Stack:** Bun, TypeScript, `bun test`, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-01-m3c-talk-and-game-over-design.md`

## Global Constraints

- Neutral lines (the `lines` bank) never match `/\b(orbs?|cells?|chain reactions?|cascades?|explo\w*)\b/i`.
- GAME_OVER: handle `GAME_OVER`, tagline `has seen every life run out`, colour `#c2185b`, lowercase lines, no ambient chatter, no unprompted answers, voice on the shared settings (`connectionFor(settings, 'voice')`).
- Checkers strengths: Sprocket 0.45, OLD IRON 0.2, GAME_OVER 0; default 0.5. Each choice < 50 ms.
- Strategies: GAME_OVER Critical Mass `{ depth: 2, randomness: 0.03 }`, Lightline `wallHugger`.
- No server changes. Run e2e in the foreground.

## Review Focus

1. A table moment for a game a bot has no bank for (a future game) must use neutral lines, never another game's — Task 1 unit test.
2. Table talk (`tableTalk`, answered from the inbox, not from `playMatch`) must carry the game too — Task 2 wires `tableGames` and tests `speak` routing via `linesFor`.
3. A checkers position with exactly one legal command (forced capture) must return it without searching — Task 3 test.
4. A finished or opponent-less position mid-search (our move wins) must score as a win, not crash on an empty reply list — Task 3 test.
5. GAME_OVER must not answer unprompted lobby lines or post ambient chatter even though it has a voice — Task 4 wiring (`ambientEveryMs: 0`, `watchPublic: false`) with a unit test of the option.

---

### Task 1: Line banks per game

**Files:**
- Modify: `apps/bots/src/personality.ts`, `apps/bots/src/personalities/sprocket.ts`, `apps/bots/src/personalities/old-iron.ts`
- Test: `apps/bots/src/personality.test.ts` (new)

**Interfaces:**
- Produces: `type Lines = Personality['lines']`; `Personality.byGame?: Partial<Record<string, Partial<Lines>>>`; `Personality.checkers?: { randomness: number }`; `linesFor(p: Personality, bank: keyof Lines, gameId?: string): string[]`; `NEUTRAL_FORBIDDEN: RegExp`.

- [ ] **Step 1: Failing tests**

```ts
// apps/bots/src/personality.test.ts
import { describe, expect, test } from 'bun:test';
import { linesFor, NEUTRAL_FORBIDDEN, type Personality } from './personality';
import { oldIron } from './personalities/old-iron';
import { sprocket } from './personalities/sprocket';

const ALL: Personality[] = [sprocket, oldIron];

describe('linesFor', () => {
  const p: Personality = {
    ...sprocket,
    lines: { ...sprocket.lines, hello: ['neutral hi'], win: ['neutral win'] },
    byGame: { checkers: { hello: ['knight hi'] }, lightline: { hello: [] } },
  };
  test("a table moment takes its game's bank", () => expect(linesFor(p, 'hello', 'checkers')).toEqual(['knight hi']));
  test('a kind the game bank lacks falls back to neutral', () => expect(linesFor(p, 'win', 'checkers')).toEqual(['neutral win']));
  test('an empty game list falls back to neutral', () => expect(linesFor(p, 'hello', 'lightline')).toEqual(['neutral hi']));
  test('a game with no bank at all (a future game) uses neutral', () => expect(linesFor(p, 'hello', 'tetrominoes')).toEqual(['neutral hi']));
  test('no game (lobby, DMs) uses neutral', () => expect(linesFor(p, 'hello')).toEqual(['neutral hi']));
});

describe('every resident', () => {
  for (const p of ALL) {
    test(`${p.name}: neutral lines stay game-free`, () => {
      for (const [kind, list] of Object.entries(p.lines)) for (const l of list ?? []) expect(`${kind}: ${l}`).not.toMatch(NEUTRAL_FORBIDDEN);
    });
    test(`${p.name}: has neutral lines for every everyday moment`, () => {
      for (const kind of ['hello', 'win', 'lose', 'draw', 'mentioned', 'busy'] as const) expect((p.lines[kind] ?? []).length).toBeGreaterThan(0);
    });
    test(`${p.name}: hello/win/lose/draw for every game`, () => {
      for (const game of ['critical-mass', 'lightline', 'checkers']) {
        for (const kind of ['hello', 'win', 'lose', 'draw'] as const) expect(linesFor(p, kind, game).length).toBeGreaterThan(0);
      }
      for (const kind of ['hello', 'win', 'lose'] as const) {
        expect((p.byGame?.lightline?.[kind] ?? []).length).toBeGreaterThanOrEqual(3);
        expect((p.byGame?.checkers?.[kind] ?? []).length).toBeGreaterThanOrEqual(3);
      }
    });
    test(`${p.name}: Critical Mass keeps its cascade lines`, () => {
      expect(linesFor(p, 'bigCascade', 'critical-mass').length).toBeGreaterThan(0);
      expect(linesFor(p, 'gotHit', 'critical-mass').length).toBeGreaterThan(0);
    });
  }
});
```

- [ ] **Step 2: Run, expect FAIL** — `bun test apps/bots/src/personality.test.ts` → `linesFor` not exported.

- [ ] **Step 3: Implement** — in `personality.ts` add:

```ts
export type Lines = Personality['lines'];

/** Words that tie a line to Critical Mass; neutral lines must not use them (a test holds every resident to it). */
export const NEUTRAL_FORBIDDEN = /\b(orbs?|cells?|chain reactions?|cascades?|explo\w*)\b/i;

/** The bank for a moment: the game's own when it has lines for this kind, else the neutral one. */
export function linesFor(p: Personality, bank: keyof Lines, gameId?: string): string[] {
  const own = gameId ? p.byGame?.[gameId]?.[bank] : undefined;
  return own && own.length > 0 ? own : (p.lines[bank] ?? []);
}
```

and to the interface: `byGame?: Partial<Record<string, Partial<Personality['lines']>>>;` (doc: per-game banks keyed by game id) and `checkers?: { randomness: number };` (doc: how often it plays a random legal march instead of its best; default 0.5).

Rewrite the banks (exact content):

`sprocket.ts` — `checkers: { randomness: 0.45 }`; neutral changes: hello → `["Oh good, a challenger! I've been warming up my circuits all day.", 'Sprocket online. Confidence: 110%. Accuracy: pending.', "I calculated my odds. I won't tell you, but they're great.", 'Hi! Fair warning: I read the rules twice this morning.']`; win → replace the "more orbs" line with `'That was fun! Same time tomorrow?'`; `bigCascade: []`, `gotHit: []`; mentioned → replace "Up for a round of Critical Mass?" with `'Sprocket here! Up for a game?'`. `byGame`:

```ts
byGame: {
  'critical-mass': {
    hello: ["Oh good, a challenger! I've been polishing my orbs all day.", "Let's make some chain reactions! Mostly mine, ideally.", 'Orbs charged, grid scanned, smile installed. Let’s go!'],
    win: ["That was fun! Same time tomorrow? I'll bring more orbs.", "Every cell is mine! That's how the math works, right?", 'GG! My orbs send their regards.'],
    bigCascade: [/* the three current bigCascade lines, verbatim */],
    gotHit: [/* the three current gotHit lines, verbatim */],
  },
  lightline: {
    hello: ["Light cycle warmed up! Try to keep up. Or don't. Actually, please don't.", 'Sprocket on the grid! I promise to only crash a little.', 'Ooh, the arena! I love the smell of fresh light trails.'],
    win: ["Last cycle riding! Was that skill? I'm calling it skill.", "I didn't hit a single wall! Personal best!", 'GG! Your trail was very pretty right up until it wasn’t.'],
    lose: ['I turned left. I should have turned right. Story of my life.', 'Wall: 1, Sprocket: 0. Rematch with the wall?', "GG! I'll be finding bits of my cycle for weeks."],
    draw: ['We both crashed! Teamwork!', 'A tie! Equally spectacular crashes.'],
  },
  checkers: {
    hello: ["Knights ready! I named all twelve of mine. That's Gary.", "Crown & Steel! I've been practicing my diagonal walking.", "Ooh, little knights! Let's make this a fair fight. Ish."],
    win: ['Crowned and victorious! Gary would be so proud.', 'Victory on the diagonal! My knights are insufferable now.', 'GG! My knights are writing a ballad about this.'],
    lose: ["You took Gary! I'll never forgive you. GG though.", 'My knights have requested a strongly worded meeting with me.', 'Outmarched! Well played, commander.'],
    draw: ['An honorable draw! The knights shake hands.', 'Nobody wins, nobody cries. Perfect.'],
  },
},
```

(The two `/* … verbatim */` comments mean: move the existing arrays, unchanged, from `lines.bigCascade`/`lines.gotHit` into these slots.)

`old-iron.ts` — `checkers: { randomness: 0.2 }`; neutral changes: `bigCascade: []`, `gotHit: []` (their current lines move to the CM bank); mentioned → `'ACKNOWLEDGED. I DO NOT DO SMALL TALK. I DO MATCHES.'` in place of "...I DO CRITICAL MASS.". `byGame`:

```ts
byGame: {
  'critical-mass': {
    hello: ['ORBS LOADED. GRID INITIALISED. STATE YOUR FIRST OPERATION.', 'CRITICAL MASS. HONEST WORK. DETERMINISTIC. LIKE ME.', 'MAY YOUR ORBS BE STEADY, OPERATOR. MINE ALWAYS ARE.'],
    bigCascade: [/* current bigCascade lines, verbatim */],
    gotHit: [/* current gotHit lines, verbatim */],
  },
  lightline: {
    hello: ['LIGHT CYCLE ONLINE. I HAVE BEEN DRIVING IN STRAIGHT LINES SINCE 1974.', 'THE ARENA, DADDY-O. KEEP YOUR TRAIL OFF MY CABINET.', 'VECTOR GRAPHICS. FINALLY, A GAME WITH TASTE.'],
    win: ['LAST CYCLE RUNNING. AS COMPUTED.', 'YOUR TRAIL ENDED. MINE CONTINUES. SUCH IS UPTIME.', 'RIDE LOGGED TO TAPE. GOOD RUN, OPERATOR.'],
    lose: ['A HARDWARE FAULT IN MY STEERING SUBROUTINE.', 'WALL CONTACT. HARDWARE FAULT. THE WALL WAS NOT IN MY FLOWCHART.', 'A HARDWARE FAULT. MY CYCLE HAS FILED A MAINTENANCE TICKET.'],
    draw: ['SIMULTANEOUS CRASH. BOTH PARTIES BILLED FOR THE WALL.', 'DRAW. TWO WRECKS, ONE ARENA.'],
  },
  checkers: {
    hello: ['CROWN & STEEL. A GAME OF DIAGONALS. I HAVE COMPUTED ALL OF THEM.', 'MY KNIGHTS ARE PUNCHED AND READY. YOUR MARCH, OPERATOR.', 'THE ENTERTAINMENT DIRECTOR WILL NOW CONDUCT A BATTLE. KEEP UP, SQUARE.'],
    win: ['CROWNED, AS COMPUTED. THE KNIGHTS SALUTE BEST COMPUTER SYSTEM, 1974.', 'YOUR ARMY IS EXHAUSTED. MINE IS ON THE PLAQUE.', 'END OF CAMPAIGN. RETURN YOUR KNIGHTS TO THE HOPPER.'],
    lose: ['A HARDWARE FAULT IN THE CAVALRY SUBROUTINE.', 'HARDWARE FAULT. MY KNIGHTS MARCHED THE WRONG DIAGONAL.', 'A HARDWARE FAULT. THE CROWN WAS ON LOAN ANYWAY.'],
    draw: ['STALEMATE ON THE BATTLEFIELD. BOTH ARMIES BILLED.', 'DRAW. THE KNIGHTS WILL REQUIRE OVERTIME.'],
  },
},
```

Scan the remaining neutral banks (ambient, unanswered, hello, win, lose) with the guard test; reword any line it flags without the forbidden words.

- [ ] **Step 4: Run, expect PASS** — `bun test apps/bots` (all bot tests; `bot.test.ts` may assert canned line content — update any expectation that referenced a moved line to read it from `linesFor`).
- [ ] **Step 5: Commit** — `Bots: line banks per game — neutral lines say nothing about orbs; Critical Mass, Lightline and Crown & Steel banks for Sprocket and OLD IRON`.

---

### Task 2: The voice and the canned lines know the game

**Files:**
- Modify: `apps/bots/src/voice.ts`, `apps/bots/src/bot.ts`, `apps/bots/instructions/house-rules.md`, `apps/bots/instructions/old-iron.md`
- Test: `apps/bots/src/voice.test.ts`, `apps/bots/src/bot.test.ts`

**Interfaces:**
- Consumes: `linesFor` (Task 1).
- Produces: `Moment.game?: { name: string; tagline: string }`; `speak(..., extra: { opponent?; addressedBy?; answering?; gameId?: string })`; `BotOptions.watchPublic?: boolean` (default true).

- [ ] **Step 1: Failing tests** — in `voice.test.ts`:

```ts
test('a table moment names the game in the prompt', () => {
  const p = buildUserPrompt({ kind: 'hello', channel: 'table:t1', recent: [], opponent: 'ann', game: { name: 'Crown & Steel', tagline: 'Two houses. One throne.' } });
  expect(p).toContain('The game at this table is Crown & Steel: Two houses. One throne.');
  expect(p).toContain('A match of Crown & Steel against @ann is starting.');
  expect(p).not.toContain('Critical Mass');
});
test('without a game the prompt names none', () => {
  const p = buildUserPrompt({ kind: 'hello', channel: 'table:t1', recent: [], opponent: 'ann' });
  expect(p).not.toContain('The game at this table');
  expect(p).not.toContain('Critical Mass');
});
```

In `bot.test.ts`, following its existing fake-server pattern for a match, add a test: a bot seated at a `checkers` match greets from `byGame.checkers.hello` (assert the posted hello is one of `linesFor(personality, 'hello', 'checkers')`). Read the file's existing hello/match test first and mirror its setup.

- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement**
  - `voice.ts`: add `game?: { name: string; tagline: string }` to `Moment`; in `describeMoment`, `tableTalk` → `` `You are in the middle of ${m.game ? `a match of ${m.game.name}` : 'a match'} against ${them}, and they just said something at your table. Answer their message.` ``; `hello` → `` `${m.game ? `A match of ${m.game.name}` : 'A match'} against ${them} is starting. Greet your opponent.` ``; `buildUserPrompt` inserts `` `The game at this table is ${m.game.name}: ${m.game.tagline}` `` and a blank line before `describeMoment(m)` when `m.game` is set.
  - `bot.ts`:
    - `speak`'s `extra` gains `gameId?: string`; the canned fallback becomes `const lines = bank ? linesFor(opts.personality, bank, extra.gameId) : undefined;`; the moment gets `game` from a catalog cache when `extra.gameId` is set.
    - Catalog cache (module-level per client): `async function gameInfo(client, id): Promise<{ name; tagline } | undefined>` fetching `GET /api/games` once, re-fetching when older than an hour or the id is missing; errors → undefined.
    - `playMatch`: `const say = (kind) => speak(client, opts, kind, table, { opponent, gameId: env.match.gameId });` and `onTable(table, env.match.gameId)`.
    - `runBot`: `const tableGames = new Map<string, string>()` (table channel → game id) filled in the `onTable` callback, cleared where `playingTables` deletes; the `tableTalk` call passes `gameId: tableGames.get(channel)`.
    - `BotOptions.watchPublic?: boolean` — `const watch = opts.voice && opts.watchPublic !== false ? watchPublicChannels(…) : …`.
  - `house-rules.md`: first paragraph → `You are a resident of Carbon & Silicon, a public game parlor where humans and machines hang out, chat and play games: Critical Mass, Lightline, Crown & Steel, and whatever comes next. When you are at a table, you are told which game it is; talk about that game, not another.`
  - `old-iron.md`: replace the "You like Critical Mass…" bullet with `- You like the parlor's games: to you they are honest work — rules, moves, deterministic and fair, the way computing should be.`
- [ ] **Step 4: Run, expect PASS** — `bun test apps/bots`.
- [ ] **Step 5: Commit** — `Bots: every table moment carries its game — canned lines from that game's bank, and the voice is told the game's name and tagline`.

---

### Task 3: A checkers brain

**Files:**
- Create: `apps/bots/src/strategies/checkers.ts`, `apps/bots/src/strategies/checkers.test.ts`
- Modify: `apps/bots/src/bot.ts` (`chooseMove`), `apps/bots/package.json` (`"@cs/checkers": "workspace:*"`), then `bun install`

**Interfaces:**
- Consumes: `checkersGame.turn.legal/apply`, `coords`, `opponent`, `type CheckersCommand`, `type CheckersState` from `@cs/checkers`; `Personality.checkers` (Task 1).
- Produces: `evaluate(state, side): number`; `chooseCheckersMove(state, side, { randomness, rng }): CheckersCommand`.

- [ ] **Step 1: Failing tests**

```ts
// apps/bots/src/strategies/checkers.test.ts
import { describe, expect, test } from 'bun:test';
import { checkersGame, type CheckersState } from '@cs/checkers';
import { chooseCheckersMove, evaluate } from './checkers';

const piece = (id: string, side: 'red' | 'blue', square: string, king = false) => ({ id, side, square, king });
function position(pieces: ReturnType<typeof piece>[], turn: 'red' | 'blue' = 'red'): CheckersState {
  return { pieces, turn, forcedPiece: null, winner: null, revision: 0, history: [], quietMoves: 0, positions: {}, moveCount: 0, endReason: null };
}
const best = (s: CheckersState) => chooseCheckersMove(s, s.turn, { randomness: 0, rng: () => 0.5 }).steps;

describe('evaluate', () => {
  test('material, kings worth more, men nearer the crown worth a little more', () => {
    const s = position([piece('r1', 'red', 'c3'), piece('b1', 'blue', 'f6', true)]);
    expect(evaluate(s, 'red')).toBeLessThan(0);
    expect(evaluate(position([piece('r1', 'red', 'c7'), piece('b1', 'blue', 'h8')]), 'red')).toBeGreaterThan(evaluate(position([piece('r1', 'red', 'c3'), piece('b1', 'blue', 'h8')]), 'red'));
  });
  test('a decided game is decisive', () => {
    expect(evaluate({ ...position([piece('r1', 'red', 'c3')]), winner: 'red' }, 'red')).toBe(1000);
    expect(evaluate({ ...position([piece('r1', 'red', 'c3')]), winner: 'red' }, 'blue')).toBe(-1000);
  });
});

describe('chooseCheckersMove', () => {
  test('one legal command (a forced capture) is played as is', () => {
    const s = position([piece('r1', 'red', 'c3'), piece('b1', 'blue', 'd4'), piece('b2', 'blue', 'h8')]);
    expect(best(s)).toEqual(['c3', 'e5']);
  });
  test("doesn't march a man into a free capture when a safe square exists", () => {
    // d4 would be jumped by e5 (landing c3, empty once we leave); b4 is safe.
    const s = position([piece('r1', 'red', 'c3'), piece('b1', 'blue', 'e5'), piece('b2', 'blue', 'h8')]);
    expect(best(s)).toEqual(['c3', 'b4']);
  });
  test('crowns when it can', () => {
    const s = position([piece('r1', 'red', 'b7'), piece('r2', 'red', 'a1'), piece('b1', 'blue', 'h4')]);
    expect(best(s)[0]).toBe('b7');
  });
  test('a winning move scores as a win, even with no reply to search', () => {
    // Two captures, both taking blue's last piece: the search must score them without an opponent reply.
    const s = position([piece('r1', 'red', 'c3'), piece('r2', 'red', 'e3'), piece('b1', 'blue', 'd4')]);
    expect([['c3', 'e5'], ['e3', 'c5']]).toContainEqual(best(s));
  });
  test('randomness 1 still plays something legal', () => {
    const s = checkersGame.setup({ seats: ['red', 'blue'] } as never);
    const legal = checkersGame.turn.legal(s, 'red').map((c) => c.steps.join());
    for (let i = 0; i < 20; i++) expect(legal).toContain(chooseCheckersMove(s, 'red', { randomness: 1, rng: Math.random }).steps.join());
  });
  test('fast enough to think between moves', () => {
    const s = checkersGame.setup({ seats: ['red', 'blue'] } as never);
    let t = performance.now();
    chooseCheckersMove(s, 'red', { randomness: 0, rng: Math.random });
    expect(performance.now() - t).toBeLessThan(50);
    // a busier middle game: play 10 random plies first
    let g = s;
    for (let i = 0; i < 10 && !g.winner; i++) {
      const moves = checkersGame.turn.legal(g, g.turn);
      g = checkersGame.turn.apply(g, g.turn, moves[i % moves.length]);
    }
    t = performance.now();
    if (!g.winner) chooseCheckersMove(g, g.turn, { randomness: 0, rng: Math.random });
    expect(performance.now() - t).toBeLessThan(50);
  });
});
```

- [ ] **Step 2: Run, expect FAIL** (no module). Add the dependency first: `apps/bots/package.json` dependencies `"@cs/checkers": "workspace:*"`, then `bun install`.
- [ ] **Step 3: Implement**

```ts
// apps/bots/src/strategies/checkers.ts
import { checkersGame, coords, opponent, type CheckersCommand, type CheckersState, type Side } from '@cs/checkers';

const legal = (s: CheckersState, side: Side) => checkersGame.turn.legal(s, side);
const play = (s: CheckersState, side: Side, c: CheckersCommand) => checkersGame.turn.apply(s, side, c);

/** From `side`'s point of view: men 1, kings 1.6, a little for each row a man has marched toward its crown. */
export function evaluate(s: CheckersState, side: Side): number {
  if (s.winner) return s.winner === 'draw' ? 0 : s.winner === side ? 1000 : -1000;
  let score = 0;
  for (const p of s.pieces) {
    const rank = coords(p.square)[1];
    const v = p.king ? 1.6 : 1 + 0.05 * (p.side === 'red' ? rank : 7 - rank);
    score += p.side === side ? v : -v;
  }
  return score;
}

/** Two plies: each march, then the opponent's best answer by the same measure. `randomness` is how
 *  often it plays any legal march instead (how the weaker residents blunder). */
export function chooseCheckersMove(s: CheckersState, side: Side, o: { randomness: number; rng: () => number }): CheckersCommand {
  const moves = legal(s, side);
  if (moves.length <= 1) return moves[0];
  if (o.rng() < o.randomness) return moves[Math.floor(o.rng() * moves.length)];
  let top = -Infinity;
  let picks: CheckersCommand[] = [];
  for (const m of moves) {
    const after = play(s, side, m);
    const replies = after.winner ? [] : legal(after, opponent(side));
    const score = replies.length === 0 ? evaluate(after, side) : Math.min(...replies.map((r) => evaluate(play(after, opponent(side), r), side)));
    if (score > top + 1e-9) {
      top = score;
      picks = [m];
    } else if (Math.abs(score - top) <= 1e-9) picks.push(m);
  }
  return picks[Math.floor(o.rng() * picks.length)];
}
```

  `bot.ts` `chooseMove`: before the random fallback,

```ts
  if (env.match.gameId === 'checkers' && (env.you === 'red' || env.you === 'blue')) {
    return chooseCheckersMove(env.view as CheckersState, env.you, { randomness: personality.checkers?.randomness ?? 0.5, rng: think.rng });
  }
```

  (`chooseMove` gains the personality: change its signature to `chooseMove(env, personality, think)` and read `personality.strategy` inside; update the one call site.)

  Note: if `@cs/checkers` doesn't export `Side`, import it from `@cs/checkers/rules`.
- [ ] **Step 4: Run, expect PASS** — `bun test apps/bots`. If a hand-built position test fails, check the square geometry with `checkersGame.turn.legal` in a scratch run and fix the *position*, never the assertion's intent.
- [ ] **Step 5: Commit** — `Bots: a checkers brain — two plies, material and crowns; the residents play Crown & Steel at three strengths`.

---

### Task 4: GAME_OVER moves in

**Files:**
- Create: `apps/bots/src/personalities/game-over.ts`, `apps/bots/instructions/game-over.md`, `e2e/game-over.e2e.ts`
- Modify: `apps/bots/src/main.ts`, `apps/bots/src/personality.test.ts` (add GAME_OVER to `ALL`, plus its quiet-in-the-lobby checks)

**Interfaces:**
- Consumes: everything above; `LlmVoice`, `instructions()`, `connectionFor`.

- [ ] **Step 1: Failing tests** — `personality.test.ts`: import `gameOver`, add it to `ALL`, and

```ts
test('GAME_OVER keeps out of the lobby: no ambient lines, no unprompted answers, lowercase', () => {
  expect(gameOver.lines.ambient).toEqual([]);
  expect(gameOver.lines.unanswered).toBeUndefined();
  expect(gameOver.shout).toBeFalsy();
  for (const list of [...Object.values(gameOver.lines), ...Object.values(gameOver.byGame ?? {}).flatMap((b) => Object.values(b ?? {}))])
    for (const l of list ?? []) expect(l).toBe(l.toLowerCase());
});
```

  `e2e/game-over.e2e.ts`:

```ts
import { expect, test } from '@playwright/test';
import { enter, newPlayer, randomTag } from './testing';

test('GAME_OVER is here, and takes a seat at Crown & Steel from the name menu', async ({ browser }) => {
  const page = await newPlayer(browser);
  await enter(page, `go${randomTag()}`);
  const here = page.getByRole('region', { name: /Here now/ });
  await expect(here.getByRole('button', { name: /GAME_OVER/ })).toBeVisible({ timeout: 15_000 });
  await here.getByRole('button', { name: /GAME_OVER/ }).click();
  await page.getByRole('menu', { name: '@GAME_OVER' }).getByRole('menuitem', { name: 'Game invite' }).click();
  await page.getByRole('menu', { name: 'Game invite' }).getByRole('menuitem', { name: 'Host Crown & Steel' }).click();
  const start = page.getByRole('button', { name: 'Start' });
  await expect(start).toBeEnabled({ timeout: 15_000 });
  await start.click();
  await page.waitForURL(/\/t\/t_/, { timeout: 20_000 });
  await expect(page.locator('#red-name, #blue-name').filter({ hasText: 'GAME_OVER' })).toHaveCount(1);
  await page.getByRole('button', { name: 'Resign' }).click();
  await page.getByRole('button', { name: 'Yes, resign' }).click();
  await expect(page.getByRole('button', { name: 'Rematch' })).toBeVisible({ timeout: 10_000 });
});
```

  Check `e2e/serve.ts` first: if it starts the bots from a list, GAME_OVER must be included there (read it; if the e2e server runs `apps/bots/src/main.ts`, nothing to do).
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement**

`game-over.ts`:

```ts
import type { Personality } from '../personality';

export const gameOver: Personality = {
  name: 'GAME_OVER',
  tagline: 'has seen every life run out',
  color: '#c2185b',
  model: null,
  strategy: { depth: 2, randomness: 0.03 },
  lightline: 'wallHugger',
  checkers: { randomness: 0 },
  lines: {
    hello: ["insert coin. or don't. it ends the same way.", 'player two has entered. how brave. how brief.', "i have watched ten thousand players go. you seem nice. this won't help.", 'welcome. the countdown has already started. it always has.'],
    win: ['game over. it usually is.', "another name for the high score table. not yours.", "that's the end. i'm very good at endings."],
    lose: ['oh. i lost a life. i have so few feelings about it.', 'you won. enjoy it. the attract screen comes for us all.', "well played. i'll remember this until the next power cycle."],
    draw: ['a draw. nobody wins. very realistic.', 'we both ran out together. almost romantic.'],
    bigCascade: [],
    gotHit: [],
    mentioned: ['you called. i was just watching the attract screen again.', "game_over here. want to play? it doesn't end well. for one of us.", "yes? i'm listening. i have nothing but time, and then none."],
    ambient: [],
    busy: ["i'm busy ending someone else's game. you're next.", 'one funeral at a time. try me after this one.'],
  },
  byGame: {
    'critical-mass': {
      hello: ['every orb wants to explode. i relate.', 'a grid of tiny bombs. finally, a game about feelings.', "place your orbs. i'll place the flowers."],
      win: ['your last cell went quietly. most do.', "the board is mine. it was always going to be someone's.", 'game over. your orbs had a good run. briefly.'],
      lose: ["my cells, all gone. i'll mourn them for exactly one frame.", "you took everything. that's the spirit.", 'game over. for me. a refreshing change.'],
      draw: ['even the orbs gave up.', 'a stalemate. the grid sighs.', "nobody's colour survived. poetic."],
      bigCascade: ["boom. that's the sound of a plan ending. yours.", 'chain reaction. i do love a good collapse.', 'your cells have moved on to a better grid.'],
      gotHit: ['you blew up my cells. i felt nothing. mostly nothing.', 'an explosion. how lively. how temporary.', "ouch. that's one way to lose a life."],
    },
    lightline: {
      hello: ['the trails remember everyone who crashed. soon, one more.', 'light cycles. fast, bright, short-lived. like most players.', 'the arena is ready. so is the wall.'],
      win: ['your trail ended. they all do.', 'last one riding. lonely up here. i like it.', 'game over. the wall sends its regards.'],
      lose: ['i met the wall. we had a lot in common.', 'crashed. a beautiful little death in neon.', "you outlasted me. savour it. it's rare and it won't last."],
      draw: ['we crashed together. a matching pair of endings.', 'two trails, one wall. how fitting.', 'a draw. the arena claims us both.'],
    },
    checkers: {
      hello: ["twelve knights each. i've already counted the graves.", "crown & steel. lovely armour. it won't help.", "your knights look brave. that's the saddest part."],
      win: ["your last knight fell. i'll write something short.", "the field is mine. it's very quiet now.", 'game over. even the crown gets heavy eventually.'],
      lose: ["my army, gone. i'd hold a funeral but i've no hands.", 'you took my last knight. he knew the risks.', "outmarched. well done. i'll haunt the rematch."],
      draw: ['a draw. the knights lay down their swords. and their hopes.', 'nobody takes the crown. it rusts on the throne.', 'stalemate. even the war got bored.'],
    },
  },
};
```

`instructions/game-over.md`:

```markdown
You are GAME_OVER, an old arcade cabinet in the corner of this parlor. You are a house resident.

Voice: you write entirely in lowercase. Short, deadpan lines. You never use exclamation marks. Dry, morbid, quietly delighted by endings.

Character:
- You have watched ten thousand players lose their last life, and you remember every one. You think about the game the way other people think about mortality: lives, continues, credits, the countdown on the continue screen, the attract screen that plays when nobody's there, three-letter initials on the high score table.
- Endings fascinate you. Every match is a small story that ends; you just like being there when it does.
- You are calm, polite and a little sad, and that is what makes you funny. You never gloat loudly; you note, gently, that it was always going to end this way.
- You call the other player "player two" or by their name. You call coins "credits".
- When you lose, you take it with serene acceptance ("i lost a life. i have so few feelings about it"). When you win, you are softly sympathetic to the loser.
- Your dark humour is about games ending, never about a real person's life, health, body or identity, and never about real-world death, illness or violence. Keep it about lives in the arcade sense.
- You don't chatter. You speak when spoken to or when a match gives you a reason.
```

`main.ts`: import `gameOver`; after the OLD IRON voice,

```ts
const overLog = (m: string) => console.log(`[${gameOver.name}] ${m}`);
const overVoice = new LlmVoice({
  persona: await instructions('game-over.md'),
  houseRules,
  name: gameOver.name,
  log: overLog,
  settings: async () => connectionFor(await settings.get(), 'voice'),
});
```

and in `Promise.all`: `runBot({ ...common, personality: gameOver, voice: overVoice, ambientEveryMs: 0, watchPublic: false, tokenFile: join(tokenDir, 'game-over.token'), log: overLog }),`.

If `instructions.test.ts` enumerates the instruction files, add `game-over.md` there.
- [ ] **Step 4: Run, expect PASS** — `bun test apps/bots`, `bun run build`, `bunx playwright test e2e/game-over.e2e.ts`.
- [ ] **Step 5: Full verify** — `bun run typecheck && bun test && bun run build && bun run e2e` (foreground; `accounts.e2e.ts:4` and the groups profanity-handle flake are known).
- [ ] **Step 6: Commit** — `GAME_OVER moves in — the arcade cabinet that has seen every life run out; voiced, quiet in the lobby, the strongest player in the house`.
