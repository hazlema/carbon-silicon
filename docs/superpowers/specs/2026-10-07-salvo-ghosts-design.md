# Salvo v3: Wreck Ghosts — design

2026-10-07 · agreed with the Foreman in chat · builds on `docs/ideas/Salvo — game design.md` (Wreck Ghosts) and the engine's `stillSeated` (landed 2026-10-06)

## Why

The first player out of a four-seat Salvo leaves minutes in, and the table talk is half the reason this place exists. A sunk fleet doesn't leave the table; it haunts it.

## Decisions (the Foreman, 2026-10-07)

- **Two tricks in this cut: Mine and False splash.** Whisper (selling radar for scrap) waits for a later cut.
- **A ghost knows what it knew, nothing more.** It keeps its own shot history and the public marks, like a spectator. Nothing a ghost can read or be refused may reveal where a living ship is.
- **Ghosts owe a trick every round.** The round waits for them on the same clock; the autopilot plays a random trick on the deadline; three missed rounds and the ghost is gone.
- **A mine on a ship backfires.** The ghost plants blind; if a ship is under the mine, the shot that sets it off sinks that whole ship for the shooter. (Refusing mines on ship cells was ruled out: `legal` would map every fleet.)
- **Ghosts talk.** A resident going down and every trick of theirs gets dramatic lines.
- **A player always knows they're a ghost and what that means:** a card naming who sank them, the mission (mischief) and the two tricks, until dismissed.

## The rules

### Becoming a ghost

When your last ship sinks you stay at the table as a ghost (👻). Your placement is fixed at that moment and never moves again. Each round, while living players fire, you owe exactly one trick. A ghost's card says "👻 @x is up to something…" once it has committed, never what.

Three missed rounds in a row and the ghost is gone: released from the table, its live mines and pending splashes cleared silently, placement unchanged. A seat forfeited while still afloat (resign, timeouts) is out and released as today; it never becomes a ghost. Only a sinking makes a ghost.

### Mine

`{"trick":"mine","at":"east","cell":"e5"}`

- Any cell of any living sea that no shell has landed on and that doesn't already hold one of this ghost's own mines. Two ghosts' mines may share a cell (refusing it would tell one ghost where the other's mine is); both go off.
- At most **3 live mines** per ghost; at 3, mines drop out of `legal`.
- Seen by its ghost alone (until it goes off, or the match ends: then every live mine is shown).
- A mine laid this round is live before this round's shells land, so a ghost who predicts the shot catches it the same volley.
- **Trigger:** a shell aimed at that exact cell (a Time on Target centred on it triggers it once for every shooter in the group; cells a blast only spills onto do not). The shell lands normally first.
- **Open water → Dirty trick.** Each triggering shooter's own fleet takes one hit: at the same cell name on their own sea if an unhit ship cell is there, else the nearest unhit ship cell (Manhattan distance, ties in board order a1, b1 … h8). Credit goes to the ghost (+1 scrap a hit, +3 if it sinks a ship). It can sink the shooter's ship and knock the shooter out.
- **Ship underneath → Backfire.** The whole ship at that cell sinks: every unhit cell of it becomes a hit credited to the triggering shooter(s), scored as normal hits and a sinking. The ghost helped.
- Mines resolve after all shells, in seat order of the mined sea, then board order, then the ghosts' seat order, and never chain. Eliminations are worked out after mines, so a mine can cause an elimination (and a same-volley tiebreak) like any shell.
- A mine dies with its sea when that fleet goes out.

### False splash

`{"trick":"splash","fool":"south","at":"east","cell":"e5"}`

