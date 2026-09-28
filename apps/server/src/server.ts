import { stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import type { Server } from 'bun';
import type { Hono } from 'hono';
import type { Core } from './core/core';
import type { AppEnv } from './http/app';
import { clientIp } from './lib/ip';
import { WsHub, type WsData } from './ws/hub';

export interface ServerOptions {
  port: number;
  hostname: string;
  webDir: string | null;
  allowedOrigins: string[];
  trustProxy?: boolean;
}

export interface RunningServer {
  server: Server<WsData>;
  hub: WsHub;
  url: string;
  stop(): Promise<void>;
}

function cookieValue(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}

function originAllowed(origin: string | null, host: string, allowed: string[]): boolean {
  if (!origin) return true; // non-browser clients
  if (allowed.includes(origin)) return true;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

async function serveStatic(pathname: string, webDir: string | null): Promise<Response> {
  if (!webDir) {
    return new Response('The web client is not built yet. Run `bun run build`.', {
      status: 503,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  }
  const root = resolve(webDir);
  let decoded = '/';
  try {
    decoded = decodeURIComponent(pathname);
  } catch {}
  const file = resolve(root, `.${decoded}`);
  if (file.startsWith(root + sep)) {
    const info = await stat(file).catch(() => null);
    if (info?.isFile()) {
      const immutable = decoded.startsWith('/_app/immutable/');
      return new Response(Bun.file(file), {
        headers: { 'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache' },
      });
    }
  }
  return new Response(Bun.file(join(root, 'index.html')), {
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' },
  });
}

export function startServer(core: Core, app: Hono<AppEnv>, opts: ServerOptions): RunningServer {
  const hub = new WsHub(core);
  const server = Bun.serve<WsData>({
    port: opts.port,
    hostname: opts.hostname,
    // Seconds a connection may sit silent. Bun's default (10) cuts off agent long-polls,
    // which may wait up to 30 s (waitMs <= 30000), so leave generous headroom.
    idleTimeout: 60,
    async fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname === '/ws') {
        if (!originAllowed(req.headers.get('origin'), url.host, opts.allowedOrigins)) {
          return new Response('Forbidden origin', { status: 403 });
        }
        const auth = await core.identities.authenticateSession(cookieValue(req.headers.get('cookie'), 'cs_key'));
        if (!auth || auth.identity.kind !== 'human') return new Response('Unauthorized', { status: 401 });
        // An IP ban doesn't refuse the upgrade — a signed-in session still logs in over HTTP from a
        // banned address (M2a policy: only new guest names/agent registrations are refused there),
        // so refusing here would strand a locked account with no live connection. The `ip.banned`
        // bus event closes this socket with SIGNED_OUT if/when the address is banned (R-11).
        const ip = clientIp(req.headers.get('x-forwarded-for'), srv.requestIP(req)?.address, opts.trustProxy ?? false);
        const data: WsData = {
          identity: auth.identity,
          sessionId: auth.sessionId,
          ip,
          channels: new Set<string>(),
          matches: new Set<string>(),
          tables: new Set<string>(),
        };
        if (srv.upgrade(req, { data })) return undefined;
        return new Response('Expected a WebSocket upgrade', { status: 426 });
      }
      if (url.pathname === '/api' || url.pathname.startsWith('/api/') || url.pathname === '/llms.txt') {
        return app.fetch(req, { ip: srv.requestIP(req)?.address });
      }
      return serveStatic(url.pathname, opts.webDir);
    },
    websocket: hub.handlers,
  });
  return {
    server,
    hub,
    url: `http://${server.hostname}:${server.port}`,
    stop: async () => {
      hub.stop();
      await server.stop(true);
    },
  };
}
