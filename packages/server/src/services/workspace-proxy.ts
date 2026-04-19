/**
 * Workspace Preview Proxy
 * Reverse-proxies to workspace services so browser only talks to Allen origin.
 */

import type { Request, Response, NextFunction } from 'express';
import { createProxyMiddleware, type RequestHandler } from 'http-proxy-middleware';
import type { Db } from 'mongodb';
import { WorkspaceManager } from './workspace.service.js';

const proxyCache = new Map<string, RequestHandler>();

export function createWorkspaceProxy(db: Db) {
  const manager = new WorkspaceManager(db);

  return async (req: Request, res: Response, next: NextFunction) => {
    const wsId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const serviceName = (req.query.service as string) ?? undefined;

    console.log(`[ws-proxy] lookup wsId=${wsId} service=${serviceName ?? '(auto)'} path=${req.url}`);

    const ws = await manager.get(wsId);
    if (!ws) {
      console.log(`[ws-proxy] workspace ${wsId} not found`);
      return res.status(404).json({ error: 'Workspace not found' });
    }

    const svc = serviceName
      ? ws.services.find((s: any) => s.name === serviceName)
      : ws.services.find((s: any) => s.status === 'ready');

    if (!svc || svc.status !== 'ready') {
      console.log(`[ws-proxy] service "${svc?.name ?? serviceName ?? 'none'}" not ready (status=${svc?.status ?? 'missing'})`);
      return res.status(503).json({ error: `Service "${svc?.name ?? 'none'}" not ready` });
    }

    const target = `http://127.0.0.1:${svc.port}`;
    console.log(`[ws-proxy] proxying ${req.method} ${req.url} → ${target} (service=${svc.name})`);

    const cacheKey = `${wsId}:${svc.name}:${svc.port}`;
    let proxy = proxyCache.get(cacheKey);

    if (!proxy) {
      console.log(`[ws-proxy] creating proxy for ${cacheKey} → ${target}`);
      proxy = createProxyMiddleware({
        target,
        changeOrigin: true,
        ws: true,
        pathRewrite: (path) => {
          const rewritten = path.replace(/^\/api\/workspaces\/[a-f0-9]+\/preview/, '') || '/';
          if (rewritten !== path) console.log(`[ws-proxy] pathRewrite: ${path} → ${rewritten}`);
          return rewritten;
        },
        on: {
          error: (err, _req, res) => {
            console.error(`[ws-proxy] proxy error for ${cacheKey}:`, (err as Error).message);
            if ('writeHead' in res) {
              (res as Response).status(502).json({ error: 'Service unavailable' });
            }
          },
        },
      });
      proxyCache.set(cacheKey, proxy);
    }

    return proxy(req, res, next);
  };
}

/** Clean up proxy cache when a workspace is archived */
export function clearProxyCache(wsId: string): void {
  for (const key of proxyCache.keys()) {
    if (key.startsWith(`${wsId}:`)) proxyCache.delete(key);
  }
}
