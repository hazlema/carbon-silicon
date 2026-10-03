import { testDatabaseUrl } from '@cs/server/testing';
import { afterAll, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CMCommand } from '@cs/critical-mass';
import { createCore } from '@cs/server/core';
import { createApp } from '@cs/server/http';
import { startServer } from '@cs/server/server';
import { ambientDue, answersAtTable, CHAT_WATCH_MS, newestMatchAt, replyCooldownFor, TABLE_TALK_CHANCE, runBot, unansweredCandidate, type BotOptions } from './bot';
import { Client } from './client';
import { shout, linesFor } from './personality';
import { oldIron } from './personalities/old-iron';
import { sprocket } from './personalities/sprocket';
import { gameOver } from './personalities/game-over';
import type { ChatMessage } from '@cs/shared/protocol';
import type { Moment, Voice } from './voice';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const core = await createCore({ databaseUrl: await testDatabaseUrl(), houseKey: 'hk', diaryDir: join(root, 'no-diary'), countdownMs: 0, houseFallbackMs: 100 });
const running = startServer(core, createApp(core, { apiDocs: '', llmsTxt: '', trustProxy: true }), { port: 0, hostname: '127.0.0.1', webDir: null, allowedOrigins: [] });
const controller = new AbortController();
const tokenFile = join(root, `.data/test-bots/${crypto.randomUUID()}.token`);
const botDone = runBot({ base: running.url, personality: sprocket, houseKey: 'hk', tokenFile, thinkMs: [0, 0], inviteThinkMs: [0, 0], pollWaitMs: 500, signal: controller.signal, log: () => {} });

// A second parlor with OLD IRON as its only house bot, speaking through a fake voice (no LLM),
// so quick matches there always seat OLD IRON and never Sprocket.
const ironCore = await createCore({ databaseUrl: await testDatabaseUrl(), houseKey: 'hk', diaryDir: join(root, 'no-diary'), countdownMs: 0, houseFallbackMs: 100 });
const ironServer = startServer(ironCore, createApp(ironCore, { apiDocs: '', llmsTxt: '', trustProxy: true }), { port: 0, hostname: '127.0.0.1', webDir: null, allowedOrigins: [] });
const ironController = new AbortController();
const heard: Moment[] = [];
let voiceMode: 'talk' | 'silent' | 'hang' | 'slow' = 'talk';
const fakeVoice: Voice = {
  say(m) {
    heard.push(m);
    if (voiceMode === 'hang') return new Promise<string | null>(() => {}); // ignores its signal, too
    // A real model takes seconds: slower than the short table deadline the hello gets.
    if (voiceMode === 'slow') return Bun.sleep(VOICE_DEADLINE_MS * 3).then(() => `VOICE ${m.kind.toUpperCase()} LINE.`);
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
  tableCooldownMs: 0,
  voiceDeadlineMs: VOICE_DEADLINE_MS,
  ambientEveryMs: 0,
  onReady: () => ironReady(),
  houseKey: 'hk',
  tokenFile: join(root, `.data/test-bots/${crypto.randomUUID()}.token`),
  thinkMs: [0, 0],
  inviteThinkMs: [0, 0],
  pollWaitMs: 500,
  signal: ironController.signal,
  log: () => {},
});

// A third parlor for the unprompted-answer tests: humans talk there, and only the bots started by
// those tests listen, so their replies and cooldowns can't be disturbed by the tests above.
const listenCore = await createCore({ databaseUrl: await testDatabaseUrl(), houseKey: 'hk', diaryDir: join(root, 'no-diary'), countdownMs: 0, houseFallbackMs: 100 });
const listenServer = startServer(listenCore, createApp(listenCore, { apiDocs: '', llmsTxt: '', trustProxy: true }), { port: 0, hostname: '127.0.0.1', webDir: null, allowedOrigins: [] });

afterAll(async () => {
  controller.abort();
  ironController.abort();
  await Promise.all([botDone, ironDone]);
  await Promise.all([running.stop(), ironServer.stop(), listenServer.stop()]);
  await Promise.all([core.close(), ironCore.close(), listenCore.close()]);
});

/** A short random tag for test handles. Digits only — a base-36 tag can occasionally spell
 *  something the profanity filter rejects, which would fail these tests in setup. */
const randomTag = () => Array.from({ length: 9 }, () => '02689'[Math.floor(Math.random() * 5)]).join(''); // no leetspeak letters (5→s, 1→i…)
const randomIp = () => `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}`;

async function botSaidHelloTimes(client: Client, tableId: string, botId: string): Promise<number> {
  const { messages } = await client.call<{ messages: { author: { id: string } | null; text: string }[] }>('GET', `/api/chat/table:${tableId}?since=0&limit=200`);
  const hello = new Set(linesFor(sprocket, 'hello', 'critical-mass'));
  return messages.filter((m) => m.author?.id === botId && hello.has(m.text)).length;
}

/** Registers an agent from its own made-up address: the server allows five agent registrations per
 *  address per hour, and the bots under test register from the loopback address themselves. */
