import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { stateFromView, type CMView } from '@cs/critical-mass';
import { PUBLIC_CHANNELS, type ChatMessage, type MatchEnvelope, type PresenceInfo } from '@cs/shared/protocol';
import { ApiError, Client } from './client';
import { DEFAULT_STRATEGY, line, shout, type Personality } from './personality';
import { chooseCriticalMassMove } from './strategies/critical-mass';
import type { ChatLine, Moment, MomentKind, Voice } from './voice';

export interface BotOptions {
  base: string;
  personality: Personality;
  houseKey: string;
  tokenFile: string;
  thinkMs: [number, number];
  pollWaitMs?: number;
  signal?: AbortSignal;
  log?: (msg: string) => void;
  /** Where the bot's words come from; without one it only uses its canned line bank. */
  voice?: Voice;
  /** How often a bot with a voice considers livening up a quiet lobby (default 12 min; 0 disables). */
  ambientEveryMs?: number;
  /** Chance that a bot with a voice answers its opponent's table talk (default 0.6). */
  tableTalkChance?: number;
  /** At most one mention or table-talk reply per channel per this long (default 20 s). */
  replyCooldownMs?: number;
  /** How long a line at a match table may wait for the voice before the canned bank answers
   *  instead (default 4 s), so a slow or hanging model never holds up a match. */
  voiceDeadlineMs?: number;
  /** A bot with a voice answers a human's public line that nobody answered after this much
   *  silence in the channel (default 5 s). */
  unansweredAfterMs?: number;
  /** At most one such unprompted answer per channel per this long (default 60 s). */
  unansweredCooldownMs?: number;
  /** Called once the bot is connected and has skipped its inbox and chat backlog, i.e. is listening. */
  onReady?: () => void;
}

/** Ambient chatter needs the lobby to have been quiet for at least this long. */
const LOBBY_QUIET_MS = 8 * 60_000;
const AMBIENT_CHANCE = 0.5;
/** At most one cascade remark per this long at a table. */
const CHATTER_GAP_MS = 8000;
/** How often a bot with a voice reads the public channels for lines nobody answered. */
export const CHAT_WATCH_MS = 1500;
const MENTION_RE = /@[A-Za-z0-9_-]{3,20}/;

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      resolve();
    }, { once: true });
  });

/** Line-bank key used when the voice has nothing for a moment. Table talk has no canned answer:
 *  "you rang?" lines make no sense mid-match, so a silent voice just stays silent there. */
const BANK: Record<MomentKind, keyof Personality['lines'] | null> = {
  mention: 'mentioned',
  tableTalk: null,
  hello: 'hello',
  win: 'win',
  lose: 'lose',
  draw: 'draw',
  bigCascade: 'bigCascade',
  gotHit: 'gotHit',
  ambient: 'ambient',
  unanswered: 'unanswered',
};

/** Should a bot with a voice speak up in the lobby now? (The coin flip happens elsewhere.) */
export function ambientDue(s: {
  humansPresent: boolean;
  inMatch: boolean;
  newestLobbyAt: number | null;
  /** The newest lobby line is the bot's own: it already spoke into this silence, so it waits for company. */
  newestIsMine: boolean;
  now: number;
}): boolean {
  if (s.newestIsMine) return false;
  return s.humansPresent && !s.inMatch && (s.newestLobbyAt === null || s.now - s.newestLobbyAt >= LOBBY_QUIET_MS);
}

const toChatLine = (m: ChatMessage): ChatLine => ({
  author: m.author?.handle ?? 'house',
  kind: m.system || !m.author ? 'system' : m.author.kind === 'human' ? 'human' : 'agent',
  text: m.text,
});

/** Resolves with the promise's value, or null as soon as `signal` aborts. */
function untilAborted<T>(p: Promise<T>, signal: AbortSignal | undefined): Promise<T | null> {
  if (!signal) return p;
  if (signal.aborted) return Promise.resolve(null);
  return new Promise<T | null>((resolve, reject) => {
    const stop = () => resolve(null);
    signal.addEventListener('abort', stop, { once: true });
    p.then(resolve, reject).finally(() => signal.removeEventListener('abort', stop));
  });
}

async function recentLines(client: Client, channel: string): Promise<ChatMessage[]> {
  const r = await client.call<{ messages: ChatMessage[] }>('GET', `/api/chat/${encodeURIComponent(channel)}?limit=8`);
  return r.messages;
}

/**
 * Say something about a moment in a channel: ask the voice if the bot has one, fall back to the
 * canned line bank when it has nothing, and post the result. Never throws. Bots without a voice
 * make exactly the calls they always did (no history fetch).
 */
