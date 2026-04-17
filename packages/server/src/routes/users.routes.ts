import { Router, type Response } from 'express';
import { ObjectId, type Db } from 'mongodb';
import { UserService, toPublicUser } from '../services/user.service.js';
import { RefreshTokenService } from '../services/refreshToken.service.js';
import { generateTempPassword } from '../auth/password.js';
import { requireAuth, type AuthedRequest } from '../middleware/requireAuth.js';
import { requireAdmin } from '../middleware/requireAdmin.js';

export function userRoutes(db: Db): Router {
  const router = Router();
  const users = new UserService(db);
  const tokens = new RefreshTokenService(db);

  // The global requireAuth at app.ts sets req.user for all /api/* routes.
  // requireAdmin checks req.user.role. If req.user is somehow missing
  // (Express quirk with router-level vs app-level middleware), re-run
  // requireAuth as a safety net.
  router.use(requireAuth, requireAdmin);

  // GET /api/users
  router.get('/', async (_req: AuthedRequest, res: Response) => {
    const list = await users.list();
    res.json(list.map(toPublicUser));
  });

  // POST /api/users  { email, name }
  router.post('/', async (req: AuthedRequest, res: Response) => {
    try {
      const { email, name } = req.body ?? {};
      if (typeof email !== 'string' || !email.includes('@')) {
        return res.status(400).json({ error: 'valid email required' });
      }
      if (typeof name !== 'string' || name.trim().length === 0) {
        return res.status(400).json({ error: 'name required' });
      }
      const tempPassword = generateTempPassword();
      const adminId = new ObjectId(req.user!.sub);
      const user = await users.createUser({
        email,
        name,
        plainPassword: tempPassword,
        role: 'user',
        mustResetPassword: true,
        createdBy: adminId,
      });
      // Temp password is shown ONCE — admin must copy & share.
      return res.status(201).json({ user: toPublicUser(user), tempPassword });
    } catch (err) {
      const status = (err as { status?: number }).status ?? 500;
      return res.status(status).json({ error: (err as Error).message });
    }
  });

  // PATCH /api/users/:id  { name?, role? }
  router.patch('/:id', async (req: AuthedRequest, res: Response) => {
    const id = String(req.params.id);
    if (!ObjectId.isValid(id)) return res.status(400).json({ error: 'invalid id' });
    const { name, role } = req.body ?? {};
    if (role !== undefined && role !== 'admin' && role !== 'user') {
      return res.status(400).json({ error: 'role must be admin or user' });
    }
    // Prevent demoting the last admin.
    if (role === 'user') {
      const target = await users.findById(id);
      if (target?.role === 'admin') {
        const count = await users.countAdmins();
        if (count <= 1) {
          return res.status(400).json({ error: 'cannot demote the last admin' });
        }
      }
    }
    await users.updateProfile(new ObjectId(id), { name, role });
    const updated = await users.findById(id);
    if (!updated) return res.status(404).json({ error: 'not_found' });
    return res.json(toPublicUser(updated));
  });

  // DELETE /api/users/:id
  router.delete('/:id', async (req: AuthedRequest, res: Response) => {
    const id = String(req.params.id);
    if (!ObjectId.isValid(id)) return res.status(400).json({ error: 'invalid id' });
    if (id === req.user!.sub) {
      return res.status(400).json({ error: 'cannot delete yourself' });
    }
    const target = await users.findById(id);
    if (!target) return res.status(404).json({ error: 'not_found' });
    if (target.role === 'admin') {
      const count = await users.countAdmins();
      if (count <= 1) return res.status(400).json({ error: 'cannot delete the last admin' });
    }
    await users.delete(new ObjectId(id));
    await tokens.revokeAllForUser(new ObjectId(id));
    return res.status(204).end();
  });

  // POST /api/users/:id/reset-temp-password
  router.post('/:id/reset-temp-password', async (req: AuthedRequest, res: Response) => {
    const id = String(req.params.id);
    if (!ObjectId.isValid(id)) return res.status(400).json({ error: 'invalid id' });
    const target = await users.findById(id);
    if (!target) return res.status(404).json({ error: 'not_found' });
    const tempPassword = generateTempPassword();
    await users.resetToTempPassword(new ObjectId(id), tempPassword);
    await tokens.revokeAllForUser(new ObjectId(id));
    return res.json({ tempPassword });
  });

  return router;
}
