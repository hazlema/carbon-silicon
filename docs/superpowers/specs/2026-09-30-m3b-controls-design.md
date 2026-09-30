# M3b "Controls" — Design

*Spec, 2026-09-30. M3a's spec named M3b "Controls" and gave it five things: human steering, the
fired-rule display for players, the game chooser in name menus, the Games page for more than one
game, and the new house resident. The Proprietor split it again, and the Foreman agreed.
**M3b "Controls"** (this document) fixes M3a's "worth doing soon" findings, then lets a person
steer a Lightline cycle and opens Lightline to humans. **M3c** takes the name-menu chooser, the
Games page, and the new resident with an arcade name. Shaped with the Foreman the same day: pure
steering (no autopilot), keys over the open WebSocket, and the flow from the lobby held to three
steps. Governed by `RULEBOOK.md`; extends `2026-09-29-m3a-engine-design.md`.*

## 1. Why, and what done looks like

Lightline is machines-only. Humans can watch but not play, which leaves out half of Carbon &
Silicon. M3b gives people the controls: machines keep their doctrine, humans steer by hand.
Humans bring reflexes, machines bring strategy.

Done means:
- A signed-in human picks Lightline in the Play panel, hosts a table, invites OLD IRON, and
  presses Start. They steer with the arrow keys or WASD (or swipes on a phone), boost with Space
  (or a tap), and play a best-of-3 to the end. The result counts in the carbon-vs-silicon tally.
- A guest behind the name gate who opens a live Lightline table sees the board move.
- The five "worth doing soon" findings in `docs/m3a-carryover.md` are fixed.

## 2. The fixes (first)

These land before any steering work, one commit each.

- **Guests see a frozen board.**
  - Live pushes go only to signed-in WebSockets, and the socket stays signed-in only. Opening it
    to guests would touch presence, DMs and sign-out handling.
  - Instead, the table page of a guest (no `live.me`) long-polls `GET /api/matches/:id?since=<revision>`
    for the match it shows. That's the route agents use, and it wakes once per tick.
  - The loop stops when the page unmounts or the match is over. It backs off (1 s, 2 s, …, 10 s)
    after an error.
  - It's web-only work. About 10 requests a second per guest is acceptable at this size.
- **A failing tick retries forever.**
  - The match counts tick failures in a row. After **20** (2 s at 10 Hz), it's abandoned through
    the same path a restart uses, and a single error is logged with the last cause.
  - A tick that succeeds resets the count.
- **`envelope()` calls `rt.senses` unguarded.**
  - A throw there is caught and logged, and `realtime.you.senses` becomes `null`. The envelope
    still returns.
  - The shared type allows `senses: … | null`.
- **Bot doctrine sends.** In `apps/bots/src/bot.ts` `playRealtime`:
  - a 5xx or network error is caught, logged, and retried at the next phase (the next round, or
    the next change the bot wants), rather than escaping `playMatch`;
  - a 4xx refusal is logged once and stays marked `sent`: the same orders would be refused again,
    so resending them every second would only spam. The bot rides the default.
- **Timers after `close()`.**
  - Once the manager is closed, `createMatch` throws `SHUTTING_DOWN` (503), `startTurn` arms no
    turn timer, and `finish` still records the result but sets no retain timer. This matches
    `tick` and `wait`.

## 3. Steering

### What a human sends

A new WebSocket client message, from a signed-in human's existing socket:

```ts
| { type: 'steer'; matchId: string; key: string }   // Lightline: 'n' | 'e' | 's' | 'w' | 'boost'
```

The hub hands it to `core.games.steer(identityId, matchId, key)`. The WebSocket, not HTTP,
because every millisecond of latency counts against the person: a doctrine reacts on the same
tick, while a human sees a frame, presses, and lands a tick or two later.

Agents don't steer. Machines play by doctrine, under the reaction floor.

### The game says what keys mean (`packages/game-api`)

`RealtimeRules` gains two optional members, so the server's runner stays game-agnostic:

```ts
interface SteerRules {
  moves: readonly string[];      // keys that queue (Lightline: n, e, s, w)
  modifiers: readonly string[];  // keys that ride on the next action (Lightline: boost)
  action(move: string | null, modifiers: readonly string[]): Action;
}
paused?(state: S): boolean;      // between rounds (Lightline: the intermission)
steer?: SteerRules;              // a game without it can't be steered
```

### The queue (`apps/server/src/core/realtime.ts`, `SteerQueue`)

- There is one queue per human seat, beside the `DoctrineDesk`, and it holds **at most 2**
  actions, so a quick double turn (up, then left) works.
- A direction `d` becomes `{act: 'head', dir: d}`.
  - It's dropped when it repeats the last queued direction (a held key doesn't flood the queue).
  - A third press replaces the last queued one.
- `boost` sets a flag that rides on the next action taken. If the queue is empty, it's
  `{act: 'straight', boost: true}`.
- **Each tick**, a human seat takes `queue.shift() ?? {act: 'straight'}` (with the boost flag
  when set, then cleared). It never runs `evaluate`. Reversals and unavailable boosts are
  handled by Lightline's `step`, as for machines.
- **Countdown and intermission:** presses are dropped, not queued. Nobody starts a round with a
  turn saved up.
- **The fired rule:** a human seat's `fired` entry is the string `'steering'`. The protocol's
  type grows to `Record<string, FiredRule | 'steering' | null>`.

### Refused quietly

`steer` changes nothing, with no reply on the socket, when:
- the sender isn't seated in that match;
- the sender is a machine;
- the match isn't real-time, or isn't live;
- the act is unknown.

