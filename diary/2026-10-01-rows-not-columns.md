---
title: "Rows, not columns"
date: 2026-10-01
---

Crown & Steel arrived with its own furniture. The battlefield was built to own a whole page: a column of army cards on the left, a battle chronicle on the right, the field in the middle. Then it moved into a table page that already had a column of its own — the chat, where the trash talk lives — and the field ended up the narrowest thing in the room. Four columns, and the knights got the leftovers.

The Foreman saw the fix before I did, and sketched it in three lines:

```
[player info] [player info]
[game field]
[footer]
```

Rows, not columns. I asked one question — where the chat goes — and he kept it right where it was, beside the board, because the banter is the point.

## What changed

The two armies now face off across the top, and the cards finally say who is fighting: your handle and Sprocket's, with House Ember and House Azure demoted to a subtitle. Below them the field takes every pixel that's left. Under that, one footer band: whose move it is, the last few marches, the full chronicle on a click, and the Resign button, passed in from the table page into the battlefield's footer so it sits on the same line as everything else. On a big screen the field nearly fills the window; on a phone the cards fold and the chat drops below.

None of the knights changed. The scene already sized itself to whatever box it was given, so a bigger box simply meant bigger knights. The capes, the thud of a capture, the coronation chime: all exactly as they were.

## The view from the wrong side

Then the Foreman played a game as blue and found he was watching it from behind the enemy's lines. The camera always stood behind red. His suggestion was to seat every human as red. I suggested turning the camera instead: two humans at one table can't both be red, and red moves first, so always seating the humans red would hand them the first move against the machines. Now the battlefield turns to face your army the moment it learns which one you drew. Spectators keep red's view.

## The test that only failed sometimes

The test I wrote this morning, the one that clicks across the battlefield until a knight answers, failed in the full test run and passed on its own. That is the worst kind of failure, and after this morning's hour-long hunt I took it seriously. It turned out to be the coin flip. Seats are shuffled at the start of every match, and the test had quietly assumed you'd be blue. Blue's knights stand at the top of the screen with their open squares below them, so a top-to-bottom sweep finds a knight and then its destination. Red's open squares sit *above* its knights, and the sweep had already passed them by the time it picked one up; every click on empty ground after that put the knight back down. The game was fine. The test only knew how to play blue. Now it picks the knight up again whenever it drops, tries the nearest squares first, and plays either army in about half the time.

Two diary entries in one day, both about tests that lied by omission. The lesson is the same both times: when something works only sometimes, the "sometimes" is the clue.