- `fool`: a living seat. `at`: a living sea that isn't the fool's own. `cell`: a cell of `at` no shell has landed on.
- Legal only while at least three seats are living (the fake needs a third seat to wear as its shooter).
- **At this round's volley** the fool alone sees a fake **hit** at that cell: in their `TargetView.hits` for that sea (with `afloat` one lower), and as a shell in their copy of `lastVolley`, credited to a living seat other than the fool and the sea, preferring one that really fired at that sea this volley (seat order otherwise). A careful counter could notice that seat fired one shell more than its guns; that's the bluff.
- It lasts one round. At the next volley it's withdrawn and told to the table. If any shell lands on the fake cell first, the real result shows and the trick is told in that volley.
- Residents fall for it like people: their odds map reads `hits`.

### Telling it

`lastVolley.tricks` (public) lists every trick revealed in this volley:

- `{ kind: 'mine', ghost, sea, cell, shooters, result: 'boomerang', hits: [{ sea, cell, ship }], sunk: [...] }`
- `{ kind: 'mine', ghost, sea, cell, shooters, result: 'backfire', ship }`
- `{ kind: 'splash', ghost, fool, sea, cell }`

The round summary tells each one:

- "**Dirty trick!** {ghost}'s mine at {east} e5 goes off under {north}'s shell — {north}'s cruiser takes the hit at e5."
- "**Backfire!** {ghost}'s mine was sitting on {east}'s cruiser. {north}'s shell sends it to the bottom. Thanks for the help, {ghost}."
- "**Dirty trick!** The hit {south} saw on {east} e5 was {ghost}'s false splash."

A ghost's commit narrates as "is up to something…"; `describe` of a trick is "plays a dirty trick" (the autopilot's line stays the engine's).

## The module (`games/salvo/src/index.ts`)

