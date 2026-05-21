import type { Response, NextFunction, RequestHandler } from 'express';
import type { AuthedRequest } from './requireAuth.js';

/**
 * If the authenticated user has `mustResetPassword: true`, block every API
 * call except the ones needed to actually perform the reset or log out.
 * The flag is read from the JWT access token, so after a successful reset the
 * user gets fresh tokens with the flag cleared and regains access.
 */
export const blockIfMustReset: RequestHandler = (req: AuthedRequest, res: Response, next: NextFunction) => {
  if (!req.user?.mustResetPassword) return next();
  // Allowlist — these paths are reachable even while flagged.
  const path = req.path;
  const allowed =
    path === '/auth/reset-password' ||
    path === '/auth/logout' ||
    path === '/auth/me';
  if (allowed) return next();
  return res.status(403).json({ error: 'password_reset_required' });
};
