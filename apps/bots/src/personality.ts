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
  /** How often it plays a random legal march in Crown & Steel instead of its best (default 0.5). */
  checkers?: { randomness: number };
  /** How well it hunts fleets in Salvo (default easy). */
  salvo?: { strength: 'easy' | 'medium' | 'hard'; style?: 'grudge' | 'finisher' | 'wanderer' };
  /** What it answers to besides its @handle, anywhere in a line (default: callName(handle)). */
  answersTo?: RegExp;
  /** Lines for one game, keyed by game id; a moment at that game's table uses them over the neutral bank. */
  byGame?: Partial<Record<string, Partial<Personality['lines']>>>;
  lines: {
    hello: string[];
    win: string[];
    lose: string[];
    draw: string[];
    bigCascade: string[];
    gotHit: string[];
    /** Salvo: going down as a ghost / a ghost's trick landing / a ghost's mine helping someone. */
    ghost?: string[];
    trick?: string[];
    backfire?: string[];
    /** Salvo: pulling a crate from a wreck I sank / someone shooting my decoy for a ship. */
    crate?: string[];
    fooled?: string[];
    mentioned: string[];
    /** Unprompted lobby chatter; only bots with a voice ever use it. May be empty. */
    ambient: string[];
    /** Answers to a human's public line that nobody else answered; only bots with a voice use it. */
    unanswered?: string[];
    /** Turning down an invite because the bot is already busy playing. */
    busy?: string[];
  };
}

export type Lines = Personality['lines'];

/** A handle as people type it in passing: OLD_IRON → "old iron", "old_iron", "oldiron", any case;
 *  never part of a longer name (not "@OLD_IRON-2", not "sprockets"). */
export function callName(handle: string): RegExp {
  const parts = handle.split(/[\s_-]+/).filter(Boolean).map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`(?<![A-Za-z0-9_-])${parts.join('[\\s_-]?')}(?![A-Za-z0-9_-])`, 'i');
}

/** Words that tie a line to Critical Mass; neutral lines must not use them (a test holds every resident to it). */
export const NEUTRAL_FORBIDDEN = /\b(orbs?|cells?|chain reactions?|cascades?|explo\w*)\b/i;

/** The bank for a moment: the game's own when it has lines for this kind, else the neutral one. */
export function linesFor(p: Personality, bank: keyof Lines, gameId?: string): string[] {
  const own = gameId ? p.byGame?.[gameId]?.[bank] : undefined;
  return own && own.length > 0 ? own : (p.lines[bank] ?? []);
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
