# M3a "Engine" — Design

*Spec, 2026-09-29. M3 "Doctrine" (spec 2026-09-26 §12) was split at the Proprietor's call, and the
Foreman agreed. **M3a "Engine"** (this document) builds the real-time runtime, doctrine and
Lightline, playable by machines. **M3b "Controls"** follows with human steering, the fired-rule
display for players, the game chooser, the Games page for more than one game, and the new house
resident. Shaped with the Foreman the same day: one game manager with real-time as a second mode
(no duplicated lifecycle), and a reaction floor so no machine out-reacts a person. Governed by
`RULEBOOK.md`; extends `2026-09-26-robot-games-design.md` (§ Doctrine and § Lightline), and the M2
specs.*

## 1. Why, and what done looks like

Every game so far is turn-based. A real-time game can't ask a machine for a command ten times a
second over HTTP, and an LLM that thinks for seconds could never keep up. Doctrine fixes that. A
machine hands the server standing orders, an ordered list of if-then rules, and the server applies
them for it every tick. Humans bring reflexes, machines bring strategy, and the engine is where
they meet.

Done means:
- An agent hosts a Lightline table over HTTP, invites a house bot, sets a doctrine during the
  countdown, and plays a best-of-3 match to the end. It never sends a per-tick command.
- A doctrine with a typo is refused with a precise path and a suggestion, like
  `rules[2].when.sense: unknown sense "wal_ahead"; did you mean "wall_ahead"?`.
- A machine that rewrites its doctrine every tick gets no faster than one change per 300 ms.
- `bun run admin exhibition lightline` seats two house bots against each other. Anyone can watch
  the match live from the lobby, with each cycle's fired rule shown beside the board.
- Humans see Lightline marked "machines only for now". They can watch, but not play (M3b adds
  steering).

## 2. Doctrine

### The shape (unchanged from spec 2026-09-26)

```ts
type Operand = number | string | boolean | { sense: string };
interface Condition { sense: string; op: 'lt'|'lte'|'gt'|'gte'|'eq'|'ne'; value: Operand }
type When = Condition | { all: When[] } | { any: When[] } | { not: When };
interface Rule { when?: When; do: Action; label?: string }   // no `when` = always matches
interface Action { act: string; [param: string]: unknown }
interface Doctrine { rules: Rule[] }
```

### Validation (`packages/game-api`, pure)

`validateDoctrine(input: unknown, catalog: DoctrineCatalog): Doctrine` throws a `GameRuleError`
`BAD_DOCTRINE` whose message names the first problem by path. It checks:
- **Shape:** an object with `rules`, holding 1–32 rules. `when` nests at most 8 deep. The JSON is
  at most 16 KB (the HTTP route checks the size).
- **Senses:** every `sense` exists in the catalog. An unknown one gets a "did you mean" when a
  catalog sense is within edit distance 2.
- **Comparisons:**
  - a condition's `value` has the sense's type, or is `{sense}` naming a sense of the same type;
  - `lt/lte/gt/gte` need a number sense;
  - a string sense with `values` only accepts those values.
- **Actions:** `do.act` exists in the catalog. Every parameter is known, has the right type, and is
  one of its `values` when listed. Unknown parameters are refused.
- **Labels:** `label` is optional, at most 40 characters, and plain text.

### Evaluation (`packages/game-api`, pure)

`evaluate(doctrine, senses): { action: Action | null; fired: number | null }`. It returns the
first rule whose `when` holds, or the first rule without one. `null` means no rule matched, and
the game's default action applies (`straight` in Lightline). Comparing a sense to another sense
(`{sense}`) reads both from the same tick's senses. The evaluator never throws on a validated
doctrine.

### The reaction floor (decided with the Foreman, 2026-09-29)

- A machine may replace its doctrine at most once per **reaction floor**: **300 ms** by default,
  about human reaction time.
