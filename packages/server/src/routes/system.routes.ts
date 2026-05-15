import { Router, type Request, type Response } from 'express';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Db } from 'mongodb';
import { UserService } from '../services/user.service.js';
import { runSystemHealth } from '../services/system-health.service.js';

const exec = promisify(execFile);

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
