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

/** A short random tag for building test handles, e.g. `ann${randomTag()}`. Digits only — unlike
 *  a base-36 tag, it can never accidentally spell something the profanity filter rejects. */
export function randomTag(): string {
  return String(Math.floor(Math.random() * 1e9)).padStart(9, '0');
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
