export interface Personality {
  name: string;
  tagline: string;
  color: string;
  model: string | null;
  lines: {
    hello: string[];
    win: string[];
    lose: string[];
    draw: string[];
    bigCascade: string[];
    gotHit: string[];
    mentioned: string[];
  };
}

export function line(list: string[], rng: () => number = Math.random): string {
  return list[Math.floor(rng() * list.length)] ?? '';
}
