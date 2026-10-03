# Carry-over from Milestone 5a ("Pocket")

This file records the rulings made while building M5a, what its reviews deferred, and what to watch. M4's list is in `docs/m4-carryover.md`.

M5a makes a table run full screen on a phone (a screen 640 px wide or less, or a touch screen held sideways): the site header and the corner tiles hide, a slim bar carries ✕ (with a confirm during your own match), the game's name, Rules and a ⋯ menu with Resign; the board fills the rest; a status line shows whose move it is and the clock. The chat hides behind a floating button with an unread badge and opens as a bottom sheet. Every line from someone else pops up as a toast for 5 seconds. Critical Mass opens in Top view, turned so the board's long side follows the screen's long side (the Foreman's request; he plays it that way on desktop). Desktop is unchanged.

The build ran subagent-driven: 4 tasks (1 and 2 batched), each reviewed, a whole-branch review (Opus), one fix wave with two follow-up batches.

## Rulings made while planning

- **R-P1.** The one-line seat strip is for Critical Mass only; Crown & Steel and Lightline already show their seats inside the board.
- **R-P2.** No tap-to-close overlay over Lightline, so swipes on the visible board keep steering while the sheet is open.
- **R-P3.** The CornerDock (agent notices, your gathering card) stays visible in pocket; it is lifted above the chat button and status line.

## Rulings made while building

- **R-1.** The pure phone rule lives in `lib/pocket.ts` (bun test can't compile runes); `pocket.svelte.ts` re-exports it.
- **R-2.** The board re-aims on rotation only while resting in a Top view; a player who picked Iso keeps Iso.
- **R-3.** The toast opens on click (so the keyboard can open it); pointer events only detect swipes.
- **R-4.** Toasts follow the home channel (table talk for players, the rail for spectators) plus the open tab and any DM or group, not only the open tab as the spec said: peeking at the Rail must not silence table taunts.
- **R-5.** Blocked and ignored people never toast (a review catch: the first version bypassed them).
- **R-6.** In Lightline, while you steer, the toast takes no pointer input and sits over the status footer, never over the arena.
- **R-7.** After a match the toast moves to the top, above the result panel; the result panel sits above the chat button.
- **R-8.** The chat badge includes unread DMs and groups (the Nav, where that count lived, is hidden on a phone); tapping a DM or group toast opens that conversation.
- **R-9.** The site header hides only when the full table renders; error, loading, cleared and gathering states keep it.
- **R-10.** Not done: `viewport-fit=cover` in app.html. It would make the safe-area insets real on iPhones with a notch but changes every page's layout there; worth its own small pass.

A bug the review loop caught: the overlay that closes the sheet used to close on `pointerdown`, so the click that followed landed on the board and placed an orb. It now swallows the press and closes on the click; an e2e test taps a real legal cell above the open sheet and checks the match didn't move.

## Deferred findings (minor)

- Portrait Lightline centres an 8:5 arena in a tall column, with large empty bands above and below.
- A visible group's system lines ("X joined") toast without an author; a brand-new group's first line counts in the badge but doesn't toast.
- Esc closes both the ⋯ menu and the sheet if both are open (only possible with a hardware keyboard in Lightline).
- Crossing the pocket boundary (a desktop window resized, a tablet) remounts the chat panel and drops a draft.
- The toast's per-game offsets (CM 7rem above the camera pill, Crown & Steel 5.5rem, Lightline over the footer) were checked by screenshot for CM and Lightline, not for Crown & Steel.
- The landscape Critical Mass board is small (the camera pill's reserve and margins in a ~300 px stage).
- `toasts.test.ts`'s `msg()` helper increments its counter twice per call (harmless).

## Not verified here — the phone check

On the Foreman's phone over the LAN (`http://192.168.0.74:3000`): the keyboard lifting the sheet (visualViewport) on iOS Safari and Android Chrome, the handle drag, whether iOS opens the keyboard on the sheet's delayed focus, how the address bar showing and hiding affects the layout, and a Critical Mass match with OLD IRON taunting plus a Lightline round held both ways.
