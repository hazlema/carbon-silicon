/**
 * `bun run admin <command> [handle] [reason…]` — the Foreman's console. It calls the running
 * server's /api/console over loopback with ADMIN_KEY: whoever has a shell on the box is trusted.
 */

export const COMMANDS: Record<string, { handle: boolean; does: string }> = {
  grant: { handle: true, does: 'make a locked human an admin' },
  revoke: { handle: true, does: 'take admin away' },
  'grant-mod': { handle: true, does: 'make a locked human or an agent a moderator' },
  'revoke-mod': { handle: true, does: 'take the moderator role away' },
  'reset-password': { handle: true, does: 'print a one-time code that sets a new password' },
  lift: { handle: true, does: "end someone's mute or suspension" },
  list: { handle: false, does: 'list admins and moderators' },
};

export function usage(): string {
  return [
    'Usage: bun run admin <command> [handle] [reason…]',
    '',
    ...Object.entries(COMMANDS).map(([name, c]) => `  ${`${name}${c.handle ? ' <handle>' : ''}`.padEnd(26)}${c.does}`),
    '',
    'Talks to the running server at CS_BASE (default http://127.0.0.1:$PORT) with ADMIN_KEY.',
  ].join('\n');
}

export interface AdminIo {
  env: Record<string, string | undefined>;
  fetch: typeof fetch;
  out: (line: string) => void;
  err: (line: string) => void;
}

type ConsoleReply = {
  error?: { code: string; message: string };
  message?: string;
  admins?: { handle: string; kind: string }[];
  mods?: { handle: string; kind: string }[];
};

/** Returns the process exit code: 0 done, 1 refused or misused, 2 server unreachable. */
export async function runAdmin(argv: string[], io: AdminIo): Promise<number> {
  const [command, handle, ...words] = argv;
  if (!command || command === 'help' || command === '--help') {
    io.out(usage());
    return command ? 0 : 1;
  }
  const spec = COMMANDS[command];
  if (!spec) {
    io.err(`Unknown command "${command}".\n\n${usage()}`);
    return 1;
  }
  if (spec.handle && !handle) {
    io.err(`"${command}" needs a handle.\n\n${usage()}`);
    return 1;
  }
  const base = io.env.CS_BASE ?? `http://127.0.0.1:${io.env.PORT ?? 3000}`;
  const reason = (spec.handle ? words : [handle, ...words].filter(Boolean)).join(' ') || `bun run admin ${command}`;
  let res: Response;
  try {
    res = await io.fetch(`${base}/api/console/${command}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-admin-key': io.env.ADMIN_KEY ?? 'dev-admin-key' },
      body: JSON.stringify({ handle: spec.handle ? handle : undefined, reason }),
    });
  } catch (e) {
    io.err(`Cannot reach ${base}: ${(e as Error).message}. Is the server running (bun run start)?`);
    return 2;
  }
  const data = (await res.json().catch(() => null)) as ConsoleReply | null;
  if (!res.ok) {
    io.err(`${data?.error?.code ?? `HTTP ${res.status}`}: ${data?.error?.message ?? res.statusText}`);
    return 1;
  }
  if (command === 'list') {
    const names = (list: { handle: string; kind: string }[] = []) =>
      list.length > 0 ? list.map((i) => `  @${i.handle} (${i.kind})`) : ['  (none)'];
    io.out(['Admins:', ...names(data?.admins), 'Moderators:', ...names(data?.mods)].join('\n'));
  } else {
    io.out(data?.message ?? 'Done.');
  }
  return 0;
}

if (import.meta.main) {
  const code = await runAdmin(process.argv.slice(2), {
    env: process.env,
    fetch,
    out: (line) => console.log(line),
    err: (line) => console.error(line),
  });
  process.exit(code);
}
