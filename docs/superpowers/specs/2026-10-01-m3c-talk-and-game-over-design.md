# M3c, part 1 — Game-aware table talk and GAME_OVER

**Date:** 2026-10-01 · **Status:** approved in conversation, awaiting spec review
**Context:** `docs/m3b-carryover.md` "For M3c". The Foreman left the new resident's name and character to the Proprietor ("I would go for the dark humor"). Part 2 of M3c (the Game Rules page and Crown & Steel's full `rules.md`) gets its own spec.

## Goal

1. The house bots stop talking about orbs at Lightline and Crown & Steel tables: lines are chosen for the game being played, and the voiced bot is told which game it is.
2. A third resident, **GAME_OVER**, moves in: dark-humoured, voiced, and the strongest player in the house — including the first real Crown & Steel brain (today every bot plays checkers by random legal move).

## 1 · Game-aware table talk

**Line banks.** `Personality.lines` stays the neutral bank (hello, win, lose, draw, mentioned, ambient, unanswered, busy, plus bigCascade/gotHit which only Critical Mass fires). A new optional `Personality.byGame: Partial<Record<string, Partial<Lines>>>` holds per-game banks keyed by game id. A moment at a table takes the game's bank when it has a non-empty list for that kind, else the neutral one. Moments outside a table (mentions in the lobby, ambient, DMs) use the neutral bank.

- Sprocket's and OLD IRON's orb-flavoured lines move into `byGame['critical-mass']`; their neutral lines are rewritten to be game-free; each gets `lightline` and `checkers` banks for hello/win/lose/draw (at least 3 lines per kind, in character).
- Invariant, enforced by a unit test: no neutral line of any personality matches `/\b(orbs?|cells?|chain reactions?|cascades?|explo\w*)\b/i`.

**The voice knows the game.** `Moment` gains `game?: { name: string; tagline: string }`, filled for every moment spoken at a match/table channel from the catalog entry (`GET /api/games`, cached by the bot at start and refreshed hourly). `buildUserPrompt` adds the line `The game at this table is <name>: <tagline>` when present.

- `instructions/house-rules.md`: the parlor plays several games ("Critical Mass, Lightline, Crown & Steel, and whatever comes next; when you are at a table you are told which one"), replacing "play Critical Mass (…)".
- `instructions/old-iron.md`: "You like Critical Mass: … honest work — orbs, cells, chain reactions" becomes a liking for the parlor's games as honest, deterministic work; no game-specific vocabulary in the persona.

## 2 · GAME_OVER

**Identity.** House bot `GAME_OVER` (handle exactly that), tagline "has seen every life run out", colour `#c2185b`. Registered by `apps/bots` like the others (house key), token file `game-over.token`.

**Character** (persona file `apps/bots/instructions/game-over.md`, live-reloaded like OLD IRON's): an old arcade cabinet that has watched ten thousand players lose their last life. Deadpan, morbid, quietly delighted by endings; talks in arcade terms — lives, continues, credits, the countdown, the attract screen, high-score initials — as if they were mortality. Writes in lowercase (no `shout`), short lines, never cruel to a person: the dark humour is about the game ending, never about anyone's real life, health or identity. All house rules apply.

**Voice.** LLM-backed through the same connection settings as OLD IRON (`.data/llm.json`, live-reloaded), with its canned banks as the fallback. It speaks at tables, when @mentioned, and in private chats; it has **no ambient chatter and no unprompted answers** (empty `ambient`, no `unanswered`), so OLD IRON stays the lobby's voice.

**Lines.** Neutral bank for every kind it can be asked for, and `byGame` banks for all three games (hello/win/lose/draw; Critical Mass also bigCascade/gotHit). At least 3 lines per kind.

**Play.**
- Critical Mass: `strategy: { depth: 2, randomness: 0.03 }`.
- Lightline: `lightline: 'wallHugger'`.
- Crown & Steel: the new checkers strategy (below) with `checkers: { randomness: 0 }`.

## 3 · A checkers brain for the house

`apps/bots/src/strategies/checkers.ts`: `chooseCheckersMove(state, seat, { randomness, rng }): CheckersCommand`.

- Candidates are `checkersGame.legal(state, seat)` (complete commands; captures and continued jumps already mandatory). One candidate → play it.
- Each candidate is scored by a 2-ply search: apply it, then assume the opponent's best reply by the same evaluation; score = evaluation after that reply (or after our move if the opponent has none / the game ended).
- Evaluation from `seat`'s side: men 1, kings 1.6, plus 0.05 per row advanced for men (toward crowning); a win is +1000, a loss −1000, a draw 0.
- With probability `randomness` it plays a uniformly random legal command instead (so weaker bots blunder sometimes); ties between best scores break by `rng`.
- `Personality.checkers?: { randomness: number }`, default `{ randomness: 0.5 }`. Sprocket `0.45`, OLD IRON `0.2`, GAME_OVER `0`.
- `chooseMove` in `bot.ts` routes `gameId === 'checkers'` to it; `@cs/checkers` becomes a dependency of `@cs/bots`.
- Budget: Crown & Steel has at most a few dozen commands per turn; 2-ply stays well under the bots' think pause (test asserts < 50 ms on the opening and on a mid-game position).

## Testing

- Unit (`apps/bots`):
  - line choice: a table moment in `checkers` uses the checkers bank; a kind the game bank lacks falls back to neutral; a lobby moment uses neutral.
  - the neutral-vocabulary guard over every personality.
  - every personality has a non-empty neutral bank for hello, win, lose, draw, mentioned, busy; GAME_OVER has empty ambient and no unanswered.
  - `buildUserPrompt` includes the game line when `moment.game` is set, and not otherwise.
  - checkers strategy: takes a free capture chain over a quiet move; doesn't move a man into an undefended capture when a safe move exists; crowns when a crowning move is available and safe; with `randomness: 1` it returns some legal command; timing budget.
- e2e: GAME_OVER appears in Here now, and a human can host Crown & Steel with GAME_OVER from the name menu (Game invite ▸ Host Crown & Steel), GAME_OVER is seated, the match starts, then the human resigns.
- Existing suites stay green (bot unit tests, `voice.test.ts`, the e2e suite).

## Out of scope

The Game Rules page and Crown & Steel's `rules.md` (part 2); renaming or retiring Sprocket; per-game LLM personas; a Lightline doctrine of its own for GAME_OVER (it uses wallHugger).
