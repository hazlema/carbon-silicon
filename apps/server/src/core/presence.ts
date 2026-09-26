import type { IdentityPublic, PresenceInfo, Status } from '@cs/shared/protocol';
import type { Clock } from '../lib/clock';
import type { EventBus } from './bus';

interface Entry {
  info: PresenceInfo;
  connections: number;
  previous: 'ready' | 'afk';
  autoAfk: boolean;
  offlineTimer: unknown;
  idleTimer: unknown;
}

export interface PresenceOptions {
  agentTimeoutMs: number;
  humanGraceMs: number;
  humanIdleMs: number;
}

export class PresenceManager {
  private entries = new Map<string, Entry>();

  constructor(
    private bus: EventBus,
    private clock: Clock,
    private opts: PresenceOptions = { agentTimeoutMs: 90_000, humanGraceMs: 15_000, humanIdleMs: 600_000 },
  ) {}

  private iso(): string {
    return new Date(this.clock.now()).toISOString();
  }

  private upsert(identity: IdentityPublic): Entry {
    let entry = this.entries.get(identity.id);
    if (!entry) {
      entry = {
        info: { identity, status: 'ready', since: this.iso() },
        connections: 0,
        previous: 'ready',
        autoAfk: false,
        offlineTimer: null,
        idleTimer: null,
      };
      this.entries.set(identity.id, entry);
      this.bus.emit('presence.changed', entry.info);
    } else {
      entry.info = { ...entry.info, identity };
    }
    return entry;
  }

  private set(entry: Entry, status: Status): void {
    if (entry.info.status === status) return;
    entry.info = { ...entry.info, status, since: this.iso() };
    this.bus.emit('presence.changed', entry.info);
  }

  private goOffline(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.clock.clearTimeout(entry.offlineTimer);
    this.clock.clearTimeout(entry.idleTimer);
    this.entries.delete(id);
    this.bus.emit('presence.changed', { ...entry.info, status: 'offline', since: this.iso() });
  }

  private armIdle(entry: Entry): void {
    this.clock.clearTimeout(entry.idleTimer);
    entry.idleTimer = this.clock.setTimeout(() => {
      if (entry.info.status === 'ready') {
        entry.autoAfk = true;
        this.set(entry, 'afk');
      }
    }, this.opts.humanIdleMs);
  }

  humanConnected(identity: IdentityPublic): void {
    const entry = this.upsert(identity);
    entry.connections += 1;
    this.clock.clearTimeout(entry.offlineTimer);
    entry.offlineTimer = null;
    this.armIdle(entry);
  }

  humanDisconnected(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    entry.connections = Math.max(0, entry.connections - 1);
    if (entry.connections === 0) {
      this.clock.clearTimeout(entry.offlineTimer);
      entry.offlineTimer = this.clock.setTimeout(() => this.goOffline(id), this.opts.humanGraceMs);
    }
  }

  humanActivity(id: string): void {
    const entry = this.entries.get(id);
    if (!entry || entry.info.identity.kind !== 'human') return;
    if (entry.autoAfk && entry.info.status === 'afk') {
      entry.autoAfk = false;
      this.set(entry, 'ready');
    }
    this.armIdle(entry);
  }

  agentSeen(identity: IdentityPublic): void {
    const entry = this.upsert(identity);
    this.clock.clearTimeout(entry.offlineTimer);
    entry.offlineTimer = this.clock.setTimeout(() => this.goOffline(identity.id), this.opts.agentTimeoutMs);
  }

  setManualStatus(identity: IdentityPublic, status: 'ready' | 'afk'): void {
    const entry = this.upsert(identity);
    entry.autoAfk = false;
    if (entry.info.status === 'playing') {
      entry.previous = status;
      return;
    }
    this.set(entry, status);
  }

  setPlaying(id: string, playing: boolean): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    if (playing) {
      if (entry.info.status !== 'playing') {
        entry.previous = entry.info.status === 'afk' ? 'afk' : 'ready';
        this.set(entry, 'playing');
      }
    } else if (entry.info.status === 'playing') {
      this.set(entry, entry.previous);
    }
  }

  get(id: string): PresenceInfo | null {
    return this.entries.get(id)?.info ?? null;
  }

  list(): PresenceInfo[] {
    return [...this.entries.values()]
      .map((e) => e.info)
      .sort((a, b) => a.identity.handle.toLowerCase().localeCompare(b.identity.handle.toLowerCase()));
  }

  isReady(id: string): boolean {
    return this.entries.get(id)?.info.status === 'ready';
  }
}
