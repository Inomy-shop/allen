/**
 * Zombie execution reconciler.
 *
 * Background loop that finds executions stuck in `running` or
 * `waiting_for_input` whose owning process has died, and transitions them
 * to `failed`. Without this, the workflow concurrency cap blocks every new
 * cron-fired run — see the 2026-04-28 incident where 309 queued runs piled
 * up because 10 zombie "running" rows from days earlier (claude-cli
 * crashes that didn't update the DB) were holding their workflows hostage.
 *
 * Two ways a row gets reconciled:
 *  - meta.pid is recorded but the PID is gone from the OS (claude crashed).
 *  - meta.pid is missing AND startedAt is older than RUNTIME_GRACE_MS
 *    (e.g. workflow node-executor doesn't record pid; we fall back to age).
 *
 * Idempotent and cheap — runs every RECONCILE_INTERVAL_MS and only touches
 * rows that have already exceeded the runtime grace.
 */
import type { Db } from 'mongodb';

const RECONCILE_INTERVAL_MS = 60_000; // every 60s
const RUNTIME_GRACE_MS = 6 * 60 * 60_000; // 6h — generous for long agent runs

function isPidAlive(pid: number): boolean {
  // signal 0 doesn't deliver a signal but does the permission/existence
  // check — throws ESRCH if the process is gone.
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // EPERM means the PID exists but is owned by another user (still alive).
    return code === 'EPERM';
  }
}

async function reconcileOnce(db: Db): Promise<void> {
  const cutoff = new Date(Date.now() - RUNTIME_GRACE_MS);
  const candidates = await db
    .collection('executions')
    .find(
      { status: { $in: ['running', 'waiting_for_input'] } },
      { projection: { id: 1, status: 1, startedAt: 1, workflowName: 1, meta: 1 } },
    )
    .toArray();

  let reconciled = 0;
  for (const row of candidates) {
    const id = row.id as string | undefined;
    if (!id) continue;
    const startedAt = row.startedAt as Date | undefined;
    const pid = (row.meta as Record<string, unknown> | undefined)?.pid as number | undefined;

    let reason: string | null = null;
    if (typeof pid === 'number') {
      if (!isPidAlive(pid)) reason = `pid ${pid} no longer alive`;
    } else if (startedAt && startedAt < cutoff) {
      reason = `no meta.pid recorded and startedAt older than ${RUNTIME_GRACE_MS / 3600000}h`;
    }

    if (!reason) continue;

    const result = await db.collection('executions').updateOne(
      { id, status: { $in: ['running', 'waiting_for_input'] } },
      {
        $set: {
          status: 'failed',
          completedAt: new Date(),
          errorMessage: `Zombie reconciler: ${reason}`,
          currentNodes: [],
        },
      },
    );
    if (result.modifiedCount > 0) {
      reconciled++;
      console.log(
        `[zombie-reconciler] failed exec=${id.slice(0, 8)} workflow=${row.workflowName ?? '?'} reason=${reason}`,
      );
    }
  }

  if (reconciled > 0) {
    console.log(`[zombie-reconciler] swept ${reconciled} zombie execution(s)`);
  }
}

export function startZombieReconciler(db: Db): NodeJS.Timeout {
  const tick = (): void => {
    reconcileOnce(db).catch((err) => {
      console.error('[zombie-reconciler] tick failed:', (err as Error).message);
    });
  };
  // Fire once at boot, then on interval.
  setTimeout(tick, 5_000);
  const handle = setInterval(tick, RECONCILE_INTERVAL_MS);
  // Don't keep the event loop alive on shutdown.
  handle.unref();
  return handle;
}
