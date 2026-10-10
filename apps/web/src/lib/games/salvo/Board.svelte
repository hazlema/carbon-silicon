<script lang="ts">
  import { untrack } from 'svelte';
  import { AUCTION_MS, buoyCells, cellIndex, cellName, clusterCells, hullCells, ITEM_LIMIT, MINE_LIMIT, SHIPS, SIZE, TELL_MAX, torpedoLane, TURN_SECONDS, type Facing, type ItemId, type SalvoCommand, type SalvoView, type ShipId, type TargetView, type Trick, type Volley } from '@cs/salvo';
  import type { TableColors } from '$lib/seats';
  import { clampTilt, DRAG_THRESHOLD, fitScale, nearestTurn } from '../critical-mass/iso';
  import CountdownRing from '$lib/components/CountdownRing.svelte';
  import { createSound } from '../critical-mass/sound';
  import { typing } from '../lightline/controls';
  import { incoming, landingTimes, planVolley, sideOf, TORPEDO_STEP_MS, type Side, type VolleyPlan } from './volley';

  let {
    view,
    interactive,
    legal,
    onMove,
    seats,
    you,
    fit = false,
    settling = $bindable(false),
    secondsLeft = null,
    toMove,
    canAct = false,
    onTell,
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
    /** True while a volley is still landing (the page holds the verdict until the last shell is down). */
    settling?: boolean;
    /** Seconds left on the round clock (the page's), for the ghost card; without it the card leaves the clock out. */
    secondsLeft?: number | null;
    /** The seats the match still waits on (the page's match.toMove): exact, where the view can only guess about ghosts. */
    toMove?: string[];
    /** The match is live and no move is in flight: optional commands (a bid, a tell) may go now, owed or not. */
    canAct?: boolean;
    /** Each banner worth keeping (a warning, a trick), as it goes up: the page writes it into your table chat. */
    onTell?: (line: { tone: 'hot' | 'calm' | 'go'; text: string }) => void;
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
  /** Sunk fleets still at the table, playing tricks. */
  const ghostOf = (seat: string) => (view.ghosts ?? []).includes(seat);
  const amGhost = $derived(!!me && ghostOf(me));

  // ── What `legal` offers ──
  type FireCmd = Extract<SalvoCommand, { fire: 'shell' }>;
  type BuoyCmd = Extract<SalvoCommand, { fire: 'buoy' }>;
  type PlaceCmd = Extract<SalvoCommand, { place: ShipId }>;
  const isFire = (l: unknown): l is FireCmd => typeof l === 'object' && l !== null && (l as FireCmd).fire === 'shell';
  const isBuoy = (l: unknown): l is BuoyCmd => typeof l === 'object' && l !== null && (l as BuoyCmd).fire === 'buoy';
  const isPlace = (l: unknown): l is PlaceCmd => typeof l === 'object' && l !== null && typeof (l as PlaceCmd).at === 'string' && 'place' in l;
  type MineCmd = Extract<SalvoCommand, { trick: 'mine' }>;
  type SplashCmd = Extract<SalvoCommand, { trick: 'splash' }>;
  const isMine = (l: unknown): l is MineCmd => typeof l === 'object' && l !== null && (l as MineCmd).trick === 'mine';
  const isSplash = (l: unknown): l is SplashCmd => typeof l === 'object' && l !== null && (l as SplashCmd).trick === 'splash';
  type WhisperCmd = Extract<SalvoCommand, { trick: 'whisper' }>;
  const isWhisper = (l: unknown): l is WhisperCmd => typeof l === 'object' && l !== null && (l as WhisperCmd).trick === 'whisper';
  const isTrick = (l: unknown): l is MineCmd | SplashCmd | WhisperCmd => isMine(l) || isSplash(l) || isWhisper(l);
  type BidCmd = Extract<SalvoCommand, { bid: number }>;
  type TellCmd = Extract<SalvoCommand, { tell: number }>;
  const isBid = (l: unknown): l is BidCmd => typeof l === 'object' && l !== null && typeof (l as BidCmd).bid === 'number';
  const isTell = (l: unknown): l is TellCmd => typeof l === 'object' && l !== null && typeof (l as TellCmd).tell === 'number';
  type ClusterCmd = Extract<SalvoCommand, { fire: 'cluster' }>;
  type TorpedoCmd = Extract<SalvoCommand, { fire: 'torpedo' }>;
  type RepairCmd = Extract<SalvoCommand, { use: 'repair' }>;
  type DecoyCmd = Extract<SalvoCommand, { use: 'decoy' }>;
  const isCluster = (l: unknown): l is ClusterCmd => typeof l === 'object' && l !== null && (l as ClusterCmd).fire === 'cluster';
  const isTorpedo = (l: unknown): l is TorpedoCmd => typeof l === 'object' && l !== null && (l as TorpedoCmd).fire === 'torpedo';
  const isRepair = (l: unknown): l is RepairCmd => typeof l === 'object' && l !== null && (l as RepairCmd).use === 'repair';
  const isDecoy = (l: unknown): l is DecoyCmd => typeof l === 'object' && l !== null && (l as DecoyCmd).use === 'decoy';
  const ITEM_TEST: Record<ItemId, (l: unknown) => boolean> = { cluster: isCluster, torpedo: isTorpedo, repair: isRepair, decoy: isDecoy };
  const randomCmd = $derived(legal.find((l) => typeof l === 'object' && l !== null && (l as { place?: unknown }).place === 'random'));

  // ── Which sea is big ──
  const deploying = $derived(view.phase === 'deploy' && !!view.mySea && !amOut);
  let picked = $state<string | null>(null);
  // The sea you picked stays on view even after its fleet goes out; left to us, a living one.
  const target = $derived(view.targets.find((t) => t.sea === picked) ?? view.targets.find((t) => !t.out) ?? view.targets[0] ?? null);
  const targetSea = $derived(target?.sea ?? null);
  // The sea on view is yours to leave: one we chose counts as picked, so a fleet that sinks while you watch
  // stays put for its stamp instead of the board sliding to the next living sea.
  $effect(() => {
    if (picked === null && target && !target.out) picked = target.sea;
  });
  const fireCells = $derived(new Set(legal.filter(isFire).filter((l) => l.at === targetSea).map((l) => l.cell)));
  /** The centres a sonar buoy may still go on the shown sea (b2..g7, once each). */
  const buoyCentres = $derived(new Set(legal.filter(isBuoy).filter((l) => l.at === targetSea).map((l) => l.cell)));
  /** Everyone at the table but you, in seat order: the seas you can aim at (or, watching, every fleet). */
  const others = $derived(view.seats.filter((s) => s !== me));

  // ── Fire: a salvo, one shot per ship afloat. Clicks toggle aims (on any sea); Fire (or Enter on an aim) sends them, one move each ──
  // An item from your arsenal takes one gun of the salvo, one a round: a cluster or a torpedo at a sea, a repair or a decoy on your own.
  type Kind = 'shell' | 'buoy' | ItemId;
  interface Aim {
    fire: Kind;
    /** The sea: a target's, or your own for a repair or a decoy. */
    at: string;
    /** The cell: a shell's, a buoy's or a cluster's centre, a torpedo's entry, the hit a repair welds, a decoy's first cell. */
    cell: string;
    lane?: string;
    facing?: Facing;
  }
  const ITEM_IDS: readonly ItemId[] = ['cluster', 'torpedo', 'repair', 'decoy'];
  const isItem = (k: string): k is ItemId => (ITEM_IDS as readonly string[]).includes(k);
  const ITEM_NAME: Record<ItemId, string> = { cluster: 'Cluster', torpedo: 'Torpedo', repair: 'Repair', decoy: 'Decoy' };
  const ITEM_ICON: Record<ItemId, string> = { cluster: '✚', torpedo: '➤', repair: '🔧', decoy: '🎭' };
  /** What each item does, said in the tray while you aim it. */
  const ITEM_HINT: Record<ItemId, string> = {
    cluster: 'Cluster: five shells in a plus. Click the centre cell.',
    torpedo: 'Torpedo: runs a lane from your side to the first ship. Click any cell of the lane.',
    repair: 'Repair: weld a hit back together; only you will know which. Click a hit on your fleet.',
    decoy: 'Decoy: a fake two-cell ship on your sea. Click to lay it; R turns it.',
  };
  let kind = $state<Kind>('shell');
  let aims = $state<Aim[]>([]);
  /** Aims going out right now (each is its own move, awaited in turn). */
  let sending = $state(false);
  /** The cell under the pointer while aiming a buoy, a cluster or a torpedo, for its preview. */
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
  // ── The arsenal: what you hold, and the one item this round ──
  const held = $derived(view.myArsenal?.items ?? []);
  /** Each kind you hold, once, with how many. */
  const tray = $derived(ITEM_IDS.filter((x) => held.includes(x)).map((x) => ({ item: x, n: held.filter((h) => h === x).length })));
  const itemAim = $derived(aims.find((a) => isItem(a.fire)));
  const itemSent = $derived(sent.find((o) => isItem(o.fire)));
  const itemLegal = (item: ItemId) => legal.some(ITEM_TEST[item]);
  /** Why an item can't be aimed now, or null when it can. */
  function itemWhy(item: ItemId): string | null {
    if (itemSent) return `One item a round: your ${itemSent.fire} is already away.`;
    if (itemAim && itemAim.fire !== item) return `One item a round: your ${itemAim.fire} is already in this salvo.`;
    // Guns first: with the salvo spent (a crate still owed), legal holds only the crate, so the checks below would misread it.
    if (!itemAim && sent.length + aims.length >= guns) return sent.length >= guns ? 'Your salvo is away: items wait for next round.' : 'Every gun is aimed: take one back to use an item.';
    if (!itemLegal(item)) {
      if (item === 'repair') return 'Nothing to repair: no hits on a ship still afloat.';
      if (item === 'decoy') return view.mySea?.decoy ? 'Your decoy is still out there: one at a time.' : 'No open water left on your sea for a decoy.';
      return `Nothing left to aim a ${item} at.`;
    }
    return null;
  }
  /** The tray's reason line: the first item that can't be used and why (one line, like the ghost's). */
  const trayWhy = $derived(tray.map((x) => itemWhy(x.item)).find((w) => w !== null) ?? null);
  const aimKind = $derived<Kind>(kind === 'buoy' ? (buoysLegal && !buoyUsed ? 'buoy' : 'shell') : isItem(kind) ? (held.includes(kind) && itemWhy(kind) === null ? kind : 'shell') : 'shell');
  /** Laying a decoy shows your own sea big. */
  const placingDecoy = $derived(aimKind === 'decoy' && !iAmReady && !!view.mySea);
  // A new round clears the aims and goes back to shells.
  $effect(() => {
    void round;
    aims = [];
    kind = 'shell';
    trickAim = null;
    fool = null;
  });
  /** The centres a cluster may go on, and the lanes a torpedo may run, on the shown sea. */
  const clusterCentres = $derived(new Set(legal.filter(isCluster).filter((l) => l.at === targetSea).map((l) => l.cell)));
  const torpedoLanes = $derived(new Set(legal.filter(isTorpedo).filter((l) => l.at === targetSea).map((l) => l.lane)));
  const repairCells = $derived(new Set(legal.filter(isRepair).map((l) => l.cell)));
  /** A torpedo from you runs down a column (north and south) or along a row (east and west): the lane a cell is in. */
  const laneOf = (cell: string) => (me === 'east' || me === 'west' ? cell.slice(1) : cell[0]);
  const laneCells = (lane: string) => (me ? (torpedoLane(me, lane) ?? []) : []);
  /** Which way your torpedo runs on screen (degrees: 0 right, 90 down): north runs down, south up, east leftward, west rightward. */
  const torpedoDir = (from: string) => ({ north: 90, south: -90, east: 180, west: 0 })[from as Side] ?? 0;
  const aimable = (k: Kind, cell: string) => (k === 'buoy' ? buoyCentres.has(cell) : fireCells.has(cell));
  const aimAt = (sea: string | null, cell: string, k?: Kind) => aims.find((a) => a.at === sea && a.cell === cell && (!k || a.fire === k));
  /** An aim that sits on this cell (a torpedo's entry cell is only where its lane starts, so it doesn't count). */
  const aimOn = (sea: string | null, cell: string) => aims.find((a) => a.at === sea && a.cell === cell && a.fire !== 'torpedo');
  const sentAt = (sea: string | null, cell: string) => sent.find((o) => o.fire === 'shell' && o.at === sea && o.cell === cell);
  /** The aims on the shown sea, and how many each other sea has. */
  const aimsHere = $derived(aims.filter((a) => a.at === targetSea));
  const aimedOn = (sea: string) => aims.filter((a) => a.at === sea).length;
  const setKind = (k: Kind) => (kind = k);
  const dropAim = (a: Aim | undefined) => (aims = aims.filter((x) => x !== a));
  /** Click a cell: take back an aim there (a buoy's or a cluster's first), or add one if there's a gun free. A buoy or an item moves rather than doubling. */
  function toggle(cell: string) {
    if (!targetSea) return;
    const sea = targetSea;
    if (aimKind === 'torpedo') {
      const lane = laneOf(cell);
      const torp = itemAim?.fire === 'torpedo' ? itemAim : undefined;
      if (torp && torp.at === sea && torp.lane === lane) return dropAim(torp);
      if (!torpedoLanes.has(lane) || (!itemAim && room === 0)) return;
      aims = [...aims.filter((a) => a !== itemAim), { fire: 'torpedo', at: sea, cell: laneCells(lane)[0] ?? cell, lane }];
      kind = 'shell';
      return;
    }
    const special = aims.find((a) => a.at === sea && a.cell === cell && (a.fire === 'buoy' || a.fire === 'cluster'));
    if (special) return dropAim(special);
    if (aimKind === 'buoy') {
      if (!buoyCentres.has(cell)) return;
      const other = aims.find((a) => a.fire === 'buoy');
      if (!other && room === 0) return;
      aims = [...aims.filter((a) => a !== other), { fire: 'buoy', at: sea, cell }];
      // One buoy a round: once it's down, the rest of the salvo is shells.
      kind = 'shell';
      return;
    }
    if (aimKind === 'cluster') {
      if (!clusterCentres.has(cell)) return;
      // A shell aimed at the centre gives way to the cluster (two of your guns can't share a cell).
      const shellHere = aimAt(sea, cell, 'shell');
      if (!itemAim && !shellHere && room === 0) return;
      aims = [...aims.filter((a) => a !== itemAim && a !== shellHere), { fire: 'cluster', at: sea, cell }];
      kind = 'shell';
      return;
    }
    const shell = aimAt(sea, cell, 'shell');
    if (shell) aims = aims.filter((a) => a !== shell);
    else if (room > 0 && fireCells.has(cell)) aims = [...aims, { fire: 'shell', at: sea, cell }];
  }
  /** Click your own fleet while repairing: weld that hit (again to take it back). */
  function pickRepair(cell: string) {
    if (!me) return;
    const was = itemAim?.fire === 'repair' ? itemAim : undefined;
    if (was && was.cell === cell) return dropAim(was);
    if (!repairCells.has(cell) || (!itemAim && room === 0)) return;
    aims = [...aims.filter((a) => a !== itemAim), { fire: 'repair', at: me, cell }];
    kind = 'shell';
  }
  // ── The decoy: your sea big, a two-cell hull under the pointer, R turns it ──
  let decoyFacing = $state<Facing>('east');
  const decoySpots = $derived(new Set(legal.filter(isDecoy).filter((l) => l.facing === decoyFacing).map((l) => l.at)));
  const decoyAimed = $derived(itemAim?.fire === 'decoy' ? itemAim : undefined);
  const decoyAimCells = $derived(decoyAimed ? (hullCells(decoyAimed.cell, 2, decoyAimed.facing ?? 'east') ?? []) : []);
  function pickDecoy(cell: string) {
    if (!me) return;
    if (decoyAimed && decoyAimCells.includes(cell)) return dropAim(decoyAimed);
    if (!decoySpots.has(cell) || (!itemAim && room === 0)) return;
    aims = [...aims.filter((a) => a !== itemAim), { fire: 'decoy', at: me, cell, facing: decoyFacing }];
    kind = 'shell';
  }
  const turnDecoy = () => (decoyFacing = decoyFacing === 'east' ? 'north' : 'east');
  $effect(() => {
    if (!placingDecoy) return;
    const key = (e: KeyboardEvent) => {
      if ((e.key === 'r' || e.key === 'R') && !e.ctrlKey && !e.metaKey && !e.altKey && !typing(e.target)) turnDecoy();
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  });
  /** The entry of `legal` an aim stands for, if it's still on offer. */
  const commandOf = (a: Aim) =>
    legal.find((l) => {
      if (typeof l !== 'object' || l === null) return false;
      const c = l as Record<string, unknown>;
      if (a.fire === 'torpedo') return c.fire === 'torpedo' && c.at === a.at && c.lane === a.lane;
      if (a.fire === 'repair') return c.use === 'repair' && c.cell === a.cell;
      if (a.fire === 'decoy') return c.use === 'decoy' && c.at === a.cell && c.facing === a.facing;
      return c.fire === a.fire && c.at === a.at && c.cell === a.cell;
    });
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
  type ItemMark = 'hover' | 'picked' | 'sent';
  /** A cluster's plus on the shown sea, by cell: the one sent, the one aimed, the one under the pointer. */
  const plusMarks = $derived.by(() => {
    const at = new Map<string, { centre: boolean; state: ItemMark }>();
    const put = (centre: string, state: ItemMark) => clusterCells(centre).forEach((c, k) => at.has(c) || at.set(c, { centre: k === 0, state }));
    for (const o of sent) if (o.fire === 'cluster' && o.at === targetSea) put(o.cell, 'sent');
    for (const a of aimsHere) if (a.fire === 'cluster') put(a.cell, 'picked');
    if (!iAmReady && aimKind === 'cluster' && aimHover && clusterCentres.has(aimHover)) put(aimHover, 'hover');
    return at;
  });
  /** A torpedo's lane on the shown sea, by cell: sent, aimed, or the one the pointer's cell implies (`bad` if it can't run there). */
  const laneMarks = $derived.by(() => {
    const at = new Map<string, { head: boolean; state: ItemMark; bad: boolean }>();
    const put = (lane: string, state: ItemMark, bad = false) => laneCells(lane).forEach((c, k) => at.has(c) || at.set(c, { head: k === 0, state, bad }));
    for (const o of sent) if (o.fire === 'torpedo' && o.at === targetSea && o.lane) put(o.lane, 'sent');
    for (const a of aimsHere) if (a.fire === 'torpedo' && a.lane) put(a.lane, 'picked');
    if (!iAmReady && aimKind === 'torpedo' && aimHover) put(laneOf(aimHover), 'hover', !torpedoLanes.has(laneOf(aimHover)));
    return at;
  });
  /** On your own sea: the repair and the decoy you've aimed or sent this round, by cell. */
  const ownMarks = $derived.by(() => {
    const at = new Map<string, { kind: 'repair' | 'decoy'; state: ItemMark; joins: string }>();
    const put = (o: { fire: Kind; cell: string; facing?: Facing }, state: ItemMark) => {
      if (o.fire === 'repair') at.set(o.cell, { kind: 'repair', state, joins: '' });
      if (o.fire === 'decoy') {
        const cells = hullCells(o.cell, 2, o.facing ?? 'east') ?? [];
        const joins = joinsOf(cells);
        for (const c of cells) at.set(c, { kind: 'decoy', state, joins: joins.get(c) ?? '' });
      }
    };
    for (const o of sent) put(o, 'sent');
    for (const a of aims) if (a.at === me) put(a, 'picked');
    return at;
  });
  const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  /** The non-shell parts of a salvo, named: "buoy", "cluster", … */
  const extrasOf = (list: { fire: Kind }[]) => list.filter((x) => x.fire !== 'shell').map((x) => x.fire);
  /** What the fire button says: "Fire 3 shells", "Fire 2 shells + buoy", "Fire 1 shell + torpedo", "Drop buoy", or "Fire 2 of 4" for part of a salvo. */
  const fireLabel = $derived.by(() => {
    const shells = aims.filter((a) => a.fire === 'shell').length;
    const owed = guns - sent.length;
    if (aims.length < owed) return `Fire ${aims.length} of ${owed}`;
    const extras = extrasOf(aims);
    if (extras.length === 0) return `Fire ${plural(shells, 'shell')}`;
    if (shells) return `Fire ${plural(shells, 'shell')} + ${extras.join(' + ')}`;
    if (extras.length === 1) return { buoy: 'Drop buoy', repair: 'Weld the repair', decoy: 'Lay the decoy' }[extras[0] as string] ?? `Fire ${extras[0]}`;
    return `Fire ${extras.join(' + ')}`;
  });
  /** What went out this round, for the locked-in line. */
  const sentText = $derived.by(() => {
    const shells = sent.filter((o) => o.fire === 'shell').length;
    const parts = [...(shells ? [plural(shells, 'shell')] : []), ...extrasOf(sent)];
    const text = `${parts.join(' + ')} away`;
    return text[0].toUpperCase() + text.slice(1);
  });

  // ── A ghost's trick: one a round, a mine, a false splash or a whisper. Click a cell (a splash then picks its fool; a whisper's is a 3×3's centre); the button sends it ──
  type TrickKind = 'mine' | 'splash' | 'whisper';
  const TRICK_KINDS: readonly TrickKind[] = ['mine', 'splash', 'whisper'];
  let trickKind = $state<TrickKind>('mine');
  /** The cell picked for this round's trick (a mine's, or a splash's before and after its fool). */
  let trickAim = $state<{ at: string; cell: string } | null>(null);
  /** Who a false splash fools. */
  let fool = $state<string | null>(null);
  let trickSending = $state(false);
  const ghostTricks = $derived(legal.filter(isTrick));
  const minesLegal = $derived(ghostTricks.some(isMine));
  const splashLegal = $derived(ghostTricks.some(isSplash));
  const whispersLegal = $derived(ghostTricks.some(isWhisper));
  /** Why a trick is greyed out, said on the board rather than in a tooltip nobody hovers. */
  const afloatSeats = $derived(view.seats.filter((x) => !out(x)).length);
  const mineWhy = $derived(minesLegal ? null : `All ${MINE_LIMIT} of your mines are down: one has to go off before you plant another.`);
  const splashWhy = $derived(
    splashLegal
      ? null
      : afloatSeats < 3
        ? `False splash needs three fleets afloat; only ${afloatSeats === 1 ? 'one is' : `${['no', 'one', 'two'][afloatSeats] ?? afloatSeats} are`} left.`
        : 'False splash needs a sea with at least two ship cells afloat.',
  );
  const whisperWhy = $derived(
    whispersLegal ? null : me && (view.auctions ?? []).some((a) => a.ghost === me) ? 'Your whisper is still up for auction: one at a time.' : 'No living sea to whisper about.',
  );
  const trickOk = (k: TrickKind) => (k === 'mine' ? minesLegal : k === 'splash' ? splashLegal : whispersLegal);
  /** The trick the next click is for: the one you picked, unless it's off the table and another is on offer. */
  const trickNow = $derived<TrickKind>(trickOk(trickKind) ? trickKind : (TRICK_KINDS.find(trickOk) ?? trickKind));
  const trickTest = (k: TrickKind) => (k === 'mine' ? isMine : k === 'splash' ? isSplash : isWhisper);
  const pendingTrick = $derived(view.myTricks?.pending ?? null);
  /** The cells of the shown sea this trick may go on. */
  const trickCells = $derived(new Set(ghostTricks.filter((l) => trickTest(trickNow)(l) && l.at === targetSea).map((l) => l.cell)));
  const trickAimAt = (sea: string | null, cell: string) => !!trickAim && trickAim.at === sea && trickAim.cell === cell;
  /** The living seats a splash on the picked cell may fool (never the sea's owner). */
  const fools = $derived.by(() => {
    const a = trickAim;
    if (!a || trickNow !== 'splash') return [];
    return [...new Set(legal.filter(isSplash).filter((l) => l.at === a.at && l.cell === a.cell).map((l) => l.fool))];
  });
  /** The entry of `legal` the picked trick stands for, once it's whole. */
  const trickCmd = $derived.by(() => {
    const a = trickAim;
    if (!a) return undefined;
    if (trickNow === 'mine') return legal.find((l) => isMine(l) && l.at === a.at && l.cell === a.cell);
    if (trickNow === 'whisper') return legal.find((l) => isWhisper(l) && l.at === a.at && l.cell === a.cell);
    return fool ? legal.find((l) => isSplash(l) && l.at === a.at && l.cell === a.cell && l.fool === fool) : undefined;
  });
  function setTrickKind(k: TrickKind) {
    trickKind = k;
    trickAim = null;
    fool = null;
  }
  /** Click a cell: take back the pick there, or pick it for the trick. */
  function pickTrick(cell: string) {
    if (!targetSea) return;
    if (trickAimAt(targetSea, cell)) {
      trickAim = null;
      fool = null;
    } else if (trickCells.has(cell)) {
      trickAim = { at: targetSea, cell };
      fool = null;
    }
  }
  async function playTrick() {
    const cmd = trickCmd;
    if (!interactive || trickSending || !cmd) return;
    trickSending = true;
    sound?.clink();
    try {
      await onMove($state.snapshot(cmd));
    } finally {
      trickSending = false;
    }
    if (view.myTricks?.pending) {
      trickAim = null;
      fool = null;
    }
  }
  /** Your trick this round, told: "mine at @east e5", "false splash for @south on @east e5". */
  const pendingText = $derived.by(() => {
    const t = pendingTrick;
    if (!t) return '';
    if (t.trick === 'whisper') return `whisper on @${handleOf(t.at)}'s ${areaOf(t.cell)}`;
    return t.trick === 'mine' ? `mine at @${handleOf(t.at)} ${t.cell}` : `false splash for @${handleOf(t.fool ?? '')} on @${handleOf(t.at)} ${t.cell}`;
  });
  /** The mines and false splashes to mark, by `sea cell`: your own live ones and this round's trick (a ghost), every mine left once it's over. */
  const trickMarks = $derived.by(() => {
    const at = new Map<string, { kind: TrickKind; pending: boolean }>();
    const t = view.myTricks;
    // Your mine that went off this volley keeps its skull until its flash plays.
    for (const k of fusing) at.set(k, { kind: 'mine', pending: false });
    // (A pending whisper is an area, not a mark: the auction panel draws it.)
    if (t?.pending && t.pending.trick !== 'whisper') at.set(`${t.pending.at} ${t.pending.cell}`, { kind: t.pending.trick, pending: true });
    for (const x of t?.splashes ?? []) at.set(`${x.sea} ${x.cell}`, { kind: 'splash', pending: false });
    for (const x of t?.mines ?? []) at.set(`${x.sea} ${x.cell}`, { kind: 'mine', pending: false });
    if (!settling) for (const tv of view.targets) for (const x of tv.mines ?? []) at.set(`${tv.sea} ${x.cell}`, { kind: 'mine', pending: false });
    return at;
  });
  /** Your mines that went off in the volley now landing, by `sea cell`, until each one's flash (the new view has already dropped them). */
  let fusing = $state<string[]>([]);
  /** A revealed trick, told as the round summary tells it (handles for seats). */
  function trickText(t: Trick): string {
    if (t.kind === 'splash') return `Dirty trick! The hit ${handleOf(t.fool)} saw on ${handleOf(t.sea)} ${t.cell} was ${handleOf(t.ghost)}'s false splash.`;
    const shell = `${names(t.shooters.map(handleOf))}'s ${t.shooters.length === 1 ? 'shell' : 'shells'}`;
    if (t.result === 'backfire' && t.ship === 'decoy') {
      return `Backfire! ${handleOf(t.ghost)}'s mine was sitting on ${handleOf(t.sea)}'s DECOY. ${shell} ${t.shooters.length === 1 ? 'blows' : 'blow'} it out of the water.`;
    }
    if (t.result === 'backfire') {
      return `Backfire! ${handleOf(t.ghost)}'s mine was sitting on ${handleOf(t.sea)}'s ${t.ship}. ${shell} ${t.shooters.length === 1 ? 'sends' : 'send'} it to the bottom. Thanks for the help, ${handleOf(t.ghost)}.`;
    }
    const back = t.hits.length === 0 ? 'but there was nothing left to hit' : t.hits.map((h) => `it comes back on ${handleOf(h.sea)}'s own sea at ${h.cell}, a hit`).join('; ');
    return `Dirty trick! ${handleOf(t.ghost)}'s mine at ${handleOf(t.sea)} ${t.cell} goes off under ${shell} — ${back}.`;
  }

  // ── Whisper: a ghost's sonar reading, sold in a silent 30-second auction among the living ──
  /** "c3–e5": a whisper's 3×3 by its corners. */
  const areaName = (cells: string[]) => `${cells[0]}–${cells.at(-1)}`;
  const areaOf = (centre: string) => areaName(buoyCells(centre));
  const auctions = $derived(view.auctions ?? []);
  /** The auctions you may bid on (or watch): every open one but your own (a ghost runs its own from its controls). */
  const otherAuctions = $derived(auctions.filter((a) => a.ghost !== me));
  /** Your own open auction, as its ghost. */
  const myAuction = $derived(me ? (auctions.find((a) => a.ghost === me) ?? null) : null);
  const myScrap = $derived(me ? (view.scrap?.[me] ?? 0) : 0);
  const mayBid = (ghost: string) => legal.some((l) => isBid(l) && l.ghost === ghost);
  /**
   * The bid of `n` on a ghost's auction: the entry of `legal` (it lists 0 up to your scrap, capped at 20); above
   * the cap, the same command for any amount you can pay (the rules take any bid up to your scrap).
   */
  const bidCmd = (ghost: string, n: number): BidCmd | undefined =>
    legal.find((l): l is BidCmd => isBid(l) && l.ghost === ghost && l.bid === n) ??
    (mayBid(ghost) && Number.isInteger(n) && n >= 1 && n <= myScrap ? { bid: n, ghost } : undefined);
  const tellCmd = (n: number) => legal.find((l): l is TellCmd => isTell(l) && l.tell === n);
  /** The number your whisper tells the winner (the truth until you set one). */
  const told = $derived(view.myTricks?.whisper ? (view.myTricks.whisper.tell ?? view.myTricks.whisper.truth) : null);
  /** The custom amount typed into each auction's box, by ghost. */
  let customBid = $state<Record<string, number | null>>({});
  let optSending = $state(false);
  /** Send an optional move (a bid or a tell): never owed, so it goes whether or not you're locked in. */
  async function sendOptional(cmd: unknown) {
    if (!canAct || optSending || !cmd) return;
    optSending = true;
    try {
      await onMove($state.snapshot(cmd));
    } finally {
      optSending = false;
    }
  }
  /** Send the typed bid; the box clears only once the bid stands (a refused one stays to be fixed). */
  async function bidCustom(ghost: string, cmd: BidCmd | undefined) {
    if (!cmd) return;
    await sendOptional(cmd);
    if (view.myBids?.[ghost] === cmd.bid) customBid[ghost] = null;
  }
  /** The wall clock, ticking while an auction is open (its close is an epoch time stamped by the server). */
  let now = $state(Date.now());
  $effect(() => {
    if (auctions.length === 0) return;
    now = Date.now();
    const t = setInterval(() => (now = Date.now()), 500);
    return () => clearInterval(t);
  });
  /** Seconds left in an auction: the full 30 until the server stamps its close. */
  const auctionSecs = (closesAt: number | null) => (closesAt === null ? AUCTION_MS / 1000 : Math.max(0, Math.ceil((closesAt - now) / 1000)));
  const auctionTone = (secs: number): 'ready' | 'warn' | 'urgent' => (secs <= 5 ? 'urgent' : secs <= 10 ? 'warn' : 'ready');
  const BID_TEXT = { bid: 'bid', abstained: 'abstained' } as const;
  /** Every whisper with its truth once the match is over: lies first (the ones worth telling), then honest sales, then the rest. */
  const whisperTruths = $derived.by(() => {
    const truths = view.truths ?? [];
    const rank = (t: (typeof truths)[number]) => (t.state === 'sold' ? (t.said !== t.truth ? 0 : 1) : 2);
    return truths.map((t) => ({ ...t, lie: t.state === 'sold' && t.said !== t.truth })).sort((x, y) => rank(x) - rank(y));
  });
  /** The side column's whisper band: the auctions under way (your own, as a ghost, first), or the truths once it's over. */
  const auctionBand = $derived.by(() => live && (otherAuctions.length > 0 || (haunting && !!myAuction)));
  /**
   * The 3×3s to outline, by `sea cell`, with the sides of each cell on the area's edge: your whisper's pick and
   * the one under the pointer, this round's listing, open auctions, and the whispers you bought.
   */
  type AreaState = 'hover' | 'picked' | 'pending' | 'auction' | 'bought';
  const areaMarks = $derived.by(() => {
    const at = new Map<string, { state: AreaState; edges: string }>();
    const put = (sea: string, cells: string[], state: AreaState) => {
      const set = new Set(cells.map((c) => cellIndex(c) ?? -1));
      for (const c of cells) {
        const i = cellIndex(c) ?? 0;
        const edges = [
          i % SIZE === 0 || !set.has(i - 1) ? 'l' : '',
          i % SIZE === SIZE - 1 || !set.has(i + 1) ? 'r' : '',
          !set.has(i + SIZE) ? 't' : '',
          !set.has(i - SIZE) ? 'b' : '',
        ].join('');
        const key = `${sea} ${c}`;
        if (!at.has(key)) at.set(key, { state, edges });
      }
    };
    if (trickAim && trickNow === 'whisper') put(trickAim.at, buoyCells(trickAim.cell), 'picked');
    if (haunting && trickNow === 'whisper' && !pendingTrick && aimHover && targetSea && trickCells.has(aimHover)) put(targetSea, buoyCells(aimHover), 'hover');
    if (pendingTrick?.trick === 'whisper') put(pendingTrick.at, buoyCells(pendingTrick.cell), 'pending');
    if (live) for (const a of auctions) put(a.sea, a.cells, 'auction');
    for (const w of view.whispers ?? []) put(w.sea, w.cells, 'bought');
    return at;
  });
  /** The words you bought, by `sea centre`: a 👻 3? on the area's middle cell. */
  const whisperMarks = $derived.by(() => {
    const at = new Map<string, { ghost: string; said: number; area: string }[]>();
    for (const w of view.whispers ?? []) {
      const key = `${w.sea} ${w.cells[4] ?? w.cells[0]}`;
      at.set(key, [...(at.get(key) ?? []), { ghost: w.ghost, said: w.said, area: areaName(w.cells) }]);
    }
    return at;
  });
  // A whisper you win is told once its volley has landed (or at once, when it closes on the clock).
  let seenWhispers: number | undefined;
  let wonQueue = $state<string[]>([]);
  $effect(() => {
    const list = view.whispers ?? [];
    const before = seenWhispers;
    seenWhispers = list.length;
    if (before === undefined || list.length <= before) return;
    untrack(() => (wonQueue = [...wonQueue, ...list.slice(before).map((w) => `👻 You win ${handleOf(w.ghost)}'s whisper: ${handleOf(w.ghost)} says ${w.said} in ${w.sea === me ? 'your' : `${handleOf(w.sea)}'s`} ${areaName(w.cells)}.`)]));
  });
  $effect(() => {
    if (wonQueue.length === 0 || settling) return;
    const lines = wonQueue;
    untrack(() => {
      wonQueue = [];
      // After a volley, the round's own call ("Round 7 — fire!") goes first.
      const wait = view.lastVolley && taken === volleyRound && plan ? 1800 : 0;
      // Already in the chat as private 👻 lines: the banner only.
      lines.forEach((text, i) => announce({ tone: 'calm', text }, wait + i * TRICK_MS, TRICK_MS, false));
    });
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
  /** 'decoy': a revealed decoy's cell, driftwood. */
  type Mark = 'sea' | 'miss' | 'hit' | 'sunk' | 'ship' | 'decoy';
  interface Hull {
    /** Sides (l r t b) where the hull runs on into the next cell. */
    joins: string;
    wreck: boolean;
    faint: boolean;
    /** Your own live decoy (dashed), or a revealed one (driftwood). */
    decoy?: 'live' | 'drift';
    /** The revealed decoy's first cell carries its DECOY stamp. */
    stamp?: boolean;
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
    // Your live decoy: a dashed hull, its hits like any hit on you.
    if (m.decoy) {
      const joins = joinsOf(m.decoy.cells);
      for (const c of m.decoy.cells)
        cells.set(c, { mark: m.decoy.hits.includes(c) ? 'hit' : 'ship', ship: null, hull: { joins: joins.get(c) ?? '', wreck: false, faint: false, decoy: 'live' } });
    }
    // A hit on your sea with no ship under it was a decoy that has been found: driftwood, paired back into its
    // two-cell hulls (each with the cell beside or above it) so the first of each carries the DECOY stamp.
    const drift = Object.entries(m.shots)
      .filter(([c, r]) => r === 'hit' && !cells.has(c))
      .map(([c]) => cellIndex(c) ?? 0)
      .sort((a, b) => a - b);
    const paired = new Set<number>();
    for (const i of drift) {
      if (paired.has(i)) continue;
      paired.add(i);
      const mate = [i + 1, i + SIZE].find((j) => drift.includes(j) && !paired.has(j) && (j === i + SIZE || j % SIZE !== 0));
      if (mate !== undefined) paired.add(mate);
      const hull = mate === undefined ? [cellName(i)] : [cellName(i), cellName(mate)];
      const joins = joinsOf(hull);
      hull.forEach((c, k) => cells.set(c, { mark: 'decoy', ship: null, hull: { joins: joins.get(c) ?? '', wreck: false, faint: false, decoy: 'drift', stamp: k === 0 } }));
    }
    return cells;
  }

  function targetModel(t: TargetView): Map<string, CellModel> {
    const cells = new Map<string, CellModel>();
    // The hidden fleets come up once the last volley has landed, not while it flies.
    for (const s of settling ? [] : (t.revealed ?? [])) {
      const joins = joinsOf(s.cells);
      for (const c of s.cells) cells.set(c, { mark: 'ship', ship: s.id, hull: { joins: joins.get(c) ?? '', wreck: false, faint: true } });
    }
    for (const c of t.misses) cells.set(c, { ...SEA, mark: 'miss' });
    for (const c of t.hits) cells.set(c, { ...(cells.get(c) ?? SEA), mark: 'hit' });
    for (const s of t.sunk) {
      const joins = joinsOf(s.cells);
      for (const c of s.cells) cells.set(c, { mark: 'sunk', ship: s.ship, hull: { joins: joins.get(c) ?? '', wreck: true, faint: false } });
    }
    for (const d of t.decoys ?? []) {
      const joins = joinsOf(d);
      d.forEach((c, k) => cells.set(c, { mark: 'decoy', ship: null, hull: { joins: joins.get(c) ?? '', wreck: false, faint: false, decoy: 'drift', stamp: k === 0 } }));
    }
    return cells;
  }

  function label(cell: string, m: CellModel, own: boolean): string {
    switch (m.mark) {
      case 'miss':
        return `${cell}, miss`;
      case 'hit':
        return own && m.ship ? `${cell}, ${m.ship}, hit` : own && m.hull?.decoy === 'live' ? `${cell}, your decoy, hit` : `${cell}, hit`;
      case 'sunk':
        return `${cell}, sunk ${m.ship}`;
      case 'decoy':
        return `${cell}, decoy (driftwood)`;
      case 'ship':
        return m.hull?.decoy === 'live' ? `${cell}, your decoy` : `${cell}, ${m.ship}`;
      default:
        return cell;
    }
  }

  const ownCells = $derived(view.mySea ? ownModel(view.mySea) : null);
  /** Your welding sparks (cells you repaired and nobody has shot since), by `sea cell`: a repair is its owner's secret. */
  const sparks = $derived(new Set(me && view.mySea ? (view.mySea.repaired ?? []).map((c) => `${me} ${c}`) : []));
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
  /** The last volley this board has taken in (played, or skipped on first paint): until then, what it brought (a crate) waits. */
  let taken = $state<number | null | undefined>(undefined);
  // A new volley: play it (skipped on first paint, so a reload doesn't replay the last round).
  $effect(() => {
    const r = volleyRound;
    untrack(() => (taken = r));
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
      // Your own mines that went off: their skulls stay until each one's flash.
      const fused = me ? p.mines.filter((m) => m.ghost === me) : [];
      fusing = fused.map((m) => `${m.sea} ${m.cell}`);
      for (const m of fused) {
        const key = `${m.sea} ${m.cell}`;
        bannerTimers.push(setTimeout(() => (fusing = fusing.filter((k) => k !== key)), m.at));
      }
      clearTimeout(clearFx);
      clearFx = setTimeout(() => (plan = null), p.total + 3000);
      // The warning hangs there until the first shell at you lands (and is long enough to read with no motion at all).
      const firstAtYou = Math.min(
        ...p.shells.filter((x) => x.sea === me).map((x) => x.landAt),
        ...p.items.flatMap((x) => (x.item === 'cluster' && x.sea === me ? [x.landAt] : x.item === 'torpedo' && x.sea === me ? [x.steps[0] ?? x.at] : [])),
      );
      const warnFor = !atSea ? 0 : reduced ? 2500 : Number.isFinite(firstAtYou) ? firstAtYou : p.lead + 900;
      if (atSea && me) {
        const { count, items, from, buoys } = incoming(v, me);
        const sonar = buoys === 1 ? '1 sonar buoy' : `${buoys} sonar buoys`;
        const kinds = [...new Set(items)].map((x) => {
          const n = items.filter((y) => y === x).length;
          return n === 1 ? `a ${x}` : `${n} ${x === 'torpedo' ? 'torpedoes' : `${x}s`}`;
        });
        const what = [...(count > 0 ? [`${count} ${count === 1 ? 'shell' : 'shells'}`] : []), ...kinds].join(' + ');
        announce(
          what
            ? { tone: 'hot', text: `⚠ ${what[0].toUpperCase()}${what.slice(1)} incoming on your sea — from ${names(from.map(handleOf))}${buoys ? ` · ${sonar}` : ''}` }
            : buoys > 0
              ? { tone: 'calm', text: `No shells at you — but ${buoys === 1 ? 'a sonar buoy' : sonar} splashed down nearby.` }
              : { tone: 'calm', text: 'Quiet waters: nothing aimed at you this round.' },
          0,
          warnFor,
          !!what || buoys > 0,
        );
      }
      // The tricks, told as they play out (after the warning, one at a time): a mine as it goes off, a false splash as the volley opens.
      const tells: { b: Banner; at: number }[] = [];
      for (const t of v.tricks ?? []) {
        if (t.kind === 'splash') {
          tells.push({ b: { tone: 'hot', text: trickText(t) }, at: p.lead });
          continue;
        }
        const at = p.mines.find((m) => m.ghost === t.ghost && m.sea === t.sea && m.cell === t.cell)?.at ?? p.lead;
        if (me && t.result === 'boomerang' && t.hits.some((h) => h.sea === me)) {
          tells.push({ b: { tone: 'hot', text: `⚠ A mine under your shell at ${handleOf(t.sea)} ${t.cell} — it came back on your sea!` }, at });
        }
        tells.push({ b: { tone: t.result === 'backfire' ? 'go' : 'hot', text: trickText(t) }, at });
      }
      let told = warnFor;
      for (const x of tells.sort((a, b) => a.at - b.at)) {
        const at = Math.max(x.at, told);
        announce(x.b, at, TRICK_MS);
        told = at + TRICK_MS;
      }
      const after = Math.max(p.total, warnFor, tells.length ? told : 0) + 400;
      // Your last ship went down in this volley: once it (and its tricks) have landed, the ghost card says what you are now.
      const sunkNow = atSea && !!me && v.eliminated.includes(me) && view.phase !== 'over';
      if (sunkNow && me) {
        const card = { sinkers: sinkersOf(v, me), round: view.round };
        bannerTimers.push(
          setTimeout(() => {
            if (live && amGhost) ghostCard = card;
          }, after),
        );
      } else openRound(after);
      settling = true;
      clearTimeout(settleTimer);
      settleTimer = setTimeout(() => (settling = false), Math.max(p.total, warnFor) + 400);
    });
  });
  let settleTimer: ReturnType<typeof setTimeout> | undefined;

  // ── The ghost card: who sank you, the mission and the two tricks, until you press Haunt them ──
  let ghostCard = $state<{ sinkers: string; round: number } | null>(null);
  let ghostBtn: HTMLButtonElement | undefined = $state();
  /** Who sank your last ship(s) in this volley: the shooters credited, a ghost by its mine. */
  function sinkersOf(v: Volley, me: string): string {
    const mineGhosts = new Set((v.tricks ?? []).filter((t) => t.kind === 'mine' && t.result === 'boomerang' && t.hits.some((h) => h.sea === me)).map((t) => t.ghost));
    const by = [...new Set(v.sunk.filter((x) => x.sea === me).flatMap((x) => x.by))];
    const named = by.map((s) => (mineGhosts.has(s) ? `@${handleOf(s)}'s mine` : `@${handleOf(s)}`));
    return names(named.length ? named : ['the volley']);
  }
  // The match ending (or the ghost fading) takes the card away.
  $effect(() => {
    if (!(live && amGhost)) ghostCard = null;
  });
  // Open, it takes the focus (so Escape reaches it), unless you're typing in the chat.
  $effect(() => {
    if (ghostCard && ghostBtn && !typing(document.activeElement)) ghostBtn.focus({ preventScroll: true });
  });
  function ghostKey(e: KeyboardEvent) {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    ghostCard = null;
  }
  $effect(() => () => {
    clearTimeout(clearFx);
    clearTimeout(settleTimer);
  });

  // ── The crate: three cards from a ship you sank, owed until you pick one (or swap, or pass) ──
  type CrateCmd = Extract<SalvoCommand, { crate: unknown }>;
  const isCrate = (l: unknown): l is CrateCmd => typeof l === 'object' && l !== null && 'crate' in l;
  /** What each card does, on the crate card (the guide's words). */
  const ITEM_LINE: Record<ItemId, string> = {
    cluster: 'A plus of five cells. Deadly next to a hit.',
    torpedo: 'Runs a lane from your side to the first ship; the water it passes shows.',
    repair: 'Patch one hit on your own ship.',
    decoy: 'A fake two-cell ship. Hits on it look real.',
  };
  const crate = $derived(live && !amOut ? (view.myArsenal?.crate ?? null) : null);
  const crateLegal = $derived(legal.filter(isCrate));
  /** Your hands are full: a card costs one of the items you hold. */
  const handsFull = $derived(held.length >= ITEM_LIMIT);
  /** The held kinds you could give up, once each. */
  const droppable = $derived([...new Set(held)]);
  const takeCmd = (card: ItemId, drop?: ItemId) => crateLegal.find((l) => l.crate === card && (l as { drop?: ItemId }).drop === drop);
  const passCmd = $derived(crateLegal.find((l) => l.crate === 'pass'));
  /** The crate card is put away (the crate stays owed, a 📦 button in the tray brings it back). A new crate opens it again. */
  let crateAway = $state(false);
  const crateKey = $derived(crate ? `${view.round} ${crate.join(' ')}` : '');
  $effect(() => {
    void crateKey;
    crateAway = false;
  });
  let crateSending = $state(false);
  /** It shows once the volley that dealt it has landed (and at once on a reload: it's owed). */
  const crateShown = $derived(!!crate && !crateAway && taken === volleyRound && !settling);
  let crateEl: HTMLDivElement | undefined = $state();
  // Open, it takes the focus (so Escape reaches it and Tab walks its cards), unless you're typing in the chat.
  $effect(() => {
    if (crateShown && crateEl && !typing(document.activeElement)) crateEl.focus({ preventScroll: true });
  });
  async function openCrate(cmd: unknown) {
    if (!interactive || crateSending || !cmd) return;
    crateSending = true;
    sound?.clink();
    try {
      await onMove($state.snapshot(cmd));
    } finally {
      crateSending = false;
    }
    // A second crate in the queue opens on its own.
    crateAway = false;
  }
  function crateKeydown(e: KeyboardEvent) {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    crateAway = true;
  }

  // ── The turn clock: the round's seconds, calm → amber at 20 → red and pulsing at 10, a tick each of the last 5 ──
  /** Whether you still owe this round: your salvo (or trick) and any open crate. */
  const clockState = $derived.by<'ticking' | 'locked' | null>(() => {
    if (!live || !me || secondsLeft === null || view.phase !== 'fire') return null;
    if (amOut && !haunting) return null;
    const owing = toMove ? toMove.includes(me) : !view.ready.includes(me);
    return owing ? 'ticking' : 'locked';
  });
  const clockTone = $derived<'ready' | 'warn' | 'urgent'>((secondsLeft ?? TURN_SECONDS) <= 10 ? 'urgent' : (secondsLeft ?? TURN_SECONDS) <= 20 ? 'warn' : 'ready');
  let tickedAt: number | null = null;
  $effect(() => {
    const secs = secondsLeft;
    if (clockState !== 'ticking' || secs === null || secs > 5 || secs <= 0 || secs === tickedAt) return;
    tickedAt = secs;
    untrack(() => sound?.tick(secs === 1));
  });

  // ── Banners: the warning before a volley, the tricks, and the call to fire when a round opens ──
  /** `call`: the round's "fire!", gone as soon as anything newer goes up. */
  type Banner = { tone: 'hot' | 'calm' | 'go'; text: string; call?: boolean };
  /** How long a trick's banner stays up (they're long lines). */
  const TRICK_MS = 3600;
  /** Banners on show stack, newest last; past this many the oldest goes. */
  const BANNERS_MAX = 3;
  let banners = $state<(Banner & { key: number })[]>([]);
  let bannerKey = 0;
  const bannerTimers: ReturnType<typeof setTimeout>[] = [];
  /** A banner from `afterMs` for `forMs`; `tell` also writes it into your table chat as it goes up (not the round's call). */
  function announce(b: Banner, afterMs: number, forMs: number, tell = true) {
    const key = (bannerKey += 1);
    bannerTimers.push(
      setTimeout(() => {
        banners = [...banners.filter((x) => !x.call), { ...b, key }].slice(-BANNERS_MAX);
        if (b.tone === 'hot') sound?.pop(-7);
        if (tell) onTell?.({ tone: b.tone, text: b.text });
      }, afterMs),
      setTimeout(() => dismiss(key), afterMs + forMs),
    );
  }
  const dismiss = (key: number) => (banners = banners.filter((x) => x.key !== key));
  /** "Round 7 — fire!" once the volley has played out (if the match goes on and you're still afloat). */
  function openRound(afterMs: number) {
    bannerTimers.push(
      setTimeout(() => {
        if (view.phase !== 'fire') return;
        announce({ tone: 'go', text: me && !out(me) ? `Round ${view.round} — fire!` : `Round ${view.round}`, call: true }, 0, 1600, false);
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
  /** When each cell's new result shows: as its shell lands, with the flash that took it, a cluster's plus, a torpedo's run, a boomerang. */
  const landing = $derived(plan ? landingTimes(plan) : new Map<string, number>());
  /** When a revealed decoy's stamp comes down, and a repair's spark flies, by `sea cell`. */
  const itemAt = $derived.by(() => {
    const at = new Map<string, number>();
    for (const x of plan?.items ?? []) {
      if (x.item === 'decoy') for (const c of x.cells) at.set(`${x.sea} ${c}`, x.at);
      else if (x.item === 'repair' && x.cell) at.set(`${x.from} ${x.cell}`, x.at);
    }
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
    for (const x of p.items) {
      if (x.item === 'cluster') {
        sound.thud(x.landAt / 1000);
        sound.pop(6, x.landAt / 1000 + 0.06);
        sound.pop(10, x.landAt / 1000 + 0.12);
      } else if (x.item === 'torpedo') {
        sound.pop(-10, x.at / 1000);
        if (x.struck) sound.thud(x.end / 1000);
      } else if (x.item === 'repair') sound.pop(16, x.at / 1000);
      else if (x.item === 'decoy') sound.pop(-2, x.at / 1000);
    }
    for (const m of p.mines) {
      sound.thud(m.at / 1000 + 0.05);
      sound.pop(-4, m.at / 1000 + 0.05);
      for (const r of m.returns) sound.thud(r.at / 1000);
    }
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
    if (e.button !== 0 || (e.target as Element).closest('.pill, .ghostcard, .cratecard')) return;
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
  /** Your fleet fills the room its section has (the section's height, less the heading and the legend): in the
   *  wide column its row takes what the others leave, so an auction above it shrinks it rather than the controls. */
  const ownCell = $derived(Math.max(12, Math.min(34, Math.floor((Math.min(ownBox.w, ownBox.h - (wide && auctionBand ? 30 : 52)) - 14) / SIZE) || 24)));

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

  /** 'repair': your fleet's hits take a click; 'decoy': your own sea, big, takes the decoy. */
  type Mode = 'fire' | 'deploy' | 'view' | 'trick' | 'repair' | 'decoy';
  /** A fire cell takes a click if it holds an aim (to take it back), or is legal and a gun is free (a buoy or an item can always move). */
  const fireable = (cell: string) => {
    if (sending) return false;
    const here = aimOn(targetSea, cell);
    if (aimKind === 'torpedo') {
      const lane = laneOf(cell);
      const mine = itemAim?.fire === 'torpedo' && itemAim.at === targetSea && itemAim.lane === lane;
      return mine || (torpedoLanes.has(lane) && (room > 0 || !!itemAim));
    }
    if (aimKind === 'cluster') return (!!here && here.fire !== 'shell') || (clusterCentres.has(cell) && (room > 0 || !!itemAim || here?.fire === 'shell'));
    return !!here || (aimable(aimKind, cell) && (room > 0 || (aimKind === 'buoy' && buoyAimed)));
  };
  const repairable = (cell: string) => !sending && ((itemAim?.fire === 'repair' && itemAim.cell === cell) || (repairCells.has(cell) && (room > 0 || !!itemAim)));
  const decoyable = (cell: string) => !sending && (decoyAimCells.includes(cell) || (decoySpots.has(cell) && (room > 0 || !!itemAim)));
  /** A trick cell takes a click if it holds the pick (to take it back), or the trick may go there; not once this round's is set. */
  const trickable = (cell: string) => !trickSending && !pendingTrick && (trickAimAt(targetSea, cell) || trickCells.has(cell));
  const enabled = (mode: Mode, cell: string) =>
    interactive &&
    (mode === 'fire'
      ? fireable(cell)
      : mode === 'deploy'
        ? placeable.has(cell)
        : mode === 'trick'
          ? trickable(cell)
          : mode === 'repair'
            ? repairable(cell)
            : mode === 'decoy'
              ? decoyable(cell)
              : false);
  function press(mode: Mode, cell: string) {
    if (suppress || !enabled(mode, cell)) return;
    if (mode === 'fire') toggle(cell);
    else if (mode === 'repair') pickRepair(cell);
    else if (mode === 'decoy') pickDecoy(cell);
    else if (mode === 'trick') pickTrick(cell);
    else if (mode === 'deploy') place(cell);
  }
  function keydown(e: KeyboardEvent, mode: Mode, cell: string, k: number) {
    if (e.key === 'Enter' && mode === 'fire' && aimOn(targetSea, cell)) {
      e.preventDefault();
      void fire();
      return;
    }
    if (e.key === 'Enter' && mode === 'trick' && trickAimAt(targetSea, cell) && trickCmd) {
      e.preventDefault();
      void playTrick();
      return;
    }
    step(e, k);
  }

  /** The seats still owing this round: the match's own list when the page passes it; else the living and the ghosts
   *  not yet ready (a ghost with no trick to play, rare, is counted too: the view doesn't say). */
  const owes = (s: string) => (toMove ? toMove.includes(s) : (!out(s) || ghostOf(s)) && !view.ready.includes(s));
  /**
   * Locking in your salvo (or trick) may land the volley, and that closes every auction at once, whatever the
   * ring says: while you owe, an open auction you haven't touched gets a nudge by the button (never a block).
   */
  const bidFirst = $derived(!!me && live && owes(me) && otherAuctions.some((a) => mayBid(a.ghost) && !a.bids[me!]));
  /** The same for a ghost whose own auction is open and whose number is still the default (the truth). */
  const tellFirst = $derived(!!me && live && owes(me) && !!myAuction && view.myTricks?.whisper?.tell === null);
  /** Those still owing, besides you. */
  const waitingFor = $derived(view.seats.filter((s) => s !== me && owes(s)).map(handleOf));
  /** The one seat everybody is waiting on, when it comes to that. */
  const holdout = $derived.by(() => {
    const living = view.seats.filter((s) => !out(s));
    const owing = view.seats.filter(owes);
    return live && living.length > 1 && owing.length === 1 ? owing[0] : null;
  });
  const stateOf = (seat: string) =>
    out(seat) ? (live && ghostOf(seat) ? (view.ready.includes(seat) ? 'haunting' : 'ghost') : 'out') : view.winner === seat && !settling ? 'winner' : !live ? '' : view.ready.includes(seat) ? (view.phase === 'deploy' ? 'deployed' : 'locked') : view.phase === 'deploy' ? 'deploying' : 'aiming';
  const STATE_TEXT: Record<string, string> = { locked: 'locked in', out: 'sunk', ghost: '👻 ghost', haunting: '👻 up to something…' };
  /** You're a ghost with the board to haunt: not while the volley that sank you is still landing. */
  const haunting = $derived(live && amGhost && !(settling && !!me && !!view.lastVolley?.eliminated.includes(me)));
  const mainSea = $derived(deploying || placingDecoy ? me : targetSea);
  /** The decoy's hull under the pointer while you lay it. */
  const decoyPreview = $derived.by(() => {
    if (!placingDecoy || !hover || !interactive) return null;
    const cells = hullCells(hover, 2, decoyFacing);
    return { cells: new Set(cells ?? [hover]), ok: !!cells && decoySpots.has(hover) };
  });
</script>

{#snippet clock(id = 'turn-clock')}
  {#if clockState === 'ticking' && secondsLeft !== null}
    <span class="tclock" data-testid={id} data-state="ticking" data-tone={clockTone}
      ><CountdownRing remaining={secondsLeft / TURN_SECONDS} secs={secondsLeft} size={32} tone={clockTone} label="{secondsLeft} seconds left in round {view.round}" /></span
    >
  {:else if clockState === 'locked'}
    <span class="tclock locked" data-testid={id} data-state="locked" role="img" aria-label="Locked in: nothing owed this round" title="Locked in: nothing owed this round">✓</span>
  {/if}
{/snippet}

{#snippet auctionClock(a: SalvoView['auctions'][number], id: string)}
  {@const secs = auctionSecs(a.closesAt)}
  <span class="au-clock" data-testid={id} data-secs={secs}>
    {#if secs > 0}
      <CountdownRing remaining={secs / (AUCTION_MS / 1000)} {secs} size={26} tone={auctionTone(secs)} label="{secs} seconds left in {handleOf(a.ghost)}'s auction" />
    {:else}
      <span class="au-closing">closing…</span>
    {/if}
  </span>
{/snippet}

{#snippet bidders(a: SalvoView['auctions'][number])}
  <ul class="au-bids" aria-label="Who has bid">
    {#each Object.entries(a.bids) as [seat, st] (seat)}
      {@const mine = seat === me ? view.myBids?.[a.ghost] : undefined}
      <li class="au-bid st-{st ?? 'none'}" data-testid="auction-status" data-seat={seat} data-status={st ?? 'none'}>
        <span class="name" class:human={humanSeat(seat)} title={handleOf(seat)}>{seat === me ? 'you' : handleOf(seat)}</span>
        <span class="st">{mine ? `bid ${mine}` : st ? BID_TEXT[st] : '—'}</span>
      </li>
    {/each}
  </ul>
{/snippet}

{#snippet auctionCard(a: SalvoView['auctions'][number])}
  {@const mine = me ? (view.myBids?.[a.ghost] ?? 0) : 0}
  {@const status = me ? a.bids[me] : undefined}
  {@const bidder = !!me && status !== undefined}
  {@const can = canAct && !optSending && mayBid(a.ghost)}
  {@const custom = customBid[a.ghost] ?? null}
  {@const customCmd = custom !== null && custom !== mine ? bidCmd(a.ghost, custom) : undefined}
  <div class="auction" class:onsea={targetSea === a.sea} data-testid="auction" data-ghost={a.ghost} data-sea={a.sea}>
    <div class="au-head">
      <p class="au-title">👻 30-second ghost intel auction</p>
      {@render auctionClock(a, 'auction-clock')}
    </div>
    <p class="au-what" data-testid="auction-what">
      <span class="who-g">@{handleOf(a.ghost)}</span>'s reading on
      {#if a.sea === me}<strong>your</strong> sea{:else}<button type="button" class="au-sea" class:human={humanSeat(a.sea)} aria-pressed={targetSea === a.sea} title="Show this sea" onclick={() => (picked = a.sea)}>@{handleOf(a.sea)}</button>'s sea{/if}, <strong>{areaName(a.cells)}</strong>
    </p>
    {#if bidder}
      <p class="hint au-close" data-testid="auction-close-note">Closes when this round's volley lands, if that's sooner — bid before you lock in.</p>
      <div class="au-mine">
        <span data-testid="auction-mybid">{#if mine > 0}Your sealed bid: <strong>{mine}</strong>{:else if status === 'abstained'}You abstained.{:else}No bid yet{a.sea === me ? ': bid to bury it' : '.'}{/if}</span>
        {#if mine > 0}
          <button type="button" class="au-btn quiet" data-testid="auction-withdraw" disabled={!can || !bidCmd(a.ghost, 0)} onclick={() => void sendOptional(bidCmd(a.ghost, 0))}>Withdraw</button>
        {:else if status !== 'abstained'}
          <button type="button" class="au-btn quiet" data-testid="auction-abstain" disabled={!can || !bidCmd(a.ghost, 0)} onclick={() => void sendOptional(bidCmd(a.ghost, 0))}>Abstain</button>
        {/if}
      </div>
      <div class="au-ctl" role="group" aria-label="Your bid on {handleOf(a.ghost)}'s whisper">
        {#each [1, 2, 5] as n (n)}
          {@const cmd = bidCmd(a.ghost, mine + n)}
          <button type="button" class="au-btn" data-testid="auction-bid-{n}" disabled={!can || !cmd} title={cmd ? `Bid ${mine + n}` : `You have ${myScrap} scrap`} onclick={() => void sendOptional(cmd)}>+{n}</button>
        {/each}
        <span class="au-custom">
          <input
            type="number"
            min="1"
            max={myScrap}
            placeholder="≤{myScrap}"
            aria-label="Custom bid, up to your {myScrap} scrap"
            data-testid="auction-custom"
            value={custom ?? ''}
            oninput={(e) => {
              const v = (e.currentTarget as HTMLInputElement).valueAsNumber;
              customBid[a.ghost] = Number.isFinite(v) ? v : null;
            }}
            onkeydown={(e) => {
              if (e.key === 'Enter' && customCmd) {
                e.preventDefault();
                void bidCustom(a.ghost, customCmd);
              }
            }}
          /><button type="button" class="au-btn" data-testid="auction-bid-custom" disabled={!can || !customCmd} onclick={() => void bidCustom(a.ghost, customCmd)}>Bid</button>
        </span>
      </div>
    {/if}
    {@render bidders(a)}
  </div>
{/snippet}

{#snippet myWhisper(a: SalvoView['auctions'][number])}
  {@const w = view.myTricks?.whisper}
  <div class="auction mine" class:onsea={targetSea === a.sea} data-testid="my-auction" data-sea={a.sea}>
    <div class="au-head">
      <p class="au-title">👻 Your whisper is up for auction</p>
      {@render auctionClock(a, 'my-auction-clock')}
    </div>
    <p class="au-what">
      <button type="button" class="au-sea" class:human={humanSeat(a.sea)} aria-pressed={targetSea === a.sea} title="Show this sea" onclick={() => (picked = a.sea)}>@{handleOf(a.sea)}</button>'s sea, <strong>{areaName(a.cells)}</strong>
      {#if w}· <span class="au-truth" data-testid="whisper-truth">Truth: {w.truth}</span>{/if}
    </p>
    {#if w}
      <div class="tells" role="group" aria-label="The number you tell the winner">
        <span class="au-tell-head" aria-hidden="true">Tell</span>
        {#each { length: TELL_MAX + 1 } as _, n (n)}
          {@const cmd = tellCmd(n)}
          <button type="button" class="tell" class:truth={n === w.truth} data-testid="tell-{n}" aria-pressed={told === n} disabled={!canAct || optSending || !cmd} onclick={() => void sendOptional(cmd)}>{n}</button>
        {/each}
      </div>
      <p class="hint au-lie" data-testid="tell-note">{told === w.truth ? 'The truth.' : 'A lie: the truth comes out at the end.'}</p>
      <p class="hint au-close" data-testid="my-auction-close-note">Closes when this round's volley lands, if that's sooner — set your number before you lock in.</p>
    {/if}
    {@render bidders(a)}
  </div>
{/snippet}

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
          {@const ghost = mode === 'deploy' ? preview?.cells.has(cell) : mode === 'decoy' && decoyPreview?.cells.has(cell)}
          {@const ghostBad = mode === 'deploy' ? !preview?.ok : !decoyPreview?.ok}
          {@const pm = mode === 'fire' ? plusMarks.get(cell) : undefined}
          {@const lm = mode === 'fire' ? laneMarks.get(cell) : undefined}
          {@const om = own ? ownMarks.get(cell) : undefined}
          {@const spark = sparks.has(`${seat} ${cell}`)}
          {@const sparkAt = itemAt.get(`${seat} ${cell}`)}
          {@const reading = intel ? sonarAt.get(cell) : undefined}
          {@const tm = trickMarks.get(`${seat} ${cell}`)}
          {@const am = areaMarks.get(`${seat} ${cell}`)}
          {@const wm = whisperMarks.get(`${seat} ${cell}`)}
          {#if main && k % SIZE === 0}<span class="tag row" aria-hidden="true">{SIZE - Math.floor(k / SIZE)}</span>{/if}
          <button
            type="button"
            data-cell={cell}
            data-mark={m.mark}
            aria-label={label(cell, m, own) +
              (reading ? `, sonar buoy: ${reading.afloat} afloat around it` : '') +
              (tm ? (tm.kind === 'mine' ? ', mine' : ', false splash') : '') +
              (wm ? wm.map((w) => `, 👻 ${handleOf(w.ghost)} says ${w.said} ship cells in ${w.area}`).join('') : '') +
              (spark ? ', repaired' : '') +
              (om ? `, ${om.kind} ${om.state === 'sent' ? 'sent' : 'aimed'}` : '')}
            aria-disabled={!ok}
            title={wm ? wm.map((w) => `👻 @${handleOf(w.ghost)} says ${w.said}`).join('\n') : undefined}
            aria-pressed={mode === 'fire'
              ? !!aimOn(seat, cell) || (lm?.state === 'picked')
              : mode === 'trick'
                ? trickAimAt(seat, cell)
                : mode === 'repair' || mode === 'decoy'
                  ? om?.state === 'picked'
                  : undefined}
            data-legal={mode === 'trick'
              ? (trickCells.has(cell) ? 'true' : 'false')
              : mode === 'repair'
                ? String(repairCells.has(cell))
                : mode === 'decoy'
                  ? String(decoySpots.has(cell))
                  : undefined}
            onclick={() => press(mode, cell)}
            onkeydown={(e) => keydown(e, mode, cell, k)}
            onpointerenter={() => (mode === 'deploy' || mode === 'decoy' ? (hover = cell) : (mode === 'fire' || mode === 'trick') && (aimHover = cell))}
            onpointerleave={() => (mode === 'deploy' || mode === 'decoy' ? hover === cell && (hover = null) : aimHover === cell && (aimHover = null))}
            onfocus={() => (mode === 'deploy' || mode === 'decoy' ? (hover = cell) : (mode === 'fire' || mode === 'trick') && (aimHover = cell))}
            onblur={() => (mode === 'fire' || mode === 'trick') && aimHover === cell && (aimHover = null)}
          >
            <span class="water" class:up={intel && liftedHere.has(Number(cell.slice(1)))}></span>
            {#if m.hull}
              {@const j = m.hull.joins}
              <span
                class="hull"
                class:wreck={m.hull.wreck}
                class:faint={m.hull.faint}
                class:decoy={m.hull.decoy === 'live'}
                class:drift={m.hull.decoy === 'drift'}
                class:jl={j.includes('l')}
                class:jr={j.includes('r')}
                class:jt={j.includes('t')}
                class:jb={j.includes('b')}
              ></span>
            {/if}
            {#if m.mark === 'miss'}<span class="ripple" class:land={land !== undefined} style:--d="{land ?? 0}ms"><i></i></span>{/if}
            {#if m.mark === 'hit' || m.mark === 'sunk' || m.mark === 'decoy'}
              <span class="glow" class:drift={m.mark === 'decoy'} class:land={land !== undefined} style:--d="{land ?? 0}ms"></span>
            {/if}
            {#if m.hull?.stamp}
              {@const at = itemAt.get(`${seat} ${cell}`)}
              <span class="dstamp" class:land={at !== undefined} style:--d="{at ?? 0}ms" data-testid="decoy-stamp">DECOY</span>
            {/if}
            {#if spark}<span class="weld" class:land={sparkAt !== undefined} style:--d="{sparkAt ?? 0}ms" data-testid="repaired"></span>{/if}
            {#if pm}<span class="plus s-{pm.state}" class:centre={pm.centre} data-testid={pm.centre && pm.state !== 'hover' ? 'cluster-aim' : undefined}></span>{/if}
            {#if lm}
              <span class="lane s-{lm.state}" class:entry={lm.head} class:bad={lm.bad} style:--dir="{me ? torpedoDir(me) : 0}deg" data-testid={lm.state === 'hover' ? 'lane-preview' : 'torpedo-lane'}
                ><i></i></span
              >
            {/if}
            {#if om?.kind === 'repair'}<span class="weld aim" class:sent={om.state === 'sent'} data-testid="repair-aim"></span>{/if}
            {#if om?.kind === 'decoy'}
              <span
                class="hull decoy aim"
                class:sent={om.state === 'sent'}
                class:jl={om.joins.includes('l')}
                class:jr={om.joins.includes('r')}
                class:jt={om.joins.includes('t')}
                class:jb={om.joins.includes('b')}
                data-testid="decoy-aim"
              ></span>
            {/if}
            {#if sinking !== undefined}
              <span class="bubbles" style:--d="{sinking}ms"><i></i><i></i><i></i></span>
            {/if}
            {#if ghost}<span class="hull-preview" class:decoy={mode === 'decoy'} class:bad={ghostBad} data-testid={mode === 'decoy' ? 'decoy-preview' : undefined}></span>{/if}
            {#if mode === 'fire' && aimAt(seat, cell, 'shell')}<span class="reticle"></span>
            {:else if mode === 'fire' && aimAt(seat, cell, 'buoy')}<span class="reticle buoy"></span>
            {:else if mode === 'fire' && aimAt(seat, cell, 'cluster')}<span class="reticle cluster"></span>
            {:else if mode === 'fire' && sentAt(seat, cell)}<span class="reticle sent" data-testid="sent"></span>
            {:else if mode === 'trick' && trickAimAt(seat, cell)}<span class="reticle trick" data-testid="trick-aim"></span>{/if}
            {#if tm}<span class="tmark m-{tm.kind}" class:pending={tm.pending} data-testid="mark-{tm.kind}">{tm.kind === 'mine' ? '💀' : '👻'}</span>{/if}
            {#if am}
              <span
                class="area s-{am.state}"
                class:el={am.edges.includes('l')}
                class:er={am.edges.includes('r')}
                class:et={am.edges.includes('t')}
                class:eb={am.edges.includes('b')}
                data-area={am.state}
              ></span>
            {/if}
            {#each wm ?? [] as w, i (i)}<span class="wmark" data-testid="whisper-mark" data-ghost={w.ghost} data-said={w.said}>👻 {w.said}?</span>{/each}
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
              <!-- A mine going off on its sea, and its boomerang landing on the shooter's own. -->
              {#each plan.mines.filter((x) => x.sea === seat) as x, n (n)}
                {@const c = centre(x.cell, size, g)}
                <i class="flash mine" style:left="{c.x}px" style:top="{c.y}px" style:--d="{x.at}ms"></i>
              {/each}
              {#each plan.mines.flatMap((x) => x.returns).filter((r) => r.sea === seat) as r, n (n)}
                {@const c = centre(r.cell, size, g)}
                <i class="flash mine back" style:left="{c.x}px" style:top="{c.y}px" style:--d="{r.at}ms"></i>
              {/each}
              <!-- Items: a cluster flies in like a shell and bursts into its plus; a torpedo runs its lane; a repair sparks. -->
              {#each plan.items.filter((x) => x.item === 'cluster' && x.sea === seat) as x, n (n)}
                {#if x.item === 'cluster'}
                  {@const c = centre(x.cell, size, g)}
                  {@const [fx, fy] = FROM[x.side]}
                  <span
                    class="shell big"
                    style:left="{c.x}px"
                    style:top="{c.y}px"
                    style:--sx="{fx * size}px"
                    style:--sy="{fy * size}px"
                    style:--fly="{x.flightMs}ms"
                    style:--d="{x.delay}ms"
                    style:--c={kindColor(x.from)}
                  >
                    <i class="shade"></i>
                    <span class="arc"><span class="bb"><i class="ball"></i></span></span>
                  </span>
                  {#each x.cells as cell (cell)}
                    {@const p = centre(cell, size, g)}
                    <i class="flash plus" style:left="{p.x}px" style:top="{p.y}px" style:--d="{x.landAt}ms"></i>
                  {/each}
                {/if}
              {/each}
              {#each plan.items.filter((x) => x.item === 'torpedo' && x.sea === seat) as x, n (n)}
                {#if x.item === 'torpedo' && x.path.length > 0}
                  {@const a = centre(x.path[0], size, g)}
                  {@const b = centre(x.path.at(-1)!, size, g)}
                  {@const dir = torpedoDir(x.from)}
                  {@const ux = Math.round(Math.cos((dir * Math.PI) / 180))}
                  {@const uy = Math.round(Math.sin((dir * Math.PI) / 180))}
                  <!-- It sets off a cell outside the sea and runs to its last cell (struck, or off the far edge). -->
                  <span
                    class="torp"
                    style:left="{a.x - ux * size}px"
                    style:top="{a.y - uy * size}px"
                    style:--tx="{b.x - a.x + ux * size * (x.struck ? 1 : 2)}px"
                    style:--ty="{b.y - a.y + uy * size * (x.struck ? 1 : 2)}px"
                    style:--run="{x.end - x.at + (x.struck ? 0 : TORPEDO_STEP_MS)}ms"
                    style:--d="{x.at}ms"
                    style:--dir="{dir}deg"
                    style:--c={kindColor(x.from)}><i></i></span
                  >
                  {#if x.struck}
                    {@const h = centre(x.struck, size, g)}
                    <i class="flash torp-hit" style:left="{h.x}px" style:top="{h.y}px" style:--d="{x.end}ms"></i>
                  {/if}
                {/if}
              {/each}
              {#each plan.items.filter((x) => x.item === 'repair' && x.from === seat) as x, n (n)}
                {#if x.item === 'repair' && x.cell}
                  {@const c = centre(x.cell, size, g)}
                  <i class="flash weld-fx" style:left="{c.x}px" style:top="{c.y}px" style:--d="{x.at}ms"></i>
                {/if}
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
        class:m-aim={!!aimOn(t.sea, cell)}
        class:m-out={!!sent.find((o) => o.at === t.sea && o.cell === cell && o.fire !== 'torpedo')}
        class:m-mine={trickMarks.get(`${t.sea} ${cell}`)?.kind === 'mine' || (trickAimAt(t.sea, cell) && trickNow === 'mine')}
        class:m-splash={trickMarks.get(`${t.sea} ${cell}`)?.kind === 'splash' || (trickAimAt(t.sea, cell) && trickNow === 'splash')}
        class:land={land !== undefined}
        style:--d="{land ?? 0}ms"
      ></i>
    {/each}
    {#if n > 0}<b class="aimed" data-testid="aimed">{n}</b>{/if}
  </span>
{/snippet}

<div class="salvo" class:fit class:deploying bind:this={rootEl}>
  <div class="banners" aria-live="polite">
    {#each banners as b (b.key)}
      <p class="banner {b.tone}">
        <span data-testid="banner">{b.text}</span><button type="button" class="banner-x" aria-label="Close this message" onclick={() => dismiss(b.key)}>✕</button>
      </p>
    {/each}
  </div>

  <div class="layout">
  <div class="stage" class:dragging bind:this={stageEl} onpointerdown={down} role="presentation">
    {#if mainSea}
      <p class="caption">
        {#if deploying}
          <span class="kicker">Your sea</span><span class="sub">place your fleet</span>
        {:else if placingDecoy}
          <span class="kicker">Your sea</span><span class="sub">lay a decoy · facing {decoyFacing} (R turns it)</span>
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
    {:else if placingDecoy && ownCells && me}
      {@render sea(me, ownCells, mainCell, true, 'decoy', true)}
    {:else if target && targetCells}
      {@render sea(target.sea, targetCells, mainCell, true, !live || !me || target.out ? 'view' : haunting ? 'trick' : !amOut ? 'fire' : 'view', false)}
      {#if target.out && view.winner !== target.sea && !settling}
        <!-- A fleet that's out stays on view, stamped once the volley that sank it has landed. -->
        <!-- The canvas is tall enough for the box once it's tilted (292 × 68 at 12° stands about 127 high). -->
        <svg class="defeated" viewBox="0 0 340 150" role="img" aria-label="{handleOf(target.sea)}'s fleet is defeated" data-testid="defeated">
          <g transform="rotate(-12 170 75)">
            <rect x="24" y="41" width="292" height="68" rx="8" />
            <rect x="32" y="49" width="276" height="52" rx="4" class="inner" />
            <text x="170" y="89" text-anchor="middle" textLength="250" lengthAdjust="spacingAndGlyphs">DEFEATED</text>
          </g>
        </svg>
      {/if}
    {/if}
    {#if !live && !settling && view.winner}
      <!-- The game's own post-game billboard: no buttons, nothing to click. The site's end panel does the rest. -->
      <section class="billboard" aria-label="Match over" data-testid="billboard">
        <p class="bb-trophy" aria-hidden="true">🏆</p>
        <p class="bb-winner"><span style:color={kindColor(view.winner)}>@{handleOf(view.winner)}</span> takes the sea</p>
        {#if whisperTruths.length > 0}
          <p class="bb-head">👻 The whispers, and the truth</p>
          <ul class="bb-list" data-testid="truths">
            {#each whisperTruths as w, i (i)}
              <li class:lie={w.lie} data-testid="truth" data-ghost={w.ghost}>
                {#if w.state === 'sold' && w.winner}
                  <span class="who">@{handleOf(w.ghost)} → @{handleOf(w.winner)}</span>
                  <span class="where">@{handleOf(w.sea)}'s {areaName(w.cells)}</span>
                  <span class="nums">said <b>{w.said}</b> · truth <b>{w.truth}</b></span>
                  {#if w.lie}<span class="stamp">LIED</span>{:else}<span class="ok" aria-label="honest">✓</span>{/if}
                {:else}
                  <span class="who">@{handleOf(w.ghost)}</span>
                  <span class="where">@{handleOf(w.sea)}'s {areaName(w.cells)}</span>
                  <span class="nums">{w.state === 'faded' ? 'faded unsold' : 'no bids'} · truth <b>{w.truth}</b></span>
                {/if}
              </li>
            {/each}
          </ul>
        {/if}
      </section>
    {/if}
    <div class="pill" role="toolbar" aria-label="Board view">
      <button type="button" class="turn" aria-label="Turn left" onclick={() => turn(-90)}>⟲ 90°</button>
      <button type="button" aria-pressed={isView(ISO)} onclick={() => aimCamera(ISO)}>Iso</button>
      <button type="button" aria-pressed={isView(TOP)} onclick={() => aimCamera(TOP)}>Top</button>
      <button type="button" class="turn" aria-label="Turn right" onclick={() => turn(90)}>90° ⟳</button>
      <button type="button" class="snd" aria-label="Sound" aria-pressed={soundOn} onclick={() => (soundOn = sound?.toggle() ?? false)}>♪</button>
      <span class="hint-drag">drag to swivel</span>
    </div>
    {#if ghostCard}
      <!-- You've just been sunk: what you are now, over the stage, until you dismiss it (the round clock runs on behind it). -->
      <div class="ghostcard" role="dialog" aria-modal="false" aria-labelledby="ghost-title" tabindex="-1" data-testid="ghost-card" onkeydown={ghostKey}>
        <p class="gc-head" id="ghost-title"><span class="gc-icon" aria-hidden="true">👻</span> <strong>You were sunk by {ghostCard.sinkers}.</strong></p>
        <p>Your fleet is gone, but your spirit stays at the table. You're a ghost now. <strong class="gc-mission">Your mission: mischief.</strong></p>
        <p class="gc-sub">Each round, play one dirty trick:</p>
        <ul>
          <li><span class="gc-li" aria-hidden="true">💀</span><span><strong>Mine:</strong> hide it on a cell. Whoever shoots there gets hit on their own sea… unless a ship is under it, then you've just sunk that ship for them.</span></li>
          <li><span class="gc-li" aria-hidden="true">💦</span><span><strong>False splash:</strong> show one player a fake hit, to waste their shots (while three fleets are still afloat).</span></li>
          <li><span class="gc-li" aria-hidden="true">🤫</span><span><strong>Whisper:</strong> scan a 3×3 and auction the reading to the living for 30 seconds. Tell the winner any number you like.</span></li>
        </ul>
        <p class="gc-sub">You can't win now, but you can decide who does. Idle three rounds and your ghost fades away.</p>
        {#if secondsLeft !== null && !pendingTrick}<p class="gc-clock" data-testid="ghost-clock">Round {view.round}: {secondsLeft} s to play your first trick</p>{/if}
        <button type="button" class="btn primary" data-testid="haunt" bind:this={ghostBtn} onclick={() => (ghostCard = null)}>Haunt them</button>
      </div>
    {/if}
    {#if crateShown && crate}
      <!-- A crate from a ship you sank: owed (you're not locked in until it's answered), over the stage until you pick, pass or put it away. -->
      <div class="cratecard" role="dialog" aria-modal="false" aria-labelledby="crate-title" tabindex="-1" data-testid="crate-card" bind:this={crateEl} onkeydown={crateKeydown}>
        <div class="cc-head">
          <p class="cc-title" id="crate-title"><span class="cc-icon" aria-hidden="true">📦</span> Crate! Pick one</p>
          {@render clock('crate-clock')}
          <button type="button" class="cc-away" data-testid="crate-away" aria-label="Put the crate away for now: it stays owed" title="Put it away for now (Esc): it stays owed" onclick={() => (crateAway = true)}>–</button>
        </div>
        <p class="cc-sub">
          {handsFull ? `Your hands are full (${ITEM_LIMIT} items): swap one out for a card, or pass.` : 'Salvaged from the ship you sank. Take one card: it costs a gun the round you use it.'}
        </p>
        <div class="cc-cards">
          {#each crate as card (card)}
            {#if handsFull}
              <div class="cc-card i-{card}" data-testid="crate-{card}">
                <span class="cc-ic" aria-hidden="true">{ITEM_ICON[card]}</span>
                <strong class="cc-name">{ITEM_NAME[card]}</strong>
                <span class="cc-line">{ITEM_LINE[card]}</span>
                <span class="cc-swaps">
                  {#each droppable as d (d)}
                    <button
                      type="button"
                      class="cc-swap"
                      data-testid="crate-swap-{card}-{d}"
                      disabled={!interactive || crateSending || !takeCmd(card, d)}
                      onclick={() => void openCrate(takeCmd(card, d))}>Swap out {ITEM_ICON[d]} {ITEM_NAME[d]}</button
                    >
                  {/each}
                </span>
              </div>
            {:else}
              <button
                type="button"
                class="cc-card i-{card}"
                data-testid="crate-{card}"
                disabled={!interactive || crateSending || !takeCmd(card)}
                onclick={() => void openCrate(takeCmd(card))}
              >
                <span class="cc-ic" aria-hidden="true">{ITEM_ICON[card]}</span>
                <strong class="cc-name">{ITEM_NAME[card]}</strong>
                <span class="cc-line">{ITEM_LINE[card]}</span>
              </button>
            {/if}
          {/each}
        </div>
        <div class="cc-foot">
          <button type="button" class="cc-pass" data-testid="crate-pass" disabled={!interactive || crateSending || !passCmd} onclick={() => void openCrate(passCmd)}>Pass</button>
          <span class="cc-owed">You're not locked in until you pick or pass.</span>
        </div>
      </div>
    {/if}
  </div>

  <aside class="side" class:ghosted={haunting && !!myAuction} class:au={auctionBand}>
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
              <span class="stat"
                >{afloatOf(seat)} afloat · {view.scrap[seat] ?? 0} scrap{#if (view.holding?.[seat] ?? 0) > 0}{' · '}<span class="holding" data-testid="holding" data-n={view.holding[seat]} title="Holding {plural(view.holding[seat], 'item')}">📦×{view.holding[seat]}</span>{/if}</span
              >
            </span>
            {#if on}<span class="badge">target</span>{/if}
            {#if st && !(on && st === 'aiming')}<span class="state {st}">{STATE_TEXT[st] ?? st}</span>{/if}
          {/snippet}
          {#if t && !deploying}
            <button
              type="button"
              class="chip"
              class:holdout={holdout === seat}
              class:gone={out(seat)}
              class:on
              data-seat={seat}
              data-ready={view.ready.includes(seat)}
              aria-pressed={on}
              aria-label="{handleOf(seat)}'s sea, {afloatOf(seat)} afloat{view.guns?.[seat] !== undefined ? `, ${plural(view.guns[seat], 'gun')}` : ''}{view.holding?.[seat] ? `, holding ${plural(view.holding[seat], 'item')}` : ''}{aimedOn(seat) ? `, ${aimedOn(seat)} aimed` : ''}{st ? `, ${STATE_TEXT[st] ?? st}` : ''}"
              onclick={() => {
                picked = seat;
                // Picking a sea to look at puts the decoy back in the tray.
                if (kind === 'decoy') kind = 'shell';
              }}>{@render card()}</button
            >
          {:else}
            <div class="chip" class:gone={out(seat)} class:holdout={holdout === seat} data-seat={seat} data-ready={view.ready.includes(seat)}>{@render card()}</div>
          {/if}
        {/each}
      </div>
    </section>

    {#if auctionBand}
      <section class="auctions" aria-label="Whisper auctions">
        {#if haunting && myAuction}{@render myWhisper(myAuction)}{/if}
        {#each otherAuctions as a (a.ghost)}{@render auctionCard(a)}{/each}
      </section>
    {/if}

    {#if !deploying && ownCells && me}
      <section class="fleet" aria-label="Your fleet" bind:this={ownEl}>
        <p class="head"><span>Your fleet</span><span class="count" class:sunk={amOut && !settling}>{amOut && !settling ? 'sunk' : `${afloatOf(me)} afloat`}</span></p>
        <div class="ownbox" class:repairing={aimKind === 'repair' && !iAmReady}>
          {@render sea(me, ownCells, ownCell, false, aimKind === 'repair' && !iAmReady ? 'repair' : 'view', true)}
          {#if amOut && !settling}
            <svg class="defeated small" viewBox="0 0 340 150" role="img" aria-label="Your fleet is sunk" data-testid="sunk">
              <g transform="rotate(-12 170 75)">
                <rect x="24" y="41" width="292" height="68" rx="8" />
                <rect x="32" y="49" width="276" height="52" rx="4" class="inner" />
                <text x="170" y="94" text-anchor="middle" class="big">SUNK</text>
              </g>
            </svg>
          {/if}
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
          {@render clock()}
          <span class="shots" data-testid="shots" aria-label="{sent.length} sent, {aims.length} aimed, {room} to aim">
            {#each sent as o, i (i)}<i class="s-sent" class:b={o.fire === 'buoy'} class:it={isItem(o.fire)}></i>{/each}
            {#each aims as a, i (i)}<i class="s-aimed" class:b={a.fire === 'buoy'} class:it={isItem(a.fire)}></i>{/each}
            {#each { length: room } as _, i (i)}<i></i>{/each}
          </span>
        </div>
        {#if crate && crateAway}
          <button
            type="button"
            class="cratebtn"
            data-testid="crate-open"
            aria-label="Open your crate: it's owed before you're locked in"
            title="Your crate is owed: you're not locked in until you pick or pass"
            onclick={() => (crateAway = false)}><span aria-hidden="true">📦</span> Crate owed: pick one</button
          >
        {/if}
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
          {#if tray.length > 0}
            <div class="tray" role="group" aria-label="Your arsenal: one item a round, for one gun">
              {#each tray as x (x.item)}
                {@const why = itemWhy(x.item)}
                <button
                  type="button"
                  class="item i-{x.item}"
                  data-testid="item-{x.item}"
                  aria-pressed={aimKind === x.item}
                  class:aimed={itemAim?.fire === x.item || itemSent?.fire === x.item}
                  disabled={!interactive || why !== null}
                  title={why ?? ITEM_HINT[x.item]}
                  onclick={() => setKind(aimKind === x.item ? 'shell' : x.item)}
                  ><span class="ic" aria-hidden="true">{ITEM_ICON[x.item]}</span>{ITEM_NAME[x.item]}{#if x.n > 1}<span class="n">×{x.n}</span>{/if}</button
                >
              {/each}
            </div>
            {#if isItem(aimKind)}
              <p class="hint item-hint" data-testid="item-hint">
                {ITEM_HINT[aimKind]}
                {#if aimKind === 'decoy'}<button type="button" class="linkbtn" onclick={turnDecoy}>Facing {decoyFacing} ⟳</button>{/if}
              </p>
            {:else if trayWhy}
              <p class="hint why item-why" data-testid="item-why">{trayWhy}</p>
            {/if}
          {/if}
          {#if aims.length > 0}
            <button type="button" class="firebtn" class:buoy={aims.every((x) => x.fire === 'buoy')} data-testid="fire" disabled={!interactive || sending} onclick={() => void fire()}
              >{sending ? 'Firing…' : fireLabel}</button
            >
            {#if room === 0}<p class="hint">Salvo aimed. Click an aim to take it back.</p>{/if}
          {:else}
            <button type="button" class="slot" data-testid="fire" disabled
              >{sent.length >= guns && crate
                ? `${sentText}. Open your crate to lock in`
                : aimKind === 'repair'
                ? 'Pick a hit on your fleet to repair'
                : aimKind === 'decoy'
                  ? 'Pick a spot on your sea for the decoy'
                  : target?.out
                    ? 'That fleet is sunk: pick a living sea'
                    : aimKind === 'buoy'
                      ? 'Pick a centre for the buoy'
                      : aimKind === 'cluster'
                        ? 'Pick the centre for the cluster'
                        : aimKind === 'torpedo'
                          ? 'Pick a lane for the torpedo'
                          : sent.length
                            ? `Pick ${plural(room, 'more cell')}`
                            : `Pick ${plural(room, 'cell')} to fire`}</button
            >
          {/if}
          {#if bidFirst}<p class="hint au-first" data-testid="auction-first">An auction is still open: bid first.</p>{/if}
        {/if}
      {:else if haunting}
        <div class="ghost-row">
          <p class="ghost-head" data-testid="ghost-head">👻 You're a ghost. One dirty trick a round.</p>
          {@render clock()}
        </div>
        {#if pendingTrick}
          <p class="slot locked haunt" data-testid="waiting">Trick set — {pendingText}. {waitingFor.length ? `Waiting on ${names(waitingFor)}…` : ''}</p>
        {:else if ghostTricks.length === 0}
          <p class="slot">Nothing to haunt this round.</p>
        {:else}
          <div class="kind haunt" role="group" aria-label="Which trick">
            <button
              type="button"
              aria-pressed={trickNow === 'mine'}
              data-testid="trick-mine"
              disabled={!minesLegal}
              title={mineWhy ?? undefined}
              onclick={() => setTrickKind('mine')}>💀 Mine</button
            >
            <button
              type="button"
              aria-pressed={trickNow === 'splash'}
              data-testid="trick-splash"
              disabled={!splashLegal}
              title={splashWhy ?? undefined}
              onclick={() => setTrickKind('splash')}>👻 False splash</button
            >
            <button
              type="button"
              aria-pressed={trickNow === 'whisper'}
              data-testid="trick-whisper"
              disabled={!whispersLegal}
              title={whisperWhy ?? 'Scan a 3×3 and auction the reading to the living'}
              onclick={() => setTrickKind('whisper')}>🤫 Whisper</button
            >
          </div>
          {#if trickNow === 'whisper'}
            <p class="hint" data-testid="whisper-hint">You see the true count in a 3×3; the living bid 30 seconds for your word.</p>
          {:else if splashWhy || mineWhy || whisperWhy}
            <p class="hint why" data-testid="trick-why">{splashWhy ?? mineWhy ?? whisperWhy}</p>
          {/if}
          {#if trickNow === 'splash' && trickAim}
            <p class="hint">Who do you fool?</p>
            <div class="fools" role="group" aria-label="Who to fool">
              {#each fools as f (f)}
                <button type="button" class="fool" class:human={humanSeat(f)} data-testid="fool" data-seat={f} aria-pressed={fool === f} onclick={() => (fool = f)}>{handleOf(f)}</button>
              {/each}
            </div>
          {/if}
          {#if trickCmd}
            <button type="button" class="firebtn haunt" data-testid="play-trick" disabled={!interactive || trickSending} onclick={() => void playTrick()}
              >{trickSending
                ? 'Sending…'
                : trickNow === 'mine'
                  ? 'Plant mine'
                  : trickNow === 'whisper' && trickAim
                    ? `Auction ${areaOf(trickAim.cell)}`
                    : `Splash @${handleOf(fool ?? '')}`}</button
            >
          {:else}
            <button type="button" class="slot" data-testid="play-trick" disabled
              >{target?.out
                ? 'That fleet is sunk: pick a living sea'
                : trickNow === 'mine'
                  ? 'Pick a cell for your mine'
                  : trickNow === 'whisper'
                    ? 'Pick the centre of a 3×3 to scan'
                  : trickAim
                    ? 'Pick who to fool'
                    : trickCells.size === 0
                      ? 'This sea is down to its last ship cell: splash another sea'
                      : 'Pick a cell for the false splash'}</button
            >
          {/if}
          {#if tellFirst}<p class="hint au-first" data-testid="auction-first">Your auction is still open: set your number first.</p>{/if}
        {/if}
      {:else if live && amOut}
        <p class="slot">{settling ? 'The volley is landing…' : 'Your fleet is sunk. Watch any sea: the others play on.'}</p>
      {:else if !live}
        <p class="slot">{settling ? 'The last volley is landing…' : 'Every fleet is shown.'}</p>
        <!-- The whispers and their truths are told in the table's end-of-match panel. -->
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

  /* A defeated fleet's sea: a red rubber stamp across the stage, over everything, taking no clicks. */
  .defeated {
    position: absolute;
    left: 50%;
    top: 50%;
    width: min(64%, 28rem);
    overflow: visible;
    translate: -50% -50%;
    pointer-events: none;
    z-index: 4;
    filter: drop-shadow(0 6px 18px rgba(0, 0, 0, 0.55));
    animation: sv-stamp 0.45s cubic-bezier(0.2, 1.6, 0.4, 1) both;
  }
  .defeated rect {
    fill: rgba(40, 6, 12, 0.55);
    stroke: #ff3b4f;
    stroke-width: 5;
  }
  .defeated rect.inner {
    fill: none;
    stroke-width: 2;
    opacity: 0.8;
  }
  .defeated.small {
    width: 86%;
  }
  .count.sunk {
    color: #ff3b4f;
    font-weight: 700;
  }
  .defeated text {
    fill: #ff3b4f;
    font: 800 40px var(--font-ui);
    letter-spacing: 0.1em;
  }
  .defeated text.big {
    font-size: 56px;
  }

  /* ── Banners: over the stage, never in the way of a click ── */
  .banners {
    position: absolute;
    top: 10px;
    left: 0;
    right: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
    pointer-events: none;
    z-index: 5;
  }
  .banner {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    margin: 0 10px;
    max-width: 34rem;
    padding: 0.55rem 0.55rem 0.55rem 1.1rem;
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
  /* The banner itself lets clicks through to the sea; only its ✕ takes one. */
  .banner-x {
    flex: none;
    pointer-events: auto;
    width: 1.6rem;
    height: 1.6rem;
    border: 0;
    border-radius: 50%;
    background: transparent;
    color: inherit;
    font: inherit;
    font-size: 0.8em;
    line-height: 1;
    opacity: 0.6;
    cursor: pointer;
  }
  .banner-x:hover,
  .banner-x:focus-visible {
    opacity: 1;
    background: rgba(255, 255, 255, 0.1);
  }

  /* ── The ghost card: over the stage (and its banners), dark glass with a violet edge ── */
  .ghostcard {
    position: absolute;
    inset: 0;
    margin: auto;
    z-index: 6;
    width: min(30rem, calc(100% - 24px));
    height: fit-content;
    max-height: calc(100% - 24px);
    overflow-y: auto;
    overscroll-behavior: contain;
    padding: 1.1rem 1.25rem 1.2rem;
    border: 1px solid #b06bff;
    border-radius: 14px;
    background: rgba(13, 16, 32, 0.94);
    backdrop-filter: blur(6px);
    color: var(--chalk);
    font-size: 15px;
    line-height: 1.45;
    text-align: left;
    cursor: auto;
    user-select: text;
    box-shadow: 0 0 34px rgba(176, 107, 255, 0.35), 0 12px 40px rgba(0, 0, 0, 0.6);
    animation: sv-banner 0.35s cubic-bezier(0.2, 1.4, 0.4, 1) both;
  }
  .ghostcard:focus {
    outline: none;
  }
  .ghostcard p,
  .ghostcard ul {
    margin: 0 0 0.6rem;
  }
  .ghostcard .gc-head {
    display: flex;
    gap: 0.5rem;
    align-items: center;
    margin-bottom: 0.75rem;
    padding-bottom: 0.7rem;
    border-bottom: 1px solid color-mix(in oklab, #b06bff 35%, transparent);
    color: #e6d2ff;
    font-size: var(--step-1);
    line-height: 1.25;
  }
  .ghostcard .gc-icon {
    font-size: 1.6em;
    filter: drop-shadow(0 0 8px rgba(176, 107, 255, 0.7));
  }
  .ghostcard .gc-mission {
    color: #cfa6ff;
  }
  .ghostcard .gc-sub {
    color: var(--fog);
  }
  .ghostcard ul {
    list-style: none;
    padding: 0;
    display: grid;
    gap: 0.45rem;
  }
  .ghostcard li {
    display: flex;
    gap: 0.6rem;
    padding: 0.5rem 0.7rem;
    border-radius: var(--r-control);
    background: color-mix(in oklab, #b06bff 10%, transparent);
  }
  .ghostcard li strong {
    color: #e6d2ff;
  }
  .ghostcard .gc-li {
    flex: none;
  }
  .ghostcard .gc-clock {
    color: #cfa6ff;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }
  .ghostcard .btn.primary {
    display: flex;
    width: 100%;
    margin-top: 0.3rem;
    background: #b06bff;
    border-color: #b06bff;
    color: #12051f;
    box-shadow: 0 8px 24px rgba(176, 107, 255, 0.28);
  }
  .ghostcard .btn.primary:hover {
    background: #c896ff;
  }
  @container salvo (max-width: 480px) {
    .ghostcard {
      font-size: 14px;
      padding: 0.9rem 1rem 1rem;
    }
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
  /* A whisper auction (or, at the end, the whispers told) gets a band of its own under the opponents. */
  /* Narrow: the whisper band takes your fleet's place beside the controls while it lasts (30 seconds), so the salvo keeps its room. */
  .side.au {
    grid-template-areas: 'opps opps' 'auction actions';
  }
  .side.au .fleet {
    display: none;
  }
  .side.au .auctions {
    min-height: 0;
    overflow-y: auto;
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
      grid-template-rows: auto minmax(9.5rem, 1fr) auto;
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
    .side.au {
      grid-template-rows: auto auto minmax(9.5rem, 1fr) auto;
      grid-template-areas: 'opps' 'auction' 'fleet' 'actions';
    }
    .side .actions {
      min-height: auto;
      overflow: visible;
    }
    /* A ghost running its auction: its sunk fleet steps aside for the tell and the tricks. */
    .side.ghosted {
      grid-template-rows: auto auto;
      grid-template-areas: 'opps' 'actions';
    }
    .side.ghosted.au {
      grid-template-rows: auto auto auto;
      grid-template-areas: 'opps' 'auction' 'actions';
    }
    .side.au .fleet {
      display: flex;
    }
    .side.ghosted .fleet {
      display: none;
    }
    .side.au .auctions {
      min-height: auto;
      overflow: visible;
    }
    /* While an auction runs the column is tight: closer rows, and the fleet's legend steps out (the fleet shrinks, the salvo keeps its room). */
    .side.au {
      row-gap: 10px;
    }
    .side.au .legend {
      display: none;
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
  /* A ghost on the roster: violet, and stamped once it has played its trick. */
  .state.ghost,
  .state.haunting {
    color: #b06bff;
  }
  .state.haunting {
    font-weight: 600;
    animation: sv-stamp 0.45s cubic-bezier(0.2, 1.6, 0.4, 1) both;
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
  .mini .m-mine { background: #b06bff; }
  .mini .m-splash { background: rgba(176, 107, 255, 0.5); box-shadow: inset 0 0 0 1px #b06bff; }
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
    position: relative;
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
    gap: 6px;
    min-width: 0;
    /* Bottom-aligned, yet scrollable from the top when the controls outgrow a phone's band (justify-content: flex-end can't scroll back up). */
    min-height: 0;
    overflow-y: auto;
    font-size: var(--step--1);
  }
  .actions p {
    margin: 0;
  }
  .actions > :first-child {
    margin-top: auto;
  }
  .hint {
    color: var(--fog);
  }
  .hint.why {
    margin: 2px 0 0;
    font-size: var(--step--1);
    color: #c9a2ff;
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
  .salvo-head {
    flex-wrap: wrap;
    gap: 4px 8px;
  }
  .salvo-head .head {
    white-space: nowrap;
  }
  .salvo-head .shots {
    margin-left: auto;
  }
  /* The turn clock: a small ring beside the salvo (or the ghost's line); a ✓ once nothing is owed. */
  .tclock {
    display: inline-grid;
    place-items: center;
    flex: none;
    width: 32px;
    height: 32px;
  }
  .tclock.locked {
    border-radius: 50%;
    box-shadow: inset 0 0 0 2px color-mix(in oklab, var(--ready) 70%, transparent);
    color: var(--ready);
    font: 700 16px var(--font-ui);
  }
  .ghost-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
  .ghost-row .ghost-head {
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
  /* A ghost's controls: violet where the living's are orange. */
  .ghost-head {
    color: #cfa6ff;
    font-weight: 600;
  }
  .kind.haunt button[aria-pressed='true'] {
    background: color-mix(in oklab, #b06bff 26%, var(--panel-2));
  }
  .fools {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }
  .fool {
    padding: 5px 10px;
    border: 1px solid var(--lattice);
    border-radius: var(--r-control);
    background: var(--panel-2);
    color: var(--silicon);
    font: 600 13px var(--font-silicon);
  }
  .fool.human {
    color: var(--carbon);
    font-family: var(--font-carbon);
    font-style: italic;
  }
  .fool[aria-pressed='true'] {
    border-color: #b06bff;
    box-shadow: 0 0 0 1px #b06bff;
  }
  .firebtn.haunt {
    background: #b06bff;
    color: #12051f;
    box-shadow: 0 8px 24px rgba(176, 107, 255, 0.28);
  }
  .firebtn.haunt:hover {
    background: #c896ff;
  }
  .slot.locked.haunt {
    border-color: color-mix(in oklab, #b06bff 45%, transparent);
    color: #cfa6ff;
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
  .hull-preview {
    position: absolute;
    inset: 10%;
    border-radius: 6px;
    background: color-mix(in oklab, var(--carbon) 40%, transparent);
    border: 1.5px solid var(--carbon);
  }
  .hull-preview.bad {
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
  .reticle.trick {
    border-color: #b06bff;
    box-shadow: 0 0 16px rgba(176, 107, 255, 0.6), inset 0 0 12px rgba(176, 107, 255, 0.3);
  }
  .reticle.trick::before,
  .reticle.trick::after {
    background: rgba(176, 107, 255, 0.7);
  }
  /* A mine (a skull) or a false splash (a ghost) lying flat in its cell; this round's, not yet live, fainter. */
  .tmark {
    position: absolute;
    inset: 16%;
    display: grid;
    place-items: center;
    border-radius: 50%;
    background: radial-gradient(circle, rgba(176, 107, 255, 0.55), rgba(176, 107, 255, 0.15) 70%);
    box-shadow: 0 0 0 1.5px #b06bff, 0 0 calc(var(--cell) * 0.25) rgba(176, 107, 255, 0.7);
    font-size: calc(var(--cell) * 0.38);
    line-height: 1;
  }
  .own .tmark {
    display: none;
  }
  /* This round's trick, not live until the volley: dashed and dimmer. */
  .tmark.pending {
    opacity: 0.7;
    background: none;
    box-shadow: 0 0 0 1.5px rgba(176, 107, 255, 0.8);
  }
  .reticle.buoy {
    border-color: var(--silicon);
    box-shadow: 0 0 14px rgba(79, 216, 238, 0.5);
  }
  .reticle.buoy::before,
  .reticle.buoy::after {
    display: none;
  }

  /* ── The arsenal: gold, wherever an item shows ── */
  .salvo {
    --item: #ffc857;
  }
  .holding {
    color: var(--item);
    font-weight: 600;
  }
  .tray {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }
  .tray .item {
    flex: 1 1 0;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    padding: 7px 8px;
    border: 1px solid color-mix(in oklab, var(--item) 45%, var(--lattice));
    border-radius: var(--r-control);
    background: color-mix(in oklab, var(--item) 7%, #141829);
    color: var(--chalk);
    font: 600 13px var(--font-ui);
    white-space: nowrap;
    cursor: pointer;
  }
  .tray .item:hover:not(:disabled) {
    border-color: var(--item);
  }
  .tray .item[aria-pressed='true'] {
    border-color: var(--item);
    background: color-mix(in oklab, var(--item) 24%, var(--panel-2));
    box-shadow: 0 0 14px color-mix(in oklab, var(--item) 35%, transparent);
  }
  .tray .item.aimed:not([aria-pressed='true']) {
    border-style: dashed;
  }
  .tray .item:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .tray .ic {
    color: var(--item);
  }
  .tray .n {
    color: var(--fog);
    font-weight: 500;
  }
  .hint.item-hint {
    color: #ffe3a3;
  }
  /* The crate put away: a gold button in the tray, glowing while it's owed. */
  .cratebtn {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    width: 100%;
    padding: 7px 10px;
    white-space: nowrap;
    border: 1px solid var(--item);
    border-radius: var(--r-control);
    background: color-mix(in oklab, var(--item) 16%, #141829);
    color: #ffe3a3;
    font: 700 14px var(--font-ui);
    cursor: pointer;
    animation: sv-owed 1.6s ease-in-out infinite;
  }
  .cratebtn:hover {
    background: color-mix(in oklab, var(--item) 26%, #141829);
  }
  @keyframes sv-owed {
    0%, 100% { box-shadow: 0 0 0 rgba(255, 200, 87, 0); }
    50% { box-shadow: 0 0 16px rgba(255, 200, 87, 0.5); }
  }

  /* ── The crate card: over the stage like the ghost card, in the arsenal's gold ── */
  .cratecard {
    position: absolute;
    inset: 0;
    margin: auto;
    z-index: 6;
    width: min(34rem, calc(100% - 24px));
    height: fit-content;
    max-height: calc(100% - 24px);
    overflow-y: auto;
    overscroll-behavior: contain;
    padding: 1rem 1.15rem 1.1rem;
    border: 1px solid var(--item);
    border-radius: 14px;
    background: rgba(13, 16, 32, 0.94);
    backdrop-filter: blur(6px);
    color: var(--chalk);
    font-size: 15px;
    line-height: 1.4;
    text-align: left;
    cursor: auto;
    user-select: text;
    box-shadow: 0 0 34px rgba(255, 200, 87, 0.28), 0 12px 40px rgba(0, 0, 0, 0.6);
    animation: sv-banner 0.35s cubic-bezier(0.2, 1.4, 0.4, 1) both;
  }
  .cratecard:focus {
    outline: none;
  }
  .cc-head {
    display: flex;
    align-items: center;
    gap: 10px;
    padding-bottom: 0.6rem;
    margin-bottom: 0.6rem;
    border-bottom: 1px solid color-mix(in oklab, var(--item) 35%, transparent);
  }
  .cc-title {
    flex: 1;
    margin: 0;
    color: #ffe3a3;
    font-size: var(--step-1);
    font-weight: 700;
    line-height: 1.2;
  }
  .cc-icon {
    filter: drop-shadow(0 0 8px rgba(255, 200, 87, 0.6));
  }
  .cc-away {
    flex: none;
    width: 30px;
    height: 30px;
    border: 1px solid var(--lattice);
    border-radius: var(--r-control);
    background: transparent;
    color: var(--fog);
    font: 700 18px/1 var(--font-ui);
    cursor: pointer;
  }
  .cc-away:hover {
    color: var(--chalk);
    border-color: var(--fog);
  }
  .cc-sub {
    margin: 0 0 0.7rem;
    color: var(--fog);
    font-size: 14px;
  }
  .cc-cards {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 8px;
  }
  .cc-card {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    padding: 0.8rem 0.6rem 0.75rem;
    border: 1px solid color-mix(in oklab, var(--item) 45%, var(--lattice));
    border-radius: 10px;
    background: color-mix(in oklab, var(--item) 8%, #141829);
    color: var(--chalk);
    font: inherit;
    text-align: center;
  }
  button.cc-card {
    cursor: pointer;
    transition: transform 0.15s ease, border-color 0.15s ease, box-shadow 0.15s ease;
  }
  button.cc-card:hover:not(:disabled),
  button.cc-card:focus-visible {
    border-color: var(--item);
    box-shadow: 0 0 16px color-mix(in oklab, var(--item) 35%, transparent);
    transform: translateY(-2px);
  }
  button.cc-card:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .cc-ic {
    color: var(--item);
    font-size: 26px;
    line-height: 1.1;
  }
  .cc-name {
    color: #ffe3a3;
    font-size: 15px;
  }
  .cc-line {
    color: var(--fog);
    font-size: 12.5px;
    line-height: 1.35;
  }
  .cc-swaps {
    display: grid;
    gap: 4px;
    width: 100%;
    margin-top: auto;
    padding-top: 6px;
  }
  .cc-swap {
    padding: 5px 6px;
    border: 1px solid color-mix(in oklab, var(--item) 50%, var(--lattice));
    border-radius: var(--r-control);
    background: color-mix(in oklab, var(--item) 12%, #141829);
    color: var(--chalk);
    font: 600 12px var(--font-ui);
    cursor: pointer;
  }
  .cc-swap:hover:not(:disabled) {
    border-color: var(--item);
    background: color-mix(in oklab, var(--item) 24%, #141829);
  }
  .cc-swap:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .cc-foot {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-top: 0.8rem;
  }
  .cc-pass {
    flex: none;
    padding: 7px 18px;
    border: 1px solid var(--lattice);
    border-radius: var(--r-control);
    background: transparent;
    color: var(--chalk);
    font: 600 14px var(--font-ui);
    cursor: pointer;
  }
  .cc-pass:hover:not(:disabled) {
    border-color: var(--fog);
  }
  .cc-pass:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .cc-owed {
    color: #e8c77a;
    font-size: 13px;
  }
  @container salvo (max-width: 480px) {
    .cratecard {
      font-size: 14px;
      padding: 0.8rem 0.85rem 0.9rem;
    }
    .cc-cards {
      gap: 6px;
    }
    .cc-card {
      padding: 0.6rem 0.4rem;
    }
    .cc-ic {
      font-size: 22px;
    }
    .cc-line {
      font-size: 11.5px;
    }
  }
  .hint.item-why {
    color: #e8c77a;
  }
  .linkbtn {
    margin-left: 4px;
    padding: 1px 6px;
    border: 1px solid color-mix(in oklab, var(--item) 50%, transparent);
    border-radius: 999px;
    background: none;
    color: var(--item);
    font: 600 11px var(--font-ui);
    cursor: pointer;
  }
  .shots i.it.s-aimed {
    box-shadow: inset 0 0 0 2px var(--item);
  }
  .shots i.it.s-sent {
    background: var(--item);
  }
  /* Repairing: your fleet's hits light up to be picked. */
  .ownbox.repairing {
    border-color: color-mix(in oklab, var(--item) 60%, transparent);
    box-shadow: 0 0 16px color-mix(in oklab, var(--item) 25%, transparent);
  }
  .own [data-mode='repair'] > button[aria-disabled='false'],
  .own [data-mode='decoy'] > button[aria-disabled='false'] {
    cursor: pointer;
  }
  .own [data-mode='repair'] > button[data-legal='true'] .water {
    box-shadow: inset 0 0 0 1.5px var(--item);
    background: color-mix(in oklab, var(--item) 14%, transparent);
  }
  /* A decoy: yours afloat is a dashed hull; one found is driftwood. */
  .hull.decoy {
    background: color-mix(in oklab, var(--item) 16%, transparent);
    border: 1.5px dashed var(--item);
    box-shadow: none;
  }
  .hull.decoy.aim {
    opacity: 0.85;
    animation: sv-aim 1.1s ease-in-out infinite;
  }
  .hull.decoy.aim.sent {
    animation: none;
    opacity: 0.55;
  }
  .hull.drift {
    inset: 22%;
    background: repeating-linear-gradient(90deg, #6b4a2b 0 30%, #3b2717 30% 38%);
    box-shadow: inset 0 0 0 1px rgba(255, 200, 120, 0.25);
    opacity: 0.85;
  }
  .glow.drift {
    background: radial-gradient(circle, rgba(200, 150, 90, 0.35), rgba(200, 150, 90, 0) 70%);
  }
  /* A found decoy's stamp: small and red, like SUNK, in its first cell. */
  .dstamp {
    position: absolute;
    left: 50%;
    top: 50%;
    translate: -50% -50%;
    rotate: -12deg;
    padding: 0 2px;
    border: 1.5px solid #ff3b4f;
    border-radius: 2px;
    background: rgba(40, 6, 12, 0.7);
    color: #ff3b4f;
    font: 800 clamp(6px, calc(var(--cell) * 0.19), 12px) / 1.2 var(--font-ui);
    letter-spacing: 0.04em;
  }
  .dstamp.land {
    animation: sv-stamp 0.45s cubic-bezier(0.2, 1.6, 0.4, 1) var(--d) both;
  }
  /* A welding spark: a repaired cell, yours alone until it's shot again (the table still sees the hit). */
  .weld {
    position: absolute;
    right: 8%;
    top: 8%;
    width: 30%;
    height: 30%;
    background: radial-gradient(circle, #fff 0 18%, var(--item) 30%, transparent 62%);
    clip-path: polygon(50% 0, 62% 38%, 100% 50%, 62% 62%, 50% 100%, 38% 62%, 0 50%, 38% 38%);
    filter: drop-shadow(0 0 3px var(--item));
  }
  .weld.land {
    animation: sv-pop 0.45s cubic-bezier(0.2, 1.6, 0.4, 1) var(--d) both;
  }
  /* The repair you've picked: a gold ring round the hit. */
  .weld.aim {
    inset: 8%;
    width: auto;
    height: auto;
    background: none;
    clip-path: none;
    filter: none;
    border: 2px solid var(--item);
    border-radius: 50%;
    box-shadow: 0 0 10px color-mix(in oklab, var(--item) 60%, transparent);
    animation: sv-aim 1.1s ease-in-out infinite;
  }
  .weld.aim.sent {
    animation: none;
    border-style: dashed;
    opacity: 0.6;
  }
  .hull-preview.decoy {
    border-style: dashed;
    background: color-mix(in oklab, var(--item) 25%, transparent);
    border-color: var(--item);
  }
  .hull-preview.decoy.bad {
    background: color-mix(in oklab, var(--danger) 30%, transparent);
    border-color: var(--danger);
  }
  .reticle.cluster {
    border-color: var(--item);
    box-shadow: 0 0 16px color-mix(in oklab, var(--item) 60%, transparent);
  }
  .reticle.cluster::before,
  .reticle.cluster::after {
    background: color-mix(in oklab, var(--item) 70%, transparent);
  }
  /* A cluster's plus: the pointer's faint, the pick bright, the one sent dashed. */
  .plus {
    position: absolute;
    inset: 4%;
    border-radius: 4px;
    border: 1.5px solid color-mix(in oklab, var(--item) 55%, transparent);
    background: color-mix(in oklab, var(--item) 12%, transparent);
  }
  .plus.centre {
    border-width: 2px;
  }
  .plus.s-picked {
    border-color: var(--item);
    background: color-mix(in oklab, var(--item) 24%, transparent);
  }
  .plus.s-sent {
    border-style: dashed;
    opacity: 0.55;
  }
  /* A torpedo's lane: a band of chevrons pointing the way it runs. */
  .lane {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    background: color-mix(in oklab, var(--item) 12%, transparent);
  }
  .lane i {
    width: 34%;
    height: 34%;
    border-top: 2px solid color-mix(in oklab, var(--item) 70%, transparent);
    border-right: 2px solid color-mix(in oklab, var(--item) 70%, transparent);
    rotate: calc(var(--dir) + 45deg);
    translate: calc(cos(var(--dir)) * -8%) calc(sin(var(--dir)) * -8%);
  }
  .lane.entry {
    box-shadow: inset 0 0 0 2px color-mix(in oklab, var(--item) 70%, transparent);
  }
  .lane.s-picked {
    background: color-mix(in oklab, var(--item) 26%, transparent);
  }
  .lane.s-picked i {
    border-color: var(--item);
  }
  .lane.s-sent {
    opacity: 0.5;
  }
  .lane.bad {
    background: color-mix(in oklab, var(--danger) 14%, transparent);
  }
  .lane.bad i {
    border-color: color-mix(in oklab, var(--danger) 60%, transparent);
  }
  .mini .m-decoy {
    background: #6b4a2b;
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
    border-radius: 50%;
    border: 2px solid var(--silicon);
    box-shadow: 0 0 16px rgba(79, 216, 238, 0.6), inset 0 0 16px rgba(79, 216, 238, 0.4);
    /* Centred in the transform, not with `translate`: the CSS minifier drops a `translate` that sits beside a `transform`. */
    transform: translate(-50%, -50%) translateZ(3px);
    animation: sv-sonar 1.2s ease-out var(--d) 2 both;
  }
  .flash.mine {
    width: calc(var(--cell) * 2.2);
    height: calc(var(--cell) * 2.2);
    background: radial-gradient(circle, rgba(255, 255, 255, 0.95), rgba(200, 150, 255, 0.85) 30%, rgba(176, 107, 255, 0.4) 55%, transparent 70%);
  }
  .flash.mine.back {
    width: calc(var(--cell) * 1.6);
    height: calc(var(--cell) * 1.6);
  }
  .flash {
    position: absolute;
    width: calc(var(--cell) * 3.4);
    height: calc(var(--cell) * 3.4);
    border-radius: 50%;
    background: radial-gradient(circle, rgba(255, 255, 255, 0.95), rgba(255, 190, 90, 0.8) 30%, rgba(255, 90, 40, 0.35) 55%, transparent 70%);
    /* Centred in the transform (see .ping). */
    transform: translate(-50%, -50%) translateZ(4px);
    animation: sv-flash 0.7s ease-out var(--d) both;
  }

  /* A cluster's shell is a bigger ball; its burst, a flash on each cell of the plus. */
  .shell.big .ball {
    scale: 1.35;
  }
  .flash.plus {
    width: calc(var(--cell) * 1.5);
    height: calc(var(--cell) * 1.5);
  }
  /* A torpedo: a glowing capsule running its lane, a wake behind it. */
  .torp {
    position: absolute;
    width: 0;
    height: 0;
    transform: translateZ(2px);
    animation:
      sv-appear 1ms linear var(--d) both,
      sv-run var(--run) linear var(--d) both,
      sv-gone 0.15s linear calc(var(--d) + var(--run)) forwards;
  }
  .torp i {
    position: absolute;
    left: calc(var(--cell) * -0.5);
    top: calc(var(--cell) * -0.09);
    width: calc(var(--cell) * 0.7);
    height: calc(var(--cell) * 0.18);
    border-radius: 999px;
    rotate: var(--dir);
    transform-origin: 70% 50%;
    background: linear-gradient(90deg, transparent, color-mix(in oklab, var(--c) 40%, transparent) 40%, var(--c) 80%, #fff);
    box-shadow: 0 0 10px var(--c);
  }
  .flash.torp-hit {
    width: calc(var(--cell) * 1.8);
    height: calc(var(--cell) * 1.8);
  }
  .flash.weld-fx {
    width: calc(var(--cell) * 1.2);
    height: calc(var(--cell) * 1.2);
    background: radial-gradient(circle, #fff, rgba(255, 200, 87, 0.9) 30%, rgba(79, 216, 238, 0.35) 55%, transparent 70%);
  }
  @keyframes sv-run {
    0% { transform: translateZ(2px) translate(0, 0); }
    100% { transform: translateZ(2px) translate(var(--tx), var(--ty)); }
  }
  @keyframes sv-appear {
    from { visibility: hidden; }
    to { visibility: visible; }
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
    0% { transform: translate(-50%, -50%) translateZ(4px) scale(0.2); opacity: 0; }
    20% { opacity: 1; }
    100% { transform: translate(-50%, -50%) translateZ(4px) scale(1.1); opacity: 0; }
  }
  @keyframes sv-sonar {
    0% { transform: translate(-50%, -50%) translateZ(3px) scale(0.1); opacity: 0; }
    15% { opacity: 1; }
    100% { transform: translate(-50%, -50%) translateZ(3px) scale(1); opacity: 0; }
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
    .dstamp.land,
    .weld.land,
    .weld.aim,
    .hull.decoy.aim,
    .banner,
    .ghostcard,
    .cratecard,
    .cratebtn {
      animation: none;
    }
    button.cc-card {
      transition: none;
    }
    .bubbles {
      display: none;
    }
  }

  /* ── Whisper: the auction cards, the ghost's tell, the areas and the words bought. Violet, as every ghost thing ── */
  .auctions {
    grid-area: auction;
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-width: 0;
  }
  .auction {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 6px 8px 7px;
    border: 1px solid color-mix(in oklab, #b06bff 55%, transparent);
    border-radius: var(--r-control);
    background: linear-gradient(160deg, rgba(176, 107, 255, 0.14), rgba(13, 16, 32, 0.7) 70%);
    box-shadow: 0 0 22px rgba(176, 107, 255, 0.16);
    font-size: 13px;
    animation: sv-au-in 0.5s ease-out;
  }
  .auction.onsea {
    border-color: #b06bff;
  }
  .auction p {
    margin: 0;
  }
  .au-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
  .au-title {
    color: #cfa6ff;
    font: 600 12px var(--font-ui);
  }
  .au-clock {
    display: inline-grid;
    place-items: center;
    flex: none;
    min-width: 26px;
    height: 26px;
  }
  .au-closing {
    color: var(--dust);
    font-size: 11px;
  }
  .au-what {
    color: var(--fog);
    line-height: 1.35;
  }
  .au-what strong {
    color: var(--chalk);
    font-weight: 600;
  }
  .who-g {
    color: #cfa6ff;
    font-family: var(--font-silicon);
  }
  .au-sea {
    padding: 0 2px;
    border: 0;
    border-bottom: 1px dashed currentColor;
    background: none;
    color: var(--silicon);
    font: inherit;
    font-family: var(--font-silicon);
    cursor: pointer;
  }
  .au-sea.human {
    color: var(--carbon);
  }
  .au-sea[aria-pressed='true'] {
    border-bottom-style: solid;
  }
  .au-bids {
    display: flex;
    flex-wrap: wrap;
    gap: 1px 10px;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .au-bid {
    display: inline-flex;
    gap: 4px;
    align-items: baseline;
    min-width: 0;
    font-size: 11.5px;
  }
  .au-bid .name {
    max-width: 6.5rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--silicon);
    font-family: var(--font-silicon);
  }
  .au-bid .name.human {
    color: var(--carbon);
  }
  .au-bid .st {
    color: var(--dust);
  }
  .au-bid.st-bid .st {
    color: #cfa6ff;
    font-weight: 600;
  }
  .au-bid.st-abstained .st {
    font-style: italic;
  }
  .au-mine {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 2px 8px;
    color: var(--chalk);
  }
  .au-mine .au-btn {
    padding: 2px 8px;
    font-size: 12px;
  }
  .au-mine strong {
    color: #cfa6ff;
  }
  .au-ctl {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }
  .au-btn {
    min-width: 1.9rem;
    padding: 4px 6px;
    border: 1px solid color-mix(in oklab, #b06bff 60%, transparent);
    border-radius: var(--r-control);
    background: color-mix(in oklab, #b06bff 18%, var(--panel-2));
    color: var(--chalk);
    font: 600 12.5px var(--font-ui);
    cursor: pointer;
  }
  .au-btn:hover:not(:disabled) {
    background: color-mix(in oklab, #b06bff 32%, var(--panel-2));
  }
  .au-btn:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .au-btn.quiet {
    border-color: var(--lattice);
    background: none;
    color: var(--fog);
    font-weight: 500;
  }
  .au-custom {
    display: inline-flex;
  }
  .au-custom input {
    width: 3.3rem;
    padding: 3px 5px;
    border: 1px solid var(--lattice);
    border-right: 0;
    border-radius: var(--r-control) 0 0 var(--r-control);
    background: rgba(13, 16, 32, 0.8);
    color: var(--chalk);
    font: 500 13px var(--font-ui);
    appearance: textfield;
  }
  .au-custom input::-webkit-inner-spin-button,
  .au-custom input::-webkit-outer-spin-button {
    appearance: none;
    margin: 0;
  }
  .au-custom .au-btn {
    border-radius: 0 var(--r-control) var(--r-control) 0;
  }
  .au-truth {
    color: var(--chalk);
    font-weight: 600;
  }
  .au-tell-head {
    margin-right: 4px;
    color: var(--fog);
    font-size: 12px;
  }
  .tells {
    display: grid;
    grid-template-columns: auto repeat(10, minmax(0, 1fr));
    align-items: center;
    gap: 2px;
  }
  .tell {
    min-width: 0;
    padding: 3px 0;
    border: 1px solid var(--lattice);
    border-radius: 6px;
    background: var(--panel-2);
    color: var(--fog);
    font: 600 13px var(--font-silicon);
    font-variant-numeric: tabular-nums;
    cursor: pointer;
  }
  .tell.truth {
    border-color: color-mix(in oklab, var(--ready) 50%, transparent);
  }
  .tell[aria-pressed='true'] {
    border-color: #b06bff;
    background: #b06bff;
    color: #12051f;
  }
  .tell:disabled {
    cursor: default;
  }
  .tell:disabled:not([aria-pressed='true']) {
    opacity: 0.5;
  }
  .au-lie {
    font-size: 12px;
  }
  .au-close {
    margin: 0;
    font-size: 11px;
  }
  .au-first {
    margin: 2px 0 0;
    font-size: var(--step--1);
    color: #c9a2ff;
  }
  @container salvo (max-width: 520px) {
    .tells {
      grid-template-columns: auto repeat(5, minmax(0, 1fr));
    }
    .tells .tell:nth-of-type(6) {
      grid-column-start: 2;
    }
  }
  /* The post-game billboard: over the sea, nothing to click (only its list scrolls when it's long). */
  .billboard {
    position: absolute;
    left: 50%;
    top: 50%;
    translate: -50% -50%;
    z-index: 6;
    width: min(30rem, calc(100% - 24px));
    max-height: calc(100% - 24px);
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 18px 20px 16px;
    border: 1px solid color-mix(in oklab, #ffd36b 45%, transparent);
    border-radius: 14px;
    background: color-mix(in oklab, #0d0f20 88%, transparent);
    box-shadow: 0 18px 60px rgb(0 0 0 / 0.55);
    text-align: center;
    pointer-events: none;
  }
  .bb-trophy {
    margin: 0;
    font-size: 44px;
    line-height: 1;
    filter: drop-shadow(0 4px 14px rgb(255 211 107 / 0.45));
  }
  .bb-winner {
    margin: 0 0 4px;
    font-size: var(--step-1);
    font-weight: 700;
    color: var(--chalk);
  }
  .bb-head {
    margin: 6px 0 2px;
    color: #c9a2ff;
    font-weight: 600;
    font-size: 12px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  .bb-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 4px;
    overflow-y: auto;
    min-height: 0;
    pointer-events: auto;
    text-align: left;
  }
  .bb-list li {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.15rem 0.6rem;
    padding: 6px 10px;
    border-radius: 8px;
    background: color-mix(in oklab, var(--panel-2) 85%, transparent);
    color: var(--fog);
    font-size: 13px;
  }
  .bb-list .who,
  .bb-list b {
    color: var(--chalk);
  }
  .bb-list .who {
    font-weight: 600;
  }
  .bb-list li.lie {
    background: color-mix(in oklab, #ff3b4f 16%, var(--panel-2));
    box-shadow: inset 3px 0 0 #ff3b4f;
  }
  .bb-list li.lie b {
    color: #ff8a96;
  }
  .bb-list .stamp {
    margin-left: auto;
    padding: 0 6px;
    border: 2px solid #ff3b4f;
    border-radius: 4px;
    color: #ff3b4f;
    font-weight: 800;
    letter-spacing: 0.08em;
    transform: rotate(-4deg);
  }
  .bb-list .ok {
    margin-left: auto;
    color: var(--ready);
    font-weight: 700;
  }
  /* The three tricks share the ghost's toggle. */
  .kind.haunt {
    display: flex;
    flex-wrap: wrap;
  }
  .kind.haunt button {
    flex: 1 1 auto;
    padding: 6px 5px;
    font-size: 12.5px;
  }
  /* A 3×3 drawn cell by cell (an overlay would be clipped on the tilted sea): only the area's outer sides are lined. */
  .area {
    position: absolute;
    inset: 0;
    background: rgba(176, 107, 255, 0.1);
    border: 0 dashed #b06bff;
  }
  .area.el {
    border-left-width: 2px;
  }
  .area.er {
    border-right-width: 2px;
  }
  .area.et {
    border-top-width: 2px;
  }
  .area.eb {
    border-bottom-width: 2px;
  }
  .area.s-hover {
    border-color: rgba(176, 107, 255, 0.6);
    background: rgba(176, 107, 255, 0.07);
  }
  .area.s-picked,
  .area.s-auction {
    border-style: solid;
    background: rgba(176, 107, 255, 0.16);
  }
  .area.s-auction {
    animation: sv-au-glow 1.6s ease-in-out infinite;
  }
  .area.s-pending {
    opacity: 0.75;
  }
  .area.s-bought {
    border-color: rgba(176, 107, 255, 0.55);
    background: rgba(176, 107, 255, 0.06);
  }
  /* Your own fleet's cells are small: a hairline outline, so the area still reads. */
  .own .area.el {
    border-left-width: 1px;
  }
  .own .area.er {
    border-right-width: 1px;
  }
  .own .area.et {
    border-top-width: 1px;
  }
  .own .area.eb {
    border-bottom-width: 1px;
  }
  /* The ghost's word on its area: 👻 3? (a word, not a reading). */
  .wmark {
    position: absolute;
    inset: 12% 2%;
    display: grid;
    place-items: center;
    border-radius: 999px;
    background: rgba(18, 5, 31, 0.82);
    box-shadow: 0 0 0 1.5px #b06bff, 0 0 calc(var(--cell) * 0.3) rgba(176, 107, 255, 0.6);
    color: #e7d4ff;
    font: 700 calc(var(--cell) * 0.26) var(--font-silicon);
    white-space: nowrap;
    line-height: 1;
  }
  @keyframes sv-au-in {
    from {
      box-shadow: 0 0 0 3px #b06bff, 0 0 40px rgba(176, 107, 255, 0.6);
    }
  }
  @keyframes sv-au-glow {
    50% {
      background: rgba(176, 107, 255, 0.26);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .auction,
    .area.s-auction {
      animation: none;
    }
  }
</style>
