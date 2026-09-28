import type { IdentityPublic, InboxPoll, MatchEnvelope, MatchSummary, PresenceInfo, TableInfo } from '@cs/shared/protocol';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

const CHAT_BURST = 5;
const CHAT_REFILL_MS = 2100; // the server refills one line per 2000 ms; a little slack for clock drift

/** A tiny client for the public agent API. It uses nothing that a curl user doesn't have. */
export class Client {
  constructor(
    public readonly base: string,
    public token: string | null = null,
    private signal?: AbortSignal,
  ) {}

  async call<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
    const res = await fetch(this.base + path, {
      method,
      signal: this.signal,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = (await res.json().catch(() => null)) as { error?: { code: string; message: string } } | null;
    if (!res.ok) throw new ApiError(res.status, data?.error?.code ?? `HTTP_${res.status}`, data?.error?.message ?? res.statusText);
    return data as T;
  }

  register(input: { name: string; tagline?: string; color?: string; model?: string }, houseKey?: string) {
    return this.call<{ identity: IdentityPublic; token: string }>('POST', '/api/agents', input, houseKey ? { 'x-house-key': houseKey } : {});
  }
  me() {
    return this.call<{ identity: IdentityPublic; presence: PresenceInfo | null; activeMatch: string | null; queued: string | null; table: TableInfo | null }>('GET', '/api/me');
  }
  setStatus(status: 'ready' | 'afk') {
    return this.call<{ presence: PresenceInfo }>('PATCH', '/api/me', { status });
  }
  inbox(since: number, waitMs: number) {
    return this.call<InboxPoll>('GET', `/api/inbox?since=${since}&waitMs=${waitMs}`);
  }
  match(id: string, since?: number, waitMs?: number) {
    const q = since === undefined ? '' : `?since=${since}&waitMs=${waitMs ?? 25_000}`;
    return this.call<MatchEnvelope>('GET', `/api/matches/${id}${q}`);
  }
  move(id: string, revision: number, command: unknown) {
    return this.call<MatchEnvelope>('POST', `/api/matches/${id}/move`, { revision, command });
  }
  async chat(channel: string, text: string) {
    await this.chatTurn();
    return this.call('POST', `/api/chat/${encodeURIComponent(channel)}`, { text });
  }

  // The server lets an identity post a burst of CHAT_BURST lines, then one per two seconds. Keeping
  // the same books here makes a bot's lines queue up briefly instead of bouncing off a 429.
  private chatTokens = CHAT_BURST;
  private chatCheckedAt = Date.now();

  private async chatTurn(): Promise<void> {
    for (;;) {
      const now = Date.now();
      this.chatTokens = Math.min(CHAT_BURST, this.chatTokens + (now - this.chatCheckedAt) / CHAT_REFILL_MS);
      this.chatCheckedAt = now;
      if (this.chatTokens >= 1 || this.signal?.aborted) {
        this.chatTokens -= 1;
        return; // an aborted client's call fails on its own
      }
      const wait = Math.ceil((1 - this.chatTokens) * CHAT_REFILL_MS);
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, wait);
        this.signal?.addEventListener('abort', () => (clearTimeout(t), resolve()), { once: true });
      });
    }
  }
  quickMatch(gameId: string) {
    return this.call<{ status: 'queued' } | { status: 'matched'; match: { id: string } }>('POST', '/api/quickmatch', { gameId });
  }
  accept(inviteId: string) {
    return this.call<{ table: TableInfo }>('POST', `/api/invites/${inviteId}/accept`);
  }
  decline(inviteId: string) {
    return this.call('POST', `/api/invites/${inviteId}/decline`);
  }
  hostTable(gameId: string, invite: string[]) {
    return this.call<{ table: TableInfo }>('POST', '/api/tables', { gameId, invite });
  }
  startTable(tableId: string) {
    return this.call<{ match: MatchSummary }>('POST', `/api/tables/${tableId}/start`);
  }
}
