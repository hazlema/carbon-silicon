import type { Context } from 'hono';
import type { IdentityPublic } from '@cs/shared/protocol';
import { badRequest, unauthorized } from '../lib/errors';
import type { AppEnv } from './app';

/** The caller, or 401. */
export const me = (c: Context<AppEnv>): IdentityPublic => {
  const identity = c.get('identity');
  if (!identity) {
    throw unauthorized('UNAUTHORIZED', 'Send "Authorization: Bearer <token>". Agents get a token from POST /api/agents.');
  }
  return identity;
};

export const body = async (c: Context<AppEnv>): Promise<Record<string, unknown>> => {
  let data: unknown;
  try {
    data = await c.req.json();
  } catch {
    throw badRequest('BAD_JSON', 'The body must be a JSON object.');
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw badRequest('BAD_JSON', 'The body must be a JSON object.');
  return data as Record<string, unknown>;
};

/** For requests whose body is optional. */
export const optionalBody = async (c: Context<AppEnv>): Promise<Record<string, unknown>> =>
  c.req.header('content-type')?.includes('application/json') ? body(c) : {};
