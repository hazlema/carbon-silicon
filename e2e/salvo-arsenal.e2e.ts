import { expect, test, type APIRequestContext } from '@playwright/test';
import { enter, newPlayer, randomTag } from './testing';

type Legal = { fire?: string; at?: string; cell?: string; lane?: string; place?: string; crate?: string; use?: string };
type Order = { fire: string; at: string; cell: string; lane?: string };
type ItemUse = { item: string; from?: string; sea: string; cell?: string; lane?: string };
type Envelope = {
  you: string | null;
  match: { status: string; revision: number; endReason: string | null };
  view: {
    phase: string;
    round: number;
    eliminated: string[];
    targets: { sea: string }[];
    myOrders: Order[];
    myArsenal: { items: string[]; crate: string[] | null } | null;
    mySea: { port: string[] } | null;
    lastVolley: { round: number; sunk: { ship: string; by: string[] }[]; items: ItemUse[] } | null;
  };
  legal: Legal[];
};

// Every scripted fleet lies in the same place, all in columns a–d: the test knows where the submarine is (a1, b1).
const FLEET: Record<string, string> = { submarine: 'a1', cruiser: 'a3', destroyer: 'a5', frigate: 'a7' };
/** Water on every scripted sea: the agents only ever shoot here, so no one sinks anything but the human. */
const WATER = /^[e-h]/;

