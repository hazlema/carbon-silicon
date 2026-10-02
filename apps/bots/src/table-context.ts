import type { MatchEnvelope } from '@cs/shared/protocol';

/** What a resident is told about the table it's sitting at, beside the chat. */
export interface TableContext {
  /** "@Frosty (human), @Fable (machine), @OLD_IRON (you)" */
  players: string;
  /** "Turn 36 — @Fable to move", "Round 2", "The match is over" */
  turn: string;
  /** "Fable leads with 14 cells, you hold 11, Frosty is down to 5"; null for a game we can't score. */
  standing: string | null;
  /** The last moves, oldest first: "28. OLD_IRON places at b4 — small chain, takes 2 of Fable's cells". */
  moves: string[];
}

export interface StandingEntry {
  handle: string;
  value: number;
  you: boolean;
  out: boolean;
  note?: string;
}

const MOVES_SHOWN = 10;

/** Leader first, the bot as "you", the last of three or more as "down to", anyone out at the end. */
export function standingLine(entries: StandingEntry[], unit: string): string {
  const live = entries.filter((e) => !e.out).sort((a, b) => b.value - a.value);
  const name = (e: StandingEntry) => (e.you ? 'you' : e.handle);
  const note = (e: StandingEntry) => (e.note ? ` (${e.note})` : '');
  const parts: string[] = [];
  if (live.length > 0) {
    const top = live.filter((e) => e.value === live[0].value);
    if (top.length > 1) parts.push(`${top.map(name).join(' and ')} are level at ${live[0].value} ${unit}`);
    else parts.push(`${name(live[0])} ${live[0].you ? 'lead' : 'leads'} with ${live[0].value} ${unit}${note(live[0])}`);
    const rest = live.slice(top.length);
    rest.forEach((e, k) => {
      const last = live.length >= 3 && k === rest.length - 1;
      parts.push(last ? `${name(e)} ${e.you ? 'are' : 'is'} down to ${e.value}${note(e)}` : `${name(e)} ${e.you ? 'hold' : 'has'} ${e.value}${note(e)}`);
    });
  }
  for (const e of entries.filter((x) => x.out)) parts.push(`${name(e)} ${e.you ? 'are' : 'is'} out`);
  return parts.join(', ');
}

type Seat = MatchEnvelope['match']['seats'][number];

function standingOf(env: MatchEnvelope): string | null {
  const v = (env.view ?? {}) as Record<string, any>;
  const entry = (s: Seat, value: number, out = false, note?: string): StandingEntry => ({ handle: s.identity.handle, value, you: s.seat === env.you, out, note });
  const seats = env.match.seats;
  switch (env.match.gameId) {
    case 'critical-mass':
      return standingLine(seats.map((s) => entry(s, v.counts?.[s.seat]?.cells ?? 0, (v.eliminated ?? []).includes(s.seat))), 'cells');
    case 'checkers':
      return standingLine(
        seats.map((s) => {
          const mine = ((v.pieces ?? []) as { side: string; king: boolean }[]).filter((p) => p.side === s.seat);
          const crowns = mine.filter((p) => p.king).length;
          return entry(s, mine.length, false, crowns > 0 ? `${crowns} crowned` : undefined);
        }),
        'knights',
      );
    case 'lightline':
      return standingLine(seats.map((s) => entry(s, v.score?.[s.seat] ?? 0)), 'rounds');
    default:
      return null;
  }
}

function turnOf(env: MatchEnvelope): string {
  const { match } = env;
  if (match.status === 'countdown') return 'The match is about to start';
  if (match.status !== 'live') return 'The match is over';
  if (env.realtime) return `Round ${(env.view as { round?: number } | null)?.round ?? 1}`;
  const n = (env.recent?.at(-1)?.number ?? 0) + 1;
  const mover = match.toMove[0];
  if (!mover) return `Turn ${n}`;
  if (mover === env.you) return `Turn ${n} — your move`;
  return `Turn ${n} — @${match.seats.find((s) => s.seat === mover)?.identity.handle ?? mover} to move`;
}

/** The table as a resident should see it before it opens its mouth. */
export function tableContext(env: MatchEnvelope): TableContext {
  return {
    players: env.match.seats.map((s) => `@${s.identity.handle} (${s.seat === env.you ? 'you' : s.identity.kind === 'human' ? 'human' : 'machine'})`).join(', '),
    turn: turnOf(env),
    standing: standingOf(env),
    moves: (env.recent ?? []).slice(-MOVES_SHOWN).map((r) => (r.handle ? `${r.number}. ${r.handle} ${r.text}` : `${r.number}. ${r.text}`)),
  };
}
