import type { SeatId } from '@cs/game-api';
import type { SalvoState } from './index';

/** How long a whisper auction runs once it opens. */
export const AUCTION_MS = 30_000;
/** A bidder's legal lists bids 0..min(scrap, BID_LEGAL_MAX): any amount up to its scrap is accepted. */
export const BID_LEGAL_MAX = 20;
/** The numbers a ghost may tell. */
export const TELL_MAX = 9;

/**
 * A ghost's whisper: a sonar reading it took on a living sea (`truth`, real ship cells afloat in the 3×3 at
 * the listing's volley; decoys invisible), sold to the highest bid among the living in a silent auction.
 * The ghost tells the winner `tell` (the truth when it never set one). `opensRound` is the round after the
 * listing; `closesAt` is stamped by the first clock() in it. Bids are sealed: `at` is a counter
 * (state.bidSeq), the tiebreak (earliest that amount was placed). 'faded': its ghost left before the close.
 * 'void': the match ended before it opened. Every auction stays in the list, for the end of the match.
 */
export interface Auction {
  ghost: SeatId;
  sea: SeatId;
  centre: string;
  cells: string[];
  truth: number;
  tell: number | null;
  opensRound: number;
  closesAt: number | null;
  bids: Record<SeatId, { n: number; at: number } | null>;
  abstained: SeatId[];
  state: 'open' | 'sold' | 'unsold' | 'faded' | 'void';
  winner: SeatId | null;
  price: number;
  /** The round it closed (or faded) in; null while open. */
  closedRound: number | null;
}

/** "c3–e5": a 3×3 by its corners. */
export const areaName = (cells: string[]) => `${cells[0]}–${cells.at(-1)}`;
/** What the winner was told. */
export const said = (a: Auction) => a.tell ?? a.truth;
export const openAuctions = (s: SalvoState) => s.auctions.filter((a) => a.state === 'open');
export const openAuctionOf = (s: SalvoState, ghost: SeatId) => s.auctions.find((a) => a.state === 'open' && a.ghost === ghost);

/**
 * Close an auction now, with the bids so far: the highest bid from a living seat that can still pay it
 * wins, ties to the earliest; the winner's scrap moves to the ghost. Mutates `s`.
 */
export function closeAuction(s: SalvoState, a: Auction, alive: SeatId[]): void {
  const offers = Object.entries(a.bids)
    .filter((e): e is [SeatId, { n: number; at: number }] => e[1] !== null && alive.includes(e[0]) && e[1].n >= 1 && e[1].n <= s.scrap[e[0]])
    .sort((x, y) => y[1].n - x[1].n || x[1].at - y[1].at);
  a.closedRound = s.round;
  const top = offers[0];
  if (!top) {
    a.state = 'unsold';
    return;
  }
  const [winner, { n }] = top;
  s.scrap[winner] -= n;
  s.scrap[a.ghost] += n;
  a.state = 'sold';
  a.winner = winner;
  a.price = n;
}

/** Close every open auction that is due by `due`, ghosts in seat order. Mutates `s`. */
export function closeDue(s: SalvoState, alive: SeatId[], due: (a: Auction) => boolean): void {
  const order = (a: Auction) => s.seats.indexOf(a.ghost);
  for (const a of openAuctions(s).filter(due).sort((x, y) => order(x) - order(y))) closeAuction(s, a, alive);
}

/** The listing, the close and the fade, told. Seats are written {seat}. */
export const listingLine = (a: Auction) => `👻 {${a.ghost}} auctions a sonar reading on {${a.sea}}'s sea, ${areaName(a.cells)} — ${AUCTION_MS / 1000} seconds.`;
export const closeLine = (a: Auction) =>
  a.state === 'sold' ? `{${a.winner}} wins {${a.ghost}}'s whisper for ${a.price} scrap.` : `Nobody bids on {${a.ghost}}'s whisper.`;
export const fadeLine = (a: Auction) => `{${a.ghost}}'s whisper fades with them.`;
export const truthLine = (a: Auction) =>
  `{${a.ghost}} told {${a.winner}} ${said(a)} in {${a.sea}}'s ${areaName(a.cells)}. The truth was ${a.truth}.${said(a) === a.truth ? ' An honest ghost!' : ''}`;

/** Auctions that closed (sold or unsold) between two states: open (or not yet listed) before, closed after. */
export const closedBetween = (before: SalvoState, after: SalvoState) =>
  after.auctions.filter((a, i) => (a.state === 'sold' || a.state === 'unsold') && (before.auctions[i]?.state ?? 'open') === 'open');
