import type { Response, NextFunction, RequestHandler } from 'express';
import type { AuthedRequest } from './requireAuth.js';

export const requireAdmin: RequestHandler = (req: AuthedRequest, res: Response, next: NextFunction) => {
  if (!req.user) return res.status(401).json({ error: 'unauthorized' });
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'admin_only' });
  return next();
};