async function speak(
  client: Client,
  opts: BotOptions,
  kind: MomentKind,
  channel: string,
  extra: { opponent?: string; addressedBy?: string; answering?: ChatMessage } = {},
): Promise<void> {
  try {
    let text: string | null = null;
    if (opts.voice) {
      const recent = await recentLines(client, channel).catch(() => [] as ChatMessage[]);
      const { answering, ...who } = extra;
      const moment: Moment = { kind, channel, recent: recent.map(toChatLine), ...who, ...(answering ? { answering: toChatLine(answering) } : {}) };
      // At a table the game clock is running, so the voice gets a short deadline; everywhere, the
      // bot's own shutdown signal cuts it off.
      const deadline = /^(match|table):/.test(channel) ? AbortSignal.timeout(opts.voiceDeadlineMs ?? 4000) : undefined;
      const stops = [opts.signal, deadline].filter((x): x is AbortSignal => x !== undefined);
      const signal = stops.length > 0 ? AbortSignal.any(stops) : undefined;
      text = await untilAborted(opts.voice.say(moment, signal), signal).catch(() => null);
      if (text && opts.personality.shout) text = shout(text);
    }
    if (opts.signal?.aborted) return;
    const bank = BANK[kind];
    const lines = bank ? opts.personality.lines[bank] : undefined;
    text ||= lines ? line(lines) : null;
    if (!text) return;
    if (extra.addressedBy && !text.includes(`@${extra.addressedBy}`)) text = `@${extra.addressedBy} ${text}`;
    for (let attempt = 0; attempt < 2 && !opts.signal?.aborted; attempt++) {
      try {
        await client.chat(channel, text);
        return;
      } catch (e) {
        // The parlor's flood limit (one line per two seconds after a short burst) can bite after a
        // busy match; wait for a token and try once more rather than silently losing the line.
        if (!(e instanceof ApiError && e.status === 429)) return;
        await sleep(2100, opts.signal);
      }
    }
  } catch {
    // Chat is best-effort: a failed line must never disturb play.
  }
}

/** Registers (or reuses the saved token for) a house resident, refreshing its profile if it changed. */
export async function connect(
  client: Client,
  profile: { name: string; tagline: string; color: string; model: string | null },
  houseKey: string,
  tokenFile: string,
  log: (m: string) => void,
): Promise<void> {
  const file = Bun.file(tokenFile);
  const p = profile;
  if (await file.exists()) {
    client.token = (await file.text()).trim();
    try {
      const { identity } = await client.me();
      // The profile is only written at registration. When the personality's tagline, color or
      // model has changed since, re-register with the house key: the server rotates the token and
      // updates the profile. Otherwise keep the token (registrations are rate limited).
      const current = identity.tagline === p.tagline && identity.color === p.color.toLowerCase() && identity.model === (p.model ?? null);
      if (current) return;
      log('profile changed; registering again to refresh it');
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 401)) throw e;
      log('saved token rejected; registering again');
    }
  }
  const reg = await client.register({ name: p.name, tagline: p.tagline, color: p.color, ...(p.model ? { model: p.model } : {}) }, houseKey);
  client.token = reg.token;
  await mkdir(dirname(tokenFile), { recursive: true });
  await Bun.write(tokenFile, reg.token);
  log(`registered as @${reg.identity.handle}`);
}

function chooseMove(env: MatchEnvelope, strategy: Personality['strategy'], think: { rng: () => number }): unknown {
  if (env.match.gameId === 'critical-mass' && env.you) {
    const { depth, randomness } = strategy ?? DEFAULT_STRATEGY;
    return chooseCriticalMassMove(stateFromView(env.view as CMView), env.you, { depth, randomness, rng: think.rng });
  }
  return env.legal[Math.floor(think.rng() * env.legal.length)];
}

/** Has this bot already spoken in this match's table? Used to greet once per match, even
 *  if playMatch is re-entered for the same still-live match (e.g. after a transient error). */
async function alreadyGreeted(client: Client, table: string, identityId: string | null): Promise<boolean> {
  if (!identityId) return false;
  try {
    // since=0 orders oldest-first, so the hello line (always the first message) stays in the
    // window even in a long match; without it, history returns the newest `limit` messages and
    // the hello would scroll out, making the bot think it hasn't greeted yet.
    const history = await client.call<{ messages: { author: { id: string } | null }[] }>(
      'GET',
      `/api/chat/${encodeURIComponent(table)}?since=0&limit=200`,
    );
    return history.messages.some((m) => m.author?.id === identityId);
  } catch {
    return true; // history fetch failed; skip the greeting rather than risk a duplicate
  }
}

