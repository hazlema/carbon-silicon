/**
 * The residents' standing orders for Lightline. They are plain doctrine, the same JSON any agent
 * can send; the house gets no extra powers. Sprocket survives: it runs from trouble and toward
 * space. OLD IRON hugs walls and turns late.
 */
export type LightlineStyle = 'survivor' | 'wallHugger';

type Rule = { label: string; when?: unknown; do: Record<string, unknown> };

const ahead = (op: string, value: unknown) => ({ sense: 'ahead', op, value });
const more = (a: string, b: string) => ({ sense: a, op: 'gt', value: { sense: b } });
const atLeast = (a: string, b: string) => ({ sense: a, op: 'gte', value: { sense: b } });

function survivor(shrinking: boolean): Rule[] {
  // Once the rings close, space matters more than distance: it looks for room sooner.
  const cramped = shrinking ? 250 : 120;
  return [
    {
      label: 'boost-away',
      when: { all: [{ sense: 'enemy_dist', op: 'lte', value: 4 }, { sense: 'enemy_bearing', op: 'ne', value: 'ahead' }, { sense: 'boosts', op: 'gt', value: 0 }, ahead('gte', 8)] },
      do: { act: 'straight', boost: true },
    },
    { label: 'veer-left', when: { all: [ahead('lte', 2), atLeast('open_left', 'open_right')] }, do: { act: 'turn', dir: 'left' } },
    { label: 'veer-right', when: ahead('lte', 2), do: { act: 'turn', dir: 'right' } },
    {
      label: 'seek-left',
      when: { all: [{ sense: 'open_ahead', op: 'lt', value: cramped }, more('open_left', 'open_ahead'), atLeast('open_left', 'open_right')] },
      do: { act: 'turn', dir: 'left' },
    },
    { label: 'seek-right', when: { all: [{ sense: 'open_ahead', op: 'lt', value: cramped }, more('open_right', 'open_ahead')] }, do: { act: 'turn', dir: 'right' } },
    { label: 'ride', do: { act: 'straight' } },
  ];
}

function wallHugger(shrinking: boolean): Rule[] {
  // It turns at the last moment, until the walls start moving; then it turns early and quits hugging.
  const late = shrinking ? 3 : 1;
  const rules: Rule[] = [
    { label: 'CORNER', when: { all: [ahead('lte', late), atLeast('open_left', 'open_right')] }, do: { act: 'turn', dir: 'left' } },
    { label: 'CORNER-R', when: ahead('lte', late), do: { act: 'turn', dir: 'right' } },
  ];
  if (!shrinking) {
    rules.push({
      label: 'HUG',
      when: { all: [{ sense: 'right', op: 'gte', value: 10 }, { sense: 'open_right', op: 'gte', value: 400 }, { sense: 'enemy_dist', op: 'gte', value: 10 }] },
      do: { act: 'turn', dir: 'right' },
    });
  }
  rules.push({ label: 'PROCEED', do: { act: 'straight' } });
  return rules;
}

export function lightlineDoctrine(style: LightlineStyle, shrinking: boolean): { rules: unknown[] } {
  return { rules: style === 'survivor' ? survivor(shrinking) : wallHugger(shrinking) };
}
