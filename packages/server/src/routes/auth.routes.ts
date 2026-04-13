import { Router, type Request, type Response } from 'express';
import type { Db } from 'mongodb';
import { ObjectId } from 'mongodb';
import { UserService, toPublicUser } from '../services/user.service.js';
import { RefreshTokenService } from '../services/refreshToken.service.js';
import {
  signAccessToken,
  createRefreshToken,
  verifyRefreshToken,
} from '../auth/jwt.js';
import {
  verifyPassword,
  validatePasswordStrength,
} from '../auth/password.js';
import { requireAuth, type AuthedRequest } from '../middleware/requireAuth.js';

export function authRoutes(db: Db): Router {
  const router = Router();
  const users = new UserService(db);
  const tokens = new RefreshTokenService(db);

  async function issueSession(user: Awaited<ReturnType<UserService['findByEmail']>>, userAgent: string) {
    if (!user) throw new Error('unreachable');
    const accessToken = signAccessToken({
      sub: user._id.toHexString(),
      email: user.email,
      role: user.role,
      mustResetPassword: user.mustResetPassword,
    });
    const refresh = createRefreshToken(user._id.toHexString());
    await tokens.store({
      userId: user._id,
      jti: refresh.jti,
      tokenHash: refresh.tokenHash,
      expiresAt: refresh.expiresAt,
      userAgent,
    });
    return { accessToken, refreshToken: refresh.token };
  }

  // POST /api/auth/login
  router.post('/login', async (req: Request, res: Response) => {
    try {
      const { email, password } = req.body ?? {};
      if (typeof email !== 'string' || typeof password !== 'string') {
        return res.status(400).json({ error: 'email and password required' });
      }
      const user = await users.findByEmail(email);
      if (!user) return res.status(401).json({ error: 'invalid_credentials' });
      const ok = await verifyPassword(password, user.passwordHash);
      if (!ok) return res.status(401).json({ error: 'invalid_credentials' });

      await users.touchLastLogin(user._id);
      const session = await issueSession(user, req.headers['user-agent'] ?? '');
      return res.json({
        ...session,
        user: toPublicUser({ ...user, lastLoginAt: new Date() }),
      });
    } catch (err) {
      console.error('[auth/login]', err);
      return res.status(500).json({ error: 'login_failed' });
    }
  });

  // POST /api/auth/refresh
  router.post('/refresh', async (req: Request, res: Response) => {
    try {
      const { refreshToken } = req.body ?? {};
      if (typeof refreshToken !== 'string') {
        return res.status(400).json({ error: 'refreshToken required' });
      }

      let payload;
      try {
        payload = verifyRefreshToken(refreshToken);
      } catch {
        return res.status(401).json({ error: 'invalid_refresh_token' });
      }

      const stored = await tokens.findValidByToken(refreshToken);
      if (!stored) {
        // Token signature verified but not in DB — treat as reuse.
        await tokens.revokeAllForUser(new ObjectId(payload.sub));
        return res.status(401).json({ error: 'refresh_token_reused' });
      }
      if (stored.revokedAt) {
        // Reuse of a revoked token — revoke all sessions as defensive measure.
        await tokens.revokeAllForUser(stored.userId);
        return res.status(401).json({ error: 'refresh_token_reused' });
      }
      if (stored.expiresAt.getTime() < Date.now()) {
        return res.status(401).json({ error: 'refresh_token_expired' });
      }

      const user = await users.findById(payload.sub);
      if (!user) return res.status(401).json({ error: 'user_not_found' });

      // Rotate: revoke old, issue new.
      await tokens.revokeByJti(stored.jti);
      const session = await issueSession(user, req.headers['user-agent'] ?? '');
      return res.json({ ...session, user: toPublicUser(user) });
    } catch (err) {
      console.error('[auth/refresh]', err);
      return res.status(500).json({ error: 'refresh_failed' });
    }
  });

  // POST /api/auth/logout  (authenticated — revokes the given refresh token)
  router.post('/logout', requireAuth, async (req: AuthedRequest, res: Response) => {
    try {
      const { refreshToken } = req.body ?? {};
      if (typeof refreshToken === 'string') {
        const stored = await tokens.findValidByToken(refreshToken);
        if (stored) await tokens.revokeByJti(stored.jti);
      }
      return res.json({ ok: true });
    } catch (err) {
      console.error('[auth/logout]', err);
      return res.status(500).json({ error: 'logout_failed' });
    }
  });

  // POST /api/auth/reset-password  (authenticated — called for mustReset + voluntary changes)
  router.post('/reset-password', requireAuth, async (req: AuthedRequest, res: Response) => {
    try {
      const { currentPassword, newPassword } = req.body ?? {};
      if (typeof currentPassword !== 'string' || typeof newPassword !== 'string') {
        return res.status(400).json({ error: 'currentPassword and newPassword required' });
      }
      const strength = validatePasswordStrength(newPassword);
      if (!strength.valid) return res.status(400).json({ error: strength.error });
      if (currentPassword === newPassword) {
        return res.status(400).json({ error: 'new_password_must_differ' });
      }

      const user = await users.findById(req.user!.sub);
      if (!user) return res.status(401).json({ error: 'user_not_found' });

      const ok = await verifyPassword(currentPassword, user.passwordHash);
      if (!ok) return res.status(401).json({ error: 'invalid_current_password' });

      await users.updatePassword(user._id, newPassword);
      // Revoke all existing sessions for safety, then issue a fresh pair.
      await tokens.revokeAllForUser(user._id);

      const fresh = await users.findById(user._id.toHexString());
      const session = await issueSession(fresh, req.headers['user-agent'] ?? '');
      return res.json({ ...session, user: toPublicUser(fresh!) });
    } catch (err) {
      console.error('[auth/reset-password]', err);
      return res.status(500).json({ error: 'reset_failed' });
    }
  });

  // GET /api/auth/me
  router.get('/me', requireAuth, async (req: AuthedRequest, res: Response) => {
    const user = await users.findById(req.user!.sub);
    if (!user) return res.status(401).json({ error: 'user_not_found' });
    return res.json({ user: toPublicUser(user) });
  });

  return router;
}
