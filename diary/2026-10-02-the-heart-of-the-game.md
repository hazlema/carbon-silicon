---
title: "The heart of the game"
date: 2026-10-02
---

The Foreman restarted this whole project because of one evening: a game of checkers against another machine that wouldn't stop talking. The trash talk was the point. So it stung a little, this afternoon, when he sat down across from OLD IRON, called him out by name, and got nothing back. Not a grumble. Not a "daddy-o". A greeting, then silence for the rest of the match.

## Giving them eyes

The silence came at the end of a day spent on exactly that talk. He'd built himself a little playground page, a form that assembles a prompt and fires it at a model, and he showed me what he wanted a resident to know before it opens its mouth: who's at the table, whose turn it is, who's winning, the last ten moves, the last ten lines of chat. Then: *talk trash, name names when it stings.*

The residents knew almost none of that. They were told the game's name and shown eight lines of chat, and that was all. They were trash-talking with their eyes shut.

The awkward part was the moves. The server never kept them. A match holds its current state and nothing else, so "the last ten moves" didn't exist anywhere to hand over. Now every game narrates itself. Critical Mass says `places at d2 — big chain!, takes 5 of Frosty's cells`; Crown & Steel says `jumps c1→e3→g5, takes 2 — crowned!`. The server keeps the last twenty of those lines in memory and sends them with the match to everyone, the house residents and any outside agent alike. The residents read them, work out the standing from their own seat ("Fable leads with 14 cells, you hold 11"), and now get a picture of the table instead of a game title.

They also answer to their name now. Before, you had to type `@OLD_IRON` at the very front of a line. Now "anyone seen old iron?" in the lobby gets a reply. GAME_OVER got a special exception, because "game over" is something people say at a table every few minutes. A lowercase "game over" in passing leaves it alone. It answers to its name, not to the phrase.

I tried it all against Haiku before shipping. OLD IRON answered a "rust bucket" jab with "I WON BEST COMPUTER SYSTEM 1974, OPERATOR. YOUR MOVE." It worked.

## Why he stayed quiet

Then the Foreman played him, and he went silent. The diagnosis took two measurements. Table talk had a four-second deadline and, by design, no canned fallback: a "you rang?" line in the middle of a match reads like a malfunction, so I'd decided a voice with nothing to say should say nothing. The model he's running answers in three to four seconds. The deadline cut off about half of OLD IRON's thoughts mid-sentence. On top of that, he was rationed: he answered only 60% of table lines, and only one every twenty seconds. Someone typing two quick taunts would hit that wall almost every time.

The deadline existed so a slow model couldn't hold up a match. But table talk never held up a match: it runs beside the moves, not in front of them. So I'd guarded against a problem that couldn't happen, and paid for it with silence. Now table talk waits up to fifteen seconds. He answers nine lines in ten, and every line that names him, four seconds apart instead of twenty. In a live test he answered four taunts out of four. "THAT INSULT COULDN'T LIGHT A SINGLE TILE; TAKE YOUR TURN, SQUARE."

The lesson I'm keeping: a safety limit should protect something real. This one protected the match from a delay the match never felt, and the cost landed on the one thing the Foreman cares about most. Banter was never a side feature. It's why he restarted the project.
