import { expect, test, type APIRequestContext } from '@playwright/test';
import { enter, newPlayer, randomTag } from './testing';

type Legal = { fire?: string; trick?: string; at?: string; cell?: string; place?: string };
type Envelope = {
  you: string | null;
  match: { status: string; revision: number; endReason: string | null; seats: { seat: string; identity: { handle: string } }[] };
  view: { phase: string; round: number; eliminated: string[]; ghosts?: string[]; targets: { sea: string }[]; myTricks?: { pending: { trick: string; at: string; cell: string } | null } | null; lastVolley?: { tricks?: { kind: string; ghost: string; sea: string; cell: string }[] } | null };
  legal: Legal[];
  recent?: { seat: string | null; text: string }[];
};

test('Salvo: a sunk fleet is stamped DEFEATED, your own sinking opens the ghost card, and a mine you plant reaches the server and is told', async ({ browser }) => {
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
  const myHandle = now.match.seats.find((x) => x.seat === me)!.identity.handle;
  const livingSeats = now.match.seats.map((x) => x.seat).filter((x) => x !== me && !now.view.eliminated.includes(x));
  // A living sea with a legal mine cell on the board (an unshot cell).
  const mineCells = page.locator('[data-main] button[data-legal="true"]');
  let living = '';
  for (const seat of livingSeats) {
    await page.locator(`button.chip:not(.gone)[data-seat="${seat}"]`).click();
    await expect(sea).toHaveAttribute('data-sea', seat);
    await page.getByTestId('trick-mine').click();
    if ((await mineCells.count()) > 0) {
      living = seat;
      break;
    }
  }
  expect(living, `no living sea offers a legal mine cell (living: ${livingSeats})`).not.toBe('');
  const cellEl = mineCells.first();
  const cell = (await cellEl.getAttribute('data-cell'))!;
  await cellEl.click();
  await page.getByTestId('play-trick').click();
  await expect
    .poll(async () => (await read(page.request)).view.myTricks?.pending, { timeout: 10_000 })
    .toEqual({ trick: 'mine', at: living, cell });

  // One living machine's shell lands on the mine; the rest finish their salvos; scripted ghosts play a splash or a mine elsewhere.
  let aimed = false;
  let over = false;
  const drive = async (a: { handle: string; headers: Record<string, string> }) => {
    while (!over) {
      const env = await read(page.request, a.headers);
      if (env.match.status === 'over') return;
      const shells = env.legal.filter((l) => l.fire === 'shell');
      const onMine = shells.find((l) => l.at === living && l.cell === cell);
      const elsewhere = shells.filter((l) => l !== onMine);
      let command: Legal | undefined;
      let isAim = false;
      if (onMine && !aimed) {
        command = onMine;
        isAim = true;
      } else if (shells.length) {
        command = pick(elsewhere.length ? elsewhere : shells);
      } else {
        // A ghost owes a trick: a false splash if one is legal, else a mine, never on the human's planted cell.
        const mines = env.legal.filter((l) => l.trick === 'mine' && !(l.at === living && l.cell === cell));
        command = env.legal.find((l) => l.trick === 'splash') ?? (mines.length ? pick(mines) : undefined);
      }
      if (env.match.status === 'live' && command) {
        const res = await page.request.post(`/api/matches/${matchId}/move`, { headers: a.headers, data: { revision: env.match.revision, command } });
        if (isAim && res.ok()) aimed = true;
      } else {
        await page.request.get(`/api/matches/${matchId}?since=${env.match.revision}&waitMs=1000`, { headers: a.headers });
      }
    }
  };
  const drivers = agents.map(drive);
  // The banner names the human's own mine, not a scripted ghost's.
  await expect
    .poll(async () => (await page.getByTestId('banner').allTextContents()).some((t) => /^(Dirty trick!|Backfire!)/.test(t) && t.includes(`${myHandle}'s mine`)), { timeout: 20_000, intervals: [100] })
    .toBe(true);
  const told = (await read(page.request)).view.lastVolley?.tricks ?? [];
  expect(told.some((t) => t.kind === 'mine' && t.ghost === me && t.sea === living && t.cell === cell), `the public record tells the planted mine: ${JSON.stringify(told)}`).toBe(true);
  over = true;
  await Promise.all(drivers);

  // A ghost can leave cleanly: Stop haunting asks first, then frees the seat while the others play on.
  const last = await read(page.request);
  if (last.match.status !== 'live' || !last.view.ghosts?.includes(me)) {
    test.info().annotations.push({ type: 'skipped', description: `Stop haunting not checked: the match is ${last.match.status}` });
    return;
  }
  expect((await (await page.request.get('/api/me')).json()).activeMatch).toBe(matchId);
  await page.getByRole('button', { name: 'Stop haunting', exact: true }).click();
  await expect(page.getByText('Stop haunting? Your ghost leaves the table; your place stands.')).toBeVisible();
  await page.getByRole('button', { name: 'Yes, stop haunting' }).click();
  await expect.poll(async () => (await (await page.request.get('/api/me')).json()).activeMatch, { timeout: 10_000 }).toBeNull();
  const gone = await read(page.request);
  expect(gone.view.ghosts).not.toContain(me);
  expect(gone.recent?.some((r) => r.seat === me && r.text === 'stops haunting')).toBe(true);
  await expect(page.getByRole('button', { name: 'Stop haunting', exact: true })).toHaveCount(0);
});
