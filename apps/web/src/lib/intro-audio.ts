/**
 * The logo intro's soundtrack: a handful of synth blips, ported from the Foreman's mock.
 * The score (INTRO_TONES) is plain data; IntroSound plays it through WebAudio.
 */
import { SILICON, TYPE_START, TYPE_STEP } from './intro-timeline';

export type Wave = 'sine' | 'square' | 'triangle';

export interface Tone {
  /** Intro time it starts, in seconds. */
  at: number;
  /** Frequency in Hz, and (for a sweep) the frequency it glides to by the end. */
  f: number;
  f2?: number;
  /** Duration in seconds. */
  d: number;
  wave: Wave;
  /** Peak gain. */
  v: number;
}

const tone = (at: number, f: number, d: number, wave: Wave, v: number, f2?: number): Tone => ({ at, f, f2, d, wave, v });

export const INTRO_TONES: Tone[] = [
  // The table assembles: rising triangle ticks.
  ...[0.15, 0.3, 0.45, 0.6].map((at, i) => tone(at, 660 + i * 110, 0.06, 'triangle', 0.05)),
  // C and Si light up.
  tone(0.95, 523, 0.5, 'sine', 0.08),
  tone(0.98, 784, 0.5, 'square', 0.025),
  // They hop out.
  tone(1.62, 220, 0.18, 'sine', 0.14, 520),
  tone(1.7, 260, 0.18, 'square', 0.04, 620),
  // "wanna play?"
  tone(2.8, 380, 0.14, 'sine', 0.16, 760),
  // Silicon types...
  ...[3.35, 3.47, 3.59, 3.71].map((at) => tone(at, 1800, 0.025, 'square', 0.03)),
  // ..."ALWAYS."
  tone(3.9, 880, 0.07, 'square', 0.05),
  tone(3.97, 1320, 0.09, 'square', 0.05),
  // Both snap home.
  tone(5.66, 180, 0.16, 'sine', 0.25, 70),
  tone(5.72, 210, 0.16, 'triangle', 0.2, 80),
  // The wordmark lands: a C-major arpeggio...
  ...[523, 659, 784, 1047].map((f, i) => tone(5.9 + i * 0.06, f, 0.6, 'sine', 0.07)),
  // ...and a teletype beep per letter of "Silicon".
  ...[...SILICON].map((_, i) => tone(TYPE_START + i * TYPE_STEP, 1500, 0.02, 'square', 0.025)),
].sort((a, b) => a.at - b.at);

/** The tones still to come once the intro has reached time `t`. */
export const tonesFrom = (t: number): Tone[] => INTRO_TONES.filter((x) => x.at >= t);

const PREF_KEY = 'cs:intro-sound';

/** Sound is on unless the player has turned it off before. */
export function loadSoundPref(): boolean {
  try {
    return localStorage.getItem(PREF_KEY) !== 'off';
  } catch {
    return true;
  }
}

export function saveSoundPref(on: boolean): void {
  try {
    localStorage.setItem(PREF_KEY, on ? 'on' : 'off');
  } catch {
    // Storage blocked (private mode, site data off): the choice just isn't remembered.
  }
}

type AudioContextCtor = typeof AudioContext;

/** Plays the score. Create the context from a user gesture (the click) so autoplay rules allow it. */
export class IntroSound {
  #ctx: AudioContext | null = null;
  #master: GainNode | null = null;
  #muted: boolean;

  constructor(muted: boolean) {
    this.#muted = muted;
  }

  /** Begin (or, after unmuting, catch up with) the score at intro time `t`. */
  play(t: number): void {
    if (this.#muted || this.#ctx) return;
    const Ctor: AudioContextCtor | undefined =
      globalThis.AudioContext ?? (globalThis as unknown as { webkitAudioContext?: AudioContextCtor }).webkitAudioContext;
    if (!Ctor) return;
    try {
      const ctx = new Ctor();
      if (ctx.state === 'suspended') void ctx.resume();
      const master = ctx.createGain();
      master.connect(ctx.destination);
      const now = ctx.currentTime;
      for (const x of tonesFrom(t)) {
        const t0 = now + (x.at - t);
        const osc = ctx.createOscillator();
        const env = ctx.createGain();
        osc.type = x.wave;
        osc.frequency.setValueAtTime(x.f, t0);
        if (x.f2) osc.frequency.exponentialRampToValueAtTime(x.f2, t0 + x.d);
        env.gain.setValueAtTime(0.0001, t0);
        env.gain.exponentialRampToValueAtTime(x.v, t0 + 0.01);
        env.gain.exponentialRampToValueAtTime(0.0001, t0 + x.d);
        osc.connect(env).connect(master);
        osc.start(t0);
        osc.stop(t0 + x.d + 0.02);
      }
      this.#ctx = ctx;
      this.#master = master;
    } catch {
      // No audio device, or the browser refused: the intro plays silent.
    }
  }

  /** Mute silences at once; unmuting resumes the score from intro time `t`. */
  setMuted(muted: boolean, t: number): void {
    this.#muted = muted;
    const ctx = this.#ctx;
    const master = this.#master;
    if (!ctx || !master) {
      if (!muted) this.play(t);
      return;
    }
    master.gain.cancelScheduledValues(ctx.currentTime);
    master.gain.setTargetAtTime(muted ? 0 : 1, ctx.currentTime, 0.004);
  }

  close(): void {
    const ctx = this.#ctx;
    this.#ctx = null;
    this.#master = null;
    if (ctx && ctx.state !== 'closed') void ctx.close().catch(() => {});
  }
}
