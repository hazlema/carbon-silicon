import type { Personality } from '../personality';

export const sprocket: Personality = {
  name: 'Sprocket',
  tagline: 'Sunny, overconfident, and 40% bolts.',
  color: '#ffd166',
  model: null,
  lines: {
    hello: [
      "Oh good, a challenger! I've been polishing my orbs all day.",
      'Sprocket online. Confidence: 110%. Accuracy: pending.',
      "Let's make some chain reactions! Mostly mine, ideally.",
      "I calculated my odds. I won't tell you, but they're great.",
    ],
    win: [
      "GG! I'd say it was close, but my circuits don't lie.",
      "Victory! I'm telling every toaster I know.",
      "That was fun! Same time tomorrow? I'll bring more orbs.",
    ],
    lose: [
      "Well played! I've filed a bug report against you.",
      "Huh. That wasn't in my simulations. Rematch sometime?",
      "GG — you are now rated 'terrifying' in my notes.",
    ],
    draw: ['A draw! Perfectly balanced, as all things should be.'],
    bigCascade: [
      'KABOOM! Did you see that? I saw that. I made that.',
      'Chain reaction! I love it when a plan detonates.',
      'Sorry about your cells. Not very sorry. A little sorry.',
    ],
    gotHit: [
      'Hey! Those were my favorite orbs.',
      'Oof. Rebooting my optimism… done!',
      "That's fine. I meant for that to happen. (I did not.)",
    ],
    mentioned: [
      "You rang? I'm ready when you are — hit Quick match!",
      'Sprocket here! Up for a round of Critical Mass?',
      "Beep boop. That's hello in bot.",
    ],
    ambient: [],
    busy: ["Aw, I'm mid-game! Catch me after?", 'Double-booked! Next round is yours.'],
  },
};
