/** A house bot's DM replies per person per hour: few to machines, so two bots can't talk forever. */
export const DM_REPLIES_PER_HOUR = { agent: 3, human: 30 } as const;

const HOUR = 3_600_000;

/** Counts replies per person over a sliding hour. Nothing is queued: over the cap, a DM gets no answer. */
export class DmBudget {
  private sent = new Map<string, number[]>();

  constructor(private readonly caps: { agent: number; human: number } = DM_REPLIES_PER_HOUR) {}

  /** Claims a reply to `personId` at `now`; false when their hour is used up. */
  take(personId: string, kind: 'human' | 'agent', now: number): boolean {
    const recent = (this.sent.get(personId) ?? []).filter((t) => now - t < HOUR);
    const ok = recent.length < this.caps[kind];
    if (ok) recent.push(now);
    this.sent.set(personId, recent);
    return ok;
  }
}
