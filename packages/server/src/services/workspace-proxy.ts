/**
 * Workspace Preview Proxy
 * Reverse-proxies HTTP requests AND WebSocket upgrades to workspace
 * services so the browser only ever talks to the Allen origin (or a
 * <service>-<wsId>.<allenDomain> subdomain that resolves to the same
 * Allen process).
 */

import type { Request, Response, NextFunction } from 'express';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { createProxyMiddleware, type RequestHandler } from 'http-proxy-middleware';
import type { Db } from 'mongodb';
import { WorkspaceManager } from './workspace.service.js';

// Cached at module scope so the same proxy instance is reused for HTTP
// requests and WebSocket upgrades — http-proxy-middleware ties its
// internal `upgrade` state to the proxy object, so a per-request proxy
// would lose every WS frame after the handshake.
const proxyCache = new Map<string, RequestHandler>();

type LookupResult =
  | { kind: 'ok'; proxy: RequestHandler; serviceName: string }
  | { kind: 'not_found' }
  | { kind: 'not_ready'; serviceName: string; status: string };

async function lookupProxy(manager: WorkspaceManager, wsId: string, requestedService?: string): Promise<LookupResult> {
  const ws = await manager.get(wsId);
  if (!ws) return { kind: 'not_found' };

  const svc = requestedService
    ? ws.services.find((s) => s.name === requestedService)
    : ws.services.find((s) => s.status === 'ready');

  if (!svc) return { kind: 'not_ready', serviceName: requestedService ?? 'none', status: 'missing' };
  if (svc.status !== 'ready') return { kind: 'not_ready', serviceName: svc.name, status: svc.status };

  const target = `http://127.0.0.1:${svc.port}`;
  const cacheKey = `${wsId}:${svc.name}:${svc.port}`;
  let proxy = proxyCache.get(cacheKey);
  if (!proxy) {
    proxy = createProxyMiddleware({
      target,
      changeOrigin: true,
      ws: true,
      pathRewrite: (path) => path.replace(/^\/api\/workspaces\/[a-f0-9]+\/preview/, '') || '/',
      on: {
        error: (err, _req, res) => {
          console.error(`[ws-proxy] proxy error for ${cacheKey}:`, (err as Error).message);
          if (res && 'writeHead' in res) {
            (res as Response).status(502).json({ error: 'Service unavailable' });
          }
        },
      },
    });
    proxyCache.set(cacheKey, proxy);
  }
  return { kind: 'ok', proxy, serviceName: svc.name };
}

export function createWorkspaceProxy(db: Db) {
  const manager = new WorkspaceManager(db);

  return async (req: Request, res: Response, next: NextFunction) => {
    const wsId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const requestedService = (req.query.service as string) ?? undefined;

    const result = await lookupProxy(manager, wsId, requestedService);
    if (result.kind === 'not_found') {
      console.log(`[ws-proxy] workspace ${wsId} not found`);
      return res.status(404).json({ error: 'Workspace not found' });
    }
    if (result.kind === 'not_ready') {
      console.log(`[ws-proxy] service "${result.serviceName}" not ready (status=${result.status})`);
      return res.status(503).json({ error: `Service "${result.serviceName}" not ready` });
    }
    return result.proxy(req, res, next);
  };
}

/**
 * Upgrade handler for the workspace subdomain proxy. Attach to the main
 * HTTP server's 'upgrade' event so Vite HMR (and any other WebSocket the
 * workspace's services use) gets forwarded through the subdomain.
 *
 * `parseTarget` returns the workspace id and service name to forward to,
 * or null if the upgrade isn't for a workspace service. Returning null
 * leaves the socket alone so other handlers (terminal WS, file-watch WS
 * if they ever move onto the main port) can claim it.
 */
export function createWorkspaceUpgradeHandler(
  db: Db,
  parseTarget: (req: IncomingMessage) => { wsId: string; serviceName?: string } | null,
) {
  const manager = new WorkspaceManager(db);

  return async (req: IncomingMessage, socket: Duplex, head: Buffer): Promise<boolean> => {
    const target = parseTarget(req);
    if (!target) return false;

    const result = await lookupProxy(manager, target.wsId, target.serviceName);
    if (result.kind !== 'ok') {
      console.log(`[ws-proxy] WS upgrade rejected — wsId=${target.wsId} svc=${target.serviceName ?? '(auto)'} reason=${result.kind}`);
      socket.destroy();
      return true;
    }

    const upgrade = (result.proxy as unknown as { upgrade?: (req: IncomingMessage, socket: Duplex, head: Buffer) => void }).upgrade;
    if (!upgrade) {
      console.error(`[ws-proxy] proxy missing upgrade() method — cannot forward WS for ${target.wsId}:${result.serviceName}`);
      socket.destroy();
      return true;
    }
    upgrade(req, socket, head);
    return true;
  };
}

/** Clean up proxy cache when a workspace is archived */
export function clearProxyCache(wsId: string): void {
  for (const key of proxyCache.keys()) {
    if (key.startsWith(`${wsId}:`)) proxyCache.delete(key);
  }
}