test('Salvo arsenal: the human sinks a submarine, picks from the crate, fires the item through the board, and the turn clock counts down', async ({ browser }) => {
  const page = await newPlayer(browser);
  await page.setViewportSize({ width: 1400, height: 900 });
  await enter(page, `sv${randomTag()}`);

  const agents: { headers: Record<string, string> }[] = [];
  for (let i = 0; i < 3; i++) {
    const reg = await page.request.post('/api/agents', { data: { name: `sva${randomTag()}` } });
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
  // The board shows the first target unless you pick another: that agent's submarine is the human's prey.
  const prey = first.view.targets[0].sea;

  // The agents deploy the fixed fleet, pass on any crate, and shell water on each other's seas (never the human's).
  let done = false;
  const pick = <T,>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)];
  const play = async (headers: Record<string, string>) => {
    while (!done) {
      const env = await read(page.request, headers);
      if (env.match.status === 'over') return;
      const port = env.view.mySea?.port ?? [];
      let command: Legal | undefined;
      if (env.view.phase === 'deploy' && port.length) command = { place: port[0], at: FLEET[port[0]], facing: 'east' } as Legal;
      else command = env.legal.find((l) => l.crate === 'pass') ?? pick(env.legal.filter((l) => l.fire === 'shell' && l.at !== me && WATER.test(l.cell!)));
      if (env.match.status === 'live' && command) await move(command, env.match.revision, headers);
      else await page.request.get(`/api/matches/${matchId}?since=${env.match.revision}&waitMs=1000`, { headers });
    }
  };

  await expect(page.getByTestId('sv-round')).toHaveText('deploying', { timeout: 15_000 });
  const loops = agents.map((a) => play(a.headers));
  await page.getByTestId('random').click();
  await expect(page.getByTestId('sv-round')).not.toHaveText('deploying', { timeout: 20_000 });
  await expect(page.locator('[data-main]')).toHaveAttribute('data-sea', prey);

  // The turn clock ticks while you owe the round, and its seconds go down.
  const clock = page.getByTestId('turn-clock');
  await expect(clock).toHaveAttribute('data-state', 'ticking');
  const secs = async () => Number(await clock.locator('.secs').textContent());
  const s0 = await secs();
  expect(s0).toBeGreaterThan(0);
  await expect.poll(secs, { timeout: 5_000, intervals: [500] }).toBeLessThan(s0);

  // Round 1: the human's salvo sinks the prey's submarine (a1, b1); the other guns go to water.
  {
    const env = await read(page.request);
    const shells = env.legal.filter((l) => l.fire === 'shell' && l.at === prey);
    const water = shells.filter((l) => /^[gh]/.test(l.cell!)).slice(0, 2);
    let revision = env.match.revision;
    for (const cell of ['a1', 'b1', ...water.map((l) => l.cell!)]) {
      const res = await move({ fire: 'shell', at: prey, cell }, revision);
      expect(res.ok(), `shell at ${cell}: ${await res.text()}`).toBe(true);
      revision = (await read(page.request)).match.revision;
    }
  }
  await expect.poll(async () => (await read(page.request)).view.lastVolley?.round ?? 0, { timeout: 20_000 }).toBe(1);
  const landed = await read(page.request);
  expect(landed.view.lastVolley!.sunk).toEqual([expect.objectContaining({ ship: 'submarine', by: [me] })]);
  const cards = landed.view.myArsenal!.crate!;
  expect(cards).toHaveLength(3);

  // The crate card shows once the volley has landed; the human takes a card the board can fire at a sea.
  const card = page.getByTestId('crate-card');
  await expect(card).toBeVisible({ timeout: 20_000 });
  await expect(card).toContainText('📦 Crate! Pick one');
  const item = cards.includes('cluster') ? 'cluster' : 'torpedo';
  await page.getByTestId(`crate-${item}`).click();
  await expect(card).toBeHidden();
  await expect.poll(async () => (await read(page.request)).view.myArsenal?.items, { timeout: 10_000 }).toEqual([item]);

  // Round 2: the item from the tray, aimed on the prey's sea through the board, and Fire.
  const now = await read(page.request);
  expect(now.view.round).toBe(2);
  const sea = page.locator('[data-main]');
  await expect(sea).toHaveAttribute('data-sea', prey);
  const tray = page.getByTestId(`item-${item}`);
  await expect(tray).toBeEnabled();
  await tray.click();
  await expect(tray).toHaveAttribute('aria-pressed', 'true');
  let expected: Order;
  if (item === 'cluster') {
    const centre = now.legal.some((l) => l.fire === 'cluster' && l.at === prey && l.cell === 'c4') ? 'c4' : now.legal.find((l) => l.fire === 'cluster' && l.at === prey)!.cell!;
    await sea.locator(`[data-cell="${centre}"]`).click();
    await expect(sea.getByTestId('cluster-aim')).toHaveCount(1);
    expected = { fire: 'cluster', at: prey, cell: centre };
  } else {
    const lane = now.legal.find((l) => l.fire === 'torpedo' && l.at === prey)!.lane!;
    // Any cell of the lane picks it: the lane is a column for north/south shooters, a row for east/west.
    const cell = me === 'east' || me === 'west' ? `d${lane}` : `${lane}4`;
    await sea.locator(`[data-cell="${cell}"]`).click();
    expected = { fire: 'torpedo', at: prey, cell: expect.any(String) as unknown as string, lane };
  }
  await page.getByTestId('fire').click();
  await expect.poll(async () => (await read(page.request)).view.myOrders, { timeout: 10_000 }).toEqual([expected]);
  await expect(page.getByTestId(`item-${item}`)).toHaveCount(0);

  // The rest of the salvo goes to water; once everyone is in, the volley tells the item, from the human.
  {
    let env = await read(page.request);
    const left = env.legal.filter((l) => l.fire === 'shell' && l.at === prey && /^[gh]/.test(l.cell!));
    const guns = (env.view as unknown as { guns: Record<string, number> }).guns[me];
    for (const l of left.slice(0, guns - 1)) {
      const res = await move(l, env.match.revision);
      expect(res.ok(), `shell at ${l.cell}: ${await res.text()}`).toBe(true);
      env = await read(page.request);
    }
  }
  await expect.poll(async () => (await read(page.request)).view.lastVolley?.round ?? 0, { timeout: 20_000 }).toBe(2);
  const told = (await read(page.request)).view.lastVolley!.items;
  expect(told.some((x) => x.item === item && x.from === me && x.sea === prey), `the volley tells the ${item}: ${JSON.stringify(told)}`).toBe(true);

  done = true;
  await Promise.all(loops);
});
