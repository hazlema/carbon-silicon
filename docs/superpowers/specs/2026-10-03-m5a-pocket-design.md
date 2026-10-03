# M5a "Pocket" — Design

**Date:** 2026-10-03 · **Status:** approved in conversation (visual companion: the bottom sheet, option A)
**Context:** M5 "Shine" is split: M5a Pocket (the phone table, this spec), M5b Faces (profile pictures),
M5c Key art, M5d Speed (performance). After the first real-phone playtest (2026-10-02, over the LAN) the
Foreman asked for phone games to run full screen with the chat floating and hidden until wanted, and
picked a toast for taunts: table talk is the heart of the game, so a hidden chat must still show it.

Today on a phone the table page stacks the site header, the game, and the chat (55% of the screen height)
below it, out of sight. Lightline swipes work; the Critical Mass isometric board is small (Top view is bigger).

## 1. When it applies

The **pocket layout** is on at a table (`/t/:id`, playing or watching) when either media query matches:

- `(max-width: 640px)` — a phone held upright, or any narrow window;
- `(pointer: coarse) and (max-height: 500px)` — a phone held sideways.

Everything else (desktop, tablets) keeps today's layout exactly. One shared helper (`lib/pocket.ts`)
exposes the query and a reactive `pocket` flag so the page, the boards and the tests agree.

## 2. The full-screen table

Plain layout, not the browser's Fullscreen API (needs a tap to start, unsupported for pages on iPhone
Safari, fights the on-screen keyboard). While the pocket layout is on, the table page tells the root
layout to hide the site header and the corner lattice, and the table fills the dynamic viewport
(`100dvh`, safe-area insets respected).

From top to bottom:

1. **Top bar** (one slim line): ✕ (leave), the game's name, `Rules`, and a ⋯ menu holding Resign
   (with today's "Yes, resign / Keep playing" confirm inside it).
2. **Seats**: one line with each seat's name (species colour and font) and its score/standing, as the
   seat cards show today, condensed.
3. **Board**: takes all remaining height.
   - Critical Mass opens in **Top view** in the pocket layout (still switchable to Iso; the choice is
     not persisted). The Top view is **turned so the board's long side lies along the screen's long
     side**: a tall board on a phone held sideways is rotated 90°, as the Foreman plays it on desktop.
     Turning the phone mid-match re-aims the board the same way (the animated turn the view buttons use).
     The Top button in pocket aims at that turned Top view.
   - Crown & Steel and Lightline already size to their container; they get the remaining height.
   - The countdown overlay works as today.
4. **Status line**: whose move it is and the clock (`Your move · 74 s`), or the Lightline round line.

The Lightline steer hint (`Swipe to steer · Tap to boost`) shows during the countdown only.

## 3. The chat button

A round button at the bottom right, outside the board's swipe area (it sits over the status line's end),
with an unread count badge (carbon orange) of lines arrived while the sheet was closed. Tapping opens
the sheet. `aria-label="Open chat (2 unread)"`.

## 4. The toast

While the sheet is closed, **every line from someone else** in the current chat tab's channel shows as a
toast: table talk for a player, the rail for a spectator, and system lines (`dozed off`, `resigns`, round
results) too. Your own lines never toast.

- One at a time; a new line replaces the current toast. Each stays 5 seconds.
- Shows the author's name in their species colour and font (carbon: Fraunces italic; silicon: Plex Mono),
  then the line, clamped to three lines. System lines show without a name, in `--fog`.
- Sits above the chat button, left of it, never over the seat line or the status line.
- Tap: opens the sheet. Swipe sideways or down: dismisses.
- `role="status"` with `aria-live="polite"` so screen readers hear taunts too.
- `prefers-reduced-motion`: appears and disappears without sliding.

## 5. The sheet

Tapping the chat button or a toast slides the **bottom sheet** up over the lower half (55% of the
viewport height). It contains today's table chat panel unchanged: the Table / Rail tabs, your
conversation tabs, the ⋯ menu, the transcript, the composer.

- The board stays visible above it (it doesn't resize; the sheet covers its lower part).
- Close: swipe the grab handle down, tap the visible board, or press Esc. Closing never sends a
  board tap through as a move.
- The on-screen keyboard pushes the sheet up (the sheet is anchored to the visual viewport).
- Opening it marks the open tab read (as the chat panel already does when visible) and clears the badge.
- Focus moves to the composer on open and back to the chat button on close.
- While the sheet is open in Lightline, swipes on the visible board still steer.

## 6. Leaving

✕ goes to the lobby. During your own live match it first asks, in place (no browser dialog):

- Turn-based: `Leave the table? The match keeps going: the autopilot plays your turns, and 3 missed in a row forfeit.`
- Lightline: `Leave the table? The match keeps going and your rider carries on without you.`

Buttons: **Leave** · **Stay**. Spectators and finished matches leave at once.

## 7. Out of scope

- Desktop and tablet layouts, the lobby and other pages on phones (they already work at 400 px).
- Installing as an app (a web manifest for chrome-less "Add to Home Screen") — a later idea.
- Changes to steering, boards' rendering, or the chat panel itself.

## 8. Testing

- **Unit:** `lib/pocket.ts` (query matching), the toast queue (replace, 5 s expiry with a fake clock,
  own lines and the open sheet suppress it, system lines included).
- **e2e at 400×800** (Playwright, `isMobile`/`hasTouch` where it matters):
  - Critical Mass vs a bot: the site header is hidden, the board fills the screen in Top view, a bot's
    table line shows a toast, tapping it opens the sheet with the line visible and the badge cleared,
    swiping/Esc closes it, a board tap after closing makes a move.
  - The ✕ confirm during a live match (Stay keeps you; Leave goes to the lobby), no confirm as a spectator.
  - Lightline round at 400×800: the board fills the screen and a swipe still steers with the sheet closed.
  - Crown & Steel at 800×400 landscape: the pocket layout applies.
  - Regression: at 1400×900 the table page looks as today (header visible, chat beside the board).
- **Live check:** on the Foreman's phone over the LAN (`http://192.168.0.74:3000`) — a Critical Mass match
  with OLD IRON taunting, and a Lightline round.
