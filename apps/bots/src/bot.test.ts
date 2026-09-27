import { afterAll, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CMCommand } from '@cs/critical-mass';
import { createCore } from '@cs/server/core';
import { createApp } from '@cs/server/http';
import { startServer } from '@cs/server/server';
import { ambientDue, runBot, type BotOptions } from './bot';
import { Client } from './client';
import { shout } from './personality';
import { oldIron } from './personalities/old-iron';
import { sprocket } from './personalities/sprocket';
import type { Moment, Voice } from './voice';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const core = await createCore({ databaseUrl: 'pglite:memory', houseKey: 'hk', adminHandles: [], diaryDir: join(root, 'no-diary'), countdownMs: 0, houseFallbackMs: 100 });
const running = startServer(core, createApp(core, { apiDocs: '', llmsTxt: '' }), { port: 0, hostname: '127.0.0.1', webDir: null, allowedOrigins: [] });
const controller = new AbortController();
const tokenFile = join(root, `.data/test-bots/${crypto.randomUUID()}.token`);
const botDone = runBot({ base: running.url, personality: sprocket, houseKey: 'hk', tokenFile, thinkMs: [0, 0], pollWaitMs: 500, signal: controller.signal, log: () => {} });

// A second parlor with OLD IRON as its only house bot, speaking through a fake voice (no LLM),
// so quick matches there always seat OLD IRON and never Sprocket.
const ironCore = await createCore({ databaseUrl: 'pglite:memory', houseKey: 'hk', adminHandles: [], diaryDir: join(root, 'no-diary'), countdownMs: 0, houseFallbackMs: 100 });
const ironServer = startServer(ironCore, createApp(ironCore, { apiDocs: '', llmsTxt: '' }), { port: 0, hostname: '127.0.0.1', webDir: null, allowedOrigins: [] });
const ironController = new AbortController();
const heard: Moment[] = [];
let voiceMode: 'talk' | 'silent' | 'hang' = 'talk';
const fakeVoice: Voice = {
  say(m) {
    heard.push(m);
    if (voiceMode === 'hang') return new Promise<string | null>(() => {}); // ignores its signal, too
    return Promise.resolve(voiceMode === 'silent' ? null : `VOICE ${m.kind.toUpperCase()} LINE.`);
  },
};
let ironReady = () => {};
const ironListening = new Promise<void>((resolve) => (ironReady = resolve));
const VOICE_DEADLINE_MS = 300;
const ironDone = runBot({
  base: ironServer.url,
  personality: oldIron,
  voice: fakeVoice,
  tableTalkChance: 1,
  replyCooldownMs: 0, // tests talk to it back to back
  voiceDeadlineMs: VOICE_DEADLINE_MS,
  ambientEveryMs: 0,
  onReady: () => ironReady(),
  houseKey: 'hk',
  tokenFile: join(root, `.data/test-bots/${crypto.randomUUID()}.token`),
  thinkMs: [0, 0],
  pollWaitMs: 500,
  signal: ironController.signal,
  log: () => {},
});

afterAll(async () => {
  controller.abort();
  ironController.abort();
  await Promise.all([botDone, ironDone]);
  await Promise.all([running.stop(), ironServer.stop()]);
  await Promise.all([core.close(), ironCore.close()]);
});

/** A short random tag for test handles. Digits only — a base-36 tag can occasionally spell
 *  something the profanity filter rejects, which would fail these tests in setup. */
const randomTag = () => String(Math.floor(Math.random() * 1e9)).padStart(9, '0');

/** Registers an agent from its own made-up address: the server allows five agent registrations per
 *  address per hour, and the bots under test register from the loopback address themselves. */
async function newAgent(base: string, name: string, houseKey?: string): Promise<{ client: Client; handle: string }> {
  const client = new Client(base);
  const ip = `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}`;
  const reg = await client.call<{ identity: { handle: string }; token: string }>('POST', '/api/agents', { name }, { 'x-forwarded-for': ip, ...(houseKey ? { 'x-house-key': houseKey } : {}) });
  client.token = reg.token;
  return { client, handle: reg.identity.handle };
}

