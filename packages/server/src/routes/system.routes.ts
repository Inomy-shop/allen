import { Router, type Request, type Response } from 'express';
import type { Db } from 'mongodb';
import { UserService } from '../services/user.service.js';

export function systemRoutes(db: Db): Router {
  const router = Router();
  const users = new UserService(db);

  // GET /api/system/onboarding-status
  //
  // Public by design: the UI needs to know whether it should show first-admin
  // bootstrap before anyone can log in. Keep the response coarse and avoid
  // exposing user records, emails, env config, or filesystem details.
  router.get('/onboarding-status', async (_req: Request, res: Response) => {
    try {
      const [userCount, adminCount] = await Promise.all([
        users.countUsers(),
        users.countAdmins(),
      ]);
      const isFirstRun = userCount === 0;
      return res.json({
        isFirstRun,
        userCount,
        adminCount,
        complete: !isFirstRun,
        step: isFirstRun ? 'account' : 'complete',
      });
    } catch (err) {
      console.error('[system/onboarding-status]', err);
      return res.status(500).json({ error: 'onboarding_status_failed' });
    }
  });

  return router;
}
