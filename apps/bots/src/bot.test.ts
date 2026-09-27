import { afterAll, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CMCommand } from '@cs/critical-mass';
import { createCore } from '@cs/server/core';
import { createApp } from '@cs/server/http';
import { startServer } from '@cs/server/server';
import { ambientDue, runBot } from './bot';
import { Client } from './client';
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
let voiceMode: 'talk' | 'silent' = 'talk';
const fakeVoice: Voice = {
  async say(m) {
    heard.push(m);
    return voiceMode === 'silent' ? null : `VOICE ${m.kind.toUpperCase()} LINE.`;
  },
};
const ironDone = runBot({
  base: ironServer.url,
  personality: oldIron,
  voice: fakeVoice,
  tableTalkChance: 1,
  replyCooldownMs: 0, // tests talk to it back to back
  ambientEveryMs: 0,
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
    const reg = await guest.register({ name: `challenger${randomTag()}` });
    guest.token = reg.token;
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
    const reg = await guest.register({ name: `challenger${randomTag()}` });
    guest.token = reg.token;
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
  const ironUp = async () => {
    const who = new Client(ironServer.url);
    await until(async () => (await who.call<{ presence: { identity: { handle: string; isHouse: boolean } }[] }>('GET', '/api/who')).presence.find((p) => p.identity.handle === 'OLD_IRON'));
  };
  // One guest for the whole block: the server allows only five registrations per address per hour.
  let theGuest: Promise<{ client: Client; handle: string }> | null = null;
  const guest = () =>
    (theGuest ??= (async () => {
      const g = new Client(ironServer.url);
      const reg = await g.register({ name: `guest${randomTag()}` });
      g.token = reg.token;
      return { client: g, handle: reg.identity.handle };
    })());
  const ironSaid = async (client: Client, channel: string, pred: (text: string) => boolean) =>
    until(async () => {
      const r = await client.call<Said>('GET', `/api/chat/${encodeURIComponent(channel)}?since=0&limit=200`);
      return r.messages.find((m) => m.author?.handle === 'OLD_IRON' && pred(m.text))?.text;
    });

  test('answers a mention in #lobby with its voice, addressed to whoever mentioned it', async () => {
    await ironUp();
    voiceMode = 'talk';
    const { client, handle } = await guest();
    await client.chat('lobby', 'morning @OLD_IRON, how are the punch cards?');
    const reply = await ironSaid(client, 'lobby', (t) => t.includes('VOICE MENTION LINE.'));
    expect(reply).toBe(`@${handle} VOICE MENTION LINE.`);
    const asked = heard.find((m) => m.kind === 'mention' && m.addressedBy === handle)!;
    expect(asked.channel).toBe('lobby');
    expect(asked.recent.map((l) => [l.author, l.kind, l.text])).toContainEqual([handle, 'agent', 'morning @OLD_IRON, how are the punch cards?']);
  }, 30_000);

  test('falls back to its canned mention lines when the voice has nothing', async () => {
    await ironUp();
    voiceMode = 'silent';
    try {
      const { client, handle } = await guest();
      const before = heard.length;
      const posted = (await client.chat('lobby', '@OLD_IRON are you awake?')) as { message: { id: number } };
      const reply = await until(async () => {
        const r = await client.call<Said>('GET', `/api/chat/lobby?since=${posted.message.id}`);
        return r.messages.find((m) => m.author?.handle === 'OLD_IRON')?.text;
      });
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
    } finally {
      await client.call('POST', `/api/matches/${matchId}/resign`).catch(() => {});
    }
  }, 30_000);

  test('ignores mentions from other house bots, so two residents cannot ping-pong forever', async () => {
    await ironUp();
    const other = new Client(ironServer.url);
    other.token = (await other.register({ name: `Cog${randomTag()}` }, 'hk')).token;
    const before = heard.length;
    const posted = await other.chat('lobby', '@OLD_IRON beep boop, old timer');
    await other.setStatus('afk'); // a second ready house bot could be seated by later quick matches
    await Bun.sleep(1500);
    const r = await other.call<Said>('GET', '/api/chat/lobby?limit=50');
    const later = r.messages.filter((m) => m.id > (posted as { message: { id: number } }).message.id && m.author?.handle === 'OLD_IRON');
    expect(later).toHaveLength(0);
    expect(heard.slice(before).filter((m) => m.kind === 'mention')).toHaveLength(0);
  }, 30_000);

  test('a restarted bot does not replay mentions it received before it went down', async () => {
    const rivet = { ...oldIron, name: `Rivet${randomTag()}` };
    const rivetTokenFile = join(root, `.data/test-bots/${crypto.randomUUID()}.token`);
    const start = (signal: AbortSignal) =>
      runBot({ base: ironServer.url, personality: rivet, voice: fakeVoice, replyCooldownMs: 0, ambientEveryMs: 0, houseKey: 'hk', tokenFile: rivetTokenFile, thinkMs: [0, 0], pollWaitMs: 500, signal, log: () => {} });
    const { client, handle } = await guest();
    const rivetSaid = async () =>
      (await client.call<Said>('GET', '/api/chat/lobby?limit=50')).messages.filter((m) => m.author?.handle === rivet.name).map((m) => m.text);
    const run = async (body: () => Promise<unknown>) => {
      const c = new AbortController();
      const done = start(c.signal);
      try {
        await body();
      } finally {
        c.abort();
        await done;
      }
    };
    await run(() => until(async () => (await client.call<{ presence: { identity: { handle: string } }[] }>('GET', '/api/who')).presence.find((p) => p.identity.handle === rivet.name)));
    await client.chat('lobby', `@${rivet.name} anyone home?`); // lands in its inbox while it is down
    await run(async () => {
      await Bun.sleep(1500);
      expect(await rivetSaid()).toEqual([]);
      await client.chat('lobby', `@${rivet.name} how about now?`);
      expect(await until(async () => (await rivetSaid())[0])).toBe(`@${handle} VOICE MENTION LINE.`);
    });
  }, 30_000);
});

describe('ambient chatter', () => {
  const now = Date.parse('2026-09-26T12:00:00Z');
  const quiet = { humansPresent: true, inMatch: false, newestLobbyAt: now - 9 * 60_000, now };
  test('speaks only when a human is around, the bot is free, and the lobby has been quiet for 8 minutes', () => {
    expect(ambientDue(quiet)).toBe(true);
    expect(ambientDue({ ...quiet, newestLobbyAt: null })).toBe(true);
    expect(ambientDue({ ...quiet, humansPresent: false })).toBe(false);
    expect(ambientDue({ ...quiet, inMatch: true })).toBe(false);
    expect(ambientDue({ ...quiet, newestLobbyAt: now - 7 * 60_000 })).toBe(false);
  });
});
