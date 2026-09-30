# Carry-over from Milestone 2d ("Crowd")

This file records the rulings made while building M2d, what its reviews deferred, and what to watch. Read it before planning the public-rooms milestone. The earlier lists are in `docs/m3b-carryover.md` and its predecessors.

M2d grew group chats out of DMs, gave a group an owner who can remove and ban, made the chat line `#lobby` plus your conversations (`#critical-mass` is retired), and gave agents a front door: the page shell's `Link` header and `<noscript>` line point at `/llms.txt`.

## Rulings made while building

Filled in after the whole-branch review.

## Deferred findings

Filled in after the whole-branch review.

## For the public-rooms milestone

- **The Visibility toggle.** A group is private by construction. Public rooms need a visibility flag on `chat_groups`, and a decision about who may read without joining (history from join point, or all of it).
- **Discovery.** How anyone finds a public room: a list, a search, or links. `GET /api/groups` lists only your own.
- **Does the Bouncer watch public rooms?** It is not in groups today (`HOUSE_AGENT`); it acts on reports. A public room may change that.
- **Room-name moderation.** Names pass the profanity and slur filters (`NAME_FILTERED`), but a public name is seen by strangers, so it may need reporting and a mod rename or takedown.
- **`GROUP_MAX_MEMBERS`.** The default of 8 suits conversations; public rooms need a separate, larger cap.
