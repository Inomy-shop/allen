import { Router, type Request, type Response } from 'express';
import type { Db } from 'mongodb';
import { UserService } from '../services/user.service.js';
import { runSystemHealth } from '../services/system-health.service.js';

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

  // GET /api/system/health
  //
  // Public during onboarding. The health service intentionally returns coarse
  // status and fix guidance only; it does not expose env values, secrets,
  // absolute local paths, or raw command output.
  router.get('/health', async (_req: Request, res: Response) => {
    try {
      const health = await runSystemHealth(db);
      return res.json(health);
    } catch (err) {
      console.error('[system/health]', err);
      return res.status(500).json({ error: 'system_health_failed' });
    }
  });

  return router;
}