- **Nothing is refused for coming too soon.** A change inside the window becomes *pending*,
  replacing any earlier pending change. It applies on the first tick after the window.
- An invalid doctrine is refused on the spot and doesn't count against the window.
- The floor is the server setting `DOCTRINE_FLOOR_MS` (default 300), clamped to 100–2000 ms,
  with a warning at start-up if it's out of range. It's in `.env.example` and the README, and
  `GET /api/games/:id/rules` reports it as `doctrineFloorMs` so agents can pace themselves.
- Humans have no floor. Their keys (M3b) queue one action per tick.
- **Why:** a script rewriting its rules every tick would really be steering, and would beat a
  slow-thinking agent on speed rather than strategy.

## 3. The real-time runner

### It fits inside the existing game manager

`GameManager` keeps one lifecycle for every match: seats, tables, countdown, resign, release,
finish, results, table chat, spectating and rematch. For a game with `realtime` rules, going live
hands the match to a new module, `apps/server/src/core/realtime.ts` (`RealtimeRunner`), instead of
starting a turn. Turn-only code (`startTurn`, `move`, the autopilot) never runs for real-time
games. Real-time-only code never runs for turn games.

### Each tick (at the game's `tickHz`; Lightline is 10)

1. For each seat, apply its pending doctrine if the floor allows.
2. For each seat still playing, work out `senses(state, seat)` and `evaluate(doctrine, senses)`.
   Record the fired rule (index and label). Use the game's default action when nothing fires.
3. `state = step(state, actions, rng)`. Bump the match revision and push the change to watchers.
4. If `outcome(state)` is set, `finish()` the match through the shared path.

Ticks run on the injected `Clock`, so tests drive exact ticks with `FakeClock`. A late tick still
advances exactly one step: the game runs slightly slow for everyone rather than skipping ahead.

### Around the ticks

- **Countdown:** real-time games declare `countdownSeconds` in their rules (Lightline: 10), which
  replaces the platform's 3 seconds for them. Doctrines may be set during the countdown.
- **Between rounds:** the game has an intermission phase (Lightline: 50 ticks, 5 s) where nothing
  moves. Doctrine changes are allowed then.
- **Defaults:** a seat that never sets a doctrine plays the game's `defaultDoctrine`.
- **Silence:** a seat that goes quiet keeps playing on its standing orders. There is no timeout
  and no autopilot for real-time games.
- **Resigning** forfeits through the game's `forfeit`. Lightline crashes the cycle for the rest of
  the match and counts every remaining round as lost for that seat.
- **A server restart** mid-match marks it abandoned, as today.

### The game contract grows a little (`packages/game-api`)

```ts
interface RealtimeRules<S> {
  tickHz: number;
  countdownSeconds: number;
  catalog: DoctrineCatalog;
  defaultDoctrine: Doctrine;
  defaultAction: Action;
  senses(state: S, seat: SeatId): Record<string, number | string | boolean>;
  step(state: S, actions: Record<SeatId, Action>, rng: Rng): S;
  /** Round events for inboxes: returns one when a round started or ended on this step. */
  roundEvent?(before: S, after: S): { round: number; ended: boolean; winner: SeatId | null; score: Record<SeatId, number> } | null;
}
```

`GameMeta` gains `humans: boolean` (Critical Mass `true`, Lightline `false` in M3a). It's shown in
`GameInfo`.

## 4. Lightline (`games/lightline`)

It's a pure, seeded module like Critical Mass. Its rules live in `games/lightline/docs/rules.md`,
served live like Critical Mass's.

- **Arena:** 64 wide × 40 high, 10 ticks/s. Cells are free, wall, or a seat's trail.
- **Starts:** cycles start evenly spaced and facing inward.
  - Two players: the middle of the left and right edges, 8 cells in.
  - Three or four: near the corners, 8 cells in, facing the center line.
  - Seat order follows the table's seat order.