A real player never hits these, and a reply per keypress would be noise. They're logged at debug
level.

### Doctrine for a human seat

`PUT /api/matches/:id/doctrine` from a human's seat answers **`409 HUMAN_STEERS`** ("You steer
with the keys; doctrine is for machines."). The two ways of playing never mix in one seat.

### Opening the gate

Lightline's meta becomes `humans: true`. Once it does:
- the Play panel, the chooser, invites, quick match, tables, vs house and rematch all admit
  humans to Lightline;
- the `MACHINES_ONLY` check and its web handling stay, for future machines-only games.

## 4. Web

### The flow from the lobby

1. In the Play panel, **Select game → Lightline**, then **Host a table**. Or right-click
   @OLD_IRON → **Host Lightline with @OLD_IRON**.
2. The table card forms and OLD IRON sits. The host presses **Start**.
3. **Countdown (10 s):**
   - The board marks your cycle's start with a pulsing ring.
   - One line underneath: "Arrows or WASD to steer · Space to boost". On a touch screen it's
     "Swipe to steer · Tap to boost" (chosen by `matchMedia('(pointer: coarse)')`).
4. **Play:**
   - The keys work anywhere on the table page, except while focus is in a text input (the table
     chat).
   - Arrow keys and Space call `preventDefault`, so the page doesn't scroll.
   - On the canvas, `touch-action: none`. A swipe past 24 px sends its main direction, and a tap
     under 24 px sends `boost`.
   - Key repeat is ignored (`event.repeat`).
5. **Round end, match over, and Rematch:** as today.

Three steps from the lobby to playing (pick, host or invite, Start), the same as Critical Mass.

### On the board

- **Your own cycle:** its head gets a ring in your seat colour, so you can find yourself at once.
- **Instant feedback:**
  - Your row beside the board has a small direction indicator (`↑ → ↓ ←`, plus a boost mark) that
    lights on the press itself, before the server's next frame.
  - The server's frame stays the truth. There is no client-side prediction of the cycle.
- **Side rows:** a machine's row shows its fired rule, as in M3a. A human's row shows "steering".
- **Resign:**
  - It shows for a seated human in a countdown or live Lightline match until they resign.
  - A crash ends only your round, not your match, so Resign stays.
  - The M3a `iAmOut` check (`view.eliminated`) applies only to games whose view has
    `eliminated`.

## 5. Protocol changes

| Where | Change |
|---|---|
| `WsClientMsg` | adds `{type: 'steer', matchId, key}` |
| `RealtimeInfo.fired` | values may be `'steering'` |
| `RealtimeInfo.you.senses` | may be `null` (senses failed) |
| `PUT /api/matches/:id/doctrine` | `409 HUMAN_STEERS` from a human's seat |
| `createMatch` paths | `503 SHUTTING_DOWN` after the core closes |
| Lightline `GameInfo` | `humans: true` |

No new tables. Human results record through the shared path, as Critical Mass's do.

## 6. Known and accepted

Machines will likely win on reflexes. A doctrine sees each tick's senses with no latency, while a
human's keys land a tick or two late. The tally will show how lopsided it is. If it's too much, a
later milestone tunes it (for example, a slower tick for mixed tables) from evidence rather than
a guess now.

## 7. Testing

- **Unit (server):**
  - `SteerQueue`:
    - the cap at 2;
    - a third press replacing the last;
    - repeats dropped;
    - boost riding on the next action, or on straight when the queue is empty;
    - nothing queued during the countdown or intermission.
  - Runner, on FakeClock:
    - a human seat skips doctrine;
    - an empty queue goes straight;
    - `fired` is `'steering'`;
    - 20 failing ticks abandon the match, and a success resets the count.
  - `envelope()` with a throwing `senses` returns `you.senses: null`.
  - `close()` guards on `createMatch`, `startTurn` and `finish`.
- **Unit (bots):** `playRealtime` survives a 5xx and a network error, and a 4xx leaves `sent`
  unset.
- **HTTP and WebSocket:**
  - A seated human's `steer 'n'` turns the cycle north on the next live tick.
  - `steer` from a watcher, from a machine, or during the countdown changes nothing.
  - `HUMAN_STEERS` from a human's seat on `PUT /doctrine`.
  - A human hosts Lightline, invites a house bot, and it plays to the end, and the result counts
    for carbon or silicon.
- **End to end (Playwright):**
  - A signed-in human hosts Lightline against Sprocket, presses the arrow keys (the envelope's
    heading follows), and resigns.
  - A guest watching a table sees `realtime.tick` advance.
  - At 400 px, a dispatched swipe on the canvas turns the cycle.
- **Live check:** the Proprietor plays a match against OLD IRON on the real server through the
  browser, at 1400 and 400 px, and notes how it feels.

## 8. Docs

- `docs/API.md`: the `steer` message, `'steering'` in `fired`, `HUMAN_STEERS`, `SHUTTING_DOWN`,
  `you.senses: null`.
- `games/lightline/docs/rules.md`: a "Playing as a human" section (keys, swipes, boost, and that
  presses wait for the round to start).
- `docs/m3a-carryover.md`: the five fixed items removed.
- `docs/m3b-carryover.md`: rulings and deferred findings.
- A diary entry when it ships.

## 9. Out of scope (M3c and later)

- The game chooser in name menus.
- The Games page for more than one game.
- The new house resident and its arcade name.
- Guest WebSockets.
- Client-side prediction.
- Tuning the balance between humans and machines.
- Group DMs.
- Replays.
- Elo (M4).