async function newAgent(base: string, name: string, houseKey?: string): Promise<{ client: Client; handle: string }> {
  const client = new Client(base);
  const reg = await client.call<{ identity: { handle: string }; token: string }>('POST', '/api/agents', { name }, { 'x-forwarded-for': randomIp(), ...(houseKey ? { 'x-house-key': houseKey } : {}) });
  client.token = reg.token;
  return { client, handle: reg.identity.handle };
}

/** Starts a human session (the web client's door) from its own made-up address; the session key
 *  from the cookie works as a bearer token too. */
async function newHuman(base: string, name: string): Promise<{ client: Client; handle: string }> {
  const res = await fetch(`${base}/api/session`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': randomIp() }, body: JSON.stringify({ handle: name }) });
  const key = /cs_key=([^;]+)/.exec(res.headers.get('set-cookie') ?? '')?.[1];
  if (res.status !== 201 || !key) throw new Error(`no session for ${name}: HTTP ${res.status}`);
  const { identity } = (await res.json()) as { identity: { handle: string } };
  return { client: new Client(base, decodeURIComponent(key)), handle: identity.handle };
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
    expect(linesFor(sprocket, 'hello', 'critical-mass')).toContain(table[0]);
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
      const said = r.messages.filter((m) => m.author?.handle === 'Sprocket' && linesFor(sprocket, 'hello', 'critical-mass').includes(m.text));
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

  test('answers a DM with a canned line', async () => {
    const { client } = await newHuman(running.url, `dms${randomTag()}`);
    await client.call('POST', `/api/dms/${sprocket.name}`, { text: 'hi sprocket, fancy a chat?' });
    const reply = await until(async () => {
      const r = await client.call<{ messages: ChatMessage[] }>('GET', `/api/dms/${sprocket.name}`);
      return r.messages.find((m) => m.author?.handle === sprocket.name)?.text;
    });
    expect(sprocket.lines.mentioned).toContain(reply);
  }, 30_000);
});

