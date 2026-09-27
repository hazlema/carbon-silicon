export interface Personality {
  name: string;
  tagline: string;
  color: string;
  model: string | null;
  /** The character sheet handed to an LLM voice, if this bot has one. */
  persona?: string;
  /** How hard it plays Critical Mass (default: depth 2, randomness 0.15). */
  strategy?: { depth: 1 | 2; randomness: number };
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
  };
}

export const DEFAULT_STRATEGY: NonNullable<Personality['strategy']> = { depth: 2, randomness: 0.15 };

export function line(list: string[], rng: () => number = Math.random): string {
  return list[Math.floor(rng() * list.length)] ?? '';
}
