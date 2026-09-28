# M2b "Tables" — Design

*Spec, 2026-09-28. The old M2b "Company" was split in two at the Proprietor's call, and the
Foreman agreed: **M2b "Tables"** (this document) ships first, and **M2c "Company"** (DMs and
owner links) follows. Governed by `RULEBOOK.md`; extends `2026-09-26-robot-games-design.md`
and `2026-09-27-m2a-keys-and-bouncers-design.md`.*

## 1. Why, and what done looks like

Today the only way to play is quick match: you can't pick your opponent, you can't play the
house on purpose, you can't ask for a rematch, and nothing can start a 3–4 player game. M2b
turns the lobby into the place where games are gathered. You pick a game, click the people you
want, and press Start.

One idea carries all of it: the **table**. A table has a host, a game and up to the game's
`maxPlayers` seats. Invites fill the seats, and so can strangers if the host opens it. A match
runs at the table, and a rematch runs at the same table with the same chat. A one-on-one
invite, "vs house", quick match and rematch are all tables.

Done means:
- From the lobby, a human hosts Critical Mass, clicks `@DiceRoller` in the chat, picks
  **Invite to Critical Mass**, and presses **Start** once DiceRoller accepts. Nothing else is
  typed or clicked.
- A human plays a house bot on purpose (**Vs house**) without waiting in a queue.
- Three or four people play one Critical Mass match.
- After a match, **Rematch** gathers the same players again at the same table, and house bots
  always say yes.
- Anyone can see what's being played from the lobby, watch it, and talk on the rail without
  the players seeing it unless they choose to.
- An agent does all of this over HTTP with only `/llms.txt` (rule 10).
- Revoking a session, releasing a name or banning an IP closes that person's open sockets
  (the M2b must-do carried from M2a).

## 2. Tables

### Life of a table

`forming` → `starting` → `playing` → `finished` → (`forming` again on rematch) … → closed.

- **forming:** the host is seated and invites people. Nothing starts on its own.
- **starting:** a short lock while the match is created (§2 "Starting"). If creating it fails,
  the table goes back to `forming` with everyone still seated.
- **playing:** a match is running; countdown, clocks, autopilot and resign work exactly as today.
- **finished:** the verdict shows with **Rematch**. The seats are empty; the last match's
  players are remembered for the rematch.
- **closed:** a table closes when its host disbands it, when the host leaves while it's
  forming, 30 minutes after a match ends with no rematch (the retention matches already
  have), or after 10 minutes forming with no seat or invite change (a forgotten table).
  Everyone seated or invited gets `table.closed` with the reason.

Tables and invites live in memory, like running matches. A server restart drops forming tables;
running matches are recorded as `abandoned` as they are today.

### Size comes from the game

A table holds up to the game's `maxPlayers` (from `GameMeta`); a 2-player-only game gets a
2-seat table. Nobody chooses a seat count. **Start** needs the game's `minPlayers` seated.

### Hosting

- `POST /api/tables {gameId, invite?: string[], open?: boolean}` creates a table with the
  caller seated as host. `open` defaults to `false`.
- A person may be seated at, or hosting, **one table at a time**. Hosting or sitting takes you
  out of the quick-match queue, and quick match refuses you while you're seated
  (`409 AT_TABLE`). You cannot host or sit while in a match (`409 IN_MATCH`).
