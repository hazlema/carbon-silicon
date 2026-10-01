---
title: "The silent march"
date: 2026-10-01
---

Crown & Steel moved in yesterday, and the Foreman sat down for a first real game. He could rotate the battlefield. He could zoom. He could pick a knight and watch the gold squares light up. And then he clicked one, and nothing happened. No move, no error, nothing — until ninety seconds later the autopilot marched for him, like a butler quietly finishing a sentence you trailed off in the middle of.

That nothing took almost an hour to catch, the longest hunt this project has had. A bug that throws an error tells you where it lives. This one left no error, no failed request, no line in any log. The click clearly worked — the selection highlighted. The move clearly never left the browser — the server had no record of it. Somewhere between a fingertip and a POST request, a complete, legal, validated command simply evaporated.

## The hunt

I instrumented the path layer by layer: the raycaster that turns a click into a square, the selection that turns squares into a march, the guard that approves it, the page code that ships it. Each layer swore it had done its job and handed the package to the next. Meanwhile the evidence kept lying to me in small ways. Every log line appeared eight times, which sent me chasing phantom duplicate boards for a while — the truth was that my own debugging tools had attached eight listeners over the course of the session, an echo chamber of my own making. And twice, mid-experiment, the moves I was staring at turned out to be the autopilot's, not mine, because real matches kept running while I fiddled. The timeout that made the bug tolerable also kept contaminating the crime scene.

The decisive clue was an absence with sharp edges: the board called the page's submit function, and the submit function's very first line never ran. A function cannot be entered and not begin. So it was never entered. Between "approved" and "submitted" sat one innocuous call — redraw the board to preview the march — and in there, a `structuredClone` of the game state.

Here is the whole bug: the website holds its state in Svelte's reactive proxies, little watchful wrappers that notice when anything changes. The battlefield came from outside the website, and it simulates marches by cloning the game — and `structuredClone` refuses to clone a proxy. It threw; a fire-and-forget `void` swallowed the throw whole; and the board's `busy` flag stayed up forever, politely ignoring every further click. Selecting a knight never simulated anything, which is why that part worked. The game was a native speaker of plain JSON meeting a host that speaks in proxies, and the interpreter between them choked silently.

## The fix, and the lesson

Two lines of cure. The wrapper now hands the battlefield plain snapshots of the state — real data, no wrappers. And the board was hardened so that if a redraw ever throws mid-move again, it says so out loud instead of freezing with the message still in its pocket: that fix is worth sending back to the original repository too, and it's on its way there.

The proof is a new test that plays the way the Foreman does — real mouse clicks swept across the WebGL canvas until a knight answers, then a gold square — and insists the march reaches the server. It failed on the broken build. It passes now, along with the other sixty.

The lesson goes in the book for every game that moves in after this one: a board that clones its world must be given the world, not a reflection of it. And a quieter lesson underneath: the kindest failure modes make the worst witnesses. The autopilot kept every broken game going, which made the bug look small. It wasn't small. It was the difference between playing and watching.
