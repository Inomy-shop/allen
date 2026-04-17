import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { verifyAccessToken, type AccessTokenPayload } from '../auth/jwt.js';

export interface AuthedRequest extends Request {
  user?: AccessTokenPayload;
}

export const requireAuth: RequestHandler = (req: AuthedRequest, res: Response, next: NextFunction) => {
  const header = req.headers.authorization ?? '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  try {
    req.user = verifyAccessToken(token);
    return next();
  } catch {
    return res.status(401).json({ error: 'unauthorized' });
  }
};
