import { expect, test, type APIRequestContext } from '@playwright/test';
import { enter, newPlayer, randomTag } from './testing';

type Legal = { fire?: string; trick?: string; at?: string; cell?: string; place?: string; crate?: string; bid?: number; ghost?: string; tell?: number };
type AuctionView = { ghost: string; sea: string; centre: string; cells: string[]; closesAt: number | null; bids: Record<string, 'bid' | 'abstained' | null> };
type Envelope = {
  you: string | null;
  match: { status: string; revision: number; seats: { seat: string; identity: { handle: string } }[] };
  view: {
    phase: string;
    round: number;
    eliminated: string[];
    ghosts: string[];
    myOrders: { fire: string; at: string; cell: string }[];
    myTricks: { pending: { trick: string; at: string; cell: string } | null; whisper: { truth: number; tell: number | null } | null } | null;
    mySea: { port: string[] } | null;
    auctions: AuctionView[];
    myBids: Record<string, number>;
    whispers: { ghost: string; sea: string; cells: string[]; said: number }[];
    scrap: Record<string, number>;
  };
  legal: Legal[];
  recent: { seat: string | null; text: string }[];
};

// Every scripted fleet lies in the same place (facing east, columns a–d): the test knows every ship cell.
const FLEET: Record<string, string> = { submarine: 'a1', cruiser: 'a3', destroyer: 'a5', frigate: 'a7' };
/** Round 1: the three shooters split the doomed agent's twelve ship cells, four guns each. */
const HUMAN_R1 = ['a3', 'b3', 'c3', 'd3'];
const AGENT_R1 = [
  ['a1', 'b1', 'a5', 'b5'],
  ['c5', 'a7', 'b7', 'c7'],
];
/** Water on every scripted sea (columns e–h): after round 1 nobody hits anything. */
const WATER = /^[e-h]/;
/** The whisper's 3×3, centred b4 (a3–c5): the cruiser's a3–c3 and the destroyer's a5–c5, all afloat. */
const CENTRE = 'b4';
const TRUTH = 6;
const TELL = 3;
const BID = 5;

