import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { stateFromView, type CMView } from '@cs/critical-mass';
import type { ChatMessage, MatchEnvelope, PresenceInfo } from '@cs/shared/protocol';
import { ApiError, Client } from './client';
import { DEFAULT_STRATEGY, line, type Personality } from './personality';
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
}

/** Ambient chatter needs the lobby to have been quiet for at least this long. */
const LOBBY_QUIET_MS = 8 * 60_000;
const AMBIENT_CHANCE = 0.5;
/** At most one cascade remark per this long at a table. */
const CHATTER_GAP_MS = 8000;

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
};

/** Should a bot with a voice speak up in the lobby now? (The coin flip happens elsewhere.) */
export function ambientDue(s: { humansPresent: boolean; inMatch: boolean; newestLobbyAt: number | null; now: number }): boolean {
  return s.humansPresent && !s.inMatch && (s.newestLobbyAt === null || s.now - s.newestLobbyAt >= LOBBY_QUIET_MS);
}

const toChatLine = (m: ChatMessage): ChatLine => ({
  author: m.author?.handle ?? 'house',
  kind: m.system || !m.author ? 'system' : m.author.kind === 'human' ? 'human' : 'agent',
  text: m.text,
});

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
  extra: { opponent?: string; addressedBy?: string } = {},
): Promise<void> {
  try {
    let text: string | null = null;
    if (opts.voice) {
      const recent = await recentLines(client, channel).catch(() => [] as ChatMessage[]);
      const moment: Moment = { kind, channel, recent: recent.map(toChatLine), ...extra };
      text = await opts.voice.say(moment).catch(() => null);
    }
    const bank = BANK[kind];
    text ||= bank ? line(opts.personality.lines[bank]) : null;
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

async function connect(client: Client, opts: BotOptions, log: (m: string) => void): Promise<void> {
  const file = Bun.file(opts.tokenFile);
  if (await file.exists()) {
    client.token = (await file.text()).trim();
    try {
      await client.me();
      return;
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 401)) throw e;
      log('saved token rejected; registering again');
    }
  }
  const p = opts.personality;
  const reg = await client.register({ name: p.name, tagline: p.tagline, color: p.color, ...(p.model ? { model: p.model } : {}) }, opts.houseKey);
  client.token = reg.token;
  await mkdir(dirname(opts.tokenFile), { recursive: true });
  await Bun.write(opts.tokenFile, reg.token);
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

async function playMatch(client: Client, opts: BotOptions, matchId: string, identityId: string | null, log: (m: string) => void): Promise<void> {
  const table = `match:${matchId}`;
  let env = await client.match(matchId);
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
  const lastReply = new Map<string, number>();
  let myId: string | null = null;
  const play = (matchId: string) => {
    if (playing.has(matchId)) return;
    playing.add(matchId);
    playMatch(client, opts, matchId, myId, log)
      .catch((e) => {
        if (!opts.signal?.aborted) log(`match ${matchId} failed: ${(e as Error).message}`);
      })
      .finally(() => playing.delete(matchId));
  };

  for (let attempt = 0; !opts.signal?.aborted; attempt++) {
    try {
      await connect(client, opts, log);
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
  const ambient = opts.voice && (opts.ambientEveryMs ?? 12 * 60_000) > 0 ? ambientLoop(client, opts, () => playing.size > 0, log) : null;

  // Start from the inbox's current end. The server keeps a bot's inbox across bot restarts, so
  // reading from 0 would replay old mentions (answering them again, long after the fact) and old
  // match.started events (re-saying win/lose lines for finished matches). A match that is still
  // live is picked up through me().activeMatch below.
  let cursor = 0;
  if (!opts.signal?.aborted) cursor = await client.inbox(0, 0).then((p) => p.cursor, () => 0);
  while (!opts.signal?.aborted) {
    try {
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
        if (event.type === 'chat.mention' && !channel.startsWith('match:') && mayReply(channel)) {
          // Not awaited: the inbox keeps flowing while the voice thinks.
          void speak(client, opts, 'mention', channel, { addressedBy: message.author.handle });
        }
        if (
          event.type === 'chat.table' &&
          opts.voice &&
          playing.has(channel.slice('match:'.length)) &&
          Math.random() < (opts.tableTalkChance ?? 0.6) &&
          mayReply(channel)
        ) {
          void speak(client, opts, 'tableTalk', channel, { opponent: message.author.handle });
        }
      }
    } catch (e) {
      if (opts.signal?.aborted) break;
      log(`inbox error: ${(e as Error).message}`);
      await sleep(2000, opts.signal);
    }
  }
  await ambient;
}

/** Every `ambientEveryMs`, maybe liven up a quiet lobby. Only runs for bots with a voice. */
async function ambientLoop(client: Client, opts: BotOptions, inMatch: () => boolean, log: (m: string) => void): Promise<void> {
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
        now: Date.now(),
      });
      if (due && Math.random() < AMBIENT_CHANCE) await speak(client, opts, 'ambient', 'lobby');
    } catch (e) {
      if (!opts.signal?.aborted) log(`ambient check failed: ${(e as Error).message}`);
    }
  }
}
