/**
 * Express request/response/error logging middleware.
 *
 * requestLogger() — assigns requestId + startTime, logs on response finish.
 * errorLogger()   — logs unhandled errors before passing to next error handler.
 */

import { randomUUID } from 'node:crypto';
import type { Request, Response, NextFunction, ErrorRequestHandler, RequestHandler } from 'express';
import { logger } from '../logger.js';

// ── Global Express type augmentation ────────────────────────────────────────

declare global {
  namespace Express {
    interface Request {
      requestId: string;
      startTime: number;
    }
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const REQUEST_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const HEALTH_PATHS = new Set(['/health', '/api/health', '/ping']);

function resolveRequestId(req: Request): string {
  const header = req.headers['x-request-id'];
  const inbound = typeof header === 'string' ? header : undefined;
  if (inbound && REQUEST_ID_RE.test(inbound)) return inbound;
  return randomUUID();
}

// ── requestLogger ────────────────────────────────────────────────────────────

export function requestLogger(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const requestId = resolveRequestId(req);
    req.requestId = requestId;
    req.startTime = Date.now();

    res.setHeader('X-Request-Id', requestId);

    // Skip verbose logging for noisy health-check paths
    if (!HEALTH_PATHS.has(req.path)) {
      res.on('finish', () => {
        const statusCode = res.statusCode;
        const durationMs = Date.now() - req.startTime;
        const meta = {
          component: 'http',
          requestId,
          method: req.method,
          path: req.path,
          statusCode,
          durationMs,
          userId: (req as unknown as { user?: { id?: string } }).user?.id ?? undefined,
        };

        if (statusCode >= 500) {
          logger.error('http request', meta);
        } else if (statusCode >= 400) {
          logger.warn('http request', meta);
        } else {
          logger.info('http request', meta);
        }
      });
    }

    next();
  };
}

// ── errorLogger ──────────────────────────────────────────────────────────────

export function errorLogger(): ErrorRequestHandler {
  return (err: unknown, req: Request, res: Response, next: NextFunction): void => {
    const error = err instanceof Error ? err : new Error(String(err));
    const statusCode = (err as { statusCode?: number; status?: number }).statusCode
      ?? (err as { status?: number }).status
      ?? 500;

    if (statusCode >= 500) {
      logger.error('http error', {
        component: 'http',
        requestId: req.requestId,
        statusCode,
        error: error.message,
        stack: error.stack,
      });
    } else {
      logger.warn('http client error', {
        component: 'http',
        requestId: req.requestId,
        statusCode,
        error: error.message,
      });
    }

    next(err);
  };
}