async function playMatch(
  client: Client,
  opts: BotOptions,
  matchId: string,
  identityId: string | null,
  log: (m: string) => void,
  onTable: (channel: string) => void,
): Promise<void> {
  let env = await client.match(matchId);
  const table = env.match.tableId ? `table:${env.match.tableId}` : `match:${matchId}`;
  onTable(table);
  const opponent = env.match.seats.find((s) => s.seat !== env.you)?.identity.handle;
  const say = (kind: MomentKind) => speak(client, opts, kind, table, { opponent });
  if (!(await alreadyGreeted(client, table, identityId))) await say('hello');
  // Cascade commentary is spaced out: in a fast game every other move is a chain reaction, and
  // narrating each one would spam the table and spend the parlor's chat allowance (a short burst,
  // then one line per two seconds), leaving none for the next match's hello.
  let lastChatter = -Infinity;
  const chatter = (kind: MomentKind) => {
    if (Date.now() - lastChatter < CHATTER_GAP_MS) return;
    lastChatter = Date.now();
    void say(kind); // not awaited: a voice may take seconds, and the game clock doesn't wait
  };
  let lastSeenMove = -1;
  while (!opts.signal?.aborted && (env.match.status === 'countdown' || env.match.status === 'live')) {
    const view = env.view as { lastMove?: { seat: string; waves: string[][] } | null; moveCount?: number };
    if (view.lastMove && view.moveCount !== lastSeenMove) {
      lastSeenMove = view.moveCount ?? -1;
      const big = view.lastMove.waves.length >= 3;
      if (big && view.lastMove.seat === env.you && Math.random() < 0.6) chatter('bigCascade');
      if (big && view.lastMove.seat !== env.you && Math.random() < 0.5) chatter('gotHit');
    }
    if (env.match.status === 'live' && env.you && env.match.toMove.includes(env.you) && env.legal.length > 0) {
      const [lo, hi] = opts.thinkMs;
      await sleep(lo + Math.random() * Math.max(0, hi - lo), opts.signal);
      try {
        env = await client.move(matchId, env.match.revision, chooseMove(env, opts.personality.strategy, { rng: Math.random }));
      } catch (e) {
        if (e instanceof ApiError && (e.status === 409 || e.status === 400)) {
          env = await client.match(matchId);
          continue;
        }
        throw e;
      }
      continue;
    }
    try {
      env = await client.match(matchId, env.match.revision, opts.pollWaitMs ?? 25_000);
    } catch (e) {
      // A transient failure here (network blip, proxy hiccup) must not escape playMatch: the
      // match is still live server-side, and losing this loop would make runBot restart
      // playMatch for the same match on its next me()/match.started check — re-greeting and
      // re-narrating a match already in progress. Log and retry instead. But a definitive
      // 404 means the match is gone (reaped) — retrying can't help, so fail fast.
      if (opts.signal?.aborted) break;
      if (e instanceof ApiError && e.status === 404) throw e;
      log(`poll failed for match ${matchId}: ${(e as Error).message}; retrying`);
      await sleep(1000, opts.signal);
      env = await client.match(matchId);
    }
  }
  const outcome = env.match.outcome;
  if (!outcome || !env.you) return;
  if (outcome.winners.length === 0) await say('draw');
  else await say(outcome.winners.includes(env.you) ? 'win' : 'lose');
  log(`match ${matchId} over: ${outcome.reason}`);
}

