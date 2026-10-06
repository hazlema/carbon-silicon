<script lang="ts">
  import { untrack } from 'svelte';
  import { cellIndex, cellName, hullCells, SHIPS, SIZE, type Facing, type SalvoCommand, type SalvoView, type ShipId, type TargetView } from '@cs/salvo';
  import { colorOf, type TableColors } from '$lib/seats';
  import { fitScale } from '../critical-mass/iso';
  import { createSound } from '../critical-mass/sound';
  import { typing } from '../lightline/controls';
  import { incoming, planVolley, sideOf, type Side, type VolleyPlan } from './volley';

  let {
    view,
    colors,
    legal,
    interactive,
    onMove,
    seats,
    you,
    fit = false,
  }: {
    view: SalvoView;
    colors: TableColors;
    legal: unknown[];
    interactive: boolean;
    /** Called with ONE entry of `legal`, verbatim. */
    onMove: (cmd: unknown) => void;
    /** The match's seats, for names. */
    seats: { seat: string; identity: { handle: string; kind: string } }[];
    you: string | null;
    /** A phone's table: open in the Top view and fill the stage. */
    fit?: boolean;
  } = $props();

  /** The fixed isometric tilt (no swivel: the seas stay where the compass says). */
  const ISO = { spin: -28, tilt: 48 };
  /** The cell size `fitScale` is asked about; the fit's scale turns it into real pixels. */
  const REF = 60;
  const LETTERS = 'abcdefgh';
  /** Cells in DOM order: row 8 first, column a on the left (a1 bottom-left). */
  const ORDER = Array.from({ length: SIZE * SIZE }, (_, k) => cellName((SIZE - 1 - Math.floor(k / SIZE)) * SIZE + (k % SIZE)));
  /** Where each compass side's chip sits in the narrow row: left to right as you'd look round the table. */
  const SIDE_ORDER: Side[] = ['west', 'north', 'east', 'south'];

  const me = $derived(view.you ?? you);
  const side = (seat: string) => sideOf(seat, me);
  const handleOf = (seat: string) => seats.find((s) => s.seat === seat)?.identity.handle ?? seat;
  const humanSeat = (seat: string) => seats.find((s) => s.seat === seat)?.identity.kind === 'human';
  const myColor = $derived(colorOf(colors, me));
  const live = $derived(view.phase !== 'over');
  const out = (seat: string) => view.eliminated.includes(seat);
  const amOut = $derived(!!me && out(me));
  const names = (list: string[]) => (list.length <= 1 ? list.join('') : `${list.slice(0, -1).join(', ')} and ${list.at(-1)}`);

  // ── What `legal` offers ──
  type FireCmd = Extract<SalvoCommand, { fire: 'shell' }>;
  type PlaceCmd = Extract<SalvoCommand, { place: ShipId }>;
  const isFire = (l: unknown): l is FireCmd => typeof l === 'object' && l !== null && (l as FireCmd).fire === 'shell';
  const isPlace = (l: unknown): l is PlaceCmd => typeof l === 'object' && l !== null && typeof (l as PlaceCmd).at === 'string' && 'place' in l;
  const randomCmd = $derived(legal.find((l) => typeof l === 'object' && l !== null && (l as { place?: unknown }).place === 'random'));

  // ── Which sea is big ──
  const deploying = $derived(view.phase === 'deploy' && !!view.mySea && !amOut);
  let picked = $state<string | null>(null);
  const byCompass = (a: TargetView, b: TargetView) => SIDE_ORDER.indexOf(side(a.sea)) - SIDE_ORDER.indexOf(side(b.sea));
  /** The sea across the table first (north), then round the compass. */
  const target = $derived(view.targets.find((t) => t.sea === picked) ?? [...view.targets].sort((a, b) => (side(a.sea) === 'north' ? -1 : side(b.sea) === 'north' ? 1 : byCompass(a, b)))[0] ?? null);
  const targetSea = $derived(target?.sea ?? null);
  const fireCells = $derived(new Set(legal.filter(isFire).filter((l) => l.at === targetSea).map((l) => l.cell)));

  // ── Fire: click selects, Fire (or Enter on the selected cell) sends ──
  let selected = $state<string | null>(null);
  const round = $derived(view.round);
  const iAmReady = $derived(!!me && view.ready.includes(me));
  // A new round clears the aim; so does looking at another sea, unless the shell is already away (then it stays on show).
  $effect(() => {
    void round;
    selected = null;
  });
  $effect(() => {
    void targetSea;
    if (!untrack(() => iAmReady)) selected = null;
  });
  const fireCmd = $derived(selected && targetSea ? (legal.filter(isFire).find((l) => l.at === targetSea && l.cell === selected) ?? null) : null);
  function fire() {
    if (!interactive || !fireCmd) return;
    sound?.clink();
    onMove($state.snapshot(fireCmd));
  }

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
  type Mark = 'sea' | 'miss' | 'hit' | 'sunk' | 'ship' | 'sighted';
  interface Hull {
    color: string;
    /** Sides (l r t b) where the hull runs on into the next cell. */
    joins: string;
    wreck: boolean;
    faint: boolean;
  }
  interface CellModel {
    mark: Mark;
    ship: ShipId | null;
    mine: boolean;
    hull: Hull | null;
  }
  const SEA: CellModel = { mark: 'sea', ship: null, mine: false, hull: null };

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

  function ownModel(m: NonNullable<SalvoView['mySea']>, color: string): Map<string, CellModel> {
    const cells = new Map<string, CellModel>();
    for (const [c, r] of Object.entries(m.shots)) if (r === 'miss') cells.set(c, { ...SEA, mark: 'miss' });
    for (const s of m.ships) {
      const sunk = s.cells.length > 0 && s.hits.length === s.cells.length;
      const joins = joinsOf(s.cells);
      for (const c of s.cells) {
        const mark: Mark = sunk ? 'sunk' : s.hits.includes(c) ? 'hit' : 'ship';
        cells.set(c, { mark, ship: s.id, mine: false, hull: { color, joins: joins.get(c) ?? '', wreck: sunk, faint: false } });
      }
    }
    return cells;
  }

  function targetModel(t: TargetView): Map<string, CellModel> {
    const cells = new Map<string, CellModel>();
    const color = colorOf(colors, t.sea);
    for (const s of t.revealed ?? []) {
      const joins = joinsOf(s.cells);
      for (const c of s.cells) cells.set(c, { mark: 'ship', ship: s.id, mine: false, hull: { color, joins: joins.get(c) ?? '', wreck: false, faint: true } });
    }
    for (const row of t.lifted) for (const c of row.cells) if (!cells.has(c)) cells.set(c, { ...SEA, mark: 'sighted' });
    for (const c of t.misses) cells.set(c, { ...SEA, mark: 'miss' });
    for (const c of t.hits) cells.set(c, { ...(cells.get(c) ?? SEA), mark: 'hit' });
    for (const s of t.sunk) {
      const joins = joinsOf(s.cells);
      for (const c of s.cells) cells.set(c, { mark: 'sunk', ship: s.ship, mine: false, hull: { color, joins: joins.get(c) ?? '', wreck: true, faint: false } });
    }
    for (const x of t.mine) cells.set(x.cell, { ...(cells.get(x.cell) ?? SEA), mine: true });
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
      case 'sighted':
        return `${cell}, ship sighted`;
      default:
        return cell;
    }
  }

  const ownCells = $derived(view.mySea ? ownModel(view.mySea, myColor) : null);
  const targetCells = $derived(target ? targetModel(target) : null);
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
        const { count, from } = incoming(v, me);
        announce(
          count > 0
            ? { tone: 'hot', text: `⚠ ${count} ${count === 1 ? 'shell' : 'shells'} incoming on your sea — from ${names(from.map(handleOf))}` }
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
  }

  /** Where a shell starts, in cells from its target, by the side it comes from. */
  const FROM: Record<Side, [number, number]> = { north: [0, -6], south: [0, 6], west: [-6, 0], east: [6, 0] };
  const centre = (cell: string, size: number) => {
    const i = cellIndex(cell) ?? 0;
    return { x: (i % SIZE) * size + size / 2, y: (SIZE - 1 - Math.floor(i / SIZE)) * size + size / 2 };
  };

  // ── Sizes: the big sea fits its slot (tilted or flat), your own sea fits the side ──
  let isoOn = $state(untrack(() => !fit) && (typeof window === 'undefined' || window.innerWidth > 700));
  // Becoming a phone's table (a rotation, a narrowed window): the flat Top view keeps the cells big enough to tap.
  $effect(() => {
    if (fit) isoOn = false;
  });
  let mainEl: HTMLDivElement | undefined = $state();
  let ownEl: HTMLDivElement | undefined = $state();
  let mainBox = $state({ w: 0, h: 0 });
  let ownBox = $state({ w: 0, h: 0 });
  function observe(el: HTMLElement | undefined, set: (b: { w: number; h: number }) => void) {
    if (!el) return;
    const ro = new ResizeObserver(([e]) => set({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }
  $effect(() => observe(mainEl, (b) => (mainBox = b)));
  $effect(() => observe(ownEl, (b) => (ownBox = b)));
  const mainCell = $derived.by(() => {
    const { w, h } = mainBox;
    if (!w || !h) return 40;
    if (!isoOn) return Math.max(16, Math.floor(Math.min(w, h) / SIZE));
    return Math.max(16, Math.floor(REF * fitScale({ w: SIZE * REF, h: SIZE * REF }, { w, h }, ISO.spin, ISO.tilt, 0)));
  });
  /** Room for your sea's caption above it. */
  const OWN_CAPTION = 24;
  const ownCell = $derived(Math.max(12, Math.min(40, Math.floor(Math.min(ownBox.w, ownBox.h - OWN_CAPTION) / SIZE) || 24)));

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
  const enabled = (mode: Mode, cell: string) =>
    interactive && (mode === 'fire' ? fireCells.has(cell) : mode === 'deploy' ? placeable.has(cell) : false);
  function press(mode: Mode, cell: string) {
    if (!enabled(mode, cell)) return;
    if (mode === 'fire') selected = cell;
    else if (mode === 'deploy') place(cell);
  }
  function keydown(e: KeyboardEvent, mode: Mode, cell: string, k: number) {
    if (e.key === 'Enter' && mode === 'fire' && selected === cell && fireCmd) {
      e.preventDefault();
      fire();
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
  const STATE_TEXT: Record<string, string> = { locked: 'locked in' };
  const chips = $derived([...view.seats].sort((a, b) => SIDE_ORDER.indexOf(side(a)) - SIDE_ORDER.indexOf(side(b))));
  const mainSea = $derived(deploying ? me : targetSea);
  const mainTitle = $derived(
    deploying ? 'Your sea' : targetSea ? (targetSea === me ? 'Your sea' : `${handleOf(targetSea)}'s sea`) : '',
  );
</script>

{#snippet sea(seat: string, model: Map<string, CellModel>, size: number, main: boolean, mode: Mode, own: boolean)}
  {@const tilted = main && isoOn}
  <div class="sea3d" class:tilted style:--cell="{size}px" style:--spin="{tilted ? ISO.spin : 0}deg" style:--tilt="{tilted ? ISO.tilt : 0}deg">
    <div class="slab" style:transform={tilted ? `rotateX(${ISO.tilt}deg) rotateZ(${ISO.spin}deg)` : 'none'}>
      {#if tilted}<div class="under" aria-hidden="true"></div>{/if}
      <div
        class="face"
        role="group"
        aria-label={own ? 'Your sea' : `${handleOf(seat)}'s sea`}
        data-sea={seat}
        data-main={main ? '' : undefined}
        data-mode={mode}
      >
        {#if tilted}<i class="edge s" aria-hidden="true"></i><i class="edge e" aria-hidden="true"></i><i class="edge n" aria-hidden="true"></i><i class="edge w" aria-hidden="true"></i>{/if}
        {#each ORDER as cell, k (cell)}
          {@const m = model.get(cell) ?? SEA}
          {@const ok = enabled(mode, cell)}
          {@const land = landing.get(`${seat} ${cell}`)}
          {@const sinking = m.mark === 'sunk' ? sinkingAt(seat, m.ship) : undefined}
          {@const ghost = mode === 'deploy' && preview?.cells.has(cell)}
          <button
            type="button"
            data-cell={cell}
            data-mark={m.mark}
            aria-label={label(cell, m, own)}
            aria-disabled={!ok}
            aria-pressed={mode === 'fire' ? selected === cell : undefined}
            onclick={() => press(mode, cell)}
            onkeydown={(e) => keydown(e, mode, cell, k)}
            onpointerenter={() => mode === 'deploy' && (hover = cell)}
            onpointerleave={() => mode === 'deploy' && hover === cell && (hover = null)}
            onfocus={() => mode === 'deploy' && (hover = cell)}
          >
            <span class="water"></span>
            {#if main && k >= SIZE * (SIZE - 1)}<span class="tag col" aria-hidden="true">{LETTERS[k % SIZE]}</span>{/if}
            {#if main && k % SIZE === 0}<span class="tag row" aria-hidden="true">{SIZE - Math.floor(k / SIZE)}</span>{/if}
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
                style:--hull={m.hull.color}
              ></span>
            {/if}
            {#if m.mark === 'sighted'}<span class="sighting"></span>{/if}
            {#if m.mark === 'miss'}<span class="splash" class:land={land !== undefined} style:--d="{land ?? 0}ms"></span>{/if}
            {#if m.mark === 'hit' || m.mark === 'sunk'}
              <span class="scorch" class:land={land !== undefined} style:--d="{land ?? 0}ms"><i class="smoke"></i></span>
            {/if}
            {#if sinking !== undefined}
              <span class="bubbles" style:--d="{sinking}ms"><i></i><i></i><i></i></span>
            {/if}
            {#if m.mine}<span class="mine" style:--c={myColor}></span>{/if}
            {#if ghost}<span class="ghost" class:bad={!preview?.ok} style:--c={myColor}></span>{/if}
            {#if mode === 'fire' && selected === cell}<span class="reticle" class:sent={iAmReady} style:--c={myColor}></span>{/if}
          </button>
        {/each}
        {#if plan && !reduced}
          {#key planKey}
            <div class="fx" aria-hidden="true">
              {#each plan.flashes.filter((f) => f.sea === seat) as f, n (n)}
                {@const c = centre(f.cell, size)}
                <i class="flash" style:left="{c.x}px" style:top="{c.y}px" style:--d="{f.at}ms"></i>
              {/each}
              {#each plan.shells.filter((s) => s.sea === seat) as s, n (n)}
                {@const c = centre(s.cell, size)}
                {@const [fx, fy] = FROM[s.side]}
                <span
                  class="shell"
                  style:left="{c.x}px"
                  style:top="{c.y}px"
                  style:--sx="{fx * size}px"
                  style:--sy="{fy * size}px"
                  style:--fly="{s.flightMs}ms"
                  style:--d="{s.delay}ms"
                  style:--c={colorOf(colors, s.from)}
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
  <span class="mini" data-mini={t.sea} aria-hidden="true">
    {#each ORDER as cell (cell)}
      {@const m = model.get(cell) ?? SEA}
      {@const land = landing.get(`${t.sea} ${cell}`)}
      <i class="m-{m.mark}" class:land={land !== undefined} style:--d="{land ?? 0}ms" style:--hull={m.hull ? m.hull.color : null}></i>
    {/each}
  </span>
{/snippet}

<div class="salvo" class:fit>
  <div class="banners" aria-live="polite">
    {#if banner}
      {#key bannerKey}
        <p class="banner {banner.tone}" data-testid="banner">{banner.text}</p>
      {/key}
    {/if}
  </div>
  <div class="layout" class:deploying>
    <div class="main" bind:this={mainEl}>
      {#if mainTitle}
        <p class="caption">
          <span>{mainTitle}</span>
          {#if !deploying && targetSea && targetSea !== me}<span class="afloat">{afloatOf(targetSea)} afloat</span>{/if}
        </p>
      {/if}
      {#if deploying && ownCells && me}
        {@render sea(me, ownCells, mainCell, true, 'deploy', true)}
      {:else if target && targetCells}
        {@render sea(target.sea, targetCells, mainCell, true, live && !amOut && !!me ? 'fire' : 'view', false)}
      {/if}
    </div>

    <div class="pill" role="toolbar" aria-label="Board view">
      <button type="button" aria-pressed={isoOn} onclick={() => (isoOn = true)}>Iso</button>
      <button type="button" aria-pressed={!isoOn} onclick={() => (isoOn = false)}>Top</button>
      <button type="button" class="snd" aria-label="Sound" aria-pressed={soundOn} onclick={() => (soundOn = sound?.toggle() ?? false)}>♪</button>
    </div>

    <div class="side">
      <div class="compass" role="group" aria-label="Compass: you are south">
        <svg class="rose" viewBox="-20 -20 40 40" aria-hidden="true">
          <circle r="15" />
          {#if targetSea && !deploying}
            {@const a = { north: 0, east: 90, south: 180, west: 270 }[side(targetSea)]}
            <path d="M0,-13 L3.5,0 L0,3 L-3.5,0 Z" transform="rotate({a})" style:fill={colorOf(colors, targetSea)} />
          {/if}
        </svg>
        {#each chips as seat (seat)}
          {@const t = view.targets.find((x) => x.sea === seat)}
          {@const st = stateOf(seat)}
          {@const isMe = seat === me}
          {#snippet chipBody()}
            {#if t && !isMe}{@render mini(t)}{/if}
            <span class="who">
              <i class="dot" style:background={colorOf(colors, seat)}></i>
              <span class="name" class:human={humanSeat(seat)}>{handleOf(seat)}</span>{#if isMe}<span class="you"> (you)</span>{/if}
            </span>
            <span class="stat">{afloatOf(seat)} afloat, {view.scrap[seat] ?? 0} scrap</span>
            {#if st}<span class="state {st}">{STATE_TEXT[st] ?? st}</span>{/if}
          {/snippet}
          {#if t && !isMe && !deploying}
            <button
              type="button"
              class="chip"
              data-side={side(seat)}
              data-seat={seat}
              data-ready={view.ready.includes(seat)}
              class:holdout={holdout === seat}
              aria-pressed={targetSea === seat}
              aria-label="{handleOf(seat)}'s sea, {afloatOf(seat)} afloat{st ? `, ${st}` : ''}"
              onclick={() => (picked = seat)}>{@render chipBody()}</button
            >
          {:else}
            <div class="chip" class:me={isMe} class:gone={out(seat)} class:holdout={holdout === seat} data-side={side(seat)} data-seat={seat} data-ready={view.ready.includes(seat)}>
              {@render chipBody()}
            </div>
          {/if}
        {/each}
      </div>

      {#if !deploying && ownCells && me}
        <div class="own" bind:this={ownEl}>
          <p class="caption small"><span>Your sea</span><span class="afloat">{afloatOf(me)} afloat</span></p>
          {@render sea(me, ownCells, ownCell, false, 'view', true)}
        </div>
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
          <p class="wait" data-testid="waiting">Fleet deployed. {waitingFor.length ? `Waiting on ${names(waitingFor)}…` : ''}</p>
        {:else if live && me && !amOut}
          {#if iAmReady}
            <p class="wait" data-testid="waiting">Locked in{selected ? ` at ${selected}` : ''}. Waiting on {names(waitingFor)}…</p>
          {:else}
            <p class="aim">
              {#if selected}Aim: <b>{selected}</b> on {targetSea ? handleOf(targetSea) : ''}'s sea{:else}Pick a cell on {targetSea ? `${handleOf(targetSea)}'s` : 'a'} sea.{/if}
            </p>
            <button type="button" class="btn primary fire" data-testid="fire" disabled={!interactive || !fireCmd} onclick={fire}
              >{selected ? `Fire at ${selected}` : 'Fire'}</button
            >
          {/if}
        {:else if live && amOut}
          <p class="wait">Your fleet is down. The others play on.</p>
        {:else if !live}
          <p class="wait">Every fleet is shown.</p>
        {/if}
      </div>
    </div>
  </div>
</div>

<style>
  .salvo {
    --ocean: #071a30;
    container: salvo / size;
    position: relative;
    width: 100%;
    height: 100%;
    overflow: hidden;
    background: radial-gradient(ellipse at 40% 45%, #0e2240 0%, transparent 65%);
    user-select: none;
  }
  /* Narrow (a phone, a narrow window): the big sea on top, the view pill, then compass, your sea and the controls. */
  .layout {
    display: grid;
    height: 100%;
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: auto auto minmax(0, 1fr);
    grid-template-areas: 'main' 'pill' 'side';
  }
  .main {
    grid-area: main;
    position: relative;
    display: grid;
    place-items: center;
    height: min(calc(100cqw + 24px), 60cqh);
    min-height: 0;
    /* The caption sits in the room above the sea; no side padding, so a 340 px column still gets 42 px cells. */
    padding: 24px 0 0;
  }
  .pill {
    grid-area: pill;
    justify-self: center;
    display: flex;
    gap: 4px;
    margin: 6px 0;
    padding: 3px;
    background: rgba(13, 16, 32, 0.9);
    border: 1px solid var(--lattice);
    border-radius: 999px;
    font-size: var(--step--1);
    z-index: 3;
  }
  .pill button {
    padding: 4px 12px;
    border: 0;
    border-radius: 999px;
    background: none;
    color: var(--fog);
  }
  .pill button[aria-pressed='true'] {
    background: var(--panel-2);
    color: var(--chalk);
  }
  .side {
    grid-area: side;
    min-height: 0;
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(8.5rem, 42%);
    grid-template-rows: auto minmax(0, 1fr);
    grid-template-areas: 'compass compass' 'own actions';
    gap: 6px 10px;
    padding: 0 8px 8px;
  }
  .layout.deploying .side {
    grid-template-areas: 'compass compass' 'actions actions';
  }
  /* Wide: the big sea on the left, a side column with the compass, your sea and the controls. */
  @container salvo (min-width: 600px) and (min-aspect-ratio: 6 / 5) {
    .layout {
      grid-template-columns: minmax(0, 1fr) clamp(15rem, 32cqw, 21rem);
      grid-template-rows: minmax(0, 1fr) auto;
      grid-template-areas: 'main side' 'pill side';
    }
    .main {
      height: auto;
      padding: 28px 8px 8px;
    }
    .pill {
      margin: 0 0 12px;
    }
    .side,
    .layout.deploying .side {
      grid-template-columns: minmax(0, 1fr);
      grid-template-rows: auto minmax(0, 1fr) auto;
      grid-template-areas: 'compass' 'own' 'actions';
      padding: 12px 14px 12px 4px;
      gap: 10px;
    }
    .layout.deploying .side {
      grid-template-rows: auto auto;
      grid-template-areas: 'compass' 'actions';
      align-content: start;
    }
  }

  .caption {
    position: absolute;
    top: 6px;
    left: 10px;
    margin: 0;
    display: flex;
    gap: 0.6rem;
    align-items: baseline;
    font-size: var(--step--1);
    color: var(--fog);
    z-index: 2;
    pointer-events: none;
  }
  .caption span:first-child {
    color: var(--chalk);
    font-weight: 600;
  }
  .caption.small {
    position: static;
    margin-bottom: 4px;
  }
  .afloat {
    font-family: var(--font-silicon);
    font-variant-numeric: tabular-nums;
  }

  /* ── The compass: you at the foot, the others where they sit round the table. ── */
  .compass {
    grid-area: compass;
    display: flex;
    gap: 6px;
    align-items: stretch;
  }
  .rose {
    display: none;
  }
  .chip {
    flex: 1 1 0;
    min-width: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
    padding: 5px 4px;
    border: 1px solid var(--lattice);
    border-radius: var(--r-tile);
    background: rgba(13, 16, 32, 0.55);
    color: var(--chalk);
    font-size: 0.75rem;
    line-height: 1.2;
    text-align: center;
  }
  .chip[data-side='west'] { order: 1; }
  .chip[data-side='north'] { order: 2; }
  .chip[data-side='east'] { order: 3; }
  .chip[data-side='south'] { order: 4; }
  button.chip[aria-pressed='true'] {
    border-color: var(--chalk);
    background: var(--panel-2);
  }
  .chip.gone {
    opacity: 0.5;
  }
  .who {
    display: flex;
    align-items: center;
    gap: 4px;
    max-width: 100%;
    min-width: 0;
  }
  .who .name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--silicon);
    font-family: var(--font-silicon);
  }
  .who .name.human {
    color: var(--carbon);
    font-family: var(--font-carbon);
    font-style: italic;
    font-weight: 600;
  }
  .you {
    color: var(--fog);
    white-space: nowrap;
  }
  .dot {
    width: 0.5rem;
    height: 0.5rem;
    border-radius: 50%;
    flex: none;
  }
  .stat {
    color: var(--fog);
    font-family: var(--font-silicon);
    font-size: 0.6875rem;
  }
  .state {
    color: var(--dust);
    font-size: 0.6875rem;
  }
  .state.locked,
  .state.deployed {
    color: var(--ready);
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    animation: sv-stamp 0.45s cubic-bezier(0.2, 1.6, 0.4, 1) both;
  }
  /* The last seat everyone is waiting on. */
  .chip.holdout {
    border-color: var(--carbon);
    animation: sv-holdout 1.1s ease-in-out infinite;
  }
  .chip.holdout .state {
    color: var(--carbon);
  }

  /* ── Banners: over the board, never in the way of a click ── */
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
    border-color: #ff7a3d;
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
  .state.winner {
    color: var(--carbon);
    font-weight: 600;
  }
  .mini {
    display: grid;
    grid-template-columns: repeat(8, 6px);
    gap: 1px;
    padding: 2px;
    background: var(--ocean);
    border-radius: 3px;
  }
  .mini i {
    width: 6px;
    height: 6px;
    border-radius: 1px;
    background: rgba(120, 170, 255, 0.12);
  }
  .mini .m-miss { background: rgba(220, 235, 255, 0.55); }
  .mini .m-hit { background: #ff7a3d; }
  .mini .m-sunk { background: #6b2a1f; box-shadow: inset 0 0 0 1px #ff7a3d; }
  .mini .m-sighted { background: rgba(255, 255, 255, 0.28); }
  .mini .m-ship { background: color-mix(in oklab, var(--hull) 60%, transparent); }
  .mini .land {
    animation: sv-ping 0.5s ease-out var(--d) both;
  }
  @container salvo (min-width: 600px) and (min-aspect-ratio: 6 / 5) {
    /* A real compass: across the table at the top, left and right beside the rose, you at the foot. */
    .compass {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      grid-template-rows: auto auto auto;
      grid-template-areas: '. north .' 'west rose east' '. south .';
      gap: 4px;
      align-items: center;
      justify-items: center;
    }
    .rose {
      display: block;
      grid-area: rose;
      width: 40px;
      height: 40px;
    }
    .rose circle {
      fill: none;
      stroke: var(--lattice);
      stroke-width: 1.5;
    }
    .chip {
      width: 100%;
      max-width: 9rem;
    }
    .chip[data-side='north'] { grid-area: north; }
    .chip[data-side='west'] { grid-area: west; }
    .chip[data-side='east'] { grid-area: east; }
    .chip[data-side='south'] { grid-area: south; }
    .mini {
      grid-template-columns: repeat(8, 7px);
    }
    .mini i {
      width: 7px;
      height: 7px;
    }
  }

  .own {
    grid-area: own;
    min-height: 0;
    min-width: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
  }
  .own > .sea3d {
    flex: 1;
    min-height: 0;
    align-items: start;
  }
  .actions {
    grid-area: actions;
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-width: 0;
    font-size: var(--step--1);
  }
  .actions p {
    margin: 0;
  }
  .head {
    color: var(--chalk);
    font-weight: 600;
  }
  .hint,
  .wait {
    color: var(--fog);
  }
  .aim b {
    font-family: var(--font-silicon);
    color: var(--chalk);
  }
  .actions .row {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
  }
  .actions .btn {
    padding: 0.45rem 0.8rem;
  }
  .fire {
    min-height: 2.75rem;
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

  /* ── A sea: a slab of dark ocean, every cell a real button a hair above it. ── */
  /* The perspective lives here and the wrapper stays flat: a preserve-3d wrapper at z = 0 would sit in front
     of the slab's far half (tilted away, below z = 0) and take its clicks. Only the cells take pointer events. */
  .sea3d {
    display: grid;
    place-items: center;
    perspective: 1900px;
    perspective-origin: 50% 40%;
    pointer-events: none;
  }
  .own > .sea3d {
    perspective: 900px;
    perspective-origin: 50% 50%;
  }
  .slab {
    position: relative;
    transform-style: preserve-3d;
    transition: transform 0.6s cubic-bezier(0.2, 0.8, 0.2, 1);
  }
  .under {
    position: absolute;
    inset: -30px;
    border-radius: 30px;
    background: radial-gradient(closest-side, rgba(0, 0, 0, 0.6), rgba(0, 0, 0, 0));
    transform: translateZ(-40px);
  }
  .face {
    position: relative;
    display: grid;
    grid-template-columns: repeat(8, var(--cell));
    grid-auto-rows: var(--cell);
    transform-style: preserve-3d;
    border-radius: 2px;
    background:
      url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.012 .06' numOctaves='3' stitchTiles='stitch'/%3E%3CfeColorMatrix values='0 0 0 0 .55 0 0 0 0 .75 0 0 0 0 1 0 0 0 .16 0'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E") 0 0 / 220px,
      radial-gradient(ellipse at 28% 22%, rgba(60, 120, 190, 0.35), transparent 55%),
      radial-gradient(ellipse at 78% 80%, rgba(10, 50, 110, 0.5), transparent 60%),
      linear-gradient(165deg, #0c2d50, #061629 70%, #040c1a);
    box-shadow: inset 0 0 0 1px rgba(140, 190, 255, 0.16), inset 0 0 40px rgba(0, 0, 0, 0.5);
  }
  .edge {
    position: absolute;
    background: linear-gradient(#0a1f3a, #030a16);
    pointer-events: none;
  }
  .edge.s { left: 0; top: 100%; width: 100%; height: 18px; transform-origin: top; transform: rotateX(-90deg); }
  .edge.n { left: 0; bottom: 100%; width: 100%; height: 18px; transform-origin: bottom; transform: rotateX(90deg); }
  .edge.w { right: 100%; top: 0; width: 18px; height: 100%; transform-origin: right; transform: rotateY(-90deg); }
  .edge.e { left: 100%; top: 0; width: 18px; height: 100%; transform-origin: left; transform: rotateY(90deg); }
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
    cursor: pointer;
    pointer-events: auto;
  }
  .face > button[aria-disabled='true'] {
    cursor: default;
  }
  .face > button > * {
    pointer-events: none;
  }
  .water {
    position: absolute;
    inset: 0;
    box-shadow: inset 0 0 0 0.5px rgba(130, 180, 255, 0.16);
  }
  button[aria-disabled='false']:hover .water,
  button[aria-disabled='false']:focus-visible .water {
    background: rgba(233, 236, 255, 0.12);
  }
  button:focus-visible .water {
    outline: 2px solid var(--chalk);
    outline-offset: -2px;
  }
  .tag {
    position: absolute;
    font: 500 clamp(8px, calc(var(--cell) * 0.2), 11px) var(--font-silicon);
    color: rgba(170, 200, 255, 0.45);
  }
  .tag.col { right: 3px; bottom: 1px; }
  .tag.row { left: 3px; top: 1px; }
  .hull {
    position: absolute;
    inset: 14%;
    border-radius: 999px;
    background: linear-gradient(180deg, color-mix(in oklab, var(--hull) 75%, white), color-mix(in oklab, var(--hull) 70%, black));
    box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.25), 0 2px 4px rgba(0, 0, 0, 0.5);
  }
  /* A hull runs on into the next cell: no gap, no rounding on that side. */
  .hull.jl { left: 0; border-top-left-radius: 0; border-bottom-left-radius: 0; }
  .hull.jr { right: 0; border-top-right-radius: 0; border-bottom-right-radius: 0; }
  .hull.jt { top: 0; border-top-left-radius: 0; border-top-right-radius: 0; }
  .hull.jb { bottom: 0; border-bottom-left-radius: 0; border-bottom-right-radius: 0; }
  .hull.faint {
    opacity: 0.55;
  }
  .hull.wreck {
    background: linear-gradient(180deg, #3a2a26, #140c0a);
    box-shadow: inset 0 0 0 1px rgba(255, 122, 61, 0.35);
  }
  .sighting {
    position: absolute;
    inset: 18%;
    border: 1.5px dashed rgba(233, 236, 255, 0.55);
    border-radius: 999px;
  }
  .splash {
    position: absolute;
    left: 50%;
    top: 50%;
    width: 34%;
    height: 34%;
    translate: -50% -50%;
    border-radius: 50%;
    border: 2px solid rgba(220, 235, 255, 0.7);
  }
  .splash.land {
    animation: sv-splash 0.5s ease-out var(--d) both;
  }
  .scorch {
    position: absolute;
    inset: 12%;
    border-radius: 50%;
    background: radial-gradient(circle, #ffd27a 0%, #ff7a3d 28%, #7a1f10 60%, transparent 72%);
  }
  .scorch.land {
    animation: sv-hit 0.55s ease-out var(--d) both;
  }
  [data-mark='sunk'] .scorch {
    inset: 26%;
    opacity: 0.75;
  }
  .smoke {
    position: absolute;
    left: 30%;
    top: 0;
    width: 40%;
    height: 40%;
    border-radius: 50%;
    background: radial-gradient(circle, rgba(200, 200, 210, 0.35), transparent 70%);
    animation: sv-smoke 2.6s ease-out infinite;
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
  .mine {
    position: absolute;
    right: 5px;
    top: 5px;
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: var(--c);
  }
  .ghost {
    position: absolute;
    inset: 10%;
    border-radius: 6px;
    background: color-mix(in oklab, var(--c) 45%, transparent);
    border: 1.5px solid var(--c);
  }
  .ghost.bad {
    background: color-mix(in oklab, var(--danger) 30%, transparent);
    border-color: var(--danger);
  }
  .reticle {
    position: absolute;
    inset: 8%;
    border: 2px solid var(--c);
    border-radius: 50%;
    box-shadow: 0 0 10px var(--c);
    animation: sv-aim 1.2s ease-in-out infinite;
  }
  .reticle::before,
  .reticle::after {
    content: '';
    position: absolute;
    background: var(--c);
  }
  .reticle::before { left: 50%; top: -20%; bottom: -20%; width: 2px; translate: -50% 0; }
  .reticle::after { top: 50%; left: -20%; right: -20%; height: 2px; translate: 0 -50%; }
  .reticle.sent {
    animation: none;
    opacity: 0.6;
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
  .bb {
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
    40% { transform: scale(1.8); opacity: 1; }
    100% { transform: none; opacity: 1; }
  }
  @keyframes sv-hit {
    0% { transform: scale(0.1); opacity: 0; filter: brightness(3); }
    35% { transform: scale(1.5); opacity: 1; }
    100% { transform: none; filter: none; }
  }
  @keyframes sv-smoke {
    0% { transform: translateY(20%) scale(0.6); opacity: 0; }
    30% { opacity: 1; }
    100% { transform: translateY(-120%) scale(1.6); opacity: 0; }
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
  @keyframes sv-aim {
    0%, 100% { transform: scale(1); }
    50% { transform: scale(0.88); }
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
  @keyframes sv-ping {
    0% { transform: scale(2.5); filter: brightness(2.5); }
    100% { transform: none; filter: none; }
  }
  @media (prefers-reduced-motion: reduce) {
    .slab {
      transition: none;
    }
    .splash.land,
    .scorch.land,
    .smoke,
    .bubbles i,
    .reticle,
    .mini .land,
    .state.locked,
    .state.deployed,
    .chip.holdout,
    .banner {
      animation: none;
    }
    .smoke,
    .bubbles {
      display: none;
    }
  }
</style>
