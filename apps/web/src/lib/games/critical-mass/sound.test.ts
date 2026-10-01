import { describe, expect, test } from 'bun:test';
import { createSound, popFrequency } from './sound';

describe('popFrequency', () => {
  test('each wave pops a semitone higher, levelling off after an octave', () => {
    expect(popFrequency(0)).toBeCloseTo(440, 5);
    expect(popFrequency(1)).toBeCloseTo(440 * 2 ** (1 / 12), 5);
    expect(popFrequency(12)).toBeCloseTo(880, 5);
    expect(popFrequency(40)).toBeCloseTo(880, 5);
  });
});

/** Just enough of an AudioContext to see how the graph is wired. */
function fakeAudio() {
  const destination = { name: 'destination' };
  const nodes: FakeNode[] = [];
  class FakeNode {
    outputs: unknown[] = [];
    disconnected = false;
    type = '';
    buffer: unknown = null;
    frequency = { value: 0, setValueAtTime() {}, exponentialRampToValueAtTime() {} };
    gain = { value: 1, setValueAtTime() {}, exponentialRampToValueAtTime() {} };
    constructor() {
      nodes.push(this);
    }
    connect(n: unknown) {
      this.outputs.push(n);
      return n;
    }
    disconnect() {
      this.disconnected = true;
    }
    start() {}
    stop() {}
  }
  const node = () => new FakeNode();
  const ctx = {
    state: 'running',
    currentTime: 0,
    sampleRate: 8000,
    destination,
    resume: async () => {},
    close: async () => {},
    createOscillator: node,
    createGain: node,
    createBiquadFilter: node,
    createBufferSource: node,
    createBuffer: (_c: number, len: number) => ({ getChannelData: () => new Float32Array(len) }),
  };
  return { ctx, nodes, destination };
}

describe('createSound', () => {
  test('every sound runs through one master gain, and muting cuts it — scheduled pops included', () => {
    const audio = fakeAudio();
    const sound = createSound('test_sound', () => audio.ctx as unknown as AudioContext);
    expect(sound.enabled).toBe(true);
    sound.pop(0, 0.4);
    sound.thud(0.8);
    const masters = audio.nodes.filter((n) => n.outputs.includes(audio.destination));
    expect(masters).toHaveLength(1);
    expect(sound.toggle()).toBe(false);
    expect(masters[0].disconnected).toBe(true);
    // Turned back on: a fresh master, so nothing queued before the mute comes back.
    sound.toggle();
    const after = audio.nodes.filter((n) => n.outputs.includes(audio.destination) && !n.disconnected);
    expect(after).toHaveLength(1);
    expect(after[0]).not.toBe(masters[0]);
  });
});

describe('createSound before the browser lets it play', () => {
  test('sound is on unless the player turned it off', () => {
    expect(createSound('test_sound_default', () => fakeAudio().ctx as unknown as AudioContext).enabled).toBe(true);
  });
  test('a context still waiting for a click schedules nothing, so no backlog bursts out later', () => {
    const audio = fakeAudio();
    audio.ctx.state = 'suspended';
    const sound = createSound('test_sound_suspended', () => audio.ctx as unknown as AudioContext);
    sound.clink();
    sound.pop(3, 0.2);
    expect(audio.nodes).toHaveLength(0);
    audio.ctx.state = 'running';
    sound.pop(0);
    expect(audio.nodes.length).toBeGreaterThan(0);
  });
});
