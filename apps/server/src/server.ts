import { stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import type { Server } from 'bun';
import type { Hono } from 'hono';
import type { Core } from './core/core';
import type { AppEnv } from './http/app';
import { WsHub, type WsData } from './ws/hub';

export interface ServerOptions {
  port: number;
  hostname: string;
  webDir: string | null;
  allowedOrigins: string[];
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
    async fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname === '/ws') {
        if (!originAllowed(req.headers.get('origin'), url.host, opts.allowedOrigins)) {
          return new Response('Forbidden origin', { status: 403 });
        }
        const identity = await core.identities.authenticate(cookieValue(req.headers.get('cookie'), 'cs_key'));
        if (!identity || identity.kind !== 'human') return new Response('Unauthorized', { status: 401 });
        if (srv.upgrade(req, { data: { identity, channels: new Set<string>(), matches: new Set<string>() } })) return undefined;
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
