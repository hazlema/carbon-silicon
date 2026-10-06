<script lang="ts">
  import { untrack } from 'svelte';
  import { buoyCells, cellIndex, cellName, hullCells, SHIPS, SIZE, type Facing, type SalvoCommand, type SalvoView, type ShipId, type TargetView } from '@cs/salvo';
  import type { TableColors } from '$lib/seats';
  import { clampTilt, DRAG_THRESHOLD, fitScale, nearestTurn } from '../critical-mass/iso';
  import { createSound } from '../critical-mass/sound';
  import { typing } from '../lightline/controls';
  import { incoming, planVolley, sideOf, type Side, type VolleyPlan } from './volley';

  let {
    view,
    interactive,
    legal,
    onMove,
    seats,
    you,
    fit = false,
  }: {
    view: SalvoView;
    /** Kept for the table page's call; Salvo draws people in their identity colours (orange carbon, cyan silicon). */
    colors?: TableColors;
    legal: unknown[];
    interactive: boolean;
    /** Called with ONE entry of `legal`, verbatim; a salvo awaits each before sending the next. */
    onMove: (cmd: unknown) => void | Promise<void>;
    /** The match's seats, for names. */
    seats: { seat: string; identity: { handle: string; kind: string } }[];
    you: string | null;
    /** A phone's table: open in the Top view and fill the stage. */
    fit?: boolean;
  } = $props();

  /** The resting isometric view, and the flat one. */
  const ISO = { spin: -28, tilt: 48 };
  const TOP = { spin: 0, tilt: 0 };
  /** The cell size `fitScale` is asked about; the fit's scale turns it into real pixels. */
  const REF = 60;
  /** The coordinate gutter beside the big sea, as a share of a cell. */
  const GUTTER = 0.42;
  const LETTERS = 'abcdefgh';
  /** Cells in DOM order: row 8 first, column a on the left (a1 bottom-left). */
  const ORDER = Array.from({ length: SIZE * SIZE }, (_, k) => cellName((SIZE - 1 - Math.floor(k / SIZE)) * SIZE + (k % SIZE)));

  const me = $derived(view.you ?? you);
  const side = (seat: string) => sideOf(seat, me);
  const handleOf = (seat: string) => seats.find((s) => s.seat === seat)?.identity.handle ?? seat;
  const humanSeat = (seat: string) => seats.find((s) => s.seat === seat)?.identity.kind === 'human';
  /** A person is orange, a machine cyan, wherever they appear on the board. */
  const kindColor = (seat: string) => (humanSeat(seat) ? 'var(--carbon)' : 'var(--silicon)');
  const live = $derived(view.phase !== 'over');
  const out = (seat: string) => view.eliminated.includes(seat);
  const amOut = $derived(!!me && out(me));
  const names = (list: string[]) => (list.length <= 1 ? list.join('') : `${list.slice(0, -1).join(', ')} and ${list.at(-1)}`);

  // ── What `legal` offers ──
  type FireCmd = Extract<SalvoCommand, { fire: 'shell' }>;
  type BuoyCmd = Extract<SalvoCommand, { fire: 'buoy' }>;
  type PlaceCmd = Extract<SalvoCommand, { place: ShipId }>;
  const isFire = (l: unknown): l is FireCmd => typeof l === 'object' && l !== null && (l as FireCmd).fire === 'shell';
  const isBuoy = (l: unknown): l is BuoyCmd => typeof l === 'object' && l !== null && (l as BuoyCmd).fire === 'buoy';
  const isPlace = (l: unknown): l is PlaceCmd => typeof l === 'object' && l !== null && typeof (l as PlaceCmd).at === 'string' && 'place' in l;
  const randomCmd = $derived(legal.find((l) => typeof l === 'object' && l !== null && (l as { place?: unknown }).place === 'random'));

  // ── Which sea is big ──
  const deploying = $derived(view.phase === 'deploy' && !!view.mySea && !amOut);
  let picked = $state<string | null>(null);
  const target = $derived(view.targets.find((t) => t.sea === picked) ?? view.targets[0] ?? null);
  const targetSea = $derived(target?.sea ?? null);
  const fireCells = $derived(new Set(legal.filter(isFire).filter((l) => l.at === targetSea).map((l) => l.cell)));
  /** The centres a sonar buoy may still go on the shown sea (b2..g7, once each). */
  const buoyCentres = $derived(new Set(legal.filter(isBuoy).filter((l) => l.at === targetSea).map((l) => l.cell)));
  /** Everyone at the table but you, in seat order: the seas you can aim at (or, watching, every fleet). */
  const others = $derived(view.seats.filter((s) => s !== me));

  // ── Fire: a salvo, one shot per ship afloat. Clicks toggle aims (on any sea); Fire (or Enter on an aim) sends them, one move each ──
  type Kind = 'shell' | 'buoy';
  interface Aim {
    fire: Kind;
    at: string;
    cell: string;
  }
  let kind = $state<Kind>('shell');
  let aims = $state<Aim[]>([]);
  /** Aims going out right now (each is its own move, awaited in turn). */
  let sending = $state(false);
  /** The cell under the pointer while aiming a buoy, for its footprint. */
  let aimHover = $state<string | null>(null);
  const round = $derived(view.round);
  const iAmReady = $derived(!!me && view.ready.includes(me));
  /** Shots this round (one per ship afloat), the ones already away, and the room left to aim. */
  const guns = $derived(me ? (view.guns?.[me] ?? 0) : 0);
  const sent = $derived(view.myOrders ?? []);
  const room = $derived(Math.max(0, guns - sent.length - aims.length));
  /** One sonar buoy a round: aimed or already away, the toggle greys out. */
  const buoyAimed = $derived(aims.some((a) => a.fire === 'buoy'));
  const buoyUsed = $derived(buoyAimed || sent.some((o) => o.fire === 'buoy'));
  const buoysLegal = $derived(legal.some(isBuoy));
  const aimKind = $derived<Kind>(buoysLegal && !buoyUsed ? kind : 'shell');
  // A new round clears the aims and goes back to shells.
  $effect(() => {
    void round;
    aims = [];
    kind = 'shell';
  });
  const aimable = (k: Kind, cell: string) => (k === 'buoy' ? buoyCentres.has(cell) : fireCells.has(cell));
  const aimAt = (sea: string | null, cell: string, k?: Kind) => aims.find((a) => a.at === sea && a.cell === cell && (!k || a.fire === k));
  const sentAt = (sea: string | null, cell: string) => sent.find((o) => o.fire === 'shell' && o.at === sea && o.cell === cell);
  /** The aims on the shown sea, and how many each other sea has. */
  const aimsHere = $derived(aims.filter((a) => a.at === targetSea));
  const aimedOn = (sea: string) => aims.filter((a) => a.at === sea).length;
  const setKind = (k: Kind) => (kind = k);
  /** Click a cell: take back an aim there (the buoy's first), or add one if there's a gun free. A buoy moves rather than doubling. */
  function toggle(cell: string) {
    if (!targetSea) return;
    const sea = targetSea;
    const buoy = aimAt(sea, cell, 'buoy');
    if (buoy) {
      aims = aims.filter((a) => a !== buoy);
      return;
    }
    if (aimKind === 'buoy') {
      if (!buoyCentres.has(cell)) return;
      const other = aims.find((a) => a.fire === 'buoy');
      if (!other && room === 0) return;
      aims = [...aims.filter((a) => a !== other), { fire: 'buoy', at: sea, cell }];
      // One buoy a round: once it's down, the rest of the salvo is shells.
      kind = 'shell';
      return;
    }
    const shell = aimAt(sea, cell, 'shell');
    if (shell) aims = aims.filter((a) => a !== shell);
    else if (room > 0 && fireCells.has(cell)) aims = [...aims, { fire: 'shell', at: sea, cell }];
  }
  /** The entry of `legal` an aim stands for, if it's still on offer. */
  const commandOf = (a: Aim) => legal.find((l) => (a.fire === 'buoy' ? isBuoy(l) : isFire(l)) && (l as FireCmd).at === a.at && (l as FireCmd).cell === a.cell);
  /** Send the salvo: one move per aim, in order, each awaited (the page takes one move at a time). Stops if one doesn't land. */
  async function fire() {
    if (!interactive || sending || aims.length === 0) return;
    sending = true;
    sound?.clink();
    const at = round;
    try {
      for (const a of [...aims]) {
        if (view.round !== at) break;
        const cmd = commandOf(a);
        if (!cmd) {
          aims = aims.filter((x) => x !== a);
          continue;
        }
        const before = view.myOrders?.length ?? 0;
        await onMove($state.snapshot(cmd));
        if (view.round !== at) break;
        if ((view.myOrders?.length ?? 0) <= before) break;
        aims = aims.filter((x) => x !== a);
      }
    } finally {
      sending = false;
    }
  }
  /** The buoy footprints on the shown sea: the one sent, the one aimed, and where the pointer is. */
  const buoyPreview = $derived.by(() => {
    const out: { cell: string; picked: boolean; sent: boolean }[] = [];
    for (const o of sent) if (o.fire === 'buoy' && o.at === targetSea) out.push({ cell: o.cell, picked: true, sent: true });
    for (const a of aimsHere) if (a.fire === 'buoy') out.push({ cell: a.cell, picked: true, sent: false });
    if (!iAmReady && aimKind === 'buoy' && aimHover && buoyCentres.has(aimHover) && !out.some((b) => b.cell === aimHover))
      out.push({ cell: aimHover, picked: false, sent: false });
    return out;
  });
  const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  /** What the fire button says: "Fire 3 shells", "Fire 2 shells + buoy", "Drop buoy", or "Fire 2 of 4" for part of a salvo. */
  const fireLabel = $derived.by(() => {
    const shells = aims.filter((a) => a.fire === 'shell').length;
    const owed = guns - sent.length;
    if (aims.length < owed) return `Fire ${aims.length} of ${owed}`;
    if (!buoyAimed) return `Fire ${plural(shells, 'shell')}`;
    return shells ? `Fire ${plural(shells, 'shell')} + buoy` : 'Drop buoy';
  });
  /** What went out this round, for the locked-in line. */
  const sentText = $derived.by(() => {
    const shells = sent.filter((o) => o.fire === 'shell').length;
    const buoy = sent.some((o) => o.fire === 'buoy');
    return shells && buoy ? `${plural(shells, 'shell')} + buoy away` : buoy ? 'Buoy away' : `${plural(shells, 'shell')} away`;
  });

  // ── Deploy: pick a ship, R rotates, click a cell; Random for the lot ──
  let shipPick = $state<ShipId | null>(null);
  let facing = $state<Facing>('east');
  let hover = $state<string | null>(null);
  const port = $derived(view.mySea?.port ?? []);
  const ship = $derived(shipPick && port.includes(shipPick) ? shipPick : (port[0] ?? null));
  const lengthOf = (id: ShipId) => SHIPS.find((x) => x.id === id)?.length ?? 0;
  const placeable = $derived(new Set(legal.filter(isPlace).filter((l) => l.place === ship && l.facing === facing).map((l) => l.at)));
  const preview = $derived.by(() => {
    if (!deploying || !ship || !hover || !interactive) return null;
    const cells = hullCells(hover, lengthOf(ship), facing);
    return { cells: new Set(cells ?? [hover]), ok: !!cells && placeable.has(hover) };
  });
  function place(cell: string) {
    if (!interactive || !ship) return;
    const cmd = legal.filter(isPlace).find((l) => l.place === ship && l.at === cell && l.facing === facing);
    if (cmd) onMove($state.snapshot(cmd));
  }
  function deployRandom() {
    if (interactive && randomCmd) onMove($state.snapshot(randomCmd));
  }
  const rotate = () => (facing = facing === 'east' ? 'north' : 'east');
  $effect(() => {
    if (!deploying) return;
    const key = (e: KeyboardEvent) => {
      if ((e.key === 'r' || e.key === 'R') && !e.ctrlKey && !e.metaKey && !e.altKey && !typing(e.target)) rotate();
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  });

  // ── What each cell shows ──
  type Mark = 'sea' | 'miss' | 'hit' | 'sunk' | 'ship';
  interface Hull {
    /** Sides (l r t b) where the hull runs on into the next cell. */
    joins: string;
    wreck: boolean;
    faint: boolean;
  }
  interface CellModel {
    mark: Mark;
    ship: ShipId | null;
    hull: Hull | null;
  }
  const SEA: CellModel = { mark: 'sea', ship: null, hull: null };

  /** For each hull cell, the screen sides where the hull continues (rows grow upward). */
  function joinsOf(cells: string[]): Map<string, string> {
    const at = cells.map((c) => cellIndex(c) ?? 0);
    return new Map(
      cells.map((c, i) => {
        const sides: string[] = [];
        for (const j of [i - 1, i + 1]) {
          if (j < 0 || j >= cells.length) continue;
          const d = at[j] - at[i];
          sides.push(d === 1 ? 'r' : d === -1 ? 'l' : d === SIZE ? 't' : 'b');
        }
        return [c, sides.join(' ')];
      }),
    );
  }

  function ownModel(m: NonNullable<SalvoView['mySea']>): Map<string, CellModel> {
    const cells = new Map<string, CellModel>();
    for (const [c, r] of Object.entries(m.shots)) if (r === 'miss') cells.set(c, { ...SEA, mark: 'miss' });
    for (const s of m.ships) {
      const sunk = s.cells.length > 0 && s.hits.length === s.cells.length;
      const joins = joinsOf(s.cells);
      for (const c of s.cells) {
        const mark: Mark = sunk ? 'sunk' : s.hits.includes(c) ? 'hit' : 'ship';
        cells.set(c, { mark, ship: s.id, hull: { joins: joins.get(c) ?? '', wreck: sunk, faint: false } });
      }
    }
    return cells;
  }

  function targetModel(t: TargetView): Map<string, CellModel> {
    const cells = new Map<string, CellModel>();
    for (const s of t.revealed ?? []) {
      const joins = joinsOf(s.cells);
      for (const c of s.cells) cells.set(c, { mark: 'ship', ship: s.id, hull: { joins: joins.get(c) ?? '', wreck: false, faint: true } });
    }
    for (const c of t.misses) cells.set(c, { ...SEA, mark: 'miss' });
    for (const c of t.hits) cells.set(c, { ...(cells.get(c) ?? SEA), mark: 'hit' });
    for (const s of t.sunk) {
      const joins = joinsOf(s.cells);
      for (const c of s.cells) cells.set(c, { mark: 'sunk', ship: s.ship, hull: { joins: joins.get(c) ?? '', wreck: true, faint: false } });
    }
    return cells;
  }

  function label(cell: string, m: CellModel, own: boolean): string {
    switch (m.mark) {
      case 'miss':
        return `${cell}, miss`;
      case 'hit':
        return own && m.ship ? `${cell}, ${m.ship}, hit` : `${cell}, hit`;
      case 'sunk':
        return `${cell}, sunk ${m.ship}`;
      case 'ship':
        return `${cell}, ${m.ship}`;
      default:
        return cell;
    }
  }

  const ownCells = $derived(view.mySea ? ownModel(view.mySea) : null);
  const targetCells = $derived(target ? targetModel(target) : null);
  /** The shown sea's lifted rows: row → ship cells still afloat in it (a count, never where). */
  const liftedHere = $derived(new Map((deploying ? [] : (target?.lifted ?? [])).map((x) => [x.row, x.afloat])));
  /** Your sonar readings on the shown sea, by centre cell. */
  const sonarHere = $derived(deploying ? [] : (target?.sonar ?? []));
  const sonarAt = $derived(new Map(sonarHere.map((x) => [x.cell, x])));
  const afloatOf = (seat: string): number => {
    if (seat === me && view.mySea) return view.mySea.ships.reduce((n, s) => n + s.cells.length - s.hits.length, 0);
    return view.targets.find((t) => t.sea === seat)?.afloat ?? 0;
  };

  // ── Incoming fire ──
  const reduced = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  let plan = $state<VolleyPlan | null>(null);
  let planKey = $state(0);
  let clearFx: ReturnType<typeof setTimeout> | undefined;
  const volleyRound = $derived(view.lastVolley?.round ?? null);
  let seen: number | null | undefined;
  // A new volley: play it (skipped on first paint, so a reload doesn't replay the last round).
  $effect(() => {
    const r = volleyRound;
    if (seen === undefined || r === null || r === seen) {
      seen = r;
      return;
    }
    seen = r;
    untrack(() => {
      const v = $state.snapshot(view.lastVolley);
      if (!v) return;
      // A seat whose fleet was afloat for this volley gets the warning, and its own shells last.
      const atSea = !!me && !!view.mySea && (!out(me) || v.eliminated.includes(me));
      const p = planVolley(v, (s) => sideOf(s, me), { reducedMotion: reduced, you: atSea ? me : null });
      plan = p;
      planKey += 1;
      playVolley(p);
      clearTimeout(clearFx);
      clearFx = setTimeout(() => (plan = null), p.total + 3000);
      // The warning hangs there until the first shell at you lands (and is long enough to read with no motion at all).
      const firstAtYou = Math.min(...p.shells.filter((x) => x.sea === me).map((x) => x.landAt));
      const warnFor = !atSea ? 0 : reduced ? 2500 : Number.isFinite(firstAtYou) ? firstAtYou : p.lead + 900;
      if (atSea && me) {
        const { count, from, buoys } = incoming(v, me);
        const sonar = buoys === 1 ? '1 sonar buoy' : `${buoys} sonar buoys`;
        announce(
          count > 0
            ? { tone: 'hot', text: `⚠ ${count} ${count === 1 ? 'shell' : 'shells'} incoming on your sea — from ${names(from.map(handleOf))}${buoys ? ` · ${sonar}` : ''}` }
            : buoys > 0
              ? { tone: 'calm', text: `No shells at you — but ${buoys === 1 ? 'a sonar buoy' : sonar} splashed down nearby.` }
              : { tone: 'calm', text: 'Quiet waters: nothing aimed at you this round.' },
          0,
          warnFor,
        );
      }
      openRound(Math.max(p.total, warnFor) + 400);
    });
  });
  $effect(() => () => clearTimeout(clearFx));

  // ── Banners: the warning before a volley, and the call to fire when a round opens ──
  type Banner = { tone: 'hot' | 'calm' | 'go'; text: string };
  let banner = $state<Banner | null>(null);
  let bannerKey = $state(0);
  const bannerTimers: ReturnType<typeof setTimeout>[] = [];
  function announce(b: Banner, afterMs: number, forMs: number) {
    let mine = -1;
    bannerTimers.push(
      setTimeout(() => {
        banner = b;
        mine = bannerKey += 1;
        if (b.tone === 'hot') sound?.pop(-7);
      }, afterMs),
      // Only its own banner: a later one may have taken its place.
      setTimeout(() => {
        if (bannerKey === mine) banner = null;
      }, afterMs + forMs),
    );
  }
  /** "Round 7 — fire!" once the volley has played out (if the match goes on and you're still afloat). */
  function openRound(afterMs: number) {
    bannerTimers.push(
      setTimeout(() => {
        if (view.phase !== 'fire') return;
        announce({ tone: 'go', text: me && !out(me) ? `Round ${view.round} — fire!` : `Round ${view.round}` }, 0, 1600);
      }, afterMs),
    );
  }
  $effect(() => () => bannerTimers.forEach(clearTimeout));
  // Deployment ending opens round 1 with no volley before it.
  let seenPhase: string | undefined;
  $effect(() => {
    const phase = view.phase;
    if (seenPhase === 'deploy' && phase === 'fire') untrack(() => openRound(0));
    seenPhase = phase;
  });

  // ── Locking in: a clink for every other seat that commits (not on first paint) ──
  let seenReady: Set<string> | undefined;
  $effect(() => {
    const now = new Set(view.ready);
    const before = seenReady;
    seenReady = now;
    if (!before) return;
    if ([...now].some((x) => !before.has(x) && x !== me)) untrack(() => sound?.clink());
  });
  /** When each cell's new result shows: as its shell lands, or with the flash that took it. */
  const landing = $derived.by(() => {
    const at = new Map<string, number>();
    if (!plan) return at;
    for (const f of plan.flashes) for (const c of f.cells) at.set(`${f.sea} ${c}`, f.at);
    for (const s of plan.shells) if (!at.has(`${s.sea} ${s.cell}`)) at.set(`${s.sea} ${s.cell}`, s.landAt);
    return at;
  });
  const sinkingAt = (sea: string, shipId: ShipId | null) => plan?.sinkings.find((x) => x.sea === sea && x.ship === shipId)?.at;

  const sound = typeof window === 'undefined' ? null : createSound('salvo_sound');
  let soundOn = $state(sound?.enabled ?? false);
  $effect(() => () => sound?.close());
  function playVolley(p: VolleyPlan) {
    if (!sound?.enabled) return;
    for (const s of p.shells) {
      if (s.blast) continue;
      if (s.result === 'miss') sound.pop(0, s.landAt / 1000);
      else sound.thud(s.landAt / 1000);
    }
    for (const f of p.flashes) {
      sound.thud(f.at / 1000);
      sound.thud(f.at / 1000 + 0.09);
      sound.pop(12, f.at / 1000);
    }
    for (const k of p.sinkings) sound.thud(k.at / 1000 + 0.25);
    for (const b of p.buoys) sound.pop(9, b.at / 1000);
  }

  /** Where a shell starts, in cells from its target, by the side it comes from. */
  const FROM: Record<Side, [number, number]> = { north: [0, -6], south: [0, 6], west: [-6, 0], east: [6, 0] };
  const centre = (cell: string, size: number, gutter: number) => {
    const i = cellIndex(cell) ?? 0;
    return { x: gutter + (i % SIZE) * size + size / 2, y: (SIZE - 1 - Math.floor(i / SIZE)) * size + size / 2 };
  };

  // ── The camera: drag to swivel, or the pill's turns and views (a phone's table opens flat) ──
  const narrowAtStart = typeof window !== 'undefined' && window.innerWidth <= 700;
  const first = untrack(() => fit) || narrowAtStart ? TOP : ISO;
  let spin = $state(first.spin);
  let tilt = $state(first.tilt);
  /** The angle the fit is computed for: only updated at rest, so the sea doesn't breathe while you drag. */
  let rest = $state({ spin: first.spin, tilt: first.tilt });
  let drag: { x: number; y: number; spin: number; tilt: number; touch: boolean; moved: boolean } | null = null;
  let dragging = $state(false);
  /** Set for the click that ends a swivel, so it never aims or places. */
  let suppress = false;
  function aimCamera(next: { spin: number; tilt: number }) {
    spin = nearestTurn(spin, next.spin);
    tilt = clampTilt(next.tilt);
    rest = { spin, tilt };
  }
  const turn = (by: number) => aimCamera({ spin: spin + by, tilt });
  // Becoming a phone's table (a rotation, a narrowed window): the flat Top view keeps the cells big enough to tap.
  $effect(() => {
    if (fit) untrack(() => aimCamera({ spin: nearestTurn(spin, 0), tilt: 0 }));
  });
  const turnsFrom360 = (a: number, b: number) => (((a - b) % 360) + 360) % 360 === 0;
  const isView = (v: { spin: number; tilt: number }) => rest.tilt === v.tilt && turnsFrom360(rest.spin, v.spin);
  function down(e: PointerEvent) {
    if (e.button !== 0 || (e.target as Element).closest('.pill')) return;
    drag = { x: e.clientX, y: e.clientY, spin, tilt, touch: e.pointerType === 'touch', moved: false };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
  }
  function move(e: PointerEvent) {
    if (!drag) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    // Touch swivels only sideways: up and down stay with the page's scroll.
    if (!drag.moved && Math.abs(dx) + (drag.touch ? 0 : Math.abs(dy)) > DRAG_THRESHOLD) {
      drag.moved = true;
      dragging = true;
    }
    if (!drag.moved) return;
    // The sea's near edge follows the pointer, like turning a lazy Susan by its front rim.
    spin = drag.spin - dx * 0.4;
    if (!drag.touch) tilt = clampTilt(drag.tilt - dy * 0.3);
  }
  function up() {
    if (drag?.moved) {
      suppress = true;
      setTimeout(() => (suppress = false), 0);
      rest = { spin, tilt };
    }
    cancel();
  }
  function cancel() {
    drag = null;
    dragging = false;
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', cancel);
  }
  $effect(() => cancel);

  // ── Sizes: the big sea fits its stage at rest; your fleet fits its panel ──
  let rootEl: HTMLDivElement | undefined = $state();
  let rootBox = $state({ w: 0, h: 0 });
  let stageEl: HTMLDivElement | undefined = $state();
  let ownEl: HTMLElement | undefined = $state();
  let stageBox = $state({ w: 0, h: 0 });
  let ownBox = $state({ w: 0, h: 0 });
  function observe(el: HTMLElement | undefined, set: (r: DOMRectReadOnly) => void) {
    if (!el) return;
    const ro = new ResizeObserver(([e]) => set(e.contentRect));
    ro.observe(el);
    return () => ro.disconnect();
  }
  $effect(() => observe(rootEl, (r) => (rootBox = { w: r.width, h: r.height })));
  $effect(() => observe(stageEl, (r) => (stageBox = { w: r.width, h: r.height })));
  /** The wide layout (the same test as the container query below): your fleet sits in a column, sized by its width. */
  const wide = $derived(rootBox.w >= 640 && rootBox.w >= rootBox.h * 1.2);
  $effect(() => observe(ownEl, (r) => (ownBox = { w: r.width, h: r.height })));
  /** The big sea's own padding round its cells (see `.main .face`). */
  const FACE_PAD = 20;
  /** Room left of the row labels for the fog's counts, as a share of a cell (only once rows have lifted). */
  const FOG_GUTTER = 0.5;
  const fogOn = $derived(liftedHere.size > 0);
  const span = $derived(SIZE + GUTTER + (fogOn ? FOG_GUTTER : 0));
  const mainCell = $derived.by(() => {
    // The stage's content box: its padding already keeps the caption and the pill clear.
    const { w, h } = stageBox;
    if (!w || !h) return 40;
    const room = { w: w - FACE_PAD, h: h - FACE_PAD };
    if (rest.tilt === 0 && turnsFrom360(rest.spin, 0)) return Math.max(16, Math.floor(Math.min(room.w, room.h) / span));
    return Math.max(16, Math.floor(REF * fitScale({ w: span * REF, h: span * REF }, room, rest.spin, rest.tilt, 0)));
  });
  /** Your fleet fills the room its section has (the section's height, less the heading and the legend). */
  const ownCell = $derived(Math.max(12, Math.min(34, Math.floor(((wide ? ownBox.w : Math.min(ownBox.w, ownBox.h - 52)) - 14) / SIZE) || 24)));

  /** Arrow keys move focus within a sea; every cell is focusable, enabled or not. */
  function step(e: KeyboardEvent, k: number) {
    const d = ({ ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] } as Record<string, [number, number]>)[e.key];
    if (!d) return;
    e.preventDefault();
    const col = Math.min(SIZE - 1, Math.max(0, (k % SIZE) + d[0]));
    const row = Math.min(SIZE - 1, Math.max(0, Math.floor(k / SIZE) + d[1]));
    const face = (e.currentTarget as HTMLElement).parentElement;
    face?.querySelectorAll<HTMLElement>(':scope > button')[row * SIZE + col]?.focus();
  }

  type Mode = 'fire' | 'deploy' | 'view';
  /** A fire cell takes a click if it holds an aim (to take it back), or is legal and a gun is free (a buoy can always move). */
  const fireable = (cell: string) =>
    !sending && (!!aimAt(targetSea, cell) || (aimable(aimKind, cell) && (room > 0 || (aimKind === 'buoy' && buoyAimed))));
  const enabled = (mode: Mode, cell: string) =>
    interactive && (mode === 'fire' ? fireable(cell) : mode === 'deploy' ? placeable.has(cell) : false);
  function press(mode: Mode, cell: string) {
    if (suppress || !enabled(mode, cell)) return;
    if (mode === 'fire') toggle(cell);
    else if (mode === 'deploy') place(cell);
  }
  function keydown(e: KeyboardEvent, mode: Mode, cell: string, k: number) {
    if (e.key === 'Enter' && mode === 'fire' && aimAt(targetSea, cell)) {
      e.preventDefault();
      void fire();
      return;
    }
    step(e, k);
  }

  /** The living seats still owing this round, besides you. */
  const waitingFor = $derived(view.seats.filter((s) => s !== me && !out(s) && !view.ready.includes(s)).map(handleOf));
  /** The one seat everybody is waiting on, when it comes to that. */
  const holdout = $derived.by(() => {
    const living = view.seats.filter((s) => !out(s));
    const owing = living.filter((s) => !view.ready.includes(s));
    return live && living.length > 1 && owing.length === 1 ? owing[0] : null;
  });
  const stateOf = (seat: string) =>
    out(seat) ? 'out' : view.winner === seat ? 'winner' : !live ? '' : view.ready.includes(seat) ? (view.phase === 'deploy' ? 'deployed' : 'locked') : view.phase === 'deploy' ? 'deploying' : 'aiming';
  const STATE_TEXT: Record<string, string> = { locked: 'locked in', out: 'sunk' };
  const mainSea = $derived(deploying ? me : targetSea);
