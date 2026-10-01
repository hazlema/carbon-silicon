import postgres from 'postgres';

/** Poll until `check` is truthy (real time). For async side effects such as DB writes after a timer fires. */
export async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 3000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await check()) return;
    await Bun.sleep(5);
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

/** A short random tag for building test handles, e.g. `ann${randomTag()}`. Only the digits the profanity
 *  filter doesn't read as letters (it resolves leetspeak: 1→i, 3→e, 4→a, 5→s, 7→t), so `a55…` or
 *  `p155…` can never turn up and fail a test in setup. */
export function randomTag(): string {
  return Array.from({ length: 9 }, () => '02689'[Math.floor(Math.random() * 5)]).join('');
}

/**
 * The database a test core should open: embedded PGlite in memory, or — when TEST_DATABASE_URL
 * points at a Postgres server — a brand-new database on it. One database per call, so a core's
 * boot-time clean-up (recoverOnBoot) never touches another core's matches.
 */
export async function testDatabaseUrl(): Promise<string> {
  const admin = process.env.TEST_DATABASE_URL;
  if (!admin) return 'pglite:memory';
  const name = `cs_test_${randomTag()}`;
  const sql = postgres(admin, { max: 1, onnotice: () => {} });
  try {
    await sql.unsafe(`CREATE DATABASE ${name}`);
  } finally {
    await sql.end();
  }
  const url = new URL(admin);
  url.pathname = `/${name}`;
  return url.toString();
}