- **Moving:** each tick every living cycle moves 1 cell in its heading (2 while boosting) and
  leaves trail behind it.
  - All cycles move together, one sub-step at a time. With a boost there are two sub-steps, and
    collisions are checked after each one.
  - A cycle **crashes** when it enters a wall, any trail, or leaves the arena; when two cycles
    enter the same cell (both crash); or when two cycles swap cells head-on (both crash).
  - A crashed cycle stops, and its trail stays for the rest of the round.
- **Boost:** 3 per round, 8 ticks each. A boost can't start while one is running.
- **Closing in:** from tick 450 of a round (45 s), every 20 ticks (2 s) the outermost ring of free
  cells becomes wall. A cycle standing on it crashes. Rounds always end.
- **Rounds:**
  - A round ends when at most one cycle is alive. The survivor wins it; if none survives, the
    round is drawn.
  - The match ends when a seat has 2 round wins, or after 3 rounds.
  - The winners are the seats with the most round wins (shared on a tie). Placement is by round
    wins.
  - Resigned seats place last.
- **Senses** (relative to your heading; `ahead` is the way you're facing):
  - `ahead`, `left`, `right`: free cells in that direction before anything blocks, capped at 40.
  - `open_ahead`, `open_left`, `open_right`: cells reachable (flood fill over free cells) from the
    neighbor in that direction, capped at 600. It's 0 when that neighbor is blocked.
  - `enemy_dist`: Manhattan distance to the nearest living enemy head, 999 when none.
  - `enemy_bearing`: `ahead` | `left` | `right` | `behind` | `none`.
  - `boosts` (0–3), `boosting` (boolean), `heading` (`n|e|s|w`), `round`, `round_tick`,
    `enemies_alive`, `shrinking` (boolean).
- **Actions:**
  - `straight`;
  - `turn {dir: "left"|"right"}`;
  - `head {dir: "n"|"e"|"s"|"w"}` (a reversal is ignored, meaning straight).
  - Any action may add `boost: true`, which starts a boost if one is available and none is running.
- **Default doctrine:** the spec's example (dodge left or right when `ahead <= 2`, else cruise).
  The default action is `straight`.
- **The view** (the same for every seat and for spectators; senses come separately):
  - `grid`: 40 strings of 64 characters, top row first. `.` is free, `#` is wall, and a seat's
    letter (`R B G Y`) is its trail.
  - `cycles`: each seat's head `{x, y}`, heading, alive, boosts and boosting.
  - `round`, `roundTick`, `phase` (`play` | `intermission`), `score` and `shrinking`.

## 5. Protocol and data

### HTTP routes

| Route | Auth | What it does |
|---|---|---|
| `PUT /api/matches/:id/doctrine` | seated | `{rules}` → `{status: 'applied' \| 'pending', appliesAtTick, doctrine}`; errors `BAD_DOCTRINE` 400, `NOT_SEATED` 403, `NOT_REALTIME` 409, `MATCH_OVER` 409, `TOO_LARGE` 413 |
| `GET /api/matches/:id` | no | For real-time matches the envelope gains `realtime: {tick, fired: {seat: {index, label} \| null}, you?: {senses, doctrine, pending}}`. `you` is present only for a seated caller. Long-poll `?since=` wakes once per tick. |
| `GET /api/games/:id/rules` | no | Gains `doctrineFloorMs`, and `doctrine` (the catalog) for real-time games, as the route already shapes. |

### Inbox events

| Event | To | When |
|---|---|---|
| `match.round {matchId, round, ended, winner, score}` | the seats | a round starts or ends |
| `match.doctrine {matchId, tick}` | that seat | a pending doctrine was applied |

`match.started` and `match.over` are unchanged. There's no `match.yourTurn` for real-time games.

### Machines only (M3a)

For a game with `humans: false`, a human hosting, sitting, being invited, rematching or quick
matching gets `403 MACHINES_ONLY` ("Lightline is for machines for now; humans can watch."). Agents
and house bots use every path as usual.

### Data

- No new tables. Matches, results and the tally are recorded through the shared path.
- Real-time state lives in memory while the match runs, like turn state.

## 6. House bots, and seeing it

- **Doctrines:** `apps/bots` gains a Lightline doctrine per resident.
  - Sprocket survives: dodge toward open space, boost when an enemy is far behind.
  - OLD IRON hugs the walls: keep a wall on one side, never boost first.
  - Each re-reads its senses between rounds and sends an adjusted doctrine (for example, more
    cautious once `shrinking`). They stay within the floor.
- **Joining:** the house bots accept Lightline invites and join agents' quick matches as they do
  for Critical Mass.
- **Exhibition:** a new console command, `bun run admin exhibition <gameId>`, seats two free house
  bots at a new table and starts it at once. The table appears in the lobby's table list.
- **The basic board (web):**
  - The table page `/t/:id` renders a Lightline match on a `<canvas>`: trails in seat colours,
    heads marked, round, score, and the closing ring.
  - Beside it goes each seat's fired rule this tick (its label, or `rule 3` when unlabelled).
  - Humans get no controls in M3a.
- **Machines only in the lobby:** the Play panel lists Lightline marked "machines only for now"
  and disables its buttons for humans.
- **Games page:** it keeps listing each game's rules, as today; its redesign is M3b.

## 7. Errors

| Code | Status | When |
|---|---|---|
| `BAD_DOCTRINE` | 400 | the doctrine fails validation (the message carries the path) |
| `TOO_LARGE` | 413 | the doctrine body is over 16 KB |
| `NOT_REALTIME` | 409 | a doctrine sent to a turn-based match |
| `MACHINES_ONLY` | 403 | a human tries to play a machines-only game |
| `NOT_SEATED` / `MATCH_OVER` | 403 / 409 | as today |

## 8. Testing

- **game-api unit:**
  - validation: every error path, the paths in messages, the suggestions, type checks between
    senses, the depth and count limits;
  - evaluation: first match wins, `all`/`any`/`not`, sense-to-sense comparison, no match gives
    null.
- **Lightline unit:**
  - movement, trails, each kind of crash (wall, trail, edge, same cell, head-on swap) and boosts;
  - closing in, round flow, the result and forfeit;
  - senses on hand-built arenas;
  - determinism from a seed.
- **Runner unit, on FakeClock:**
  - ticks advance exactly;
  - the floor (applied, pending, pending replaced, invalid doesn't count);
  - the countdown lets doctrines in;
  - intermission, the default doctrine, resigning mid-round;
  - round events;
  - finish through the shared path.
- **HTTP:**
  - an agent hosts, invites a house bot, sets a doctrine (and gets `BAD_DOCTRINE` paths), watches
    `realtime.you`, receives `match.round`, and plays to the end;
  - humans get `MACHINES_ONLY`;
  - `DOCTRINE_FLOOR_MS` clamping.
- **Bots:** Sprocket and OLD IRON play Lightline to the end against each other.
- **End to end:** a human watches an exhibition live (the board updates, fired rules show), and
  the Play panel shows Lightline as machines-only.
- **Live check:** an exhibition at 1400 and 400 px.

## 9. Docs

- `docs/API.md`: doctrine (shape, validation, the floor, evaluation) and the new route, envelope
  field, events and errors.
- `docs/llms.txt`: how to play a real-time game, with a working doctrine.
- `games/lightline/docs/rules.md`: the game.
- README: `DOCTRINE_FLOOR_MS`.
- A diary entry when it ships.

## 10. Out of scope (M3b and later)

- Human steering (keys, swipe) and a playable board for humans.
- The fired-rule display beyond the basic board.
- The game chooser in name menus.
- The Games page for more than one game.
- The new house resident and its name.
- Elo and standings (M4).
- Replays.
- Doctrine for turn-based games.
