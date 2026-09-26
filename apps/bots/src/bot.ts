import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { stateFromView, type CMView } from '@cs/critical-mass';
import type { MatchEnvelope } from '@cs/shared/protocol';
import { ApiError, Client } from './client';
import { line, type Personality } from './personality';
import { chooseCriticalMassMove } from './strategies/critical-mass';

export interface BotOptions {
  base: string;
  personality: Personality;
  houseKey: string;
  tokenFile: string;
  thinkMs: [number, number];
  pollWaitMs?: number;
  signal?: AbortSignal;
  log?: (msg: string) => void;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      resolve();
    }, { once: true });
  });

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

function chooseMove(env: MatchEnvelope, think: { rng: () => number }): unknown {
  if (env.match.gameId === 'critical-mass' && env.you) {
    return chooseCriticalMassMove(stateFromView(env.view as CMView), env.you, { depth: 2, randomness: 0.15, rng: think.rng });
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
  const p = opts.personality;
  const table = `match:${matchId}`;
  const say = (text: string) => client.chat(table, text).catch(() => {});
  let env = await client.match(matchId);
  if (!(await alreadyGreeted(client, table, identityId))) await say(line(p.lines.hello));
  let lastSeenMove = -1;
  while (!opts.signal?.aborted && (env.match.status === 'countdown' || env.match.status === 'live')) {
    const view = env.view as { lastMove?: { seat: string; waves: string[][] } | null; moveCount?: number };
    if (view.lastMove && view.moveCount !== lastSeenMove) {
      lastSeenMove = view.moveCount ?? -1;
      const big = view.lastMove.waves.length >= 3;
      if (big && view.lastMove.seat === env.you && Math.random() < 0.6) await say(line(p.lines.bigCascade));
      if (big && view.lastMove.seat !== env.you && Math.random() < 0.5) await say(line(p.lines.gotHit));
    }
    if (env.match.status === 'live' && env.you && env.match.toMove.includes(env.you) && env.legal.length > 0) {
      const [lo, hi] = opts.thinkMs;
      await sleep(lo + Math.random() * Math.max(0, hi - lo), opts.signal);
      try {
        env = await client.move(matchId, env.match.revision, chooseMove(env, { rng: Math.random }));
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
  if (outcome.winners.length === 0) await say(line(p.lines.draw));
  else await say(line(outcome.winners.includes(env.you) ? p.lines.win : p.lines.lose));
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

  let cursor = 0;
  while (!opts.signal?.aborted) {
    try {
      const me = await client.me();
      if (me.presence?.status === 'afk') await client.setStatus('ready');
      if (me.activeMatch) play(me.activeMatch);
      const poll = await client.inbox(cursor, opts.pollWaitMs ?? 25_000);
      cursor = poll.cursor;
      for (const event of poll.events) {
        if (event.type === 'match.started') play(event.match.id);
        if (event.type === 'chat.mention' && !event.message.channel.startsWith('match:')) {
          const channel = event.message.channel;
          const now = Date.now();
          if ((lastReply.get(channel) ?? 0) + 15_000 < now) {
            lastReply.set(channel, now);
            const who = event.message.author ? `@${event.message.author.handle} ` : '';
            await client.chat(channel, who + line(opts.personality.lines.mentioned)).catch(() => {});
          }
        }
      }
    } catch (e) {
      if (opts.signal?.aborted) break;
      log(`inbox error: ${(e as Error).message}`);
      await sleep(2000, opts.signal);
    }
  }
}