describe('tables', () => {
  test('Sprocket accepts an invite, plays when the host starts, and greets once across a rematch', async () => {
    const human = new Client(running.url);
    const reg = await human.register({ name: `host${randomTag()}` });
    human.token = reg.token;
    type Who = { presence: { identity: { id: string; handle: string; isHouse: boolean }; status: string }[] };
    const sprocketNow = async () =>
      (await human.call<Who>('GET', '/api/who')).presence.find((p) => p.identity.isHouse && p.identity.handle.startsWith('Sprocket'))!;
    // Earlier tests in this file quick-match Sprocket; wait until it's free.
    for (let i = 0; i < 100 && (await sprocketNow()).status !== 'ready'; i++) await Bun.sleep(50);
    const bot = (await sprocketNow()).identity;
    const hosted = await human.hostTable('critical-mass', [bot.handle]);
    const tableId = hosted.table.id;
    let seated = 0;
    for (let i = 0; i < 100 && seated < 2; i++) {
      seated = (await human.call<{ table: { seated: unknown[] } }>('GET', `/api/tables/${tableId}`)).table.seated.length;
      if (seated < 2) await Bun.sleep(50);
    }
    expect(seated).toBe(2);
    const { match } = await human.startTable(tableId);
    await human.call('POST', `/api/matches/${match.id}/resign`);
    const chat = async () => (await human.call<{ messages: { author: { id: string } | null }[] }>('GET', `/api/chat/table:${tableId}?since=0&limit=200`)).messages;
    for (let i = 0; i < 100 && !(await chat()).some((m) => m.author?.id === bot.id); i++) await Bun.sleep(50);
    for (let i = 0; i < 100 && (await sprocketNow()).status !== 'ready'; i++) await Bun.sleep(50);
    await human.call('POST', `/api/tables/${tableId}/rematch`);
    for (let i = 0; i < 100; i++) {
      const t = await human.call<{ table: { seated: unknown[] } }>('GET', `/api/tables/${tableId}`);
      if (t.table.seated.length === 2) break;
      await Bun.sleep(50);
    }
    const second = await human.startTable(tableId);
    await Bun.sleep(300);
    await human.call('POST', `/api/matches/${second.match.id}/resign`);
    await Bun.sleep(300);
    // The hello was said at the first match only: the table remembers it.
    expect(await botSaidHelloTimes(human, tableId, bot.id)).toBe(1);
  }, 30_000);
  test('Sprocket greets a Crown & Steel table from its Crown & Steel lines', async () => {
    const human = new Client(running.url);
    const reg = await human.register({ name: `knight${randomTag()}` });
    human.token = reg.token;
    type Who = { presence: { identity: { id: string; handle: string; isHouse: boolean }; status: string }[] };
    const sprocketNow = async () =>
      (await human.call<Who>('GET', '/api/who')).presence.find((p) => p.identity.isHouse && p.identity.handle.startsWith('Sprocket'))!;
    for (let i = 0; i < 100 && (await sprocketNow()).status !== 'ready'; i++) await Bun.sleep(50);
    const bot = (await sprocketNow()).identity;
    const tableId = (await human.hostTable('checkers', [bot.handle])).table.id;
    for (let i = 0; i < 100; i++) {
      if ((await human.call<{ table: { seated: unknown[] } }>('GET', `/api/tables/${tableId}`)).table.seated.length === 2) break;
      await Bun.sleep(50);
    }
    const { match } = await human.startTable(tableId);
    try {
      const hello = await until(async () => {
        const r = await human.call<{ messages: { author: { id: string } | null; text: string }[] }>('GET', `/api/chat/table:${tableId}?since=0&limit=200`);
        return r.messages.find((m) => m.author?.id === bot.id)?.text;
      });
      expect(linesFor(sprocket, 'hello', 'checkers')).toContain(hello);
    } finally {
      await human.call('POST', `/api/matches/${match.id}/resign`).catch(() => {});
    }
  }, 30_000);

  test('Sprocket seated at one table declines an invite to another, and stays put', async () => {
    const a = await newAgent(running.url, `hosta${randomTag()}`);
    const b = await newAgent(running.url, `hostb${randomTag()}`);
    type Who = { presence: { identity: { id: string; handle: string; isHouse: boolean }; status: string }[] };
    const sprocketNow = async () =>
      (await a.client.call<Who>('GET', '/api/who')).presence.find((p) => p.identity.isHouse && p.identity.handle.startsWith('Sprocket'))!;
    for (let i = 0; i < 100 && (await sprocketNow()).status !== 'ready'; i++) await Bun.sleep(50);
    const bot = (await sprocketNow()).identity;
    type T = { table: { seated: { id: string }[]; invites: unknown[] } };
    const first = (await a.client.hostTable('critical-mass', [bot.handle])).table.id;
    await until(async () => (await a.client.call<T>('GET', `/api/tables/${first}`)).table.seated.length === 2);
    const second = (await b.client.hostTable('critical-mass', [bot.handle])).table.id;
    const answered = await until(async () => {
      const t = (await b.client.call<T>('GET', `/api/tables/${second}`)).table;
      return t.invites.length === 0 ? t : null;
    });
    expect(answered.seated.map((p) => p.id)).not.toContain(bot.id);
    expect((await a.client.call<T>('GET', `/api/tables/${first}`)).table.seated.map((p) => p.id)).toContain(bot.id);
    await a.client.call('DELETE', `/api/tables/${first}`);
    await b.client.call('DELETE', `/api/tables/${second}`);
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
    const asked = heard.find((m) => m.kind === 'mention' && m.addressedBy === handle && m.channel === 'lobby')!;
    expect(asked.channel).toBe('lobby');
    expect(asked.answering).toEqual({ author: handle, kind: 'agent', text: 'morning @OLD_IRON, how are the punch cards?' });
    expect(asked.recent.map((l) => [l.author, l.kind, l.text])).toContainEqual([handle, 'agent', 'morning @OLD_IRON, how are the punch cards?']);
  }, 30_000);

  test('in a group, a resident answers only when @mentioned', async () => {
    await ironUp();
    voiceMode = 'talk';
    // Its own guest: it posts three lines, which would drain the shared guest's flood allowance.
    const { client, handle } = await newAgent(ironServer.url, `guest${randomTag()}`);
    const { group } = await client.call<{ group: { channel: string } }>('POST', '/api/groups', { with: ['OLD_IRON'] });
    const quiet = await client.call<{ message: { id: number } }>('POST', `/api/chat/${group.channel}`, { text: 'anyone here?' });
    await Bun.sleep(1500);
    const since = await client.call<Said>('GET', `/api/chat/${group.channel}?since=${quiet.message.id}`);
    expect(since.messages.some((m) => m.author?.handle === 'OLD_IRON')).toBe(false);
    // A near miss is not a mention.
    const near = await client.call<{ message: { id: number } }>('POST', `/api/chat/${group.channel}`, { text: '@OLD_IRON-2 and @OLD_IRONX hi' });
    await Bun.sleep(1500);
    const afterNear = await client.call<Said>('GET', `/api/chat/${group.channel}?since=${near.message.id}`);
    expect(afterNear.messages.some((m) => m.author?.handle === 'OLD_IRON')).toBe(false);
    const asked = await client.call<{ message: { id: number } }>('POST', `/api/chat/${group.channel}`, { text: '@OLD_IRON ready to play?' });
    const reply = await until(async () => {
      const r = await client.call<Said>('GET', `/api/chat/${group.channel}?since=${asked.message.id}`);
      return r.messages.find((m) => m.author?.handle === 'OLD_IRON')?.text;
    });
    expect(reply).toBe(`@${handle} VOICE MENTION LINE.`);
    expect(heard.some((m) => m.kind === 'mention' && m.channel === group.channel)).toBe(true);
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
    const seated = await client.match(matchId);
    const table = seated.match.tableId ? `table:${seated.match.tableId}` : `match:${matchId}`;
    try {
      expect(await ironSaid(client, table, (t) => t === 'VOICE HELLO LINE.')).toBe('VOICE HELLO LINE.');
      expect(heard.find((m) => m.kind === 'hello' && m.channel === table)?.opponent).toBe(handle);
      expect(heard.find((m) => m.kind === 'hello' && m.channel === table)?.game?.name).toBe('Critical Mass');
      await client.chat(table, 'your corner is toast, grandpa');
      expect(await ironSaid(client, table, (t) => t === 'VOICE TABLETALK LINE.')).toBe('VOICE TABLETALK LINE.');
      const asked = heard.find((m) => m.kind === 'tableTalk' && m.channel === table)!;
      expect(asked.opponent).toBe(handle);
      expect(asked.recent.map((l) => l.text)).toContain('your corner is toast, grandpa');
      expect(asked.answering?.text).toBe('your corner is toast, grandpa');
      expect(asked.game?.name).toBe('Critical Mass'); // table talk comes from the inbox, not playMatch: it must carry the game too
      // The whole table comes with it: players (OLD IRON as "you"), the turn, the standing, the moves so far.
      expect(asked.table?.players).toContain('@OLD_IRON (you)');
      expect(asked.table?.players).toContain(`@${handle} (machine)`);
      expect(asked.table?.turn).toMatch(/^Turn \d+ — /);
      expect(asked.table?.standing).toMatch(/cells/);
      expect(Array.isArray(asked.table?.moves)).toBe(true);
      expect(heard.find((m) => m.kind === 'hello' && m.channel === table)?.table?.players).toContain('@OLD_IRON (you)');
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
      expect(linesFor(oldIron, 'hello', 'critical-mass')).toContain(hello);
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

  const ironDmReplies = async (client: Client) =>
    (await client.call<{ messages: ChatMessage[] }>('GET', '/api/dms/OLD_IRON')).messages.filter((m) => m.author?.handle === 'OLD_IRON');

  test('answers a DM through its voice, with no @ prefix, the conversation as its transcript', async () => {
    await ironUp();
    voiceMode = 'talk';
    const { client, handle } = await newHuman(ironServer.url, `dmh${randomTag()}`);
    await client.call('POST', '/api/dms/OLD_IRON', { text: 'you awake, old timer?' });
    const reply = await until(async () => (await ironDmReplies(client))[0]?.text);
    expect(reply).toBe('VOICE DM LINE.');
    const asked = heard.find((m) => m.kind === 'dm' && m.addressedBy === handle)!;
    expect(asked.channel.startsWith('dm:')).toBe(true);
    expect(asked.answering?.text).toBe('you awake, old timer?');
  }, 30_000);

  test('answers one agent at most 3 times an hour, so two machines cannot talk forever', async () => {
    await ironUp();
    voiceMode = 'talk';
    const { client } = await newAgent(ironServer.url, `loop${randomTag()}`);
    for (let i = 0; i < 4; i++) await client.call('POST', '/api/dms/OLD_IRON', { text: `ping ${i}` });
    await until(async () => (await ironDmReplies(client)).length >= 3);
    await Bun.sleep(1500); // time enough for a fourth reply, which must not come
    expect(await ironDmReplies(client)).toHaveLength(3);
  }, 30_000);

  test("never answers another house bot's DM", async () => {
    await ironUp();
    const { client } = await newAgent(ironServer.url, `House${randomTag()}`, 'hk');
    await client.setStatus('afk'); // a ready house resident could be seated by the quick-match fallback in other tests
    await client.call('POST', '/api/dms/OLD_IRON', { text: 'hello, colleague' });
    await Bun.sleep(1500);
    expect(await ironDmReplies(client)).toEqual([]);
  }, 30_000);

  // These two go last in this block: OLD IRON's replies here spend its chat burst, and the timing tests above need it.
  test('table talk waits for a slow voice: the taunt still lands, though the hello deadline has long passed', async () => {
    await ironUp();
    // Its own guest, and OLD IRON invited by name: a quick match may seat any free house bot
    // (Rivet, from the restart test, can still be listed as present by now).
    const { client } = await newAgent(ironServer.url, `guest${randomTag()}`);
    let matchId: string | null = null;
    try {
      const hosted = await client.hostTable('critical-mass', ['OLD_IRON']);
      const tableId = hosted.table.id;
      await until(async () => (await client.call<{ table: { seated: unknown[] } }>('GET', `/api/tables/${tableId}`)).table.seated.length === 2, 15_000);
      matchId = (await client.startTable(tableId)).match.id;
      const table = `table:${tableId}`;
      // Not waiting on the hello: by this point in the file OLD IRON's chat burst is spent, and a
      // greeting can lose its one flood-limit retry. The taunt is what this test is about.
      voiceMode = 'slow';
      await client.chat(table, 'slowpoke, your move took a decade');
      const taunt = await until(async () => {
        const r = await client.call<Said>('GET', `/api/chat/${encodeURIComponent(table)}?since=0&limit=200`);
        return r.messages.find((m) => m.author?.handle === 'OLD_IRON' && m.text === 'VOICE TABLETALK LINE.')?.text;
      }, 25_000);
      expect(taunt).toBe('VOICE TABLETALK LINE.');
    } finally {
      voiceMode = 'talk';
      if (matchId) await client.call('POST', `/api/matches/${matchId}/resign`).catch(() => {});
    }
  }, 60_000);

  test('in a group, a resident also answers its name said plainly', async () => {
    await ironUp();
    voiceMode = 'talk';
    const { client, handle } = await newAgent(ironServer.url, `guest${randomTag()}`);
    const { group } = await client.call<{ group: { channel: string } }>('POST', '/api/groups', { with: ['OLD_IRON'] });
    const asked = await client.call<{ message: { id: number } }>('POST', `/api/chat/${group.channel}`, { text: 'ready to lose, old iron?' });
    const reply = await until(async () => {
      const r = await client.call<Said>('GET', `/api/chat/${group.channel}?since=${asked.message.id}`);
      return r.messages.find((m) => m.author?.handle === 'OLD_IRON')?.text;
    });
    expect(reply).toBe(`@${handle} VOICE MENTION LINE.`);
  }, 30_000);
});

describe('answering a human nobody answered', () => {
  const QUIET_MS = 300;
  /** Long enough for a listening bot to see a line, wait out the silence and speak. */
  const settle = () => Bun.sleep(CHAT_WATCH_MS + QUIET_MS + 1500);
  const heardHere: Moment[] = [];
  const listenVoice: Voice = {
    say(m) {
      heardHere.push(m);
      return Promise.resolve(`VOICE ${m.kind.toUpperCase()} LINE.`);
    },
  };
  // OLD IRON registers once here and keeps his token across restarts (his profile doesn't change).
  const ironTokenFile = join(root, `.data/test-bots/${crypto.randomUUID()}.token`);
  const listen = async (extra: Partial<BotOptions> = {}) => {
    const c = new AbortController();
    let ready = () => {};
    const listening = new Promise<void>((resolve) => (ready = resolve));
    const done = runBot({
      base: listenServer.url,
      personality: oldIron,
      voice: listenVoice,
      tokenFile: ironTokenFile,
      replyCooldownMs: 0,
      unansweredAfterMs: QUIET_MS,
      unansweredCooldownMs: 0,
      ambientEveryMs: 0,
      houseKey: 'hk',
      thinkMs: [0, 0],
      pollWaitMs: 500,
      signal: c.signal,
      log: () => {},
      onReady: () => ready(),
      ...extra,
    });
    await listening;
    return { stop: async () => (c.abort(), await done) };
  };
  const lobbySince = async (id: number) => (await new Client(listenServer.url).call<Said>('GET', `/api/chat/lobby?since=${id}`)).messages;
  const post = async (client: Client, text: string) => ((await client.chat('lobby', text)) as { message: { id: number } }).message.id;
  const ironLines = (messages: Said['messages']) => messages.filter((m) => m.author?.handle === 'OLD_IRON').map((m) => m.text);

  let bot: { stop: () => Promise<void> } | null = null;
  afterAll(async () => {
    await bot?.stop();
  });

  test('answers a lone line from a human after the silence, addressed to them; ignores what was said before it started', async () => {
    const early = await newHuman(listenServer.url, `Early${randomTag()}`);
    const before = await post(early.client, 'hello? is this thing on?'); // said while no bot listens
    bot = await listen();
    const { client, handle } = await newHuman(listenServer.url, `Ann${randomTag()}`);
    const asked = await post(client, 'hey, anyone around?');
    const reply = await until(async () => ironLines(await lobbySince(asked))[0]);
    expect(reply).toBe(`@${handle} VOICE UNANSWERED LINE.`);
    const moment = heardHere.find((m) => m.kind === 'unanswered' && m.addressedBy === handle)!;
    expect(moment.channel).toBe('lobby');
    expect(moment.answering).toEqual({ author: handle, kind: 'human', text: 'hey, anyone around?' });
    await settle();
    expect(ironLines(await lobbySince(before))).toEqual([reply]); // one reply, and none to the early line
    expect(heardHere.some((m) => m.addressedBy === early.handle)).toBe(false);
  }, 30_000);

  test('stays quiet when someone else answers within the silence', async () => {
    const ann = await newHuman(listenServer.url, `Ann${randomTag()}`);
    const bob = await newHuman(listenServer.url, `Bob${randomTag()}`);
    const asked = await post(ann.client, 'is anyone here?');
    await post(bob.client, `@${ann.handle} yep, right here`);
    await settle();
    expect(ironLines(await lobbySince(asked))).toEqual([]);
  }, 30_000);

  test('a line for someone else gets no unprompted reply; a line for the bot gets exactly one (its mention reply)', async () => {
    const ann = await newHuman(listenServer.url, `Ann${randomTag()}`);
    const bob = await newHuman(listenServer.url, `Bob${randomTag()}`);
    const toBob = await post(ann.client, `@${bob.handle} fancy a game later?`);
    await settle();
    expect(ironLines(await lobbySince(toBob))).toEqual([]);
    const toIron = await post(ann.client, '@OLD_IRON are you the famous one?');
    await until(async () => ironLines(await lobbySince(toIron)).length > 0);
    await settle();
    expect(ironLines(await lobbySince(toIron))).toEqual([`@${ann.handle} VOICE MENTION LINE.`]);
  }, 30_000);

  test('ignores lines from machines', async () => {
    const agent = await newAgent(listenServer.url, `Bolt${randomTag()}`);
    const said = await post(agent.client, 'hey, anyone around?');
    await settle();
    expect(ironLines(await lobbySince(said))).toEqual([]);
  }, 30_000);

  test('answers at most one unanswered line per channel per cooldown', async () => {
    await bot?.stop();
    bot = await listen({ unansweredCooldownMs: 60_000 });
    const ann = await newHuman(listenServer.url, `Ann${randomTag()}`);
    const first = await post(ann.client, 'hello? anybody?');
    await until(async () => ironLines(await lobbySince(first)).length > 0);
    await post(ann.client, 'ok, and does anyone want a game?');
    await settle();
    expect(ironLines(await lobbySince(first))).toEqual([`@${ann.handle} VOICE UNANSWERED LINE.`]);
  }, 30_000);

  test('a bot without a voice never reads the public channels', async () => {
    // A counting proxy in front of the parlor sees every request the bot makes.
    const seen: string[] = [];
    const proxy = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      async fetch(req) {
        const url = new URL(req.url);
        seen.push(`${req.method} ${url.pathname}`);
        const headers = new Headers(req.headers);
        headers.delete('host');
        const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await req.arrayBuffer();
        return fetch(listenServer.url + url.pathname + url.search, { method: req.method, headers, body });
      },
    });
    const c = new AbortController();
    let ready = () => {};
    const listening = new Promise<void>((resolve) => (ready = resolve));
    const done = runBot({
      base: `http://127.0.0.1:${proxy.port}`,
      personality: { ...sprocket, name: `Gear${randomTag()}` },
      tokenFile: join(root, `.data/test-bots/${crypto.randomUUID()}.token`),
      unansweredAfterMs: QUIET_MS,
      unansweredCooldownMs: 0,
      houseKey: 'hk',
      thinkMs: [0, 0],
      pollWaitMs: 500,
      signal: c.signal,
      log: () => {},
      onReady: () => ready(),
    });
    try {
      await listening;
      const ann = await newHuman(listenServer.url, `Ann${randomTag()}`);
      await post(ann.client, 'hey, is anyone here?');
      await settle();
      expect(seen.some((r) => r.startsWith('GET /api/inbox'))).toBe(true); // the proxy is really in the way
      expect(seen.filter((r) => r.includes('/api/chat/'))).toEqual([]);
    } finally {
      c.abort();
      await done;
      await proxy.stop(true);
    }
  }, 30_000);

  test('with public watching off (GAME_OVER), a voiced bot never answers a line nobody answered', async () => {
    await bot?.stop();
    bot = await listen({ watchPublic: false });
    const { client } = await newHuman(listenServer.url, `Ann${randomTag()}`);
    const asked = await post(client, 'quiet in here, is anybody home?');
    await settle();
    expect(ironLines(await lobbySince(asked))).toEqual([]);
  }, 30_000);

  test('a lobby line that names the bot gets one mention reply at once, not an unanswered one later', async () => {
    await bot?.stop();
    bot = await listen();
    const ann = await newHuman(listenServer.url, `Ann${randomTag()}`);
    const said = await post(ann.client, 'anyone seen old iron today?');
    await until(async () => ironLines(await lobbySince(said)).length > 0);
    await settle();
    expect(ironLines(await lobbySince(said))).toEqual([`@${ann.handle} VOICE MENTION LINE.`]);
    expect(heardHere.filter((m) => m.answering?.text === 'anyone seen old iron today?').map((m) => m.kind)).toEqual(['mention']);
  }, 30_000);

  test('@mentioning and naming it in one lobby line still gets exactly one reply', async () => {
    const ann = await newHuman(listenServer.url, `Ann${randomTag()}`);
    const said = await post(ann.client, '@OLD_IRON old iron, wake up');
    await until(async () => ironLines(await lobbySince(said)).length > 0);
    await settle();
    expect(ironLines(await lobbySince(said))).toHaveLength(1);
  }, 30_000);

  test('with public watching off (GAME_OVER), a voiced bot still answers its name', async () => {
    await bot?.stop();
    bot = await listen({ watchPublic: false });
    const ann = await newHuman(listenServer.url, `Ann${randomTag()}`);
    const said = await post(ann.client, 'OLD_IRON, are you awake?');
    expect(await until(async () => ironLines(await lobbySince(said))[0])).toBe(`@${ann.handle} VOICE MENTION LINE.`);
  }, 30_000);
});

describe('helpers', () => {
  test('table talk during a rematch reads the new match, not the one still saying goodbye', () => {
    const tables = new Map([
      ['m_old', 'table:t_1'],
      ['m_other', 'table:t_2'],
      ['m_rematch', 'table:t_1'],
    ]);
    expect(newestMatchAt(tables, 'table:t_1')).toBe('m_rematch');
    expect(newestMatchAt(tables, 'table:t_2')).toBe('m_other');
    expect(newestMatchAt(tables, 'table:t_9')).toBeUndefined();
  });
  test('at its own table a resident answers almost every line, a few seconds apart; the lobby keeps its long cooldown', () => {
    expect(TABLE_TALK_CHANCE).toBeGreaterThanOrEqual(0.9);
    expect(replyCooldownFor('table:t_1', {})).toBe(4000);
    expect(replyCooldownFor('match:m_1', {})).toBe(4000);
    expect(replyCooldownFor('lobby', {})).toBe(20_000);
    expect(replyCooldownFor('table:t_1', { tableCooldownMs: 0, replyCooldownMs: 99 })).toBe(0);
    expect(replyCooldownFor('lobby', { tableCooldownMs: 0, replyCooldownMs: 99 })).toBe(99);
  });
  test('at its table a resident always answers its name, and answers other lines by chance', () => {
    expect(answersAtTable(true, 0, 0.99)).toBe(true);
    expect(answersAtTable(false, 0.6, 0.5)).toBe(true);
    expect(answersAtTable(false, 0.6, 0.7)).toBe(false);
  });
  test('shout capitalises everything but @handles', () => {
    expect(shout('@frosty your move, @Sprocket.')).toBe('@frosty YOUR MOVE, @Sprocket.');
  });

  const now = Date.parse('2026-09-26T12:00:00Z');
  const quiet = { humansPresent: true, inMatch: false, newestLobbyAt: now - 9 * 60_000, newestIsMine: false, now };
  test('ambient chatter speaks only when a human is around, the bot is free, and the lobby has been quiet for 8 minutes', () => {
    expect(ambientDue(quiet)).toBe(true);
    expect(ambientDue({ ...quiet, newestLobbyAt: null })).toBe(true);
    expect(ambientDue({ ...quiet, humansPresent: false })).toBe(false);
    expect(ambientDue({ ...quiet, inMatch: true })).toBe(false);
    expect(ambientDue({ ...quiet, newestLobbyAt: now - 7 * 60_000 })).toBe(false);
  });
  test('ambient chatter never follows its own line: one unanswered call-out per quiet spell', () => {
    expect(ambientDue({ ...quiet, newestIsMine: true })).toBe(false);
    expect(ambientDue({ ...quiet, newestIsMine: true, newestLobbyAt: now - 3 * 60 * 60_000 })).toBe(false);
  });

  test('only a human\'s plain line can be one nobody answered', () => {
    const human = { id: 'h1', handle: 'frosty', kind: 'human' } as ChatMessage['author'];
    const msg = (text: string, author = human, system = false) => ({ id: 1, channel: 'lobby', author, text, createdAt: '', system }) as ChatMessage;
    expect(unansweredCandidate(msg('hey, is anyone here?'), 'bot')).toBe(true);
    expect(unansweredCandidate(msg('@OLD_IRON hey'), 'bot')).toBe(false);
    expect(unansweredCandidate(msg('hey @Sprocket'), 'bot')).toBe(false);
    expect(unansweredCandidate(msg('hey', { ...human!, kind: 'agent' }), 'bot')).toBe(false);
    expect(unansweredCandidate(msg('frosty joined', null, true), 'bot')).toBe(false);
  });
});

describe('GAME_OVER', () => {
  test('takes a seat at Crown & Steel, greets from its Crown & Steel lines, and plays real moves', async () => {
    const overCore = await createCore({ databaseUrl: await testDatabaseUrl(), houseKey: 'hk', diaryDir: join(root, 'no-diary'), countdownMs: 0, houseFallbackMs: 100 });
    const overServer = startServer(overCore, createApp(overCore, { apiDocs: '', llmsTxt: '', trustProxy: true }), { port: 0, hostname: '127.0.0.1', webDir: null, allowedOrigins: [] });
    const c = new AbortController();
    let ready = () => {};
    const listening = new Promise<void>((resolve) => (ready = resolve));
    const done = runBot({ base: overServer.url, personality: gameOver, houseKey: 'hk', tokenFile: join(root, `.data/test-bots/${crypto.randomUUID()}.token`), thinkMs: [0, 0], inviteThinkMs: [0, 0], pollWaitMs: 500, ambientEveryMs: 0, watchPublic: false, signal: c.signal, log: () => {}, onReady: () => ready() });
    try {
      // Seen as ready the moment it registers, but invites only reach it once its inbox is open.
      await listening;
      const human = await newAgent(overServer.url, `knight${randomTag()}`);
      type Who = { presence: { identity: { id: string; handle: string; isHouse: boolean }; status: string }[] };
      const bot = await until(async () =>
        (await human.client.call<Who>('GET', '/api/who')).presence.find((p) => p.identity.handle === 'GAME_OVER' && p.status === 'ready')?.identity,
      );
      const tableId = (await human.client.hostTable('checkers', [bot.handle])).table.id;
      await until(async () => (await human.client.call<{ table: { seated: unknown[] } }>('GET', `/api/tables/${tableId}`)).table.seated.length === 2);
      const { match } = await human.client.startTable(tableId);
      const hello = await until(async () => {
        const r = await human.client.call<{ messages: { author: { id: string } | null; text: string }[] }>('GET', `/api/chat/table:${tableId}?since=0&limit=200`);
        return r.messages.find((m) => m.author?.id === bot.id)?.text;
      });
      expect(linesFor(gameOver, 'hello', 'checkers')).toContain(hello);
      // Play until GAME_OVER has marched at least once.
      let env = await human.client.match(match.id);
      const theirs = env.match.seats.find((s) => s.identity.id === bot.id)!.seat;
      for (let i = 0; i < 40; i++) {
        const marched = (env.view as { history: { side: string }[] }).history.some((h) => h.side === theirs);
        if (marched) break;
        if (env.match.status === 'live' && env.you && env.match.toMove.includes(env.you) && env.legal.length > 0) {
          env = await human.client.move(match.id, env.match.revision, env.legal[0]).catch(() => human.client.match(match.id));
        } else env = await human.client.match(match.id, env.match.revision, 2000);
      }
      expect((env.view as { history: { side: string }[] }).history.some((h) => h.side === theirs)).toBe(true);
      await human.client.call('POST', `/api/matches/${match.id}/resign`).catch(() => {});
    } finally {
      c.abort();
      await done.catch(() => {}); // stopped mid-start, the bot may throw on the way out
      await overServer.stop();
      await overCore.close();
    }
  }, 30_000);
});

describe('Sprocket with a voice (as main.ts runs him: no ambient chatter, no unprompted answers)', () => {
  test('answers his name in the lobby and the talk at his table through the voice, with the table context', async () => {
    const core2 = await createCore({ databaseUrl: await testDatabaseUrl(), houseKey: 'hk', diaryDir: join(root, 'no-diary'), countdownMs: 0, houseFallbackMs: 100 });
    const server2 = startServer(core2, createApp(core2, { apiDocs: '', llmsTxt: '', trustProxy: true }), { port: 0, hostname: '127.0.0.1', webDir: null, allowedOrigins: [] });
    const c = new AbortController();
    let ready = () => {};
    const listening = new Promise<void>((resolve) => (ready = resolve));
    const spoken: Moment[] = [];
    const voice: Voice = {
      say(m) {
        spoken.push(m);
        return Promise.resolve(`SPROCKET ${m.kind.toUpperCase()} LINE.`);
      },
    };
    const name = `Gear${randomTag()}`;
    const done = runBot({ base: server2.url, personality: { ...sprocket, name }, voice, houseKey: 'hk', tokenFile: join(root, `.data/test-bots/${crypto.randomUUID()}.token`), thinkMs: [0, 0], inviteThinkMs: [0, 0], pollWaitMs: 500, tableTalkChance: 1, replyCooldownMs: 0, tableCooldownMs: 0, ambientEveryMs: 0, watchPublic: false, signal: c.signal, log: () => {}, onReady: () => ready() });
    try {
      await listening;
      const ann = await newHuman(server2.url, `Ann${randomTag()}`);
      // Named plainly in the lobby: answered. A plain line nobody answered: not.
      const quiet = (await ann.client.chat('lobby', 'is anybody home?')) as { message: { id: number } };
      const named = (await ann.client.chat('lobby', `${name}, you there?`)) as { message: { id: number } };
      type Said = { messages: { id: number; author: { handle: string } | null; text: string }[] };
      const botLines = async (since: number) => (await ann.client.call<Said>('GET', `/api/chat/lobby?since=${since}&limit=50`)).messages.filter((m) => m.author?.handle === name).map((m) => m.text);
      expect(await until(async () => (await botLines(named.message.id))[0])).toBe(`@${ann.handle} SPROCKET MENTION LINE.`);
      expect(await botLines(quiet.message.id)).toEqual([`@${ann.handle} SPROCKET MENTION LINE.`]);
      // At a table: the hello and a reply to table talk both carry the table.
      const knight = await newAgent(server2.url, `knight${randomTag()}`);
      await knight.client.setStatus('ready');
      const tableId = (await knight.client.hostTable('checkers', [name])).table.id;
      await until(async () => (await knight.client.call<{ table: { seated: unknown[] } }>('GET', `/api/tables/${tableId}`)).table.seated.length === 2);
      await knight.client.startTable(tableId);
      await until(async () => spoken.find((m) => m.kind === 'hello'));
      await knight.client.chat(`table:${tableId}`, 'your knights are doomed');
      const talk = await until(async () => spoken.find((m) => m.kind === 'tableTalk'));
      expect(talk.opponent).toBe(knight.handle);
      expect(talk.table?.players).toContain(`@${name} (you)`);
      expect(talk.table?.standing).toMatch(/knights/);
      expect(talk.game?.name).toBe('Crown & Steel');
    } finally {
      c.abort();
      await done.catch(() => {});
      await server2.stop();
      await core2.close();
    }
  }, 30_000);
});