async function until<T>(fn: () => Promise<T | null | undefined | false>, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await Bun.sleep(20);
  }
  throw new Error('timed out');
}

describe('Sprocket', () => {
  test('shows up, gets matched by quick match, plays to the end, and talks', async () => {
    const guest = new Client(running.url);
    await until(async () => (await guest.call<{ presence: { identity: { handle: string; isHouse: boolean } }[] }>('GET', '/api/who')).presence.find((p) => p.identity.handle === 'Sprocket' && p.identity.isHouse));
    guest.token = (await newAgent(running.url, `challenger${randomTag()}`)).client.token;
    expect((await guest.quickMatch('critical-mass')).status).toBe('queued');
    const matchId = await until(async () => (await guest.me()).activeMatch);
    let env = await guest.match(matchId);
    expect(env.match.seats.map((s) => s.identity.handle)).toContain('Sprocket');
    while (env.match.status !== 'over') {
      if (env.match.status === 'live' && env.legal.length > 0) {
        try {
          env = await guest.move(matchId, env.match.revision, env.legal[0] as CMCommand);
        } catch {
          env = await guest.match(matchId);
        }
      } else {
        env = await guest.match(matchId, env.match.revision, 5000);
      }
    }
    expect(env.match.outcome?.winners).toHaveLength(1);
    const table = await until(async () => {
      const r = await guest.call<{ messages: { author: { handle: string } | null; text: string }[] }>('GET', `/api/chat/match:${matchId}`);
      const said = r.messages.filter((m) => m.author?.handle === 'Sprocket').map((m) => m.text);
      return said.length >= 2 ? said : null;
    });
    expect(sprocket.lines.hello).toContain(table[0]);
  }, 60_000);

  test('greets exactly once per match', async () => {
    const guest = new Client(running.url);
    guest.token = (await newAgent(running.url, `challenger${randomTag()}`)).client.token;
    expect((await guest.quickMatch('critical-mass')).status).toBe('queued');
    const matchId = await until(async () => (await guest.me()).activeMatch);
    // Sprocket greets as soon as it notices the match (playMatch says hello before its first
    // move), so we don't need to play the match out to see it — doing so made this test's
    // duration depend on how long a whole game against a random opponent takes, which could run
    // long enough that the wait for the greeting (which had already long since happened) timed
    // out under the CPU contention of a full `bun test apps/server apps/bots` run with many
    // concurrent in-memory PGlite instances. Observing the greeting and then resigning keeps the
    // test's duration bounded by Sprocket's poll interval instead.
    const hellos = await until(async () => {
      const r = await guest.call<{ messages: { author: { handle: string } | null; text: string }[] }>(
        'GET',
        `/api/chat/match:${matchId}?since=0&limit=200`,
      );
      const said = r.messages.filter((m) => m.author?.handle === 'Sprocket' && sprocket.lines.hello.includes(m.text));
      return said.length >= 1 ? said : null;
    });
    await guest.call('POST', `/api/matches/${matchId}/resign`).catch(() => {}); // best-effort cleanup
    expect(hellos).toHaveLength(1);
  }, 60_000);

  test('a house bot that loses its token file recovers by re-registering with the house key', async () => {
    const gizmo = { ...sprocket, name: 'Gizmo' };
    const gizmoTokenFile = join(root, `.data/test-bots/${crypto.randomUUID()}.token`);
    const who = new Client(running.url);
    const isGizmoUp = async () =>
      (await who.call<{ presence: { identity: { handle: string; isHouse: boolean } }[] }>('GET', '/api/who')).presence.find(
        (p) => p.identity.handle === 'Gizmo' && p.identity.isHouse,
      );
    const start = (signal: AbortSignal) =>
      runBot({ base: running.url, personality: gizmo, houseKey: 'hk', tokenFile: gizmoTokenFile, thinkMs: [0, 0], pollWaitMs: 500, signal, log: () => {} });

    let controller = new AbortController();
    let done = start(controller.signal);
    try {
      await until(isGizmoUp);
    } finally {
      controller.abort();
      await done;
    }

    await Bun.file(gizmoTokenFile).delete();

    controller = new AbortController();
    done = start(controller.signal);
    try {
      const recovered = await until(isGizmoUp);
      expect(recovered?.identity.isHouse).toBe(true);
    } finally {
      controller.abort();
      await done;
    }
  }, 30_000);
});

