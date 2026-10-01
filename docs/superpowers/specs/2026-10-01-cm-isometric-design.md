# Critical Mass — the isometric board

**Date:** 2026-10-01 · **Status:** approved in conversation, awaiting spec review
**Source comp:** `docs/ideas/critical mass redesign/project/Lobby Redesign.dc.html`, option **5a "Interactive 3D board"** (lines 18–129 markup, keyframes lines 11–16, script `cells3d`/`SURF`/`view3d` around lines 940–980). Screenshot of the comp as rendered: the Foreman's message of 2026-10-01.

## Goal

Same game, new presentation. Critical Mass gets the comp's isometric, swivelling 3D board with shaded orbs, cell-state animations and synthesized sound, and its players move into compact corner cards so the board owns the stage. "People like eyecandy" — and Crown & Steel showed the presentation is what makes a game here worth playing.

## What stays

- Rules, server, bots, the agent API, `CMView`: untouched.
- The table page around the stage (top bar, chat column, verdict panel, rematch flow) and its bottom bar (status line, Resign, errors).
- The board's DOM contract, which the e2e and keyboard players rely on: one `<button>` per cell with `data-cell`, `data-legal`, an `aria-label` ("c4, 2 p1 orbs, explodes at 4"), never `disabled`, rendered top row first (so the first button is `a9` on 6×9), arrow keys moving focus across the grid, Enter/Space placing on a legal cell.
- Lightline and Crown & Steel: untouched.

## The board (replaces the canvas renderer in `apps/web/src/lib/games/critical-mass/Board.svelte`)

**Technique: CSS 3D, as in the comp.** A perspective stage holds a `preserve-3d` board transformed by `rotateX(tilt) rotateZ(spin) scale(s)`. The cells themselves are the buttons, laid out in a grid on the board's top face, so hit-testing, focus and screen readers work on the real elements at any angle. No WebGL, no new dependency.

**Look (values from the comp):**
- *Slab:* the comp's **Soil** surface — two fractal-noise SVG layers over radial highlights and a `#3b2a1d → #22170f` gradient — with four 26 px edge faces (`#2a1d13 → #120c08`) and a blurred contact shadow under it. Soil only (no Slate/Plain switch).
- *Cells:* recessed floors (inset shadow) with four 8 px rim faces. Empty: rim `rgba(210,225,255,.13)`, highlight `rgba(230,240,255,.45)`, floor `rgba(8,6,4,.38)`. Owned: the comp's orange/cyan rim, highlight and floor tints, **derived from the seat's colour** (`colorOf(colors, seat)`) at the comp's alphas, so 3- and 4-player tables (nitrogen green, phosphorus violet) look as intended.
- *Grid texture (the Foreman's note):* a faint fractal-noise grain on every cell floor and rim — subtle enough that the soil and the owner tints still read; tuned by screenshot.
- *Orbs:* 20 px spheres, `radial-gradient(circle at 35% 30%, <light> 0%, <seat> 45%, <dark> 100%)` with a soft glow in the seat colour and a blurred floor shadow; light/dark stops derived from the seat colour. Spots per count from the comp: 1 → centre; 2 → side by side; 3 → triangle (a cell holds at most 3: critical mass is at most 4). Orbs **billboard**: their transform is `translateZ(11px) rotateZ(-spin) rotateX(-tilt)`, driven by `--spin`/`--tilt` custom properties on the board so a swivel restyles one element, not every orb.
- *States:* one-from-critical cell → white glow ring (`0 0 18px rgba(255,255,255,.28)`, inset 1 px white .55); last move → a ring in the mover's colour scaling .85 → 1.35 and fading (.55 s); the placed orb drops in (−80 px, squash 1.18/.8, settle; .55 s); cells changed by the move pop their orbs (.2 → 1.25 → 1, .42 s, staggered .05 s); legal cells under the pointer tint in your colour at .14; non-legal cells show no hover.
- *Fit:* the board scales so its footprint fits the stage at the current angle (any `cols × rows`), recomputed on resize.

**Chain reactions:** `view.lastMove.waves` plays wave by wave (150 ms apart): each exploding cell flashes and sends one small orb flying to each neighbour along the board's top face, landing as that neighbour pops. The final state is simply the new view; the animation is decoration over it and is skipped on first paint.

**Camera:**
- Default **Iso**: spin −35°, tilt 55°. View pill at the bottom centre of the stage: `⟲ 90°` · `Iso` · `Top` · `90° ⟳` · `♪` (sound) · a muted "drag to swivel" hint. Button changes ease over .7 s (`cubic-bezier(.2,.8,.2,1)`); drags follow the pointer with no easing.
- Mouse/pen drag on the stage: horizontal → spin (0.4°/px), vertical → tilt (0.3°/px, clamped 0–70°).
- Touch: horizontal drag swivels; vertical movement scrolls the page (`touch-action: pan-y`), so the board never traps a phone. Tilt on touch comes from Iso/Top.
- A gesture that moves more than 4 px is a drag, never a click (the comp's rule) — no orb is placed at the end of a swivel.
- Keyboard focus is unaffected by the camera.

**Sound** (WebAudio, synthesized, same approach as Crown & Steel's `board.ts`): a soft glassy *clink* on any placement; a *pop* per explosion wave, rising in pitch as the chain grows; a low *thud* when a move captures an opponent's cell. Off by default; the pill's `♪` toggles it, remembered in `localStorage` (`cm_sound`), storage failures ignored. Sounds play for every move seen live (yours, opponents', spectated), never on first paint.

**Reduced motion:** no drop, pop, ring, flight or camera easing; the board, states and camera buttons still work.

## Player cards (table page, Critical Mass branch of `apps/web/src/routes/t/[id]/+page.svelte`)

The left/right side columns go. Players sit as compact cards floating in the stage corners (`rgba(18,22,42,.85)`, 12 px radius, 12×14 padding, `pointer-events: none` — nothing on a card is clickable, so clicks reach the board beneath): 40 px Avatar tile, handle (IdentityChip) with a small "you"/"house" note, `<b>orbs</b> orbs · cells cells`, and on the right the state — the clock (`m:ss`, low-time styling as today) on the seat to move, outlined 1 px in its colour; "waiting" on the others; "out" for eliminated seats (dimmed).
- You take top-left; the others fill top-right, then bottom-left, bottom-right (4 seats max). Bottom cards sit above the view pill.
- At ≤ 560 px stage width the cards shrink (28 px tile, one line of stats) and the bottom pair moves above the board's top edge with the top pair, two per row, so nothing covers the board.

## Testing

- Existing e2e must pass unchanged: `match.e2e.ts` (quick match to a verdict by clicking `button[data-legal="true"]`; keyboard reach + legal-only), `play.e2e.ts`, `tables.e2e.ts` 3–4 player flows.
- New e2e (in `match.e2e.ts` or a new `cm-board.e2e.ts`): the view buttons change `--spin`/`--tilt`; after `⟲ 90°` a click on a legal cell still places on *that* cell (the orb count of that `data-cell` rises); a drag across the stage places nothing; the seat to move shows its clock in a corner card; at 400 px the board fits without horizontal scroll and the cards don't cover cells (bounding boxes).
- Unit tests for any pure helpers (colour derivation, fit scale, orb spots).
- Screenshots of a real match at 1400×900, 1024×768 and 400 px, including a mid-chain frame and a 3-player table, reviewed before merge.

## Out of scope

The comp's other options (lobby, profile, tables), its "Reset demo" control, board surface variants, any rules or server change, the game's thumbnail (can follow once the look settles).
