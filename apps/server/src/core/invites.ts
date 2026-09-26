import type { IdentityPublic, MatchSummary } from '@cs/shared/protocol';
import type { Clock } from '../lib/clock';
import { conflict, forbidden } from '../lib/errors';
import type { EventBus } from './bus';
import type { GameManager } from './games';
import type { PresenceManager } from './presence';

interface QueueEntry {
  identity: IdentityPublic;
  gameId: string;
  timer: unknown;
}

export type QuickMatchResult = { status: 'queued' } | { status: 'matched'; match: MatchSummary };

export class InviteManager {
  private queue = new Map<string, QueueEntry>();

  constructor(
    private games: GameManager,
    private presence: PresenceManager,
    bus: EventBus,
    private clock: Clock,
    private opts: { houseFallbackMs: number } = { houseFallbackMs: 8000 },
  ) {
    bus.on('presence.changed', (p) => {
      if (p.status !== 'ready') this.leave(p.identity.id);
    });
  }

  async quickMatch(identity: IdentityPublic, gameId: string): Promise<QuickMatchResult> {
    this.games.module(gameId);
    if (identity.isHouse) throw forbidden('HOUSE_WAITS', 'House bots are matched automatically.');
    if (this.games.activeMatchOf(identity.id)) throw conflict('IN_MATCH', 'Finish your current match first.');
    if (!this.presence.isReady(identity.id)) throw conflict('NOT_READY', 'Set your status to ready first.');
    const existing = this.queue.get(identity.id);
    if (existing?.gameId === gameId) return { status: 'queued' };
    if (existing) this.leave(identity.id);
    const partner = [...this.queue.values()].find(
      (e) => e.gameId === gameId && e.identity.id !== identity.id && this.presence.isReady(e.identity.id),
    );
    if (partner) {
      const partnerEntry = partner;
      this.leave(partner.identity.id);
      const players = Math.random() < 0.5 ? [partner.identity, identity] : [identity, partner.identity];
      try {
        return { status: 'matched', match: await this.games.createMatch(gameId, players) };
      } catch (e) {
        this.queue.set(partnerEntry.identity.id, partnerEntry);
        this.arm(partnerEntry);
        throw e;
      }
    }
    const entry: QueueEntry = { identity, gameId, timer: null };
    this.queue.set(identity.id, entry);
    this.arm(entry);
    return { status: 'queued' };
  }

  private arm(entry: QueueEntry): void {
    entry.timer = this.clock.setTimeout(() => {
      this.fallback(entry.identity.id).catch((e) => console.error('[invites] fallback failed', e));
    }, this.opts.houseFallbackMs);
  }

  private async fallback(identityId: string): Promise<void> {
    const entry = this.queue.get(identityId);
    if (!entry) return;
    const bot = this.presence
      .list()
      .find((p) => p.identity.isHouse && p.status === 'ready' && !this.games.activeMatchOf(p.identity.id));
    if (!bot) {
      this.arm(entry);
      return;
    }
    this.leave(identityId);
    try {
      await this.games.createMatch(entry.gameId, [entry.identity, bot.identity]);
    } catch (e) {
      console.error('[invites] could not start house match', e);
      this.queue.set(identityId, entry);
      this.arm(entry);
    }
  }

  leave(identityId: string): boolean {
    const entry = this.queue.get(identityId);
    if (!entry) return false;
    this.clock.clearTimeout(entry.timer);
    this.queue.delete(identityId);
    return true;
  }

  queuedFor(identityId: string): string | null {
    return this.queue.get(identityId)?.gameId ?? null;
  }
}
