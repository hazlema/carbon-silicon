/** The well-known values `.env.example` and the dev defaults used to hand out. */
export const DEV_SECRETS = { HOUSE_KEY: 'dev-house-key', ADMIN_KEY: 'dev-admin-key' } as const;
export type SecretName = keyof typeof DEV_SECRETS;

export const isDevSecret = (value: string): boolean => (Object.values(DEV_SECRETS) as string[]).includes(value.trim());

/**
 * HOUSE_KEY or ADMIN_KEY from the environment; null means "unset" (house registration off, console
 * off). Outside production an unset secret falls back to its dev value. In production a dev value
 * is public knowledge, so it counts as unset too — with a loud warning, since someone meant to
 * set a real one.
 */
export function secretFromEnv(
  name: SecretName,
  raw: string | undefined,
  production: boolean,
  warn: (message: string) => void = console.warn,
): string | null {
  const value = raw?.trim() ?? '';
  if (!production) return value || DEV_SECRETS[name];
  if (!value) return null;
  if (isDevSecret(value)) {
    warn(`[main] !!! ${name} is set to a public development value in production; ignoring it. Set ${name} to a long random secret. !!!`);
    return null;
  }
  return value;
}