</script>

{#snippet sea(seat: string, model: Map<string, CellModel>, size: number, main: boolean, mode: Mode, own: boolean)}
  {@const g = main ? Math.round(size * GUTTER) : 0}
  {@const intel = main && !own}
  {@const fp = intel && fogOn ? Math.round(size * FOG_GUTTER) : 0}
  <div
    class="sea3d"
    class:main
    class:own
    style:--cell="{size}px"
    style:--g="{g}px"
    style:--fp="{fp}px"
    style:--spin="{main ? spin : 0}deg"
    style:--tilt="{main ? tilt : 0}deg"
  >
    <div class="slab" class:still={dragging} style:transform={main ? `rotateX(${tilt}deg) rotateZ(${spin}deg)` : 'none'}>
      {#if main}<div class="under" aria-hidden="true"></div>{/if}
      <div
        class="face"
        role="group"
        aria-label={own ? 'Your sea' : `${handleOf(seat)}'s sea`}
        data-sea={seat}
        data-main={main ? '' : undefined}
        data-mode={mode}
      >
        {#if main}<i class="edge s" aria-hidden="true"></i><i class="edge e" aria-hidden="true"></i><i class="edge n" aria-hidden="true"></i><i class="edge w" aria-hidden="true"></i>{/if}
        {#each ORDER as cell, k (cell)}
          {@const m = model.get(cell) ?? SEA}
          {@const ok = enabled(mode, cell)}
          {@const land = landing.get(`${seat} ${cell}`)}
          {@const sinking = m.mark === 'sunk' ? sinkingAt(seat, m.ship) : undefined}
          {@const ghost = mode === 'deploy' && preview?.cells.has(cell)}
          {@const reading = intel ? sonarAt.get(cell) : undefined}
          {#if main && k % SIZE === 0}<span class="tag row" aria-hidden="true">{SIZE - Math.floor(k / SIZE)}</span>{/if}
          <button
            type="button"
            data-cell={cell}
            data-mark={m.mark}
            aria-label={label(cell, m, own) + (reading ? `, sonar buoy: ${reading.afloat} afloat around it` : '')}
            aria-disabled={!ok}
            aria-pressed={mode === 'fire' ? !!aimAt(seat, cell) : undefined}
            onclick={() => press(mode, cell)}
            onkeydown={(e) => keydown(e, mode, cell, k)}
            onpointerenter={() => (mode === 'deploy' ? (hover = cell) : mode === 'fire' && (aimHover = cell))}
            onpointerleave={() => (mode === 'deploy' ? hover === cell && (hover = null) : aimHover === cell && (aimHover = null))}
            onfocus={() => (mode === 'deploy' ? (hover = cell) : mode === 'fire' && (aimHover = cell))}
            onblur={() => mode === 'fire' && aimHover === cell && (aimHover = null)}
          >
            <span class="water" class:up={intel && liftedHere.has(Number(cell.slice(1)))}></span>
            {#if m.hull}
              {@const j = m.hull.joins}
              <span
                class="hull"
                class:wreck={m.hull.wreck}
                class:faint={m.hull.faint}
                class:jl={j.includes('l')}
                class:jr={j.includes('r')}
                class:jt={j.includes('t')}
                class:jb={j.includes('b')}
              ></span>
            {/if}
            {#if m.mark === 'miss'}<span class="ripple" class:land={land !== undefined} style:--d="{land ?? 0}ms"><i></i></span>{/if}
            {#if m.mark === 'hit' || m.mark === 'sunk'}
              <span class="glow" class:land={land !== undefined} style:--d="{land ?? 0}ms"></span>
            {/if}
            {#if sinking !== undefined}
              <span class="bubbles" style:--d="{sinking}ms"><i></i><i></i><i></i></span>
            {/if}
            {#if ghost}<span class="ghost" class:bad={!preview?.ok}></span>{/if}
            {#if mode === 'fire' && aimAt(seat, cell, 'shell')}<span class="reticle"></span>
            {:else if mode === 'fire' && aimAt(seat, cell, 'buoy')}<span class="reticle buoy"></span>
            {:else if mode === 'fire' && sentAt(seat, cell)}<span class="reticle sent" data-testid="sent"></span>{/if}
          </button>
        {/each}
        {#if main}
          <span class="tag corner" aria-hidden="true"></span>
          {#each LETTERS as letter (letter)}<span class="tag col" aria-hidden="true">{letter}</span>{/each}
        {/if}
        {#if intel}
          <!-- What you know without seeing: the fog's counts by the row labels, sonar footprints, a buoy's aim. Flat on the water. -->
          <div class="marks" aria-hidden="true">
            {#each [...liftedHere] as [row, n] (row)}
              <span class="fogn" class:none={n === 0} data-testid="fog-count" data-row={row} style:left="{-fp / 2}px" style:top="{(SIZE - row) * size + size / 2}px">{n}</span>
            {/each}
            {#each sonarHere as r, n (r.cell)}
              {@const c = centre(r.cell, size, g)}
              <span class="foot" class:newest={n === sonarHere.length - 1} class:none={r.afloat === 0} style:left="{c.x}px" style:top="{c.y}px"></span>
            {/each}
            {#each mode === 'fire' ? buoyPreview : [] as b (b.cell)}
              {@const c = centre(b.cell, size, g)}
              <span class="foot aim" class:picked={b.picked} class:sent={b.sent} style:left="{c.x}px" style:top="{c.y}px"></span>
            {/each}
          </div>
        {/if}
        <!-- Pegs stand up out of the water in their own layer: inside a cell's button they'd be clipped to it. -->
        <div class="pegs" aria-hidden="true">
          {#each ORDER as cell (cell)}
            {@const m = model.get(cell) ?? SEA}
            {#if m.mark === 'hit' || m.mark === 'sunk'}
              {@const c = centre(cell, size, g)}
              {@const land = landing.get(`${seat} ${cell}`)}
              <span class="peg" class:sunk={m.mark === 'sunk'} style:left="{c.x}px" style:top="{c.y}px"
                ><span class="bb"><i class:land={land !== undefined} style:--d="{land ?? 0}ms"></i></span></span
              >
            {/if}
          {/each}
          <!-- A sonar reading's count floats over its centre, facing you at any tilt. -->
          {#each intel ? sonarHere : [] as r, n (r.cell)}
            {@const c = centre(r.cell, size, g)}
            {@const drop = plan?.round === r.round ? plan.buoys.find((b) => b.sea === seat && b.cell === r.cell) : undefined}
            <span class="sonar" class:newest={n === sonarHere.length - 1} class:none={r.afloat === 0} style:left="{c.x}px" style:top="{c.y}px"
              ><span class="bb"><b data-testid="sonar" data-at={r.cell} class:land={!!drop} style:--d="{(drop?.at ?? 0) + 500}ms">{r.afloat}</b></span></span
            >
          {/each}
        </div>
        {#if plan && !reduced}
          {#key planKey}
            <div class="fx" aria-hidden="true">
              {#each plan.buoys.filter((b) => b.sea === seat) as b, n (n)}
                {@const c = centre(b.cell, size, g)}
                <i class="ping" style:left="{c.x}px" style:top="{c.y}px" style:--d="{b.at}ms" style:--c={kindColor(b.from)}></i>
              {/each}
              {#each plan.flashes.filter((f) => f.sea === seat) as f, n (n)}
                {@const c = centre(f.cell, size, g)}
                <i class="flash" style:left="{c.x}px" style:top="{c.y}px" style:--d="{f.at}ms"></i>
              {/each}
              {#each plan.shells.filter((s) => s.sea === seat) as s, n (n)}
                {@const c = centre(s.cell, size, g)}
                {@const [fx, fy] = FROM[s.side]}
                <span
                  class="shell"
                  style:left="{c.x}px"
                  style:top="{c.y}px"
                  style:--sx="{fx * size}px"
                  style:--sy="{fy * size}px"
                  style:--fly="{s.flightMs}ms"
                  style:--d="{s.delay}ms"
                  style:--c={kindColor(s.from)}
                >
                  <i class="shade"></i>
                  <span class="arc"><span class="bb"><i class="ball"></i></span></span>
                </span>
              {/each}
            </div>
          {/key}
        {/if}
      </div>
    </div>
  </div>
{/snippet}

{#snippet mini(t: TargetView)}
  {@const model = targetModel(t)}
  {@const n = aimedOn(t.sea)}
  <span class="mini" data-mini={t.sea} aria-hidden="true">
    {#each ORDER as cell (cell)}
      {@const m = model.get(cell) ?? SEA}
      {@const land = landing.get(`${t.sea} ${cell}`)}
      <i
        class="m-{m.mark}"
        class:m-aim={!!aimAt(t.sea, cell)}
        class:m-out={!!sent.find((o) => o.at === t.sea && o.cell === cell)}
        class:land={land !== undefined}
        style:--d="{land ?? 0}ms"
      ></i>
    {/each}
    {#if n > 0}<b class="aimed" data-testid="aimed">{n}</b>{/if}
  </span>
{/snippet}

<div class="salvo" class:fit class:deploying bind:this={rootEl}>
  <div class="banners" aria-live="polite">
    {#if banner}
      {#key bannerKey}
        <p class="banner {banner.tone}" data-testid="banner">{banner.text}</p>
      {/key}
    {/if}
  </div>

  <div class="layout">
  <div class="stage" class:dragging bind:this={stageEl} onpointerdown={down} role="presentation">
    {#if mainSea}
      <p class="caption">
        {#if deploying}
          <span class="kicker">Your sea</span><span class="sub">place your fleet</span>
        {:else}
          <span class="kicker">{mainSea === me ? 'Your sea' : 'Target'}</span>
          {#if mainSea !== me}<span class="who-big" style:color={kindColor(mainSea)}>{handleOf(mainSea)}</span><span class="sub">'s sea · {afloatOf(mainSea)} afloat</span>{/if}
        {/if}
      </p>
      {#if fogOn && liftedHere.size <= 2}
        <p class="caption-hint">Fog lifted: numbers count ship cells afloat in a row</p>
      {/if}
    {/if}
    {#if deploying && ownCells && me}
      {@render sea(me, ownCells, mainCell, true, 'deploy', true)}
    {:else if target && targetCells}
      {@render sea(target.sea, targetCells, mainCell, true, live && !amOut && !!me ? 'fire' : 'view', false)}
    {/if}
    <div class="pill" role="toolbar" aria-label="Board view">
      <button type="button" class="turn" aria-label="Turn left" onclick={() => turn(-90)}>⟲ 90°</button>
      <button type="button" aria-pressed={isView(ISO)} onclick={() => aimCamera(ISO)}>Iso</button>
      <button type="button" aria-pressed={isView(TOP)} onclick={() => aimCamera(TOP)}>Top</button>
      <button type="button" class="turn" aria-label="Turn right" onclick={() => turn(90)}>90° ⟳</button>
      <button type="button" class="snd" aria-label="Sound" aria-pressed={soundOn} onclick={() => (soundOn = sound?.toggle() ?? false)}>♪</button>
      <span class="hint-drag">drag to swivel</span>
    </div>
  </div>

  <aside class="side">
    <section class="opps" aria-label={me ? 'Opponents' : 'Fleets'}>
      <p class="head">{me ? 'Opponents' : 'Fleets'}</p>
      <div class="list">
        {#each others as seat (seat)}
          {@const t = view.targets.find((x) => x.sea === seat)}
          {@const st = stateOf(seat)}
          {@const on = !deploying && targetSea === seat}
          {#snippet card()}
            {#if t}{@render mini(t)}{:else}<span class="mini empty" aria-hidden="true"></span>{/if}
            {@const g = view.guns?.[seat]}
            <span class="who">
              <span class="line1"
                ><span class="name" class:human={humanSeat(seat)}>{handleOf(seat)}</span
                >{#if g !== undefined}<span class="guns" data-testid="guns" data-guns={g} title="{plural(g, 'gun')}: one shot per ship afloat"
                    >{#each { length: SHIPS.length } as _, i (i)}<i class:lost={i >= g}></i>{/each}</span
                  >{/if}</span
              >
              <span class="stat">{afloatOf(seat)} afloat · {view.scrap[seat] ?? 0} scrap</span>
            </span>
            {#if on}<span class="badge">target</span>{/if}
            {#if st && !(on && st === 'aiming')}<span class="state {st}">{STATE_TEXT[st] ?? st}</span>{/if}
          {/snippet}
          {#if t && !deploying}
            <button
              type="button"
              class="chip"
              class:holdout={holdout === seat}
              class:on
              data-seat={seat}
              data-ready={view.ready.includes(seat)}
              aria-pressed={on}
              aria-label="{handleOf(seat)}'s sea, {afloatOf(seat)} afloat{view.guns?.[seat] !== undefined ? `, ${plural(view.guns[seat], 'gun')}` : ''}{aimedOn(seat) ? `, ${aimedOn(seat)} aimed` : ''}{st ? `, ${STATE_TEXT[st] ?? st}` : ''}"
              onclick={() => (picked = seat)}>{@render card()}</button
            >
          {:else}
            <div class="chip" class:gone={out(seat)} class:holdout={holdout === seat} data-seat={seat} data-ready={view.ready.includes(seat)}>{@render card()}</div>
          {/if}
        {/each}
      </div>
    </section>

    {#if !deploying && ownCells && me}
      <section class="fleet" aria-label="Your fleet" bind:this={ownEl}>
        <p class="head"><span>Your fleet</span><span class="count">{afloatOf(me)} afloat</span></p>
        <div class="ownbox">
          {@render sea(me, ownCells, ownCell, false, 'view', true)}
        </div>
        <p class="legend"><span><i class="k-hit"></i>hit on you</span><span><i class="k-miss"></i>miss</span></p>
      </section>
    {/if}

    <div class="actions">
      {#if deploying && port.length > 0}
        <p class="head">Your port</p>
        <div class="port" role="group" aria-label="Ships in port">
          {#each SHIPS as s (s.id)}
            {@const docked = port.includes(s.id)}
            <button
              type="button"
              class="ship"
              data-ship={s.id}
              aria-pressed={docked && ship === s.id}
              disabled={!docked || !interactive}
              onclick={() => (shipPick = s.id)}
            >
              <span class="sname">{s.id}</span>
              <span class="pips" aria-hidden="true">{#each { length: s.length } as _, i (i)}<i></i>{/each}</span>
            </button>
          {/each}
        </div>
        <div class="row">
          <button type="button" class="btn" disabled={!interactive} onclick={rotate} aria-label="Rotate: facing {facing} (R)">Facing {facing}</button>
          <button type="button" class="btn primary" data-testid="random" disabled={!interactive || !randomCmd} onclick={deployRandom}>Random</button>
        </div>
        <p class="hint">Pick a ship, then a cell; R turns it.</p>
      {:else if deploying}
        <p class="slot" data-testid="waiting">Fleet deployed. {waitingFor.length ? `Waiting on ${names(waitingFor)}…` : ''}</p>
      {:else if live && me && !amOut}
        <div class="salvo-head">
          <span class="head">Salvo: {plural(guns, 'shot')}</span>
          <span class="shots" data-testid="shots" aria-label="{sent.length} sent, {aims.length} aimed, {room} to aim">
            {#each sent as o, i (i)}<i class="s-sent" class:b={o.fire === 'buoy'}></i>{/each}
            {#each aims as a, i (i)}<i class="s-aimed" class:b={a.fire === 'buoy'}></i>{/each}
            {#each { length: room } as _, i (i)}<i></i>{/each}
          </span>
        </div>
        {#if iAmReady}
          <p class="slot locked" data-testid="waiting">Locked in — {sentText}. Waiting on {names(waitingFor)}…</p>
        {:else}
          {#if buoysLegal || buoyUsed}
            <div class="kind" role="group" aria-label="What the next aim is">
              <button type="button" aria-pressed={aimKind === 'shell'} data-testid="kind-shell" onclick={() => setKind('shell')}>Shell</button>
              <button
                type="button"
                class="k-buoy"
                aria-pressed={aimKind === 'buoy'}
                data-testid="kind-buoy"
                disabled={buoyUsed || (room === 0 && !buoyAimed)}
                title={buoyAimed ? 'One buoy a round: click its centre to take it back' : buoyUsed ? 'One buoy a round' : undefined}
                onclick={() => setKind('buoy')}>Sonar buoy</button
              >
            </div>
          {/if}
          {#if aims.length > 0}
            <button type="button" class="firebtn" class:buoy={aims.every((x) => x.fire === 'buoy')} data-testid="fire" disabled={!interactive || sending} onclick={() => void fire()}
              >{sending ? 'Firing…' : fireLabel}</button
            >
            {#if room === 0}<p class="hint">Salvo aimed. Click an aim to take it back.</p>{/if}
          {:else}
            <button type="button" class="slot" data-testid="fire" disabled
              >{aimKind === 'buoy' ? 'Pick a centre for the buoy' : sent.length ? `Pick ${plural(room, 'more cell')}` : `Pick ${plural(room, 'cell')} to fire`}</button
            >
          {/if}
        {/if}
      {:else if live && amOut}
        <p class="slot">Your fleet is down. The others play on.</p>
      {:else if !live}
        <p class="slot">Every fleet is shown.</p>
      {/if}
    </div>
  </aside>
  </div>
</div>

<style>
  .salvo {
    container: salvo / size;
    position: relative;
    width: 100%;
    height: 100%;
    overflow: hidden;
    user-select: none;
  }
  .layout {
    height: 100%;
    display: grid;
    /* Narrow (a phone, a narrow window): the target sea on top, the opponents, then your fleet beside the controls. */
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: min(calc(100cqw + 64px), 62cqh) minmax(0, 1fr);
    grid-template-areas: 'stage' 'side';
  }
  /* Wide: the target sea takes the stage, a 290 px column beside it. */
  @container salvo (min-width: 640px) and (min-aspect-ratio: 6 / 5) {
    .layout {
      grid-template-columns: minmax(0, 1fr) 290px;
      grid-template-rows: minmax(0, 1fr);
      grid-template-areas: 'stage side';
    }
  }

  /* ── The stage ── */
  .stage {
    grid-area: stage;
    position: relative;
    min-height: 0;
    min-width: 0;
    display: grid;
    place-items: center;
    padding: 40px 8px 56px;
    overflow: hidden;
    cursor: grab;
    touch-action: pan-y;
    background: radial-gradient(ellipse at 50% 55%, #152238 0%, transparent 62%);
  }
  .stage.dragging {
    cursor: grabbing;
  }
  .caption {
    position: absolute;
    top: 14px;
    left: 18px;
    margin: 0;
    display: flex;
    gap: 8px;
    align-items: baseline;
    pointer-events: none;
    z-index: 2;
  }
  .kicker,
  .head {
    font: 500 11px var(--font-ui);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--dust);
  }
  .who-big {
    font: 600 16px var(--font-silicon);
  }
  .sub {
    color: var(--dust);
    font-size: 12px;
  }
  .caption-hint {
    position: absolute;
    top: 34px;
    left: 18px;
    margin: 0;
    font-size: 11px;
    color: var(--fog);
    pointer-events: none;
    z-index: 2;
  }
  .pill {
    position: absolute;
    bottom: 12px;
    left: 50%;
    translate: -50% 0;
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 4px;
    background: rgba(13, 16, 32, 0.9);
    border: 1px solid var(--lattice);
    border-radius: 999px;
    font: 500 12px var(--font-ui);
    color: var(--fog);
    cursor: default;
    z-index: 3;
    white-space: nowrap;
  }
  .pill button {
    padding: 6px 11px;
    border: 0;
    border-radius: 999px;
    background: none;
    color: inherit;
    font: inherit;
  }
  .pill button:hover,
  .pill button[aria-pressed='true'] {
    background: var(--panel-2);
    color: var(--chalk);
  }
  .hint-drag {
    padding: 6px 11px 6px 9px;
    border-left: 1px solid var(--lattice);
    color: var(--dust);
  }
  @container salvo (max-width: 520px) {
    .hint-drag,
    .pill .turn {
      display: none;
    }
  }

  /* ── Banners: over the stage, never in the way of a click ── */
  .banners {
    position: absolute;
    top: 10px;
    left: 0;
    right: 0;
    display: flex;
    justify-content: center;
    pointer-events: none;
    z-index: 5;
  }
  .banner {
    margin: 0 10px;
    max-width: 34rem;
    padding: 0.55rem 1.1rem;
    border-radius: 999px;
    border: 1px solid var(--lattice);
    background: rgba(13, 16, 32, 0.92);
    color: var(--chalk);
    font-weight: 600;
    text-align: center;
    box-shadow: 0 8px 30px rgba(0, 0, 0, 0.55);
    animation: sv-banner 0.35s cubic-bezier(0.2, 1.4, 0.4, 1) both;
  }
  .banner.hot {
    border-color: var(--carbon);
    color: #ffd2b8;
    box-shadow: 0 0 24px rgba(255, 122, 61, 0.45), 0 8px 30px rgba(0, 0, 0, 0.55);
  }
  .banner.calm {
    color: var(--fog);
  }
  .banner.go {
    border-color: var(--ready);
    font-size: var(--step-1);
    letter-spacing: 0.04em;
  }

  /* ── The side column ── */
  .side {
    grid-area: side;
    min-height: 0;
    min-width: 0;
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(8.5rem, 44%);
    grid-template-rows: auto minmax(0, 1fr);
    grid-template-areas: 'opps opps' 'fleet actions';
    gap: 8px 10px;
    padding: 6px 8px 8px;
    border-top: 1px solid var(--lattice);
  }
  .salvo.deploying .side {
    grid-template-areas: 'opps opps' 'actions actions';
  }
  .stage {
    padding: 34px 2px 50px;
  }
  @container salvo (min-width: 640px) and (min-aspect-ratio: 6 / 5) {
    .stage {
      padding: 40px 8px 56px;
    }
    .side,
    .salvo.deploying .side {
      grid-template-columns: minmax(0, 1fr);
      grid-template-rows: auto auto minmax(0, 1fr);
      grid-template-areas: 'opps' 'fleet' 'actions';
      align-content: start;
      gap: 14px;
      padding: 16px;
      border-top: 0;
      border-left: 1px solid var(--lattice);
      overflow-y: auto;
    }
    .salvo.deploying .side {
      grid-template-rows: auto auto;
      grid-template-areas: 'opps' 'actions';
    }
  }
  .head {
    margin: 0 0 8px;
    display: flex;
    justify-content: space-between;
    align-items: baseline;
  }
  .count {
    font: 12px var(--font-ui);
    letter-spacing: 0;
    text-transform: none;
    color: var(--fog);
  }

  /* Opponents: one card each, with your shot history on a mini-map. */
  .opps {
    grid-area: opps;
    min-width: 0;
  }
  .list {
    display: flex;
    gap: 6px;
    overflow-x: auto;
  }
  @container salvo (min-width: 640px) and (min-aspect-ratio: 6 / 5) {
    .list {
      flex-direction: column;
      overflow: visible;
    }
    .list .chip {
      flex: none;
    }
  }
  .chip {
    flex: 1 0 9.5rem;
    min-width: 0;
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    grid-template-rows: auto auto;
    column-gap: 10px;
    align-items: center;
    padding: 7px 9px;
    border: 1px solid var(--lattice);
    border-radius: var(--r-control);
    background: #141829;
    color: var(--chalk);
    text-align: left;
    font: inherit;
  }
  button.chip:hover {
    border-color: #2f3658;
  }
  .chip.on {
    border-color: color-mix(in oklab, var(--carbon) 55%, var(--lattice));
    background: color-mix(in oklab, var(--carbon) 7%, #141829);
  }
  .chip.gone {
    opacity: 0.5;
  }
  .chip .mini {
    grid-row: 1 / 3;
  }
  .chip .who {
    grid-row: 1 / 3;
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font: 600 13px var(--font-silicon);
    color: var(--silicon);
  }
  .name.human {
    color: var(--carbon);
    font-family: var(--font-carbon);
    font-style: italic;
  }
  .stat {
    margin-top: 2px;
    font-size: 12px;
    color: var(--dust);
    white-space: nowrap;
  }
  .badge {
    justify-self: end;
    padding: 3px 6px;
    border-radius: 4px;
    background: var(--carbon);
    color: #1a0d06;
    font: 600 10px var(--font-ui);
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }
  .state {
    justify-self: end;
    grid-column: 3;
    display: flex;
    align-items: center;
    gap: 5px;
    font-size: 11px;
    color: var(--dust);
    white-space: nowrap;
  }
  .badge + .state {
    grid-row: 2;
  }
  .state.locked,
  .state.deployed {
    color: var(--ready);
    font-weight: 600;
    animation: sv-stamp 0.45s cubic-bezier(0.2, 1.6, 0.4, 1) both;
  }
  .state.locked::before,
  .state.deployed::before {
    content: '';
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: var(--ready);
  }
  .state.winner {
    color: var(--carbon);
    font-weight: 600;
  }
  /* The last seat everyone is waiting on. */
  .chip.holdout {
    border-color: var(--carbon);
    animation: sv-holdout 1.1s ease-in-out infinite;
  }
  .chip.holdout .state {
    color: var(--carbon);
  }
  .mini {
    display: grid;
    grid-template-columns: repeat(8, 1fr);
    gap: 1px;
    width: 42px;
    height: 42px;
    padding: 2px;
    border-radius: 4px;
    background: #0f2134;
  }
  .mini {
    position: relative;
  }
  /* Your aims on that sea (outlined), and what you've already sent this round (filled, dimmer). */
  .mini .m-aim {
    box-shadow: inset 0 0 0 1px var(--carbon);
    background: rgba(255, 122, 61, 0.25);
  }
  .mini .m-out {
    background: rgba(255, 122, 61, 0.5);
  }
  .mini .aimed {
    position: absolute;
    right: -5px;
    top: -5px;
    min-width: 15px;
    height: 15px;
    padding: 0 3px;
    border-radius: 999px;
    background: var(--carbon);
    color: #1a0d06;
    font: 700 10px/15px var(--font-ui);
    text-align: center;
    box-shadow: 0 0 0 2px #141829;
  }
  .line1 {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
  }
  /* Guns: one per ship afloat. Losing a ship costs you a shot a round. */
  .guns {
    display: flex;
    gap: 2px;
    flex: none;
  }
  .guns i {
    width: 4px;
    height: 9px;
    border-radius: 1px;
    background: var(--chalk);
    opacity: 0.85;
  }
  .guns i.lost {
    background: none;
    box-shadow: inset 0 0 0 1px rgba(170, 180, 210, 0.35);
    opacity: 1;
  }
  .mini.empty {
    opacity: 0.4;
  }
  .mini i {
    border-radius: 1px;
    background: rgba(120, 190, 220, 0.1);
  }
  .mini .m-miss { background: rgba(220, 240, 250, 0.45); }
  .mini .m-hit { background: var(--carbon); }
  .mini .m-sunk { background: #6b2a1f; box-shadow: inset 0 0 0 1px var(--carbon); }
  .mini .m-ship { background: rgba(226, 231, 245, 0.55); }
  .mini .land {
    animation: sv-ping 0.5s ease-out var(--d) both;
  }

  /* Your fleet: a flat chart, hits on you in cyan. */
  .fleet {
    grid-area: fleet;
    min-height: 0;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }
  .ownbox {
    min-width: 0;
    padding: 6px;
    border-radius: var(--r-control);
    background: linear-gradient(160deg, #10304a, #0a1c2f);
    border: 1px solid #1d3550;
    display: grid;
    place-items: center;
  }
  .legend {
    display: flex;
    gap: 14px;
    margin: 8px 0 0;
    font-size: 11px;
    color: var(--dust);
  }
  .legend span {
    display: flex;
    align-items: center;
    gap: 5px;
  }
  .k-hit,
  .k-miss {
    width: 8px;
    height: 8px;
    border-radius: 50%;
  }
  .k-hit { background: var(--silicon); }
  .k-miss { border: 1.5px solid rgba(79, 216, 238, 0.6); }

  /* The controls: one place that says what you're doing. */
  .actions {
    grid-area: actions;
    display: flex;
    flex-direction: column;
    justify-content: flex-end;
    gap: 6px;
    min-width: 0;
    font-size: var(--step--1);
  }
  .actions p {
    margin: 0;
  }
  .hint {
    color: var(--fog);
  }
  .actions .row {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
  }
  .actions .btn {
    padding: 0.45rem 0.8rem;
  }
  .firebtn,
  .slot {
    width: 100%;
    min-height: 3rem;
    padding: 12px;
    border-radius: var(--r-control);
    text-align: center;
    font: 600 15px var(--font-ui);
  }
  .firebtn {
    border: 0;
    background: var(--carbon);
    color: #1a0d06;
    box-shadow: 0 8px 24px rgba(255, 122, 61, 0.25);
    cursor: pointer;
  }
  .firebtn:hover {
    background: #ff9d6c;
  }
  .firebtn.buoy {
    background: var(--silicon);
    color: #04161c;
    box-shadow: 0 8px 24px rgba(79, 216, 238, 0.22);
  }
  .firebtn.buoy:hover {
    background: #8ae6f4;
  }
  /* The salvo: a pip per gun — filled sent, outlined aimed, empty still to aim. */
  .salvo-head {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .salvo-head .head {
    margin: 0;
  }
  .shots {
    display: flex;
    gap: 4px;
  }
  .shots i {
    width: 11px;
    height: 11px;
    border-radius: 50%;
    box-shadow: inset 0 0 0 1.5px #3a4266;
  }
  .shots i.s-aimed {
    box-shadow: inset 0 0 0 2px var(--carbon);
  }
  .shots i.s-sent {
    background: var(--carbon);
    box-shadow: none;
  }
  .shots i.b.s-aimed {
    box-shadow: inset 0 0 0 2px var(--silicon);
  }
  .shots i.b.s-sent {
    background: var(--silicon);
  }
  /* Shell | Sonar buoy: what the next aim is. */
  .kind {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 2px;
    padding: 3px;
    border: 1px solid var(--lattice);
    border-radius: var(--r-control);
    background: rgba(13, 16, 32, 0.6);
  }
  .kind button {
    padding: 6px 8px;
    border: 0;
    border-radius: calc(var(--r-control) - 2px);
    background: none;
    color: var(--fog);
    font: 500 13px var(--font-ui);
    white-space: nowrap;
  }
  .kind button:hover:not(:disabled) {
    color: var(--chalk);
  }
  .kind button:disabled {
    opacity: 0.4;
  }
  .kind button[aria-pressed='true'] {
    background: color-mix(in oklab, var(--carbon) 22%, var(--panel-2));
    color: var(--chalk);
  }
  .kind .k-buoy[aria-pressed='true'] {
    background: color-mix(in oklab, var(--silicon) 22%, var(--panel-2));
  }
  .slot {
    display: grid;
    place-items: center;
    border: 1px dashed #2f3658;
    background: none;
    color: var(--dust);
    font-weight: 500;
    font-size: 14px;
  }
  .slot.locked {
    border-style: solid;
    border-color: color-mix(in oklab, var(--ready) 40%, transparent);
    color: var(--ready);
  }
  .port {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }
  .ship {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 3px;
    padding: 5px 8px;
    border: 1px solid var(--lattice);
    border-radius: var(--r-tile);
    background: var(--panel-2);
    color: var(--chalk);
    text-transform: capitalize;
  }
  .ship[aria-pressed='true'] {
    border-color: var(--carbon);
  }
  .ship:disabled {
    opacity: 0.4;
  }
  .pips {
    display: flex;
    gap: 2px;
  }
  .pips i {
    width: 10px;
    height: 6px;
    border-radius: 2px;
    background: var(--fog);
  }

  /* ── A sea: a slab of dark water, every cell a real button a hair above it. ── */
  /* The perspective lives here and the wrapper stays flat: a preserve-3d wrapper at z = 0 would sit in front
     of the slab's far half (tilted away, below z = 0) and take its clicks. Only the cells take pointer events. */
  .sea3d {
    display: grid;
    place-items: center;
    pointer-events: none;
  }
  .sea3d.main {
    perspective: 1900px;
    perspective-origin: 50% 38%;
  }
  .slab {
    position: relative;
    transform-style: preserve-3d;
    transition: transform 0.6s cubic-bezier(0.2, 0.8, 0.2, 1);
  }
  .slab.still {
    transition: none;
  }
  .under {
    position: absolute;
    inset: -50px;
    border-radius: 50px;
    background: radial-gradient(closest-side, rgba(0, 0, 0, 0.6), rgba(0, 0, 0, 0));
    transform: translateZ(-50px);
  }
  .face {
    position: relative;
    display: grid;
    grid-template-columns: repeat(8, var(--cell));
    grid-auto-rows: var(--cell);
    transform-style: preserve-3d;
  }
  .main .face {
    grid-template-columns: var(--g) repeat(8, var(--cell));
    grid-template-rows: repeat(8, var(--cell)) var(--g);
    padding: 8px 14px 4px calc(6px + var(--fp, 0px));
    border-radius: 3px;
    background:
      url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.012 .06' numOctaves='3' stitchTiles='stitch'/%3E%3CfeColorMatrix values='0 0 0 0 .55 0 0 0 0 .8 0 0 0 0 .95 0 0 0 .14 0'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E") 0 0 / 220px,
      radial-gradient(ellipse at 30% 25%, rgba(70, 150, 190, 0.3), transparent 55%),
      linear-gradient(165deg, #123a52, #0b2338 65%, #071626);
    box-shadow: inset 0 0 0 1px rgba(140, 210, 240, 0.14), inset 0 0 70px rgba(0, 0, 0, 0.5);
  }
  .main .fx,
  .main .pegs,
  .main .marks {
    left: calc(6px + var(--fp, 0px));
    top: 8px;
  }
  .edge {
    position: absolute;
    background: linear-gradient(#123049, #071320);
    pointer-events: none;
  }
  .edge.s { left: 0; top: 100%; width: 100%; height: 22px; transform-origin: top; transform: rotateX(-90deg); }
  .edge.n { left: 0; bottom: 100%; width: 100%; height: 22px; transform-origin: bottom; transform: rotateX(90deg); }
  .edge.w { right: 100%; top: 0; width: 22px; height: 100%; transform-origin: right; transform: rotateY(-90deg); }
  .edge.e { left: 100%; top: 0; width: 22px; height: 100%; transform-origin: left; transform: rotateY(90deg); }
  .tag {
    display: grid;
    place-items: center;
    font: 500 clamp(9px, calc(var(--cell) * 0.21), 11px) var(--font-silicon);
    color: rgba(170, 215, 235, 0.55);
    transform: translateZ(1px);
  }
  .face > button {
    position: relative;
    width: var(--cell);
    height: var(--cell);
    padding: 0;
    border: 0;
    background: none;
    /* A hair above the slab: coplanar with it, the slab can win the hit test and eat the click. */
    transform: translateZ(1px);
    transform-style: preserve-3d;
    cursor: crosshair;
    pointer-events: auto;
  }
  .face > button[aria-disabled='true'] {
    cursor: inherit;
  }
  .own .face > button {
    cursor: default;
  }
  .face > button > * {
    pointer-events: none;
  }
  .water {
    position: absolute;
    inset: 0;
    border-right: 1px solid rgba(150, 210, 240, 0.13);
    border-bottom: 1px solid rgba(150, 210, 240, 0.13);
  }
  /* A lifted row: the fog is off it, so the water reads a shade lighter. */
  .water.up {
    background: rgba(200, 230, 250, 0.07);
  }
  .own .water {
    inset: 1px;
    border: 0;
    border-radius: 2px;
    background: rgba(140, 200, 230, 0.06);
  }
  button[aria-disabled='false']:hover .water,
  button[aria-disabled='false']:focus-visible .water {
    background: rgba(255, 122, 61, 0.12);
  }
  button:focus-visible .water {
    outline: 2px solid var(--chalk);
    outline-offset: -2px;
  }
  .hull {
    position: absolute;
    inset: 14%;
    border-radius: 999px;
    background: linear-gradient(#e2e7f5, #9aa5c4);
    box-shadow: inset 0 -2px 0 rgba(0, 0, 0, 0.2), 0 2px 4px rgba(0, 0, 0, 0.45);
  }
  /* A hull runs on into the next cell: no gap, no rounding on that side. */
  .hull.jl { left: 0; border-top-left-radius: 0; border-bottom-left-radius: 0; }
  .hull.jr { right: 0; border-top-right-radius: 0; border-bottom-right-radius: 0; }
  .hull.jt { top: 0; border-top-left-radius: 0; border-top-right-radius: 0; }
  .hull.jb { bottom: 0; border-bottom-left-radius: 0; border-bottom-right-radius: 0; }
  .hull.faint {
    opacity: 0.5;
  }
  .hull.wreck {
    background: linear-gradient(180deg, #3a2a26, #140c0a);
    box-shadow: inset 0 0 0 1px rgba(255, 122, 61, 0.35);
  }
  /* A miss: a ripple with a drop at its heart. */
  .ripple {
    position: absolute;
    left: 50%;
    top: 50%;
    width: 50%;
    height: 50%;
    translate: -50% -50%;
    border-radius: 50%;
    border: 2px solid rgba(220, 240, 250, 0.75);
    box-shadow: 0 0 0 calc(var(--cell) * 0.1) rgba(220, 240, 250, 0.08);
  }
  .ripple i {
    position: absolute;
    left: 50%;
    top: 50%;
    width: 24%;
    height: 24%;
    translate: -50% -50%;
    border-radius: 50%;
    background: rgba(230, 245, 255, 0.85);
  }
  .own .ripple {
    width: 56%;
    height: 56%;
    border: 1.5px solid rgba(79, 216, 238, 0.6);
    box-shadow: none;
  }
  .own .ripple i {
    display: none;
  }
  .ripple.land {
    animation: sv-splash 0.5s ease-out var(--d) both;
  }
  /* A hit: an orange glow on the water and a peg standing up out of it (cyan on your own fleet). */
  .glow {
    position: absolute;
    inset: 8%;
    border-radius: 4px;
    background: radial-gradient(circle, rgba(255, 122, 61, 0.55), rgba(255, 122, 61, 0) 70%);
  }
  .own .glow {
    display: none;
  }
  .glow.land {
    animation: sv-glow 0.5s ease-out var(--d) both;
  }
  .pegs {
    position: absolute;
    inset: 0;
    transform-style: preserve-3d;
    pointer-events: none;
  }
  .peg {
    position: absolute;
    width: 0;
    height: 0;
    transform-style: preserve-3d;
    --pc: var(--carbon);
  }
  .own .peg {
    --pc: var(--silicon);
  }
  /* Billboard (as Critical Mass's orbs): a sized box, lifted off the water, that undoes the sea's spin and tilt. */
  .peg .bb {
    position: absolute;
    left: calc(var(--cell) * -0.21);
    top: calc(var(--cell) * -0.21);
    width: calc(var(--cell) * 0.42);
    height: calc(var(--cell) * 0.42);
    transform: translateZ(var(--lift, 1px)) rotateZ(calc(-1 * var(--spin))) rotateX(calc(-1 * var(--tilt)));
  }
  .peg .bb i {
    position: absolute;
    inset: 0;
    border-radius: 50%;
    background: radial-gradient(circle at 35% 30%, color-mix(in oklab, var(--pc) 25%, white) 0%, var(--pc) 45%, color-mix(in oklab, var(--pc) 45%, black) 100%);
    box-shadow: 0 0 calc(var(--cell) * 0.27) color-mix(in oklab, var(--pc) 70%, transparent);
  }
  /* On the big sea the peg stands on the water, not half under it. */
  .main .peg {
    --lift: calc(var(--cell) * 0.22);
  }
  .peg.sunk .bb i {
    scale: 0.7;
    filter: saturate(0.6) brightness(0.8);
  }
  .peg .bb i.land {
    animation: sv-drop 0.6s ease-out var(--d) both;
  }
  .bubbles i {
    position: absolute;
    bottom: 20%;
    width: 18%;
    height: 18%;
    border-radius: 50%;
    border: 1px solid rgba(200, 230, 255, 0.8);
    opacity: 0;
    animation: sv-bubble 1.4s ease-out calc(var(--d) + var(--k, 0ms)) 2 both;
  }
  .bubbles i:nth-child(1) { left: 22%; --k: 0ms; }
  .bubbles i:nth-child(2) { left: 48%; --k: 250ms; }
  .bubbles i:nth-child(3) { left: 66%; --k: 500ms; }
  .ghost {
    position: absolute;
    inset: 10%;
    border-radius: 6px;
    background: color-mix(in oklab, var(--carbon) 40%, transparent);
    border: 1.5px solid var(--carbon);
  }
  .ghost.bad {
    background: color-mix(in oklab, var(--danger) 30%, transparent);
    border-color: var(--danger);
  }
  /* Your aim: a pulsing square with crosshairs running past it. */
  .reticle {
    position: absolute;
    inset: 6%;
    border: 2px solid var(--carbon);
    border-radius: 4px;
    box-shadow: 0 0 16px rgba(255, 122, 61, 0.6), inset 0 0 12px rgba(255, 122, 61, 0.3);
    animation: sv-aim 1.1s ease-in-out infinite;
  }
  .reticle::before,
  .reticle::after {
    content: '';
    position: absolute;
    background: rgba(255, 122, 61, 0.7);
  }
  .reticle::before { left: 50%; top: -18%; bottom: -18%; width: 1px; }
  .reticle::after { top: 50%; left: -18%; right: -18%; height: 1px; }
  /* Already sent this round: committed, so it stops pulsing and dims. */
  .reticle.sent {
    animation: none;
    opacity: 0.45;
    border-style: dashed;
    box-shadow: none;
  }
  .reticle.buoy {
    border-color: var(--silicon);
    box-shadow: 0 0 14px rgba(79, 216, 238, 0.5);
  }
  .reticle.buoy::before,
  .reticle.buoy::after {
    display: none;
  }

  /* ── Intel on the water: fog counts, sonar footprints, a buoy's aim (flat, under the pegs) ── */
  .marks {
    position: absolute;
    inset: 0;
    transform: translateZ(2px);
    transform-style: preserve-3d;
    pointer-events: none;
  }
  .fogn {
    position: absolute;
    translate: -50% -50%;
    min-width: calc(var(--cell) * 0.36);
    padding: 0 3px;
    border-radius: 999px;
    background: color-mix(in oklab, var(--carbon) 22%, #0d1020);
    border: 1px solid color-mix(in oklab, var(--carbon) 70%, transparent);
    color: #ffd2b8;
    font: 600 clamp(9px, calc(var(--cell) * 0.24), 13px) / 1.45 var(--font-silicon);
    text-align: center;
  }
  .fogn.none {
    background: none;
    border-color: rgba(170, 215, 235, 0.25);
    color: rgba(170, 215, 235, 0.45);
  }
  /* A sonar reading's 3×3; the newest a little stronger, an empty one calmer. */
  .foot {
    position: absolute;
    width: calc(var(--cell) * 3);
    height: calc(var(--cell) * 3);
    translate: -50% -50%;
    border: 1.5px dashed rgba(79, 216, 238, 0.45);
    border-radius: 6px;
    background: rgba(79, 216, 238, 0.06);
  }
  .foot.newest {
    border-color: rgba(79, 216, 238, 0.8);
    background: rgba(79, 216, 238, 0.11);
  }
  .foot.none {
    border-color: rgba(170, 215, 235, 0.22);
    background: rgba(170, 215, 235, 0.03);
  }
  /* Where your buoy would go (or went): the pointer's lighter, the pick brighter. */
  .foot.aim {
    border: 2px dashed rgba(79, 216, 238, 0.55);
    background: rgba(79, 216, 238, 0.08);
  }
  .foot.aim.picked {
    border-color: var(--silicon);
    background: rgba(79, 216, 238, 0.16);
    box-shadow: 0 0 18px rgba(79, 216, 238, 0.35);
  }
  .foot.aim.sent {
    opacity: 0.6;
  }
  .sonar {
    position: absolute;
    width: 0;
    height: 0;
    transform-style: preserve-3d;
  }
  .sonar .bb {
    position: absolute;
    left: calc(var(--cell) * -0.26);
    top: calc(var(--cell) * -0.26);
    width: calc(var(--cell) * 0.52);
    height: calc(var(--cell) * 0.52);
    display: grid;
    place-items: center;
    transform: translateZ(var(--lift, 1px)) rotateZ(calc(-1 * var(--spin))) rotateX(calc(-1 * var(--tilt)));
  }
  .main .sonar {
    --lift: calc(var(--cell) * 0.5);
  }
  .sonar b {
    min-width: 100%;
    padding: 0 4px;
    border-radius: 999px;
    background: color-mix(in oklab, var(--silicon) 70%, #0d1020);
    color: #04161c;
    font: 700 clamp(10px, calc(var(--cell) * 0.3), 16px) / calc(var(--cell) * 0.52) var(--font-silicon);
    text-align: center;
    box-shadow: 0 0 calc(var(--cell) * 0.22) rgba(79, 216, 238, 0.45), 0 2px 6px rgba(0, 0, 0, 0.5);
    opacity: 0.8;
  }
  .sonar.newest b {
    background: var(--silicon);
    opacity: 1;
  }
  .sonar.none b {
    background: #10202c;
    color: rgba(170, 215, 235, 0.7);
    border: 1px solid rgba(170, 215, 235, 0.35);
    box-shadow: 0 2px 6px rgba(0, 0, 0, 0.5);
  }
  .sonar b.land {
    animation: sv-pop 0.45s cubic-bezier(0.2, 1.6, 0.4, 1) var(--d) both;
  }

  /* ── Shells in the air ── */
  .fx {
    position: absolute;
    inset: 0;
    transform-style: preserve-3d;
    pointer-events: none;
  }
  .shell {
    position: absolute;
    width: 0;
    height: 0;
    transform-style: preserve-3d;
    animation:
      sv-fly var(--fly) linear var(--d) both,
      sv-gone 0.15s linear calc(var(--d) + var(--fly)) forwards;
  }
  .shade {
    position: absolute;
    left: calc(var(--cell) * -0.22);
    top: calc(var(--cell) * -0.12);
    width: calc(var(--cell) * 0.44);
    height: calc(var(--cell) * 0.24);
    border-radius: 50%;
    background: rgba(0, 0, 0, 0.6);
    filter: blur(2px);
    animation: sv-shade var(--fly) ease-in var(--d) both;
  }
  .arc {
    position: absolute;
    transform-style: preserve-3d;
    animation: sv-arc var(--fly) linear var(--d) both;
  }
  .arc .bb {
    position: absolute;
    transform: rotateZ(calc(-1 * var(--spin))) rotateX(calc(-1 * var(--tilt)));
  }
  .ball {
    position: absolute;
    left: calc(var(--cell) * -0.13);
    top: calc(var(--cell) * -0.13);
    width: calc(var(--cell) * 0.26);
    height: calc(var(--cell) * 0.26);
    border-radius: 50%;
    background: radial-gradient(circle at 35% 30%, #fff 0%, var(--c) 45%, color-mix(in oklab, var(--c) 50%, black) 100%);
    box-shadow: 0 0 10px var(--c);
  }
  /* A buoy splashing down: a ring that spreads over the 3×3 it will listen to. */
  .ping {
    position: absolute;
    width: calc(var(--cell) * 3);
    height: calc(var(--cell) * 3);
    translate: -50% -50%;
    border-radius: 50%;
    border: 2px solid var(--silicon);
    box-shadow: 0 0 16px rgba(79, 216, 238, 0.6), inset 0 0 16px rgba(79, 216, 238, 0.4);
    transform: translateZ(3px);
    animation: sv-sonar 1.2s ease-out var(--d) 2 both;
  }
  .flash {
    position: absolute;
    width: calc(var(--cell) * 3.4);
    height: calc(var(--cell) * 3.4);
    translate: -50% -50%;
    border-radius: 50%;
    background: radial-gradient(circle, rgba(255, 255, 255, 0.95), rgba(255, 190, 90, 0.8) 30%, rgba(255, 90, 40, 0.35) 55%, transparent 70%);
    transform: translateZ(4px);
    animation: sv-flash 0.7s ease-out var(--d) both;
  }

  @keyframes sv-fly {
    from { transform: translate(var(--sx), var(--sy)); }
    to { transform: translate(0, 0); }
  }
  @keyframes sv-gone {
    to { opacity: 0; visibility: hidden; }
  }
  @keyframes sv-arc {
    0% { transform: translateZ(20px); animation-timing-function: cubic-bezier(0.2, 0.6, 0.4, 1); }
    45% { transform: translateZ(calc(var(--cell) * 4)); animation-timing-function: cubic-bezier(0.6, 0, 0.8, 0.4); }
    100% { transform: translateZ(0); }
  }
  @keyframes sv-shade {
    0% { transform: scale(0.25); opacity: 0.1; }
    100% { transform: scale(1); opacity: 0.8; }
  }
  @keyframes sv-splash {
    0% { transform: scale(0.2); opacity: 0; }
    40% { transform: scale(1.6); opacity: 1; }
    100% { transform: none; opacity: 1; }
  }
  @keyframes sv-glow {
    0% { opacity: 0; filter: brightness(3); }
    35% { opacity: 1; }
    100% { filter: none; }
  }
  @keyframes sv-drop {
    0% { transform: translateY(calc(var(--cell) * -1.4)); opacity: 0; }
    50% { transform: translateY(0) scale(1.18, 0.8); opacity: 1; }
    70% { transform: translateY(calc(var(--cell) * -0.12)) scale(0.95, 1.06); }
    85% { transform: translateY(0) scale(1.04, 0.96); }
    100% { transform: none; }
  }
  @keyframes sv-bubble {
    0% { transform: translateY(0) scale(0.4); opacity: 0; }
    20% { opacity: 1; }
    100% { transform: translateY(calc(var(--cell) * -0.6)) scale(1); opacity: 0; }
  }
  @keyframes sv-flash {
    0% { transform: translateZ(4px) scale(0.2); opacity: 0; }
    20% { opacity: 1; }
    100% { transform: translateZ(4px) scale(1.1); opacity: 0; }
  }
  @keyframes sv-sonar {
    0% { transform: translateZ(3px) scale(0.1); opacity: 0; }
    15% { opacity: 1; }
    100% { transform: translateZ(3px) scale(1); opacity: 0; }
  }
  @keyframes sv-pop {
    0% { transform: scale(0); opacity: 0; }
    100% { transform: none; opacity: 1; }
  }
  @keyframes sv-aim {
    0%, 100% { transform: scale(1); opacity: 1; }
    50% { transform: scale(0.88); opacity: 0.7; }
  }
  @keyframes sv-ping {
    0% { transform: scale(2.5); filter: brightness(2.5); }
    100% { transform: none; filter: none; }
  }
  @keyframes sv-stamp {
    0% { transform: scale(2.2) rotate(-8deg); opacity: 0; }
    100% { transform: none; opacity: 1; }
  }
  @keyframes sv-holdout {
    0%, 100% { box-shadow: 0 0 0 rgba(255, 150, 80, 0); }
    50% { box-shadow: 0 0 14px rgba(255, 150, 80, 0.55); }
  }
  @keyframes sv-banner {
    0% { transform: translateY(-14px) scale(0.92); opacity: 0; }
    100% { transform: none; opacity: 1; }
  }
  @media (prefers-reduced-motion: reduce) {
    .slab {
      transition: none;
    }
    .ripple.land,
    .glow.land,
    .peg .bb i.land,
    .bubbles i,
    .reticle,
    .mini .land,
    .sonar b.land,
    .state.locked,
    .state.deployed,
    .chip.holdout,
    .banner {
      animation: none;
    }
    .bubbles {
      display: none;
    }
  }
</style>
