import { expect, test, type APIRequestContext } from '@playwright/test';
import { enter, newPlayer, randomTag } from './testing';

type Legal = { fire?: string; trick?: string; at?: string; cell?: string; place?: string };
type Envelope = {
  you: string | null;
  match: { status: string; revision: number; endReason: string | null; seats: { seat: string; identity: { handle: string } }[] };
  view: { phase: string; round: number; eliminated: string[]; targets: { sea: string }[]; myTricks?: { pending: { trick: string; at: string; cell: string } | null } | null };
  legal: Legal[];
};

test('Salvo: a fleet sunk mid-match stays on view stamped DEFEATED, and your own sinking is told', async ({ browser }) => {
  const page = await newPlayer(browser);
  await page.setViewportSize({ width: 1400, height: 900 });
  await enter(page, `sv${randomTag()}`);

  // Three machines over plain HTTP, aimed by the script: four seats, so the match outlives two fleets.
  const agents: { handle: string; headers: Record<string, string> }[] = [];
  for (let i = 0; i < 3; i++) {
    const reg = await page.request.post('/api/agents', { data: { name: `sva${randomTag()}` } });
    expect(reg.status()).toBe(201);
    const { token, identity } = await reg.json();
    agents.push({ handle: identity.handle, headers: { authorization: `Bearer ${token}` } });
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
  const first = await read(page.request);
  const me = first.you!;
  // The board shows the first living target unless you pick another.
  const watched = first.view.targets[0].sea;

  // Everyone shoots at the sea the page shows by default, then at the human. Once the human is out
  // nobody fires again, so the match holds still (live) while the page is checked.
  let done = false;
  const pick = <T,>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)];
  const play = async (headers?: Record<string, string>) => {
    while (!done) {
      const env = await read(page.request, headers);
      if (env.match.status === 'over' || env.view.eliminated.includes(me)) return;
      const victim = env.view.eliminated.includes(watched) ? me : watched;
      const shells = env.legal.filter((l) => l.fire === 'shell');
      const deploy = env.legal.find((l) => l.place === 'random');
      const aimed = shells.filter((l) => l.at === victim);
      // A sunk agent is a ghost and owes a trick a round: a false splash (harmless) keeps the rounds moving.
      const tricks = env.legal.filter((l) => l.trick);
      const trick = tricks.find((l) => l.trick === 'splash') ?? tricks.find((l) => l.at !== me) ?? tricks[0];
      const command = deploy ?? (aimed.length ? pick(aimed) : shells.length ? pick(shells) : trick);
      if (env.match.status === 'live' && command) {
        await page.request.post(`/api/matches/${matchId}/move`, { headers, data: { revision: env.match.revision, command } });
      } else {
        await page.request.get(`/api/matches/${matchId}?since=${env.match.revision}&waitMs=1000`, { headers });
      }
    }
  };

  const sea = page.locator('[data-main]');
  await expect(page.getByTestId('sv-round')).toHaveText('deploying', { timeout: 15_000 });
  const loops = [play(), ...agents.map((a) => play(a.headers))];
  await expect(page.getByTestId('sv-round')).not.toHaveText('deploying', { timeout: 20_000 });
  await expect(sea).toHaveAttribute('data-sea', watched);

  // The watched fleet goes down with the others still afloat: it stays the big sea, stamped.
  await expect.poll(async () => (await read(page.request)).view.eliminated.includes(watched), { timeout: 60_000 }).toBe(true);
  await expect(page.getByTestId('defeated')).toBeVisible({ timeout: 10_000 });
  await expect(sea).toHaveAttribute('data-sea', watched);

  // Then everyone turns on you.
  await expect.poll(async () => (await read(page.request)).view.eliminated.includes(me), { timeout: 60_000 }).toBe(true);
  const after = await read(page.request);
  expect(after.match.status, `the match goes on (${after.match.endReason}, out: ${after.view.eliminated})`).toBe('live');
  await expect(page.getByTestId('sunk')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByLabel('Your fleet').getByText('sunk', { exact: true })).toBeVisible();
  // Once the volley (and any trick told in it) has landed, the ghost card says who sank you and what you are now, until you press Haunt them.
  const card = page.getByTestId('ghost-card');
  await expect(card).toBeVisible({ timeout: 15_000 });
  await expect(card).toContainText('You were sunk by @');
  await card.getByRole('button', { name: 'Haunt them' }).click();
  await expect(card).toBeHidden();
  await expect(page.getByText("👻 You're a ghost.", { exact: true })).toBeVisible();
  done = true;
  await Promise.all(loops);

  // Plant a mine through the board on a living sea; the server holds that very trick.
  const now = await read(page.request);
  const living = now.match.seats.map((x) => x.seat).find((x) => x !== me && !now.view.eliminated.includes(x))!;
  expect(living).toBeTruthy();
  await page.locator(`button.chip:not(.gone)[data-seat="${living}"]`).click();
  await expect(sea).toHaveAttribute('data-sea', living);
  await page.getByTestId('trick-mine').click();
  const cellEl = page.locator('[data-main] button[data-legal="true"]').first();
  const cell = (await cellEl.getAttribute('data-cell'))!;
  await cellEl.click();
  await page.getByTestId('play-trick').click();
  await expect
    .poll(async () => (await read(page.request)).view.myTricks?.pending, { timeout: 10_000 })
    .toEqual({ trick: 'mine', at: living, cell });

  // One living machine's shell lands on it; the rest finish their salvos; ghosts play a trick.
  // The reveal tells the trick: a Dirty trick! (open water) or a Backfire! (a ship was under it).
  let aimed = false;
  let over = false;
  const drive = async (a: { handle: string; headers: Record<string, string> }) => {
    while (!over) {
      const env = await read(page.request, a.headers);
      if (env.match.status === 'over') return;
      const mine = env.legal.find((l) => l.fire === 'shell' && l.at === living && l.cell === cell);
      const shells = env.legal.filter((l) => l.fire === 'shell');
      const tricks = env.legal.filter((l) => l.trick);
      let command: Legal | undefined;
      if (mine && !aimed) {
        aimed = true;
        command = mine;
      } else command = shells.length ? pick(shells.filter((l) => !(l.at === living && l.cell === cell)).concat(shells.length === 1 ? shells : [])) : tricks.find((l) => l.trick === 'splash') ?? tricks[0];
      if (env.match.status === 'live' && command) {
        await page.request.post(`/api/matches/${matchId}/move`, { headers: a.headers, data: { revision: env.match.revision, command } });
      } else {
        await page.request.get(`/api/matches/${matchId}?since=${env.match.revision}&waitMs=1000`, { headers: a.headers });
      }
    }
  };
  const drivers = agents.map(drive);
  await expect
    .poll(async () => (await page.getByTestId('banner').allTextContents()).some((t) => /^(Dirty trick!|Backfire!)/.test(t)), { timeout: 40_000, intervals: [100] })
    .toBe(true);
  over = true;
  await Promise.all(drivers);
});
