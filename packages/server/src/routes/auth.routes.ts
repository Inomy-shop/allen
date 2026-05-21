import { Router, type Request, type Response } from 'express';
import type { Db } from 'mongodb';
import { ObjectId, MongoServerError } from 'mongodb';
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

  // POST /api/auth/bootstrap
  //
  // Public first-run endpoint. It is only valid while the users collection is
  // empty; after any user exists, this route is permanently closed for that
  // instance. The database unique email index is the final race guard.
  router.post('/bootstrap', async (req: Request, res: Response) => {
    try {
      const userCount = await users.countUsers();
      if (userCount > 0) {
        return res.status(409).json({ error: 'bootstrap_closed' });
      }

      const { name, email, password } = req.body ?? {};
      if (typeof name !== 'string' || typeof email !== 'string' || typeof password !== 'string') {
        return res.status(400).json({ error: 'name, email and password required' });
      }

      const cleanName = name.trim();
      const cleanEmail = email.trim().toLowerCase();
      if (!cleanName) return res.status(400).json({ error: 'name is required' });
      if (!cleanEmail.includes('@')) return res.status(400).json({ error: 'valid email is required' });

      const strength = validatePasswordStrength(password);
      if (!strength.valid) return res.status(400).json({ error: strength.error });

      let lockAcquired = false;
      try {
        const bootstrapLocks = db.collection<{ _id: string; createdAt: Date }>('bootstrap_locks');
        await bootstrapLocks.insertOne({
          _id: 'first-admin',
          createdAt: new Date(),
        });
        lockAcquired = true;

        const lockedUserCount = await users.countUsers();
        if (lockedUserCount > 0) {
          return res.status(409).json({ error: 'bootstrap_closed' });
        }

        const user = await users.createUser({
          email: cleanEmail,
          name: cleanName,
          plainPassword: password,
          role: 'admin',
          mustResetPassword: false,
          createdBy: 'system',
        });
        await users.touchLastLogin(user._id);
        const fresh = { ...user, lastLoginAt: new Date() };
        const session = await issueSession(fresh, req.headers['user-agent'] ?? '');
        return res.status(201).json({
          ...session,
          user: toPublicUser(fresh),
        });
      } catch (err) {
        if (err instanceof MongoServerError && err.code === 11000) {
          return res.status(409).json({ error: 'bootstrap_closed' });
        }
        if (lockAcquired) {
          await db.collection<{ _id: string }>('bootstrap_locks').deleteOne({ _id: 'first-admin' }).catch(() => {});
        }
        throw err;
      }
    } catch (err) {
      const status = (err as { status?: number }).status ?? 500;
      const message = (err as Error).message;
      if (status === 409 || message.includes('already exists')) {
        return res.status(409).json({ error: 'bootstrap_closed' });
      }
      console.error('[auth/bootstrap]', err);
      return res.status(500).json({ error: 'bootstrap_failed' });
    }
  });

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