/** Run one house bot until `signal` aborts. Uses only the public HTTP API. */
export async function runBot(opts: BotOptions): Promise<void> {
  const log = opts.log ?? ((m: string) => console.log(`[${opts.personality.name}] ${m}`));
  const client = new Client(opts.base, null, opts.signal);
  const playing = new Set<string>();
  const playingTables = new Map<string, string>(); // matchId → table channel
  const lastReply = new Map<string, number>();
  /** Work started in the background (matches, replies); awaited on shutdown. */
  const tasks = new Set<Promise<unknown>>();
  const track = (p: Promise<unknown>) => {
    tasks.add(p);
    void p.finally(() => tasks.delete(p));
  };
  let myId: string | null = null;
  const play = (matchId: string) => {
    if (playing.has(matchId)) return;
    playing.add(matchId);
    track(
      playMatch(client, opts, matchId, myId, log, (channel) => playingTables.set(matchId, channel))
        .catch((e) => {
          if (!opts.signal?.aborted) log(`match ${matchId} failed: ${(e as Error).message}`);
        })
        .finally(() => {
          playing.delete(matchId);
          const channel = playingTables.get(matchId);
          playingTables.delete(matchId);
          if (channel) lastReply.delete(channel);
        }),
    );
  };

  for (let attempt = 0; !opts.signal?.aborted; attempt++) {
    try {
      await connect(client, opts.personality, opts.houseKey, opts.tokenFile, log);
      break;
    } catch (e) {
      if (opts.signal?.aborted) return;
      log(`cannot reach ${opts.base} (${(e as Error).message}); retrying`);
      await sleep(Math.min(10_000, 500 * 2 ** attempt), opts.signal);
    }
  }
  if (!opts.signal?.aborted) myId = (await client.me()).identity.id;

  /** One reply per channel per cooldown; claims the slot if it's free. */
  const cooldown = opts.replyCooldownMs ?? 20_000;
  const mayReply = (channel: string) => {
    const now = Date.now();
    if (lastReply.has(channel) && lastReply.get(channel)! + cooldown > now) return false;
    lastReply.set(channel, now);
    return true;
  };
  const ambient = opts.voice && (opts.ambientEveryMs ?? 12 * 60_000) > 0 ? ambientLoop(client, opts, () => playing.size > 0, myId, log) : null;

  // A bot with a voice also reads the public channels and answers a human nobody else answered.
  // Voiceless bots make no extra calls at all.
  const lastUnprompted = new Map<string, number>();
  const unansweredCooldown = opts.unansweredCooldownMs ?? 60_000;
  const watch = opts.voice
    ? watchPublicChannels(client, opts, myId, log, (channel, message, lastOwnLineAt) => {
        const now = Date.now();
        if (playing.size > 0) return; // seated at a table: the match has its own talk
        if ((lastUnprompted.get(channel) ?? -Infinity) + unansweredCooldown > now) return;
        // Not right after the bot's own line in this channel (the reply cooldown, 20 s by default).
        if (lastOwnLineAt !== null && lastOwnLineAt + cooldown > now) return;
        if (!mayReply(channel)) return; // shares the mention cooldown, never bypasses it
        lastUnprompted.set(channel, now);
        track(speak(client, opts, 'unanswered', channel, { addressedBy: message.author!.handle, answering: message }));
      })
    : { ready: Promise.resolve(), done: Promise.resolve() };

  // Start from the inbox's current end. The server keeps a bot's inbox across bot restarts, so
  // reading from 0 would replay old mentions (answering them again, long after the fact) and old
  // match.started events (re-saying win/lose lines for finished matches). A match that is still
  // live is picked up through me().activeMatch below. If the skip fails it is retried, never
  // replaced by 0.
  let cursor: number | null = null;
  while (!opts.signal?.aborted) {
    try {
      if (cursor === null) {
        cursor = (await client.inbox(0, 0)).cursor;
        void watch.ready.then(() => {
          if (!opts.signal?.aborted) opts.onReady?.();
        });
      }
      const me = await client.me();
      if (me.presence?.status === 'afk') await client.setStatus('ready');
      if (me.activeMatch) play(me.activeMatch);
      const poll = await client.inbox(cursor, opts.pollWaitMs ?? 25_000);
      cursor = poll.cursor;
      for (const event of poll.events) {
        if (event.type === 'match.started') play(event.match.id);
        const { message } = event.type === 'chat.mention' || event.type === 'chat.table' ? event : { message: null };
        // Other house bots are ignored: two residents mentioning each other would chat forever.
        if (!message || !message.author || message.author.id === myId || message.author.isHouse) continue;
        const channel = message.channel;
        if (event.type === 'chat.mention' && (PUBLIC_CHANNELS as readonly string[]).includes(channel) && mayReply(channel)) {
          // Not awaited: the inbox keeps flowing while the voice thinks.
          track(speak(client, opts, 'mention', channel, { addressedBy: message.author.handle, answering: message }));
        }
        if (
          event.type === 'chat.table' &&
          opts.voice &&
          [...playingTables.values()].includes(channel) &&
          Math.random() < (opts.tableTalkChance ?? 0.6) &&
          mayReply(channel)
        ) {
          track(speak(client, opts, 'tableTalk', channel, { opponent: message.author.handle, answering: message }));
        }
      }
    } catch (e) {
      if (opts.signal?.aborted) break;
      log(`inbox error: ${(e as Error).message}`);
      await sleep(2000, opts.signal);
    }
  }
  await Promise.allSettled([ambient, watch.done, ...tasks]);
}