test('Salvo whisper: a ghost auctions a reading, the human bids through the panel, wins on the 30-second clock and sees the ghost’s word', async ({ browser }) => {
  test.setTimeout(150_000);
  const page = await newPlayer(browser);
  await page.setViewportSize({ width: 1400, height: 900 });
  await enter(page, `sv${randomTag()}`);

  const agents: { headers: Record<string, string> }[] = [];
  for (let i = 0; i < 3; i++) {
    const reg = await page.request.post('/api/agents', { data: { name: `svw${randomTag()}` } });
    expect(reg.status()).toBe(201);
    const { token } = await reg.json();
    agents.push({ headers: { authorization: `Bearer ${token}` } });
  }
  const host = await page.request.post('/api/tables', { data: { gameId: 'salvo', open: true } });
  expect(host.status()).toBe(201);
  const tableId = (await host.json()).table.id as string;
  for (const a of agents) expect((await page.request.post(`/api/tables/${tableId}/sit`, { headers: a.headers })).status()).toBe(200);
  expect((await page.request.post(`/api/tables/${tableId}/start`)).status()).toBe(200);
  await page.goto(`/t/${tableId}`);
  let matchId = '';
  await expect
    .poll(async () => (matchId = (await (await page.request.get(`/api/tables/${tableId}`)).json()).table.matchId ?? ''), { timeout: 10_000 })
    .not.toBe('');

  const read = async (req: APIRequestContext, headers?: Record<string, string>): Promise<Envelope> =>
    (await req.get(`/api/matches/${matchId}`, { headers })).json();
  const move = (command: unknown, revision: number, headers?: Record<string, string>) =>
    page.request.post(`/api/matches/${matchId}/move`, { headers, data: { revision, command } });

  const first = await read(page.request);
  const me = first.you!;
  const seatOf = await Promise.all(agents.map(async (a) => (await read(page.request, a.headers)).you!));
  // agents[0] is sunk in round 1 and haunts; agents[1]'s sea is the one it whispers about; agents[2] bids 1.
  const [ghost, sea, rival] = seatOf;
  const handle = (seat: string) => first.match.seats.find((x) => x.seat === seat)!.identity.handle;

  // The scripted seats: deploy the fixed fleet, pass on crates, round 1 at the doomed fleet, then water on
  // each other's seas (never the human's). The ghost lists its whisper in round 2, tells a lie, and otherwise
  // owes a trick (a splash or a mine away from the human). In the auction the sea's owner abstains, the rival bids 1.
  let done = false;
  const pick = <T,>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)];
  const play = async (i: number) => {
    const headers = agents[i].headers;
    const self = seatOf[i];
    while (!done) {
      const env = await read(page.request, headers);
      if (env.match.status === 'over') return;
      const v = env.view;
      const port = v.mySea?.port ?? [];
      const open = v.auctions?.find((a) => a.ghost === ghost);
      let command: Legal | undefined;
      if (v.phase === 'deploy' && port.length) command = { place: port[0], at: FLEET[port[0]], facing: 'east' } as Legal;
      else if (env.legal.some((l) => l.crate === 'pass')) command = { crate: 'pass' };
      else if (self === ghost && v.ghosts.includes(self)) {
        if (v.myTricks?.whisper && v.myTricks.whisper.tell === null) command = { tell: TELL };
        else if (v.round === 2 && !v.myTricks?.pending) command = { trick: 'whisper', at: sea, cell: CENTRE };
        else if (!v.myTricks?.pending) {
          const tricks = env.legal.filter((l) => l.trick && l.trick !== 'whisper' && l.at !== me);
          command = tricks.find((l) => l.trick === 'splash' && (l as { fool?: string }).fool !== me) ?? tricks.find((l) => l.trick === 'mine');
        }
      } else if (open && open.bids[self] === null && self !== ghost) command = self === sea ? { bid: 0, ghost } : { bid: 1, ghost };
      else {
        const shells = env.legal.filter((l) => l.fire === 'shell');
        const sent = new Set(v.myOrders.map((o) => `${o.at} ${o.cell}`));
        if (v.round === 1 && self !== ghost) {
          const cells = AGENT_R1[self === sea ? 0 : 1];
          command = shells.find((l) => l.at === ghost && cells.includes(l.cell!) && !sent.has(`${l.at} ${l.cell}`));
        } else {
          const water = shells.filter((l) => l.at !== me && WATER.test(l.cell!));
          if (water.length) command = pick(water);
        }
      }
      if (env.match.status === 'live' && command) {
        const res = await move(command, env.match.revision, headers);
        if (res.status() === 409 || res.status() === 400 || res.status() === 422) await page.request.get(`/api/matches/${matchId}?since=${env.match.revision}&waitMs=300`, { headers });
      } else {
        await page.request.get(`/api/matches/${matchId}?since=${env.match.revision}&waitMs=1000`, { headers });
      }
    }
  };

  /** The human's shots, through the API: these cells on that sea, one by one. */
  const fire = async (at: string, cells: string[]) => {
    for (const cell of cells) {
      const env = await read(page.request);
      const res = await move({ fire: 'shell', at, cell }, env.match.revision);
      expect(res.ok(), `shell at ${at} ${cell}: ${await res.text()}`).toBe(true);
    }
  };

  await expect(page.getByTestId('sv-round')).toHaveText('deploying', { timeout: 15_000 });
  const loops = agents.map((_, i) => play(i));
  await page.getByTestId('random').click();
  await expect.poll(async () => (await read(page.request)).view.round, { timeout: 20_000 }).toBe(1);
  await expect.poll(async () => (await read(page.request)).view.phase, { timeout: 20_000 }).toBe('fire');

  // Round 1: the human's four shells sink the doomed agent's cruiser; the other two agents finish its fleet.
  await fire(ghost, HUMAN_R1);
  await expect.poll(async () => (await read(page.request)).view.round, { timeout: 20_000 }).toBe(2);
  const r2 = await read(page.request);
  expect(r2.view.ghosts, `round 1 sinks ${ghost} (out: ${r2.view.eliminated})`).toContain(ghost);

  // Round 2: the human passes on its crate and shells water on the rival's sea; the ghost lists its whisper.
  if (r2.legal.some((l) => l.crate === 'pass')) expect((await move({ crate: 'pass' }, r2.match.revision)).ok()).toBe(true);
  await expect.poll(async () => (await read(page.request, agents[0].headers)).view.myTricks?.pending, { timeout: 15_000 }).toEqual({ trick: 'whisper', at: sea, cell: CENTRE });
  await fire(rival, ['g1', 'g2', 'g3', 'g4']);
  await expect.poll(async () => (await read(page.request)).view.round, { timeout: 20_000 }).toBe(3);

  // Round 3: the auction is open. The human sees the panel naming the ghost and the sea.
  const r3 = await read(page.request);
  const auction = r3.view.auctions.find((a) => a.ghost === ghost)!;
  expect(auction, `an auction is open: ${JSON.stringify(r3.view.auctions)}`).toBeTruthy();
  expect(auction.sea).toBe(sea);
  expect(auction.cells).toHaveLength(9);
  expect(r3.recent.some((r) => r.text === `👻 ${handle(ghost)} auctions a sonar reading on ${handle(sea)}'s sea, a3–c5 — 30 seconds.`), JSON.stringify(r3.recent.map((r) => r.text))).toBe(true);
  const panel = page.locator(`[data-testid="auction"][data-ghost="${ghost}"][data-sea="${sea}"]`);
  await expect(panel).toBeVisible({ timeout: 10_000 });
  await expect(panel).toContainText('👻 30-second ghost intel auction');
  await expect(panel.getByTestId('auction-what')).toContainText(`@${handle(ghost)}'s reading on`);
  await expect(panel.getByTestId('auction-what')).toContainText(`@${handle(sea)}'s sea, a3–c5`);
  await expect(panel.getByTestId('auction-clock')).toBeVisible();

  // The ghost tells a lie; its own view holds the truth.
  await expect.poll(async () => (await read(page.request, agents[0].headers)).view.myTricks?.whisper, { timeout: 15_000 }).toEqual({ truth: TRUTH, tell: TELL });

  // The human bids through the panel; the server holds the amount as the human's alone.
  const before = (await read(page.request)).view.scrap;
  expect(before[me]).toBeGreaterThanOrEqual(BID);
  await panel.getByTestId(`auction-bid-${BID}`).click();
  await expect.poll(async () => (await read(page.request)).view.myBids[ghost], { timeout: 10_000 }).toBe(BID);
  await expect(panel.getByTestId('auction-mybid')).toHaveText(`Your sealed bid: ${BID}`);
  await expect(panel.locator(`[data-testid="auction-status"][data-seat="${me}"]`)).toHaveAttribute('data-status', 'bid');

  // Another seat sees that the human bid, never how much.
  await expect
    .poll(async () => (await read(page.request, agents[2].headers)).view.auctions.find((a) => a.ghost === ghost)?.bids, { timeout: 15_000 })
    .toEqual(expect.objectContaining({ [me]: 'bid', [sea]: 'abstained', [rival]: 'bid' }));
  const theirs = await read(page.request, agents[2].headers);
  const seen = theirs.view.auctions.find((a) => a.ghost === ghost)!;
  expect(Object.values(seen.bids).every((b) => b === null || typeof b === 'string'), JSON.stringify(seen.bids)).toBe(true);
  expect(theirs.view.myBids).toEqual({ [ghost]: 1 });
  expect(JSON.stringify(theirs.view.auctions)).not.toContain(`"n"`);
  expect(theirs.view.myTricks).toBeNull();

  // The human holds its salvo, so round 3 can't resolve: the auction closes on its 30-second clock.
  const closesAt = (await read(page.request)).view.auctions.find((a) => a.ghost === ghost)!.closesAt;
  expect(closesAt, 'the clock stamped the close').not.toBeNull();
  await expect.poll(async () => (await read(page.request)).view.auctions.length, { timeout: 40_000, intervals: [500] }).toBe(0);
  const after = await read(page.request);
  expect(after.view.round, 'closed on the clock, not by the round resolving').toBe(3);
  expect(Date.now()).toBeGreaterThanOrEqual(closesAt! - 2_000);
  expect(after.view.scrap[me]).toBe(before[me] - BID);
  expect(after.view.scrap[ghost]).toBe(before[ghost] + BID);
  expect(after.view.whispers).toEqual([{ ghost, sea, cells: auction.cells, said: TELL }]);
  expect(after.recent.some((r) => r.text === `${handle(me)} wins ${handle(ghost)}'s whisper for ${BID} scrap.`), JSON.stringify(after.recent.map((r) => r.text))).toBe(true);
  // The rival, who bid 1, paid nothing.
  expect(after.view.scrap[rival]).toBe(before[rival]);

  // The board shows the ghost's word on the area: show that sea, and the marker reads the tell.
  await expect(panel).toBeHidden({ timeout: 10_000 });
  await page.locator(`button.chip:not(.gone)[data-seat="${sea}"]`).click();
  const main = page.locator('[data-main]');
  await expect(main).toHaveAttribute('data-sea', sea);
  const mark = main.locator(`[data-testid="whisper-mark"][data-ghost="${ghost}"]`);
  await expect(mark).toHaveAttribute('data-said', String(TELL));
  await expect(mark).toHaveText(`👻 ${TELL}?`);
  await expect(main.locator(`[data-cell="${CENTRE}"]`)).toHaveAttribute('title', new RegExp(`👻 @${handle(ghost)} says ${TELL}`));

  done = true;
  await Promise.all(loops);
});
