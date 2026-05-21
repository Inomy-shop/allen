import { Router, type Request, type Response } from 'express';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ObjectId, type Db } from 'mongodb';
import { UserService } from '../services/user.service.js';
import { runSystemHealth } from '../services/system-health.service.js';
import { contextProviderRuntimeConfig } from '../services/context/config/context-provider-config.js';
import { requireAuth, type AuthedRequest } from '../middleware/requireAuth.js';

const exec = promisify(execFile);
const ONBOARDING_STEPS = new Set(['health', 'repository', 'first_workflow', 'complete']);

function dateIso(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string' && value) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
  return null;
}

function onboardingProgressPayload(onboarding: Record<string, unknown>) {
  const completedAt = dateIso(onboarding.completedAt);
  const skippedAt = dateIso(onboarding.skippedAt);
  const rawStep = typeof onboarding.step === 'string' ? onboarding.step : 'health';
  const step = ONBOARDING_STEPS.has(rawStep) ? rawStep : 'health';
  const complete = Boolean(completedAt || skippedAt);
  return {
    complete,
    skipped: Boolean(skippedAt),
    step: complete ? 'complete' : step,
    completedAt,
    skippedAt,
  };
}

type ExecErrorWithOutput = Error & {
  stdout?: string;
  stderr?: string;
  killed?: boolean;
  signal?: string;
};

function sanitizeSshHost(input: unknown): string {
  const host = String(input ?? 'github.com').trim().toLowerCase();
  if (!/^[a-z0-9.-]+$/.test(host)) {
    throw new Error('Invalid SSH host');
  }
  return host;
}

async function runSshAuthCheck(host: string): Promise<{ stdout: string; stderr: string; timedOut: boolean }> {
  try {
    const { stdout, stderr } = await exec('ssh', [
      '-T',
      '-o', 'BatchMode=yes',
      '-o', 'StrictHostKeyChecking=accept-new',
      `git@${host}`,
    ], { timeout: 8000 });
    return { stdout, stderr, timedOut: false };
  } catch (err) {
    const output = err as ExecErrorWithOutput;
    return {
      stdout: output.stdout ?? '',
      stderr: output.stderr ?? '',
      timedOut: output.killed === true || output.signal === 'SIGTERM',
    };
  }
}

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

  router.get('/runtime-config', (_req: Request, res: Response) => {
    return res.json({
      contextEngine: contextProviderRuntimeConfig(),
    });
  });

  router.get('/onboarding-progress', requireAuth, async (req: AuthedRequest, res: Response) => {
    try {
      const userId = req.user?.sub;
      if (!userId) return res.status(401).json({ error: 'unauthorized' });
      const user = await db.collection('users').findOne(
        { _id: new ObjectId(userId) },
        { projection: { onboarding: 1 } },
      );
      const onboarding = (user?.onboarding ?? {}) as Record<string, unknown>;
      return res.json(onboardingProgressPayload(onboarding));
    } catch (err) {
      console.error('[system/onboarding-progress]', err);
      return res.status(500).json({ error: 'onboarding_progress_failed' });
    }
  });

  router.patch('/onboarding-progress', requireAuth, async (req: AuthedRequest, res: Response) => {
    try {
      const userId = req.user?.sub;
      if (!userId) return res.status(401).json({ error: 'unauthorized' });

      const step = typeof req.body?.step === 'string' ? req.body.step : undefined;
      const action = typeof req.body?.action === 'string' ? req.body.action : undefined;
      if (step && !ONBOARDING_STEPS.has(step)) {
        return res.status(400).json({ error: 'invalid_onboarding_step' });
      }
      if (action && action !== 'complete' && action !== 'skip') {
        return res.status(400).json({ error: 'invalid_onboarding_action' });
      }

      const now = new Date();
      const currentUser = await db.collection('users').findOne(
        { _id: new ObjectId(userId) },
        { projection: { onboarding: 1 } },
      );
      const currentOnboarding = (currentUser?.onboarding ?? {}) as Record<string, unknown>;
      const currentProgress = onboardingProgressPayload(currentOnboarding);
      if (!action && currentProgress.complete) {
        return res.json(currentProgress);
      }

      const set: Record<string, unknown> = {
        'onboarding.updatedAt': now,
      };
      const unset: Record<string, ''> = {};
      if (step) set['onboarding.step'] = step;
      if (action === 'complete') {
        set['onboarding.step'] = 'complete';
        set['onboarding.completedAt'] = now;
        unset['onboarding.skippedAt'] = '';
      }
      if (action === 'skip') {
        set['onboarding.step'] = 'complete';
        set['onboarding.skippedAt'] = now;
        unset['onboarding.completedAt'] = '';
      }

      const update: Record<string, unknown> = { $set: set };
      if (Object.keys(unset).length > 0) update.$unset = unset;
      await db.collection('users').updateOne({ _id: new ObjectId(userId) }, update);
      return res.json(onboardingProgressPayload({
        ...currentOnboarding,
        ...(step ? { step } : {}),
        ...(action === 'complete' ? { step: 'complete', completedAt: now, skippedAt: undefined } : {}),
        ...(action === 'skip' ? { step: 'complete', skippedAt: now, completedAt: undefined } : {}),
        updatedAt: now,
      }));
    } catch (err) {
      console.error('[system/onboarding-progress]', err);
      return res.status(500).json({ error: 'onboarding_progress_failed' });
    }
  });

  // POST /api/system/verify-ssh
  //
  // Verifies SSH auth for Git hosting without exposing raw command output.
  router.post('/verify-ssh', async (req: Request, res: Response) => {
    try {
      const host = sanitizeSshHost(req.body?.host);
      const { stdout, stderr, timedOut } = await runSshAuthCheck(host);
      const text = `${stdout}\n${stderr}`;
      const ok = /successfully authenticated|authenticated/i.test(text);
      return res.json({
        ok,
        host,
        detail: ok
          ? `SSH authentication to ${host} is working.`
          : timedOut
            ? `SSH authentication to ${host} timed out.`
            : `SSH did not confirm authentication to ${host}.`,
        fix: ok ? undefined : {
          summary: `Add an SSH key to ${host}, then retry.`,
          commands: [`ssh -T git@${host}`],
          docsPath: 'docs/first-workflow.md',
        },
      });
    } catch (err) {
      const message = (err as Error).message;
      const host = (() => {
        try { return sanitizeSshHost(req.body?.host); } catch { return 'github.com'; }
      })();
      return res.json({
        ok: false,
        host,
        detail: message === 'Invalid SSH host'
          ? message
          : `SSH authentication to ${host} failed or timed out.`,
        fix: {
          summary: `Add an SSH key to ${host}, then retry.`,
          commands: [`ssh -T git@${host}`],
          docsPath: 'docs/first-workflow.md',
        },
      });
    }
  });

  return router;
}
