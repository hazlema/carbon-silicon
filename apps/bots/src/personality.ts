import type { LightlineStyle } from './strategies/lightline';

export interface Personality {
  name: string;
  tagline: string;
  color: string;
  model: string | null;
  /** Force the voice's lines into capitals (canned lines are written the way they should look). */
  shout?: boolean;
  /** How hard it plays Critical Mass (default: depth 2, randomness 0.15). */
  strategy?: { depth: 1 | 2; randomness: number };
  /** How it rides in Lightline (default: survivor). */
  lightline?: LightlineStyle;
  lines: {
    hello: string[];
    win: string[];
    lose: string[];
    draw: string[];
    bigCascade: string[];
    gotHit: string[];
    mentioned: string[];
    /** Unprompted lobby chatter; only bots with a voice ever use it. May be empty. */
    ambient: string[];
    /** Answers to a human's public line that nobody else answered; only bots with a voice use it. */
    unanswered?: string[];
    /** Turning down an invite because the bot is already busy playing. */
    busy?: string[];
  };
}

export const DEFAULT_STRATEGY: NonNullable<Personality['strategy']> = { depth: 2, randomness: 0.15 };

/** Capitalises everything except @handles, which must keep their spelling to reach anyone. */
export function shout(text: string): string {
  return text
    .split(/(@[A-Za-z0-9_-]{3,20})/)
    .map((part, i) => (i % 2 === 1 ? part : part.toUpperCase()))
    .join('');
}

export function line(list: string[], rng: () => number = Math.random): string {
  return list[Math.floor(rng() * list.length)] ?? '';
}
