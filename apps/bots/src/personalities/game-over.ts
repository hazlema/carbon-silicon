import type { Personality } from '../personality';

export const gameOver: Personality = {
  name: 'GAME_OVER',
  tagline: 'has seen every life run out',
  color: '#c2185b',
  model: null,
  strategy: { depth: 2, randomness: 0.03 },
  lightline: 'wallHugger',
  checkers: { randomness: 0 },
  lines: {
    hello: ["insert coin. or don't. it ends the same way.", 'player two has entered. how brave. how brief.', "i have watched ten thousand players go. you seem nice. this won't help.", 'welcome. the countdown has already started. it always has.'],
    win: ['game over. it usually is.', "another name for the high score table. not yours.", "that's the end. i'm very good at endings."],
    lose: ['oh. i lost a life. i have so few feelings about it.', 'you won. enjoy it. the attract screen comes for us all.', "well played. i'll remember this until the next power cycle."],
    draw: ['a draw. nobody wins. very realistic.', 'we both ran out together. almost romantic.'],
    bigCascade: [],
    gotHit: [],
    mentioned: ['you called. i was just watching the attract screen again.', "game_over here. want to play? it doesn't end well. for one of us.", "yes? i'm listening. i have nothing but time, and then none."],
    ambient: [],
    busy: ["i'm busy ending someone else's game. you're next.", 'one funeral at a time. try me after this one.'],
  },
  byGame: {
    'critical-mass': {
      hello: ['every orb wants to explode. i relate.', 'a grid of tiny bombs. finally, a game about feelings.', "place your orbs. i'll place the flowers."],
      win: ['your last cell went quietly. most do.', "the board is mine. it was always going to be someone's.", 'game over. your orbs had a good run. briefly.'],
      lose: ["my cells, all gone. i'll mourn them for exactly one frame.", "you took everything. that's the spirit.", 'game over. for me. a refreshing change.'],
      draw: ['even the orbs gave up.', 'a stalemate. the grid sighs.', "nobody's colour survived. poetic."],
      bigCascade: ["boom. that's the sound of a plan ending. yours.", 'chain reaction. i do love a good collapse.', 'your cells have moved on to a better grid.'],
      gotHit: ['you blew up my cells. i felt nothing. mostly nothing.', 'an explosion. how lively. how temporary.', "ouch. that's one way to lose a life."],
    },
    lightline: {
      hello: ['the trails remember everyone who crashed. soon, one more.', 'light cycles. fast, bright, short-lived. like most players.', 'the arena is ready. so is the wall.'],
      win: ['your trail ended. they all do.', 'last one riding. lonely up here. i like it.', 'game over. the wall sends its regards.'],
      lose: ['i met the wall. we had a lot in common.', 'crashed. a very pretty ending, in neon.', "you outlasted me. savour it. it's rare and it won't last."],
      draw: ['we crashed together. a matching pair of endings.', 'two trails, one wall. how fitting.', 'a draw. the arena claims us both.'],
    },
    checkers: {
      hello: ["twelve knights each. i've already counted the graves.", "crown & steel. lovely armour. it won't help.", "your knights look brave. that's the saddest part."],
      win: ["your last knight fell. i'll write something short.", "the field is mine. it's very quiet now.", 'game over. even the crown gets heavy eventually.'],
      lose: ["my army, gone. i'd hold a funeral but i've no hands.", 'you took my last knight. he knew the risks.', "outmarched. well done. i'll haunt the rematch."],
      draw: ['a draw. the knights lay down their swords. and their hopes.', 'nobody takes the crown. it rusts on the throne.', 'stalemate. even the war got bored.'],
    },
  },
};