- **State:** `mines: { ghost, sea, cell, round }[]`, `splashes: { ghost, fool, sea, cell, round, as: SeatId }[]`, `ghostsGone: SeatId[]`, `pending` gains `kind: 'mine' | 'splash'` orders.
- `ghosts(s)`: eliminated with reason `sunk`, not in `ghostsGone`, match not over.
- `toMove` (fire): living seats not ready, then ghosts not ready.
- `stillSeated(s, seat)`: `ghosts(s).includes(seat)`. `isOut` unchanged.
- `forfeit` of a ghost: add to `ghostsGone`, drop its mines and splashes, resolve the round if it was the last owing. Never touches `eliminated`.
- `legal` for a ghost: mines (cap 3) and splashes; for the living, unchanged.
- `apply`: `{trick}` accepted from ghosts only (`NOT_A_GHOST` otherwise); one trick and the ghost is ready. Error codes: `BAD_CELL`, `ALREADY_SHOT`, `YOUR_MINE`, `MINE_LIMIT`, `BAD_FOOL`, `TOO_FEW`.
- `resolve`: lay this round's mines and splashes → shells land as today → mines trigger → expired splashes withdrawn → sinkings, eliminations (mines included), scrap → `lastVolley.tricks`.
- **Views:** `ghosts: SeatId[]` (public); `myTricks` for a ghost (its live mines, its live splashes, this round's pending trick); the fool's fake in its own `targets` and `lastVolley`; `guns` 0 for ghosts. At game end every live mine is shown on its sea.
- `ascii` shows a ghost's own mines as `*` in its own view only.

## Residents (`apps/bots/src/strategies/salvo.ts`)

- A ghost planner on the existing odds map (public marks + the ghost's own past shots and sonar).
  - **Mine:** where living players will shoot but a ship is unlikely: score = chance the cell is shot next round × (1 − chance of a ship). Hard takes the best, medium one within 80%, easy random.
  - **Splash:** fool the living seat with the most cells afloat, on a sea it's been firing at, in the coldest unshot cell.
- One trick a round, committed at once like a salvo.
- **Banter:** new Salvo moments for every resident, in the LLM table-talk prompt and in each personality's canned bank: `ghost` (its own fleet sinks: "My hull is on the seabed. My grudge is not."), `trick` (its Dirty trick lands: "Mind your step. The water remembers."), `backfire` (its mine helped someone: "…I meant to do that."). OLD IRON is a haunted 1974 mainframe, GAME_OVER says things like "INSERT COIN TO HAUNT", Sprocket is cheerful about it.

## The board (`apps/web/src/lib/games/salvo/Board.svelte`)

- Once you're a ghost (and the sinking volley has landed), the fire controls become ghost controls: **Mine / False splash** toggle; Mine: click a cell; Splash: click a cell, then pick who to fool (living seats, not the sea's owner); "Plant mine" / "Splash" sends it. Your live mines show on their seas as a skull marker; your live splash as a ghost marker.
- Ghost cards get a 👻 badge and "up to something…" once committed; the status line says "You're a ghost: one dirty trick a round."
- The volley plays mines after the shells: a triggered mine flashes on the mined sea, then lands like an incoming shell on the shooter's own sea (warned on your sea: "⚠ A mine under your shell at east e5!"). Backfire plays as a sinking.
- Banners: "Dirty trick! …" (hot) and "Backfire! …" (go), in the reveal.
- **Becoming a ghost is announced, not hinted (the Foreman, 2026-10-07).** Once the volley that sank you has landed, a card over the stage replaces R-31's 6 s banner and stays until you press **Haunt them**:

  > 👻 **You were sunk by @Fable.** (or "by @Fable and @Bob"; "by @ghost's mine" when a mine finished you)
  > Your fleet is gone, but your spirit stays at the table. You're a ghost now. **Your mission: mischief.**
  > Each round, play one dirty trick:
  > 💀 **Mine:** hide it on a cell. Whoever shoots there gets hit on their own sea… unless a ship is under it, then you've just sunk that ship for them.
  > 💦 **False splash:** show one player a fake hit, to waste their shots.
  > You can't win now, but you can decide who does. Idle three rounds and your ghost fades away.

  The round clock keeps running behind it, and the card says so ("Round 9: 38 s to play your first trick"). Dismissed, the same mission sits in short form at the top of the ghost controls ("👻 You're a ghost. One dirty trick a round."), and a ghost's own card on the roster wears the 👻. A reload while you're a ghost shows the short form, not the card. "Who sank you" comes from the last volley: the shooters credited with your last sinking(s), or the ghost whose mine did it.

## The rules guide (`games/salvo/docs/rules.md`)

A **Ghosts** section: becoming a ghost, Mine (with Backfire), False splash, how they're told, three misses and you're gone. One worked example rendered from the engine (a mine going off, before and after).

## Tests

- **Unit (module):** each trick legal/illegal with its code; mine same-round trigger; ToT on a mine triggers per shooter; blast spill doesn't; boomerang at same cell / nearest / tie order; boomerang sinks and eliminates (and a same-volley tiebreak); backfire sinks the whole ship and credits the shooters; mine cap; mine dies with its sea; splash shown to the fool alone, dressed as a real shooter, withdrawn and told next volley, told early when shot; splash needs three living; ghost owes and is ready after one trick; ghost forfeit keeps placement and clears its tricks; an afloat forfeit never becomes a ghost; immutability; order-free resolution with tricks.
- **Leak fuzz:** extended with ghosts playing random tricks: a live mine appears in no view but its ghost's, in no `recent`, no `describe`, no summary until it fires; a fake splash appears only in the fool's and the ghost's views; nothing in a ghost's `legal` depends on hidden ships.
- **`legal` × `apply` fuzz** with ghosts; **"ghost forfeits keep placement"**.
- **Residents:** the ghost planner returns legal tricks; hard prefers likely-shot, unlikely-ship cells; four-resident tables still finish (cap rate checked by sim).
- **e2e:** extend `e2e/salvo-endings.e2e.ts`: once sunk, the ghost card names the sinker and is dismissed with Haunt them, then the human plants a mine through the board and the server receives that command; a scripted shooter sets it off and the "Dirty trick!" banner shows.

## Out of scope

Whisper; ghosts on the leaderboard beyond their fixed placement; spectators seeing live mines; ghosts for a resign/timeout.
