import type { Doctrine, DoctrineCatalog } from '@cs/game-api';

const boost = { type: 'boolean', doc: 'Also start a boost, if one is left and none is running.' };

/** What a Lightline machine can sense and do (spec M3a §4). */
export const CATALOG: DoctrineCatalog = {
  senses: {
    ahead: { type: 'number', doc: 'Free cells straight ahead before anything blocks (0–40).' },
    left: { type: 'number', doc: 'Free cells to your left (0–40).' },
    right: { type: 'number', doc: 'Free cells to your right (0–40).' },
    open_ahead: { type: 'number', doc: 'Cells you could reach by going ahead (0–600).' },
    open_left: { type: 'number', doc: 'Cells you could reach by turning left (0–600).' },
    open_right: { type: 'number', doc: 'Cells you could reach by turning right (0–600).' },
    enemy_dist: { type: 'number', doc: 'Steps to the nearest living enemy head (999 when none).' },
    enemy_bearing: { type: 'string', doc: 'Where that enemy is, relative to your heading.', values: ['ahead', 'left', 'right', 'behind', 'none'] },
    boosts: { type: 'number', doc: 'Boosts left this round (0–3).' },
    boosting: { type: 'boolean', doc: 'A boost is running.' },
    heading: { type: 'string', doc: 'Your compass heading.', values: ['n', 'e', 's', 'w'] },
    round: { type: 'number', doc: 'The round, from 1.' },
    round_tick: { type: 'number', doc: 'Ticks since the round began (10 a second).' },
    enemies_alive: { type: 'number', doc: 'Enemy cycles still riding this round.' },
    shrinking: { type: 'boolean', doc: 'The arena is closing in (from 45 seconds).' },
  },
  actions: {
    straight: { doc: 'Keep going.', params: { boost } },
    turn: { doc: 'Turn left or right.', params: { dir: { type: 'string', doc: 'left or right', values: ['left', 'right'], required: true }, boost } },
    head: { doc: 'Face a compass direction; a reversal is ignored.', params: { dir: { type: 'string', doc: 'n, e, s or w', values: ['n', 'e', 's', 'w'], required: true }, boost } },
  },
};

/** What a machine that never sends a doctrine plays: dodge toward space, else cruise. */
export const DEFAULT_DOCTRINE: Doctrine = {
  rules: [
    {
      label: 'dodge-left',
      when: { all: [{ sense: 'ahead', op: 'lte', value: 2 }, { sense: 'open_left', op: 'gte', value: { sense: 'open_right' } }] },
      do: { act: 'turn', dir: 'left' },
    },
    { label: 'dodge-right', when: { sense: 'ahead', op: 'lte', value: 2 }, do: { act: 'turn', dir: 'right' } },
    { label: 'cruise', do: { act: 'straight' } },
  ],
};
