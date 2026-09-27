import { testDatabaseUrl } from '@cs/server/testing';
import { afterAll, describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import type { IdentityPublic } from '@cs/shared/protocol';
import { runAdmin } from '../admin';
import { createCore } from '../core/core';
import { randomTag } from '../lib/testing';
import { createApp } from './app';

const diaryDir = fileURLToPath(new URL('../__fixtures__/diary', import.meta.url));
const core = await createCore({ databaseUrl: await testDatabaseUrl(), houseKey: 'hk', diaryDir, countdownMs: 0, sweepEveryMs: 0 });
const on = createApp(core, { apiDocs: '', llmsTxt: '', adminKey: 'k3y' });
const off = createApp(core, { apiDocs: '', llmsTxt: '' });
afterAll(() => core.close());

const meta = { label: 'test', ip: null };
async function post(app: typeof on, command: string, body: unknown, opts: { ip?: string; key?: string; xff?: string } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json', 'x-admin-key': opts.key ?? 'k3y' };
  if (opts.xff) headers['x-forwarded-for'] = opts.xff;
  const res = await app.request(`/api/console/${command}`, { method: 'POST', headers, body: JSON.stringify(body) }, { ip: opts.ip ?? '127.0.0.1' });
  return { status: res.status, data: (await res.json()) as any };
}
const guest = async () => (await core.identities.createHuman(`g${randomTag()}`, meta)).identity;
const locked = async (): Promise<IdentityPublic> => (await core.accounts.lock(await guest(), 'correct horse battery')).identity;
const agent = async () => (await core.identities.registerAgent({ name: `a${randomTag()}` }, null)).identity;

describe('the console door', () => {
  test('it answers only the server itself, with the right key, when switched on', async () => {
    const refused = [
      await post(off, 'list', {}),
      await post(on, 'list', {}, { ip: '10.0.0.8' }),
      await post(on, 'list', {}, { ip: '10.0.0.8', xff: '127.0.0.1' }),
      await post(on, 'list', {}, { key: 'wrong' }),
      // behind nginx every request has a loopback socket address; only the absence of
      // X-Forwarded-For (which the CLI never sends and nginx always adds) proves it's the CLI
      await post(on, 'list', {}, { ip: '127.0.0.1', xff: '203.0.113.5' }),
    ];
    expect(refused.map((r) => [r.status, r.data.error.code])).toEqual(Array(5).fill([403, 'CONSOLE_OFF']));
    expect(refused[0].data.error.message).toContain('ADMIN_KEY');
    expect((await post(on, 'list', {}, { ip: '::1' })).status).toBe(200);
    expect((await post(on, 'list', {}, { ip: '::ffff:127.0.0.1' })).status).toBe(200);
  });

  test('grant needs a locked human; grant-mod takes a locked human or an agent', async () => {
    const g = await guest();
    expect((await post(on, 'grant', { handle: g.handle })).data.error.code).toBe('NOT_LOCKED');
    const bot = await agent();
    expect((await post(on, 'grant', { handle: bot.handle })).data.error.code).toBe('BAD_ROLE');
    expect((await post(on, 'grant', { handle: 'nobody_here_3' })).data.error.code).toBe('NO_USER');

    const boss = await locked();
    const granted = await post(on, 'grant', { handle: `@${boss.handle}` });
    expect(granted.data.identity.role).toBe('admin');
    expect(granted.data.message).toBe(`@${boss.handle} is now an admin.`);
    expect((await core.moderation.log({ targetId: boss.id }))[0]).toMatchObject({ actor: 'console', action: 'role' });

    expect((await post(on, 'grant-mod', { handle: bot.handle })).data.identity.role).toBe('mod');
    expect((await post(on, 'revoke-mod', { handle: bot.handle })).data.identity.role).toBe('user');
    expect((await post(on, 'revoke-mod', { handle: bot.handle })).data.error.code).toBe('NO_ROLE');
    expect((await post(on, 'revoke', { handle: boss.handle })).data.identity.role).toBe('user');

    const list = await post(on, 'list', {});
    expect(list.data.admins.some((a: IdentityPublic) => a.id === boss.id)).toBe(false);
  });

  test('reset-password prints a code that recovers the account', async () => {
    const p = await locked();
    const reset = await post(on, 'reset-password', { handle: p.handle });
    expect(reset.data.code).toStartWith('csr_');
    expect(reset.data.message).toContain(reset.data.code);
    const recovered = await core.accounts.recover(p.handle, reset.data.code, 'a brand new password', meta);
    expect(recovered.identity.id).toBe(p.id);
  });

  test('lift ends a sanction', async () => {
    const p = await guest();
    await core.moderation.suspend({ kind: 'console' }, p.id, 'test', 60);
    const lifted = await post(on, 'lift', { handle: p.handle });
    expect(lifted.data.message).toBe(`@${p.handle} is free to talk and play again.`);
    expect(core.moderation.sanctionOf(p.id)).toBeNull();
  });

  test('list excludes released identities even though they keep their role', async () => {
    const boss = await locked();
    await post(on, 'grant', { handle: boss.handle });
    await core.moderation.release({ kind: 'console' }, boss.id, 'test release');
    const list = await post(on, 'list', {});
    expect(list.data.admins.some((a: IdentityPublic) => a.id === boss.id)).toBe(false);
  });
});

describe('bun run admin', () => {
  const lines: string[] = [];
  const errors: string[] = [];
  const io = (env: Record<string, string | undefined>, fetchImpl?: typeof fetch) => ({
    env,
    fetch:
      fetchImpl ??
      (((url: string | URL | Request, init?: RequestInit) =>
        on.request(new URL(String(url)).pathname, init, { ip: '127.0.0.1' })) as typeof fetch),
    out: (l: string) => lines.push(l),
    err: (l: string) => errors.push(l),
  });

  test('commands reach the console and print what happened', async () => {
    const bot = await agent();
    expect(await runAdmin(['grant-mod', bot.handle], io({ ADMIN_KEY: 'k3y' }))).toBe(0);
    expect(lines.at(-1)).toBe(`@${bot.handle} is now a moderator.`);
    expect(await runAdmin(['list'], io({ ADMIN_KEY: 'k3y' }))).toBe(0);
    expect(lines.at(-1)).toContain(`@${bot.handle} (agent)`);
  });

  test('mistakes exit non-zero with a reason', async () => {
    expect(await runAdmin([], io({}))).toBe(1);
    expect(await runAdmin(['help'], io({}))).toBe(0);
    expect(lines.at(-1)).toContain('Usage: bun run admin');
    expect(await runAdmin(['frobnicate'], io({}))).toBe(1);
    expect(errors.at(-1)).toContain('Unknown command "frobnicate"');
    expect(await runAdmin(['grant'], io({}))).toBe(1);
    expect(errors.at(-1)).toContain('"grant" needs a handle');
    expect(await runAdmin(['list'], io({ ADMIN_KEY: 'nope' }))).toBe(1);
    expect(errors.at(-1)).toStartWith('CONSOLE_OFF:');
    const down = (() => Promise.reject(new Error('connection refused'))) as unknown as typeof fetch;
    expect(await runAdmin(['list'], io({ ADMIN_KEY: 'k3y', PORT: '3999' }, down))).toBe(2);
    expect(errors.at(-1)).toContain('Cannot reach http://127.0.0.1:3999');
  });
});
