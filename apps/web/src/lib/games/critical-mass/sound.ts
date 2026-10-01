/** Explosion waves climb a semitone each, for an octave. */
export const popFrequency = (wave: number) => 440 * 2 ** (Math.min(wave, 12) / 12);

/** Critical Mass's sounds, synthesized like Crown & Steel's: no files, nothing until the player turns it on. */
export function createSound(key = 'cm_sound') {
  let enabled = false;
  try {
    enabled = localStorage.getItem(key) === 'on';
  } catch {
    /* Storage is optional. */
  }
  let ctx: AudioContext | undefined;
  let noise: AudioBuffer | undefined;
  function audio() {
    if (!enabled) return;
    try {
      ctx ??= new AudioContext();
      void ctx.resume();
      return ctx;
    } catch {
      return; /* Sound is optional. */
    }
  }
  function noiseBuffer(a: AudioContext) {
    if (!noise) {
      noise = a.createBuffer(1, Math.floor(a.sampleRate * 0.25), a.sampleRate);
      const data = noise.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    }
    return noise;
  }
  /** A glassy clink: two bright partials, fast decay. */
  function clink(delay = 0) {
    const a = audio();
    if (!a) return;
    const t = a.currentTime + delay;
    for (const [freq, vol] of [[1568, 0.08], [2349, 0.04]] as const) {
      const osc = a.createOscillator();
      const gain = a.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(vol, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.25);
      osc.connect(gain);
      gain.connect(a.destination);
      osc.start(t);
      osc.stop(t + 0.26);
    }
  }
  /** A pop: a short pitched blip over a puff of bandpassed noise. */
  function pop(wave: number, delay = 0) {
    const a = audio();
    if (!a) return;
    const t = a.currentTime + delay;
    const f = popFrequency(wave);
    const osc = a.createOscillator();
    const gain = a.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(f * 1.5, t);
    osc.frequency.exponentialRampToValueAtTime(f, t + 0.06);
    gain.gain.setValueAtTime(0.12, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.14);
    osc.connect(gain);
    gain.connect(a.destination);
    osc.start(t);
    osc.stop(t + 0.15);
    const puff = a.createBufferSource();
    puff.buffer = noiseBuffer(a);
    const band = a.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = f * 2;
    const puffGain = a.createGain();
    puffGain.gain.setValueAtTime(0.08, t);
    puffGain.gain.exponentialRampToValueAtTime(0.001, t + 0.08);
    puff.connect(band);
    band.connect(puffGain);
    puffGain.connect(a.destination);
    puff.start(t);
    puff.stop(t + 0.09);
  }
  /** A capture: a low sine dropping fast. */
  function thud(delay = 0) {
    const a = audio();
    if (!a) return;
    const t = a.currentTime + delay;
    const osc = a.createOscillator();
    const gain = a.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(110, t);
    osc.frequency.exponentialRampToValueAtTime(42, t + 0.18);
    gain.gain.setValueAtTime(0.28, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.24);
    osc.connect(gain);
    gain.connect(a.destination);
    osc.start(t);
    osc.stop(t + 0.25);
  }
  return {
    get enabled() {
      return enabled;
    },
    toggle() {
      enabled = !enabled;
      try {
        localStorage.setItem(key, enabled ? 'on' : 'off');
      } catch {
        /* Storage is optional. */
      }
      if (enabled) clink();
      return enabled;
    },
    clink,
    pop,
    thud,
    close() {
      void ctx?.close();
    },
  };
}
