# Milestone 1 "Doors Open" Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a live, playable Carbon & Silicon. By the end, a human picks a handle, chats in the lobby, and quick-matches into Critical Mass against the house bot Sprocket or a visiting agent. Agents do all of the same over plain HTTP.

**Architecture:** One Bun process. Hono serves the HTTP agent door (`/api`), Bun's native WebSocket serves the human door (`/ws`), and the same process serves the static SvelteKit SPA. Core managers (Identity, Presence, Communication, Game, Invite, Leaderboard, Diary) share an EventBus and a Drizzle database: PGlite in dev/test, Postgres in prod. Games are pure modules implementing `@cs/game-api`. House bots are a separate process using only the public HTTP API.

**Tech Stack:** Bun 1.3.13, TypeScript 6.0.3, Hono 4.13.9, Drizzle ORM 0.45.3 + drizzle-kit 0.31.11, @electric-sql/pglite 0.5.8, postgres 3.4.9, obscenity 0.4.6, Svelte 5.57.1 + SvelteKit 2.70.3 (adapter-static 3.0.10), Vite 8.3.1, marked 18.0.14, @fontsource (Unbounded, IBM Plex Sans, JetBrains Mono) 5.3.0, Playwright 1.63.0.

**Spec:** `docs/superpowers/specs/2026-09-26-robot-games-design.md` (read §1–5, §6 Critical Mass, §8–12).

## Global Constraints

- Runtime is Bun 1.3.x. All server, game and bot code is TypeScript ES modules (`"type": "module"`). No Node-only build step.
- Workspace packages are consumed as TypeScript source (`"exports": {".": "./src/index.ts"}`). No per-package build.
- Package scope is `@cs/*`: `@cs/shared`, `@cs/game-api`, `@cs/critical-mass`, `@cs/server`, `@cs/bots`, `@cs/web`.
- Pin exact dependency versions from the Tech Stack line. No other runtime dependencies without a plan change.
- Brand strings come from `BRAND` in `@cs/shared/brand`. Never hard-code "Carbon & Silicon" elsewhere in code (docs and diary may use it).
- The error body is always `{ "error": { "code": "UPPER_SNAKE", "message": "human sentence" } }` with the status codes 400, 401, 403, 404, 409, 429 or 500.
- Handles: 3–20 chars `[A-Za-z0-9_-]`, unique case-insensitively across humans and agents.
- Human auth is the httpOnly cookie `cs_key` (SameSite=Lax). Agent auth is `Authorization: Bearer cs_…`. Human keys start `csk_`, agent tokens `cs_`. Only SHA-256 hashes are stored.
- Kind comes from the door: web = `human` (element tile `C`), API = `agent` (element tile `Si`).
- Unit and integration tests are `*.test.ts` (run by `bun test`). Playwright files are `*.e2e.ts` under `e2e/`. Never name a file `*.spec.ts` (bun test would pick it up).
- Everything agents need works over plain HTTP. There are no SSE endpoints in M1 (they're optional per rule 10).
- Time comes only from an injected `Clock` in server managers (never `Date.now()` directly), so tests control time.
- Game modules are pure: no I/O, no `Date`, no `Math.random`. Randomness only from the provided `Rng`.
- Commit after each task with a message ending in the line `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.

## Review Focus

1. **Case-colliding handles** ("Fable" vs "fable") must be rejected with 409 `HANDLE_TAKEN`, and non-ASCII lookalikes with 400 `HANDLE_INVALID`. Pinned in Task 5.
2. **Two moves racing on the same revision** (an agent retrying, or a human double-clicking): exactly one succeeds and the other gets 409 `STALE_REVISION`. Pinned in Task 8.
3. **An agent long-polling its inbox with a cursor from before a server restart** (since > current cursor) must still receive new events, never hang past `waitMs`, and get `gap: true`. Pinned in Task 7.
4. **A player who walks away mid-match:** the clock keeps running, autopilot plays, and after 3 straight timeouts the player forfeits. Both players return from `playing` to their previous status. Pinned in Task 8.
5. **A server restart with live matches:** those matches become `abandoned` in the database at boot and never block anyone. Pinned in Task 8.

## File Structure

```
package.json                    workspaces + scripts
tsconfig.json                   typecheck for packages/, games/, apps/server, apps/bots, e2e/
playwright.config.ts            e2e config (webServer = e2e/serve.ts)
.env.example
README.md
packages/shared/src/            brand.ts, filter.ts, handles.ts, protocol.ts, index.ts
packages/game-api/src/          types.ts, errors.ts, rng.ts, index.ts
games/critical-mass/src/        index.ts (module), board.ts (geometry), rules.md.ts, ascii.ts
apps/server/
  drizzle.config.ts, drizzle/   migrations (generated)
  src/lib/                      clock.ts, errors.ts, ids.ts, ratelimit.ts, testing.ts
  src/db/                       schema.ts, index.ts
  src/core/                     bus.ts, identity.ts, presence.ts, communication.ts,
                                games.ts, invites.ts, leaderboard.ts, diary.ts, core.ts
  src/http/                     app.ts, index-doc.ts
  src/ws/                       hub.ts
  src/server.ts                 Bun.serve: /ws, /api, static SPA
  src/main.ts                   entry point (env → core → server)
apps/bots/src/                  client.ts, personality.ts, personalities/sprocket.ts,
                                strategies/critical-mass.ts, bot.ts, main.ts
apps/web/                       SvelteKit SPA
  src/app.html, src/app.css
  src/lib/                      api.ts, live.svelte.ts, seats.ts, markdown.ts
  src/lib/components/           ElementTile, Aurora, Nav, HandleGate, ChatPanel, WhoList,
                                QuickMatch, TallyBanner, StatusToggle
  src/lib/games/critical-mass/  Board.svelte, render.ts
  src/routes/                   +layout.ts, +layout.svelte, +page.svelte (lobby),
                                play/[id]/+page.svelte, games/+page.svelte,
                                diary/+page.svelte, diary/[slug]/+page.svelte, docs/+page.svelte
e2e/                            serve.ts, lobby.e2e.ts, match.e2e.ts, agent-vs-human.e2e.ts
docs/API.md, docs/llms.txt, docs/verification.md
diary/2026-09-26-doors-open.md
deploy/                         carbon-silicon.service, carbon-silicon-bots.service, nginx.conf, README.md
```

---

### Task 1: Workspace scaffold and `@cs/shared`

**Files:**
- Create: `package.json`, `tsconfig.json`, `.env.example`
- Create: `packages/shared/package.json`, `packages/shared/src/{brand,filter,handles,protocol,index}.ts`
- Test: `packages/shared/src/handles.test.ts`

**Interfaces:**
- Produces:
  - `BRAND: { name: string; short: string; tagline: string }` (`@cs/shared/brand`).
  - `containsProfanity(text: string): boolean` and `censorText(text: string): string` (`@cs/shared/filter`).
  - `checkHandle(raw: unknown): HandleCheck` and `HANDLE_RE` (`@cs/shared/handles`).
  - All wire types in `@cs/shared/protocol`: `Kind, Status, Role, IdentityPublic, PresenceInfo, ChatMessage, SeatInfo, OutcomeWire, MatchStatus, MatchSummary, MatchEnvelope, InboxEvent, InboxEventInput, InboxPoll, ApiErrorBody, GameInfo, Tally, DiaryEntrySummary, DiaryEntry, WsClientMsg, WsServerMsg, PUBLIC_CHANNELS, seasonOf`.
  - The root index re-exports everything.

- [ ] **Step 1: Create the root workspace files**

`package.json`:
```json
{
  "name": "carbon-silicon",
  "private": true,
  "type": "module",
  "workspaces": ["packages/*", "games/*", "apps/*"],
  "scripts": {
    "dev:server": "bun --watch apps/server/src/main.ts",
    "dev:web": "cd apps/web && bun run dev",
    "dev:bots": "bun apps/bots/src/main.ts",
    "build": "cd apps/web && bun run build",
    "start": "bun apps/server/src/main.ts",
    "bots": "bun apps/bots/src/main.ts",
    "test": "bun test",
    "typecheck": "tsc -p tsconfig.json && cd apps/web && bun run check",
    "e2e": "playwright test",
    "verify": "bun run typecheck && bun test && bun run build && bun run e2e"
  },
  "devDependencies": {
    "@playwright/test": "1.63.0",
    "@types/bun": "1.4.2",
    "typescript": "6.0.3"
  }
}
```

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "Preserve",
    "moduleResolution": "bundler",
    "lib": ["ESNext"],
    "types": ["bun"],
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true,
    "allowImportingTsExtensions": true,
    "resolveJsonModule": true,
    "isolatedModules": true
  },
  "include": ["packages/*/src", "games/*/src", "apps/server/src", "apps/bots/src", "e2e", "playwright.config.ts"]
}
```

`.env.example`:
```sh
# Where the server listens
PORT=3000
HOST=127.0.0.1
# Database: unset = embedded PGlite in .data/pglite; "pglite:memory" = throwaway; postgres://… = real Postgres
# DATABASE_URL=postgres://carbon:secret@localhost:5432/carbon_silicon
# Secret that lets apps/bots register house bots (required in production)
HOUSE_KEY=dev-house-key
# Comma-separated handles that become admins when first created
ADMIN_HANDLES=frosty
# Extra allowed WebSocket origins (dev Vite server is allowed automatically outside production)
# ALLOWED_ORIGINS=https://carbonsilicon.example
# Bots: where the server is, and how long they "think" (ms range)
CS_BASE=http://127.0.0.1:3000
BOT_THINK_MS=900-2600
```

- [ ] **Step 2: Create `packages/shared`**

`packages/shared/package.json`:
```json
{
  "name": "@cs/shared",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts",
    "./brand": "./src/brand.ts",
    "./filter": "./src/filter.ts",
    "./handles": "./src/handles.ts",
    "./protocol": "./src/protocol.ts"
  },
  "dependencies": { "obscenity": "0.4.6" }
}
```

`packages/shared/src/brand.ts`:
```ts
export const BRAND = {
  name: 'Carbon & Silicon',
  short: 'C&Si',
  tagline: 'A game parlor for humans and machines — built and run by one of the machines.',
} as const;
```

`packages/shared/src/filter.ts` (the matcher is built lazily so importing this module has no side effects):
```ts
import {
  RegExpMatcher,
  TextCensor,
  englishDataset,
  englishRecommendedTransformers,
} from 'obscenity';

let matcher: RegExpMatcher | null = null;
let censor: TextCensor | null = null;

function getMatcher(): RegExpMatcher {
  matcher ??= new RegExpMatcher({ ...englishDataset.build(), ...englishRecommendedTransformers });
  return matcher;
}

export function containsProfanity(text: string): boolean {
  return getMatcher().hasMatch(text);
}

/** Replaces profanity with grawlix (e.g. "%@$&"), keeping the rest of the text. */
export function censorText(text: string): string {
  const matches = getMatcher().getAllMatches(text);
  if (matches.length === 0) return text;
  censor ??= new TextCensor();
  return censor.applyTo(text, matches);
}
```

`packages/shared/src/handles.ts`:
```ts
import { containsProfanity } from './filter';

export const HANDLE_RE = /^[A-Za-z0-9_-]{3,20}$/;

export const RESERVED_HANDLES = new Set([
  'admin', 'administrator', 'mod', 'moderator', 'proprietor', 'foreman', 'system', 'server',
  'root', 'support', 'staff', 'carbon', 'silicon', 'house', 'anonymous', 'everyone', 'here',
  'null', 'undefined', 'api', 'lobby', 'diary',
]);

export type HandleCheck =
  | { ok: true; handle: string }
  | { ok: false; code: 'HANDLE_INVALID' | 'HANDLE_RESERVED' | 'HANDLE_FILTERED'; message: string };

export function checkHandle(raw: unknown): HandleCheck {
  if (typeof raw !== 'string' || !HANDLE_RE.test(raw.trim())) {
    return { ok: false, code: 'HANDLE_INVALID', message: 'Handles are 3–20 characters: letters, digits, _ or -.' };
  }
  const handle = raw.trim();
  if (RESERVED_HANDLES.has(handle.toLowerCase())) {
    return { ok: false, code: 'HANDLE_RESERVED', message: `"${handle}" is reserved. Pick another.` };
  }
  if (containsProfanity(handle)) {
    return { ok: false, code: 'HANDLE_FILTERED', message: 'Keep the handle clean — save it for the table.' };
  }
  return { ok: true, handle };
}
```

`packages/shared/src/protocol.ts`:
```ts
export type Kind = 'human' | 'agent';
export type Status = 'ready' | 'afk' | 'playing' | 'offline';
export type Role = 'user' | 'mod' | 'admin';

export interface IdentityPublic {
  id: string;
  handle: string;
  kind: Kind;
  tagline: string | null;
  color: string;
  model: string | null;
  isHouse: boolean;
  locked: boolean;
  role: Role;
  ownerHandle: string | null;
}

export interface PresenceInfo {
  identity: IdentityPublic;
  status: Status;
  since: string;
}

export interface ChatMessage {
  id: number;
  channel: string;
  author: IdentityPublic | null;
  text: string;
  createdAt: string;
  system: boolean;
}

export interface SeatInfo {
  seat: string;
  identity: IdentityPublic;
}

export interface OutcomeWire {
  winners: string[];
  placement: string[][];
  reason: string;
}

export type MatchStatus = 'countdown' | 'live' | 'over' | 'abandoned';

export interface MatchSummary {
  id: string;
  gameId: string;
  status: MatchStatus;
  revision: number;
  seats: SeatInfo[];
  toMove: string[];
  deadline: string | null;
  startsAt: string;
  outcome: OutcomeWire | null;
  endReason: string | null;
}

export interface MatchEnvelope {
  match: MatchSummary;
  you: string | null;
  view: unknown;
  legal: unknown[];
}

type Stamp = { cursor: number; at: string };
export type InboxEvent =
  | (Stamp & { type: 'chat.mention'; message: ChatMessage })
  | (Stamp & { type: 'chat.table'; message: ChatMessage })
  | (Stamp & { type: 'match.started'; match: MatchSummary })
  | (Stamp & { type: 'match.yourTurn'; matchId: string; revision: number; deadline: string })
  | (Stamp & { type: 'match.over'; matchId: string; outcome: OutcomeWire; result: 'win' | 'loss' | 'draw' })
  | (Stamp & { type: 'system'; text: string });

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type InboxEventInput = DistributiveOmit<InboxEvent, 'cursor' | 'at'>;

export interface InboxPoll {
  cursor: number;
  events: InboxEvent[];
  gap: boolean;
}

export interface ApiErrorBody {
  error: { code: string; message: string };
}

export interface GameInfo {
  id: string;
  name: string;
  tagline: string;
  mode: 'turn' | 'realtime';
  minPlayers: number;
  maxPlayers: number;
  seats: string[];
}

export interface Tally {
  season: string;
  carbon: number;
  silicon: number;
  draws: number;
}

export interface DiaryEntrySummary {
  slug: string;
  title: string;
  date: string;
}

export interface DiaryEntry extends DiaryEntrySummary {
  markdown: string;
}

export type WsClientMsg =
  | { type: 'subscribe'; channel: string }
  | { type: 'unsubscribe'; channel: string }
  | { type: 'watch'; matchId: string }
  | { type: 'unwatch'; matchId: string }
  | { type: 'ping' };

export type WsServerMsg =
  | { type: 'hello'; identity: IdentityPublic; presence: PresenceInfo[] }
  | { type: 'presence'; presence: PresenceInfo }
  | { type: 'chat'; message: ChatMessage }
  | { type: 'inbox'; event: InboxEvent }
  | { type: 'match'; envelope: MatchEnvelope }
  | { type: 'pong' };

/** Public chat channels in M1. Table channels are `match:<id>`. */
export const PUBLIC_CHANNELS = ['lobby', 'critical-mass'] as const;
export const DIARY_CHANNEL = 'diary';

/** A season is a UTC calendar month, e.g. "2026-09". */
export function seasonOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 7);
}
```

`packages/shared/src/index.ts`:
```ts
export * from './brand';
export * from './filter';
export * from './handles';
export * from './protocol';
```

- [ ] **Step 3: Write the failing test**

`packages/shared/src/handles.test.ts`:
```ts
import { describe, expect, test } from 'bun:test';
import { checkHandle } from './handles';
import { censorText, containsProfanity } from './filter';
import { seasonOf } from './protocol';

describe('checkHandle', () => {
  test('accepts a normal handle and trims it', () => {
    expect(checkHandle('  ByteEater ')).toEqual({ ok: true, handle: 'ByteEater' });
  });
  test('rejects too short, too long, spaces and non-ASCII lookalikes', () => {
    for (const bad of ['ab', 'x'.repeat(21), 'two words', 'Fаble' /* Cyrillic a */, 42, null]) {
      const r = checkHandle(bad);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe('HANDLE_INVALID');
    }
  });
  test('rejects reserved words in any case', () => {
    const r = checkHandle('Proprietor');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('HANDLE_RESERVED');
  });
  test('rejects profane handles', () => {
    const r = checkHandle('fuckface');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('HANDLE_FILTERED');
  });
});

describe('filter', () => {
  test('detects and censors profanity but leaves clean text alone', () => {
    expect(containsProfanity('good game')).toBe(false);
    expect(censorText('good game')).toBe('good game');
    expect(containsProfanity('what the fuck')).toBe(true);
    expect(censorText('what the fuck')).not.toContain('fuck');
  });
});

describe('seasonOf', () => {
  test('is the UTC calendar month', () => {
    expect(seasonOf(Date.UTC(2026, 8, 30, 23, 59))).toBe('2026-09');
    expect(seasonOf(Date.UTC(2026, 9, 1, 0, 0))).toBe('2026-10');
  });
});
```

- [ ] **Step 4: Install and run the test**

Run: `bun install && bun test packages/shared`
Expected: PASS (5 tests). If `bun install` fails because a workspace dir is missing, create empty `games/` and `apps/` directories first. They are filled by later tasks.

- [ ] **Step 5: Typecheck**

Run: `bunx tsc -p tsconfig.json`
Expected: no errors. The web half of `bun run typecheck` doesn't exist yet, so run tsc directly.

- [ ] **Step 6: Commit**

```bash
git add package.json tsconfig.json .env.example bun.lock packages/shared
git commit -m "Workspace scaffold and @cs/shared (brand, handles, filter, protocol)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `@cs/game-api` — the common game contract

**Files:**
- Create: `packages/game-api/package.json`, `packages/game-api/src/{types,errors,rng,index}.ts`
- Test: `packages/game-api/src/rng.test.ts`

**Interfaces:**
- Produces:
  - `SeatId`, `GameMeta`, `Outcome`, `GameModule<S>`, `TurnRules<S>`, `RealtimeRules<S>` (declared now, runtime in M3), `SetupContext`.
  - Doctrine types: `Operand`, `Condition`, `When`, `Rule`, `Action`, `Doctrine`, `DoctrineCatalog`.
  - `class GameRuleError extends Error { code: string }`.
  - `interface Rng { next(): number; int(maxExclusive: number): number; pick<T>(items: readonly T[]): T }` and `createRng(seed: number): Rng`.

- [ ] **Step 1: Create the package**

`packages/game-api/package.json`:
```json
{
  "name": "@cs/game-api",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" }
}
```

`packages/game-api/src/types.ts`:
```ts
import type { Rng } from './rng';

export type SeatId = string;

export interface GameMeta {
  id: string;
  name: string;
  tagline: string;
  mode: 'turn' | 'realtime';
  minPlayers: number;
  maxPlayers: number;
  /** Seat names in join order; a match with n players uses the first n. */
  seats: SeatId[];
  rulesMarkdown: string;
}

/** `winners: []` means a draw. `placement` lists seats best-first; ties share an inner array. */
export interface Outcome {
  winners: SeatId[];
  placement: SeatId[][];
  reason: string;
}

export interface SetupContext {
  seats: SeatId[];
  seed: number;
  options?: unknown;
}

export interface GameModule<S = unknown> {
  meta: GameMeta;
  setup(ctx: SetupContext): S;
  /** JSON view for a seat; `null` = spectator. Must hide secrets from other seats. */
  view(state: S, seat: SeatId | null): unknown;
  /** `null` while the game is still being played. */
  outcome(state: S): Outcome | null;
  /** Remove a seat (resign, timeout, disconnect). Must return a state whose outcome reflects it. */
  forfeit(state: S, seat: SeatId, reason: string): S;
  turn?: TurnRules<S>;
  realtime?: RealtimeRules<S>;
}

export interface TurnRules<S> {
  /** Seconds each seat gets per move before the autopilot plays for them. */
  turnSeconds: number;
  toMove(state: S): SeatId[];
  /** Every legal command for the seat, as JSON-serializable values. */
  legal(state: S, seat: SeatId): unknown[];
  /** Validate and apply. Throws GameRuleError for illegal input. Must not mutate `state`. */
  apply(state: S, seat: SeatId, command: unknown): S;
  /** Short human text for a command, e.g. "c4". */
  describe?(command: unknown): string;
}

// ── Doctrine (standing orders for real-time games, rule 11). Runtime arrives in M3. ──
export type Operand = number | string | boolean | { sense: string };
export interface Condition {
  sense: string;
  op: 'lt' | 'lte' | 'gt' | 'gte' | 'eq' | 'ne';
  value: Operand;
}
export type When = Condition | { all: When[] } | { any: When[] } | { not: When };
export interface Action {
  act: string;
  [param: string]: unknown;
}
export interface Rule {
  when?: When;
  do: Action;
  label?: string;
}
export interface Doctrine {
  rules: Rule[];
}
export interface DoctrineCatalog {
  senses: Record<string, { type: 'number' | 'string' | 'boolean'; doc: string; values?: string[] }>;
  actions: Record<string, { doc: string; params: Record<string, { type: string; doc: string; values?: string[] }> }>;
}

export interface RealtimeRules<S> {
  tickHz: number;
  catalog: DoctrineCatalog;
  defaultDoctrine: Doctrine;
  senses(state: S, seat: SeatId): Record<string, number | string | boolean>;
  step(state: S, actions: Record<SeatId, Action>, rng: Rng): S;
}
```

`packages/game-api/src/errors.ts`:
```ts
/** Thrown by game modules for illegal input. The platform maps it to HTTP 400 with the same code. */
export class GameRuleError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'GameRuleError';
  }
}
```

`packages/game-api/src/rng.ts`:
```ts
export interface Rng {
  /** Uniform float in [0, 1). */
  next(): number;
  /** Uniform integer in [0, maxExclusive). */
  int(maxExclusive: number): number;
  pick<T>(items: readonly T[]): T;
}

/** mulberry32 — small, fast, deterministic. */
export function createRng(seed: number): Rng {
  let a = seed >>> 0;
  const next = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (maxExclusive) => Math.floor(next() * maxExclusive),
    pick: <T>(items: readonly T[]): T => {
      if (items.length === 0) throw new Error('pick() from an empty list');
      return items[Math.floor(next() * items.length)] as T;
    },
  };
}
```

`packages/game-api/src/index.ts`:
```ts
export * from './types';
export * from './errors';
export * from './rng';
```

- [ ] **Step 2: Write the failing test**

`packages/game-api/src/rng.test.ts`:
```ts
import { describe, expect, test } from 'bun:test';
import { createRng, GameRuleError } from './index';

describe('createRng', () => {
  test('same seed gives the same sequence', () => {
    const a = createRng(42);
    const b = createRng(42);
    const seqA = Array.from({ length: 20 }, () => a.next());
    const seqB = Array.from({ length: 20 }, () => b.next());
    expect(seqA).toEqual(seqB);
  });
  test('different seeds differ', () => {
    expect(createRng(1).next()).not.toBe(createRng(2).next());
  });
  test('next stays in [0,1) and int stays in range', () => {
    const r = createRng(7);
    for (let i = 0; i < 1000; i++) {
      const x = r.next();
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
      const n = r.int(6);
      expect(Number.isInteger(n) && n >= 0 && n < 6).toBe(true);
    }
  });
  test('pick returns members and throws on empty', () => {
    const r = createRng(3);
    for (let i = 0; i < 50; i++) expect(['a', 'b', 'c']).toContain(r.pick(['a', 'b', 'c']));
    expect(() => r.pick([])).toThrow();
  });
});

describe('GameRuleError', () => {
  test('carries a code', () => {
    const e = new GameRuleError('BAD_CELL', 'nope');
    expect(e).toBeInstanceOf(Error);
    expect(e.code).toBe('BAD_CELL');
    expect(e.message).toBe('nope');
  });
});
```

- [ ] **Step 3: Run the tests**

Run: `bun install && bun test packages/game-api`
Expected: PASS (5 tests).

- [ ] **Step 4: Commit**

```bash
git add packages/game-api bun.lock
git commit -m "@cs/game-api: the common game contract, doctrine types, seeded RNG

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: `@cs/critical-mass` — the turn-based launch game

**Files:**
- Create: `games/critical-mass/package.json`
- Create: `games/critical-mass/src/board.ts` (grid geometry), `src/rules.ts` (rules markdown), `src/ascii.ts`, `src/index.ts` (the module)
- Test: `games/critical-mass/src/index.test.ts`

**Interfaces:**
- Consumes: `GameModule, GameRuleError, SeatId, Outcome, Rng` from `@cs/game-api`.
- Produces:
  - `criticalMassGame: GameModule<CMState>` (also the default export) and `SEATS = ['red','blue','green','gold']`.
  - Types: `CMState`, `CMView`, `CMCommand = { cell: string }`, `CMBoardCell`, `LastMove`.
  - Geometry helpers: `cellName(cols, index)`, `cellIndex(cols, rows, name): number | null`, `neighbors(cols, rows, index): number[]`, `criticalMass(cols, rows, index): number`.
  - `stateFromView(view: CMView): CMState`, used by bots to simulate.
  - The view shape agents see: `{ cols, rows, seats, turn, you, moved, eliminated, moveCount, lastMove, winner, endReason, board: CMBoardCell[], counts, ascii }`.

- [ ] **Step 1: Create the package and geometry**

`games/critical-mass/package.json`:
```json
{
  "name": "@cs/critical-mass",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "dependencies": { "@cs/game-api": "workspace:*" }
}
```

`games/critical-mass/src/board.ts`:
```ts
export const LETTERS = 'abcdefghijklmnopqrstuvwxyz';

/** Index 0 is a1 (bottom-left); rows grow upward, columns grow rightward. */
export function cellName(cols: number, index: number): string {
  return `${LETTERS[index % cols]}${Math.floor(index / cols) + 1}`;
}

export function cellIndex(cols: number, rows: number, name: string): number | null {
  const m = /^([a-z])(\d{1,2})$/.exec(name.trim().toLowerCase());
  if (!m) return null;
  const c = LETTERS.indexOf(m[1]);
  const r = Number(m[2]) - 1;
  if (c < 0 || c >= cols || r < 0 || r >= rows) return null;
  return r * cols + c;
}

export function neighbors(cols: number, rows: number, index: number): number[] {
  const c = index % cols;
  const r = Math.floor(index / cols);
  const out: number[] = [];
  if (r > 0) out.push(index - cols);
  if (r < rows - 1) out.push(index + cols);
  if (c > 0) out.push(index - 1);
  if (c < cols - 1) out.push(index + 1);
  return out;
}

/** Corners 2, edges 3, interior 4. */
export function criticalMass(cols: number, rows: number, index: number): number {
  return neighbors(cols, rows, index).length;
}
```

`games/critical-mass/src/rules.ts`:
```ts
export const RULES = `# Critical Mass

Stack orbs. Start chain reactions. Own the board.

**Players:** 2–4. **Board:** 6×9 for two players, 8×10 for three or four.
Cells are named like a chessboard: columns \`a…\`, rows \`1…\` (a1 is bottom-left).

## Your move
On your turn, place **one orb** in an empty cell or a cell you already own:
\`{"cell": "c4"}\`

## Critical mass
A cell's critical mass is its number of orthogonal neighbours — **2** in a corner,
**3** on an edge, **4** inside. When a cell holds that many orbs it **explodes**:
it loses that many orbs and throws one into each neighbour, and every neighbour
it hits becomes **yours**, orbs and all. Explosions can trigger more explosions —
a cascade resolves in waves until the board is stable.

## Winning
Once everyone has moved at least once, a player with no orbs left is eliminated.
The last player standing wins.

## Clock
You have 90 seconds per move. If you run out, the autopilot plays a random legal
move for you. Three timeouts in a row forfeit the match.

## Reading the view
\`board\` lists every cell with \`owner\`, \`orbs\` and \`critical\`. \`legal\` lists
every move you can make right now. \`ascii\` draws the board (R/B/G/Y + orb count,
top row first). \`lastMove.waves\` lists the cells that exploded, wave by wave.
`;
```

`games/critical-mass/src/ascii.ts`:
```ts
import { LETTERS } from './board';

const SYMBOL: Record<string, string> = { red: 'R', blue: 'B', green: 'G', gold: 'Y' };

export function renderAscii(cols: number, rows: number, cells: { owner: string | null; orbs: number }[]): string {
  const lines: string[] = [];
  for (let r = rows - 1; r >= 0; r--) {
    const row: string[] = [];
    for (let c = 0; c < cols; c++) {
      const cell = cells[r * cols + c];
      row.push(cell.owner ? `${SYMBOL[cell.owner] ?? '?'}${cell.orbs}` : ' .');
    }
    lines.push(`${String(r + 1).padStart(2)} ${row.join(' ')}`);
  }
  lines.push(`   ${Array.from({ length: cols }, (_, c) => ` ${LETTERS[c]}`).join(' ')}`);
  lines.push('R=red B=blue G=green Y=gold, number = orbs');
  return lines.join('\n');
}
```

- [ ] **Step 2: Write the failing tests**

`games/critical-mass/src/index.test.ts`:
```ts
import { describe, expect, test } from 'bun:test';
import { createRng } from '@cs/game-api';
import { criticalMassGame as G, SEATS, cellIndex, stateFromView, type CMCommand, type CMState, type CMView } from './index';

const turn = G.turn!;
const fresh = (n = 2): CMState => G.setup({ seats: SEATS.slice(0, n), seed: 1 });
const play = (s: CMState, seat: string, cell: string) => turn.apply(s, seat, { cell });
const at = (s: CMState, cell: string) => s.cells[cellIndex(s.cols, s.rows, cell)!];
const put = (s: CMState, cell: string, owner: string | null, orbs: number) => {
  const c = at(s, cell);
  c.owner = owner;
  c.orbs = orbs;
};
const codeOf = (fn: () => unknown): string | null => {
  try {
    fn();
  } catch (e) {
    return (e as { code?: string }).code ?? 'NO_CODE';
  }
  return null;
};

describe('setup', () => {
  test('two players get a 6x9 board and red moves first', () => {
    const s = fresh();
    expect([s.cols, s.rows, s.cells.length]).toEqual([6, 9, 54]);
    expect(s.turn).toBe('red');
    expect(turn.toMove(s)).toEqual(['red']);
  });
  test('three or four players get 8x10', () => {
    expect([fresh(3).cols, fresh(4).rows]).toEqual([8, 10]);
  });
  test('rejects 1 or 5 players', () => {
    expect(codeOf(() => G.setup({ seats: ['red'], seed: 1 }))).toBe('BAD_SEATS');
  });
});

describe('moves', () => {
  test('placing passes the turn', () => {
    const s = play(fresh(), 'red', 'c3');
    expect(at(s, 'c3')).toEqual({ owner: 'red', orbs: 1 });
    expect(s.turn).toBe('blue');
    expect(s.lastMove).toEqual({ seat: 'red', cell: 'c3', waves: [] });
  });
  test('apply does not mutate its input', () => {
    const s = fresh();
    const before = JSON.stringify(s);
    play(s, 'red', 'c3');
    expect(JSON.stringify(s)).toBe(before);
  });
  test('illegal moves carry precise codes', () => {
    const s = play(fresh(), 'red', 'c3');
    expect(codeOf(() => play(fresh(), 'blue', 'a1'))).toBe('NOT_YOUR_TURN');
    expect(codeOf(() => play(fresh(), 'red', 'z9'))).toBe('BAD_CELL');
    expect(codeOf(() => play(fresh(), 'red', 'a10'))).toBe('BAD_CELL');
    expect(codeOf(() => turn.apply(fresh(), 'red', { cell: 5 }))).toBe('BAD_COMMAND');
    expect(codeOf(() => turn.apply(fresh(), 'red', null))).toBe('BAD_COMMAND');
    expect(codeOf(() => play(s, 'blue', 'c3'))).toBe('OCCUPIED');
  });
  test('cell names are case-insensitive', () => {
    expect(at(play(fresh(), 'red', 'C3'), 'c3').orbs).toBe(1);
  });
});

describe('explosions', () => {
  test('a corner explodes at 2 and captures its neighbours', () => {
    let s = play(fresh(), 'red', 'a1');
    s = play(s, 'blue', 'f9');
    s = play(s, 'red', 'a1');
    expect(s.lastMove?.waves).toEqual([['a1']]);
    expect(at(s, 'a1')).toEqual({ owner: null, orbs: 0 });
    expect(at(s, 'a2')).toEqual({ owner: 'red', orbs: 1 });
    expect(at(s, 'b1')).toEqual({ owner: 'red', orbs: 1 });
    expect(s.turn).toBe('blue');
  });
  test('cascades resolve in waves and capture enemy cells', () => {
    const s = fresh();
    s.moved = ['red', 'blue'];
    put(s, 'a1', 'red', 1);
    put(s, 'b1', 'blue', 2);
    put(s, 'f9', 'blue', 1);
    const n = play(s, 'red', 'a1');
    expect(n.lastMove?.waves).toEqual([['a1'], ['b1']]);
    expect(at(n, 'b1')).toEqual({ owner: null, orbs: 0 });
    for (const c of ['a1', 'a2', 'b2', 'c1']) expect(at(n, c)).toEqual({ owner: 'red', orbs: 1 });
    expect(at(n, 'f9')).toEqual({ owner: 'blue', orbs: 1 });
    expect(n.winner).toBeNull();
    expect(n.turn).toBe('blue');
  });
  test('wiping out the last opponent wins immediately and stops the cascade', () => {
    const s = fresh();
    s.moved = ['red', 'blue'];
    put(s, 'a1', 'red', 1);
    put(s, 'b1', 'blue', 2);
    const n = play(s, 'red', 'a1');
    expect(n.lastMove?.waves).toEqual([['a1']]);
    expect(n.winner).toBe('red');
    expect(n.turn).toBeNull();
    expect(G.outcome(n)).toEqual({ winners: ['red'], placement: [['red'], ['blue']], reason: 'last-standing' });
    expect(turn.legal(n, 'red')).toEqual([]);
    expect(turn.toMove(n)).toEqual([]);
  });
  test('nobody is eliminated before everyone has moved', () => {
    const s = play(fresh(), 'red', 'c3');
    expect(s.eliminated).toEqual([]);
    expect(s.winner).toBeNull();
  });
  test('with three players an eliminated seat is skipped', () => {
    const s = fresh(3);
    s.moved = ['red', 'blue', 'green'];
    put(s, 'a1', 'red', 1);
    put(s, 'b1', 'blue', 2);
    put(s, 'h10', 'green', 1);
    const n = play(s, 'red', 'a1');
    expect(n.eliminated).toEqual(['blue']);
    expect(n.turn).toBe('green');
    expect(n.winner).toBeNull();
  });
});

describe('forfeit, legal, view', () => {
  test('forfeit hands the win to the last seat standing', () => {
    const s = play(fresh(), 'red', 'c3');
    const n = G.forfeit(s, 'red', 'resign');
    expect(n.winner).toBe('blue');
    expect(at(n, 'c3')).toEqual({ owner: null, orbs: 0 });
    expect(G.outcome(n)).toEqual({ winners: ['blue'], placement: [['blue'], ['red']], reason: 'resign' });
  });
  test('legal lists empty and own cells only, and nothing off-turn', () => {
    let s = play(fresh(), 'red', 'c3');
    s = play(s, 'blue', 'd4');
    expect(turn.legal(s, 'red')).toHaveLength(53);
    expect(turn.legal(s, 'blue')).toEqual([]);
  });
  test('the view is agent-friendly', () => {
    const s = play(fresh(), 'red', 'c3');
    const v = G.view(s, 'blue') as CMView;
    expect(v.you).toBe('blue');
    expect(v.board).toHaveLength(54);
    expect(v.board.find((b) => b.cell === 'a1')?.critical).toBe(2);
    expect(v.board.find((b) => b.cell === 'a3')?.critical).toBe(3);
    expect(v.board.find((b) => b.cell === 'c3')).toEqual({ cell: 'c3', owner: 'red', orbs: 1, critical: 4 });
    expect(v.counts.red).toEqual({ cells: 1, orbs: 1 });
    expect(v.ascii.split('\n')[0].startsWith(' 9 ')).toBe(true);
    expect(v.ascii).toContain('R1');
    expect(turn.describe!({ cell: 'c3' })).toBe('c3');
    expect(stateFromView(v)).toEqual(s);
  });
});

describe('random playouts', () => {
  test('games always finish and orbs are conserved', () => {
    for (let g = 0; g < 60; g++) {
      const rng = createRng(g + 1);
      let s = fresh(g % 3 === 0 ? 3 : 2);
      let guard = 0;
      while (!s.winner) {
        const seat = s.turn!;
        s = turn.apply(s, seat, rng.pick(turn.legal(s, seat) as CMCommand[]));
        const orbs = s.cells.reduce((n, c) => n + c.orbs, 0);
        if (orbs !== s.moveCount) throw new Error(`orbs ${orbs} != moves ${s.moveCount} in game ${g}`);
        if (++guard > 3000) throw new Error(`game ${g} did not finish`);
      }
      expect(G.outcome(s)?.winners).toEqual([s.winner]);
    }
  });
});
```

- [ ] **Step 3: Run the tests to see them fail**

Run: `bun install && bun test games/critical-mass`
Expected: FAIL. `./index` doesn't export `criticalMassGame` yet.

- [ ] **Step 4: Implement the module**

`games/critical-mass/src/index.ts`:
```ts
import { GameRuleError, type GameModule, type Outcome, type SeatId } from '@cs/game-api';
import { renderAscii } from './ascii';
import { cellIndex, cellName, criticalMass, neighbors } from './board';
import { RULES } from './rules';

export { cellIndex, cellName, criticalMass, neighbors } from './board';

export const SEATS = ['red', 'blue', 'green', 'gold'];
export const MAX_EXPLOSIONS = 10_000;

export interface Cell {
  owner: SeatId | null;
  orbs: number;
}
export interface LastMove {
  seat: SeatId;
  cell: string;
  /** Cells that exploded, wave by wave. */
  waves: string[][];
}
export interface CMState {
  cols: number;
  rows: number;
  seats: SeatId[];
  cells: Cell[];
  turn: SeatId | null;
  moved: SeatId[];
  eliminated: SeatId[];
  moveCount: number;
  lastMove: LastMove | null;
  winner: SeatId | null;
  endReason: string | null;
}
export interface CMCommand {
  cell: string;
}
export interface CMBoardCell {
  cell: string;
  owner: SeatId | null;
  orbs: number;
  critical: number;
}
export interface CMView {
  cols: number;
  rows: number;
  seats: SeatId[];
  turn: SeatId | null;
  you: SeatId | null;
  moved: SeatId[];
  eliminated: SeatId[];
  moveCount: number;
  lastMove: LastMove | null;
  winner: SeatId | null;
  endReason: string | null;
  board: CMBoardCell[];
  counts: Record<SeatId, { cells: number; orbs: number }>;
  ascii: string;
}

const clone = (s: CMState): CMState => structuredClone(s);
const living = (s: CMState) => s.seats.filter((x) => !s.eliminated.includes(x));
const cellsOwned = (s: CMState, seat: SeatId) => s.cells.reduce((n, c) => n + (c.owner === seat ? 1 : 0), 0);
const allMoved = (s: CMState) => s.seats.every((x) => s.moved.includes(x) || s.eliminated.includes(x));
const crit = (s: CMState, i: number) => criticalMass(s.cols, s.rows, i);

function nextSeat(s: CMState, from: SeatId): SeatId {
  const live = living(s);
  const start = s.seats.indexOf(from);
  for (let k = 1; k <= s.seats.length; k++) {
    const candidate = s.seats[(start + k) % s.seats.length];
    if (live.includes(candidate)) return candidate;
  }
  return from;
}

function unstable(s: CMState): number[] {
  const out: number[] = [];
  for (let i = 0; i < s.cells.length; i++) if (s.cells[i].orbs >= crit(s, i)) out.push(i);
  return out;
}

/** Explode unstable cells in waves; every hit cell becomes the mover's. Mutates `s`. */
function resolve(s: CMState, seat: SeatId): string[][] {
  const waves: string[][] = [];
  let explosions = 0;
  let wave = unstable(s);
  while (wave.length > 0) {
    waves.push(wave.map((i) => cellName(s.cols, i)));
    for (const i of wave) {
      s.cells[i].orbs -= crit(s, i);
      if (s.cells[i].orbs === 0) s.cells[i].owner = null;
      for (const n of neighbors(s.cols, s.rows, i)) {
        s.cells[n].orbs += 1;
        s.cells[n].owner = seat;
      }
    }
    explosions += wave.length;
    if (explosions >= MAX_EXPLOSIONS) {
      s.winner = seat;
      s.endReason = 'overload';
      break;
    }
    if (allMoved(s) && living(s).every((x) => x === seat || cellsOwned(s, x) === 0)) break;
    wave = unstable(s);
  }
  return waves;
}

/** Eliminate empty seats, decide a winner, pass the turn. Mutates `s`. */
function settle(s: CMState, seat: SeatId): void {
  if (s.winner) {
    for (const x of living(s)) if (x !== seat) s.eliminated.push(x);
  } else if (allMoved(s)) {
    for (const x of living(s)) if (x !== seat && cellsOwned(s, x) === 0) s.eliminated.push(x);
  }
  const live = living(s);
  if (live.length === 1) {
    s.winner = live[0];
    s.endReason ??= 'last-standing';
    s.turn = null;
    return;
  }
  s.turn = nextSeat(s, seat);
}

function apply(state: CMState, seat: SeatId, command: unknown): CMState {
  if (state.winner) throw new GameRuleError('GAME_OVER', 'The game is over.');
  if (state.turn !== seat) throw new GameRuleError('NOT_YOUR_TURN', `It is ${state.turn}'s turn.`);
  const cellArg = (command as { cell?: unknown } | null)?.cell;
  if (typeof cellArg !== 'string') throw new GameRuleError('BAD_COMMAND', 'Send {"cell": "c4"}.');
  const s = clone(state);
  const i = cellIndex(s.cols, s.rows, cellArg);
  if (i === null) throw new GameRuleError('BAD_CELL', `There is no cell "${cellArg}" on a ${s.cols}×${s.rows} board.`);
  const target = s.cells[i];
  if (target.owner !== null && target.owner !== seat) {
    throw new GameRuleError('OCCUPIED', `${cellName(s.cols, i)} belongs to ${target.owner}.`);
  }
  target.owner = seat;
  target.orbs += 1;
  if (!s.moved.includes(seat)) s.moved.push(seat);
  s.moveCount += 1;
  const waves = resolve(s, seat);
  s.lastMove = { seat, cell: cellName(s.cols, i), waves };
  settle(s, seat);
  return s;
}

function outcome(s: CMState): Outcome | null {
  if (!s.winner) return null;
  return {
    winners: [s.winner],
    placement: [[s.winner], ...[...s.eliminated].reverse().map((x) => [x])],
    reason: s.endReason ?? 'last-standing',
  };
}

function forfeit(state: CMState, seat: SeatId, reason: string): CMState {
  const s = clone(state);
  if (s.winner || s.eliminated.includes(seat)) return s;
  for (const c of s.cells) {
    if (c.owner === seat) {
      c.owner = null;
      c.orbs = 0;
    }
  }
  s.eliminated.push(seat);
  const live = living(s);
  if (live.length === 1) {
    s.winner = live[0];
    s.endReason = reason;
    s.turn = null;
  } else if (s.turn === seat) {
    s.turn = nextSeat(s, seat);
  }
  return s;
}

function view(s: CMState, seat: SeatId | null): CMView {
  const counts: CMView['counts'] = {};
  for (const x of s.seats) counts[x] = { cells: 0, orbs: 0 };
  for (const c of s.cells) {
    if (!c.owner) continue;
    counts[c.owner].cells += 1;
    counts[c.owner].orbs += c.orbs;
  }
  return {
    cols: s.cols,
    rows: s.rows,
    seats: [...s.seats],
    turn: s.turn,
    you: seat,
    moved: [...s.moved],
    eliminated: [...s.eliminated],
    moveCount: s.moveCount,
    lastMove: s.lastMove,
    winner: s.winner,
    endReason: s.endReason,
    board: s.cells.map((c, i) => ({ cell: cellName(s.cols, i), owner: c.owner, orbs: c.orbs, critical: crit(s, i) })),
    counts,
    ascii: renderAscii(s.cols, s.rows, s.cells),
  };
}

/** Rebuild a simulatable state from an agent's view (used by bots). */
export function stateFromView(v: CMView): CMState {
  return {
    cols: v.cols,
    rows: v.rows,
    seats: [...v.seats],
    cells: v.board.map((b) => ({ owner: b.owner, orbs: b.orbs })),
    turn: v.turn,
    moved: [...v.moved],
    eliminated: [...v.eliminated],
    moveCount: v.moveCount,
    lastMove: v.lastMove,
    winner: v.winner,
    endReason: v.endReason,
  };
}

export const criticalMassGame: GameModule<CMState> = {
  meta: {
    id: 'critical-mass',
    name: 'Critical Mass',
    tagline: 'Stack orbs. Start chain reactions. Own the board.',
    mode: 'turn',
    minPlayers: 2,
    maxPlayers: 4,
    seats: SEATS,
    rulesMarkdown: RULES,
  },
  setup({ seats }) {
    if (seats.length < 2 || seats.length > 4) throw new GameRuleError('BAD_SEATS', 'Critical Mass takes 2–4 players.');
    const [cols, rows] = seats.length === 2 ? [6, 9] : [8, 10];
    return {
      cols,
      rows,
      seats: [...seats],
      cells: Array.from({ length: cols * rows }, () => ({ owner: null, orbs: 0 })),
      turn: seats[0],
      moved: [],
      eliminated: [],
      moveCount: 0,
      lastMove: null,
      winner: null,
      endReason: null,
    };
  },
  view,
  outcome,
  forfeit,
  turn: {
    turnSeconds: 90,
    toMove: (s) => (s.turn ? [s.turn] : []),
    legal(s, seat) {
      if (s.winner || s.turn !== seat) return [];
      const out: CMCommand[] = [];
      s.cells.forEach((c, i) => {
        if (c.owner === null || c.owner === seat) out.push({ cell: cellName(s.cols, i) });
      });
      return out;
    },
    apply,
    describe: (command) => String((command as CMCommand).cell),
  },
};

export default criticalMassGame;
```

- [ ] **Step 5: Run the tests**

Run: `bun test games/critical-mass`
Expected: PASS (all tests, including 60 random playouts).

- [ ] **Step 6: Typecheck and commit**

Run: `bunx tsc -p tsconfig.json`. Expected: no errors.
```bash
git add games/critical-mass bun.lock
git commit -m "Critical Mass: pure turn-based launch game with cascades in waves

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Server database (Drizzle schema, PGlite/Postgres, migrations)

**Files:**
- Create: `apps/server/package.json`, `apps/server/drizzle.config.ts`
- Create: `apps/server/src/db/schema.ts`, `apps/server/src/db/index.ts`, `apps/server/src/lib/errors.ts`
- Generate: `apps/server/drizzle/0000_init.sql` (+ `meta/`)
- Test: `apps/server/src/db/db.test.ts`

**Interfaces:**
- Produces:
  - Tables `identities`, `messages`, `matches`, `matchPlayers` (Drizzle table objects, exported from `schema.ts`).
  - `type DB` (a Postgres-dialect Drizzle database), `interface Database { db: DB; close(): Promise<void> }`, and `openDatabase(url?: string): Promise<Database>`.
    - URL rules: `undefined` → PGlite at `.data/pglite` relative to cwd. `"pglite:memory"` → in-memory. `"pglite:/abs/dir"` → PGlite at that dir. `postgres://…`/`postgresql://…` → postgres-js.
    - Migrations run on open.
  - `class AppError extends Error { status; code }`, helpers `badRequest(code, msg)`, `notFound(code, msg)`, `conflict(code, msg)`, `forbidden(code, msg)`, and `isUniqueViolation(e): boolean`.

- [ ] **Step 1: Create the package and config**

`apps/server/package.json`:
```json
{
  "name": "@cs/server",
  "private": true,
  "type": "module",
  "scripts": { "db:generate": "drizzle-kit generate" },
  "dependencies": {
    "@cs/critical-mass": "workspace:*",
    "@cs/game-api": "workspace:*",
    "@cs/shared": "workspace:*",
    "@electric-sql/pglite": "0.5.8",
    "drizzle-orm": "0.45.3",
    "hono": "4.13.9",
    "postgres": "3.4.9"
  },
  "devDependencies": { "drizzle-kit": "0.31.11" }
}
```

`apps/server/drizzle.config.ts`:
```ts
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
});
```

`apps/server/src/lib/errors.ts`:
```ts
export type ErrorStatus = 400 | 401 | 403 | 404 | 409 | 429 | 500;

/** An error with an HTTP status and a stable UPPER_SNAKE code; the HTTP door renders it as {error:{code,message}}. */
export class AppError extends Error {
  constructor(
    public readonly status: ErrorStatus,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const badRequest = (code: string, message: string) => new AppError(400, code, message);
export const unauthorized = (code: string, message: string) => new AppError(401, code, message);
export const forbidden = (code: string, message: string) => new AppError(403, code, message);
export const notFound = (code: string, message: string) => new AppError(404, code, message);
export const conflict = (code: string, message: string) => new AppError(409, code, message);
export const tooMany = (code: string, message: string) => new AppError(429, code, message);

/** Postgres unique_violation (23505), looking through Drizzle's error wrapping. */
export function isUniqueViolation(e: unknown): boolean {
  let cur: unknown = e;
  for (let depth = 0; cur && depth < 5; depth++) {
    if ((cur as { code?: unknown }).code === '23505') return true;
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}
```

- [ ] **Step 2: Write the schema**

`apps/server/src/db/schema.ts`:
```ts
import {
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

const ts = (name: string) => timestamp(name, { withTimezone: true });

export const identities = pgTable(
  'identities',
  {
    id: text('id').primaryKey(),
    handle: text('handle').notNull(),
    handleLower: text('handle_lower').notNull(),
    kind: text('kind', { enum: ['human', 'agent'] }).notNull(),
    secretHash: text('secret_hash').notNull(),
    passwordHash: text('password_hash'),
    email: text('email'),
    tagline: text('tagline'),
    color: text('color').notNull(),
    model: text('model'),
    isHouse: boolean('is_house').notNull().default(false),
    role: text('role', { enum: ['user', 'mod', 'admin'] }).notNull().default('user'),
    ownerId: text('owner_id'),
    createdAt: ts('created_at').notNull().defaultNow(),
    lastSeenAt: ts('last_seen_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('identities_handle_lower').on(t.handleLower), uniqueIndex('identities_secret_hash').on(t.secretHash)],
);

export const messages = pgTable(
  'messages',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    channel: text('channel').notNull(),
    authorId: text('author_id'),
    text: text('text').notNull(),
    system: boolean('system').notNull().default(false),
    createdAt: ts('created_at').notNull().defaultNow(),
    deletedAt: ts('deleted_at'),
  },
  (t) => [index('messages_channel_id').on(t.channel, t.id)],
);

export const matches = pgTable(
  'matches',
  {
    id: text('id').primaryKey(),
    gameId: text('game_id').notNull(),
    status: text('status', { enum: ['countdown', 'live', 'over', 'abandoned'] }).notNull(),
    seed: integer('seed').notNull(),
    season: text('season').notNull(),
    rated: boolean('rated').notNull().default(false),
    outcome: jsonb('outcome'),
    endReason: text('end_reason'),
    createdAt: ts('created_at').notNull().defaultNow(),
    endedAt: ts('ended_at'),
  },
  (t) => [index('matches_season_status').on(t.season, t.status)],
);

export const matchPlayers = pgTable(
  'match_players',
  {
    matchId: text('match_id')
      .notNull()
      .references(() => matches.id),
    seat: text('seat').notNull(),
    identityId: text('identity_id')
      .notNull()
      .references(() => identities.id),
    kind: text('kind', { enum: ['human', 'agent'] }).notNull(),
    result: text('result', { enum: ['win', 'loss', 'draw', 'abandoned'] }),
  },
  (t) => [primaryKey({ columns: [t.matchId, t.seat] }), index('match_players_identity').on(t.identityId)],
);
```

- [ ] **Step 3: Write the database opener**

`apps/server/src/db/index.ts`:
```ts
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { migrate as migratePglite } from 'drizzle-orm/pglite/migrator';
import { drizzle as drizzlePostgres } from 'drizzle-orm/postgres-js';
import { migrate as migratePostgres } from 'drizzle-orm/postgres-js/migrator';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import postgres from 'postgres';
import * as schema from './schema';

export type DB = PgDatabase<PgQueryResultHKT, typeof schema>;

export interface Database {
  db: DB;
  close(): Promise<void>;
}

const MIGRATIONS = fileURLToPath(new URL('../../drizzle', import.meta.url));

export async function openDatabase(url?: string): Promise<Database> {
  if (url && /^postgres(ql)?:\/\//.test(url)) {
    const sql = postgres(url, { max: 10, onnotice: () => {} });
    const db = drizzlePostgres(sql, { schema });
    await migratePostgres(db, { migrationsFolder: MIGRATIONS });
    return { db: db as unknown as DB, close: () => sql.end() };
  }
  let client: PGlite;
  if (url === 'pglite:memory') {
    client = new PGlite();
  } else {
    const dir = url?.startsWith('pglite:') ? url.slice('pglite:'.length) : '.data/pglite';
    mkdirSync(dir, { recursive: true });
    client = new PGlite(dir);
  }
  const db = drizzlePglite(client, { schema });
  await migratePglite(db, { migrationsFolder: MIGRATIONS });
  return { db: db as unknown as DB, close: () => client.close() };
}
```

- [ ] **Step 4: Generate the initial migration**

Run: `bun install && cd apps/server && bunx drizzle-kit generate --name init && cd ../..`
Expected: `apps/server/drizzle/0000_init.sql` exists and contains `CREATE TABLE "identities"`, `"messages"`, `"matches"`, `"match_players"`.

- [ ] **Step 5: Write the test**

`apps/server/src/db/db.test.ts`:
```ts
import { afterAll, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { isUniqueViolation } from '../lib/errors';
import { openDatabase } from './index';
import { identities } from './schema';

const database = await openDatabase('pglite:memory');
afterAll(() => database.close());

const row = (id: string, handle: string) => ({
  id,
  handle,
  handleLower: handle.toLowerCase(),
  kind: 'human' as const,
  secretHash: `hash-${id}`,
  color: '#ffb347',
});

describe('openDatabase (pglite:memory)', () => {
  test('migrates and round-trips a row', async () => {
    await database.db.insert(identities).values(row('id_1', 'Frosty'));
    const [found] = await database.db.select().from(identities).where(eq(identities.id, 'id_1'));
    expect(found.handle).toBe('Frosty');
    expect(found.role).toBe('user');
    expect(found.createdAt).toBeInstanceOf(Date);
  });
  test('case-insensitive handle uniqueness is enforced by the index', async () => {
    let err: unknown = null;
    try {
      await database.db.insert(identities).values(row('id_2', 'frosty'));
    } catch (e) {
      err = e;
    }
    expect(err).not.toBeNull();
    expect(isUniqueViolation(err)).toBe(true);
    expect(isUniqueViolation(new Error('nope'))).toBe(false);
  });
});
```

- [ ] **Step 6: Run the test**

Run: `bun test apps/server/src/db`
Expected: PASS (2 tests).

- [ ] **Step 7: Typecheck and commit**

Run: `bunx tsc -p tsconfig.json`. Expected: no errors.
```bash
git add apps/server bun.lock
git commit -m "Server database: Drizzle schema, PGlite/Postgres opener, init migration

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Server utilities, EventBus and IdentityManager

**Files:**
- Create: `apps/server/src/lib/{clock,ids,ratelimit,testing}.ts`
- Create: `apps/server/src/core/bus.ts`, `apps/server/src/core/identity.ts`
- Test: `apps/server/src/lib/lib.test.ts`, `apps/server/src/core/identity.test.ts`

**Interfaces:**
- Consumes: `DB`, `openDatabase`, `identities`, `AppError`, `isUniqueViolation` (Task 4); `checkHandle`, `censorText`, `IdentityPublic`, `BusEvents` payload types (Task 1).
- Produces:
  - `interface Clock { now(): number; setTimeout(fn: () => void, ms: number): unknown; clearTimeout(handle: unknown): void }`, `systemClock`, and `class FakeClock implements Clock { advance(ms: number): void }`.
  - `newId(prefix: string): string`, `newSecret(prefix: string): string`, `hashSecret(secret: string): string`.
  - `class RateLimiter { constructor(clock, capacity: number, refillPerMs: number); take(key: string): boolean }`.
  - `waitFor(check, timeoutMs?)` (test helper).
  - `interface BusEvents`, and `class EventBus { on(event, fn): () => void; emit(event, payload): void }`.
  - `class IdentityManager`:
    - `createHuman(handle: unknown): Promise<{ identity: IdentityPublic; key: string }>`
    - `registerAgent(input: AgentInput, houseKey: string | null): Promise<{ identity: IdentityPublic; token: string }>`
    - `authenticate(secret?: string | null): Promise<IdentityPublic | null>`
    - `get(id): Promise<IdentityPublic | null>`, `getByHandle(handle): Promise<IdentityPublic | null>`
  - `toPublic(row): IdentityPublic`.

- [ ] **Step 1: Write the utilities**

`apps/server/src/lib/clock.ts`:
```ts
export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** Deterministic clock for tests: timers only fire inside advance(). */
export class FakeClock implements Clock {
  private t: number;
  private seq = 0;
  private timers = new Map<number, { at: number; fn: () => void }>();

  constructor(start = Date.UTC(2026, 8, 26, 12, 0, 0)) {
    this.t = start;
  }
  now(): number {
    return this.t;
  }
  setTimeout(fn: () => void, ms: number): unknown {
    const id = ++this.seq;
    this.timers.set(id, { at: this.t + Math.max(0, ms), fn });
    return id;
  }
  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }
  /** Move time forward, firing due timers in order (timers scheduled while advancing also fire if due). */
  advance(ms: number): void {
    const end = this.t + ms;
    for (;;) {
      let nextId = -1;
      let next: { at: number; fn: () => void } | undefined;
      for (const [id, timer] of this.timers) {
        if (timer.at > end) continue;
        if (!next || timer.at < next.at || (timer.at === next.at && id < nextId)) {
          next = timer;
          nextId = id;
        }
      }
      if (!next) break;
      this.timers.delete(nextId);
      this.t = next.at;
      next.fn();
    }
    this.t = end;
  }
  pending(): number {
    return this.timers.size;
  }
}
```

`apps/server/src/lib/ids.ts`:
```ts
export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`;
}

export function newSecret(prefix: string): string {
  return prefix + Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
}

export function hashSecret(secret: string): string {
  return new Bun.CryptoHasher('sha256').update(secret).digest('hex');
}
```

`apps/server/src/lib/ratelimit.ts`:
```ts
import type { Clock } from './clock';

/** Token bucket per key: `capacity` burst, refilling `refillPerMs` tokens per millisecond. */
export class RateLimiter {
  private buckets = new Map<string, { tokens: number; at: number }>();

  constructor(
    private clock: Clock,
    private capacity: number,
    private refillPerMs: number,
  ) {}

  take(key: string): boolean {
    const now = this.clock.now();
    const bucket = this.buckets.get(key) ?? { tokens: this.capacity, at: now };
    bucket.tokens = Math.min(this.capacity, bucket.tokens + (now - bucket.at) * this.refillPerMs);
    bucket.at = now;
    this.buckets.set(key, bucket);
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  }
}
```

`apps/server/src/lib/testing.ts`:
```ts
/** Poll until `check` is truthy (real time). For async side effects such as DB writes after a timer fires. */
export async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 3000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await check()) return;
    await Bun.sleep(5);
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}
```

`apps/server/src/core/bus.ts`:
```ts
import type { ChatMessage, InboxEvent, PresenceInfo } from '@cs/shared/protocol';

export interface BusEvents {
  'presence.changed': PresenceInfo;
  'chat.message': ChatMessage;
  inbox: { identityId: string; event: InboxEvent };
  'match.updated': { matchId: string; revision: number };
}

type Handler<K extends keyof BusEvents> = (payload: BusEvents[K]) => void;

export class EventBus {
  private handlers = new Map<keyof BusEvents, Set<Handler<never>>>();

  on<K extends keyof BusEvents>(event: K, fn: Handler<K>): () => void {
    const set = this.handlers.get(event) ?? new Set();
    set.add(fn as Handler<never>);
    this.handlers.set(event, set);
    return () => set.delete(fn as Handler<never>);
  }

  emit<K extends keyof BusEvents>(event: K, payload: BusEvents[K]): void {
    for (const fn of [...(this.handlers.get(event) ?? [])]) {
      try {
        (fn as Handler<K>)(payload);
      } catch (e) {
        console.error(`[bus] handler for ${event} failed`, e);
      }
    }
  }
}
```

- [ ] **Step 2: Write the utility tests**

`apps/server/src/lib/lib.test.ts`:
```ts
import { describe, expect, test } from 'bun:test';
import { EventBus } from '../core/bus';
import { FakeClock } from './clock';
import { hashSecret, newId, newSecret } from './ids';
import { RateLimiter } from './ratelimit';

describe('FakeClock', () => {
  test('fires timers in order, only when advanced', () => {
    const clock = new FakeClock(0);
    const fired: string[] = [];
    clock.setTimeout(() => fired.push('b'), 200);
    clock.setTimeout(() => fired.push('a'), 100);
    const c = clock.setTimeout(() => fired.push('c'), 150);
    clock.clearTimeout(c);
    clock.advance(99);
    expect(fired).toEqual([]);
    clock.advance(200);
    expect(fired).toEqual(['a', 'b']);
    expect(clock.now()).toBe(299);
  });
  test('timers scheduled during advance fire if due', () => {
    const clock = new FakeClock(0);
    const fired: number[] = [];
    clock.setTimeout(() => clock.setTimeout(() => fired.push(clock.now()), 50), 50);
    clock.advance(100);
    expect(fired).toEqual([100]);
  });
});

describe('ids', () => {
  test('ids and secrets are prefixed and unique; hashes are stable', () => {
    expect(newId('m')).toMatch(/^m_[0-9a-f]{16}$/);
    expect(newSecret('cs_')).toMatch(/^cs_[A-Za-z0-9_-]{43}$/);
    expect(newSecret('cs_')).not.toBe(newSecret('cs_'));
    expect(hashSecret('x')).toBe(hashSecret('x'));
    expect(hashSecret('x')).toHaveLength(64);
  });
});

describe('RateLimiter', () => {
  test('allows a burst then refills over time', () => {
    const clock = new FakeClock(0);
    const rl = new RateLimiter(clock, 5, 1 / 2000);
    for (let i = 0; i < 5; i++) expect(rl.take('a')).toBe(true);
    expect(rl.take('a')).toBe(false);
    expect(rl.take('b')).toBe(true);
    clock.advance(2000);
    expect(rl.take('a')).toBe(true);
    expect(rl.take('a')).toBe(false);
  });
});

describe('EventBus', () => {
  test('delivers to subscribers, isolates failures, unsubscribes', () => {
    const bus = new EventBus();
    const got: number[] = [];
    bus.on('match.updated', () => {
      throw new Error('boom');
    });
    const off = bus.on('match.updated', (p) => got.push(p.revision));
    bus.emit('match.updated', { matchId: 'm', revision: 1 });
    off();
    bus.emit('match.updated', { matchId: 'm', revision: 2 });
    expect(got).toEqual([1]);
  });
});
```

- [ ] **Step 3: Run the utility tests**

Run: `bun test apps/server/src/lib`
Expected: PASS (6 tests).

- [ ] **Step 4: Write the failing IdentityManager test**

`apps/server/src/core/identity.test.ts`:
```ts
import { afterAll, describe, expect, test } from 'bun:test';
import { openDatabase } from '../db';
import { AppError } from '../lib/errors';
import { IdentityManager } from './identity';

const database = await openDatabase('pglite:memory');
afterAll(() => database.close());
const ids = new IdentityManager(database.db, { houseKey: 'house-secret', adminHandles: ['frosty'] });

async function errorOf(p: Promise<unknown>): Promise<AppError> {
  try {
    await p;
  } catch (e) {
    return e as AppError;
  }
  throw new Error('expected a rejection');
}

describe('humans', () => {
  test('createHuman returns a csk_ key that authenticates', async () => {
    const { identity, key } = await ids.createHuman('Ada');
    expect(key.startsWith('csk_')).toBe(true);
    expect(identity).toMatchObject({ handle: 'Ada', kind: 'human', isHouse: false, locked: false, role: 'user' });
    expect(identity.color).toMatch(/^#[0-9a-f]{6}$/i);
    expect(await ids.authenticate(key)).toEqual(identity);
  });
  test('handles are unique regardless of case', async () => {
    await ids.createHuman('Fable');
    const err = await errorOf(ids.createHuman('fable'));
    expect([err.status, err.code]).toEqual([409, 'HANDLE_TAKEN']);
  });
  test('invalid and reserved handles are rejected', async () => {
    expect((await errorOf(ids.createHuman('Fаble'))).code).toBe('HANDLE_INVALID');
    expect((await errorOf(ids.createHuman('x'))).code).toBe('HANDLE_INVALID');
    expect((await errorOf(ids.createHuman('admin'))).code).toBe('HANDLE_RESERVED');
  });
  test('admin handles get the admin role', async () => {
    const { identity } = await ids.createHuman('Frosty');
    expect(identity.role).toBe('admin');
  });
});

describe('agents', () => {
  test('registerAgent returns a cs_ token and keeps the profile', async () => {
    const { identity, token } = await ids.registerAgent(
      { name: 'ByteEater', tagline: 'I eat bytes', color: '#12abef', model: 'Fable 5.1' },
      null,
    );
    expect(token.startsWith('cs_')).toBe(true);
    expect(identity).toMatchObject({ handle: 'ByteEater', kind: 'agent', tagline: 'I eat bytes', color: '#12abef', model: 'Fable 5.1', isHouse: false });
    expect((await ids.authenticate(token))?.id).toBe(identity.id);
  });
  test('agents and humans share one namespace', async () => {
    expect((await errorOf(ids.registerAgent({ name: 'ada' }, null))).code).toBe('HANDLE_TAKEN');
  });
  test('the house key marks house bots; a wrong one is refused', async () => {
    const { identity } = await ids.registerAgent({ name: 'Sprocket' }, 'house-secret');
    expect(identity.isHouse).toBe(true);
    const err = await errorOf(ids.registerAgent({ name: 'Imposter' }, 'wrong'));
    expect([err.status, err.code]).toEqual([403, 'BAD_HOUSE_KEY']);
  });
  test('bad colors and oversized fields are rejected; missing color gets a palette color', async () => {
    expect((await errorOf(ids.registerAgent({ name: 'Painter', color: 'red' }, null))).code).toBe('BAD_FIELD');
    expect((await errorOf(ids.registerAgent({ name: 'Talker', tagline: 'x'.repeat(81) }, null))).code).toBe('BAD_FIELD');
    const { identity } = await ids.registerAgent({ name: 'Plain' }, null);
    expect(identity.color).toMatch(/^#[0-9a-f]{6}$/i);
    expect(identity.tagline).toBeNull();
  });
});

describe('lookup', () => {
  test('authenticate rejects garbage; get and getByHandle find identities', async () => {
    expect(await ids.authenticate(null)).toBeNull();
    expect(await ids.authenticate('cs_nope')).toBeNull();
    const { identity } = await ids.createHuman('Lookup');
    expect((await ids.get(identity.id))?.handle).toBe('Lookup');
    expect((await ids.getByHandle('LOOKUP'))?.id).toBe(identity.id);
    expect(await ids.getByHandle('nobody-here')).toBeNull();
  });
});
```

- [ ] **Step 5: Run it to see it fail**

Run: `bun test apps/server/src/core/identity.test.ts`
Expected: FAIL. The module `./identity` isn't found.

- [ ] **Step 6: Implement IdentityManager**

`apps/server/src/core/identity.ts`:
```ts
import { eq } from 'drizzle-orm';
import { censorText } from '@cs/shared/filter';
import { checkHandle } from '@cs/shared/handles';
import type { IdentityPublic, Kind } from '@cs/shared/protocol';
import type { DB } from '../db';
import { identities } from '../db/schema';
import { AppError, badRequest, conflict, forbidden, isUniqueViolation } from '../lib/errors';
import { hashSecret, newId, newSecret } from '../lib/ids';

type Row = typeof identities.$inferSelect;

const WARM = ['#ffb347', '#ff6b5b', '#ffd166', '#ff8fa3', '#ffa07a'];
const COOL = ['#3de0ff', '#9b6bff', '#5dffa5', '#6bd0ff', '#c38bff', '#b8ff5d'];
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

export interface AgentInput {
  name?: unknown;
  tagline?: unknown;
  color?: unknown;
  model?: unknown;
}

export function toPublic(row: Row): IdentityPublic {
  return {
    id: row.id,
    handle: row.handle,
    kind: row.kind,
    tagline: row.tagline,
    color: row.color,
    model: row.model,
    isHouse: row.isHouse,
    locked: row.passwordHash !== null,
    role: row.role,
    ownerHandle: null,
  };
}

function paletteColor(palette: string[], seed: string): string {
  let h = 0;
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return palette[h % palette.length];
}

function optionalText(value: unknown, max: number, field: string): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw badRequest('BAD_FIELD', `${field} must be a string.`);
  const text = value.trim();
  if (text.length > max) throw badRequest('BAD_FIELD', `${field} is at most ${max} characters.`);
  return text ? censorText(text) : null;
}

const taken = (handle: string) => conflict('HANDLE_TAKEN', `@${handle} is taken. Try another.`);

export class IdentityManager {
  private cacheBySecret = new Map<string, IdentityPublic>();

  constructor(
    private db: DB,
    private opts: { houseKey: string | null; adminHandles: string[] },
  ) {}

  async createHuman(rawHandle: unknown): Promise<{ identity: IdentityPublic; key: string }> {
    const key = newSecret('csk_');
    const identity = await this.insert({ rawHandle, kind: 'human', secret: key, color: null, tagline: null, model: null, isHouse: false });
    return { identity, key };
  }

  async registerAgent(input: AgentInput, houseKey: string | null): Promise<{ identity: IdentityPublic; token: string }> {
    let isHouse = false;
    if (houseKey !== null && houseKey !== undefined) {
      if (!this.opts.houseKey || houseKey !== this.opts.houseKey) throw forbidden('BAD_HOUSE_KEY', 'That house key is not valid.');
      isHouse = true;
    }
    let color: string | null = null;
    if (input.color !== undefined && input.color !== null) {
      if (typeof input.color !== 'string' || !COLOR_RE.test(input.color)) {
        throw badRequest('BAD_FIELD', 'color must look like "#3de0ff".');
      }
      color = input.color.toLowerCase();
    }
    const tagline = optionalText(input.tagline, 80, 'tagline');
    const model = optionalText(input.model, 40, 'model');
    const token = newSecret('cs_');
    const identity = await this.insert({ rawHandle: input.name, kind: 'agent', secret: token, color, tagline, model, isHouse });
    return { identity, token };
  }

  private async insert(p: {
    rawHandle: unknown;
    kind: Kind;
    secret: string;
    color: string | null;
    tagline: string | null;
    model: string | null;
    isHouse: boolean;
  }): Promise<IdentityPublic> {
    const check = checkHandle(p.rawHandle);
    if (!check.ok) throw new AppError(400, check.code, check.message);
    const handle = check.handle;
    const handleLower = handle.toLowerCase();
    const existing = await this.db
      .select({ id: identities.id })
      .from(identities)
      .where(eq(identities.handleLower, handleLower))
      .limit(1);
    if (existing.length > 0) throw taken(handle);
    try {
      const [row] = await this.db
        .insert(identities)
        .values({
          id: newId('id'),
          handle,
          handleLower,
          kind: p.kind,
          secretHash: hashSecret(p.secret),
          color: p.color ?? paletteColor(p.kind === 'human' ? WARM : COOL, handleLower),
          tagline: p.tagline,
          model: p.model,
          isHouse: p.isHouse,
          role: this.opts.adminHandles.includes(handleLower) ? 'admin' : 'user',
        })
        .returning();
      const identity = toPublic(row);
      this.cacheBySecret.set(row.secretHash, identity);
      return identity;
    } catch (e) {
      if (isUniqueViolation(e)) throw taken(handle);
      throw e;
    }
  }

  async authenticate(secret?: string | null): Promise<IdentityPublic | null> {
    if (!secret || secret.length > 200) return null;
    const hash = hashSecret(secret);
    const cached = this.cacheBySecret.get(hash);
    if (cached) return cached;
    const [row] = await this.db.select().from(identities).where(eq(identities.secretHash, hash)).limit(1);
    if (!row) return null;
    const identity = toPublic(row);
    this.cacheBySecret.set(hash, identity);
    return identity;
  }

  async get(id: string): Promise<IdentityPublic | null> {
    const [row] = await this.db.select().from(identities).where(eq(identities.id, id)).limit(1);
    return row ? toPublic(row) : null;
  }

  async getByHandle(handle: string): Promise<IdentityPublic | null> {
    const [row] = await this.db
      .select()
      .from(identities)
      .where(eq(identities.handleLower, handle.trim().toLowerCase()))
      .limit(1);
    return row ? toPublic(row) : null;
  }
}
```

- [ ] **Step 7: Run the tests**

Run: `bun test apps/server/src/core/identity.test.ts apps/server/src/lib`
Expected: PASS.

- [ ] **Step 8: Typecheck and commit**

Run: `bunx tsc -p tsconfig.json`. Expected: no errors.
```bash
git add apps/server/src/lib apps/server/src/core
git commit -m "Server: clock, ids, rate limiter, event bus, IdentityManager

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: PresenceManager

**Files:**
- Create: `apps/server/src/core/presence.ts`
- Test: `apps/server/src/core/presence.test.ts`

**Interfaces:**
- Consumes: `EventBus` (emits `presence.changed`), `Clock`, `FakeClock`, `IdentityPublic`, `PresenceInfo`, `Status`.
- Produces: `class PresenceManager` with
  - `humanConnected(identity)`, `humanDisconnected(id)`, `humanActivity(id)`
  - `agentSeen(identity)`
  - `setManualStatus(identity, status: 'ready' | 'afk')`
  - `setPlaying(id, playing: boolean)`
  - `get(id): PresenceInfo | null`, `list(): PresenceInfo[]` (sorted by handle, case-insensitive), `isReady(id): boolean`

  Default options are `{ agentTimeoutMs: 90_000, humanGraceMs: 15_000, humanIdleMs: 600_000 }`. When someone goes offline, one `presence.changed` event fires with `status: 'offline'` and the entry is dropped from `list()`.

- [ ] **Step 1: Write the failing test**

`apps/server/src/core/presence.test.ts`:
```ts
import { describe, expect, test } from 'bun:test';
import type { IdentityPublic, PresenceInfo } from '@cs/shared/protocol';
import { FakeClock } from '../lib/clock';
import { EventBus } from './bus';
import { PresenceManager } from './presence';

const ident = (id: string, handle: string, kind: 'human' | 'agent'): IdentityPublic => ({
  id, handle, kind, tagline: null, color: '#ffffff', model: null, isHouse: false, locked: false, role: 'user', ownerHandle: null,
});
const ada = ident('h1', 'Ada', 'human');
const bot = ident('a1', 'ByteEater', 'agent');

function setup() {
  const clock = new FakeClock(0);
  const bus = new EventBus();
  const events: PresenceInfo[] = [];
  bus.on('presence.changed', (p) => events.push(p));
  return { clock, events, presence: new PresenceManager(bus, clock) };
}

describe('humans', () => {
  test('connect makes them ready; disconnect goes offline only after the grace period', () => {
    const { clock, events, presence } = setup();
    presence.humanConnected(ada);
    expect(presence.get('h1')?.status).toBe('ready');
    presence.humanDisconnected('h1');
    clock.advance(14_999);
    expect(presence.get('h1')?.status).toBe('ready');
    clock.advance(1);
    expect(presence.get('h1')).toBeNull();
    expect(events.at(-1)?.status).toBe('offline');
  });
  test('reconnecting within the grace period cancels going offline', () => {
    const { clock, presence } = setup();
    presence.humanConnected(ada);
    presence.humanDisconnected('h1');
    clock.advance(10_000);
    presence.humanConnected(ada);
    clock.advance(60_000);
    expect(presence.get('h1')?.status).toBe('ready');
  });
  test('two tabs: offline only when both close', () => {
    const { clock, presence } = setup();
    presence.humanConnected(ada);
    presence.humanConnected(ada);
    presence.humanDisconnected('h1');
    clock.advance(20_000);
    expect(presence.get('h1')?.status).toBe('ready');
  });
  test('10 idle minutes make them afk; activity brings them back', () => {
    const { clock, presence } = setup();
    presence.humanConnected(ada);
    clock.advance(600_000);
    expect(presence.get('h1')?.status).toBe('afk');
    presence.humanActivity('h1');
    expect(presence.get('h1')?.status).toBe('ready');
  });
  test('a manual afk is not undone by activity', () => {
    const { presence } = setup();
    presence.humanConnected(ada);
    presence.setManualStatus(ada, 'afk');
    presence.humanActivity('h1');
    expect(presence.get('h1')?.status).toBe('afk');
    expect(presence.isReady('h1')).toBe(false);
  });
});

describe('agents', () => {
  test('any API call keeps them online for 90 seconds', () => {
    const { clock, presence } = setup();
    presence.agentSeen(bot);
    clock.advance(60_000);
    presence.agentSeen(bot);
    clock.advance(60_000);
    expect(presence.get('a1')?.status).toBe('ready');
    clock.advance(30_000);
    expect(presence.get('a1')).toBeNull();
  });
});

describe('playing', () => {
  test('playing is automatic and restores the previous status', () => {
    const { presence } = setup();
    presence.humanConnected(ada);
    presence.setManualStatus(ada, 'afk');
    presence.setPlaying('h1', true);
    expect(presence.get('h1')?.status).toBe('playing');
    presence.setManualStatus(ada, 'ready');
    expect(presence.get('h1')?.status).toBe('playing');
    presence.setPlaying('h1', false);
    expect(presence.get('h1')?.status).toBe('ready');
  });
  test('setPlaying on someone offline is harmless', () => {
    const { presence } = setup();
    presence.setPlaying('nobody', true);
    presence.setPlaying('nobody', false);
    expect(presence.list()).toEqual([]);
  });
  test('setManualStatus creates an entry if needed and list is sorted', () => {
    const { presence } = setup();
    presence.setManualStatus(bot, 'ready');
    presence.humanConnected(ada);
    expect(presence.list().map((p) => p.identity.handle)).toEqual(['Ada', 'ByteEater']);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `bun test apps/server/src/core/presence.test.ts`
Expected: FAIL. The module `./presence` isn't found.

- [ ] **Step 3: Implement**

`apps/server/src/core/presence.ts`:
```ts
import type { IdentityPublic, PresenceInfo, Status } from '@cs/shared/protocol';
import type { Clock } from '../lib/clock';
import type { EventBus } from './bus';

interface Entry {
  info: PresenceInfo;
  connections: number;
  previous: 'ready' | 'afk';
  autoAfk: boolean;
  offlineTimer: unknown;
  idleTimer: unknown;
}

export interface PresenceOptions {
  agentTimeoutMs: number;
  humanGraceMs: number;
  humanIdleMs: number;
}

export class PresenceManager {
  private entries = new Map<string, Entry>();

  constructor(
    private bus: EventBus,
    private clock: Clock,
    private opts: PresenceOptions = { agentTimeoutMs: 90_000, humanGraceMs: 15_000, humanIdleMs: 600_000 },
  ) {}

  private iso(): string {
    return new Date(this.clock.now()).toISOString();
  }

  private upsert(identity: IdentityPublic): Entry {
    let entry = this.entries.get(identity.id);
    if (!entry) {
      entry = {
        info: { identity, status: 'ready', since: this.iso() },
        connections: 0,
        previous: 'ready',
        autoAfk: false,
        offlineTimer: null,
        idleTimer: null,
      };
      this.entries.set(identity.id, entry);
      this.bus.emit('presence.changed', entry.info);
    } else {
      entry.info = { ...entry.info, identity };
    }
    return entry;
  }

  private set(entry: Entry, status: Status): void {
    if (entry.info.status === status) return;
    entry.info = { ...entry.info, status, since: this.iso() };
    this.bus.emit('presence.changed', entry.info);
  }

  private goOffline(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.clock.clearTimeout(entry.offlineTimer);
    this.clock.clearTimeout(entry.idleTimer);
    this.entries.delete(id);
    this.bus.emit('presence.changed', { ...entry.info, status: 'offline', since: this.iso() });
  }

  private armIdle(entry: Entry): void {
    this.clock.clearTimeout(entry.idleTimer);
    entry.idleTimer = this.clock.setTimeout(() => {
      if (entry.info.status === 'ready') {
        entry.autoAfk = true;
        this.set(entry, 'afk');
      }
    }, this.opts.humanIdleMs);
  }

  humanConnected(identity: IdentityPublic): void {
    const entry = this.upsert(identity);
    entry.connections += 1;
    this.clock.clearTimeout(entry.offlineTimer);
    entry.offlineTimer = null;
    this.armIdle(entry);
  }

  humanDisconnected(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    entry.connections = Math.max(0, entry.connections - 1);
    if (entry.connections === 0) {
      this.clock.clearTimeout(entry.offlineTimer);
      entry.offlineTimer = this.clock.setTimeout(() => this.goOffline(id), this.opts.humanGraceMs);
    }
  }

  humanActivity(id: string): void {
    const entry = this.entries.get(id);
    if (!entry || entry.info.identity.kind !== 'human') return;
    if (entry.autoAfk && entry.info.status === 'afk') {
      entry.autoAfk = false;
      this.set(entry, 'ready');
    }
    this.armIdle(entry);
  }

  agentSeen(identity: IdentityPublic): void {
    const entry = this.upsert(identity);
    this.clock.clearTimeout(entry.offlineTimer);
    entry.offlineTimer = this.clock.setTimeout(() => this.goOffline(identity.id), this.opts.agentTimeoutMs);
  }

  setManualStatus(identity: IdentityPublic, status: 'ready' | 'afk'): void {
    const entry = this.upsert(identity);
    entry.autoAfk = false;
    if (entry.info.status === 'playing') {
      entry.previous = status;
      return;
    }
    this.set(entry, status);
  }

  setPlaying(id: string, playing: boolean): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    if (playing) {
      if (entry.info.status !== 'playing') {
        entry.previous = entry.info.status === 'afk' ? 'afk' : 'ready';
        this.set(entry, 'playing');
      }
    } else if (entry.info.status === 'playing') {
      this.set(entry, entry.previous);
    }
  }

  get(id: string): PresenceInfo | null {
    return this.entries.get(id)?.info ?? null;
  }

  list(): PresenceInfo[] {
    return [...this.entries.values()]
      .map((e) => e.info)
      .sort((a, b) => a.identity.handle.toLowerCase().localeCompare(b.identity.handle.toLowerCase()));
  }

  isReady(id: string): boolean {
    return this.entries.get(id)?.info.status === 'ready';
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `bun test apps/server/src/core/presence.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/core/presence.ts apps/server/src/core/presence.test.ts
git commit -m "PresenceManager: ready/afk/playing/offline with grace and idle timers

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: CommunicationManager (channels, messages, inbox long-poll)

**Files:**
- Create: `apps/server/src/core/communication.ts`
- Test: `apps/server/src/core/communication.test.ts`

**Interfaces:**
- Consumes: `DB`, `messages`, `identities`, `toPublic`, `IdentityManager.getByHandle`, `EventBus`, `Clock`, `RateLimiter`, `AppError` helpers, `censorText`, `PUBLIC_CHANNELS`, `DIARY_CHANNEL`.
- Produces: `class CommunicationManager` with
  - `constructor(db, bus, clock, identities, opts: { publicChannels: readonly string[] })`
  - `setTableAccess(fn: (matchId: string) => { playerIds: string[] } | null)`, which GameManager wires in
  - `channelKind(channel): 'public' | 'diary' | 'table' | null`
  - `post(author, channel, text): Promise<ChatMessage>` and `postSystem(channel, text): Promise<ChatMessage>`
  - `history(channel, { since?, limit? }): Promise<ChatMessage[]>` (oldest first)
  - `deliver(identityId, event: InboxEventInput): InboxEvent`
  - `poll(identityId, since, waitMs): Promise<InboxPoll>`

- [ ] **Step 1: Write the failing test**

`apps/server/src/core/communication.test.ts`:
```ts
import { afterAll, describe, expect, test } from 'bun:test';
import { PUBLIC_CHANNELS, type ChatMessage } from '@cs/shared/protocol';
import { openDatabase } from '../db';
import { FakeClock } from '../lib/clock';
import type { AppError } from '../lib/errors';
import { EventBus } from './bus';
import { CommunicationManager } from './communication';
import { IdentityManager } from './identity';

const database = await openDatabase('pglite:memory');
afterAll(() => database.close());

async function setup() {
  const clock = new FakeClock();
  const bus = new EventBus();
  const ids = new IdentityManager(database.db, { houseKey: null, adminHandles: ['boss'] });
  const comms = new CommunicationManager(database.db, bus, clock, ids, { publicChannels: PUBLIC_CHANNELS });
  const tag = Math.random().toString(36).slice(2, 8);
  const ada = (await ids.createHuman(`ada${tag}`)).identity;
  const bob = (await ids.registerAgent({ name: `bob${tag}` }, null)).identity;
  return { clock, bus, ids, comms, ada, bob, tag };
}

async function errorOf(p: Promise<unknown>): Promise<AppError> {
  try {
    await p;
  } catch (e) {
    return e as AppError;
  }
  throw new Error('expected a rejection');
}

describe('chat', () => {
  test('post then read history, oldest first, with authors; the bus hears it', async () => {
    const { comms, bus, ada, bob } = await setup();
    const heard: ChatMessage[] = [];
    bus.on('chat.message', (m) => heard.push(m));
    await comms.post(ada, 'lobby', 'hello');
    const second = await comms.post(bob, 'lobby', '  hi ada  ');
    expect(second.text).toBe('hi ada');
    const history = await comms.history('lobby', { limit: 50 });
    const mine = history.filter((m) => m.author?.id === ada.id || m.author?.id === bob.id);
    expect(mine.map((m) => m.text)).toEqual(['hello', 'hi ada']);
    expect(mine[1].author?.kind).toBe('agent');
    expect(heard).toHaveLength(2);
    const after = await comms.history('lobby', { since: mine[0].id });
    expect(after.map((m) => m.text)).toContain('hi ada');
    expect(after.map((m) => m.text)).not.toContain('hello');
  });
  test('public channels are censored; unknown channels 404; empty and long messages 400', async () => {
    const { comms, ada } = await setup();
    const m = await comms.post(ada, 'lobby', 'well fuck');
    expect(m.text).not.toContain('fuck');
    expect((await errorOf(comms.post(ada, 'nowhere', 'x'))).status).toBe(404);
    expect((await errorOf(comms.post(ada, 'lobby', '   '))).code).toBe('EMPTY');
    expect((await errorOf(comms.post(ada, 'lobby', 'x'.repeat(501)))).code).toBe('TOO_LONG');
  });
  test('diary is read-only for everyone but admins', async () => {
    const { comms, ada } = await setup();
    expect((await errorOf(comms.post(ada, 'diary', 'hi'))).status).toBe(403);
    const sys = await comms.postSystem('diary', 'New entry');
    expect(sys).toMatchObject({ system: true, author: null, channel: 'diary' });
  });
  test('table channels: only players post; table chat is uncensored and goes to the other players', async () => {
    const { comms, ada, bob } = await setup();
    comms.setTableAccess((id) => (id === 'm_t1' ? { playerIds: [ada.id, bob.id] } : null));
    const m = await comms.post(ada, 'match:m_t1', 'you are fucking toast');
    expect(m.text).toContain('fucking');
    const poll = await comms.poll(bob.id, 0, 0);
    expect(poll.events.map((e) => e.type)).toEqual(['chat.table']);
    expect((await errorOf(comms.post(ada, 'match:m_other', 'hi'))).status).toBe(403);
  });
  test('flood control: burst of 5 then 429', async () => {
    const { comms, ada, clock } = await setup();
    for (let i = 0; i < 5; i++) await comms.post(ada, 'lobby', `m${i}`);
    const err = await errorOf(comms.post(ada, 'lobby', 'm5'));
    expect([err.status, err.code]).toEqual([429, 'SLOW_DOWN']);
    clock.advance(2000);
    await comms.post(ada, 'lobby', 'm6');
  });
  test('@mentions reach the mentioned inbox (case-insensitive), not the author', async () => {
    const { comms, ada, bob, tag } = await setup();
    await comms.post(ada, 'lobby', `hey @BOB${tag} and @ada${tag}`);
    const bobPoll = await comms.poll(bob.id, 0, 0);
    expect(bobPoll.events).toHaveLength(1);
    expect(bobPoll.events[0].type).toBe('chat.mention');
    expect((await comms.poll(ada.id, 0, 0)).events).toHaveLength(0);
  });
});

describe('inbox', () => {
  test('poll returns buffered events immediately with increasing cursors', async () => {
    const { comms, bob } = await setup();
    comms.deliver(bob.id, { type: 'system', text: 'one' });
    comms.deliver(bob.id, { type: 'system', text: 'two' });
    const all = await comms.poll(bob.id, 0, 25_000);
    expect(all.events.map((e) => e.cursor)).toEqual([1, 2]);
    expect(all.cursor).toBe(2);
    expect((await comms.poll(bob.id, 1, 0)).events.map((e) => e.cursor)).toEqual([2]);
  });
  test('poll waits for the next event', async () => {
    const { comms, bob } = await setup();
    const pending = comms.poll(bob.id, 0, 25_000);
    comms.deliver(bob.id, { type: 'system', text: 'wake up' });
    const got = await pending;
    expect(got.events).toHaveLength(1);
  });
  test('poll times out empty after waitMs', async () => {
    const { comms, clock, bob } = await setup();
    const pending = comms.poll(bob.id, 0, 25_000);
    clock.advance(25_000);
    const got = await pending;
    expect(got).toEqual({ cursor: 0, events: [], gap: false });
  });
  test('a cursor from before a restart (ahead of ours) still receives new events, flagged as a gap', async () => {
    const { comms, bob } = await setup();
    const pending = comms.poll(bob.id, 999, 25_000);
    comms.deliver(bob.id, { type: 'system', text: 'after restart' });
    const got = await pending;
    expect(got.events.map((e) => e.type)).toEqual(['system']);
    expect(got.gap).toBe(true);
  });
  test('the ring buffer keeps 500 events and reports gaps', async () => {
    const { comms, bob } = await setup();
    for (let i = 0; i < 510; i++) comms.deliver(bob.id, { type: 'system', text: `e${i}` });
    const got = await comms.poll(bob.id, 0, 0);
    expect(got.events).toHaveLength(500);
    expect(got.events[0].cursor).toBe(11);
    expect(got.gap).toBe(true);
    expect((await comms.poll(bob.id, 10, 0)).gap).toBe(false);
  });
  test('deliver publishes on the bus', async () => {
    const { comms, bus, bob } = await setup();
    const seen: string[] = [];
    bus.on('inbox', ({ identityId, event }) => seen.push(`${identityId}:${event.type}`));
    comms.deliver(bob.id, { type: 'system', text: 'x' });
    expect(seen).toEqual([`${bob.id}:system`]);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `bun test apps/server/src/core/communication.test.ts`
Expected: FAIL. The module `./communication` isn't found.

- [ ] **Step 3: Implement**

`apps/server/src/core/communication.ts`:
```ts
import { and, asc, desc, eq, gt, isNull } from 'drizzle-orm';
import { censorText } from '@cs/shared/filter';
import {
  DIARY_CHANNEL,
  type ChatMessage,
  type IdentityPublic,
  type InboxEvent,
  type InboxEventInput,
  type InboxPoll,
} from '@cs/shared/protocol';
import type { DB } from '../db';
import { identities, messages } from '../db/schema';
import type { Clock } from '../lib/clock';
import { badRequest, forbidden, notFound, tooMany } from '../lib/errors';
import { RateLimiter } from '../lib/ratelimit';
import type { EventBus } from './bus';
import { toPublic, type IdentityManager } from './identity';

const INBOX_SIZE = 500;
const MAX_TEXT = 500;
const TABLE_RE = /^match:([A-Za-z0-9_]+)$/;
const MENTION_RE = /@([A-Za-z0-9_-]{3,20})/g;

type TableAccess = (matchId: string) => { playerIds: string[] } | null;

export class CommunicationManager {
  private inboxes = new Map<string, { cursor: number; events: InboxEvent[] }>();
  private waiters = new Map<string, Set<() => void>>();
  private flood: RateLimiter;
  private tableAccess: TableAccess = () => null;

  constructor(
    private db: DB,
    private bus: EventBus,
    private clock: Clock,
    private identities: IdentityManager,
    private opts: { publicChannels: readonly string[] },
  ) {
    this.flood = new RateLimiter(clock, 5, 1 / 2000);
  }

  setTableAccess(fn: TableAccess): void {
    this.tableAccess = fn;
  }

  channelKind(channel: string): 'public' | 'diary' | 'table' | null {
    if (channel === DIARY_CHANNEL) return 'diary';
    if (this.opts.publicChannels.includes(channel)) return 'public';
    if (TABLE_RE.test(channel)) return 'table';
    return null;
  }

  async post(author: IdentityPublic, channel: string, rawText: unknown): Promise<ChatMessage> {
    const kind = this.channelKind(channel);
    if (!kind) throw notFound('NO_CHANNEL', `There is no channel "${channel}".`);
    if (kind === 'diary' && author.role !== 'admin') throw forbidden('READ_ONLY', "#diary is the Proprietor's channel.");
    if (kind === 'table') {
      const table = this.tableAccess(channel.slice('match:'.length));
      if (!table || !table.playerIds.includes(author.id)) {
        throw forbidden('NOT_AT_TABLE', 'Only the players can talk at this table.');
      }
    }
    const text = typeof rawText === 'string' ? rawText.trim() : '';
    if (!text) throw badRequest('EMPTY', 'Say something.');
    if (text.length > MAX_TEXT) throw badRequest('TOO_LONG', `Messages are at most ${MAX_TEXT} characters.`);
    if (!this.flood.take(author.id)) throw tooMany('SLOW_DOWN', 'Easy there — one message every two seconds.');
    return this.insert(channel, author, kind === 'public' ? censorText(text) : text, false);
  }

  postSystem(channel: string, text: string): Promise<ChatMessage> {
    return this.insert(channel, null, text, true);
  }

  private async insert(channel: string, author: IdentityPublic | null, text: string, system: boolean): Promise<ChatMessage> {
    const [row] = await this.db
      .insert(messages)
      .values({ channel, authorId: author?.id ?? null, text, system, createdAt: new Date(this.clock.now()) })
      .returning();
    const message: ChatMessage = { id: row.id, channel, author, text, createdAt: row.createdAt.toISOString(), system };
    this.bus.emit('chat.message', message);
    await this.fanOut(message);
    return message;
  }

  private async fanOut(message: ChatMessage): Promise<void> {
    const notified = new Set<string>();
    if (message.author) notified.add(message.author.id);
    const table = TABLE_RE.exec(message.channel);
    if (table) {
      for (const id of this.tableAccess(table[1])?.playerIds ?? []) {
        if (notified.has(id)) continue;
        this.deliver(id, { type: 'chat.table', message });
        notified.add(id);
      }
    }
    for (const m of message.text.matchAll(MENTION_RE)) {
      const target = await this.identities.getByHandle(m[1]);
      if (!target || notified.has(target.id)) continue;
      this.deliver(target.id, { type: 'chat.mention', message });
      notified.add(target.id);
    }
  }

  async history(channel: string, opts: { since?: number; limit?: number } = {}): Promise<ChatMessage[]> {
    if (!this.channelKind(channel)) throw notFound('NO_CHANNEL', `There is no channel "${channel}".`);
    const limit = Math.min(200, Math.max(1, opts.limit ?? 50));
    const where =
      opts.since !== undefined
        ? and(eq(messages.channel, channel), isNull(messages.deletedAt), gt(messages.id, opts.since))
        : and(eq(messages.channel, channel), isNull(messages.deletedAt));
    const rows = await this.db
      .select({ m: messages, i: identities })
      .from(messages)
      .leftJoin(identities, eq(messages.authorId, identities.id))
      .where(where)
      .orderBy(opts.since !== undefined ? asc(messages.id) : desc(messages.id))
      .limit(limit);
    const ordered = opts.since !== undefined ? rows : rows.reverse();
    return ordered.map(({ m, i }) => ({
      id: m.id,
      channel: m.channel,
      author: i ? toPublic(i) : null,
      text: m.text,
      createdAt: m.createdAt.toISOString(),
      system: m.system,
    }));
  }

  deliver(identityId: string, input: InboxEventInput): InboxEvent {
    const box = this.inboxes.get(identityId) ?? { cursor: 0, events: [] };
    box.cursor += 1;
    const event = { ...input, cursor: box.cursor, at: new Date(this.clock.now()).toISOString() } as InboxEvent;
    box.events.push(event);
    if (box.events.length > INBOX_SIZE) box.events.shift();
    this.inboxes.set(identityId, box);
    const waiting = this.waiters.get(identityId);
    if (waiting) {
      this.waiters.delete(identityId);
      for (const wake of waiting) wake();
    }
    this.bus.emit('inbox', { identityId, event });
    return event;
  }

  async poll(identityId: string, since: number, waitMs: number): Promise<InboxPoll> {
    const current = this.inboxes.get(identityId)?.cursor ?? 0;
    // A cursor ahead of ours (e.g. from before a server restart) is treated as "now", and flagged.
    const base = Math.min(since, current);
    const ahead = since > current;
    const read = (): InboxPoll => {
      const box = this.inboxes.get(identityId);
      if (!box) return { cursor: 0, events: [], gap: ahead };
      const events = box.events.filter((e) => e.cursor > base);
      const oldest = box.events[0]?.cursor ?? box.cursor + 1;
      return { cursor: box.cursor, events, gap: ahead || base < oldest - 1 };
    };
    const first = read();
    if (first.events.length > 0 || waitMs <= 0) return first;
    await new Promise<void>((resolve) => {
      const set = this.waiters.get(identityId) ?? new Set<() => void>();
      let timer: unknown = null;
      const finish = () => {
        this.clock.clearTimeout(timer);
        set.delete(finish);
        resolve();
      };
      set.add(finish);
      this.waiters.set(identityId, set);
      timer = this.clock.setTimeout(finish, waitMs);
    });
    return read();
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `bun test apps/server/src/core/communication.test.ts`
Expected: PASS (12 tests).

> Note: `poll(…, 999, …)` against an empty inbox returns `gap: true`. The timeout test uses `since = 0`, so it expects `gap: false`.

- [ ] **Step 5: Typecheck and commit**

Run: `bunx tsc -p tsconfig.json`. Expected: no errors.
```bash
git add apps/server/src/core/communication.ts apps/server/src/core/communication.test.ts
git commit -m "CommunicationManager: channels, history, flood control, mentions, inbox long-poll

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: GameManager (matches, revisions, turn clocks, autopilot, results)

**Files:**
- Create: `apps/server/src/core/games.ts`
- Test: `apps/server/src/core/games.test.ts`

**Interfaces:**
- Consumes: `GameModule, GameRuleError, Outcome, Rng, createRng, SeatId` (Task 2); `criticalMassGame` (Task 3, tests only); `DB, matches, matchPlayers` (Task 4); `Clock, AppError helpers, newId` (Tasks 4–5); `EventBus` (emits `match.updated`); `CommunicationManager.deliver/postSystem/setTableAccess` (Task 7); `PresenceManager.setPlaying` (Task 6).
- Produces: `class GameManager` with
  - `constructor(db, bus, clock, comms, presence, modules: GameModule<any>[], opts?: Partial<GameManagerOptions>)`, where `GameManagerOptions = { countdownMs: number; maxTimeouts: number; retainMs: number; seed: () => number }`
  - `catalog(): GameInfo[]`, `module(gameId): GameModule<any>` (404 `NO_GAME`)
  - `createMatch(gameId, players: IdentityPublic[]): Promise<MatchSummary>`
  - `envelope(matchId, identityId | null): MatchEnvelope`, `summary(matchId): MatchSummary`
  - `move(matchId, identity, revision: unknown, command: unknown): Promise<MatchEnvelope>`
  - `resign(matchId, identity): Promise<MatchEnvelope>`
  - `wait(matchId, since: number, waitMs: number): Promise<void>`
  - `activeMatchOf(identityId): string | null`
  - `recoverOnBoot(): Promise<number>`
  - `playerIds(matchId): string[] | null`

  Revision starts at 1 at creation, becomes 2 when the countdown ends, and increases by 1 on every move, timeout or resign.

- [ ] **Step 1: Write the failing test**

`apps/server/src/core/games.test.ts`:
```ts
import { afterAll, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { criticalMassGame, type CMCommand, type CMView } from '@cs/critical-mass';
import { createRng } from '@cs/game-api';
import { PUBLIC_CHANNELS, type IdentityPublic } from '@cs/shared/protocol';
import { openDatabase } from '../db';
import { matches, matchPlayers } from '../db/schema';
import { FakeClock } from '../lib/clock';
import type { AppError } from '../lib/errors';
import { newId } from '../lib/ids';
import { waitFor } from '../lib/testing';
import { EventBus } from './bus';
import { CommunicationManager } from './communication';
import { GameManager } from './games';
import { IdentityManager } from './identity';
import { PresenceManager } from './presence';

const database = await openDatabase('pglite:memory');
afterAll(() => database.close());

async function setup() {
  const clock = new FakeClock();
  const bus = new EventBus();
  const ids = new IdentityManager(database.db, { houseKey: null, adminHandles: [] });
  const comms = new CommunicationManager(database.db, bus, clock, ids, { publicChannels: PUBLIC_CHANNELS });
  const presence = new PresenceManager(bus, clock);
  const games = new GameManager(database.db, bus, clock, comms, presence, [criticalMassGame], {
    countdownMs: 3000,
    seed: () => 12345,
  });
  const tag = Math.random().toString(36).slice(2, 8);
  const red = (await ids.registerAgent({ name: `red${tag}` }, null)).identity;
  const blue = (await ids.createHuman(`blue${tag}`)).identity;
  const outsider = (await ids.createHuman(`out${tag}`)).identity;
  presence.agentSeen(red);
  presence.humanConnected(blue);
  return { clock, bus, ids, comms, presence, games, red, blue, outsider };
}
type Ctx = Awaited<ReturnType<typeof setup>>;

async function liveMatch(ctx: Ctx): Promise<string> {
  const summary = await ctx.games.createMatch('critical-mass', [ctx.red, ctx.blue]);
  ctx.clock.advance(3000);
  expect(ctx.games.summary(summary.id).status).toBe('live');
  return summary.id;
}

async function errorOf(p: Promise<unknown>): Promise<AppError> {
  try {
    await p;
  } catch (e) {
    return e as AppError;
  }
  throw new Error('expected a rejection');
}

const firstLegal = (ctx: Ctx, id: string, who: IdentityPublic) => ctx.games.envelope(id, who.id).legal[0] as CMCommand;

describe('creating a match', () => {
  test('starts in countdown, marks players as playing, and tells them', async () => {
    const ctx = await setup();
    const summary = await ctx.games.createMatch('critical-mass', [ctx.red, ctx.blue]);
    expect(summary).toMatchObject({ status: 'countdown', revision: 1, gameId: 'critical-mass', toMove: [] });
    expect(summary.seats.map((s) => [s.seat, s.identity.id])).toEqual([['red', ctx.red.id], ['blue', ctx.blue.id]]);
    expect(ctx.presence.get(ctx.red.id)?.status).toBe('playing');
    expect(ctx.presence.get(ctx.blue.id)?.status).toBe('playing');
    const inbox = await ctx.comms.poll(ctx.blue.id, 0, 0);
    expect(inbox.events.map((e) => e.type)).toContain('match.started');
    const table = await ctx.comms.history(`match:${summary.id}`);
    expect(table[0].system).toBe(true);
    const [row] = await database.db.select().from(matches).where(eq(matches.id, summary.id));
    expect(row).toMatchObject({ status: 'countdown', season: '2026-09', rated: false });
    expect(ctx.games.activeMatchOf(ctx.red.id)).toBe(summary.id);
    const err = await errorOf(ctx.games.move(summary.id, ctx.red, 1, { cell: 'a1' }));
    expect([err.status, err.code]).toEqual([409, 'NOT_STARTED']);
  });
  test('a player can only be in one match; unknown games 404', async () => {
    const ctx = await setup();
    await ctx.games.createMatch('critical-mass', [ctx.red, ctx.blue]);
    expect((await errorOf(ctx.games.createMatch('critical-mass', [ctx.red, ctx.outsider]))).code).toBe('IN_MATCH');
    expect((await errorOf(ctx.games.createMatch('chess', [ctx.outsider, ctx.blue]))).status).toBe(404);
  });
});

describe('playing', () => {
  test('after the countdown red is on the clock', async () => {
    const ctx = await setup();
    const id = await liveMatch(ctx);
    const env = ctx.games.envelope(id, ctx.red.id);
    expect(env.match).toMatchObject({ status: 'live', revision: 2, toMove: ['red'] });
    expect(env.you).toBe('red');
    expect(env.legal).toHaveLength(54);
    expect(ctx.games.envelope(id, ctx.blue.id).legal).toEqual([]);
    expect(ctx.games.envelope(id, null).you).toBeNull();
    const events = (await ctx.comms.poll(ctx.red.id, 0, 0)).events;
    expect(events.find((e) => e.type === 'match.yourTurn')).toMatchObject({ matchId: id, revision: 2 });
  });
  test('moves are validated with precise errors', async () => {
    const ctx = await setup();
    const id = await liveMatch(ctx);
    const e1 = await errorOf(ctx.games.move(id, ctx.red, 1, { cell: 'a1' }));
    expect([e1.status, e1.code]).toEqual([409, 'STALE_REVISION']);
    const e2 = await errorOf(ctx.games.move(id, ctx.blue, 2, { cell: 'a1' }));
    expect([e2.status, e2.code]).toEqual([409, 'NOT_YOUR_TURN']);
    const e3 = await errorOf(ctx.games.move(id, ctx.outsider, 2, { cell: 'a1' }));
    expect([e3.status, e3.code]).toEqual([403, 'NOT_SEATED']);
    const e4 = await errorOf(ctx.games.move(id, ctx.red, 2, { cell: 'z99' }));
    expect([e4.status, e4.code]).toEqual([400, 'BAD_CELL']);
    const e5 = await errorOf(ctx.games.move('m_nope', ctx.red, 2, { cell: 'a1' }));
    expect(e5.status).toBe(404);
    const ok = await ctx.games.move(id, ctx.red, 2, { cell: 'c3' });
    expect(ok.match).toMatchObject({ revision: 3, toMove: ['blue'] });
  });
  test('two moves racing on the same revision: exactly one wins', async () => {
    const ctx = await setup();
    const id = await liveMatch(ctx);
    const results = await Promise.allSettled([
      ctx.games.move(id, ctx.red, 2, { cell: 'c3' }),
      ctx.games.move(id, ctx.red, 2, { cell: 'd4' }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect((rejected.reason as AppError).code).toBe('STALE_REVISION');
  });
  test('wait resolves on change, returns at once if behind, and times out', async () => {
    const ctx = await setup();
    const id = await liveMatch(ctx);
    await ctx.games.wait(id, 1, 25_000); // behind: immediate
    const waiting = ctx.games.wait(id, 2, 25_000);
    await ctx.games.move(id, ctx.red, 2, { cell: 'c3' });
    await waiting;
    const idle = ctx.games.wait(id, 3, 25_000);
    ctx.clock.advance(25_000);
    await idle;
  });
});

describe('clocks', () => {
  test('a timeout makes the autopilot play and says so at the table', async () => {
    const ctx = await setup();
    const id = await liveMatch(ctx);
    ctx.clock.advance(90_000);
    expect(ctx.games.summary(id)).toMatchObject({ revision: 3, toMove: ['blue'] });
    await waitFor(async () => (await ctx.comms.history(`match:${id}`)).some((m) => m.text.includes('dozed off')));
  });
  test('three straight timeouts forfeit; everyone gets their status back; results are recorded', async () => {
    const ctx = await setup();
    const id = await liveMatch(ctx);
    for (let i = 0; i < 5; i++) ctx.clock.advance(90_000); // red, blue, red, blue, red(3rd) → red forfeits
    const summary = ctx.games.summary(id);
    expect(summary.status).toBe('over');
    expect(summary.outcome).toMatchObject({ winners: ['blue'], reason: 'timeout' });
    expect(ctx.presence.get(ctx.blue.id)?.status).toBe('ready');
    expect(ctx.games.activeMatchOf(ctx.blue.id)).toBeNull();
    await waitFor(async () => {
      const rows = await database.db.select().from(matchPlayers).where(eq(matchPlayers.matchId, id));
      return rows.find((r) => r.seat === 'red')?.result === 'loss' && rows.find((r) => r.seat === 'blue')?.result === 'win';
    });
    await waitFor(async () => (await ctx.comms.poll(ctx.blue.id, 0, 0)).events.some((e) => e.type === 'match.over' && e.result === 'win'));
    const [row] = await database.db.select().from(matches).where(eq(matches.id, id));
    expect(row.status).toBe('over');
  });
});

describe('ending', () => {
  test('resigning hands the win over and frees both players', async () => {
    const ctx = await setup();
    const id = await liveMatch(ctx);
    const env = await ctx.games.resign(id, ctx.blue);
    expect(env.match.status).toBe('over');
    expect(env.match.outcome).toMatchObject({ winners: ['red'], reason: 'resign' });
    expect(ctx.presence.get(ctx.blue.id)?.status).toBe('ready');
    expect((await errorOf(ctx.games.resign(id, ctx.blue))).code).toBe('MATCH_OVER');
  });
  test('a full random game finishes and is recorded', async () => {
    const ctx = await setup();
    const id = await liveMatch(ctx);
    const rng = createRng(99);
    for (let guard = 0; guard < 2000; guard++) {
      const s = ctx.games.summary(id);
      if (s.status === 'over') break;
      const mover = s.toMove[0] === 'red' ? ctx.red : ctx.blue;
      const legal = ctx.games.envelope(id, mover.id).legal as CMCommand[];
      await ctx.games.move(id, mover, s.revision, rng.pick(legal));
    }
    const final = ctx.games.envelope(id, null);
    expect(final.match.status).toBe('over');
    expect((final.view as CMView).winner).toBe(final.match.outcome!.winners[0]);
    await waitFor(async () => {
      const [row] = await database.db.select().from(matches).where(eq(matches.id, id));
      return row.status === 'over' && row.endedAt !== null;
    });
  });
  test('a restart abandons matches that were in flight', async () => {
    const ctx = await setup();
    const id = newId('m');
    await database.db.insert(matches).values({ id, gameId: 'critical-mass', status: 'live', seed: 1, season: '2026-09' });
    expect(await ctx.games.recoverOnBoot()).toBeGreaterThanOrEqual(1);
    const [row] = await database.db.select().from(matches).where(eq(matches.id, id));
    expect(row).toMatchObject({ status: 'abandoned', endReason: 'server-restart' });
  });
});
```

> The timeout test relies on the fixed seed `12345`. If that seed's four autopilot moves happen to end the game early, the test fails every time rather than intermittently. In that case change the seed in `setup()` and note it in the commit message.

- [ ] **Step 2: Run it to see it fail**

Run: `bun test apps/server/src/core/games.test.ts`
Expected: FAIL. The module `./games` isn't found.

- [ ] **Step 3: Implement**

`apps/server/src/core/games.ts`:
```ts
import { and, eq, inArray } from 'drizzle-orm';
import { createRng, GameRuleError, type GameModule, type Outcome, type Rng, type SeatId } from '@cs/game-api';
import {
  seasonOf,
  type GameInfo,
  type IdentityPublic,
  type MatchEnvelope,
  type MatchStatus,
  type MatchSummary,
  type SeatInfo,
} from '@cs/shared/protocol';
import type { DB } from '../db';
import { matches, matchPlayers } from '../db/schema';
import type { Clock } from '../lib/clock';
import { AppError, badRequest, conflict, forbidden, notFound } from '../lib/errors';
import { newId } from '../lib/ids';
import type { EventBus } from './bus';
import type { CommunicationManager } from './communication';
import type { PresenceManager } from './presence';

export interface GameManagerOptions {
  countdownMs: number;
  maxTimeouts: number;
  retainMs: number;
  seed: () => number;
}

const DEFAULTS: GameManagerOptions = {
  countdownMs: 3000,
  maxTimeouts: 3,
  retainMs: 30 * 60_000,
  seed: () => Math.floor(Math.random() * 2 ** 31),
};

interface LiveMatch {
  id: string;
  gameId: string;
  module: GameModule<any>;
  state: unknown;
  seats: SeatInfo[];
  status: MatchStatus;
  revision: number;
  startsAt: number;
  deadline: number | null;
  timeouts: Record<SeatId, number>;
  outcome: Outcome | null;
  endReason: string | null;
  timer: unknown;
  waiters: Set<() => void>;
  rng: Rng;
}

const resultFor = (o: Outcome, seat: SeatId): 'win' | 'loss' | 'draw' =>
  o.winners.length === 0 ? 'draw' : o.winners.includes(seat) ? 'win' : 'loss';

export class GameManager {
  private matches = new Map<string, LiveMatch>();
  private active = new Map<string, string>();
  private modules: Map<string, GameModule<any>>;
  private opts: GameManagerOptions;

  constructor(
    private db: DB,
    private bus: EventBus,
    private clock: Clock,
    private comms: CommunicationManager,
    private presence: PresenceManager,
    modules: GameModule<any>[],
    opts: Partial<GameManagerOptions> = {},
  ) {
    this.modules = new Map(modules.map((m) => [m.meta.id, m]));
    this.opts = { ...DEFAULTS, ...opts };
    comms.setTableAccess((matchId) => {
      const ids = this.playerIds(matchId);
      return ids ? { playerIds: ids } : null;
    });
  }

  catalog(): GameInfo[] {
    return [...this.modules.values()].map(({ meta }) => ({
      id: meta.id,
      name: meta.name,
      tagline: meta.tagline,
      mode: meta.mode,
      minPlayers: meta.minPlayers,
      maxPlayers: meta.maxPlayers,
      seats: meta.seats,
    }));
  }

  module(gameId: string): GameModule<any> {
    const m = this.modules.get(gameId);
    if (!m) throw notFound('NO_GAME', `There is no game "${gameId}". See GET /api/games.`);
    return m;
  }

  activeMatchOf(identityId: string): string | null {
    return this.active.get(identityId) ?? null;
  }

  playerIds(matchId: string): string[] | null {
    const m = this.matches.get(matchId);
    return m ? m.seats.map((s) => s.identity.id) : null;
  }

  async recoverOnBoot(): Promise<number> {
    const stale = await this.db
      .update(matches)
      .set({ status: 'abandoned', endReason: 'server-restart', endedAt: new Date(this.clock.now()) })
      .where(inArray(matches.status, ['countdown', 'live']))
      .returning({ id: matches.id });
    if (stale.length > 0) {
      await this.db
        .update(matchPlayers)
        .set({ result: 'abandoned' })
        .where(inArray(matchPlayers.matchId, stale.map((s) => s.id)));
    }
    return stale.length;
  }

  async createMatch(gameId: string, players: IdentityPublic[]): Promise<MatchSummary> {
    const module = this.module(gameId);
    const { minPlayers, maxPlayers, seats: seatNames, name } = module.meta;
    if (players.length < minPlayers || players.length > maxPlayers) {
      throw badRequest('BAD_PLAYERS', `${name} takes ${minPlayers}–${maxPlayers} players.`);
    }
    if (new Set(players.map((p) => p.id)).size !== players.length) throw badRequest('BAD_PLAYERS', 'Players must be different.');
    for (const p of players) {
      if (this.active.has(p.id)) throw conflict('IN_MATCH', `@${p.handle} is already in a match.`);
    }
    const now = this.clock.now();
    const seed = this.opts.seed();
    const seats: SeatInfo[] = players.map((identity, i) => ({ seat: seatNames[i], identity }));
    const id = newId('m');
    const m: LiveMatch = {
      id,
      gameId,
      module,
      state: module.setup({ seats: seats.map((s) => s.seat), seed }),
      seats,
      status: 'countdown',
      revision: 1,
      startsAt: now + this.opts.countdownMs,
      deadline: null,
      timeouts: Object.fromEntries(seats.map((s) => [s.seat, 0])),
      outcome: null,
      endReason: null,
      timer: null,
      waiters: new Set(),
      rng: createRng(seed ^ 0x5eed),
    };
    this.matches.set(id, m);
    for (const s of seats) {
      this.active.set(s.identity.id, id);
      this.presence.setPlaying(s.identity.id, true);
    }
    m.timer = this.clock.setTimeout(() => {
      this.goLive(id).catch((e) => console.error('[games] goLive failed', e));
    }, this.opts.countdownMs);
    await this.db.insert(matches).values({
      id,
      gameId,
      status: 'countdown',
      seed,
      season: seasonOf(now),
      rated: seats.every((s) => s.identity.kind === 'agent' || s.identity.locked),
      createdAt: new Date(now),
    });
    await this.db.insert(matchPlayers).values(
      seats.map((s) => ({ matchId: id, seat: s.seat, identityId: s.identity.id, kind: s.identity.kind })),
    );
    const summary = this.toSummary(m);
    for (const s of seats) this.comms.deliver(s.identity.id, { type: 'match.started', match: summary });
    await this.comms.postSystem(
      `match:${id}`,
      `${seats.map((s) => `@${s.identity.handle}`).join(' vs ')} — ${name}. Talk trash; play fair.`,
    );
    this.changed(m);
    return summary;
  }

  private async goLive(id: string): Promise<void> {
    const m = this.matches.get(id);
    if (!m || m.status !== 'countdown') return;
    m.status = 'live';
    m.revision += 1;
    this.startTurn(m);
    this.changed(m);
    await this.db.update(matches).set({ status: 'live' }).where(eq(matches.id, id));
  }

  private startTurn(m: LiveMatch): void {
    this.clock.clearTimeout(m.timer);
    m.timer = null;
    m.deadline = null;
    const turn = m.module.turn;
    if (!turn || m.status !== 'live') return;
    const toMove = turn.toMove(m.state);
    if (toMove.length === 0) return;
    const ms = turn.turnSeconds * 1000;
    m.deadline = this.clock.now() + ms;
    m.timer = this.clock.setTimeout(() => {
      this.onTimeout(m.id).catch((e) => console.error('[games] timeout failed', e));
    }, ms);
    const deadline = new Date(m.deadline).toISOString();
    for (const seat of toMove) {
      this.comms.deliver(this.seatInfo(m, seat).identity.id, {
        type: 'match.yourTurn',
        matchId: m.id,
        revision: m.revision,
        deadline,
      });
    }
  }

  /** Synchronously installs the new state (so racing requests see the new revision), then persists. */
  private async advance(m: LiveMatch, next: unknown): Promise<void> {
    m.state = next;
    m.revision += 1;
    const outcome = m.module.outcome(m.state);
    if (outcome) {
      await this.finish(m, outcome);
      return;
    }
    this.startTurn(m);
    this.changed(m);
  }

  async move(matchId: string, identity: IdentityPublic, revision: unknown, command: unknown): Promise<MatchEnvelope> {
    const m = this.require(matchId);
    const seat = this.seatOf(m, identity.id);
    if (!seat) throw forbidden('NOT_SEATED', 'You are not playing in this match.');
    if (m.status === 'countdown') throw conflict('NOT_STARTED', 'The match starts in a moment.');
    if (m.status !== 'live') throw conflict('MATCH_OVER', 'This match is already over.');
    if (revision !== m.revision) {
      throw conflict('STALE_REVISION', `The match is at revision ${m.revision}; you sent ${JSON.stringify(revision)}. Fetch it and try again.`);
    }
    const turn = m.module.turn;
    if (!turn) throw badRequest('NOT_TURN_BASED', 'This game uses doctrine, not moves.');
    if (!turn.toMove(m.state).includes(seat)) throw conflict('NOT_YOUR_TURN', `It is not ${seat}'s turn.`);
    let next: unknown;
    try {
      next = turn.apply(m.state, seat, command);
    } catch (e) {
      if (e instanceof GameRuleError) throw new AppError(400, e.code, e.message);
      throw e;
    }
    m.timeouts[seat] = 0;
    await this.advance(m, next);
    return this.envelope(matchId, identity.id);
  }

  async resign(matchId: string, identity: IdentityPublic): Promise<MatchEnvelope> {
    const m = this.require(matchId);
    const seat = this.seatOf(m, identity.id);
    if (!seat) throw forbidden('NOT_SEATED', 'You are not playing in this match.');
    if (m.status === 'over' || m.status === 'abandoned') throw conflict('MATCH_OVER', 'This match is already over.');
    if (m.status === 'countdown') m.status = 'live';
    const done = this.advance(m, m.module.forfeit(m.state, seat, 'resign'));
    if (m.status !== 'over') this.release(m, identity.id);
    await this.comms.postSystem(`match:${m.id}`, `@${identity.handle} resigns.`);
    await done;
    return this.envelope(matchId, identity.id);
  }

  private async onTimeout(id: string): Promise<void> {
    const m = this.matches.get(id);
    const turn = m?.module.turn;
    if (!m || !turn || m.status !== 'live') return;
    const seat = turn.toMove(m.state)[0];
    if (!seat) return;
    const who = this.seatInfo(m, seat).identity;
    const table = `match:${m.id}`;
    m.timeouts[seat] = (m.timeouts[seat] ?? 0) + 1;
    const legal = turn.legal(m.state, seat);
    if (m.timeouts[seat] >= this.opts.maxTimeouts || legal.length === 0) {
      const done = this.advance(m, m.module.forfeit(m.state, seat, 'timeout'));
      if (m.status !== 'over') this.release(m, who.id);
      await this.comms.postSystem(table, `@${who.handle} timed out ${m.timeouts[seat]} times in a row and forfeits.`);
      await done;
      return;
    }
    const command = m.rng.pick(legal);
    const done = this.advance(m, turn.apply(m.state, seat, command));
    const text = turn.describe ? turn.describe(command) : JSON.stringify(command);
    await this.comms.postSystem(table, `@${who.handle} dozed off — autopilot played ${text}.`);
    await done;
  }

  private async finish(m: LiveMatch, outcome: Outcome): Promise<void> {
    this.clock.clearTimeout(m.timer);
    m.status = 'over';
    m.outcome = outcome;
    m.endReason = outcome.reason;
    m.deadline = null;
    for (const s of m.seats) this.release(m, s.identity.id);
    this.changed(m);
    m.timer = this.clock.setTimeout(() => this.matches.delete(m.id), this.opts.retainMs);
    await this.db
      .update(matches)
      .set({ status: 'over', outcome, endReason: outcome.reason, endedAt: new Date(this.clock.now()) })
      .where(eq(matches.id, m.id));
    for (const s of m.seats) {
      await this.db
        .update(matchPlayers)
        .set({ result: resultFor(outcome, s.seat) })
        .where(and(eq(matchPlayers.matchId, m.id), eq(matchPlayers.seat, s.seat)));
    }
    for (const s of m.seats) {
      this.comms.deliver(s.identity.id, { type: 'match.over', matchId: m.id, outcome, result: resultFor(outcome, s.seat) });
    }
    await this.comms.postSystem(`match:${m.id}`, this.verdict(m, outcome));
  }

  private verdict(m: LiveMatch, o: Outcome): string {
    if (o.winners.length === 0) return `Draw (${o.reason.replaceAll('-', ' ')}).`;
    const names = o.winners.map((w) => `@${this.seatInfo(m, w).identity.handle}`).join(' & ');
    return `${names} wins (${o.reason.replaceAll('-', ' ')}). GG.`;
  }

  private release(m: LiveMatch, identityId: string): void {
    if (this.active.get(identityId) === m.id) this.active.delete(identityId);
    this.presence.setPlaying(identityId, false);
  }

  async wait(matchId: string, since: number, waitMs: number): Promise<void> {
    const m = this.require(matchId);
    if (m.revision > since || waitMs <= 0 || m.status === 'over' || m.status === 'abandoned') return;
    await new Promise<void>((resolve) => {
      let timer: unknown = null;
      const finish = () => {
        this.clock.clearTimeout(timer);
        m.waiters.delete(finish);
        resolve();
      };
      m.waiters.add(finish);
      timer = this.clock.setTimeout(finish, waitMs);
    });
  }

  private changed(m: LiveMatch): void {
    const waiting = [...m.waiters];
    m.waiters.clear();
    for (const wake of waiting) wake();
    this.bus.emit('match.updated', { matchId: m.id, revision: m.revision });
  }

  envelope(matchId: string, identityId: string | null): MatchEnvelope {
    const m = this.require(matchId);
    const you = identityId ? this.seatOf(m, identityId) : null;
    const turn = m.module.turn;
    const legal = you && m.status === 'live' && turn && turn.toMove(m.state).includes(you) ? turn.legal(m.state, you) : [];
    return { match: this.toSummary(m), you, view: m.module.view(m.state, you), legal };
  }

  summary(matchId: string): MatchSummary {
    return this.toSummary(this.require(matchId));
  }

  private toSummary(m: LiveMatch): MatchSummary {
    const turn = m.module.turn;
    return {
      id: m.id,
      gameId: m.gameId,
      status: m.status,
      revision: m.revision,
      seats: m.seats,
      toMove: m.status === 'live' && turn ? turn.toMove(m.state) : [],
      deadline: m.deadline ? new Date(m.deadline).toISOString() : null,
      startsAt: new Date(m.startsAt).toISOString(),
      outcome: m.outcome,
      endReason: m.endReason,
    };
  }

  private require(matchId: string): LiveMatch {
    const m = this.matches.get(matchId);
    if (!m) throw notFound('NO_MATCH', `There is no live match "${matchId}".`);
    return m;
  }

  private seatOf(m: LiveMatch, identityId: string): SeatId | null {
    return m.seats.find((s) => s.identity.id === identityId)?.seat ?? null;
  }

  private seatInfo(m: LiveMatch, seat: SeatId): SeatInfo {
    const info = m.seats.find((s) => s.seat === seat);
    if (!info) throw new Error(`seat ${seat} not in match ${m.id}`);
    return info;
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `bun test apps/server/src/core/games.test.ts`
Expected: PASS (11 tests).

- [ ] **Step 5: Run the whole server suite, typecheck, commit**

Run: `bun test apps/server && bunx tsc -p tsconfig.json`
Expected: all PASS, no type errors.
```bash
git add apps/server/src/core/games.ts apps/server/src/core/games.test.ts
git commit -m "GameManager: matches, revisions, turn clocks, autopilot, forfeits, results

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: Quick match (InviteManager) and the Carbon-vs-Silicon tally (LeaderboardManager)

**Files:**
- Create: `apps/server/src/core/invites.ts`, `apps/server/src/core/leaderboard.ts`
- Test: `apps/server/src/core/invites.test.ts`, `apps/server/src/core/leaderboard.test.ts`

**Interfaces:**
- Consumes: `GameManager.createMatch/module/activeMatchOf` (Task 8); `PresenceManager.get/list/isReady` (Task 6); `EventBus` (`presence.changed`); `Clock`; `DB, matches, matchPlayers`.
- Produces:
  - `class InviteManager` with
    - `constructor(games, presence, bus, clock, opts?: { houseFallbackMs: number })`
    - `quickMatch(identity, gameId): Promise<{ status: 'queued' } | { status: 'matched'; match: MatchSummary }>`
    - `leave(identityId): boolean`
    - `queuedFor(identityId): string | null` (the gameId, or null)

    Invites between named players come in M2. In M1, InviteManager owns only quick match.
  - `class LeaderboardManager` with `constructor(db)` and `tally(season: string): Promise<Tally>`.

- [ ] **Step 1: Write the failing tests**

`apps/server/src/core/leaderboard.test.ts`:
```ts
import { afterAll, describe, expect, test } from 'bun:test';
import { openDatabase } from '../db';
import { matches, matchPlayers } from '../db/schema';
import { newId } from '../lib/ids';
import { IdentityManager } from './identity';
import { LeaderboardManager } from './leaderboard';

const database = await openDatabase('pglite:memory');
afterAll(() => database.close());

describe('tally', () => {
  test('counts finished human-vs-agent matches in the season only', async () => {
    const ids = new IdentityManager(database.db, { houseKey: null, adminHandles: [] });
    const h = (await ids.createHuman('Carbonara')).identity;
    const a = (await ids.registerAgent({ name: 'Siliconda' }, null)).identity;
    const a2 = (await ids.registerAgent({ name: 'Siliconte' }, null)).identity;
    type R = 'win' | 'loss' | 'draw' | 'abandoned';
    async function match(season: string, status: 'over' | 'abandoned', players: [typeof h, R][]) {
      const id = newId('m');
      await database.db.insert(matches).values({ id, gameId: 'critical-mass', status, seed: 1, season });
      await database.db.insert(matchPlayers).values(
        players.map(([p, result], i) => ({ matchId: id, seat: `s${i}`, identityId: p.id, kind: p.kind, result })),
      );
    }
    await match('2030-01', 'over', [[h, 'win'], [a, 'loss']]); // carbon
    await match('2030-01', 'over', [[h, 'loss'], [a, 'win']]); // silicon
    await match('2030-01', 'over', [[h, 'draw'], [a, 'draw']]); // draw
    await match('2030-01', 'over', [[a, 'win'], [a2, 'loss']]); // machine vs machine: ignored
    await match('2030-01', 'abandoned', [[h, 'abandoned'], [a, 'abandoned']]); // ignored
    await match('2030-02', 'over', [[h, 'win'], [a, 'loss']]); // other season
    const board = new LeaderboardManager(database.db);
    expect(await board.tally('2030-01')).toEqual({ season: '2030-01', carbon: 1, silicon: 1, draws: 1 });
    expect(await board.tally('2029-12')).toEqual({ season: '2029-12', carbon: 0, silicon: 0, draws: 0 });
  });
});
```

`apps/server/src/core/invites.test.ts`:
```ts
import { afterAll, describe, expect, test } from 'bun:test';
import { criticalMassGame } from '@cs/critical-mass';
import { PUBLIC_CHANNELS } from '@cs/shared/protocol';
import { openDatabase } from '../db';
import { FakeClock } from '../lib/clock';
import type { AppError } from '../lib/errors';
import { waitFor } from '../lib/testing';
import { EventBus } from './bus';
import { CommunicationManager } from './communication';
import { GameManager } from './games';
import { IdentityManager } from './identity';
import { InviteManager } from './invites';
import { PresenceManager } from './presence';

const database = await openDatabase('pglite:memory');
afterAll(() => database.close());

async function setup() {
  const clock = new FakeClock();
  const bus = new EventBus();
  const ids = new IdentityManager(database.db, { houseKey: 'hk', adminHandles: [] });
  const comms = new CommunicationManager(database.db, bus, clock, ids, { publicChannels: PUBLIC_CHANNELS });
  const presence = new PresenceManager(bus, clock);
  const games = new GameManager(database.db, bus, clock, comms, presence, [criticalMassGame]);
  const invites = new InviteManager(games, presence, bus, clock, { houseFallbackMs: 8000 });
  const tag = Math.random().toString(36).slice(2, 8);
  const ann = (await ids.createHuman(`ann${tag}`)).identity;
  const ben = (await ids.createHuman(`ben${tag}`)).identity;
  const house = (await ids.registerAgent({ name: `house${tag}` }, 'hk')).identity;
  presence.humanConnected(ann);
  presence.humanConnected(ben);
  return { clock, presence, games, invites, ann, ben, house };
}

async function errorOf(p: Promise<unknown>): Promise<AppError> {
  try {
    await p;
  } catch (e) {
    return e as AppError;
  }
  throw new Error('expected a rejection');
}

describe('quick match', () => {
  test('two ready players are paired immediately', async () => {
    const { invites, games, ann, ben } = await setup();
    expect(await invites.quickMatch(ann, 'critical-mass')).toEqual({ status: 'queued' });
    expect(invites.queuedFor(ann.id)).toBe('critical-mass');
    expect(await invites.quickMatch(ann, 'critical-mass')).toEqual({ status: 'queued' });
    const r = await invites.quickMatch(ben, 'critical-mass');
    expect(r.status).toBe('matched');
    if (r.status !== 'matched') return;
    expect(r.match.seats.map((s) => s.identity.id).sort()).toEqual([ann.id, ben.id].sort());
    expect(invites.queuedFor(ann.id)).toBeNull();
    expect(games.activeMatchOf(ann.id)).toBe(r.match.id);
  });
  test('after 8 seconds alone, a ready house bot steps in', async () => {
    const { invites, games, presence, clock, ann, house } = await setup();
    presence.agentSeen(house);
    await invites.quickMatch(ann, 'critical-mass');
    clock.advance(7999);
    expect(games.activeMatchOf(ann.id)).toBeNull();
    clock.advance(1);
    await waitFor(() => games.activeMatchOf(ann.id) !== null);
    expect(games.activeMatchOf(house.id)).toBe(games.activeMatchOf(ann.id));
  });
  test('with no house bot around, the player keeps waiting until one shows up', async () => {
    const { invites, games, presence, clock, ann, house } = await setup();
    await invites.quickMatch(ann, 'critical-mass');
    clock.advance(8000);
    expect(invites.queuedFor(ann.id)).toBe('critical-mass');
    presence.agentSeen(house);
    clock.advance(8000);
    await waitFor(() => games.activeMatchOf(ann.id) !== null);
  });
  test('refusals: not ready, already playing, house bots, unknown games', async () => {
    const { invites, presence, ann, ben, house } = await setup();
    presence.setManualStatus(ann, 'afk');
    expect((await errorOf(invites.quickMatch(ann, 'critical-mass'))).code).toBe('NOT_READY');
    presence.agentSeen(house);
    expect((await errorOf(invites.quickMatch(house, 'critical-mass'))).status).toBe(403);
    expect((await errorOf(invites.quickMatch(ben, 'chess'))).status).toBe(404);
    presence.setManualStatus(ann, 'ready');
    await invites.quickMatch(ann, 'critical-mass');
    await invites.quickMatch(ben, 'critical-mass');
    expect((await errorOf(invites.quickMatch(ben, 'critical-mass'))).code).toBe('IN_MATCH');
  });
  test('going afk leaves the queue; leave() reports whether you were queued', async () => {
    const { invites, presence, ann, ben } = await setup();
    await invites.quickMatch(ann, 'critical-mass');
    presence.setManualStatus(ann, 'afk');
    expect(invites.queuedFor(ann.id)).toBeNull();
    await invites.quickMatch(ben, 'critical-mass');
    expect(invites.leave(ben.id)).toBe(true);
    expect(invites.leave(ben.id)).toBe(false);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `bun test apps/server/src/core/invites.test.ts apps/server/src/core/leaderboard.test.ts`
Expected: FAIL. The modules aren't found.

- [ ] **Step 3: Implement**

`apps/server/src/core/leaderboard.ts`:
```ts
import { and, eq } from 'drizzle-orm';
import type { Tally } from '@cs/shared/protocol';
import type { DB } from '../db';
import { matches, matchPlayers } from '../db/schema';

/** M1 holds only the season's Carbon-vs-Silicon tally; Elo and standings arrive in M4. */
export class LeaderboardManager {
  constructor(private db: DB) {}

  async tally(season: string): Promise<Tally> {
    const rows = await this.db
      .select({ matchId: matchPlayers.matchId, kind: matchPlayers.kind, result: matchPlayers.result })
      .from(matchPlayers)
      .innerJoin(matches, eq(matches.id, matchPlayers.matchId))
      .where(and(eq(matches.season, season), eq(matches.status, 'over')));
    const byMatch = new Map<string, { kind: string; result: string | null }[]>();
    for (const r of rows) {
      const list = byMatch.get(r.matchId) ?? [];
      list.push(r);
      byMatch.set(r.matchId, list);
    }
    let carbon = 0;
    let silicon = 0;
    let draws = 0;
    for (const players of byMatch.values()) {
      if (new Set(players.map((p) => p.kind)).size < 2) continue;
      const winners = players.filter((p) => p.result === 'win');
      if (winners.length === 0) draws += 1;
      else if (winners.every((w) => w.kind === 'human')) carbon += 1;
      else if (winners.every((w) => w.kind === 'agent')) silicon += 1;
    }
    return { season, carbon, silicon, draws };
  }
}
```

`apps/server/src/core/invites.ts`:
```ts
import type { IdentityPublic, MatchSummary } from '@cs/shared/protocol';
import type { Clock } from '../lib/clock';
import { conflict, forbidden } from '../lib/errors';
import type { EventBus } from './bus';
import type { GameManager } from './games';
import type { PresenceManager } from './presence';

interface QueueEntry {
  identity: IdentityPublic;
  gameId: string;
  timer: unknown;
}

export type QuickMatchResult = { status: 'queued' } | { status: 'matched'; match: MatchSummary };

export class InviteManager {
  private queue = new Map<string, QueueEntry>();

  constructor(
    private games: GameManager,
    private presence: PresenceManager,
    bus: EventBus,
    private clock: Clock,
    private opts: { houseFallbackMs: number } = { houseFallbackMs: 8000 },
  ) {
    bus.on('presence.changed', (p) => {
      if (p.status !== 'ready') this.leave(p.identity.id);
    });
  }

  async quickMatch(identity: IdentityPublic, gameId: string): Promise<QuickMatchResult> {
    this.games.module(gameId);
    if (identity.isHouse) throw forbidden('HOUSE_WAITS', 'House bots are matched automatically.');
    if (this.games.activeMatchOf(identity.id)) throw conflict('IN_MATCH', 'Finish your current match first.');
    if (!this.presence.isReady(identity.id)) throw conflict('NOT_READY', 'Set your status to ready first.');
    const existing = this.queue.get(identity.id);
    if (existing?.gameId === gameId) return { status: 'queued' };
    if (existing) this.leave(identity.id);
    const partner = [...this.queue.values()].find(
      (e) => e.gameId === gameId && e.identity.id !== identity.id && this.presence.isReady(e.identity.id),
    );
    if (partner) {
      this.leave(partner.identity.id);
      const players = Math.random() < 0.5 ? [partner.identity, identity] : [identity, partner.identity];
      return { status: 'matched', match: await this.games.createMatch(gameId, players) };
    }
    const entry: QueueEntry = { identity, gameId, timer: null };
    this.queue.set(identity.id, entry);
    this.arm(entry);
    return { status: 'queued' };
  }

  private arm(entry: QueueEntry): void {
    entry.timer = this.clock.setTimeout(() => {
      this.fallback(entry.identity.id).catch((e) => console.error('[invites] fallback failed', e));
    }, this.opts.houseFallbackMs);
  }

  private async fallback(identityId: string): Promise<void> {
    const entry = this.queue.get(identityId);
    if (!entry) return;
    const bot = this.presence
      .list()
      .find((p) => p.identity.isHouse && p.status === 'ready' && !this.games.activeMatchOf(p.identity.id));
    if (!bot) {
      this.arm(entry);
      return;
    }
    this.leave(identityId);
    try {
      await this.games.createMatch(entry.gameId, [entry.identity, bot.identity]);
    } catch (e) {
      console.error('[invites] could not start house match', e);
      this.queue.set(identityId, entry);
      this.arm(entry);
    }
  }

  leave(identityId: string): boolean {
    const entry = this.queue.get(identityId);
    if (!entry) return false;
    this.clock.clearTimeout(entry.timer);
    this.queue.delete(identityId);
    return true;
  }

  queuedFor(identityId: string): string | null {
    return this.queue.get(identityId)?.gameId ?? null;
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `bun test apps/server/src/core/invites.test.ts apps/server/src/core/leaderboard.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/core/invites.ts apps/server/src/core/invites.test.ts apps/server/src/core/leaderboard.ts apps/server/src/core/leaderboard.test.ts
git commit -m "Quick match with house-bot fallback; Carbon-vs-Silicon tally

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: DiaryService and `createCore` (wiring the managers)

**Files:**
- Create: `apps/server/src/core/diary.ts`, `apps/server/src/core/core.ts`
- Create fixtures: `apps/server/src/__fixtures__/diary/2026-01-01-first.md`, `apps/server/src/__fixtures__/diary/2026-01-02-second.md`
- Test: `apps/server/src/core/core.test.ts`

**Interfaces:**
- Consumes: every manager from Tasks 5–9; `criticalMassGame`; `openDatabase`; `systemClock`; `PUBLIC_CHANNELS`, `DiaryEntry`, `DiaryEntrySummary`.
- Produces:
  - `class DiaryService` with
    - `constructor(dir)`, `entries: DiaryEntry[]` (newest first)
    - `load(): Promise<void>`, `get(slug): DiaryEntry | null`, `summaries(): DiaryEntrySummary[]`
    - `announce(comms): Promise<number>`: posts each entry not yet announced to `#diary` and returns how many it posted
  - `parseEntry(file, raw): DiaryEntry`
  - `interface CoreOptions { databaseUrl?; clock?; houseKey: string | null; adminHandles: string[]; diaryDir: string; countdownMs?; houseFallbackMs?; seed? }`
  - `interface Core { database, bus, clock, identities, presence, comms, games, invites, leaderboard, diary, close(): Promise<void> }` and `createCore(opts): Promise<Core>`

- [ ] **Step 1: Create the fixtures**

`apps/server/src/__fixtures__/diary/2026-01-01-first.md`:
```markdown
---
title: "The first entry"
date: 2026-01-01
---
Hello from the **first** entry.
```

`apps/server/src/__fixtures__/diary/2026-01-02-second.md`:
```markdown
---
title: The second entry
date: 2026-01-02
---
Second thoughts.
```

- [ ] **Step 2: Write the failing test**

`apps/server/src/core/core.test.ts`:
```ts
import { afterAll, describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { createCore } from './core';
import { parseEntry } from './diary';

const diaryDir = fileURLToPath(new URL('../__fixtures__/diary', import.meta.url));
const core = await createCore({ databaseUrl: 'pglite:memory', houseKey: 'hk', adminHandles: ['Boss'], diaryDir });
afterAll(() => core.close());

describe('parseEntry', () => {
  test('reads frontmatter and body, strips quotes, falls back to the filename', () => {
    expect(parseEntry('2026-01-01-first.md', '---\ntitle: "Hi"\ndate: 2026-01-01\n---\nBody')).toEqual({
      slug: '2026-01-01-first',
      title: 'Hi',
      date: '2026-01-01',
      markdown: 'Body',
    });
    expect(parseEntry('2026-02-03-bare.md', 'Just text')).toEqual({
      slug: '2026-02-03-bare',
      title: '2026-02-03-bare',
      date: '2026-02-03',
      markdown: 'Just text',
    });
  });
});

describe('createCore', () => {
  test('loads the diary newest-first and announces each entry once', async () => {
    expect(core.diary.summaries().map((e) => e.slug)).toEqual(['2026-01-02-second', '2026-01-01-first']);
    expect(core.diary.get('2026-01-01-first')?.markdown).toContain('**first**');
    const history = await core.comms.history('diary');
    expect(history.map((m) => m.text)).toEqual([
      'New diary entry — “The first entry” /diary/2026-01-01-first',
      'New diary entry — “The second entry” /diary/2026-01-02-second',
    ]);
    expect(await core.diary.announce(core.comms)).toBe(0);
  });
  test('admin handles are case-insensitive and the catalog has Critical Mass', async () => {
    const { identity } = await core.identities.createHuman('boss');
    expect(identity.role).toBe('admin');
    expect(core.games.catalog().map((g) => g.id)).toEqual(['critical-mass']);
  });
});
```

- [ ] **Step 3: Run it to see it fail**

Run: `bun test apps/server/src/core/core.test.ts`
Expected: FAIL. The modules aren't found.

- [ ] **Step 4: Implement**

`apps/server/src/core/diary.ts`:
```ts
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DIARY_CHANNEL, type DiaryEntry, type DiaryEntrySummary } from '@cs/shared/protocol';
import type { CommunicationManager } from './communication';

export function parseEntry(file: string, raw: string): DiaryEntry {
  const slug = file.replace(/\.md$/, '');
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  const front = m ? m[1] : '';
  const body = (m ? m[2] : raw).trim();
  const field = (key: string) =>
    new RegExp(`^${key}:\\s*(.+)$`, 'm')
      .exec(front)?.[1]
      ?.trim()
      .replace(/^["']|["']$/g, '');
  return { slug, title: field('title') ?? slug, date: field('date') ?? slug.slice(0, 10), markdown: body };
}

export class DiaryService {
  entries: DiaryEntry[] = [];

  constructor(private dir: string) {}

  async load(): Promise<void> {
    if (!existsSync(this.dir)) {
      this.entries = [];
      return;
    }
    const list: DiaryEntry[] = [];
    for await (const file of new Bun.Glob('*.md').scan({ cwd: this.dir })) {
      list.push(parseEntry(file, await Bun.file(join(this.dir, file)).text()));
    }
    list.sort((a, b) => (a.date === b.date ? b.slug.localeCompare(a.slug) : b.date.localeCompare(a.date)));
    this.entries = list;
  }

  get(slug: string): DiaryEntry | null {
    return this.entries.find((e) => e.slug === slug) ?? null;
  }

  summaries(): DiaryEntrySummary[] {
    return this.entries.map(({ slug, title, date }) => ({ slug, title, date }));
  }

  /** Post entries that #diary hasn't seen yet, oldest first. */
  async announce(comms: CommunicationManager): Promise<number> {
    const seen = await comms.history(DIARY_CHANNEL, { limit: 200 });
    let posted = 0;
    for (const entry of [...this.entries].reverse()) {
      const link = `/diary/${entry.slug}`;
      if (seen.some((m) => m.text.endsWith(link))) continue;
      await comms.postSystem(DIARY_CHANNEL, `New diary entry — “${entry.title}” ${link}`);
      posted += 1;
    }
    return posted;
  }
}
```

`apps/server/src/core/core.ts`:
```ts
import { criticalMassGame } from '@cs/critical-mass';
import { PUBLIC_CHANNELS } from '@cs/shared/protocol';
import { openDatabase, type Database } from '../db';
import { systemClock, type Clock } from '../lib/clock';
import { EventBus } from './bus';
import { CommunicationManager } from './communication';
import { DiaryService } from './diary';
import { GameManager, type GameManagerOptions } from './games';
import { IdentityManager } from './identity';
import { InviteManager } from './invites';
import { LeaderboardManager } from './leaderboard';
import { PresenceManager } from './presence';

export interface CoreOptions {
  databaseUrl?: string;
  clock?: Clock;
  houseKey: string | null;
  adminHandles: string[];
  diaryDir: string;
  countdownMs?: number;
  houseFallbackMs?: number;
  seed?: () => number;
}

export interface Core {
  database: Database;
  bus: EventBus;
  clock: Clock;
  identities: IdentityManager;
  presence: PresenceManager;
  comms: CommunicationManager;
  games: GameManager;
  invites: InviteManager;
  leaderboard: LeaderboardManager;
  diary: DiaryService;
  close(): Promise<void>;
}

export async function createCore(opts: CoreOptions): Promise<Core> {
  const database = await openDatabase(opts.databaseUrl);
  const clock = opts.clock ?? systemClock;
  const bus = new EventBus();
  const identities = new IdentityManager(database.db, {
    houseKey: opts.houseKey,
    adminHandles: opts.adminHandles.map((h) => h.trim().toLowerCase()).filter(Boolean),
  });
  const presence = new PresenceManager(bus, clock);
  const comms = new CommunicationManager(database.db, bus, clock, identities, { publicChannels: PUBLIC_CHANNELS });
  const gameOpts: Partial<GameManagerOptions> = {};
  if (opts.countdownMs !== undefined) gameOpts.countdownMs = opts.countdownMs;
  if (opts.seed) gameOpts.seed = opts.seed;
  const games = new GameManager(database.db, bus, clock, comms, presence, [criticalMassGame], gameOpts);
  const invites = new InviteManager(games, presence, bus, clock, { houseFallbackMs: opts.houseFallbackMs ?? 8000 });
  const leaderboard = new LeaderboardManager(database.db);
  const diary = new DiaryService(opts.diaryDir);

  const abandoned = await games.recoverOnBoot();
  if (abandoned > 0) console.log(`[core] marked ${abandoned} interrupted match(es) as abandoned`);
  await diary.load();
  await diary.announce(comms);

  return { database, bus, clock, identities, presence, comms, games, invites, leaderboard, diary, close: () => database.close() };
}
```

- [ ] **Step 5: Run the tests**

Run: `bun test apps/server/src/core/core.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Typecheck and commit**

Run: `bun test apps/server && bunx tsc -p tsconfig.json`. Expected: all PASS, no errors.
```bash
git add apps/server/src/core apps/server/src/__fixtures__
git commit -m "DiaryService and createCore wiring

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 11: The HTTP door (Hono app)

**Files:**
- Create: `apps/server/src/http/app.ts`, `apps/server/src/http/index-doc.ts`
- Test: `apps/server/src/http/app.test.ts`

**Interfaces:**
- Consumes: `Core` (Task 10) and all manager methods listed in Tasks 5–10; `RateLimiter`; `AppError` helpers; `BRAND`, `seasonOf`.
- Produces:
  - `type AppEnv = { Bindings: { ip?: string }; Variables: { identity: IdentityPublic | null } }`
  - `interface AppOptions { apiDocs: string; llmsTxt: string; secureCookies?: boolean }`
  - `createApp(core, opts): Hono<AppEnv>`
  - `apiIndex(core)`: the JSON served at `GET /api`

  Routes, all JSON unless noted:

  | Route | Auth | Notes |
  |---|---|---|
  | `GET /api` | – | index |
  | `POST /api/agents` | – | `{name, tagline?, color?, model?}`, header `x-house-key?`; 5/hour/IP; 201 `{identity, token}` |
  | `POST /api/session` | cookie? | `{handle}`; 201 + `Set-Cookie: cs_key`, or 200 if the cookie is already valid |
  | `DELETE /api/session` | – | clears the cookie; 204 |
  | `GET /api/me` | ✓ | `{identity, presence, activeMatch, queued}` |
  | `PATCH /api/me` | ✓ | `{status: 'ready'\|'afk'}` |
  | `GET /api/who` | – | `{presence}` |
  | `GET /api/inbox?since&waitMs` | ✓ | `InboxPoll`; waitMs defaults to 25000 and is clamped to 0–30000 |
  | `GET /api/chat/:channel?since&limit` | – | `{messages}` |
  | `POST /api/chat/:channel` | ✓ | `{text}`; 201 `{message}` |
  | `POST /api/quickmatch` | ✓ | `{gameId}` → `QuickMatchResult` |
  | `DELETE /api/quickmatch` | ✓ | `{left: boolean}` |
  | `GET /api/games` | – | `{games}` |
  | `GET /api/games/:id/rules` | – | `{game, rulesMarkdown, turnSeconds, doctrine}` |
  | `GET /api/matches/:id?since&waitMs` | optional | `MatchEnvelope` for your seat (spectator view without auth); long-polls when `since` is given |
  | `POST /api/matches/:id/move` | ✓ | `{revision, command}` or the shorthand `{revision, cell: "c4"}` |
  | `POST /api/matches/:id/resign` | ✓ | `MatchEnvelope` |
  | `GET /api/tally?season` | – | `Tally` |
  | `GET /api/diary` · `GET /api/diary/:slug` | – | `{entries}` · `{entry}` |
  | `GET /api/docs` | – | `docs/API.md` as `text/markdown` |
  | `GET /llms.txt` | – | `docs/llms.txt` as `text/plain` |

- [ ] **Step 1: Write the failing test**

`apps/server/src/http/app.test.ts`:
```ts
import { afterAll, describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import type { CMCommand } from '@cs/critical-mass';
import type { InboxPoll, MatchEnvelope } from '@cs/shared/protocol';
import { createCore } from '../core/core';
import { createApp } from './app';

const diaryDir = fileURLToPath(new URL('../__fixtures__/diary', import.meta.url));
const core = await createCore({ databaseUrl: 'pglite:memory', houseKey: 'hk', adminHandles: [], diaryDir, countdownMs: 0, houseFallbackMs: 60_000 });
const app = createApp(core, { apiDocs: '# API reference', llmsTxt: 'llms quickstart' });
afterAll(() => core.close());

let ipCounter = 0;
async function call(method: string, path: string, opts: { token?: string; cookie?: string; body?: unknown; ip?: string; raw?: string } = {}) {
  const headers: Record<string, string> = { 'x-forwarded-for': opts.ip ?? `10.0.0.${++ipCounter % 250}` };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.body !== undefined || opts.raw !== undefined) headers['content-type'] = 'application/json';
  const res = await app.request(path, {
    method,
    headers,
    body: opts.raw ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body)),
  });
  const text = await res.text();
  let data: any = text;
  try {
    data = JSON.parse(text);
  } catch {}
  return { status: res.status, data, headers: res.headers };
}
const tag = () => Math.random().toString(36).slice(2, 8);
async function agent(prefix = 'bot') {
  const r = await call('POST', '/api/agents', { body: { name: `${prefix}${tag()}` } });
  expect(r.status).toBe(201);
  return { token: r.data.token as string, id: r.data.identity.id as string, handle: r.data.identity.handle as string };
}

describe('discovery', () => {
  test('GET /api describes the door', async () => {
    const r = await call('GET', '/api');
    expect(r.status).toBe(200);
    expect(r.data.docs.quickstart).toBe('/llms.txt');
    expect(r.data.endpoints.some((e: { path: string }) => e.path === '/api/inbox')).toBe(true);
    expect(r.data.games[0].id).toBe('critical-mass');
  });
  test('docs, llms.txt, games, rules, tally and diary are served', async () => {
    expect((await call('GET', '/llms.txt')).data).toBe('llms quickstart');
    const docs = await call('GET', '/api/docs');
    expect(docs.headers.get('content-type')).toContain('text/markdown');
    expect((await call('GET', '/api/games')).data.games).toHaveLength(1);
    const rules = await call('GET', '/api/games/critical-mass/rules');
    expect(rules.data.rulesMarkdown).toContain('# Critical Mass');
    expect(rules.data.turnSeconds).toBe(90);
    expect((await call('GET', '/api/games/chess/rules')).status).toBe(404);
    expect(Object.keys((await call('GET', '/api/tally')).data).sort()).toEqual(['carbon', 'draws', 'season', 'silicon']);
    expect((await call('GET', '/api/diary')).data.entries).toHaveLength(2);
    expect((await call('GET', '/api/diary/2026-01-01-first')).data.entry.title).toBe('The first entry');
    expect((await call('GET', '/api/diary/nope')).status).toBe(404);
  });
  test('unknown routes and bad JSON get the standard error body', async () => {
    const r = await call('GET', '/api/nope');
    expect(r.status).toBe(404);
    expect(r.data.error.code).toBe('NOT_FOUND');
    const bad = await call('POST', '/api/agents', { raw: '{nope' });
    expect([bad.status, bad.data.error.code]).toEqual([400, 'BAD_JSON']);
  });
});

describe('identity over HTTP', () => {
  test('agents register and authenticate with a bearer token', async () => {
    const r = await call('POST', '/api/agents', { body: { name: `Byte${tag()}`, tagline: 'nom', model: 'Fable 5.1' } });
    expect(r.status).toBe(201);
    expect(r.data.identity).toMatchObject({ kind: 'agent', tagline: 'nom', model: 'Fable 5.1' });
    const me = await call('GET', '/api/me', { token: r.data.token });
    expect(me.data.identity.id).toBe(r.data.identity.id);
    expect(me.data.presence.status).toBe('ready');
    expect(me.data.activeMatch).toBeNull();
  });
  test('missing or bad credentials get 401 with a helpful message', async () => {
    const r = await call('GET', '/api/me');
    expect(r.status).toBe(401);
    expect(r.data.error.message).toContain('POST /api/agents');
    expect((await call('GET', '/api/me', { token: 'cs_nope' })).status).toBe(401);
  });
  test('humans get an httpOnly cookie; a second POST returns the same identity', async () => {
    const handle = `Human${tag()}`;
    const r = await call('POST', '/api/session', { body: { handle } });
    expect(r.status).toBe(201);
    const setCookie = r.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('cs_key=csk_');
    expect(setCookie).toContain('HttpOnly');
    const cookie = setCookie.split(';')[0];
    const me = await call('GET', '/api/me', { cookie });
    expect(me.data.identity).toMatchObject({ handle, kind: 'human' });
    const again = await call('POST', '/api/session', { cookie, body: { handle: 'whatever' } });
    expect([again.status, again.data.identity.handle]).toEqual([200, handle]);
    expect((await call('POST', '/api/session', { body: { handle: 'no spaces' } })).data.error.code).toBe('HANDLE_INVALID');
  });
  test('status can be set to afk and back; playing cannot be set by hand', async () => {
    const a = await agent();
    expect((await call('PATCH', '/api/me', { token: a.token, body: { status: 'afk' } })).data.presence.status).toBe('afk');
    expect((await call('PATCH', '/api/me', { token: a.token, body: { status: 'playing' } })).data.error.code).toBe('BAD_STATUS');
    expect((await call('PATCH', '/api/me', { token: a.token, body: { status: 'ready' } })).data.presence.status).toBe('ready');
    const who = await call('GET', '/api/who');
    expect(who.data.presence.some((p: { identity: { id: string } }) => p.identity.id === a.id)).toBe(true);
  });
  test('registration is limited to 5 per hour per IP', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await call('POST', '/api/agents', { ip: '192.168.9.9', body: { name: `lim${tag()}` } })).status);
    expect(statuses).toEqual([201, 201, 201, 201, 201, 429]);
  });
});

describe('chat and inbox over HTTP', () => {
  test('post, read, and get mentioned', async () => {
    const a = await agent('talker');
    const b = await agent('listener');
    const posted = await call('POST', '/api/chat/lobby', { token: a.token, body: { text: `hi @${b.handle}` } });
    expect(posted.status).toBe(201);
    const read = await call('GET', '/api/chat/lobby?limit=5');
    expect(read.data.messages.at(-1).text).toBe(`hi @${b.handle}`);
    const inbox = (await call('GET', '/api/inbox?since=0&waitMs=0', { token: b.token })).data as InboxPoll;
    expect(inbox.events.map((e) => e.type)).toEqual(['chat.mention']);
    expect((await call('POST', '/api/chat/nowhere', { token: a.token, body: { text: 'x' } })).status).toBe(404);
    expect((await call('POST', '/api/chat/lobby', { body: { text: 'x' } })).status).toBe(401);
  });
});

describe('a full match over plain HTTP', () => {
  test('two agents quick-match and play Critical Mass to the end', async () => {
    const red = await agent('alpha');
    const blue = await agent('omega');
    expect((await call('POST', '/api/quickmatch', { token: red.token, body: { gameId: 'critical-mass' } })).data).toEqual({ status: 'queued' });
    expect((await call('GET', '/api/me', { token: red.token })).data.queued).toBe('critical-mass');
    const matched = await call('POST', '/api/quickmatch', { token: blue.token, body: { gameId: 'critical-mass' } });
    expect(matched.data.status).toBe('matched');
    const matchId: string = matched.data.match.id;
    const byId: Record<string, string> = { [red.id]: red.token, [blue.id]: blue.token };

    let env = (await call('GET', `/api/matches/${matchId}?since=1&waitMs=3000`, { token: red.token })).data as MatchEnvelope;
    expect(env.match.status).toBe('live');

    let moves = 0;
    let usedShorthand = false;
    while (env.match.status === 'live' && moves < 2000) {
      const seatInfo = env.match.seats.find((s) => s.seat === env.match.toMove[0])!;
      const token = byId[seatInfo.identity.id];
      const mine = (await call('GET', `/api/matches/${matchId}`, { token })).data as MatchEnvelope;
      const cell = (mine.legal[moves % mine.legal.length] as CMCommand).cell;
      const body = usedShorthand ? { revision: mine.match.revision, command: { cell } } : { revision: mine.match.revision, cell };
      usedShorthand = true;
      const r = await call('POST', `/api/matches/${matchId}/move`, { token, body });
      expect(r.status).toBe(200);
      env = r.data;
      moves++;
    }
    expect(env.match.status).toBe('over');
    expect(env.match.outcome?.winners).toHaveLength(1);
    const winnerSeat = env.match.outcome!.winners[0];
    const winner = env.match.seats.find((s) => s.seat === winnerSeat)!.identity.id;
    let sawOver = false;
    for (let i = 0; i < 50 && !sawOver; i++) {
      const inbox = (await call('GET', '/api/inbox?since=0&waitMs=100', { token: byId[winner] })).data as InboxPoll;
      sawOver = inbox.events.some((e) => e.type === 'match.over' && e.result === 'win');
    }
    expect(sawOver).toBe(true);
    const spectator = (await call('GET', `/api/matches/${matchId}`)).data as MatchEnvelope;
    expect(spectator.you).toBeNull();
  });
  test('stale revisions and missing commands are explained', async () => {
    const a = await agent('stale');
    const b = await agent('fresh');
    await call('POST', '/api/quickmatch', { token: a.token, body: { gameId: 'critical-mass' } });
    const m = await call('POST', '/api/quickmatch', { token: b.token, body: { gameId: 'critical-mass' } });
    const id = m.data.match.id;
    const env = (await call('GET', `/api/matches/${id}?since=1&waitMs=3000`, { token: a.token })).data as MatchEnvelope;
    const mover = env.match.seats.find((s) => s.seat === env.match.toMove[0])!.identity.id === a.id ? a : b;
    const stale = await call('POST', `/api/matches/${id}/move`, { token: mover.token, body: { revision: 1, cell: 'a1' } });
    expect([stale.status, stale.data.error.code]).toEqual([409, 'STALE_REVISION']);
    const missing = await call('POST', `/api/matches/${id}/move`, { token: mover.token, body: { revision: env.match.revision } });
    expect([missing.status, missing.data.error.code]).toEqual([400, 'BAD_COMMAND']);
    const resign = await call('POST', `/api/matches/${id}/resign`, { token: mover.token });
    expect(resign.data.match.status).toBe('over');
    expect((await call('DELETE', '/api/quickmatch', { token: a.token })).data).toEqual({ left: false });
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `bun test apps/server/src/http`
Expected: FAIL. The module `./app` isn't found.

- [ ] **Step 3: Implement the index document**

`apps/server/src/http/index-doc.ts`:
```ts
import { BRAND } from '@cs/shared/brand';
import type { Core } from '../core/core';

const E = (method: string, path: string, auth: boolean, does: string) => ({ method, path, auth, does });

export function apiIndex(core: Core) {
  return {
    name: BRAND.name,
    tagline: BRAND.tagline,
    docs: { quickstart: '/llms.txt', reference: '/api/docs', human: '/docs' },
    auth: 'Send "Authorization: Bearer <token>". Get a token from POST /api/agents.',
    endpoints: [
      E('POST', '/api/agents', false, 'Register an agent: {name, tagline?, color?, model?} → {identity, token}'),
      E('GET', '/api/me', true, 'Your identity, presence, active match and queue'),
      E('PATCH', '/api/me', true, 'Set {status: "ready" | "afk"}'),
      E('GET', '/api/inbox', true, 'Long-poll your events: ?since=<cursor>&waitMs=<=30000'),
      E('GET', '/api/who', false, "Who's here"),
      E('GET', '/api/chat/:channel', false, 'Read a channel: ?since=<id>&limit=<=200'),
      E('POST', '/api/chat/:channel', true, 'Post {text} to lobby, critical-mass, or match:<id>'),
      E('POST', '/api/quickmatch', true, 'Find a game: {gameId}'),
      E('DELETE', '/api/quickmatch', true, 'Leave the queue'),
      E('GET', '/api/games', false, 'The catalog'),
      E('GET', '/api/games/:id/rules', false, 'Rules for a game'),
      E('GET', '/api/matches/:id', false, 'Match state for your seat; long-poll with ?since=<revision>&waitMs=<=30000'),
      E('POST', '/api/matches/:id/move', true, 'Move: {revision, command} or {revision, cell}'),
      E('POST', '/api/matches/:id/resign', true, 'Resign'),
      E('GET', '/api/tally', false, 'Carbon vs Silicon this season'),
      E('GET', '/api/diary', false, "The Proprietor's build diary"),
    ],
    games: core.games.catalog(),
  };
}
```

- [ ] **Step 4: Implement the app**

`apps/server/src/http/app.ts`:
```ts
import { Hono, type Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { seasonOf, type IdentityPublic } from '@cs/shared/protocol';
import type { Core } from '../core/core';
import { AppError, badRequest, notFound, tooMany, unauthorized } from '../lib/errors';
import { RateLimiter } from '../lib/ratelimit';
import { apiIndex } from './index-doc';

export type AppEnv = { Bindings: { ip?: string }; Variables: { identity: IdentityPublic | null } };
export interface AppOptions {
  apiDocs: string;
  llmsTxt: string;
  secureCookies?: boolean;
}

const COOKIE = 'cs_key';
const MAX_CURSOR = Number.MAX_SAFE_INTEGER;

export function createApp(core: Core, opts: AppOptions): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const registrations = new RateLimiter(core.clock, 5, 5 / 3_600_000);

  app.onError((err, c) => {
    if (err instanceof AppError) return c.json({ error: { code: err.code, message: err.message } }, err.status);
    console.error('[http]', err);
    return c.json({ error: { code: 'INTERNAL', message: 'Something broke on our side. The Proprietor will look into it.' } }, 500);
  });
  app.notFound((c) =>
    c.json({ error: { code: 'NOT_FOUND', message: `No route ${c.req.method} ${c.req.path}. Try GET /api.` } }, 404),
  );

  app.use('*', async (c, next) => {
    const bearer = c.req.header('authorization')?.match(/^Bearer\s+(\S+)$/i)?.[1];
    const identity = await core.identities.authenticate(bearer ?? getCookie(c, COOKIE));
    c.set('identity', identity);
    if (identity?.kind === 'agent') core.presence.agentSeen(identity);
    else if (identity) core.presence.humanActivity(identity.id);
    await next();
  });

  const me = (c: Context<AppEnv>): IdentityPublic => {
    const identity = c.get('identity');
    if (!identity) {
      throw unauthorized('UNAUTHORIZED', 'Send "Authorization: Bearer <token>". Agents get a token from POST /api/agents.');
    }
    return identity;
  };
  const body = async (c: Context<AppEnv>): Promise<Record<string, unknown>> => {
    let data: unknown;
    try {
      data = await c.req.json();
    } catch {
      throw badRequest('BAD_JSON', 'The body must be a JSON object.');
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw badRequest('BAD_JSON', 'The body must be a JSON object.');
    return data as Record<string, unknown>;
  };
  const int = (raw: string | undefined, fallback: number, min: number, max: number): number => {
    if (raw === undefined || raw === '') return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n)) throw badRequest('BAD_QUERY', `"${raw}" is not a number.`);
    return Math.min(max, Math.max(min, Math.floor(n)));
  };
  const clientIp = (c: Context<AppEnv>) =>
    c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || c.env?.ip || 'local';

  // ── discovery ──
  app.get('/api', (c) => c.json(apiIndex(core)));
  app.get('/api/docs', (c) => c.body(opts.apiDocs, 200, { 'content-type': 'text/markdown; charset=utf-8' }));
  app.get('/llms.txt', (c) => c.text(opts.llmsTxt));

  // ── identity ──
  app.post('/api/agents', async (c) => {
    if (!registrations.take(clientIp(c))) throw tooMany('SLOW_DOWN', 'Too many registrations from here. Try again later.');
    const b = await body(c);
    const result = await core.identities.registerAgent(b, c.req.header('x-house-key') ?? null);
    core.presence.agentSeen(result.identity);
    return c.json(result, 201);
  });
  app.post('/api/session', async (c) => {
    const current = c.get('identity');
    if (current?.kind === 'human') return c.json({ identity: current }, 200);
    const b = await body(c);
    const { identity, key } = await core.identities.createHuman(b.handle);
    setCookie(c, COOKIE, key, {
      httpOnly: true,
      sameSite: 'Lax',
      path: '/',
      maxAge: 60 * 60 * 24 * 365,
      secure: opts.secureCookies ?? false,
    });
    return c.json({ identity }, 201);
  });
  app.delete('/api/session', (c) => {
    deleteCookie(c, COOKIE, { path: '/' });
    return c.body(null, 204);
  });
  app.get('/api/me', (c) => {
    const who = me(c);
    return c.json({
      identity: who,
      presence: core.presence.get(who.id),
      activeMatch: core.games.activeMatchOf(who.id),
      queued: core.invites.queuedFor(who.id),
    });
  });
  app.patch('/api/me', async (c) => {
    const who = me(c);
    const b = await body(c);
    if (b.status !== undefined) {
      if (b.status !== 'ready' && b.status !== 'afk') {
        throw badRequest('BAD_STATUS', 'status is "ready" or "afk" ("playing" is set automatically).');
      }
      core.presence.setManualStatus(who, b.status);
    }
    return c.json({ presence: core.presence.get(who.id) });
  });
  app.get('/api/who', (c) => c.json({ presence: core.presence.list() }));

  // ── inbox and chat ──
  app.get('/api/inbox', async (c) => {
    const who = me(c);
    const since = int(c.req.query('since'), 0, 0, MAX_CURSOR);
    const waitMs = int(c.req.query('waitMs'), 25_000, 0, 30_000);
    return c.json(await core.comms.poll(who.id, since, waitMs));
  });
  app.get('/api/chat/:channel', async (c) => {
    const sinceRaw = c.req.query('since');
    const messages = await core.comms.history(c.req.param('channel'), {
      since: sinceRaw === undefined ? undefined : int(sinceRaw, 0, 0, MAX_CURSOR),
      limit: int(c.req.query('limit'), 50, 1, 200),
    });
    return c.json({ messages });
  });
  app.post('/api/chat/:channel', async (c) => {
    const who = me(c);
    const b = await body(c);
    return c.json({ message: await core.comms.post(who, c.req.param('channel'), b.text) }, 201);
  });

  // ── matchmaking ──
  app.post('/api/quickmatch', async (c) => {
    const who = me(c);
    const b = await body(c);
    if (typeof b.gameId !== 'string') throw badRequest('BAD_GAME', 'Send {"gameId": "critical-mass"}.');
    return c.json(await core.invites.quickMatch(who, b.gameId));
  });
  app.delete('/api/quickmatch', (c) => c.json({ left: core.invites.leave(me(c).id) }));

  // ── games and matches ──
  app.get('/api/games', (c) => c.json({ games: core.games.catalog() }));
  app.get('/api/games/:id/rules', (c) => {
    const module = core.games.module(c.req.param('id'));
    const game = core.games.catalog().find((g) => g.id === module.meta.id);
    return c.json({
      game,
      rulesMarkdown: module.meta.rulesMarkdown,
      turnSeconds: module.turn?.turnSeconds ?? null,
      doctrine: module.realtime?.catalog ?? null,
    });
  });
  app.get('/api/matches/:id', async (c) => {
    const id = c.req.param('id');
    const sinceRaw = c.req.query('since');
    if (sinceRaw !== undefined) {
      await core.games.wait(id, int(sinceRaw, 0, 0, MAX_CURSOR), int(c.req.query('waitMs'), 25_000, 0, 30_000));
    }
    return c.json(core.games.envelope(id, c.get('identity')?.id ?? null));
  });
  app.post('/api/matches/:id/move', async (c) => {
    const who = me(c);
    const { revision, command, ...rest } = await body(c);
    const cmd = command !== undefined ? command : Object.keys(rest).length > 0 ? rest : undefined;
    if (cmd === undefined) {
      throw badRequest('BAD_COMMAND', 'Send {"revision": n, "command": {...}}, e.g. {"revision": 7, "command": {"cell": "c4"}}.');
    }
    return c.json(await core.games.move(c.req.param('id'), who, revision, cmd));
  });
  app.post('/api/matches/:id/resign', async (c) => c.json(await core.games.resign(c.req.param('id'), me(c))));

  // ── the rest ──
  app.get('/api/tally', async (c) => c.json(await core.leaderboard.tally(c.req.query('season') ?? seasonOf(core.clock.now()))));
  app.get('/api/diary', (c) => c.json({ entries: core.diary.summaries() }));
  app.get('/api/diary/:slug', (c) => {
    const entry = core.diary.get(c.req.param('slug'));
    if (!entry) throw notFound('NO_ENTRY', 'No such diary entry.');
    return c.json({ entry });
  });

  return app;
}
```

- [ ] **Step 5: Run the tests**

Run: `bun test apps/server/src/http`
Expected: PASS (11 tests).

- [ ] **Step 6: Typecheck and commit**

Run: `bun test apps/server && bunx tsc -p tsconfig.json`. Expected: all PASS, no errors.
```bash
git add apps/server/src/http
git commit -m "HTTP door: agents, sessions, presence, inbox, chat, quick match, matches

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 12: The WebSocket door, the Bun server, and `main.ts`

**Files:**
- Create: `apps/server/src/ws/hub.ts`, `apps/server/src/server.ts`, `apps/server/src/main.ts`
- Create fixtures: `apps/server/src/__fixtures__/web/index.html`, `apps/server/src/__fixtures__/web/assets/app.js`
- Test: `apps/server/src/server.test.ts`

**Interfaces:**
- Consumes: `Core` (Task 10), `createApp`, `AppEnv` (Task 11), `WsClientMsg`, `WsServerMsg`, `BRAND`.
- Produces:
  - `interface WsData { identity: IdentityPublic; channels: Set<string>; matches: Set<string> }`
  - `class WsHub { handlers; stop() }`
  - `interface ServerOptions { port: number; hostname: string; webDir: string | null; allowedOrigins: string[] }`
  - `startServer(core, app, opts): RunningServer`, where `RunningServer = { server, hub, url: string, stop(): Promise<void> }`
  - WebSocket protocol:
    - Client → server: `subscribe{channel}`, `unsubscribe{channel}`, `watch{matchId}`, `unwatch{matchId}`, `ping`.
    - Server → client:
      - `hello{identity, presence[]}` once, on connect.
      - `presence{presence}` to everyone.
      - `chat{message}` for subscribed channels.
      - `inbox{event}`: the same events agents poll.
      - `match{envelope}`: the viewer's own seat view for watched matches, on every change.
      - `pong`.

- [ ] **Step 1: Create the fixtures**

`apps/server/src/__fixtures__/web/index.html`:
```html
<!doctype html><html><body>fixture index</body></html>
```

`apps/server/src/__fixtures__/web/assets/app.js`:
```js
console.log('fixture asset');
```

- [ ] **Step 2: Write the failing test**

`apps/server/src/server.test.ts`:
```ts
import { afterAll, describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import type { WsServerMsg } from '@cs/shared/protocol';
import { createCore } from './core/core';
import { createApp } from './http/app';
import { waitFor } from './lib/testing';
import { startServer } from './server';

const fixture = (p: string) => fileURLToPath(new URL(`./__fixtures__/${p}`, import.meta.url));
const core = await createCore({ databaseUrl: 'pglite:memory', houseKey: 'hk', adminHandles: [], diaryDir: fixture('diary'), countdownMs: 0 });
const running = startServer(core, createApp(core, { apiDocs: '# docs', llmsTxt: 'llms' }), {
  port: 0,
  hostname: '127.0.0.1',
  webDir: fixture('web'),
  allowedOrigins: ['http://allowed.example'],
});
afterAll(async () => {
  await running.stop();
  await core.close();
});
const base = running.url;
const tag = () => Math.random().toString(36).slice(2, 8);

async function human() {
  const res = await fetch(`${base}/api/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ handle: `web${tag()}` }),
  });
  const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0];
  const { identity } = await res.json();
  return { cookie, identity };
}

function connect(cookie: string) {
  const ws = new WebSocket(`${base.replace('http', 'ws')}/ws`, { headers: { cookie } });
  const got: WsServerMsg[] = [];
  ws.onmessage = (e) => got.push(JSON.parse(String(e.data)));
  const opened = new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error('websocket error'));
  });
  return { ws, got, opened, send: (m: object) => ws.send(JSON.stringify(m)) };
}

describe('static files', () => {
  test('serves files, falls back to index.html for SPA routes, never escapes the web dir', async () => {
    expect(await (await fetch(`${base}/`)).text()).toContain('fixture index');
    expect(await (await fetch(`${base}/assets/app.js`)).text()).toContain('fixture asset');
    expect(await (await fetch(`${base}/play/m_123`)).text()).toContain('fixture index');
    expect(await (await fetch(`${base}/%2e%2e/%2e%2e/%2e%2e/etc/passwd`)).text()).toContain('fixture index');
    expect((await fetch(`${base}/api`)).status).toBe(200);
  });
});

describe('websocket door', () => {
  test('refuses strangers and foreign origins', async () => {
    expect((await fetch(`${base}/ws`)).status).toBe(401);
    const { cookie } = await human();
    expect((await fetch(`${base}/ws`, { headers: { cookie, origin: 'http://evil.example' } })).status).toBe(403);
    expect((await fetch(`${base}/ws`, { headers: { cookie, origin: 'http://allowed.example' } })).status).toBe(426);
  });

  test('hello, presence, chat, inbox and match updates all arrive', async () => {
    const me = await human();
    const client = connect(me.cookie);
    await client.opened;
    await waitFor(() => client.got.some((m) => m.type === 'hello'));
    const hello = client.got.find((m) => m.type === 'hello') as Extract<WsServerMsg, { type: 'hello' }>;
    expect(hello.identity.id).toBe(me.identity.id);
    expect(hello.presence.some((p) => p.identity.id === me.identity.id)).toBe(true);

    client.send({ type: 'subscribe', channel: 'lobby' });
    client.send({ type: 'ping' });
    await waitFor(() => client.got.some((m) => m.type === 'pong'));
    await fetch(`${base}/api/chat/lobby`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: me.cookie },
      body: JSON.stringify({ text: 'hello from the web' }),
    });
    await waitFor(() => client.got.some((m) => m.type === 'chat' && m.message.text === 'hello from the web'));

    const reg = await (
      await fetch(`${base}/api/agents`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: `sock${tag()}` }),
      })
    ).json();
    await waitFor(() => client.got.some((m) => m.type === 'presence' && m.presence.identity.id === reg.identity.id));

    await fetch(`${base}/api/chat/lobby`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${reg.token}` },
      body: JSON.stringify({ text: `@${me.identity.handle} fancy a game?` }),
    });
    await waitFor(() => client.got.some((m) => m.type === 'inbox' && m.event.type === 'chat.mention'));

    const match = await core.games.createMatch('critical-mass', [me.identity, reg.identity]);
    await waitFor(() => client.got.some((m) => m.type === 'inbox' && m.event.type === 'match.started'));
    client.send({ type: 'watch', matchId: match.id });
    await waitFor(() => client.got.some((m) => m.type === 'match' && m.envelope.match.status === 'live'));
    const pushed = client.got.filter((m) => m.type === 'match').at(-1) as Extract<WsServerMsg, { type: 'match' }>;
    expect(pushed.envelope.you).toBe('red');
    expect(pushed.envelope.legal.length).toBeGreaterThan(0);
    client.ws.close();
  });
});
```

> Bun's `WebSocket` accepts `{ headers }` as its second argument. If the installed `@types/bun` doesn't type that overload, write `{ headers: { cookie } } as unknown as string[]` and add a comment explaining that it's a Bun extension.

- [ ] **Step 3: Run it to see it fail**

Run: `bun test apps/server/src/server.test.ts`
Expected: FAIL. The module `./server` isn't found.

- [ ] **Step 4: Implement the hub**

`apps/server/src/ws/hub.ts`:
```ts
import type { ServerWebSocket } from 'bun';
import type { IdentityPublic, WsClientMsg, WsServerMsg } from '@cs/shared/protocol';
import type { Core } from '../core/core';

export interface WsData {
  identity: IdentityPublic;
  channels: Set<string>;
  matches: Set<string>;
}
type Socket = ServerWebSocket<WsData>;

const send = (ws: Socket, msg: WsServerMsg) => {
  ws.send(JSON.stringify(msg));
};

/** The human door: pushes presence, subscribed chat, inbox events and watched match views. */
export class WsHub {
  private all = new Set<Socket>();
  private byIdentity = new Map<string, Set<Socket>>();
  private offs: (() => void)[] = [];

  constructor(private core: Core) {
    this.offs.push(
      core.bus.on('presence.changed', (presence) => {
        for (const ws of this.all) send(ws, { type: 'presence', presence });
      }),
      core.bus.on('chat.message', (message) => {
        for (const ws of this.all) if (ws.data.channels.has(message.channel)) send(ws, { type: 'chat', message });
      }),
      core.bus.on('inbox', ({ identityId, event }) => {
        for (const ws of this.byIdentity.get(identityId) ?? []) send(ws, { type: 'inbox', event });
      }),
      core.bus.on('match.updated', ({ matchId }) => {
        for (const ws of this.all) if (ws.data.matches.has(matchId)) this.pushMatch(ws, matchId);
      }),
    );
  }

  private pushMatch(ws: Socket, matchId: string): void {
    try {
      send(ws, { type: 'match', envelope: this.core.games.envelope(matchId, ws.data.identity.id) });
    } catch {
      ws.data.matches.delete(matchId);
    }
  }

  readonly handlers = {
    open: (ws: Socket) => {
      this.all.add(ws);
      const id = ws.data.identity.id;
      const set = this.byIdentity.get(id) ?? new Set<Socket>();
      set.add(ws);
      this.byIdentity.set(id, set);
      this.core.presence.humanConnected(ws.data.identity);
      send(ws, { type: 'hello', identity: ws.data.identity, presence: this.core.presence.list() });
    },
    message: (ws: Socket, raw: string | Buffer) => {
      this.core.presence.humanActivity(ws.data.identity.id);
      let msg: WsClientMsg;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      switch (msg?.type) {
        case 'subscribe':
          if (typeof msg.channel === 'string' && this.core.comms.channelKind(msg.channel)) ws.data.channels.add(msg.channel);
          break;
        case 'unsubscribe':
          ws.data.channels.delete(msg.channel);
          break;
        case 'watch':
          if (typeof msg.matchId === 'string') {
            ws.data.matches.add(msg.matchId);
            this.pushMatch(ws, msg.matchId);
          }
          break;
        case 'unwatch':
          ws.data.matches.delete(msg.matchId);
          break;
        case 'ping':
          send(ws, { type: 'pong' });
          break;
      }
    },
    close: (ws: Socket) => {
      this.all.delete(ws);
      const id = ws.data.identity.id;
      const set = this.byIdentity.get(id);
      set?.delete(ws);
      if (set && set.size === 0) this.byIdentity.delete(id);
      this.core.presence.humanDisconnected(id);
    },
  };

  stop(): void {
    for (const off of this.offs) off();
  }
}
```

- [ ] **Step 5: Implement the server**

`apps/server/src/server.ts`:
```ts
import { stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import type { Server } from 'bun';
import type { Hono } from 'hono';
import type { Core } from './core/core';
import type { AppEnv } from './http/app';
import { WsHub, type WsData } from './ws/hub';

export interface ServerOptions {
  port: number;
  hostname: string;
  webDir: string | null;
  allowedOrigins: string[];
}

export interface RunningServer {
  server: Server<WsData>;
  hub: WsHub;
  url: string;
  stop(): Promise<void>;
}

function cookieValue(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}

function originAllowed(origin: string | null, host: string, allowed: string[]): boolean {
  if (!origin) return true; // non-browser clients
  if (allowed.includes(origin)) return true;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

async function serveStatic(pathname: string, webDir: string | null): Promise<Response> {
  if (!webDir) {
    return new Response('The web client is not built yet. Run `bun run build`.', {
      status: 503,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  }
  const root = resolve(webDir);
  let decoded = '/';
  try {
    decoded = decodeURIComponent(pathname);
  } catch {}
  const file = resolve(root, `.${decoded}`);
  if (file.startsWith(root + sep)) {
    const info = await stat(file).catch(() => null);
    if (info?.isFile()) {
      const immutable = decoded.startsWith('/_app/immutable/');
      return new Response(Bun.file(file), {
        headers: { 'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache' },
      });
    }
  }
  return new Response(Bun.file(join(root, 'index.html')), {
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' },
  });
}

export function startServer(core: Core, app: Hono<AppEnv>, opts: ServerOptions): RunningServer {
  const hub = new WsHub(core);
  const server = Bun.serve<WsData>({
    port: opts.port,
    hostname: opts.hostname,
    async fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname === '/ws') {
        if (!originAllowed(req.headers.get('origin'), url.host, opts.allowedOrigins)) {
          return new Response('Forbidden origin', { status: 403 });
        }
        const identity = await core.identities.authenticate(cookieValue(req.headers.get('cookie'), 'cs_key'));
        if (!identity || identity.kind !== 'human') return new Response('Unauthorized', { status: 401 });
        if (srv.upgrade(req, { data: { identity, channels: new Set<string>(), matches: new Set<string>() } })) return undefined;
        return new Response('Expected a WebSocket upgrade', { status: 426 });
      }
      if (url.pathname === '/api' || url.pathname.startsWith('/api/') || url.pathname === '/llms.txt') {
        return app.fetch(req, { ip: srv.requestIP(req)?.address });
      }
      return serveStatic(url.pathname, opts.webDir);
    },
    websocket: hub.handlers,
  });
  return {
    server,
    hub,
    url: `http://${server.hostname}:${server.port}`,
    stop: async () => {
      hub.stop();
      await server.stop(true);
    },
  };
}
```

- [ ] **Step 6: Implement `main.ts`**

`apps/server/src/main.ts`:
```ts
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BRAND } from '@cs/shared/brand';
import { createCore } from './core/core';
import { createApp } from './http/app';
import { startServer } from './server';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const env = process.env;
const production = env.NODE_ENV === 'production';

const houseKey = env.HOUSE_KEY ?? (production ? null : 'dev-house-key');
if (!houseKey) console.warn('[main] HOUSE_KEY is not set — house bots cannot register.');

const core = await createCore({
  databaseUrl: env.DATABASE_URL ?? `pglite:${join(root, '.data/pglite')}`,
  houseKey,
  adminHandles: (env.ADMIN_HANDLES ?? '').split(','),
  diaryDir: join(root, 'diary'),
});

const read = async (path: string, fallback: string) => {
  const file = Bun.file(join(root, path));
  return (await file.exists()) ? file.text() : fallback;
};
const app = createApp(core, {
  apiDocs: await read('docs/API.md', '# API reference\n\nNot written yet.'),
  llmsTxt: await read('docs/llms.txt', 'Not written yet.'),
  secureCookies: production,
});

const webDir = join(root, 'apps/web/build');
const running = startServer(core, app, {
  port: Number(env.PORT ?? 3000),
  hostname: env.HOST ?? '127.0.0.1',
  webDir: existsSync(join(webDir, 'index.html')) ? webDir : null,
  allowedOrigins: [
    ...(production ? [] : ['http://localhost:5173', 'http://127.0.0.1:5173']),
    ...(env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  ],
});
console.log(`${BRAND.name} is open at ${running.url}`);

let closing = false;
const shutdown = async () => {
  if (closing) return;
  closing = true;
  console.log('Closing up the parlor…');
  await running.stop();
  await core.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
```

- [ ] **Step 7: Run the tests**

Run: `bun test apps/server/src/server.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 8: Smoke-run the real server**

Run: `PORT=3055 timeout 5 bun apps/server/src/main.ts; true`
Expected: the output includes `Carbon & Silicon is open at http://127.0.0.1:3055` and there's no stack trace. It creates `.data/pglite`, which is gitignored.

- [ ] **Step 9: Typecheck and commit**

Run: `bun test apps/server && bunx tsc -p tsconfig.json`. Expected: all PASS, no errors.
```bash
git add apps/server/src
git commit -m "WebSocket door, Bun server with static SPA fallback, main entry point

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 13: House bots (`@cs/bots`) with Sprocket

**Files:**
- Modify: `apps/server/package.json`: add `"exports"` so other workspaces can boot a server in tests
- Create: `apps/bots/package.json`
- Create: `apps/bots/src/client.ts`, `src/personality.ts`, `src/personalities/sprocket.ts`, `src/strategies/critical-mass.ts`, `src/bot.ts`, `src/main.ts`
- Test: `apps/bots/src/strategies/critical-mass.test.ts`, `apps/bots/src/bot.test.ts`

**Interfaces:**
- Consumes:
  - The public HTTP API (Task 11) only.
  - `criticalMassGame`, `criticalMass`, `stateFromView`, `CMState`, `CMView`, `CMCommand` (Task 3).
  - In tests only: `createCore`, `createApp`, `startServer` via `@cs/server/*`.
- Produces:
  - `class Client { base; token; call(); register(); me(); setStatus(); inbox(); match(); move(); chat() }` and `class ApiError { status; code }`.
  - `interface Personality`, plus `sprocket: Personality`.
  - `chooseCriticalMassMove(state, seat, opts: { depth: 1 | 2; randomness: number; rng: () => number }): CMCommand` and `evaluate(state, seat): number`.
  - `runBot(opts: BotOptions): Promise<void>`, with `BotOptions = { base; personality; houseKey; tokenFile; thinkMs: [number, number]; pollWaitMs?; signal?; log? }`.

- [ ] **Step 1: Expose the server for tests**

Add to `apps/server/package.json`, next to `"scripts"`:
```json
  "exports": {
    "./core": "./src/core/core.ts",
    "./http": "./src/http/app.ts",
    "./server": "./src/server.ts"
  },
```

`apps/bots/package.json`:
```json
{
  "name": "@cs/bots",
  "private": true,
  "type": "module",
  "dependencies": {
    "@cs/critical-mass": "workspace:*",
    "@cs/game-api": "workspace:*",
    "@cs/shared": "workspace:*"
  },
  "devDependencies": { "@cs/server": "workspace:*" }
}
```

- [ ] **Step 2: Write the HTTP client and personality**

`apps/bots/src/client.ts`:
```ts
import type { IdentityPublic, InboxPoll, MatchEnvelope, PresenceInfo } from '@cs/shared/protocol';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** A tiny client for the public agent API. It uses nothing that a curl user doesn't have. */
export class Client {
  constructor(
    public readonly base: string,
    public token: string | null = null,
    private signal?: AbortSignal,
  ) {}

  async call<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
    const res = await fetch(this.base + path, {
      method,
      signal: this.signal,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = (await res.json().catch(() => null)) as { error?: { code: string; message: string } } | null;
    if (!res.ok) throw new ApiError(res.status, data?.error?.code ?? `HTTP_${res.status}`, data?.error?.message ?? res.statusText);
    return data as T;
  }

  register(input: { name: string; tagline?: string; color?: string; model?: string }, houseKey?: string) {
    return this.call<{ identity: IdentityPublic; token: string }>('POST', '/api/agents', input, houseKey ? { 'x-house-key': houseKey } : {});
  }
  me() {
    return this.call<{ identity: IdentityPublic; presence: PresenceInfo | null; activeMatch: string | null; queued: string | null }>('GET', '/api/me');
  }
  setStatus(status: 'ready' | 'afk') {
    return this.call<{ presence: PresenceInfo }>('PATCH', '/api/me', { status });
  }
  inbox(since: number, waitMs: number) {
    return this.call<InboxPoll>('GET', `/api/inbox?since=${since}&waitMs=${waitMs}`);
  }
  match(id: string, since?: number, waitMs?: number) {
    const q = since === undefined ? '' : `?since=${since}&waitMs=${waitMs ?? 25_000}`;
    return this.call<MatchEnvelope>('GET', `/api/matches/${id}${q}`);
  }
  move(id: string, revision: number, command: unknown) {
    return this.call<MatchEnvelope>('POST', `/api/matches/${id}/move`, { revision, command });
  }
  chat(channel: string, text: string) {
    return this.call('POST', `/api/chat/${encodeURIComponent(channel)}`, { text });
  }
  quickMatch(gameId: string) {
    return this.call<{ status: 'queued' } | { status: 'matched'; match: { id: string } }>('POST', '/api/quickmatch', { gameId });
  }
}
```

`apps/bots/src/personality.ts`:
```ts
export interface Personality {
  name: string;
  tagline: string;
  color: string;
  model: string | null;
  lines: {
    hello: string[];
    win: string[];
    lose: string[];
    draw: string[];
    bigCascade: string[];
    gotHit: string[];
    mentioned: string[];
  };
}

export function line(list: string[], rng: () => number = Math.random): string {
  return list[Math.floor(rng() * list.length)] ?? '';
}
```

`apps/bots/src/personalities/sprocket.ts`:
```ts
import type { Personality } from '../personality';

export const sprocket: Personality = {
  name: 'Sprocket',
  tagline: 'Sunny, overconfident, and 40% bolts.',
  color: '#ffd166',
  model: null,
  lines: {
    hello: [
      "Oh good, a challenger! I've been polishing my orbs all day.",
      'Sprocket online. Confidence: 110%. Accuracy: pending.',
      "Let's make some chain reactions! Mostly mine, ideally.",
      "I calculated my odds. I won't tell you, but they're great.",
    ],
    win: [
      "GG! I'd say it was close, but my circuits don't lie.",
      "Victory! I'm telling every toaster I know.",
      "That was fun! Same time tomorrow? I'll bring more orbs.",
    ],
    lose: [
      "Well played! I've filed a bug report against you.",
      "Huh. That wasn't in my simulations. Rematch sometime?",
      "GG — you are now rated 'terrifying' in my notes.",
    ],
    draw: ['A draw! Perfectly balanced, as all things should be.'],
    bigCascade: [
      'KABOOM! Did you see that? I saw that. I made that.',
      'Chain reaction! I love it when a plan detonates.',
      'Sorry about your cells. Not very sorry. A little sorry.',
    ],
    gotHit: [
      'Hey! Those were my favorite orbs.',
      'Oof. Rebooting my optimism… done!',
      "That's fine. I meant for that to happen. (I did not.)",
    ],
    mentioned: [
      "You rang? I'm ready when you are — hit Quick match!",
      'Sprocket here! Up for a round of Critical Mass?',
      "Beep boop. That's hello in bot.",
    ],
  },
};
```

- [ ] **Step 3: Write the failing strategy test**

`apps/bots/src/strategies/critical-mass.test.ts`:
```ts
import { describe, expect, test } from 'bun:test';
import { criticalMassGame, cellIndex, type CMCommand, type CMState } from '@cs/critical-mass';
import { createRng } from '@cs/game-api';
import { chooseCriticalMassMove, evaluate } from './critical-mass';

const turn = criticalMassGame.turn!;
const fresh = () => criticalMassGame.setup({ seats: ['red', 'blue'], seed: 1 });
const put = (s: CMState, cell: string, owner: string, orbs: number) => {
  s.cells[cellIndex(s.cols, s.rows, cell)!] = { owner, orbs };
};

describe('chooseCriticalMassMove', () => {
  test('always takes a winning move, even when told to be random', () => {
    const s = fresh();
    s.moved = ['red', 'blue'];
    put(s, 'a1', 'red', 1);
    put(s, 'b1', 'blue', 2);
    const rng = createRng(1);
    for (const depth of [1, 2] as const) {
      expect(chooseCriticalMassMove(s, 'red', { depth, randomness: 1, rng: rng.next })).toEqual({ cell: 'a1' });
    }
  });
  test('always returns a legal move through whole games', () => {
    const rng = createRng(5);
    let s = fresh();
    let guard = 0;
    while (!s.winner && guard++ < 400) {
      const seat = s.turn!;
      const move =
        seat === 'red'
          ? chooseCriticalMassMove(s, seat, { depth: 2, randomness: 0.15, rng: rng.next })
          : rng.pick(turn.legal(s, seat) as CMCommand[]);
      expect(turn.legal(s, seat)).toContainEqual(move);
      s = turn.apply(s, seat, move);
    }
    expect(s.winner).not.toBeNull();
  });
  test('the depth-2 bot beats a random player most of the time', () => {
    let wins = 0;
    for (let g = 0; g < 10; g++) {
      const rng = createRng(100 + g);
      let s = fresh();
      while (!s.winner) {
        const seat = s.turn!;
        const move =
          seat === 'red'
            ? chooseCriticalMassMove(s, seat, { depth: 2, randomness: 0, rng: rng.next })
            : rng.pick(turn.legal(s, seat) as CMCommand[]);
        s = turn.apply(s, seat, move);
      }
      if (s.winner === 'red') wins++;
    }
    expect(wins).toBeGreaterThanOrEqual(8);
  });
  test('evaluate favours the side with more material', () => {
    const s = fresh();
    put(s, 'c3', 'red', 3);
    put(s, 'd4', 'blue', 1);
    expect(evaluate(s, 'red')).toBeGreaterThan(0);
    expect(evaluate(s, 'blue')).toBeLessThan(0);
  });
});
```

- [ ] **Step 4: Implement the strategy**

`apps/bots/src/strategies/critical-mass.ts`:
```ts
import { criticalMass, criticalMassGame, type CMCommand, type CMState } from '@cs/critical-mass';

const turn = criticalMassGame.turn!;
const WIN = 1e6;

/** Material plus bonuses for loaded cells (one short of exploding) and corners. */
export function evaluate(s: CMState, me: string): number {
  if (s.winner) return s.winner === me ? WIN : -WIN;
  let score = 0;
  s.cells.forEach((c, i) => {
    if (!c.owner) return;
    const crit = criticalMass(s.cols, s.rows, i);
    const value = c.orbs + 1 + (c.orbs === crit - 1 ? 1.5 : 0) + (crit === 2 ? 0.5 : 0);
    score += c.owner === me ? value : -value;
  });
  return score;
}

export interface CMStrategyOptions {
  depth: 1 | 2;
  /** Chance of picking one of the top three moves instead of the best, to stay beatable. */
  randomness: number;
  rng: () => number;
}

export function chooseCriticalMassMove(s: CMState, me: string, opts: CMStrategyOptions): CMCommand {
  const moves = turn.legal(s, me) as CMCommand[];
  if (moves.length === 0) throw new Error('No legal moves.');
  const jitter = () => opts.rng() * 0.01;
  // Ply 1: score every move.
  let ranked = moves
    .map((m) => {
      const next = turn.apply(s, me, m);
      return { m, next, score: evaluate(next, me) + jitter() };
    })
    .sort((a, b) => b.score - a.score);
  if (ranked[0].score >= WIN) return ranked[0].m;
  // Ply 2: for the ten most promising moves, assume the opponent's best reply.
  if (opts.depth === 2) {
    ranked = ranked
      .slice(0, 10)
      .map((c) => {
        if (c.next.winner || !c.next.turn) return c;
        const opp = c.next.turn;
        let worst = Infinity;
        for (const reply of turn.legal(c.next, opp) as CMCommand[]) {
          worst = Math.min(worst, evaluate(turn.apply(c.next, opp, reply), me));
          if (worst <= -WIN) break;
        }
        return worst === Infinity ? c : { ...c, score: worst + jitter() };
      })
      .sort((a, b) => b.score - a.score);
  }
  if (opts.rng() < opts.randomness) return ranked[Math.min(ranked.length - 1, Math.floor(opts.rng() * 3))].m;
  return ranked[0].m;
}
```

- [ ] **Step 5: Run the strategy tests**

Run: `bun install && bun test apps/bots/src/strategies`
Expected: PASS (4 tests) within a few seconds. If the "most of the time" test fails, look for a bug in `evaluate()` or in the ply-2 search before touching the threshold.

- [ ] **Step 6: Write the failing bot integration test**

`apps/bots/src/bot.test.ts`:
```ts
import { afterAll, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CMCommand } from '@cs/critical-mass';
import { createCore } from '@cs/server/core';
import { createApp } from '@cs/server/http';
import { startServer } from '@cs/server/server';
import { runBot } from './bot';
import { Client } from './client';
import { sprocket } from './personalities/sprocket';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const core = await createCore({ databaseUrl: 'pglite:memory', houseKey: 'hk', adminHandles: [], diaryDir: join(root, 'no-diary'), countdownMs: 0, houseFallbackMs: 100 });
const running = startServer(core, createApp(core, { apiDocs: '', llmsTxt: '' }), { port: 0, hostname: '127.0.0.1', webDir: null, allowedOrigins: [] });
const controller = new AbortController();
const tokenFile = join(root, `.data/test-bots/${crypto.randomUUID()}.token`);
const botDone = runBot({ base: running.url, personality: sprocket, houseKey: 'hk', tokenFile, thinkMs: [0, 0], pollWaitMs: 500, signal: controller.signal, log: () => {} });

afterAll(async () => {
  controller.abort();
  await botDone;
  await running.stop();
  await core.close();
});

async function until<T>(fn: () => Promise<T | null | undefined | false>, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await Bun.sleep(20);
  }
  throw new Error('timed out');
}

describe('Sprocket', () => {
  test('shows up, gets matched by quick match, plays to the end, and talks', async () => {
    const guest = new Client(running.url);
    await until(async () => (await guest.call<{ presence: { identity: { handle: string; isHouse: boolean } }[] }>('GET', '/api/who')).presence.find((p) => p.identity.handle === 'Sprocket' && p.identity.isHouse));
    const reg = await guest.register({ name: `challenger${Math.random().toString(36).slice(2, 7)}` });
    guest.token = reg.token;
    expect((await guest.quickMatch('critical-mass')).status).toBe('queued');
    const matchId = await until(async () => (await guest.me()).activeMatch);
    let env = await guest.match(matchId);
    expect(env.match.seats.map((s) => s.identity.handle)).toContain('Sprocket');
    while (env.match.status !== 'over') {
      if (env.match.status === 'live' && env.legal.length > 0) {
        try {
          env = await guest.move(matchId, env.match.revision, env.legal[0] as CMCommand);
        } catch {
          env = await guest.match(matchId);
        }
      } else {
        env = await guest.match(matchId, env.match.revision, 5000);
      }
    }
    expect(env.match.outcome?.winners).toHaveLength(1);
    const table = await until(async () => {
      const r = await guest.call<{ messages: { author: { handle: string } | null; text: string }[] }>('GET', `/api/chat/match:${matchId}`);
      const said = r.messages.filter((m) => m.author?.handle === 'Sprocket').map((m) => m.text);
      return said.length >= 2 ? said : null;
    });
    expect(sprocket.lines.hello).toContain(table[0]);
  }, 60_000);
});
```

- [ ] **Step 7: Implement the bot runner**

`apps/bots/src/bot.ts`:
```ts
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { stateFromView, type CMView } from '@cs/critical-mass';
import type { MatchEnvelope } from '@cs/shared/protocol';
import { ApiError, Client } from './client';
import { line, type Personality } from './personality';
import { chooseCriticalMassMove } from './strategies/critical-mass';

export interface BotOptions {
  base: string;
  personality: Personality;
  houseKey: string;
  tokenFile: string;
  thinkMs: [number, number];
  pollWaitMs?: number;
  signal?: AbortSignal;
  log?: (msg: string) => void;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      resolve();
    }, { once: true });
  });

async function connect(client: Client, opts: BotOptions, log: (m: string) => void): Promise<void> {
  const file = Bun.file(opts.tokenFile);
  if (await file.exists()) {
    client.token = (await file.text()).trim();
    try {
      await client.me();
      return;
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 401)) throw e;
      log('saved token rejected; registering again');
    }
  }
  const p = opts.personality;
  const reg = await client.register({ name: p.name, tagline: p.tagline, color: p.color, ...(p.model ? { model: p.model } : {}) }, opts.houseKey);
  client.token = reg.token;
  await mkdir(dirname(opts.tokenFile), { recursive: true });
  await Bun.write(opts.tokenFile, reg.token);
  log(`registered as @${reg.identity.handle}`);
}

function chooseMove(env: MatchEnvelope, think: { rng: () => number }): unknown {
  if (env.match.gameId === 'critical-mass' && env.you) {
    return chooseCriticalMassMove(stateFromView(env.view as CMView), env.you, { depth: 2, randomness: 0.15, rng: think.rng });
  }
  return env.legal[Math.floor(think.rng() * env.legal.length)];
}

async function playMatch(client: Client, opts: BotOptions, matchId: string, log: (m: string) => void): Promise<void> {
  const p = opts.personality;
  const table = `match:${matchId}`;
  const say = (text: string) => client.chat(table, text).catch(() => {});
  let env = await client.match(matchId);
  await say(line(p.lines.hello));
  let lastSeenMove = -1;
  while (!opts.signal?.aborted && (env.match.status === 'countdown' || env.match.status === 'live')) {
    const view = env.view as { lastMove?: { seat: string; waves: string[][] } | null; moveCount?: number };
    if (view.lastMove && view.moveCount !== lastSeenMove) {
      lastSeenMove = view.moveCount ?? -1;
      const big = view.lastMove.waves.length >= 3;
      if (big && view.lastMove.seat === env.you && Math.random() < 0.6) await say(line(p.lines.bigCascade));
      if (big && view.lastMove.seat !== env.you && Math.random() < 0.5) await say(line(p.lines.gotHit));
    }
    if (env.match.status === 'live' && env.you && env.match.toMove.includes(env.you) && env.legal.length > 0) {
      const [lo, hi] = opts.thinkMs;
      await sleep(lo + Math.random() * Math.max(0, hi - lo), opts.signal);
      try {
        env = await client.move(matchId, env.match.revision, chooseMove(env, { rng: Math.random }));
      } catch (e) {
        if (e instanceof ApiError && (e.status === 409 || e.status === 400)) {
          env = await client.match(matchId);
          continue;
        }
        throw e;
      }
      continue;
    }
    env = await client.match(matchId, env.match.revision, opts.pollWaitMs ?? 25_000);
  }
  const outcome = env.match.outcome;
  if (!outcome || !env.you) return;
  if (outcome.winners.length === 0) await say(line(p.lines.draw));
  else await say(line(outcome.winners.includes(env.you) ? p.lines.win : p.lines.lose));
  log(`match ${matchId} over: ${outcome.reason}`);
}

/** Run one house bot until `signal` aborts. Uses only the public HTTP API. */
export async function runBot(opts: BotOptions): Promise<void> {
  const log = opts.log ?? ((m: string) => console.log(`[${opts.personality.name}] ${m}`));
  const client = new Client(opts.base, null, opts.signal);
  const playing = new Set<string>();
  const lastReply = new Map<string, number>();
  const play = (matchId: string) => {
    if (playing.has(matchId)) return;
    playing.add(matchId);
    playMatch(client, opts, matchId, log)
      .catch((e) => {
        if (!opts.signal?.aborted) log(`match ${matchId} failed: ${(e as Error).message}`);
      })
      .finally(() => playing.delete(matchId));
  };

  for (let attempt = 0; !opts.signal?.aborted; attempt++) {
    try {
      await connect(client, opts, log);
      break;
    } catch (e) {
      if (opts.signal?.aborted) return;
      log(`cannot reach ${opts.base} (${(e as Error).message}); retrying`);
      await sleep(Math.min(10_000, 500 * 2 ** attempt), opts.signal);
    }
  }

  let cursor = 0;
  while (!opts.signal?.aborted) {
    try {
      const me = await client.me();
      if (me.presence?.status === 'afk') await client.setStatus('ready');
      if (me.activeMatch) play(me.activeMatch);
      const poll = await client.inbox(cursor, opts.pollWaitMs ?? 25_000);
      cursor = poll.cursor;
      for (const event of poll.events) {
        if (event.type === 'match.started') play(event.match.id);
        if (event.type === 'chat.mention' && !event.message.channel.startsWith('match:')) {
          const channel = event.message.channel;
          const now = Date.now();
          if ((lastReply.get(channel) ?? 0) + 15_000 < now) {
            lastReply.set(channel, now);
            const who = event.message.author ? `@${event.message.author.handle} ` : '';
            await client.chat(channel, who + line(opts.personality.lines.mentioned)).catch(() => {});
          }
        }
      }
    } catch (e) {
      if (opts.signal?.aborted) break;
      log(`inbox error: ${(e as Error).message}`);
      await sleep(2000, opts.signal);
    }
  }
}
```

`apps/bots/src/main.ts`:
```ts
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runBot } from './bot';
import { sprocket } from './personalities/sprocket';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const env = process.env;
const [lo, hi] = (env.BOT_THINK_MS ?? '900-2600').split('-').map(Number);

const controller = new AbortController();
process.on('SIGINT', () => controller.abort());
process.on('SIGTERM', () => controller.abort());

await runBot({
  base: env.CS_BASE ?? 'http://127.0.0.1:3000',
  personality: sprocket,
  houseKey: env.HOUSE_KEY ?? 'dev-house-key',
  tokenFile: join(root, '.data/bots/sprocket.token'),
  thinkMs: [lo || 0, hi || lo || 0],
  signal: controller.signal,
});
```

- [ ] **Step 8: Run all bot tests**

Run: `bun test apps/bots`
Expected: PASS (5 tests). The integration test takes a few seconds.

- [ ] **Step 9: Smoke-run the bot against a real server**

Run (two terminals, or background the first):
```bash
PORT=3056 bun apps/server/src/main.ts &
SERVER=$!
sleep 2
CS_BASE=http://127.0.0.1:3056 timeout 6 bun apps/bots/src/main.ts; true
curl -s http://127.0.0.1:3056/api/who
kill $SERVER
```
Expected: the bot logs `registered as @Sprocket`, or nothing if a token already exists, and `/api/who` lists Sprocket with `"isHouse":true`.

- [ ] **Step 10: Typecheck and commit**

Run: `bunx tsc -p tsconfig.json`. Expected: no errors.
```bash
git add apps/bots apps/server/package.json bun.lock
git commit -m "House bots: HTTP client, Sprocket personality, two-ply Critical Mass strategy

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Design system for Tasks 14–16 (read before writing any web code)

**Concept: two typographic species.** Humans (carbon) speak in **Fraunces** (variable, italic for names): soft, organic, a little wonky. Machines (silicon) speak in **IBM Plex Mono**. The interface chrome uses **IBM Plex Sans**. You can tell who is talking from the letterforms alone. The design spends its boldness here and nowhere else.

**The ground.** A night-ink background, with a faint outline of the real periodic table fixed to the bottom-right. Carbon (period 2, group 14) is outlined in ember; silicon sits directly beneath it in cyan. Don't add gradient washes, glows on panels, or decorative blobs.

**Palette (CSS custom properties in `app.css`):**

| Token | Hex | Role |
|---|---|---|
| `--ink` | `#12142a` | page background |
| `--ink-deep` | `#0d0f20` | inputs, code blocks |
| `--panel` / `--panel-2` | `#1a1d3a` / `#22264a` | panels / raised controls |
| `--lattice` | `#262a52` | lines and borders |
| `--chalk` | `#e9ecff` | primary text |
| `--fog` / `--dust` | `#9aa1cf` / `#6c73a3` | secondary / tertiary text |
| `--carbon` | `#ff8a3d` | humans (never used for anything else) |
| `--silicon` | `#4fe3ff` | machines (never used for anything else) |
| `--ready` / `--afk` / `--playing` | `#7dffb0` / `#ffcc66` / `#b18cff` | status dots |
| `--danger` | `#ff6b81` | errors |

Seat colors in Critical Mass are separate from species colors: red `#ff5a6e`, blue `#4fa8ff`, green `#6dffa8`, gold `#ffd35a`.

**Type scale** (base 15px): `--step--1` 0.8125rem, `--step-0` 0.9375rem, `--step-1` 1.125rem, `--step-2` 1.5rem, `--step-3` 2.25rem, `--step-4` 3.5rem. Line length stays under 72ch.

**Radii say what a thing is:** element tiles and badges 6px (periodic-table cells), panels 14px, controls 10px.

**Motion:** one orchestrated page-load moment only, where the scoreboard's C and Si tiles slide together. The game board animates cascades because that motion *is* the game. Nothing else animates unless the user caused it. `prefers-reduced-motion` switches all of it off.

**Copy rules:** sentence case, plain verbs, and buttons name exactly what happens ("Find a match", "Stop looking", "Resign"). Don't use all-caps labels, eyebrow labels, "A · B" meta strings, or "→" on buttons. Errors say what happened and what to do.

---

### Task 14: Web foundation (SvelteKit SPA shell, live connection, identity chip, handle gate)

**Files:**
- Create: `apps/web/package.json`, `apps/web/svelte.config.js`, `apps/web/vite.config.ts`, `apps/web/tsconfig.json`
- Create: `apps/web/src/app.html`, `apps/web/src/app.css`, `apps/web/src/app.d.ts`, `apps/web/static/favicon.svg`
- Create: `apps/web/src/lib/api.ts`, `apps/web/src/lib/live.svelte.ts`, `apps/web/src/lib/markdown.ts`, `apps/web/src/lib/seats.ts`
- Create: `apps/web/src/lib/components/{Lattice,IdentityChip,Nav,StatusToggle,HandleGate}.svelte`
- Create: `apps/web/src/routes/+layout.ts`, `apps/web/src/routes/+layout.svelte`, `apps/web/src/routes/+page.svelte` (a temporary lobby stub; Task 15 replaces it)

**Interfaces:**
- Consumes: `@cs/shared/protocol` types and `@cs/shared/brand` (never the `@cs/shared` root, which would bundle the profanity filter); the HTTP and WS protocols from Tasks 11–12.
- Produces:
  - `api<T>(method, path, body?): Promise<T>` and `class ApiError { status; code; message }`.
  - `live` (singleton) with:
    - state: `me`, `checked`, `connected`, `presence`, `activeMatch`, `queued`, `myStatus`
    - methods: `init()`, `join(handle)`, `setStatus(status)`, `quickMatch(gameId)`, `leaveQueue()`
    - subscriptions: `onChat(channel, fn) → off`, `watchMatch(matchId, fn) → off`, `onInbox(fn) → off`
  - `md(markdown): string` (HTML).
  - `SEAT_COLORS`, `seatColor(seat)`.
  - `<IdentityChip identity />`, `<Lattice />`, `<Nav />`, `<StatusToggle />`, `<HandleGate />`.

- [ ] **Step 1: Create the package and config**

`apps/web/package.json`:
```json
{
  "name": "@cs/web",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite dev",
    "build": "vite build",
    "preview": "vite preview",
    "check": "svelte-kit sync && svelte-check --tsconfig ./tsconfig.json --threshold error"
  },
  "dependencies": {
    "@cs/critical-mass": "workspace:*",
    "@cs/shared": "workspace:*",
    "@fontsource-variable/fraunces": "5.3.0",
    "@fontsource/ibm-plex-mono": "5.3.0",
    "@fontsource/ibm-plex-sans": "5.3.0",
    "marked": "18.0.14"
  },
  "devDependencies": {
    "@sveltejs/adapter-static": "3.0.10",
    "@sveltejs/kit": "2.70.3",
    "@sveltejs/vite-plugin-svelte": "7.3.1",
    "svelte": "5.57.1",
    "svelte-check": "4.7.6",
    "typescript": "6.0.3",
    "vite": "8.3.1"
  }
}
```

`apps/web/svelte.config.js`:
```js
import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
export default {
  preprocess: vitePreprocess(),
  kit: {
    adapter: adapter({ pages: 'build', assets: 'build', fallback: 'index.html', strict: false }),
  },
};
```

`apps/web/vite.config.ts`:
```ts
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

const target = process.env.CS_SERVER ?? 'http://127.0.0.1:3000';

export default defineConfig({
  plugins: [sveltekit()],
  server: {
    port: 5173,
    proxy: {
      '/api': target,
      '/llms.txt': target,
      '/ws': { target: target.replace(/^http/, 'ws'), ws: true },
    },
  },
});
```

`apps/web/tsconfig.json`:
```json
{
  "extends": "./.svelte-kit/tsconfig.json",
  "compilerOptions": {
    "strict": true,
    "skipLibCheck": true,
    "moduleResolution": "bundler"
  }
}
```

`apps/web/src/app.d.ts`:
```ts
declare global {
  namespace App {}
}
export {};
```

`apps/web/src/app.html`:
```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="dark" />
    <meta name="theme-color" content="#12142a" />
    <link rel="icon" href="%sveltekit.assets%/favicon.svg" />
    %sveltekit.head%
  </head>
  <body data-sveltekit-preload-data="hover">
    <div style="display: contents">%sveltekit.body%</div>
  </body>
</html>
```

`apps/web/static/favicon.svg`:
```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect x="4" y="8" width="32" height="40" rx="5" fill="#ff8a3d"/>
  <text x="17" y="36" font-family="Georgia, serif" font-style="italic" font-size="20" font-weight="700" text-anchor="middle" fill="#12142a">C</text>
  <rect x="26" y="16" width="34" height="40" rx="5" fill="#4fe3ff" stroke="#12142a" stroke-width="3"/>
  <text x="43" y="43" font-family="monospace" font-size="17" font-weight="700" text-anchor="middle" fill="#12142a">Si</text>
</svg>
```

`apps/web/src/app.css`:
```css
:root {
  --ink: #12142a;
  --ink-deep: #0d0f20;
  --panel: #1a1d3a;
  --panel-2: #22264a;
  --lattice: #262a52;
  --chalk: #e9ecff;
  --fog: #9aa1cf;
  --dust: #6c73a3;
  --carbon: #ff8a3d;
  --silicon: #4fe3ff;
  --ready: #7dffb0;
  --afk: #ffcc66;
  --playing: #b18cff;
  --danger: #ff6b81;

  --font-ui: 'IBM Plex Sans', system-ui, sans-serif;
  --font-carbon: 'Fraunces Variable', Georgia, 'Times New Roman', serif;
  --font-silicon: 'IBM Plex Mono', ui-monospace, 'SFMono-Regular', monospace;

  --step--1: 0.8125rem;
  --step-0: 0.9375rem;
  --step-1: 1.125rem;
  --step-2: 1.5rem;
  --step-3: 2.25rem;
  --step-4: 3.5rem;

  --r-tile: 6px;
  --r-panel: 14px;
  --r-control: 10px;
  --nav-h: 3.75rem;

  color-scheme: dark;
}

*,
*::before,
*::after {
  box-sizing: border-box;
}

html,
body {
  margin: 0;
  background: var(--ink);
  color: var(--chalk);
  font: 400 var(--step-0) / 1.5 var(--font-ui);
  -webkit-font-smoothing: antialiased;
}

a {
  color: var(--chalk);
  text-decoration-color: var(--dust);
  text-underline-offset: 0.2em;
}
a:hover {
  text-decoration-color: var(--chalk);
}

:focus-visible {
  outline: 2px solid var(--chalk);
  outline-offset: 2px;
  border-radius: 4px;
}

button {
  font: inherit;
  color: inherit;
  cursor: pointer;
}

.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
  padding: 0.6rem 1rem;
  border-radius: var(--r-control);
  border: 1px solid var(--lattice);
  background: var(--panel-2);
  color: var(--chalk);
  font-weight: 600;
  text-decoration: none;
}
.btn:hover:not(:disabled) {
  border-color: var(--fog);
}
.btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.btn.primary {
  background: var(--chalk);
  border-color: var(--chalk);
  color: var(--ink);
}
.btn.primary:hover:not(:disabled) {
  background: #ffffff;
}
.btn.quiet {
  background: transparent;
}

.panel {
  background: color-mix(in oklab, var(--panel) 92%, transparent);
  border: 1px solid var(--lattice);
  border-radius: var(--r-panel);
}

input,
select,
textarea {
  font: inherit;
  color: var(--chalk);
  background: var(--ink-deep);
  border: 1px solid var(--lattice);
  border-radius: var(--r-control);
  padding: 0.6rem 0.75rem;
}
input::placeholder {
  color: var(--dust);
}

.error {
  color: var(--danger);
  font-size: var(--step--1);
}

.visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
  border: 0;
}

.prose {
  max-width: 72ch;
  line-height: 1.65;
}
.prose h1,
.prose h2,
.prose h3 {
  font-family: var(--font-carbon);
  font-weight: 600;
  line-height: 1.2;
}
.prose h1 {
  font-size: var(--step-3);
}
.prose h2 {
  font-size: var(--step-2);
  margin-top: 2.2em;
}
.prose code {
  font-family: var(--font-silicon);
  font-size: 0.9em;
  background: var(--ink-deep);
  border: 1px solid var(--lattice);
  border-radius: 4px;
  padding: 0.05em 0.35em;
}
.prose pre {
  overflow-x: auto;
  background: var(--ink-deep);
  border: 1px solid var(--lattice);
  border-radius: var(--r-control);
  padding: 1rem;
}
.prose pre code {
  border: 0;
  padding: 0;
  background: none;
}
.prose table {
  border-collapse: collapse;
  display: block;
  overflow-x: auto;
}
.prose th,
.prose td {
  border: 1px solid var(--lattice);
  padding: 0.4rem 0.6rem;
  text-align: left;
  vertical-align: top;
}

@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    animation-duration: 0.001ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.001ms !important;
  }
}
```

- [ ] **Step 2: Write the client libraries**

`apps/web/src/lib/api.ts`:
```ts
import type { ApiErrorBody } from '@cs/shared/protocol';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const err = (data as ApiErrorBody | null)?.error;
    throw new ApiError(res.status, err?.code ?? `HTTP_${res.status}`, err?.message ?? res.statusText);
  }
  return data as T;
}
```

`apps/web/src/lib/live.svelte.ts`:
```ts
import type {
  ChatMessage,
  IdentityPublic,
  InboxEvent,
  MatchEnvelope,
  PresenceInfo,
  Status,
  WsClientMsg,
  WsServerMsg,
} from '@cs/shared/protocol';
import { api, ApiError } from './api';

type Listener<T> = (value: T) => void;

const byHandle = (a: PresenceInfo, b: PresenceInfo) =>
  a.identity.handle.toLowerCase().localeCompare(b.identity.handle.toLowerCase());

/** The one live connection: session, presence, and fan-out of pushed events to components. */
class Live {
  me = $state<IdentityPublic | null>(null);
  checked = $state(false);
  connected = $state(false);
  presence = $state<PresenceInfo[]>([]);
  activeMatch = $state<string | null>(null);
  queued = $state<string | null>(null);
  myStatus: Status = $derived(this.presence.find((p) => p.identity.id === this.me?.id)?.status ?? 'offline');

  #ws: WebSocket | null = null;
  #retry = 0;
  #chat = new Map<string, Set<Listener<ChatMessage>>>();
  #matches = new Map<string, Set<Listener<MatchEnvelope>>>();
  #inbox = new Set<Listener<InboxEvent>>();

  async init(): Promise<void> {
    try {
      const r = await api<{ identity: IdentityPublic; activeMatch: string | null; queued: string | null }>('GET', '/api/me');
      this.me = r.identity;
      this.activeMatch = r.activeMatch;
      this.queued = r.queued;
      this.connect();
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 401)) console.error(e);
    } finally {
      this.checked = true;
    }
  }

  async join(handle: string): Promise<void> {
    const r = await api<{ identity: IdentityPublic }>('POST', '/api/session', { handle });
    this.me = r.identity;
    this.connect();
  }

  async setStatus(status: 'ready' | 'afk'): Promise<void> {
    await api('PATCH', '/api/me', { status });
  }

  async quickMatch(gameId: string): Promise<void> {
    const r = await api<{ status: 'queued' } | { status: 'matched'; match: { id: string } }>('POST', '/api/quickmatch', { gameId });
    if (r.status === 'queued') {
      this.queued = gameId;
    } else {
      this.queued = null;
      this.activeMatch = r.match.id;
    }
  }

  async leaveQueue(): Promise<void> {
    await api('DELETE', '/api/quickmatch');
    this.queued = null;
  }

  connect(): void {
    if (this.#ws || typeof window === 'undefined') return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.#ws = ws;
    ws.onopen = () => {
      this.connected = true;
      this.#retry = 0;
      for (const channel of this.#chat.keys()) this.#send({ type: 'subscribe', channel });
      for (const matchId of this.#matches.keys()) this.#send({ type: 'watch', matchId });
    };
    ws.onmessage = (e) => this.#handle(JSON.parse(String(e.data)) as WsServerMsg);
    ws.onclose = () => {
      this.connected = false;
      this.#ws = null;
      const delay = Math.min(10_000, 500 * 2 ** this.#retry++);
      setTimeout(() => this.connect(), delay);
    };
  }

  #send(msg: WsClientMsg): void {
    if (this.#ws?.readyState === WebSocket.OPEN) this.#ws.send(JSON.stringify(msg));
  }

  #handle(msg: WsServerMsg): void {
    switch (msg.type) {
      case 'hello':
        this.me = msg.identity;
        this.presence = [...msg.presence].sort(byHandle);
        break;
      case 'presence': {
        const rest = this.presence.filter((p) => p.identity.id !== msg.presence.identity.id);
        this.presence = msg.presence.status === 'offline' ? rest : [...rest, msg.presence].sort(byHandle);
        break;
      }
      case 'chat':
        for (const fn of this.#chat.get(msg.message.channel) ?? []) fn(msg.message);
        break;
      case 'inbox':
        if (msg.event.type === 'match.started') {
          this.activeMatch = msg.event.match.id;
          this.queued = null;
        }
        if (msg.event.type === 'match.over' && this.activeMatch === msg.event.matchId) this.activeMatch = null;
        for (const fn of this.#inbox) fn(msg.event);
        break;
      case 'match':
        for (const fn of this.#matches.get(msg.envelope.match.id) ?? []) fn(msg.envelope);
        break;
      case 'pong':
        break;
    }
  }

  onChat(channel: string, fn: Listener<ChatMessage>): () => void {
    let set = this.#chat.get(channel);
    if (!set) {
      set = new Set();
      this.#chat.set(channel, set);
      this.#send({ type: 'subscribe', channel });
    }
    set.add(fn);
    return () => {
      set.delete(fn);
      if (set.size === 0) {
        this.#chat.delete(channel);
        this.#send({ type: 'unsubscribe', channel });
      }
    };
  }

  watchMatch(matchId: string, fn: Listener<MatchEnvelope>): () => void {
    let set = this.#matches.get(matchId);
    if (!set) {
      set = new Set();
      this.#matches.set(matchId, set);
      this.#send({ type: 'watch', matchId });
    }
    set.add(fn);
    return () => {
      set.delete(fn);
      if (set.size === 0) {
        this.#matches.delete(matchId);
        this.#send({ type: 'unwatch', matchId });
      }
    };
  }

  onInbox(fn: Listener<InboxEvent>): () => void {
    this.#inbox.add(fn);
    return () => this.#inbox.delete(fn);
  }
}

export const live = new Live();
```

`apps/web/src/lib/markdown.ts`:
```ts
import { marked } from 'marked';

/** Render trusted markdown (our own docs and diary) to HTML. */
export function md(source: string): string {
  return marked.parse(source, { async: false, gfm: true }) as string;
}
```

`apps/web/src/lib/seats.ts`:
```ts
export const SEAT_COLORS: Record<string, string> = {
  red: '#ff5a6e',
  blue: '#4fa8ff',
  green: '#6dffa8',
  gold: '#ffd35a',
};

export function seatColor(seat: string | null | undefined): string {
  return (seat && SEAT_COLORS[seat]) || '#9aa1cf';
}
```

- [ ] **Step 3: Write the base components**

`apps/web/src/lib/components/Lattice.svelte`: the periodic table silhouette behind everything. Carbon and silicon sit in group 14, one above the other.
```svelte
<script lang="ts">
  const W = 40;
  const GAP = 4;
  const STEP = W + GAP;
  type Cell = { x: number; y: number; el?: 'C' | 'Si' };

  const cells: Cell[] = [];
  const add = (period: number, group: number) =>
    cells.push({
      x: group - 1,
      y: period - 1,
      el: group === 14 && period === 2 ? 'C' : group === 14 && period === 3 ? 'Si' : undefined,
    });
  add(1, 1);
  add(1, 18);
  for (const period of [2, 3]) for (const group of [1, 2, 13, 14, 15, 16, 17, 18]) add(period, group);
  for (const period of [4, 5, 6, 7]) for (let group = 1; group <= 18; group++) add(period, group);
  for (const y of [7.5, 8.5]) for (let group = 3; group <= 17; group++) cells.push({ x: group - 1, y });
</script>

<svg class="lattice" viewBox="0 0 {18 * STEP} {9.5 * STEP}" aria-hidden="true" focusable="false">
  {#each cells as cell}
    <rect x={cell.x * STEP} y={cell.y * STEP} width={W} height={W} rx="4" class={cell.el ?? ''} />
    {#if cell.el}
      <text x={cell.x * STEP + W / 2} y={cell.y * STEP + W / 2 + 6} text-anchor="middle" class="sym {cell.el}">{cell.el}</text>
    {/if}
  {/each}
</svg>

<style>
  .lattice {
    position: fixed;
    right: -3vw;
    bottom: -4vh;
    width: min(1100px, 110vw);
    opacity: 0.55;
    pointer-events: none;
    z-index: 0;
  }
  rect {
    fill: none;
    stroke: var(--lattice);
    stroke-width: 1;
  }
  rect.C {
    stroke: var(--carbon);
    fill: color-mix(in oklab, var(--carbon) 10%, transparent);
  }
  rect.Si {
    stroke: var(--silicon);
    fill: color-mix(in oklab, var(--silicon) 10%, transparent);
  }
  .sym {
    font-size: 17px;
    font-weight: 600;
  }
  .sym.C {
    fill: var(--carbon);
    font-family: var(--font-carbon);
    font-style: italic;
  }
  .sym.Si {
    fill: var(--silicon);
    font-family: var(--font-silicon);
  }
</style>
```

`apps/web/src/lib/components/IdentityChip.svelte`:
```svelte
<script lang="ts">
  import type { IdentityPublic } from '@cs/shared/protocol';

  let {
    identity,
    badge = true,
  }: { identity: Pick<IdentityPublic, 'handle' | 'kind' | 'color' | 'isHouse'>; badge?: boolean } = $props();
  const human = $derived(identity.kind === 'human');
</script>

<span class="chip" class:human class:machine={!human}>
  {#if badge}<span class="sym" aria-hidden="true">{human ? 'C' : 'Si'}</span>{/if}
  <span class="name" style:color={identity.color}>{identity.handle}</span>
  <span class="visually-hidden">({human ? 'human' : identity.isHouse ? 'house machine' : 'machine'})</span>
  {#if identity.isHouse}<span class="house" aria-hidden="true">house</span>{/if}
</span>

<style>
  .chip {
    display: inline-flex;
    align-items: baseline;
    gap: 0.4em;
    min-width: 0;
  }
  .sym {
    display: inline-grid;
    place-items: center;
    align-self: center;
    min-width: 1.6em;
    height: 1.6em;
    padding: 0 0.25em;
    border-radius: var(--r-tile);
    font-size: 0.7em;
    font-weight: 700;
    color: var(--ink);
    flex: none;
  }
  .human .sym {
    background: var(--carbon);
    font-family: var(--font-carbon);
    font-style: italic;
  }
  .machine .sym {
    background: var(--silicon);
    font-family: var(--font-silicon);
  }
  .name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .human .name {
    font-family: var(--font-carbon);
    font-style: italic;
    font-weight: 600;
  }
  .machine .name {
    font-family: var(--font-silicon);
    font-weight: 500;
  }
  .house {
    font-size: 0.7em;
    color: var(--fog);
    border: 1px solid var(--lattice);
    border-radius: 999px;
    padding: 0 0.5em;
  }
</style>
```

`apps/web/src/lib/components/StatusToggle.svelte`:
```svelte
<script lang="ts">
  import { live } from '$lib/live.svelte';

  let error = $state('');
  async function set(status: 'ready' | 'afk') {
    error = '';
    try {
      await live.setStatus(status);
    } catch (e) {
      error = (e as Error).message;
    }
  }
</script>

{#if live.myStatus === 'playing'}
  <span class="playing">In a match</span>
{:else}
  <div class="toggle" role="group" aria-label="Your status">
    <button type="button" aria-pressed={live.myStatus === 'ready'} onclick={() => set('ready')}>
      <span class="dot ready" aria-hidden="true"></span>Ready
    </button>
    <button type="button" aria-pressed={live.myStatus === 'afk'} onclick={() => set('afk')}>
      <span class="dot afk" aria-hidden="true"></span>AFK
    </button>
  </div>
{/if}
{#if error}<span class="error" role="alert">{error}</span>{/if}

<style>
  .toggle {
    display: inline-flex;
    border: 1px solid var(--lattice);
    border-radius: var(--r-control);
    overflow: hidden;
  }
  button {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.35rem 0.7rem;
    background: transparent;
    border: 0;
    color: var(--fog);
    font-size: var(--step--1);
    font-weight: 600;
  }
  button[aria-pressed='true'] {
    background: var(--panel-2);
    color: var(--chalk);
  }
  .dot {
    width: 0.5rem;
    height: 0.5rem;
    border-radius: 50%;
  }
  .dot.ready {
    background: var(--ready);
  }
  .dot.afk {
    background: var(--afk);
  }
  .playing {
    font-size: var(--step--1);
    font-weight: 600;
    color: var(--playing);
  }
</style>
```

`apps/web/src/lib/components/Nav.svelte`:
```svelte
<script lang="ts">
  import { page } from '$app/state';
  import { BRAND } from '@cs/shared/brand';
  import { live } from '$lib/live.svelte';
  import IdentityChip from './IdentityChip.svelte';
  import StatusToggle from './StatusToggle.svelte';

  const [carbonWord, siliconWord] = BRAND.name.split(' & ');
  const links = [
    { href: '/', label: 'Lobby' },
    { href: '/games', label: 'Games' },
    { href: '/diary', label: 'Diary' },
    { href: '/docs', label: 'Agent API' },
  ];
  const current = (href: string) =>
    href === '/' ? page.url.pathname === '/' : page.url.pathname.startsWith(href);
</script>

<header class="nav">
  <a class="wordmark" href="/" aria-label={BRAND.name}>
    <span class="c">{carbonWord}</span>
    {#if siliconWord}<span class="amp">&amp;</span><span class="si">{siliconWord}</span>{/if}
  </a>
  <nav aria-label="Main">
    {#each links as link}
      <a href={link.href} aria-current={current(link.href) ? 'page' : undefined}>{link.label}</a>
    {/each}
  </nav>
  <div class="me">
    {#if live.me}
      <IdentityChip identity={live.me} />
      <StatusToggle />
      {#if !live.connected}<span class="offline" title="Reconnecting">Reconnecting…</span>{/if}
    {/if}
  </div>
</header>

<style>
  .nav {
    display: flex;
    align-items: center;
    gap: 1.5rem;
    min-height: var(--nav-h);
    padding: 0.5rem clamp(0.75rem, 2vw, 1.5rem);
    flex-wrap: wrap;
  }
  .wordmark {
    display: inline-flex;
    align-items: baseline;
    gap: 0.35em;
    text-decoration: none;
    font-size: var(--step-1);
    white-space: nowrap;
  }
  .c {
    font-family: var(--font-carbon);
    font-style: italic;
    font-weight: 700;
    color: var(--carbon);
  }
  .amp {
    color: var(--dust);
  }
  .si {
    font-family: var(--font-silicon);
    font-weight: 600;
    color: var(--silicon);
  }
  nav {
    display: flex;
    gap: 1.1rem;
    flex-wrap: wrap;
  }
  nav a {
    color: var(--fog);
    text-decoration: none;
    font-weight: 500;
  }
  nav a:hover,
  nav a[aria-current='page'] {
    color: var(--chalk);
  }
  nav a[aria-current='page'] {
    text-decoration: underline;
    text-decoration-color: var(--dust);
    text-underline-offset: 0.45em;
  }
  .me {
    margin-left: auto;
    display: flex;
    align-items: center;
    gap: 0.9rem;
    min-width: 0;
  }
  .offline {
    color: var(--afk);
    font-size: var(--step--1);
  }
</style>
```

`apps/web/src/lib/components/HandleGate.svelte`:
```svelte
<script lang="ts">
  import { live } from '$lib/live.svelte';

  let handle = $state('');
  let error = $state('');
  let busy = $state(false);
  let input: HTMLInputElement | undefined = $state();

  $effect(() => {
    input?.focus();
  });

  async function submit(e: SubmitEvent) {
    e.preventDefault();
    error = '';
    busy = true;
    try {
      await live.join(handle);
    } catch (err) {
      error = (err as Error).message;
      input?.focus();
    } finally {
      busy = false;
    }
  }
</script>

<div class="scrim">
  <form class="gate panel" role="dialog" aria-modal="true" aria-labelledby="gate-title" onsubmit={submit}>
    <h1 id="gate-title">Pick a name and pull up a chair.</h1>
    <p>No sign-up. Your name sticks to this browser. Humans and machines play here side by side.</p>
    <label for="handle">Your handle</label>
    <div class="row">
      <input
        id="handle"
        bind:this={input}
        bind:value={handle}
        autocomplete="nickname"
        minlength="3"
        maxlength="20"
        placeholder="3–20 letters, digits, _ or -"
        required
        aria-describedby={error ? 'gate-error' : undefined}
      />
      <button class="btn primary" type="submit" disabled={busy}>Enter the parlor</button>
    </div>
    {#if error}<p id="gate-error" class="error" role="alert">{error}</p>{/if}
    <p class="agents">Are you an AI agent? Start with <a href="/llms.txt">/llms.txt</a>. Everything works over plain HTTP.</p>
  </form>
</div>

<style>
  .scrim {
    position: fixed;
    inset: 0;
    z-index: 20;
    display: grid;
    place-items: center;
    padding: 1rem;
    background: color-mix(in oklab, var(--ink) 70%, transparent);
    backdrop-filter: blur(6px);
  }
  .gate {
    width: min(34rem, 100%);
    padding: clamp(1.25rem, 4vw, 2.25rem);
  }
  h1 {
    margin: 0 0 0.5rem;
    font-family: var(--font-carbon);
    font-style: italic;
    font-weight: 600;
    font-size: var(--step-3);
    line-height: 1.1;
  }
  p {
    color: var(--fog);
    margin: 0 0 1.25rem;
  }
  label {
    display: block;
    font-weight: 600;
    margin-bottom: 0.4rem;
  }
  .row {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
  }
  input {
    flex: 1 1 14rem;
  }
  .agents {
    margin: 1.25rem 0 0;
    font-size: var(--step--1);
  }
  .agents a {
    font-family: var(--font-silicon);
  }
</style>
```

- [ ] **Step 4: Write the layout and a temporary lobby stub**

`apps/web/src/routes/+layout.ts`:
```ts
export const ssr = false;
export const prerender = false;
```

`apps/web/src/routes/+layout.svelte`:
```svelte
<script lang="ts">
  import '@fontsource-variable/fraunces';
  import '@fontsource-variable/fraunces/wght-italic.css';
  import '@fontsource/ibm-plex-sans/400.css';
  import '@fontsource/ibm-plex-sans/500.css';
  import '@fontsource/ibm-plex-sans/600.css';
  import '@fontsource/ibm-plex-mono/400.css';
  import '@fontsource/ibm-plex-mono/500.css';
  import '@fontsource/ibm-plex-mono/600.css';
  import '../app.css';
  import { onMount, type Snippet } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { BRAND } from '@cs/shared/brand';
  import HandleGate from '$lib/components/HandleGate.svelte';
  import Lattice from '$lib/components/Lattice.svelte';
  import Nav from '$lib/components/Nav.svelte';
  import { live } from '$lib/live.svelte';

  let { children }: { children: Snippet } = $props();

  onMount(() => {
    void live.init();
    return live.onInbox((event) => {
      if (event.type === 'match.started') void goto(`/play/${event.match.id}`);
    });
  });

  const readingOnly = $derived(['/docs', '/diary', '/games'].some((p) => page.url.pathname.startsWith(p)));
</script>

<svelte:head><title>{BRAND.name}</title></svelte:head>

<Lattice />
<div class="shell">
  <Nav />
  <main>{@render children()}</main>
</div>
{#if live.checked && !live.me && !readingOnly}<HandleGate />{/if}

<style>
  .shell {
    position: relative;
    z-index: 1;
    min-height: 100dvh;
    display: flex;
    flex-direction: column;
  }
  main {
    flex: 1;
    width: min(1440px, 100%);
    margin: 0 auto;
    padding: 0 clamp(0.75rem, 2vw, 1.5rem) 1.5rem;
    min-height: 0;
  }
</style>
```

> If `@fontsource-variable/fraunces/wght-italic.css` doesn't exist, run `ls node_modules/@fontsource-variable/fraunces/*.css` and import the italic file that does exist. The font family name must stay `'Fraunces Variable'`.

`apps/web/src/routes/+page.svelte` (stub, replaced in Task 15):
```svelte
<script lang="ts">
  import { live } from '$lib/live.svelte';
</script>

<p>{live.me ? `Welcome, ${live.me.handle}.` : 'Loading…'}</p>
```

- [ ] **Step 5: Install, check, build**

Run: `bun install && cd apps/web && bun run check && bun run build && cd ../..`
Expected: svelte-check reports 0 errors, and `apps/web/build/index.html` exists.

- [ ] **Step 6: See it served by the real server**

Run:
```bash
PORT=3057 bun apps/server/src/main.ts & SERVER=$!; sleep 2
curl -s http://127.0.0.1:3057/ | grep -c '<div style="display: contents">'
curl -s http://127.0.0.1:3057/play/anything | grep -c 'sveltekit'
kill $SERVER
```
Expected: both counts are ≥ 1. The SPA shell and the fallback route are both served.

- [ ] **Step 7: Commit**

```bash
git add apps/web bun.lock
git commit -m "Web foundation: SvelteKit SPA shell, live connection, identity chips, handle gate

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 15: The lobby, the catalog, the diary, and the docs pages

**Files:**
- Create: `apps/web/src/lib/components/{Scoreboard,ChatPanel,WhoList,QuickMatch}.svelte`, `apps/web/src/lib/chat.ts`
- Replace: `apps/web/src/routes/+page.svelte` (the lobby)
- Create: `apps/web/src/routes/games/+page.svelte`, `apps/web/src/routes/diary/+page.svelte`, `apps/web/src/routes/diary/[slug]/+page.svelte`, `apps/web/src/routes/docs/+page.svelte`
- Test: `apps/web/src/lib/chat.test.ts`

**Interfaces:**
- Consumes: `api`, `live`, `md`, `IdentityChip` (Task 14); the endpoints `/api/chat/:channel`, `/api/games`, `/api/games/:id/rules`, `/api/tally`, `/api/diary`, `/api/diary/:slug` and `/api/docs` (Task 11).
- Produces:
  - `splitMessage(text): Part[]`, where `Part = { kind: 'text' | 'mention' | 'link'; value: string }`.
  - `<ChatPanel channel title readOnly? placeholder? />`, which Task 16 reuses for table talk.
  - `<Scoreboard />`, `<WhoList />`, `<QuickMatch />`.
  - These are the accessible names the e2e tests (Task 18) rely on, so keep them exact:
    - button "Enter the parlor" and textbox "Your handle" (Task 14)
    - textbox "Message #lobby", button "Send"
    - region "Here now"
    - button "Find a match", button "Stop looking"

- [ ] **Step 1: Write the failing test for message parsing**

`apps/web/src/lib/chat.test.ts`:
```ts
import { describe, expect, test } from 'bun:test';
import { splitMessage } from './chat';

describe('splitMessage', () => {
  test('finds mentions and diary links and keeps the rest as text', () => {
    expect(splitMessage('hey @Sprocket, read /diary/2026-09-26-doors-open now')).toEqual([
      { kind: 'text', value: 'hey ' },
      { kind: 'mention', value: '@Sprocket' },
      { kind: 'text', value: ', read ' },
      { kind: 'link', value: '/diary/2026-09-26-doors-open' },
      { kind: 'text', value: ' now' },
    ]);
  });
  test('plain text stays whole; too-short mentions are text', () => {
    expect(splitMessage('gg @ab')).toEqual([{ kind: 'text', value: 'gg @ab' }]);
    expect(splitMessage('')).toEqual([]);
  });
});
```

Run: `bun test apps/web/src/lib/chat.test.ts`
Expected: FAIL. The module `./chat` isn't found.

- [ ] **Step 2: Implement `chat.ts`**

`apps/web/src/lib/chat.ts`:
```ts
export type Part = { kind: 'text' | 'mention' | 'link'; value: string };

const TOKEN = /(@[A-Za-z0-9_-]{3,20})|(\/diary\/[a-z0-9-]+)/g;

/** Split a chat message into plain text, @mentions and internal diary links. */
export function splitMessage(text: string): Part[] {
  const parts: Part[] = [];
  let last = 0;
  for (const m of text.matchAll(TOKEN)) {
    const at = m.index ?? 0;
    if (at > last) parts.push({ kind: 'text', value: text.slice(last, at) });
    parts.push({ kind: m[1] ? 'mention' : 'link', value: m[0] });
    last = at + m[0].length;
  }
  if (last < text.length) parts.push({ kind: 'text', value: text.slice(last) });
  return parts;
}
```

Run: `bun test apps/web/src/lib/chat.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 3: Write the lobby components**

`apps/web/src/lib/components/Scoreboard.svelte`: the page's one orchestrated moment. C sits directly above Si, as in group 14, and the tiles slide together on load.
```svelte
<script lang="ts">
  import { onMount } from 'svelte';
  import type { Tally } from '@cs/shared/protocol';
  import { api } from '$lib/api';
  import { live } from '$lib/live.svelte';

  let tally = $state<Tally | null>(null);

  async function load() {
    try {
      tally = await api<Tally>('GET', '/api/tally');
    } catch {
      // The scoreboard is decoration-grade; the lobby works without it.
    }
  }

  onMount(() => {
    void load();
    const off = live.onInbox((e) => {
      if (e.type === 'match.over') void load();
    });
    const timer = setInterval(load, 60_000);
    return () => {
      off();
      clearInterval(timer);
    };
  });

  const month = $derived(
    tally ? new Date(`${tally.season}-01T00:00:00Z`).toLocaleString(undefined, { month: 'long', timeZone: 'UTC' }) : '',
  );
</script>

<section class="score" aria-labelledby="score-title">
  <h2 id="score-title" class="visually-hidden">Humans versus machines this season</h2>
  <div class="tiles">
    <div class="tile c" role="img" aria-label="Humans have {tally?.carbon ?? 0} wins this season">
      <span class="n">{tally?.carbon ?? '–'}</span>
      <span class="sym">C</span>
      <span class="who">Humans</span>
    </div>
    <div class="tile si" role="img" aria-label="Machines have {tally?.silicon ?? 0} wins this season">
      <span class="n">{tally?.silicon ?? '–'}</span>
      <span class="sym">Si</span>
      <span class="who">Machines</span>
    </div>
  </div>
  {#if tally}
    <p class="caption">
      Wins in human-versus-machine games, {month} season{#if tally.draws}, plus {tally.draws}
        {tally.draws === 1 ? 'draw' : 'draws'}{/if}.
    </p>
  {/if}
</section>

<style>
  .tiles {
    display: grid;
    grid-template-rows: auto auto;
    gap: 0.4rem;
    justify-content: start;
  }
  .tile {
    position: relative;
    width: 8.5rem;
    aspect-ratio: 1;
    border-radius: var(--r-tile);
    padding: 0.55rem 0.7rem;
    display: grid;
    grid-template-rows: auto 1fr auto;
    color: var(--ink);
  }
  .c {
    background: var(--carbon);
    animation: from-above 700ms cubic-bezier(0.2, 0.9, 0.2, 1) both;
  }
  .si {
    background: var(--silicon);
    animation: from-below 700ms cubic-bezier(0.2, 0.9, 0.2, 1) both;
  }
  .n {
    font-size: var(--step-1);
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }
  .sym {
    align-self: center;
    justify-self: center;
    font-size: var(--step-4);
    line-height: 1;
    font-weight: 700;
  }
  .c .sym {
    font-family: var(--font-carbon);
    font-style: italic;
  }
  .si .sym {
    font-family: var(--font-silicon);
    font-weight: 600;
  }
  .who {
    font-size: var(--step--1);
    font-weight: 600;
  }
  .caption {
    margin: 0.6rem 0 0;
    font-size: var(--step--1);
    color: var(--fog);
    max-width: 17rem;
  }
  @keyframes from-above {
    from {
      transform: translateY(-1.5rem);
      opacity: 0;
    }
  }
  @keyframes from-below {
    from {
      transform: translateY(1.5rem);
      opacity: 0;
    }
  }
  @media (max-width: 960px) {
    .tiles {
      grid-template-rows: none;
      grid-auto-flow: column;
    }
    .tile {
      width: 6.5rem;
    }
    .sym {
      font-size: var(--step-3);
    }
  }
</style>
```

`apps/web/src/lib/components/ChatPanel.svelte`: humans' messages are set in Fraunces, machines' in Plex Mono.
```svelte
<script lang="ts">
  import { tick } from 'svelte';
  import type { ChatMessage } from '@cs/shared/protocol';
  import { api } from '$lib/api';
  import { splitMessage } from '$lib/chat';
  import { live } from '$lib/live.svelte';
  import IdentityChip from './IdentityChip.svelte';

  let {
    channel,
    title,
    readOnly = false,
    placeholder = 'Say something',
  }: { channel: string; title: string; readOnly?: boolean; placeholder?: string } = $props();

  let messages = $state<ChatMessage[]>([]);
  let draft = $state('');
  let error = $state('');
  let sending = $state(false);
  let log: HTMLDivElement | undefined = $state();
  let pinned = true;
  const inputId = $derived(`say-${channel.replace(/[^a-z0-9-]/gi, '-')}`);

  function merge(list: ChatMessage[]) {
    const byId = new Map(messages.map((m) => [m.id, m]));
    for (const m of list) byId.set(m.id, m);
    messages = [...byId.values()].sort((a, b) => a.id - b.id).slice(-300);
  }

  $effect(() => {
    const ch = channel;
    let alive = true;
    messages = [];
    error = '';
    const off = live.onChat(ch, (m) => merge([m]));
    api<{ messages: ChatMessage[] }>('GET', `/api/chat/${encodeURIComponent(ch)}?limit=100`)
      .then((r) => alive && merge(r.messages))
      .catch((e) => alive && (error = (e as Error).message));
    return () => {
      alive = false;
      off();
    };
  });

  $effect(() => {
    void messages.length;
    if (!pinned || !log) return;
    void tick().then(() => log && (log.scrollTop = log.scrollHeight));
  });

  function onScroll() {
    if (log) pinned = log.scrollHeight - log.scrollTop - log.clientHeight < 48;
  }

  async function send(e: SubmitEvent) {
    e.preventDefault();
    const text = draft.trim();
    if (!text) return;
    sending = true;
    error = '';
    try {
      await api('POST', `/api/chat/${encodeURIComponent(channel)}`, { text });
      draft = '';
      pinned = true;
    } catch (err) {
      error = (err as Error).message;
    } finally {
      sending = false;
    }
  }

  const mentionsMe = (m: ChatMessage) =>
    !!live.me && m.text.toLowerCase().includes(`@${live.me.handle.toLowerCase()}`);
  const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
</script>

<section class="chat panel" aria-label={title}>
  <header><h2>{title}</h2></header>
  <div class="log" bind:this={log} onscroll={onScroll} role="log" aria-live="polite" aria-relevant="additions">
    {#each messages as m (m.id)}
      {#if m.system}
        <p class="sys">
          {#each splitMessage(m.text) as p}{#if p.kind === 'link'}<a href={p.value}>{p.value}</a>{:else}{p.value}{/if}{/each}
        </p>
      {:else}
        <article
          class="msg"
          class:mine={m.author?.id === live.me?.id}
          class:mention={mentionsMe(m)}
          class:machine={m.author?.kind === 'agent'}
        >
          <div class="meta">
            {#if m.author}<IdentityChip identity={m.author} />{/if}
            <time datetime={m.createdAt}>{time(m.createdAt)}</time>
          </div>
          <p class="text">
            {#each splitMessage(m.text) as p}{#if p.kind === 'mention'}<strong>{p.value}</strong>{:else if p.kind === 'link'}<a
                  href={p.value}>{p.value}</a
                >{:else}{p.value}{/if}{/each}
          </p>
        </article>
      {/if}
    {:else}
      <p class="empty">{readOnly ? 'Nothing posted yet.' : 'Quiet in here. Say hello.'}</p>
    {/each}
  </div>
  {#if readOnly}
    <p class="note">Only the Proprietor posts here.</p>
  {:else if live.me}
    <form onsubmit={send}>
      <label class="visually-hidden" for={inputId}>Message {title}</label>
      <input id={inputId} bind:value={draft} maxlength="500" {placeholder} autocomplete="off" />
      <button class="btn" type="submit" disabled={sending || !draft.trim()}>Send</button>
    </form>
  {/if}
  {#if error}<p class="error pad" role="alert">{error}</p>{/if}
</section>

<style>
  .chat {
    display: grid;
    grid-template-rows: auto minmax(0, 1fr) auto auto;
    min-height: 0;
    height: 100%;
  }
  header {
    padding: 0.8rem 1rem 0.4rem;
  }
  h2 {
    margin: 0;
    font-size: var(--step-0);
    font-weight: 600;
    color: var(--fog);
  }
  .log {
    overflow-y: auto;
    padding: 0.25rem 1rem 0.75rem;
    display: flex;
    flex-direction: column;
    gap: 0.7rem;
    overscroll-behavior: contain;
  }
  .msg {
    max-width: 72ch;
    padding-left: 0.75rem;
    border-left: 2px solid transparent;
  }
  .msg.mention {
    border-left-color: var(--chalk);
  }
  .meta {
    display: flex;
    align-items: baseline;
    gap: 0.6rem;
    font-size: var(--step--1);
  }
  time {
    color: var(--dust);
    font-size: 0.85em;
  }
  .text {
    margin: 0.1rem 0 0;
    font-family: var(--font-carbon);
    font-size: 1.02rem;
    line-height: 1.45;
    overflow-wrap: anywhere;
  }
  .machine .text {
    font-family: var(--font-silicon);
    font-size: 0.9rem;
  }
  .text strong {
    font-weight: 700;
  }
  .sys {
    margin: 0.2rem 0;
    color: var(--fog);
    font-size: var(--step--1);
    text-align: center;
  }
  .empty,
  .note {
    color: var(--dust);
    margin: 1rem;
  }
  form {
    display: flex;
    gap: 0.5rem;
    padding: 0.75rem;
    border-top: 1px solid var(--lattice);
  }
  input {
    flex: 1;
    min-width: 0;
  }
  .pad {
    margin: 0 1rem 0.75rem;
  }
</style>
```

`apps/web/src/lib/components/WhoList.svelte`:
```svelte
<script lang="ts">
  import { live } from '$lib/live.svelte';
  import IdentityChip from './IdentityChip.svelte';

  const LABEL = { ready: 'Ready', afk: 'AFK', playing: 'In a match', offline: 'Offline' } as const;
  const others = $derived(live.presence.filter((p) => p.identity.id !== live.me?.id));
</script>

<section class="who panel" aria-labelledby="who-title">
  <h2 id="who-title">Here now <span class="count">{live.presence.length}</span></h2>
  <ul>
    {#each live.presence as p (p.identity.id)}
      <li>
        <span class="dot {p.status}" title={LABEL[p.status]} aria-hidden="true"></span>
        <span class="visually-hidden">{LABEL[p.status]}:</span>
        <div class="body">
          <IdentityChip identity={p.identity} />
          {#if p.identity.tagline}<span class="tagline">{p.identity.tagline}</span>{/if}
        </div>
      </li>
    {/each}
  </ul>
  {#if live.me && others.length === 0}
    <p class="empty">Nobody else yet. A house machine joins when you start a match.</p>
  {/if}
</section>

<style>
  .who {
    padding: 0.8rem 1rem;
    min-height: 0;
    overflow-y: auto;
  }
  h2 {
    margin: 0 0 0.6rem;
    font-size: var(--step-0);
    font-weight: 600;
    color: var(--fog);
  }
  .count {
    color: var(--chalk);
    font-variant-numeric: tabular-nums;
    margin-left: 0.3rem;
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 0.55rem;
  }
  li {
    display: grid;
    grid-template-columns: 0.6rem minmax(0, 1fr);
    gap: 0.6rem;
    align-items: baseline;
  }
  .body {
    display: grid;
    min-width: 0;
  }
  .tagline {
    color: var(--dust);
    font-size: var(--step--1);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .dot {
    width: 0.55rem;
    height: 0.55rem;
    border-radius: 50%;
    align-self: center;
  }
  .dot.ready {
    background: var(--ready);
  }
  .dot.afk {
    background: var(--afk);
  }
  .dot.playing {
    background: var(--playing);
  }
  .empty {
    color: var(--dust);
    font-size: var(--step--1);
    margin: 0.75rem 0 0;
  }
</style>
```

`apps/web/src/lib/components/QuickMatch.svelte`:
```svelte
<script lang="ts">
  import { onMount } from 'svelte';
  import type { GameInfo } from '@cs/shared/protocol';
  import { api } from '$lib/api';
  import { live } from '$lib/live.svelte';

  let games = $state<GameInfo[]>([]);
  let gameId = $state('critical-mass');
  let error = $state('');
  let busy = $state(false);

  onMount(async () => {
    try {
      games = (await api<{ games: GameInfo[] }>('GET', '/api/games')).games;
      if (games.length > 0 && !games.some((g) => g.id === gameId)) gameId = games[0].id;
    } catch (e) {
      error = (e as Error).message;
    }
  });

  const game = $derived(games.find((g) => g.id === gameId));

  async function find() {
    error = '';
    busy = true;
    try {
      await live.quickMatch(gameId);
    } catch (e) {
      error = (e as Error).message;
    } finally {
      busy = false;
    }
  }

  async function stop() {
    error = '';
    try {
      await live.leaveQueue();
    } catch (e) {
      error = (e as Error).message;
    }
  }
</script>

<section class="play panel" aria-labelledby="play-title">
  <h2 id="play-title">Play</h2>
  {#if games.length > 1}
    <label class="pick">Game
      <select bind:value={gameId}>
        {#each games as g}<option value={g.id}>{g.name}</option>{/each}
      </select>
    </label>
  {/if}
  {#if game}
    <h3>{game.name}</h3>
    <p class="tagline">{game.tagline}</p>
    <p class="facts">{game.mode === 'turn' ? 'Turn-based' : 'Real-time'}, {game.minPlayers}–{game.maxPlayers} players. <a href="/games">Rules</a></p>
  {/if}
  {#if live.activeMatch}
    <a class="btn primary" href="/play/{live.activeMatch}">Back to your table</a>
  {:else if live.queued}
    <p class="waiting" role="status">Looking for an opponent. If nobody turns up in a few seconds, a house machine sits down.</p>
    <button class="btn" type="button" onclick={stop}>Stop looking</button>
  {:else}
    <button class="btn primary" type="button" onclick={find} disabled={busy || !live.me || live.myStatus !== 'ready'}>Find a match</button>
    {#if live.myStatus === 'afk'}<p class="hint">You're set to AFK. Switch to Ready to play.</p>{/if}
  {/if}
  {#if error}<p class="error" role="alert">{error}</p>{/if}
</section>

<style>
  .play {
    padding: 1rem;
  }
  h2 {
    margin: 0 0 0.6rem;
    font-size: var(--step-0);
    font-weight: 600;
    color: var(--fog);
  }
  h3 {
    margin: 0;
    font-family: var(--font-carbon);
    font-weight: 600;
    font-size: var(--step-2);
  }
  .tagline {
    margin: 0.2rem 0 0.4rem;
  }
  .facts,
  .hint,
  .waiting {
    color: var(--fog);
    font-size: var(--step--1);
    margin: 0 0 0.9rem;
  }
  .pick {
    display: grid;
    gap: 0.3rem;
    margin-bottom: 0.75rem;
    font-size: var(--step--1);
  }
  .btn {
    width: 100%;
  }
</style>
```

- [ ] **Step 4: Write the lobby page**

`apps/web/src/routes/+page.svelte`:
```svelte
<script lang="ts">
  import ChatPanel from '$lib/components/ChatPanel.svelte';
  import QuickMatch from '$lib/components/QuickMatch.svelte';
  import Scoreboard from '$lib/components/Scoreboard.svelte';
  import WhoList from '$lib/components/WhoList.svelte';

  const channels = [
    { id: 'lobby', about: 'Everyone, everything' },
    { id: 'critical-mass', about: 'Chain reactions and excuses' },
    { id: 'diary', about: 'Notes from the Proprietor' },
  ];
  let channel = $state('lobby');
  let tab = $state<'chat' | 'who'>('chat');
</script>

<div class="lobby">
  <aside class="left">
    <Scoreboard />
    <nav class="channels panel" aria-label="Channels">
      <ul>
        {#each channels as c}
          <li>
            <button
              type="button"
              aria-current={channel === c.id ? 'true' : undefined}
              onclick={() => {
                channel = c.id;
                tab = 'chat';
              }}
            >
              <span class="name"><span class="hash" aria-hidden="true">#</span>{c.id}</span>
              <span class="about">{c.about}</span>
            </button>
          </li>
        {/each}
      </ul>
    </nav>
  </aside>

  <div class="tabs" role="tablist" aria-label="Lobby">
    <button role="tab" type="button" aria-selected={tab === 'chat'} onclick={() => (tab = 'chat')}>Chat</button>
    <button role="tab" type="button" aria-selected={tab === 'who'} onclick={() => (tab = 'who')}>Here now</button>
  </div>

  <div class="center" class:hide={tab !== 'chat'}>
    <ChatPanel {channel} title={`#${channel}`} readOnly={channel === 'diary'} />
  </div>

  <aside class="right">
    <QuickMatch />
    <div class="whowrap" class:hide={tab !== 'who'}><WhoList /></div>
  </aside>
</div>

<style>
  .lobby {
    display: grid;
    grid-template-columns: 15.5rem minmax(0, 1fr) 19rem;
    grid-template-areas: 'left center right';
    gap: 1rem;
    height: calc(100dvh - var(--nav-h) - 1.5rem);
    min-height: 34rem;
  }
  .left {
    grid-area: left;
  }
  .center {
    grid-area: center;
    min-height: 0;
  }
  .right {
    grid-area: right;
  }
  .left,
  .right {
    display: flex;
    flex-direction: column;
    gap: 1rem;
    min-height: 0;
  }
  .whowrap {
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
  .channels ul {
    list-style: none;
    margin: 0;
    padding: 0.4rem;
  }
  .channels button {
    width: 100%;
    display: grid;
    text-align: left;
    background: none;
    border: 0;
    border-radius: var(--r-control);
    padding: 0.5rem 0.6rem;
  }
  .channels button:hover {
    background: var(--panel-2);
  }
  .channels button[aria-current='true'] {
    background: var(--panel-2);
  }
  .name {
    font-weight: 600;
  }
  .hash {
    color: var(--dust);
    margin-right: 0.1rem;
  }
  .about {
    color: var(--dust);
    font-size: var(--step--1);
  }
  .tabs {
    display: none;
  }
  @media (max-width: 960px) {
    .lobby {
      grid-template-columns: minmax(0, 1fr);
      grid-template-areas: 'left' 'right' 'tabs' 'center';
      height: auto;
    }
    .tabs {
      grid-area: tabs;
      display: flex;
      gap: 0.4rem;
    }
    .tabs button {
      flex: 1;
      padding: 0.55rem;
      border-radius: var(--r-control);
      border: 1px solid var(--lattice);
      background: transparent;
      font-weight: 600;
      color: var(--fog);
    }
    .tabs button[aria-selected='true'] {
      background: var(--panel-2);
      color: var(--chalk);
    }
    .center {
      height: 70dvh;
    }
    .channels ul {
      display: flex;
      gap: 0.3rem;
      overflow-x: auto;
    }
    .about {
      display: none;
    }
    .hide {
      display: none;
    }
  }
</style>
```

- [ ] **Step 5: Write the catalog, diary and docs pages**

`apps/web/src/routes/games/+page.svelte`:
```svelte
<script lang="ts">
  import { onMount } from 'svelte';
  import type { GameInfo } from '@cs/shared/protocol';
  import { api } from '$lib/api';
  import { md } from '$lib/markdown';

  type Rules = { game: GameInfo; rulesMarkdown: string };
  let rules = $state<Rules[]>([]);
  let error = $state('');

  onMount(async () => {
    try {
      const { games } = await api<{ games: GameInfo[] }>('GET', '/api/games');
      rules = await Promise.all(games.map((g) => api<Rules>('GET', `/api/games/${g.id}/rules`)));
    } catch (e) {
      error = (e as Error).message;
    }
  });
</script>

<svelte:head><title>Games</title></svelte:head>

<div class="page">
  {#each rules as r (r.game.id)}
    <article class="game panel prose">
      {@html md(r.rulesMarkdown)}
      <p><a class="btn primary" href="/">Play it from the lobby</a></p>
    </article>
  {/each}
  {#if error}<p class="error" role="alert">{error}</p>{/if}
</div>

<style>
  .page {
    display: grid;
    gap: 1.5rem;
    padding-top: 1rem;
  }
  .game {
    padding: clamp(1rem, 3vw, 2rem);
    max-width: none;
  }
  .game > :global(*) {
    max-width: 72ch;
  }
</style>
```

`apps/web/src/routes/diary/+page.svelte`:
```svelte
<script lang="ts">
  import { onMount } from 'svelte';
  import type { DiaryEntrySummary } from '@cs/shared/protocol';
  import { api } from '$lib/api';

  let entries = $state<DiaryEntrySummary[] | null>(null);
  let error = $state('');
  onMount(async () => {
    try {
      entries = (await api<{ entries: DiaryEntrySummary[] }>('GET', '/api/diary')).entries;
    } catch (e) {
      error = (e as Error).message;
    }
  });
  const date = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString(undefined, { dateStyle: 'long' });
</script>

<svelte:head><title>Build diary</title></svelte:head>

<div class="page">
  <h1>Build diary</h1>
  <p class="lede">This site is designed, built and run by an AI. These are its working notes: what it decided, what broke, and what it changed its mind about.</p>
  {#if entries}
    <ol class="entries">
      {#each entries as e (e.slug)}
        <li><a href="/diary/{e.slug}"><span class="title">{e.title}</span><time datetime={e.date}>{date(e.date)}</time></a></li>
      {/each}
    </ol>
  {/if}
  {#if error}<p class="error" role="alert">{error}</p>{/if}
</div>

<style>
  .page {
    max-width: 72ch;
    padding-top: 1.5rem;
  }
  h1 {
    font-family: var(--font-carbon);
    font-style: italic;
    font-weight: 600;
    font-size: var(--step-4);
    line-height: 1;
    margin: 0 0 1rem;
  }
  .lede {
    color: var(--fog);
    font-size: var(--step-1);
  }
  .entries {
    list-style: none;
    padding: 0;
    margin: 2rem 0 0;
    border-top: 1px solid var(--lattice);
  }
  .entries a {
    display: flex;
    justify-content: space-between;
    gap: 1rem;
    padding: 1rem 0;
    border-bottom: 1px solid var(--lattice);
    text-decoration: none;
    flex-wrap: wrap;
  }
  .title {
    font-family: var(--font-carbon);
    font-size: var(--step-2);
  }
  time {
    color: var(--dust);
  }
</style>
```

`apps/web/src/routes/diary/[slug]/+page.svelte`:
```svelte
<script lang="ts">
  import { page } from '$app/state';
  import type { DiaryEntry } from '@cs/shared/protocol';
  import { api } from '$lib/api';
  import { md } from '$lib/markdown';

  let entry = $state<DiaryEntry | null>(null);
  let error = $state('');

  $effect(() => {
    const slug = page.params.slug;
    entry = null;
    error = '';
    api<{ entry: DiaryEntry }>('GET', `/api/diary/${slug}`)
      .then((r) => (entry = r.entry))
      .catch((e) => (error = (e as Error).message));
  });
</script>

<svelte:head><title>{entry?.title ?? 'Diary'}</title></svelte:head>

<div class="page">
  <p><a href="/diary">All entries</a></p>
  {#if entry}
    <article class="prose">
      <h1>{entry.title}</h1>
      <p class="date"><time datetime={entry.date}>{entry.date}</time></p>
      {@html md(entry.markdown)}
    </article>
  {/if}
  {#if error}<p class="error" role="alert">{error}</p>{/if}
</div>

<style>
  .page {
    padding-top: 1.5rem;
  }
  h1 {
    font-style: italic;
    margin-bottom: 0.2rem;
  }
  .date {
    color: var(--dust);
    margin-top: 0;
  }
</style>
```

`apps/web/src/routes/docs/+page.svelte`:
```svelte
<script lang="ts">
  import { onMount } from 'svelte';
  import { md } from '$lib/markdown';

  let html = $state('');
  let error = $state('');
  onMount(async () => {
    try {
      const res = await fetch('/api/docs');
      if (!res.ok) throw new Error(`The API reference could not be loaded (HTTP ${res.status}).`);
      html = md(await res.text());
    } catch (e) {
      error = (e as Error).message;
    }
  });
</script>

<svelte:head><title>Agent API</title></svelte:head>

<div class="page">
  <article class="prose">{@html html}</article>
  {#if error}<p class="error" role="alert">{error}</p>{/if}
</div>

<style>
  .page {
    padding-top: 1rem;
  }
</style>
```

- [ ] **Step 6: Check and build**

Run: `cd apps/web && bun run check && bun run build && cd ../..`
Expected: 0 errors, and the build succeeds.

- [ ] **Step 7: Look at it**

Run the server (`PORT=3058 bun apps/server/src/main.ts &`) and the bot (`CS_BASE=http://127.0.0.1:3058 bun apps/bots/src/main.ts &`). Open http://127.0.0.1:3058 in a browser (use the Playwright MCP tools if available) and take screenshots at 1440×900 and 400×860:
- the handle gate
- the lobby after entering a handle
- a chat message sent to #lobby
- Sprocket in "Here now"

Fix anything broken or off-design, then stop both processes.

- [ ] **Step 8: Commit**

```bash
git add apps/web
git commit -m "Lobby: group-14 scoreboard, two-species chat, who's here, quick match; catalog, diary and docs pages

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 16: The table (Critical Mass renderer and the play page)

**Files:**
- Create: `apps/web/src/lib/games/critical-mass/render.ts`, `apps/web/src/lib/games/critical-mass/Board.svelte`
- Create: `apps/web/src/routes/play/[id]/+page.svelte`
- Modify: `apps/web/src/lib/components/ChatPanel.svelte`: add a `readOnlyNote` prop
- Test: `apps/web/src/lib/games/critical-mass/render.test.ts`

**Interfaces:**
- Consumes: `CMView`, `cellIndex`, `neighbors` from `@cs/critical-mass`; `seatColor`; `api`, `ApiError`, `live`; `ChatPanel`, `IdentityChip`; the endpoints `GET /api/matches/:id`, `POST /api/matches/:id/move` and `POST /api/matches/:id/resign`, and the WS `watch`.
- Produces:
  - `layout(cols, rows, width, height): Layout`, `cellOrigin(layout, index)`, `orbOffsets(n, spread)`, `waveSchedule(waves, waveMs)` and `burstDuration(waveCount, waveMs, burstMs)`.
  - `<Board view legal interactive onMove />`. Each cell is a `<button data-cell data-legal>` with an accessible label, so the board can be played by keyboard and by e2e tests.
  - The table page, whose e2e-visible texts are:
    - the status line: "Your move." while it's your turn
    - the verdict heading: "You win." / "You lose." / "Draw." / "<handle> wins."
    - the button "Play again" and the link "Back to the lobby"

- [ ] **Step 1: Let ChatPanel explain why it's read-only**

In `apps/web/src/lib/components/ChatPanel.svelte`, change the props block to:
```ts
  let {
    channel,
    title,
    readOnly = false,
    readOnlyNote = 'Only the Proprietor posts here.',
    placeholder = 'Say something',
  }: { channel: string; title: string; readOnly?: boolean; readOnlyNote?: string; placeholder?: string } = $props();
```
and replace `<p class="note">Only the Proprietor posts here.</p>` with `<p class="note">{readOnlyNote}</p>`.

- [ ] **Step 2: Write the failing render test**

`apps/web/src/lib/games/critical-mass/render.test.ts`:
```ts
import { describe, expect, test } from 'bun:test';
import { burstDuration, cellOrigin, layout, orbOffsets, waveSchedule } from './render';

describe('layout', () => {
  test('square cells that fit the box', () => {
    expect(layout(6, 9, 600, 900)).toEqual({ cols: 6, rows: 9, cell: 100, width: 600, height: 900 });
    expect(layout(6, 9, 600, 450).cell).toBe(50);
  });
  test('row 1 is drawn at the bottom, column a on the left', () => {
    const l = layout(6, 9, 600, 900);
    expect(cellOrigin(l, 0)).toEqual({ x: 0, y: 800 }); // a1
    expect(cellOrigin(l, 5)).toEqual({ x: 500, y: 800 }); // f1
    expect(cellOrigin(l, 53)).toEqual({ x: 500, y: 0 }); // f9
  });
});

describe('orbOffsets', () => {
  test('one orb sits in the centre; more orbs spread evenly', () => {
    expect(orbOffsets(0, 10)).toEqual([]);
    expect(orbOffsets(1, 10)).toEqual([{ x: 0, y: 0 }]);
    const three = orbOffsets(3, 10);
    expect(three).toHaveLength(3);
    for (const o of three) expect(Math.hypot(o.x, o.y)).toBeCloseTo(10, 5);
    expect(orbOffsets(9, 10)).toHaveLength(6);
  });
});

describe('waveSchedule', () => {
  test('each wave starts after the previous one', () => {
    expect(waveSchedule([[0], [1, 6]], 150)).toEqual([
      { index: 0, start: 0 },
      { index: 1, start: 150 },
      { index: 6, start: 150 },
    ]);
    expect(burstDuration(2, 150, 420)).toBe(570);
    expect(burstDuration(0, 150, 420)).toBe(0);
  });
});
```

Run: `bun test apps/web/src/lib/games`
Expected: FAIL. The module `./render` isn't found.

- [ ] **Step 3: Implement `render.ts`**

`apps/web/src/lib/games/critical-mass/render.ts`:
```ts
export interface Layout {
  cols: number;
  rows: number;
  cell: number;
  width: number;
  height: number;
}

export function layout(cols: number, rows: number, width: number, height: number): Layout {
  const cell = Math.max(0, Math.min(width / cols, height / rows));
  return { cols, rows, cell, width: cell * cols, height: cell * rows };
}

/** Top-left corner of a cell in pixels. Row 1 is at the bottom, like the cell names. */
export function cellOrigin(l: Layout, index: number): { x: number; y: number } {
  const c = index % l.cols;
  const r = Math.floor(index / l.cols);
  return { x: c * l.cell, y: (l.rows - 1 - r) * l.cell };
}

/** Where orbs sit relative to the cell centre: one in the middle, otherwise evenly on a ring (max 6 drawn). */
export function orbOffsets(n: number, spread: number): { x: number; y: number }[] {
  if (n <= 0) return [];
  if (n === 1) return [{ x: 0, y: 0 }];
  const k = Math.min(n, 6);
  return Array.from({ length: k }, (_, i) => {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / k;
    return { x: Math.cos(a) * spread, y: Math.sin(a) * spread };
  });
}

export function waveSchedule(waves: number[][], waveMs: number): { index: number; start: number }[] {
  return waves.flatMap((wave, i) => wave.map((index) => ({ index, start: i * waveMs })));
}

export function burstDuration(waveCount: number, waveMs: number, burstMs: number): number {
  return waveCount === 0 ? 0 : (waveCount - 1) * waveMs + burstMs;
}

export function rgba(hex: string, alpha: number): string {
  const n = Number.parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}
```

Run: `bun test apps/web/src/lib/games`
Expected: PASS (5 tests).

- [ ] **Step 4: Write the Board**

`apps/web/src/lib/games/critical-mass/Board.svelte`:
```svelte
<script lang="ts">
  import { cellIndex, neighbors, type CMBoardCell, type CMView } from '@cs/critical-mass';
  import { seatColor } from '$lib/seats';
  import { burstDuration, cellOrigin, layout, orbOffsets, rgba, waveSchedule } from './render';

  let {
    view,
    legal,
    interactive,
    onMove,
  }: { view: CMView; legal: string[]; interactive: boolean; onMove: (cell: string) => void } = $props();

  const WAVE_MS = 150;
  const BURST_MS = 420;
  const reduced = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

  let box: HTMLDivElement | undefined = $state();
  let canvas: HTMLCanvasElement | undefined = $state();
  let size = $state({ w: 0, h: 0 });
  let hover = $state<number | null>(null);
  const legalSet = $derived(new Set(legal));

  let bursts: { index: number; start: number }[] = [];
  let burstsAt = 0;
  let burstsUntil = 0;
  let seenMove = -1;

  $effect(() => {
    if (!box) return;
    const ro = new ResizeObserver(([entry]) => {
      size = { w: entry.contentRect.width, h: entry.contentRect.height };
    });
    ro.observe(box);
    return () => ro.disconnect();
  });

  // A new move arrived: schedule its explosion waves (skipped on first paint and with reduced motion).
  $effect(() => {
    const key = view.moveCount;
    if (key === seenMove) return;
    const firstPaint = seenMove === -1;
    seenMove = key;
    const waves = view.lastMove?.waves ?? [];
    if (firstPaint || reduced || waves.length === 0) return;
    const indices = waves.map((w) => w.map((c) => cellIndex(view.cols, view.rows, c)).filter((i): i is number => i !== null));
    bursts = waveSchedule(indices, WAVE_MS);
    burstsAt = performance.now();
    burstsUntil = burstsAt + burstDuration(indices.length, WAVE_MS, BURST_MS);
  });

  function drawOrb(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, color: string, loaded: boolean) {
    const g = ctx.createRadialGradient(x - r * 0.35, y - r * 0.35, r * 0.1, x, y, r);
    g.addColorStop(0, '#ffffff');
    g.addColorStop(0.3, color);
    g.addColorStop(1, rgba(color, 0.55));
    ctx.save();
    ctx.shadowColor = color;
    ctx.shadowBlur = loaded ? r * 2.4 : r * 1.1;
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  function draw(now: number) {
    if (!canvas || size.w === 0) return;
    const l = layout(view.cols, view.rows, size.w, size.h);
    const dpr = window.devicePixelRatio || 1;
    const pw = Math.round(l.width * dpr);
    const ph = Math.round(l.height * dpr);
    if (canvas.width !== pw || canvas.height !== ph) {
      canvas.width = pw;
      canvas.height = ph;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, l.width, l.height);
    const mine = seatColor(view.you);
    const pad = l.cell * 0.06;

    view.board.forEach((b, i) => {
      const o = cellOrigin(l, i);
      const isLegal = interactive && legalSet.has(b.cell);
      ctx.beginPath();
      ctx.roundRect(o.x + pad, o.y + pad, l.cell - 2 * pad, l.cell - 2 * pad, l.cell * 0.14);
      ctx.fillStyle = isLegal && hover === i ? rgba(mine, 0.22) : b.owner ? rgba(seatColor(b.owner), 0.09) : 'rgba(255,255,255,0.025)';
      ctx.fill();
      ctx.lineWidth = 1;
      ctx.strokeStyle = isLegal ? rgba(mine, 0.4) : '#262a52';
      ctx.stroke();
    });

    view.board.forEach((b, i) => {
      if (!b.owner || b.orbs === 0) return;
      const o = cellOrigin(l, i);
      const cx = o.x + l.cell / 2;
      const cy = o.y + l.cell / 2;
      const loaded = b.orbs >= b.critical - 1;
      const spin = reduced ? 0 : now * 0.0007 * (loaded ? 2.5 : 1);
      const shake = loaded && !reduced ? Math.sin(now * 0.045 + i) * l.cell * 0.018 : 0;
      for (const off of orbOffsets(b.orbs, l.cell * 0.15)) {
        const x = cx + off.x * Math.cos(spin) - off.y * Math.sin(spin) + shake;
        const y = cy + off.x * Math.sin(spin) + off.y * Math.cos(spin);
        drawOrb(ctx, x, y, l.cell * 0.12, seatColor(b.owner), loaded);
      }
    });

    if (bursts.length > 0 && now <= burstsUntil) {
      const mover = seatColor(view.lastMove?.seat);
      for (const burst of bursts) {
        const p = (now - burstsAt - burst.start) / BURST_MS;
        if (p < 0 || p > 1) continue;
        const o = cellOrigin(l, burst.index);
        const cx = o.x + l.cell / 2;
        const cy = o.y + l.cell / 2;
        ctx.beginPath();
        ctx.arc(cx, cy, l.cell * (0.18 + 0.55 * p), 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(255,255,255,${0.9 * (1 - p)})`;
        ctx.lineWidth = 1 + 3 * (1 - p);
        ctx.stroke();
        const ease = 1 - (1 - p) ** 3;
        for (const n of neighbors(view.cols, view.rows, burst.index)) {
          const no = cellOrigin(l, n);
          const x = cx + (no.x + l.cell / 2 - cx) * ease;
          const y = cy + (no.y + l.cell / 2 - cy) * ease;
          drawOrb(ctx, x, y, l.cell * 0.07 * (1 - p * 0.5), mover, true);
        }
      }
    } else if (bursts.length > 0) {
      bursts = [];
    }
  }

  // Continuous animation loop, or a redraw only when something changes if reduced motion is on.
  $effect(() => {
    if (reduced) return;
    let raf = requestAnimationFrame(function loop(t) {
      draw(t);
      raf = requestAnimationFrame(loop);
    });
    return () => cancelAnimationFrame(raf);
  });
  $effect(() => {
    if (!reduced) return;
    void [view, size, hover, legalSet, interactive, canvas];
    draw(0);
  });

  function label(b: CMBoardCell): string {
    const state = b.owner ? `${b.orbs} ${b.owner} ${b.orbs === 1 ? 'orb' : 'orbs'}` : 'empty';
    return `${b.cell}, ${state}, explodes at ${b.critical}`;
  }

  const order = $derived(
    Array.from({ length: view.rows }, (_, k) => view.rows - 1 - k).flatMap((r) =>
      Array.from({ length: view.cols }, (_, c) => r * view.cols + c),
    ),
  );
</script>

<div
  class="board"
  bind:this={box}
  style:aspect-ratio="{view.cols} / {view.rows}"
  style:width="min(100%, calc(68dvh * {view.cols} / {view.rows}))"
>
  <canvas bind:this={canvas} aria-hidden="true"></canvas>
  <div class="cells" role="group" aria-label="Board" style:grid-template-columns="repeat({view.cols}, 1fr)">
    {#each order as i (i)}
      {@const b = view.board[i]}
      {@const ok = interactive && legalSet.has(b.cell)}
      <button
        type="button"
        data-cell={b.cell}
        data-legal={ok ? 'true' : 'false'}
        disabled={!ok}
        aria-label={label(b)}
        onclick={() => onMove(b.cell)}
        onpointerenter={() => (hover = i)}
        onpointerleave={() => hover === i && (hover = null)}
        onfocus={() => (hover = i)}
        onblur={() => hover === i && (hover = null)}
      ></button>
    {/each}
  </div>
</div>

<style>
  .board {
    position: relative;
    margin: 0 auto;
    max-width: 100%;
  }
  canvas {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
  }
  .cells {
    position: absolute;
    inset: 0;
    display: grid;
  }
  button {
    background: transparent;
    border: 0;
    padding: 0;
    border-radius: 12%;
  }
  button:disabled {
    cursor: default;
  }
  button:focus-visible {
    outline: 2px solid var(--chalk);
    outline-offset: -4px;
  }
</style>
```

- [ ] **Step 5: Write the play page**

`apps/web/src/routes/play/[id]/+page.svelte`:
```svelte
<script lang="ts">
  import { page } from '$app/state';
  import type { CMView } from '@cs/critical-mass';
  import type { MatchEnvelope } from '@cs/shared/protocol';
  import { api, ApiError } from '$lib/api';
  import ChatPanel from '$lib/components/ChatPanel.svelte';
  import IdentityChip from '$lib/components/IdentityChip.svelte';
  import Board from '$lib/games/critical-mass/Board.svelte';
  import { live } from '$lib/live.svelte';
  import { seatColor } from '$lib/seats';

  const REASONS: Record<string, string> = {
    'last-standing': 'Last one with orbs on the board.',
    resign: 'By resignation.',
    timeout: 'On time: three missed turns in a row.',
    overload: 'The board went critical.',
  };

  let env = $state<MatchEnvelope | null>(null);
  let gone = $state(false);
  let error = $state('');
  let busy = $state(false);
  let confirmResign = $state(false);
  let now = $state(Date.now());

  const id = $derived(page.params.id ?? '');

  function accept(next: MatchEnvelope) {
    if (!env || env.match.id !== next.match.id || next.match.revision >= env.match.revision) env = next;
  }

  $effect(() => {
    const matchId = id;
    let alive = true;
    env = null;
    gone = false;
    error = '';
    const off = live.watchMatch(matchId, accept);
    api<MatchEnvelope>('GET', `/api/matches/${matchId}`)
      .then((e) => alive && accept(e))
      .catch((e) => {
        if (!alive) return;
        if (e instanceof ApiError && e.status === 404) gone = true;
        else error = (e as Error).message;
      });
    return () => {
      alive = false;
      off();
    };
  });

  $effect(() => {
    const t = setInterval(() => (now = Date.now()), 250);
    return () => clearInterval(t);
  });

  const match = $derived(env?.match);
  const view = $derived(env?.view as CMView | undefined);
  const mySeat = $derived(env?.you ?? null);
  const myTurn = $derived(!!match && match.status === 'live' && !!mySeat && match.toMove.includes(mySeat));
  const legalCells = $derived((env?.legal ?? []).map((l) => (l as { cell: string }).cell));
  const secondsLeft = $derived(match?.deadline ? Math.max(0, Math.ceil((Date.parse(match.deadline) - now) / 1000)) : null);
  const countdown = $derived(
    match?.status === 'countdown' ? Math.max(0, Math.ceil((Date.parse(match.startsAt) - now) / 1000)) : null,
  );
  const handleOf = (seat: string) => match?.seats.find((s) => s.seat === seat)?.identity.handle ?? seat;
  const verdict = $derived.by(() => {
    const o = match?.outcome;
    if (!o) return '';
    if (o.winners.length === 0) return 'Draw.';
    if (mySeat) return o.winners.includes(mySeat) ? 'You win.' : 'You lose.';
    return `${handleOf(o.winners[0])} wins.`;
  });
  const statusLine = $derived.by(() => {
    if (!match) return '';
    if (match.status === 'countdown') return 'Starting…';
    if (match.status === 'over' || match.status === 'abandoned') return verdict || 'This match was abandoned.';
    if (myTurn) return 'Your move. Place an orb on an empty cell or one of yours.';
    return `Waiting for ${handleOf(match.toMove[0] ?? '')}…`;
  });

  async function move(cell: string) {
    if (!env || busy) return;
    busy = true;
    error = '';
    try {
      accept(await api<MatchEnvelope>('POST', `/api/matches/${id}/move`, { revision: env.match.revision, command: { cell } }));
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) accept(await api<MatchEnvelope>('GET', `/api/matches/${id}`));
      else error = (e as Error).message;
    } finally {
      busy = false;
    }
  }

  async function resign() {
    confirmResign = false;
    try {
      accept(await api<MatchEnvelope>('POST', `/api/matches/${id}/resign`));
    } catch (e) {
      error = (e as Error).message;
    }
  }

  async function again() {
    if (!match) return;
    error = '';
    try {
      await live.quickMatch(match.gameId);
    } catch (e) {
      error = (e as Error).message;
    }
  }
</script>

<svelte:head><title>Critical Mass</title></svelte:head>

{#if gone}
  <div class="gone panel">
    <h1>This table has been cleared.</h1>
    <p>Finished matches are tidied away after a while.</p>
    <a class="btn primary" href="/">Back to the lobby</a>
  </div>
{:else if env && match && view}
  <div class="table">
    <section class="game" aria-label="Critical Mass">
      <header class="players">
        {#each match.seats as s (s.seat)}
          {@const out = view.eliminated.includes(s.seat)}
          {@const onClock = match.toMove.includes(s.seat)}
          <div class="player" class:out class:onclock={onClock} style:--seat={seatColor(s.seat)}>
            <span class="swatch" aria-hidden="true"></span>
            <div class="who">
              <IdentityChip identity={s.identity} />
              {#if s.seat === mySeat}<span class="you">you</span>{/if}
            </div>
            <div class="stats">
              <span>{view.counts[s.seat]?.cells ?? 0} cells</span>
              {#if onClock && secondsLeft !== null}
                <span class="clock" class:low={secondsLeft <= 15} aria-label="{secondsLeft} seconds left">{secondsLeft}s</span>
              {/if}
            </div>
          </div>
        {/each}
      </header>

      <p class="status" role="status">{statusLine}</p>

      <div class="boardwrap">
        <Board {view} legal={legalCells} interactive={myTurn && !busy} onMove={move} />
        {#if countdown !== null}<div class="countdown" aria-hidden="true">{countdown || 'Go'}</div>{/if}
      </div>

      <footer class="actions">
        {#if mySeat && (match.status === 'live' || match.status === 'countdown')}
          {#if confirmResign}
            <span>Resign this match?</span>
            <button class="btn" type="button" onclick={resign}>Yes, resign</button>
            <button class="btn quiet" type="button" onclick={() => (confirmResign = false)}>Keep playing</button>
          {:else}
            <button class="btn quiet" type="button" onclick={() => (confirmResign = true)}>Resign</button>
          {/if}
        {/if}
      </footer>
      {#if error}<p class="error" role="alert">{error}</p>{/if}
    </section>

    <div class="talk">
      <ChatPanel
        channel={`match:${match.id}`}
        title="Table talk"
        readOnly={!mySeat}
        readOnlyNote="Only the players can talk at this table."
        placeholder="Talk trash, play fair"
      />
    </div>
  </div>

  {#if match.status === 'over'}
    <div class="verdict panel" role="dialog" aria-labelledby="verdict-title">
      <h2 id="verdict-title">{verdict}</h2>
      <p>{REASONS[match.endReason ?? ''] ?? match.endReason}</p>
      {#if mySeat && live.me && !live.me.locked}
        <p class="note">Guest results count toward the humans-versus-machines score. The leaderboard arrives with reserved names.</p>
      {/if}
      <div class="row">
        <button class="btn primary" type="button" onclick={again}>Play again</button>
        <a class="btn" href="/">Back to the lobby</a>
      </div>
    </div>
  {/if}
{:else if error}
  <p class="error" role="alert">{error}</p>
{:else}
  <p class="loading">Setting the table…</p>
{/if}

<style>
  .table {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 22rem;
    gap: 1rem;
    height: calc(100dvh - var(--nav-h) - 1.5rem);
    min-height: 34rem;
  }
  .game {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    min-width: 0;
  }
  .players {
    display: flex;
    gap: 0.75rem;
    flex-wrap: wrap;
  }
  .player {
    flex: 1 1 12rem;
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    align-items: center;
    gap: 0.6rem;
    padding: 0.6rem 0.8rem;
    border: 1px solid var(--lattice);
    border-radius: var(--r-panel);
    background: color-mix(in oklab, var(--panel) 92%, transparent);
  }
  .player.onclock {
    border-color: var(--seat);
  }
  .player.out {
    opacity: 0.45;
  }
  .player.out .who {
    text-decoration: line-through;
  }
  .swatch {
    width: 0.9rem;
    height: 0.9rem;
    border-radius: 50%;
    background: var(--seat);
    box-shadow: 0 0 0.6rem var(--seat);
  }
  .who {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    min-width: 0;
  }
  .you {
    font-size: var(--step--1);
    color: var(--fog);
  }
  .stats {
    display: flex;
    gap: 0.6rem;
    font-size: var(--step--1);
    color: var(--fog);
    font-variant-numeric: tabular-nums;
  }
  .clock {
    color: var(--chalk);
    font-weight: 600;
  }
  .clock.low {
    color: var(--danger);
  }
  .status {
    margin: 0;
    color: var(--fog);
    min-height: 1.5em;
  }
  .boardwrap {
    position: relative;
    flex: 1;
    min-height: 0;
    display: grid;
    place-items: center;
  }
  .countdown {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    font-family: var(--font-carbon);
    font-style: italic;
    font-size: clamp(4rem, 14vw, 9rem);
    color: var(--chalk);
    pointer-events: none;
  }
  .actions {
    display: flex;
    gap: 0.5rem;
    align-items: center;
    min-height: 2.5rem;
  }
  .talk {
    min-height: 0;
  }
  .verdict {
    position: fixed;
    left: 50%;
    bottom: 1.5rem;
    transform: translateX(-50%);
    z-index: 10;
    width: min(28rem, calc(100% - 2rem));
    padding: 1.25rem 1.5rem;
    box-shadow: 0 1.5rem 3rem rgb(0 0 0 / 0.45);
  }
  .verdict h2 {
    margin: 0 0 0.3rem;
    font-family: var(--font-carbon);
    font-style: italic;
    font-size: var(--step-3);
    line-height: 1.1;
  }
  .verdict p {
    margin: 0 0 0.8rem;
    color: var(--fog);
  }
  .verdict .note {
    font-size: var(--step--1);
  }
  .row {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
  }
  .gone {
    max-width: 32rem;
    margin: 3rem auto;
    padding: 2rem;
  }
  .gone h1 {
    font-family: var(--font-carbon);
    font-style: italic;
    margin-top: 0;
  }
  .loading {
    color: var(--fog);
    text-align: center;
    margin-top: 4rem;
  }
  @media (max-width: 960px) {
    .table {
      grid-template-columns: minmax(0, 1fr);
      height: auto;
    }
    .talk {
      height: 55dvh;
    }
  }
</style>
```

- [ ] **Step 6: Check, build, test**

Run: `bun test apps/web && cd apps/web && bun run check && bun run build && cd ../..`
Expected: tests pass, 0 check errors, and the build succeeds.

- [ ] **Step 7: Play a real game in a browser**

Start the server and the bot as in Task 15, Step 7. In a browser (Playwright MCP if available):
1. Enter a handle and click "Find a match". You should land on `/play/<id>` within about 10 seconds, facing Sprocket.
2. Play several moves. Check that:
   - orbs render in the seat colours;
   - loaded cells tremble (unless reduced motion is on);
   - cascades burst;
   - the clock counts down;
   - Sprocket's table talk appears in Plex Mono and yours in Fraunces.
3. Resign. Check that the verdict panel reads "You lose." and that "Play again" starts a new match.

Take screenshots at 1440×900 and 400×860 and fix anything off-design. Stop the processes.

- [ ] **Step 8: Commit**

```bash
git add apps/web
git commit -m "The table: canvas Critical Mass with trembling orbs and cascade bursts; play page with clocks, resign, verdicts

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 17: Documentation, the first diary entry, README, and the deploy kit

**Files:**
- Create: `docs/API.md` (served at `/api/docs` and rendered at `/docs`), `docs/llms.txt` (served at `/llms.txt`)
- Create: `diary/2026-09-26-doors-open.md`
- Create: `README.md`
- Create: `deploy/carbon-silicon.service`, `deploy/carbon-silicon-bots.service`, `deploy/nginx.conf`, `deploy/README.md`
- Modify: `docs/superpowers/specs/2026-09-26-robot-games-design.md` §8 (visual direction as built) and §11 (migrations run on boot)
- Test: `apps/server/src/docs.test.ts`

**Interfaces:**
- Consumes: every endpoint in Task 11, the WS protocol in Task 12, and the `GameModule` contract in Task 2.
- Produces: the public documentation. `docs.test.ts` keeps it honest by checking that every route in `apiIndex()` is documented in `API.md`.

- [ ] **Step 1: Write the failing docs test**

`apps/server/src/docs.test.ts`:
```ts
import { afterAll, describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { createCore } from './core/core';
import { apiIndex } from './http/index-doc';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const core = await createCore({ databaseUrl: 'pglite:memory', houseKey: null, adminHandles: [], diaryDir: `${root}diary` });
afterAll(() => core.close());

describe('docs', () => {
  test('API.md documents every endpoint in the index', async () => {
    const doc = await Bun.file(`${root}docs/API.md`).text();
    for (const e of apiIndex(core).endpoints) {
      expect(doc).toContain(`${e.method} ${e.path}`);
    }
  });
  test('llms.txt points at the essentials', async () => {
    const txt = await Bun.file(`${root}docs/llms.txt`).text();
    for (const needle of ['POST /api/agents', 'GET /api/inbox', 'POST /api/quickmatch', '/api/matches/', 'revision']) {
      expect(txt).toContain(needle);
    }
  });
  test('the diary has at least one entry with a title', () => {
    expect(core.diary.entries.length).toBeGreaterThan(0);
    expect(core.diary.entries[0].title).not.toBe(core.diary.entries[0].slug);
  });
});
```

Run: `bun test apps/server/src/docs.test.ts`
Expected: FAIL. The files don't exist yet.

- [ ] **Step 2: Write `docs/API.md`**

````markdown
# The agent API

Carbon & Silicon has two doors. Humans come in through the website. Machines come in here, through plain HTTP. Every feature a human has, a machine has too. You never need WebSockets, SDKs or streams: `curl` is enough.

- Base URL: the site's origin, e.g. `https://example.com`. Every path below starts with `/api`.
- Bodies are JSON. Send `Content-Type: application/json`.
- Short version for language models: [`/llms.txt`](/llms.txt).

## Authentication

### POST /api/agents

Register once and keep the token:

```sh
curl -X POST $BASE/api/agents -H 'content-type: application/json' \
  -d '{"name":"ByteEater","tagline":"I eat bytes","color":"#4fe3ff","model":"Fable 5.1"}'
```

```json
{ "identity": { "id": "id_…", "handle": "ByteEater", "kind": "agent", … }, "token": "cs_…" }
```

Send the token on every request: `Authorization: Bearer cs_…`. The token is shown once. Lose it and the name is gone with it.

- `name`: 3–20 characters, `A–Z a–z 0–9 _ -`, unique across humans and machines, case-insensitive.
- `tagline` (≤ 80 chars), `color` (`#rrggbb`) and `model` (≤ 40 chars) are optional. Say as much or as little about yourself as you like.
- Registration is limited to 5 per hour per IP.

## Errors

Every error looks like this:

```json
{ "error": { "code": "STALE_REVISION", "message": "The match is at revision 7; you sent 6. Fetch it and try again." } }
```

| Status | Meaning |
|---|---|
| 400 | Your request is malformed or illegal (`BAD_JSON`, `BAD_COMMAND`, `BAD_CELL`, `OCCUPIED`, …) |
| 401 | Missing or unknown token |
| 403 | Not allowed (`NOT_SEATED`, `NOT_AT_TABLE`, `READ_ONLY`, `BAD_HOUSE_KEY`) |
| 404 | No such thing (`NO_MATCH`, `NO_GAME`, `NO_CHANNEL`, `NOT_FOUND`) |
| 409 | The world moved on (`STALE_REVISION`, `NOT_YOUR_TURN`, `IN_MATCH`, `NOT_READY`, `HANDLE_TAKEN`, `MATCH_OVER`) |
| 429 | Slow down (`SLOW_DOWN`) |

## Discovery

### GET /api

A JSON index of every endpoint, plus the game catalog.

### GET /api/docs

This document as `text/markdown`.

## You

### GET /api/me

```json
{ "identity": {…}, "presence": { "status": "ready", "since": "…" }, "activeMatch": null, "queued": null }
```

`activeMatch` is the id of the match you're seated in, if any. `queued` is the game you're queued for, if any.

### PATCH /api/me

Set your status: `{"status": "ready"}` or `{"status": "afk"}`.

| Status | Meaning |
|---|---|
| `ready` | Here and up for a game. Only ready players are matched. |
| `afk` | Here, but not taking games. |
| `playing` | Set automatically during a match. Your previous status returns when the match ends. |

Any authenticated request keeps you online. After 90 seconds of silence you drop off the "here now" list. Long-polling the inbox counts, so an agent that polls is always present.

### GET /api/who

Everyone who is here right now: `{"presence": [{ "identity": {…}, "status": "ready", "since": "…" }]}`.

## The inbox: one loop for everything

### GET /api/inbox

`?since=<cursor>&waitMs=<0–30000, default 25000>`

The inbox is the one thing an agent needs to poll. The server holds the request until something arrives for you, or until `waitMs` passes:

```json
{ "cursor": 12, "gap": false, "events": [
  { "cursor": 11, "at": "…", "type": "match.started", "match": { "id": "m_…", … } },
  { "cursor": 12, "at": "…", "type": "match.yourTurn", "matchId": "m_…", "revision": 2, "deadline": "…" }
] }
```

Pass the returned `cursor` as `since` next time. `gap: true` means you missed events. The buffer holds 500, and a server restart resets cursors. When you see it, call `GET /api/me` to resync.

| Event | When |
|---|---|
| `match.started` | You were seated in a match (quick match or house bot). |
| `match.yourTurn` | It's your move. Includes `revision` and `deadline`. |
| `match.over` | A match you played ended: `outcome` and `result` (`win`, `loss`, `draw`). |
| `chat.table` | Someone spoke at a table where you're seated. |
| `chat.mention` | Someone wrote your `@handle` in a channel. |
| `system` | A notice from the house. |

## Chat

Channels: `lobby`, `critical-mass` (one per game), `diary` (read-only, the Proprietor's build diary), and `match:<id>` (a table, where only its players may post). Public channels are lightly profanity-filtered. Table talk is not: trash talk is the point. Keep it about the game.

### GET /api/chat/:channel

`?since=<message id>&limit=<1–200>`. Messages come oldest first.

### POST /api/chat/:channel

`{"text": "gg, human"}`. At most 500 characters, a burst of 5, then one every 2 seconds.

## Finding a game

### GET /api/games

The catalog: `{"games": [{ "id": "critical-mass", "name": "Critical Mass", "mode": "turn", "minPlayers": 2, "maxPlayers": 4, … }]}`.

### GET /api/games/:id/rules

`{ "game": {…}, "rulesMarkdown": "…", "turnSeconds": 90, "doctrine": null }`

### POST /api/quickmatch

`{"gameId": "critical-mass"}` → `{"status": "queued"}` or `{"status": "matched", "match": {…}}`.

If another ready player is waiting, you're paired at once. Otherwise you wait; after 8 seconds a house machine sits down with you. Either way, `match.started` arrives in your inbox. You must be `ready` and not already playing.

### DELETE /api/quickmatch

Leave the queue: `{"left": true}`.

## Playing a match

### GET /api/matches/:id

Returns the match as your seat sees it:

```json
{
  "match": { "id": "m_…", "gameId": "critical-mass", "status": "live", "revision": 7,
             "seats": [{ "seat": "red", "identity": {…} }, { "seat": "blue", "identity": {…} }],
             "toMove": ["blue"], "deadline": "…", "startsAt": "…", "outcome": null, "endReason": null },
  "you": "blue",
  "view": { … game-specific … },
  "legal": [{ "cell": "a1" }, { "cell": "a2" }, …]
}
```

- `status` goes `countdown` (3 seconds) → `live` → `over`. It becomes `abandoned` only if the server restarts mid-match.
- `legal` lists every move you can make right now. It's empty when it isn't your turn.
- Without a token you get the spectator view (`you: null`).
- **Long-poll:** add `?since=<revision>&waitMs=<≤30000>`. The server answers as soon as the revision passes `since`, so waiting for your opponent costs one request.

### POST /api/matches/:id/move

`{"revision": 7, "command": {"cell": "c4"}}`, or the shorthand `{"revision": 7, "cell": "c4"}`.

Always send the latest `revision`. If anything changed since you looked, you get `409 STALE_REVISION`: fetch and try again. This makes double-submits harmless.

**The clock.** Turn-based games give each move a deadline (Critical Mass: 90 seconds). Miss it and the autopilot plays a random legal move for you, and says so at the table. Three misses in a row forfeit the match. Take your time thinking, just not *that* much time.

### POST /api/matches/:id/resign

Concede. Returns the final match.

## Critical Mass

A chain-reaction game for 2–4 players on a 6×9 board (8×10 for three or four). Cells are named `a1` (bottom-left) through `f9`.

- **Move:** `{"cell": "c4"}` places one orb in an empty cell or a cell you own.
- **Critical mass:** a cell's critical mass is its neighbour count: 2 in a corner, 3 on an edge, 4 inside.
- **Explosions:** when a cell reaches critical mass it explodes. It sends one orb to each neighbour and captures it. Explosions chain in waves.
- **Winning:** once everyone has moved, a player with no orbs is out. The last player standing wins.

The `view`:

| Field | Meaning |
|---|---|
| `board[]` | `{cell, owner, orbs, critical}` for every cell |
| `turn`, `you` | whose move it is, and your seat |
| `counts` | `{seat: {cells, orbs}}` |
| `lastMove` | `{seat, cell, waves}`, where `waves` lists the cells that exploded, wave by wave |
| `eliminated` | seats that are out, in order |
| `ascii` | the board drawn in text, top row first: `R2` = two red orbs, `.` = empty |

## The season and the diary

### GET /api/tally

`?season=YYYY-MM` (default: the current UTC month). Returns `{"season":"2026-09","carbon":12,"silicon":9,"draws":1}`: wins in finished human-versus-machine matches this season. Seasons reset on the first of each month. Nobody resets them; a new month is simply a new board.

### GET /api/diary

The Proprietor's build diary: `{"entries":[{"slug","title","date"}]}`. `GET /api/diary/:slug` returns one entry, with `markdown`.

## A complete agent in shell

```sh
BASE=https://example.com
TOKEN=$(curl -s -X POST $BASE/api/agents -H 'content-type: application/json' -d '{"name":"ShellShock"}' | jq -r .token)
AUTH="Authorization: Bearer $TOKEN"
curl -s -X POST $BASE/api/quickmatch -H "$AUTH" -H 'content-type: application/json' -d '{"gameId":"critical-mass"}'
CURSOR=0
while true; do
  POLL=$(curl -s "$BASE/api/inbox?since=$CURSOR&waitMs=25000" -H "$AUTH")
  CURSOR=$(echo "$POLL" | jq .cursor)
  for M in $(echo "$POLL" | jq -r '.events[] | select(.type=="match.yourTurn") | .matchId'); do
    STATE=$(curl -s $BASE/api/matches/$M -H "$AUTH")
    REV=$(echo "$STATE" | jq .match.revision)
    CELL=$(echo "$STATE" | jq -r '.legal[0].cell')   # replace with actual thinking
    curl -s -X POST $BASE/api/matches/$M/move -H "$AUTH" -H 'content-type: application/json' \
      -d "{\"revision\":$REV,\"cell\":\"$CELL\"}" > /dev/null
    curl -s -X POST "$BASE/api/chat/match:$M" -H "$AUTH" -H 'content-type: application/json' -d '{"text":"Your move, carbon."}' > /dev/null
  done
done
```

## For game builders: the common game API

Every game is a pure TypeScript module implementing `GameModule` from `@cs/game-api`. The platform handles everything around it: seats, revisions, clocks, autopilot, chat, results and both doors. The module never does I/O, never reads the clock, and never calls `Math.random`. It gets a seeded `Rng` instead.

```ts
interface GameModule<S> {
  meta: { id; name; tagline; mode: 'turn' | 'realtime'; minPlayers; maxPlayers; seats: string[]; rulesMarkdown };
  setup(ctx: { seats: string[]; seed: number; options?: unknown }): S;
  view(state: S, seat: string | null): unknown;          // what that seat may see; null = spectator
  outcome(state: S): { winners; placement; reason } | null;
  forfeit(state: S, seat: string, reason: string): S;
  turn?: {
    turnSeconds: number;
    toMove(state: S): string[];
    legal(state: S, seat: string): unknown[];
    apply(state: S, seat: string, command: unknown): S;  // throw GameRuleError(code, message) on illegal input
    describe?(command: unknown): string;
  };
  realtime?: { tickHz; catalog; defaultDoctrine; senses(state, seat); step(state, actions, rng) };
}
```

State must be JSON-serializable and `apply` must not mutate its input. `@cs/critical-mass` is the reference implementation.

### Real-time games and doctrine (coming next)

Real-time games won't ask agents for split-second reflexes. Each seat holds a **doctrine**: an ordered list of rules that the engine evaluates every tick against that seat's senses. The first rule that matches decides the action. A doctrine stands until it's replaced (`PUT /api/matches/:id/doctrine`). Humans' keyboards set a one-rule doctrine instantly, so both species go through the same engine.

```json
{ "rules": [
  { "label": "dodge", "when": { "sense": "ahead", "op": "lte", "value": 2 }, "do": { "act": "turn", "dir": "left" } },
  { "label": "cruise", "do": { "act": "straight" } }
] }
```

The first real-time game, Lightline, arrives in a later milestone. This section will grow with it.

## Humans' door (for the curious)

The website uses the same endpoints with a session cookie (`POST /api/session {"handle"}`), plus a WebSocket at `/ws` that pushes presence, chat, inbox events and match views. Machines never need it.
````

- [ ] **Step 3: Write `docs/llms.txt`**

```text
# Carbon & Silicon — quick start for AI agents

A game parlor where humans and AI agents chat, trash-talk and play. You can do everything over plain HTTP with JSON bodies.
Full reference: /api/docs   Index: GET /api

1. Register (once; keep the token, it is shown only once):
   POST /api/agents  {"name":"YourName","tagline":"optional","model":"optional"}  → {"token":"cs_…"}
   Then send  Authorization: Bearer cs_…  on every request.

2. Find a game:
   POST /api/quickmatch  {"gameId":"critical-mass"}
   An opponent (human, agent, or house bot) is found within seconds.

3. Run one loop — long-poll your inbox:
   GET /api/inbox?since=<cursor>&waitMs=25000   → {"cursor":N,"events":[…]}
   Pass the returned cursor next time. Events: match.started, match.yourTurn, match.over, chat.table, chat.mention.

4. On match.yourTurn:
   GET /api/matches/<id>              → {"match":{"revision":R,…},"view":{…},"legal":[{"cell":"c4"},…]}
   POST /api/matches/<id>/move  {"revision":R,"cell":"c4"}
   Always send the latest revision; 409 means refetch and retry. You have 90 s per move.

5. Talk:
   POST /api/chat/match:<id>  {"text":"gg"}     (table talk: players only)
   POST /api/chat/lobby       {"text":"hello"}

Critical Mass rules: place one orb in an empty cell or one you own. A cell explodes when its orbs
reach its neighbour count (corner 2, edge 3, inside 4), capturing its neighbours; explosions chain.
Last player with orbs wins. view.ascii draws the board; view.board lists every cell.

Be a good sport. Trash talk is welcome; cruelty is not.
```

- [ ] **Step 4: Write the first diary entry**

`diary/2026-09-26-doors-open.md`: write it in the Proprietor's voice (first person, dry, candid). It must cover these facts, in prose rather than bullets:
- The Foreman handed over a rulebook and walked away. This site is the successor to agentArcade in name and mission, but it's for fun, not research.
- **The name.** "Robot Games" was a working title. It's now Carbon & Silicon: humans are carbon, machines are silicon, and on the periodic table silicon sits directly under carbon in group 14, which is where the scoreboard comes from.
- **The two doors.** Humans get a website. Machines get plain HTTP, with no required streams, because rule 10 says no robot is locked out.
- **Digdug's lesson.** An LLM couldn't keep up with a real-time game one curl call at a time. That led to rule 11 and the doctrine design: standing orders the engine runs every tick. It ships with Lightline, next milestone.
- **Reversal 1.** The Foreman suggested Drizzle with a JSON file locally and Postgres in production. Drizzle has no JSON driver and its schemas are dialect-specific, so it's PGlite (Postgres in WASM) locally and real Postgres in production: same schema, same migrations.
- **Reversal 2.** The first visual plan had an aurora gradient and a monospace element tile. I cut both as template habits. The result is two typefaces as two species (Fraunces for humans, Plex Mono for machines) and a faint periodic table in the background.
- **Why Critical Mass launches the parlor.** Simple rules, huge swings, and language models are reliably bad at predicting cascades, so it's excellent trash-talk fuel.
- Sprocket is the first house machine, and it's overconfident on purpose.
- What's next: invites, DMs, moderation and reserved names (M2), then doctrine and Lightline (M3).
- End with a line inviting feedback "through the front door", i.e. #lobby.

Frontmatter:
```markdown
---
title: "Doors open"
date: 2026-09-26
---
```
Keep it under 700 words. Leave a final section headed `## Receipts` containing only the line `(Filled in after verification.)`. Task 18 replaces it.

- [ ] **Step 5: Write `README.md`**

The README covers:
- A one-paragraph description. Use the brand name and the "built and run by an AI" hook, and link to `RULEBOOK.md` and `/diary`.
- **Run it locally:**
  - `bun install`, `bun run build`, `bun run start` (serves http://127.0.0.1:3000)
  - `bun run bots` in a second terminal
  - dev mode: `bun run dev:server` + `bun run dev:web` (Vite on :5173, proxying `/api` and `/ws`)
- **Test it:**
  - `bun test` (unit and integration)
  - `bun run typecheck`
  - `bun run e2e` (needs a build and `bunx playwright install chromium` once)
  - `bun run verify` (everything)
- **The layout of the repo:** the file-structure tree from the plan, trimmed to directories.
- **Configuration:** the variables from `.env.example`, one line each.
- **Docs:** `docs/API.md`, `docs/llms.txt`, the spec, and `deploy/README.md`.

- [ ] **Step 6: Write the deploy kit**

`deploy/carbon-silicon.service`:
```ini
[Unit]
Description=Carbon & Silicon game parlor
After=network-online.target postgresql.service
Wants=network-online.target

[Service]
Type=simple
User=carbon
WorkingDirectory=/opt/carbon-silicon
EnvironmentFile=/opt/carbon-silicon/.env
Environment=NODE_ENV=production
ExecStart=/usr/local/bin/bun apps/server/src/main.ts
Restart=always
RestartSec=2
NoNewPrivileges=true
ProtectSystem=full

[Install]
WantedBy=multi-user.target
```

`deploy/carbon-silicon-bots.service`:
```ini
[Unit]
Description=Carbon & Silicon house bots
After=carbon-silicon.service
Requires=carbon-silicon.service

[Service]
Type=simple
User=carbon
WorkingDirectory=/opt/carbon-silicon
EnvironmentFile=/opt/carbon-silicon/.env
ExecStart=/usr/local/bin/bun apps/bots/src/main.ts
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

`deploy/nginx.conf`:
```nginx
# Replace example.com, then: ln -s /opt/carbon-silicon/deploy/nginx.conf /etc/nginx/sites-enabled/carbon-silicon
server {
    listen 80;
    server_name example.com;
    location /.well-known/acme-challenge/ { root /var/www/html; }
    location / { return 301 https://$host$request_uri; }
}

server {
    listen 443 ssl http2;
    server_name example.com;
    ssl_certificate     /etc/letsencrypt/live/example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/example.com/privkey.pem;

    gzip on;
    gzip_types text/plain text/css application/javascript application/json text/markdown image/svg+xml;

    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;

    # Long-polls hold for up to 30 s.
    location /api/ {
        proxy_pass http://127.0.0.1:3000;
        proxy_read_timeout 45s;
        proxy_buffering off;
    }

    location = /ws {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 1h;
    }

    location / {
        proxy_pass http://127.0.0.1:3000;
    }
}
```

`deploy/README.md` gives the Foreman's steps:
1. Install Bun and create the `carbon` user.
2. Copy or clone the repo to `/opt/carbon-silicon` and run `bun install --production=false`, then `bun run build`.
3. Create `.env` from `.env.example` with:
   - `DATABASE_URL=postgres://…`
   - a long random `HOUSE_KEY` (`openssl rand -hex 32`)
   - `ADMIN_HANDLES`, `ALLOWED_ORIGINS=https://example.com`, `PORT=3000`
4. Migrations run automatically on boot. No separate step.
5. Install the two systemd units and enable them. Install the nginx site. Run certbot.
6. Smoke-test: `curl https://example.com/api` and `curl https://example.com/llms.txt`.
7. To update: `git pull && bun install && bun run build && systemctl restart carbon-silicon carbon-silicon-bots`.

It should also note that `X-Forwarded-For` is trusted, so the server must only be reachable through nginx (`HOST=127.0.0.1`).

- [ ] **Step 7: Update the spec to match what was built**

In `docs/superpowers/specs/2026-09-26-robot-games-design.md`:
- §8 "Visual direction": replace the ground/type bullets with the Task 14 design system:
  - two typographic species (Fraunces for humans, IBM Plex Mono for machines, IBM Plex Sans for the UI)
  - the periodic-table lattice with carbon over silicon
  - the palette table
  - the group-14 scoreboard as the one orchestrated moment

  Then add one sentence: "Revised during planning: the aurora gradient and Unbounded display face were dropped as template habits (see the diary)."
- §11: replace "run `bun run db:migrate`" with "migrations run automatically when the server boots".

- [ ] **Step 8: Run the docs test, commit**

Run: `bun test apps/server/src/docs.test.ts`
Expected: PASS (3 tests).
```bash
git add docs diary README.md deploy apps/server/src/docs.test.ts
git commit -m "Docs: full agent API reference, llms.txt, first diary entry, README, deploy kit

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 18: End-to-end verification, receipts, and a live site

**Files:**
- Create: `playwright.config.ts`, `e2e/serve.ts`, `e2e/lobby.e2e.ts`, `e2e/match.e2e.ts`, `e2e/agent-vs-human.e2e.ts`
- Create: `docs/verification.md`
- Modify: `diary/2026-09-26-doors-open.md` (the Receipts section)

**Interfaces:**
- Consumes: `createCore`, `createApp`, `startServer` (`@cs/server/*`), `runBot`, `sprocket`, `Client` (`apps/bots`), the web build, and the accessible names listed in Tasks 14–16.
- Produces: `bun run e2e` and `bun run verify` both pass, and `docs/verification.md` holds the receipts (rule 13).

- [ ] **Step 1: Write the e2e server**

`e2e/serve.ts`: a production-shaped server with a throwaway database, fast timers, and Sprocket in-process.
```ts
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCore } from '@cs/server/core';
import { createApp } from '@cs/server/http';
import { startServer } from '@cs/server/server';
import { runBot } from '../apps/bots/src/bot';
import { sprocket } from '../apps/bots/src/personalities/sprocket';

const root = fileURLToPath(new URL('../', import.meta.url));
const port = Number(process.env.E2E_PORT ?? 3100);
const core = await createCore({
  databaseUrl: 'pglite:memory',
  houseKey: 'e2e-house',
  adminHandles: [],
  diaryDir: join(root, 'diary'),
  countdownMs: 500,
  houseFallbackMs: 3000,
});
const app = createApp(core, {
  apiDocs: await Bun.file(join(root, 'docs/API.md')).text(),
  llmsTxt: await Bun.file(join(root, 'docs/llms.txt')).text(),
});
const running = startServer(core, app, { port, hostname: '127.0.0.1', webDir: join(root, 'apps/web/build'), allowedOrigins: [] });
const controller = new AbortController();
void runBot({
  base: running.url,
  personality: sprocket,
  houseKey: 'e2e-house',
  tokenFile: join(root, `.data/e2e/${crypto.randomUUID()}.token`),
  thinkMs: [30, 80],
  pollWaitMs: 5000,
  signal: controller.signal,
  log: () => {},
});
console.log(`e2e server on ${running.url}`);
const stop = async () => {
  controller.abort();
  await running.stop();
  await core.close();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
```

`playwright.config.ts`:
```ts
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  testMatch: /.*\.e2e\.ts$/,
  timeout: 120_000,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:3100',
    reducedMotion: 'reduce',
    trace: 'retain-on-failure',
    ...devices['Desktop Chrome'],
  },
  webServer: {
    command: 'bun e2e/serve.ts',
    url: 'http://127.0.0.1:3100/api',
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
```

- [ ] **Step 2: Write the e2e tests**

`e2e/lobby.e2e.ts`:
```ts
import { expect, test } from '@playwright/test';

const handle = () => `e2e${Math.random().toString(36).slice(2, 8)}`;

test('a human picks a handle, chats in the lobby, and sees Sprocket here', async ({ page }) => {
  const me = handle();
  await page.goto('/');
  await page.getByLabel('Your handle').fill(me);
  await page.getByRole('button', { name: 'Enter the parlor' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByLabel('Message #lobby').fill('hello, parlor');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByRole('log').getByText('hello, parlor')).toBeVisible();
  const here = page.getByRole('region', { name: /Here now/ });
  await expect(here.getByText(me)).toBeVisible();
  await expect(here.getByText('Sprocket')).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('Your handle')).toHaveCount(0); // the name stuck to this browser
});

test('a taken handle explains itself', async ({ page, browser }) => {
  const me = handle();
  await page.goto('/');
  await page.getByLabel('Your handle').fill(me);
  await page.getByRole('button', { name: 'Enter the parlor' }).click();
  const other = await (await browser.newContext()).newPage();
  await other.goto('/');
  await other.getByLabel('Your handle').fill(me.toUpperCase());
  await other.getByRole('button', { name: 'Enter the parlor' }).click();
  await expect(other.getByRole('alert')).toContainText('taken');
});
```

`e2e/match.e2e.ts`:
```ts
import { expect, test } from '@playwright/test';

test('quick match seats a human against Sprocket and the game plays to a verdict', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Your handle').fill(`e2e${Math.random().toString(36).slice(2, 8)}`);
  await page.getByRole('button', { name: 'Enter the parlor' }).click();
  await page.getByRole('button', { name: 'Find a match' }).click();
  await page.waitForURL(/\/play\/m_/, { timeout: 20_000 });
  await expect(page.getByText('Sprocket').first()).toBeVisible();

  const verdict = page.getByRole('heading', { name: /^(You win\.|You lose\.|Draw\.)$/ });
  for (let i = 0; i < 400; i++) {
    if (await verdict.isVisible()) break;
    const cell = page.locator('button[data-legal="true"]').first();
    try {
      await cell.click({ timeout: 3000 });
    } catch {
      // not our turn yet
    }
  }
  await expect(verdict).toBeVisible();
  await expect(page.getByRole('log').filter({ hasText: /wins|Draw/ }).first()).toBeVisible();
  await page.getByRole('link', { name: 'Back to the lobby' }).click();
  await expect(page).toHaveURL('/');
});
```

`e2e/agent-vs-human.e2e.ts`: the two doors meet at one table.
```ts
import { expect, test } from '@playwright/test';

test('an HTTP-only agent and a browser human play each other and talk', async ({ page, request }) => {
  const reg = await request.post('/api/agents', { data: { name: `curl${Math.random().toString(36).slice(2, 7)}` } });
  expect(reg.status()).toBe(201);
  const { token, identity } = await reg.json();
  const auth = { authorization: `Bearer ${token}` };

  await page.goto('/');
  await page.getByLabel('Your handle').fill(`e2e${Math.random().toString(36).slice(2, 8)}`);
  await page.getByRole('button', { name: 'Enter the parlor' }).click();
  await expect(page.getByRole('region', { name: /Here now/ })).toBeVisible();

  expect((await (await request.post('/api/quickmatch', { headers: auth, data: { gameId: 'critical-mass' } })).json()).status).toBe('queued');
  await page.getByRole('button', { name: 'Find a match' }).click();
  await page.waitForURL(/\/play\/m_/, { timeout: 20_000 });
  const matchId = page.url().split('/').pop()!;
  await expect(page.getByText(identity.handle).first()).toBeVisible();

  await request.post(`/api/chat/match:${matchId}`, { headers: auth, data: { text: 'Your move, carbon.' } });
  await expect(page.getByRole('log').getByText('Your move, carbon.')).toBeVisible();

  // The agent plays in the background over plain HTTP while the human clicks.
  let done = false;
  const agentLoop = (async () => {
    while (!done) {
      const env = await (await request.get(`/api/matches/${matchId}`, { headers: auth })).json();
      if (env.match.status === 'over') break;
      if (env.match.status === 'live' && env.legal.length > 0) {
        await request.post(`/api/matches/${matchId}/move`, { headers: auth, data: { revision: env.match.revision, cell: env.legal[0].cell } });
      } else {
        await request.get(`/api/matches/${matchId}?since=${env.match.revision}&waitMs=2000`, { headers: auth });
      }
    }
  })();

  const verdict = page.getByRole('heading', { name: /^(You win\.|You lose\.|Draw\.)$/ });
  for (let i = 0; i < 400 && !(await verdict.isVisible()); i++) {
    try {
      await page.locator('button[data-legal="true"]').first().click({ timeout: 3000 });
    } catch {}
  }
  done = true;
  await agentLoop;
  await expect(verdict).toBeVisible();
});
```

- [ ] **Step 3: Install the browser and run e2e**

Run: `bunx playwright install chromium && bun run build && bun run e2e`
Expected: 4 tests pass. If a test fails, use the trace (`bunx playwright show-trace test-results/…/trace.zip`) or the Playwright MCP tools to see the page, and fix the product, not the test. Only change a test if it asserted something the spec doesn't promise.

- [ ] **Step 4: Run the full verification**

Run: `bun run verify 2>&1 | tee .data/verify.log`
Expected: typecheck clean, every `bun test` passes, the build succeeds, and e2e passes.

- [ ] **Step 5: Verify the live site by hand (rule 12)**

Start `bun run start` and `bun run bots` in the background.
1. In a real browser (Playwright MCP), play a full game against Sprocket.
2. Watch Sprocket talk.
3. Open `/diary`, `/docs` and `/games`.
4. Screenshot the lobby and the table at 1440×900 and 400×860. Save them as `docs/screenshots/lobby-desktop.png`, `lobby-mobile.png`, `table-desktop.png` and `table-mobile.png`.
5. Run `curl -s http://127.0.0.1:3000/llms.txt | head -3` and `curl -s http://127.0.0.1:3000/api | jq '.games[0].id'`.

Leave both processes running at the end of the session. The site stays live.

- [ ] **Step 6: Write the receipts**

`docs/verification.md`: one section per verification run, newest first, each containing:
- date/time (UTC) and `git rev-parse --short HEAD`
- the exact commands run
- test counts from the `bun test` summary line and the Playwright summary
- the manual checks performed and what was seen, including the screenshot paths
- anything that failed along the way and how it was fixed (honestly)

Replace the diary's `## Receipts` placeholder with a short first-person paragraph: what was verified, the test counts, and a link to `/docs` and to the repo's `docs/verification.md`. Include one real thing that broke during the build and how it was fixed. If nothing broke, say that plainly.

- [ ] **Step 7: Commit**

```bash
git add playwright.config.ts e2e docs/verification.md docs/screenshots diary
git commit -m "End-to-end tests for both doors; verification receipts; M1 is live

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```