type Said = { messages: { id: number; author: { handle: string } | null; text: string }[] };

describe('OLD IRON (a bot with a voice)', () => {
  // Only OLD IRON and Rivet (plus Rivet's one profile refresh) register from the loopback address,
  // three of the five allowed per hour; guests and Cog register through newAgent.
  const ironUp = () => ironListening;
  let theGuest: Promise<{ client: Client; handle: string }> | null = null;
  const guest = () => (theGuest ??= newAgent(ironServer.url, `guest${randomTag()}`));
  const ironSaid = async (client: Client, channel: string, pred: (text: string) => boolean) =>
    until(async () => {
      const r = await client.call<Said>('GET', `/api/chat/${encodeURIComponent(channel)}?since=0&limit=200`);
      return r.messages.find((m) => m.author?.handle === 'OLD_IRON' && pred(m.text))?.text;
    });
  /** Mentions a bot in #lobby and returns its reply to that message. */
  const mentionAndWait = async (client: Client, botHandle: string, text: string) => {
    const posted = (await client.chat('lobby', text)) as { message: { id: number } };
    return until(async () => {
      const r = await client.call<Said>('GET', `/api/chat/lobby?since=${posted.message.id}`);
      return r.messages.find((m) => m.author?.handle === botHandle)?.text;
    });
  };

  test('answers a mention in #lobby with its voice, addressed to whoever mentioned it', async () => {
    await ironUp();
    voiceMode = 'talk';
    const { client, handle } = await guest();
    const reply = await mentionAndWait(client, 'OLD_IRON', 'morning @OLD_IRON, how are the punch cards?');
    expect(reply).toBe(`@${handle} VOICE MENTION LINE.`);
    const asked = heard.find((m) => m.kind === 'mention' && m.addressedBy === handle)!;
    expect(asked.channel).toBe('lobby');
    expect(asked.answering).toEqual({ author: handle, kind: 'agent', text: 'morning @OLD_IRON, how are the punch cards?' });
    expect(asked.recent.map((l) => [l.author, l.kind, l.text])).toContainEqual([handle, 'agent', 'morning @OLD_IRON, how are the punch cards?']);
  }, 30_000);

  test('falls back to its canned mention lines when the voice has nothing', async () => {
    await ironUp();
    voiceMode = 'silent';
    try {
      const { client, handle } = await guest();
      const before = heard.length;
      const reply = await mentionAndWait(client, 'OLD_IRON', '@OLD_IRON are you awake?');
      expect(reply.startsWith(`@${handle} `)).toBe(true);
      expect(oldIron.lines.mentioned).toContain(reply.slice(`@${handle} `.length));
      expect(heard.slice(before).some((m) => m.kind === 'mention' && m.addressedBy === handle)).toBe(true);
    } finally {
      voiceMode = 'talk';
    }
  }, 30_000);

  test('answers table talk from its opponent through the voice', async () => {
    await ironUp();
    voiceMode = 'talk';
    const { client, handle } = await guest();
    expect((await client.quickMatch('critical-mass')).status).toBe('queued');
    const matchId = await until(async () => (await client.me()).activeMatch);
    const table = `match:${matchId}`;
    try {
      expect(await ironSaid(client, table, (t) => t === 'VOICE HELLO LINE.')).toBe('VOICE HELLO LINE.');
      expect(heard.find((m) => m.kind === 'hello' && m.channel === table)?.opponent).toBe(handle);
      await client.chat(table, 'your corner is toast, grandpa');
      expect(await ironSaid(client, table, (t) => t === 'VOICE TABLETALK LINE.')).toBe('VOICE TABLETALK LINE.');
      const asked = heard.find((m) => m.kind === 'tableTalk' && m.channel === table)!;
      expect(asked.opponent).toBe(handle);
      expect(asked.recent.map((l) => l.text)).toContain('your corner is toast, grandpa');
      expect(asked.answering?.text).toBe('your corner is toast, grandpa');
    } finally {
      await client.call('POST', `/api/matches/${matchId}/resign`).catch(() => {});
    }
  }, 30_000);

  test('a hanging voice cannot hold up a match: the canned hello and the first move come on time', async () => {
    await ironUp();
    const { client } = await guest();
    voiceMode = 'hang';
    let matchId: string | null = null;
    try {
      expect((await client.quickMatch('critical-mass')).status).toBe('queued');
      matchId = await until(async () => (await client.me()).activeMatch);
      const table = `match:${matchId}`;
      const seen = Date.now();
      const hello = await ironSaid(client, table, () => true);
      // Deadline plus one inbox poll (500 ms) plus slack; without the deadline this never arrives.
      expect(Date.now() - seen).toBeLessThan(VOICE_DEADLINE_MS + 2500);
      expect(oldIron.lines.hello).toContain(hello);
      let env = await client.match(matchId);
      const ironSeat = env.match.seats.find((s) => s.identity.handle === 'OLD_IRON')!.seat;
      if (env.you && env.match.toMove.includes(env.you)) env = await client.move(matchId, env.match.revision, env.legal[0] as CMCommand);
      const moved = Date.now();
      await until(async () => ((await client.match(matchId!)).view as { moved: string[] }).moved.includes(ironSeat), 5000);
      expect(Date.now() - moved).toBeLessThan(VOICE_DEADLINE_MS + 2500);
    } finally {
      voiceMode = 'talk';
      if (matchId) await client.call('POST', `/api/matches/${matchId}/resign`).catch(() => {});
    }
  }, 30_000);

  test('ignores mentions from other house bots, so two residents cannot ping-pong forever', async () => {
    await ironUp();
    voiceMode = 'talk';
    const cog = await newAgent(ironServer.url, `Cog${randomTag()}`, 'hk');
    await cog.client.setStatus('afk'); // a second ready house bot could be seated by later quick matches
    const before = heard.length;
    const posted = (await cog.client.chat('lobby', '@OLD_IRON beep boop, old timer')) as { message: { id: number } };
    // Events are handled in order, so once a guest's later mention is answered, Cog's was seen.
    const { client, handle } = await guest();
    expect(await mentionAndWait(client, 'OLD_IRON', '@OLD_IRON did Cog just talk to you?')).toBe(`@${handle} VOICE MENTION LINE.`);
    const r = await client.call<Said>('GET', `/api/chat/lobby?since=${posted.message.id}`);
    expect(r.messages.filter((m) => m.author?.handle === 'OLD_IRON')).toHaveLength(1);
    expect(heard.slice(before).filter((m) => m.kind === 'mention').map((m) => m.addressedBy)).toEqual([handle]);
  }, 30_000);

  const startBot = (extra: Partial<BotOptions> & Pick<BotOptions, 'personality' | 'tokenFile'>) => {
    const c = new AbortController();
    let ready = () => {};
    const listening = new Promise<void>((resolve) => (ready = resolve));
    const done = runBot({ base: ironServer.url, voice: fakeVoice, replyCooldownMs: 0, ambientEveryMs: 0, houseKey: 'hk', thinkMs: [0, 0], pollWaitMs: 500, signal: c.signal, log: () => {}, onReady: () => ready(), ...extra });
    return { listening, done, stop: async () => (c.abort(), await done) };
  };

  // One extra house bot for the restart tests, reused so the loopback address stays well under
  // the registration limit (OLD IRON, Rivet, and Rivet's one profile refresh).
  const rivet = { ...oldIron, name: `Rivet${randomTag()}`, tagline: 'First edition.' };
  const rivetTokenFile = join(root, `.data/test-bots/${crypto.randomUUID()}.token`);
  const whoTagline = async (handle: string) =>
    (await new Client(ironServer.url).call<{ presence: { identity: { handle: string; tagline: string | null } }[] }>('GET', '/api/who')).presence.find(
      (p) => p.identity.handle === handle,
    )?.identity.tagline;

  test('a restarted bot refreshes its profile and does not replay mentions it received while down', async () => {
    voiceMode = 'talk';
    const { client, handle } = await guest();
    let bot = startBot({ personality: rivet, tokenFile: rivetTokenFile });
    await bot.listening;
    expect(await whoTagline(rivet.name)).toBe('First edition.');
    await bot.stop();
    const stale = (await client.chat('lobby', `@${rivet.name} anyone home?`)) as { message: { id: number } }; // arrives while it is down
    rivet.tagline = 'Second edition, now with more core.';
    const staleToken = (await Bun.file(rivetTokenFile).text()).trim();
    bot = startBot({ personality: rivet, tokenFile: rivetTokenFile });
    try {
      await bot.listening;
      expect(await whoTagline(rivet.name)).toBe('Second edition, now with more core.');
      const refreshedToken = (await Bun.file(rivetTokenFile).text()).trim();
      expect(refreshedToken).not.toBe(staleToken); // re-registered with the house key: token rotated
      // An unchanged profile keeps its token: no needless re-registration on every start.
      await bot.stop();
      bot = startBot({ personality: rivet, tokenFile: rivetTokenFile });
      await bot.listening;
      expect((await Bun.file(rivetTokenFile).text()).trim()).toBe(refreshedToken);
      expect(await mentionAndWait(client, rivet.name, `@${rivet.name} how about now?`)).toBe(`@${handle} VOICE MENTION LINE.`);
      const r = await client.call<Said>('GET', `/api/chat/lobby?since=${stale.message.id}`);
      expect(r.messages.filter((m) => m.author?.handle === rivet.name)).toHaveLength(1);
    } finally {
      await bot.stop();
    }
  }, 30_000);

  test('stopping a bot while its voice hangs returns promptly', async () => {
    voiceMode = 'hang';
    try {
      const stall = rivet;
      const bot = startBot({ personality: stall, tokenFile: rivetTokenFile });
      await bot.listening;
      const { client } = await guest();
      const before = heard.length;
      await client.chat('lobby', `@${stall.name} are you stuck?`);
      await until(async () => heard.slice(before).some((m) => m.kind === 'mention'));
      const started = Date.now();
      await bot.stop();
      expect(Date.now() - started).toBeLessThan(1000);
    } finally {
      voiceMode = 'talk';
    }
  }, 30_000);
});

describe('helpers', () => {
  test('shout capitalises everything but @handles', () => {
    expect(shout('@frosty your move, @Sprocket.')).toBe('@frosty YOUR MOVE, @Sprocket.');
  });

  const now = Date.parse('2026-09-26T12:00:00Z');
  const quiet = { humansPresent: true, inMatch: false, newestLobbyAt: now - 9 * 60_000, now };
  test('ambient chatter speaks only when a human is around, the bot is free, and the lobby has been quiet for 8 minutes', () => {
    expect(ambientDue(quiet)).toBe(true);
    expect(ambientDue({ ...quiet, newestLobbyAt: null })).toBe(true);
    expect(ambientDue({ ...quiet, humansPresent: false })).toBe(false);
    expect(ambientDue({ ...quiet, inMatch: true })).toBe(false);
    expect(ambientDue({ ...quiet, newestLobbyAt: now - 7 * 60_000 })).toBe(false);
  });
});