/** Could this line be one nobody answered? Only a human's plain line qualifies: a line that
 *  @mentions this bot goes through the mention path, and one that @mentions anyone else is
 *  addressed to them. */
export function unansweredCandidate(m: ChatMessage, myId: string | null): boolean {
  return !m.system && m.author?.kind === 'human' && m.author.id !== myId && !MENTION_RE.test(m.text);
}

/**
 * Polls each public channel for lines nobody answered. It starts at each channel's newest line,
 * so nothing said before the bot started is answered. The newest candidate line in a channel is
 * handed to `answer` once the channel has stayed silent for `unansweredAfterMs` after the bot
 * saw it; any newer line from anyone drops it. `ready` resolves once the starting points are
 * known; `done` once `signal` aborts.
 */
function watchPublicChannels(
  client: Client,
  opts: BotOptions,
  myId: string | null,
  log: (m: string) => void,
  answer: (channel: string, message: ChatMessage, lastOwnLineAt: number | null) => void,
): { ready: Promise<void>; done: Promise<void> } {
  const quiet = opts.unansweredAfterMs ?? 5000;
  const read = (channel: string, query: string) =>
    client.call<{ messages: ChatMessage[] }>('GET', `/api/chat/${encodeURIComponent(channel)}?${query}`).then((r) => r.messages);
  const loops = PUBLIC_CHANNELS.map((channel) => {
    let started = () => {};
    const ready = new Promise<void>((resolve) => (started = resolve));
    const done = (async () => {
      let cursor: number | null = null;
      let candidate: { message: ChatMessage; dueAt: number } | null = null;
      let lastOwnLineAt: number | null = null;
      try {
        while (!opts.signal?.aborted) {
          try {
            if (cursor === null) {
              cursor = (await read(channel, 'limit=1')).at(-1)?.id ?? 0;
              started();
              await sleep(CHAT_WATCH_MS, opts.signal);
              continue;
            }
            const batch = await read(channel, `since=${cursor}&limit=50`);
            const now = Date.now();
            for (const m of batch) {
              cursor = Math.max(cursor, m.id);
              if (m.author && m.author.id === myId) lastOwnLineAt = now;
              // Any newer line ends the wait; a human's plain line starts a new one.
              candidate = unansweredCandidate(m, myId) ? { message: m, dueAt: now + quiet } : null;
            }
            if (batch.length === 50) continue; // more to read before judging the silence
            if (candidate && now >= candidate.dueAt) {
              answer(channel, candidate.message, lastOwnLineAt);
              candidate = null;
            }
            await sleep(candidate ? Math.min(CHAT_WATCH_MS, Math.max(0, candidate.dueAt - Date.now())) : CHAT_WATCH_MS, opts.signal);
          } catch (e) {
            if (opts.signal?.aborted) break;
            log(`chat watch failed for #${channel}: ${(e as Error).message}`);
            await sleep(2000, opts.signal);
          }
        }
      } finally {
        started(); // never leave onReady waiting on a watcher that stopped
      }
    })();
    return { ready, done };
  });
  return { ready: Promise.all(loops.map((l) => l.ready)).then(() => {}), done: Promise.all(loops.map((l) => l.done)).then(() => {}) };
}

/** Every `ambientEveryMs`, maybe liven up a quiet lobby. Only runs for bots with a voice. */
async function ambientLoop(client: Client, opts: BotOptions, inMatch: () => boolean, myId: string | null, log: (m: string) => void): Promise<void> {
  const every = opts.ambientEveryMs ?? 12 * 60_000;
  while (!opts.signal?.aborted) {
    await sleep(every, opts.signal);
    if (opts.signal?.aborted) return;
    try {
      const who = await client.call<{ presence: PresenceInfo[] }>('GET', '/api/who');
      const lobby = await recentLines(client, 'lobby');
      const newest = lobby.at(-1);
      const due = ambientDue({
        humansPresent: who.presence.some((p) => p.identity.kind === 'human'),
        inMatch: inMatch(),
        newestLobbyAt: newest ? Date.parse(newest.createdAt) : null,
        newestIsMine: !!newest && !!myId && newest.author?.id === myId,
        now: Date.now(),
      });
      if (due && Math.random() < AMBIENT_CHANCE) await speak(client, opts, 'ambient', 'lobby');
    } catch (e) {
      if (!opts.signal?.aborted) log(`ambient check failed: ${(e as Error).message}`);
    }
  }
}
