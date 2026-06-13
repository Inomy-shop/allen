import { Router, type Request, type Response } from 'express';
import type { Db } from 'mongodb';
import { UsageService, type UsageReport } from '../services/usage.service.js';
import { logger } from '../logger.js';

/**
 * Usage dashboard API (Settings → Usage).
 *
 * The aggregation is heavy (range scans over execution_traces +
 * chat_messages), so reports are cached in memory for 1 hour and refreshed
 * in the background:
 *   - GET serves the cached report immediately (stale-while-revalidate —
 *     a stale hit kicks off a single-flight background recompute)
 *   - an hourly timer re-warms the preset ranges (today / 7d / 30d)
 *   - POST /refresh recomputes synchronously for the Refresh button
 * The cache is disposable and never persisted — traces/messages remain the
 * only stored cost records.
 */

const USAGE_CACHE_TTL_MS = 60 * 60_000;
const MAX_CACHE_ENTRIES = 24; // presets + a handful of custom ranges (LRU)
const PRESETS = ['today', '7d', '30d'] as const;
type Preset = (typeof PRESETS)[number];

const usageCache = new Map<string, { at: number; data: UsageReport }>();
const inFlight = new Map<string, Promise<UsageReport>>();

function presetRange(preset: Preset): { from: Date; to: Date } {
  const to = new Date();
  if (preset === 'today') {
    const from = new Date(to);
    from.setHours(0, 0, 0, 0);
    return { from, to };
  }
  const days = preset === '7d' ? 7 : 30;
  return { from: new Date(to.getTime() - days * 24 * 3600_000), to };
}

function resolveRange(req: Request): { key: string; range: { from: Date; to: Date } } | null {
  const preset = req.query.range ?? (req.body as Record<string, unknown> | undefined)?.range;
  if (typeof preset === 'string' && (PRESETS as readonly string[]).includes(preset)) {
    return { key: `preset:${preset}`, range: presetRange(preset as Preset) };
  }
  const fromRaw = req.query.from ?? (req.body as Record<string, unknown> | undefined)?.from;
  const toRaw = req.query.to ?? (req.body as Record<string, unknown> | undefined)?.to;
  if (typeof fromRaw === 'string' && typeof toRaw === 'string') {
    const from = new Date(fromRaw);
    const to = new Date(toRaw);
    if (!Number.isNaN(from.getTime()) && !Number.isNaN(to.getTime()) && from < to) {
      return { key: `custom:${from.toISOString()}|${to.toISOString()}`, range: { from, to } };
    }
  }
  return null;
}

function cachePut(key: string, data: UsageReport): void {
  usageCache.delete(key);
  usageCache.set(key, { at: Date.now(), data });
  // LRU eviction — Map iteration order is insertion order.
  while (usageCache.size > MAX_CACHE_ENTRIES) {
    const oldest = usageCache.keys().next().value;
    if (oldest === undefined) break;
    usageCache.delete(oldest);
  }
}

/** Single-flight recompute: concurrent callers share one computation. */
function refresh(db: Db, key: string, range: { from: Date; to: Date }): Promise<UsageReport> {
  const running = inFlight.get(key);
  if (running) return running;
  const job = new UsageService(db)
    .computeUsage(range)
    .then((data) => {
      cachePut(key, data);
      return data;
    })
    .finally(() => {
      inFlight.delete(key);
    });
  inFlight.set(key, job);
  return job;
}

/**
 * Hourly background re-warm of the preset ranges so the dashboard always
 * answers from a fresh-enough cache. Called once from server bootstrap.
 */
export function startUsageCacheWarmer(db: Db): void {
  const warm = () => {
    for (const preset of PRESETS) {
      refresh(db, `preset:${preset}`, presetRange(preset)).catch((err) => {
        logger.warn('[usage] cache warm failed', { preset, error: (err as Error).message });
      });
    }
  };
  // First warm shortly after boot (don't block startup), then hourly.
  setTimeout(warm, 15_000).unref?.();
  setInterval(warm, USAGE_CACHE_TTL_MS).unref?.();
}

export function usageRoutes(db: Db): Router {
  const router = Router();

  // GET /api/usage?range=today|7d|30d  or  ?from=ISO&to=ISO
  router.get('/', async (req: Request, res: Response) => {
    const resolved = resolveRange(req);
    if (!resolved) return res.status(400).json({ error: 'Pass range=today|7d|30d or from/to ISO dates (from < to).' });
    const { key, range } = resolved;
    try {
      const cached = usageCache.get(key);
      if (cached) {
        const stale = Date.now() - cached.at > USAGE_CACHE_TTL_MS;
        if (stale) refresh(db, key, range).catch(() => {}); // serve stale, refresh behind
        return res.json({ ...cached.data, stale });
      }
      const data = await refresh(db, key, range); // first request: compute now
      return res.json({ ...data, stale: false });
    } catch (err: unknown) {
      return res.status(500).json({ error: (err as Error).message });
    }
  });

  // POST /api/usage/refresh — on-demand recompute (Refresh button)
  router.post('/refresh', async (req: Request, res: Response) => {
    const resolved = resolveRange(req);
    if (!resolved) return res.status(400).json({ error: 'Pass range=today|7d|30d or from/to ISO dates (from < to).' });
    try {
      usageCache.delete(resolved.key); // bypass — recompute even if fresh
      const data = await refresh(db, resolved.key, resolved.range);
      return res.json({ ...data, stale: false });
    } catch (err: unknown) {
      return res.status(500).json({ error: (err as Error).message });
    }
  });

  return router;
}

/** Test hook — clears module-level cache state between cases. */
export function __resetUsageCacheForTest(): void {
  usageCache.clear();
  inFlight.clear();
}
