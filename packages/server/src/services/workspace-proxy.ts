/**
 * Workspace Preview Proxy
 * Reverse-proxies to workspace services so browser only talks to FlowForge origin.
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

    const ws = await manager.get(wsId);
    if (!ws) return res.status(404).json({ error: 'Workspace not found' });

    // Each service gets its own subdomain — no smart routing.
    // e.g. ui-<wsid>.domain, backend-<wsid>.domain, backend2-<wsid>.domain
    const svc = serviceName
      ? ws.services.find((s: any) => s.name === serviceName)
      : ws.services.find((s: any) => s.status === 'ready');

    if (!svc || svc.status !== 'ready') {
      return res.status(503).json({ error: `Service "${svc?.name ?? 'none'}" not ready` });
    }

    const cacheKey = `${wsId}:${svc.name}:${svc.port}`;
    let proxy = proxyCache.get(cacheKey);

    if (!proxy) {
      proxy = createProxyMiddleware({
        target: `http://127.0.0.1:${svc.port}`,
        changeOrigin: true,
        ws: true,
        pathRewrite: (path) => {
          // Strip /api/workspaces/:id/preview prefix
          return path.replace(/^\/api\/workspaces\/[a-f0-9]+\/preview/, '') || '/';
        },
        on: {
          error: (err, _req, res) => {
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