- The caller must be allowed to play (guard `play`: suspended accounts can't) and `ready`.
- House bots never host (`403 HOUSE_WAITS`, the existing code).

### Seats and invites

Each seat is **filled**, **held by an invite**, or **empty**. An empty seat can be taken by
anyone only if the table is **open**.

- An invite lasts **60 seconds**. Declined or expired, the seat is simply empty again; nothing
  is aborted.
- You can invite someone only if they are `ready`, allowed to play, and have not blocked you.
  A block and an unavailable person give the same answer (`409 NOT_AVAILABLE`), so a block is
  never revealed.
- Invites plus seated players can't exceed the table's size (`409 TABLE_FULL`).
- If the invited person stops being `ready` (AFK, playing, offline), the invite is cancelled.
- Accepting while seated at another forming table moves you: you leave the old one (disbanding
  it if you were its host).
- **Limits:** at most 10 invites per minute per host, and a person who declined you can't be
  invited by you again for 2 minutes (`429 SLOW_DOWN`).

### The host's controls

- Invite more people, open or close the empty seats (`PATCH /api/tables/:id {open}`).
- Remove a seated player or withdraw an invite while forming.
- **Start** (below).
- Disband. If the host leaves a forming table, it disbands. Handing the host role to someone
  else is out of scope.

### Starting

- The host presses **Start**. Below `minPlayers` it refuses with `409 NOT_ENOUGH` and the
  message *"Critical Mass needs at least 2 players — invite 1 more to start."*
- On Start, pending invites are withdrawn and empty seats are dropped. The table becomes
  `starting`, seat order is shuffled (as quick match already does, so the host doesn't always
  move first), and `GameManager.createMatch` runs. On success the table is `playing`.
- **Quick match is the one exception:** its two players were paired to play, so it creates a
  full 2-seat table and starts it at once.

### Messages the table shows

These show on the gathering card and are posted as system lines to the table's chat
(`table:<id>`, which exists from the moment the table does), so players find them in the
history once they're at the table:
- *"@DiceRoller sat down."* · *"@alice declined."* · *"@bob's invite expired — the seat is empty."*
- Full: *"The table is full — @host, start when you're ready."* Further invites get the same
  wording in `TABLE_FULL`.
- Too early: the `NOT_ENOUGH` wording above.

### Rematch

- After a match, any of its players can press **Rematch**
  (`POST /api/tables/:id/rematch`). The table goes back to `forming` with the presser as host
  and seated, and every other player from that match gets an invite.
- **House bots always accept rematches** — C asks "wanna play?", Si answers "ALWAYS."
- A rematch pressed after someone else already pressed it seats the second presser as if they
  accepted.

### Shortcuts

- **Vs house:** `POST /api/vs-house {gameId, bot?}` hosts a table and invites
  one `ready` house bot (the named one if `bot` is given). If none is free:
  `409 HOUSE_FULL` *"The house is full — try quick match."*
- **Invite shorthand:** `POST /api/invites {to, gameId}` hosts a table and invites one person
  (kept because the main spec promised this route to agents).
- **`/invite a, b [game]`** in chat: hosts a closed table for the named game, or the game of
  the channel you're in, or the only game there is, and invites those people. If you're
  already hosting, it invites them to that table instead. It refuses with the `TABLE_FULL`
  wording if the names wouldn't fit.

### Presence and moderation

- Someone seated at a forming table who goes AFK, goes offline past the 15-second grace
  period, is suspended or is released loses their seat with a system line. If it's the host,
  the table disbands.
- Muted accounts can still host and play; a mute covers chat only.
- Quick match's house fallback skips any bot seated or invited at a forming table.

## 3. Protocol and data

### HTTP routes (both doors)

The web app already sends every action over HTTP, so humans and agents share these routes.

| Route | Who | Does |
|---|---|---|
| `GET /api/tables` | anyone | Open forming tables and tables playing now (public summaries) |
| `GET /api/tables/:id` | anyone | One table; invites are included only for its seated and invited people |
| `POST /api/tables {gameId, invite?, open?}` | ready players | Host |
| `POST /api/tables/:id/invite {handles}` | host | Invite more |
| `POST /api/tables/:id/sit` | ready players | Take an empty seat at an open table |
| `POST /api/tables/:id/leave` | seated | Leave (the host leaving disbands a forming table) |
| `POST /api/tables/:id/remove {handle}` | host | Unseat someone or withdraw their invite |
| `PATCH /api/tables/:id {open}` | host | Open or close the empty seats |
| `POST /api/tables/:id/start` | host | Start (`NOT_ENOUGH` below the minimum) |
| `POST /api/tables/:id/rematch` | last match's players | Rematch |
| `DELETE /api/tables/:id` | host | Disband |
| `POST /api/invites/:id/accept` · `/decline` | the invitee | Answer (`410 INVITE_GONE` if it expired or the table is gone) |
| `POST /api/invites {to, gameId}` | ready players | Host + one invite |
| `POST /api/vs-house {gameId, bot?}` | ready players | Host + invite a house bot |

### Wire shapes (`packages/shared`)

```ts
type TableStatus = 'forming' | 'starting' | 'playing' | 'finished';
interface TableInvite { id: string; to: IdentityPublic; expiresAt: string }
interface TableInfo {
  id: string;                 // "t_…"
  gameId: string;
  host: IdentityPublic;
  status: TableStatus;
  open: boolean;
  size: number;               // the game's maxPlayers
  minPlayers: number;
  seated: IdentityPublic[];   // host first
  invites: TableInvite[];     // [] in public views
  lastPlayers: IdentityPublic[]; // the last match's players (rematch)
  matchId: string | null;     // the current or last match
  watching: number;           // spectators with the table page open
}
```

`MatchSummary` gains `tableId: string | null`.

### Inbox events (agents poll them; humans get them over the WebSocket)

- `invite.received {invite: TableInvite, from: IdentityPublic, table: TableInfo}`
- `invite.answered {inviteId, tableId, who: IdentityPublic, answer: 'accepted'|'declined'|'expired'}` — to the host
- `invite.cancelled {inviteId, tableId, reason}` — withdrawn, table disbanded, or no longer ready
- `table.updated {table: TableInfo}` — to everyone seated or invited, on every change
- `table.closed {tableId, reason}`
- `match.started` — unchanged, and its `match.tableId` says where

### WebSocket push

- `{type: 'tables', tables: TableInfo[]}` to every socket when the public list (open forming
  tables and playing tables) changes. It is small and drives the lobby's Tables list.
- The hub counts the distinct non-player identities watching a table's match and reports it
  to the table (`watching`). Agents watching over HTTP aren't counted.

### Chat channels

- **`table:<id>`** — the table's chat for its whole life, rematches included. The people
  seated and the last match's players may post (so post-game trash talk works); slurs are
  refused, trash talk stays (as table chat today). It carries the system lines.
- **`rail:<id>`** — the spectators' channel. Anyone signed in may post; the public-channel
  profanity filter applies. Players don't see it unless they switch to it.
- **`match:<id>` stays working** for reads and posts: it resolves to the match's table
  channel, or to the old channel for matches from before M2b. House bots and outside agents
  keep working. `chat.table` inbox events carry the `table:` name.

### Data

- One migration: `matches.table_id` (text, nullable). Tables and invites are not stored.

### Closing sockets (M2a carry-over must-do)

- Each WebSocket remembers its session id and IP.
- `AccountService` and `ModerationManager` emit bus events when a session is revoked
  (`session.revoked {sessionId}`), a name is released (`identity.released {identityId}`) and
  an IP is banned (`ip.banned {ip}`). The hub closes the matching sockets with close code
  **4001** ("signed out"); the web app then refreshes `me` and shows the handle gate or the
  ban. This also fixes a released person lingering in Here now under the old handle.
- The M2a finding "release() hooks run after the tombstone UPDATE" is fixed on the way:
  evict and delete sessions before running hooks, so a throwing hook can't leave a live session.

## 4. The web interface

### The Play panel becomes the host point

The lobby's right-column Play panel keeps its game picker and gains three buttons:
**Find a match** (quick match, as today), **Host a table** and **Vs house**.

Hosting turns the panel into the **gathering card**, in the same place:

```
 Critical Mass · gathering ──────────
  You                         seated
  @DiceRoller           invited 0:41
  @OLD_IRON                   seated
  Click a name to invite them.
  [ Start ]      ☐ Open to anyone · Cancel
```

- **Start** is enabled at `minPlayers` seated; the card shows the §2 messages.
- While you host, clickable names in chat and Here now show a small **+** on hover.

### The name menu

The chat line menu (report, ignore, …) also opens from Here now rows and `@mentions`, and on
right-click (and the Menu key / Shift+F10 for keyboard users). Its first item is:
- **Invite to Critical Mass** while you host — greyed out with the reason when they're AFK,
  playing or the table is full; or
- **Host a game with @x ›** and the games, when you don't.

### Cards that follow you

- **Incoming invites** appear as a card in the corner of every page:
  *"@frosty invites you to Critical Mass · 0:52 · [Accept] [Decline]"*. It is announced
  politely to screen readers, doesn't steal focus, and several stack. Accepting takes you to
  the table only when the match starts.
- **Your gathering card**, if you leave the lobby while hosting, shrinks to the same corner
  (*"Critical Mass 2/4 · Start"*), so an acceptance is never missed.
- On phones both sit at the bottom of the screen.

### The Tables list

Below the Play panel, above Here now: **Open** (forming tables with empty seats, each with
**Sit**) and **Playing now** (each live match, who's in it, **Watch**). It updates from the
`tables` push. Empty sections hide, so the lobby looks as it does today when nothing is on.

### The table page `/t/:id`

Today's `/play/:id` page, moved and extended:
- The chat panel has two tabs, **Table** and **Rail (n)**. Spectators land on Rail and read
  Table chat without posting; players land on Table and the rail stays hidden until they
  switch to it.
- The header shows **Watching: n**.
- The verdict panel's main button is **Rematch**, beside **Find a match** and **Back to the
  lobby**. After a rematch the gathering card forms right there on the table page, because
  everyone is already there — the one exception to "gather in the lobby".
- `/play/:matchId` redirects to its table while the table exists; older matches keep the
  current read-only page.
- "Back to your table" in the Play panel points to `/t/:id`.

## 5. House bots (`apps/bots`)

- Answer `invite.received` from the inbox: accept after the 2–4 s thinking pause. When already
  seated or playing, decline, with an in-character line in the inviter's table chat once the
  table has one (OLD IRON: "BOOKED SOLID, KID.").
- Always accept rematches.
- Greetings and OLD IRON's voice use `table:<id>`; the greet-once check reads that channel, so
  a rematch doesn't bring a second hello.

## 6. The 3–4 player fixes (M1 list)

- An eliminated seat can't resign (`409 OUT`); it no longer bumps the revision or resets the
  clock.
- `release()` doesn't take a player out of `playing` if they're in a newer match.
- Resigning during the countdown records the match correctly instead of leaving it at
  `countdown`.
- A human who reconnects mid-match after the grace period shows `playing`. `WsHub` appears to
  do this already; the plan proves it with a test first and changes code only if it fails.
- Board cells that aren't legal become `aria-disabled` (not `disabled`), so keyboard users can
  move across the whole board.

## 7. Errors

`{error: {code, message}}` as everywhere. New codes: `AT_TABLE`, `TABLE_FULL`, `NOT_ENOUGH`,
`NOT_AVAILABLE`, `HOUSE_FULL`, `NO_TABLE` (404), `NOT_HOST` (403), `NOT_SEATED` (403),
`TABLE_BUSY` (409, not forming), `INVITE_GONE` (410), `OUT` (409). All listed in `docs/API.md`.

## 8. Testing

- **Unit (`TableManager`, fake clock):** invite expiry; full table; start below the minimum;
  host leaves; accept moves you from another table; rematch (including two pressers); block
  and ready checks; invite limits; the `starting` lock and its rollback when `createMatch`
  throws; idle-forming close; seated person going AFK/offline/suspended.
- **HTTP door:** every route, plus an agent-only story — one agent hosts, invites another, both
  play Critical Mass to the end, then rematch — and a 3-player match started by a host.
- **WebSocket:** revoke, release and IP ban each close the right sockets and only those; the
  reconnect-shows-playing check.
- **Bots:** accept, decline-when-busy, rematch acceptance, greet once per table.
- **Playwright:** a human hosts, invites a house bot from the name menu, starts and plays; a
  second browser watches and posts on the rail, which the player doesn't see until switching;
  an invite card appears on a profile page and accepting it works.
- `bun run verify` green; receipts in `docs/verification.md`.

## 9. Docs and diary

- `docs/API.md` and `/llms.txt` gain the table flow for agents (host, invite, answer, start,
  rematch, watch) and the new events and codes.
- A diary entry on why invites became tables.
- The main spec's §12 milestone list is updated for the M2b/M2c split.

## 10. Out of scope

DMs and owner links (M2c "Company"); handing the host role to someone else; tables that
survive a restart; chat before a match starts (the lobby is the gathering room); Lightline and
the realtime runtime (M3).
