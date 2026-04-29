/**
 * MCP orphan sweeper.
 *
 * Background loop that hunts down processes inside allen.service's cgroup
 * that have been orphaned (reparented to systemd, PPID=1) and have been
 * alive long enough that no live execution could plausibly own them, then
 * group-kills each one. Catches the leak edge cases that escape the
 * cli-runner.ts and chat-mcp-client.ts cleanup paths:
 *
 *   - mcp-mongo-server keeps its node event loop alive via the MongoDB
 *     driver's heartbeat timer, so it never exits on stdin EOF; if its
 *     parent dies between finally-block cleanups, it survives forever.
 *   - allen.service systemd-stop's KillMode/TimeoutStopSec window can
 *     leave SIGTERM-ignoring children alive into the next allen run.
 *   - Edge-case race conditions where claude exits before its MCP
 *     children fully attach to its PGID.
 *
 * Approach (rev'd 2026-04-30 after observing the v15 sweeper miss leaks):
 *   The leaked tree is `sh -c "mongodb …"` (PPID=1, ORPHAN) → `node …
 *   /bin/mongodb mongodb://…` (PPID=sh, NOT orphan). The earlier
 *   pattern-match-the-MCP rule only saw the node child, never killed
 *   the wrapper shell, and the chain survived. Switching to "any orphan
 *   in allen.service's cgroup" — that captures the wrapper shells too,
 *   and group-killing the shell cascades down to the node MCP.
 *
 * Conservative by design — only touches processes that are
 *   (a) listed in /sys/fs/cgroup/system.slice/allen.service/cgroup.procs,
 *   (b) currently orphans (PPID=1, so reparented to init),
 *   (c) NOT allen's own main process (allen's PPID is also 1 by systemd
 *       design — without this guard the sweeper kills the parent every
 *       10 min in a perfect loop, which is exactly the failure mode the
 *       2026-04-30 audit traced 6 systemd auto-restarts to), AND
 *   (d) older than MIN_ORPHAN_AGE_MS, so a freshly-spawned child briefly
 *       orphan during a parent setpgid race is never killed.
 *
 * Long-running agents are safe: their MCP wrapper chain (npx → npm → sh
 * → node) all stay alive while the claude binary is running, so the
 * MCPs are NOT orphans during the run. They become orphans only after
 * claude exits, at which point they're correct to reap. The age guard
 * is irrelevant for long agents — by the time their MCP becomes orphan
 * (after claude exit) the process is already hours old.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';

const execFileP = promisify(execFile);

const SWEEP_INTERVAL_MS = 5 * 60_000;     // every 5 min
const MIN_ORPHAN_AGE_MS = 10 * 60_000;    // only orphans alive >10 min
const KILL_GRACE_MS = 5_000;              // SIGTERM → SIGKILL escalation
const ALLEN_CGROUP_PROCS = '/sys/fs/cgroup/system.slice/allen.service/cgroup.procs';

interface OrphanProc {
  pid: number;
  ageMs: number;
  cmd: string;
}

/**
 * Parse `etime` from `ps` (e.g. "01:23", "1-02:30:45", "1234567") to ms.
 * Returns 0 on parse failure (won't be killed).
 */
function parseEtimeMs(etime: string): number {
  // Format: [DD-]HH:MM:SS or MM:SS or SS
  const dayMatch = etime.match(/^(\d+)-(.+)$/);
  let days = 0;
  let rest = etime;
  if (dayMatch) {
    days = parseInt(dayMatch[1], 10);
    rest = dayMatch[2];
  }
  const parts = rest.split(':').map((p) => parseInt(p, 10));
  if (parts.some((n) => Number.isNaN(n))) return 0;
  let secs = 0;
  if (parts.length === 3) secs = parts[0] * 3600 + parts[1] * 60 + parts[2];
  else if (parts.length === 2) secs = parts[0] * 60 + parts[1];
  else if (parts.length === 1) secs = parts[0];
  return (days * 86400 + secs) * 1000;
}

/** Read PIDs in allen.service's cgroup. Returns empty Set on error. */
async function readAllenCgroupPids(): Promise<Set<number>> {
  try {
    const raw = await readFile(ALLEN_CGROUP_PROCS, 'utf8');
    const pids = new Set<number>();
    for (const line of raw.split('\n')) {
      const n = parseInt(line.trim(), 10);
      if (Number.isFinite(n)) pids.add(n);
    }
    return pids;
  } catch {
    // cgroup file may be unreadable in dev / non-systemd environments.
    return new Set();
  }
}

/**
 * Build the set of PIDs we must NEVER kill: this process, the
 * systemd-tracked MainPID for allen.service (which is the same PID under
 * normal conditions but defended against `--inspect`/`fork()`-style
 * setups where they could differ), and the immediate ancestor chain of
 * this process inside allen's cgroup so we don't blow up our own
 * supervisor (e.g. a wrapping `node --import` loader).
 */
async function buildSelfPidGuard(): Promise<Set<number>> {
  const guard = new Set<number>([process.pid]);

  // systemd's MainPID — read from `systemctl show` if available.
  try {
    const { stdout } = await execFileP('systemctl', ['show', 'allen', '--no-pager', '-p', 'MainPID', '--value']);
    const main = parseInt(stdout.trim(), 10);
    if (Number.isFinite(main) && main > 0) guard.add(main);
  } catch { /* systemctl unavailable — process.pid still in guard */ }

  // Walk our own ancestor chain — anything from PID 1 down to us is
  // structural (init, our supervisor) and must not be killed.
  let cur: number | null = process.pid;
  for (let depth = 0; depth < 8 && cur != null && cur > 1; depth++) {
    try {
      const { stdout } = await execFileP('ps', ['-o', 'ppid=', '-p', String(cur)]);
      const ppid = parseInt(stdout.trim(), 10);
      if (!Number.isFinite(ppid) || ppid <= 1) break;
      guard.add(ppid);
      cur = ppid;
    } catch { break; }
  }

  return guard;
}

async function findOrphanMcps(): Promise<OrphanProc[]> {
  const cgroupPids = await readAllenCgroupPids();
  if (cgroupPids.size === 0) return []; // not in systemd or no permission — bail safely

  const guard = await buildSelfPidGuard();

  const { stdout } = await execFileP('ps', ['-eo', 'pid,ppid,etime,args']);
  const out: OrphanProc[] = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('PID')) continue;
    // Greedy split: pid, ppid, etime, then everything else is args.
    const m = trimmed.match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
    if (!m) continue;
    const pid = parseInt(m[1], 10);
    const ppid = parseInt(m[2], 10);
    const etime = m[3];
    const args = m[4];
    // Hard guard: never reap our own process or our supervisor chain.
    // Without this, allen's main PID matches every other criterion (in
    // its own cgroup, PPID=1 by systemd design, etime grows past
    // MIN_ORPHAN_AGE_MS after 10 min) and the sweeper kills the parent
    // it's running inside. systemd Restart=always then bounces us, the
    // new instance kills itself 10 min later, ad infinitum.
    if (guard.has(pid)) continue;
    // Belt-and-suspenders: never kill a process whose cmdline looks like
    // the allen entrypoint, even if guard-set construction failed.
    if (args.includes('node dist/app.js') || args.includes('packages/server/dist/app')) continue;
    // Require all three: orphan, in allen's cgroup, old enough.
    if (ppid !== 1) continue;
    if (!cgroupPids.has(pid)) continue;
    const ageMs = parseEtimeMs(etime);
    if (ageMs < MIN_ORPHAN_AGE_MS) continue;
    out.push({ pid, ageMs, cmd: args.slice(0, 120) });
  }
  return out;
}

function killGroup(pid: number, sig: NodeJS.Signals): void {
  try { process.kill(-pid, sig); }
  catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return; // already gone, fine
    // EPERM / EINVAL → fall back to per-PID
    try { process.kill(pid, sig); } catch { /* ignore */ }
  }
}

async function sweepOnce(): Promise<void> {
  let orphans: OrphanProc[];
  try {
    orphans = await findOrphanMcps();
  } catch (err) {
    console.warn(`[mcp-orphan-sweeper] ps failed, will retry: ${(err as Error).message}`);
    return;
  }
  if (orphans.length === 0) return;

  console.log(`[mcp-orphan-sweeper] found ${orphans.length} orphan MCP(s) to reap`);
  for (const o of orphans) {
    const ageMin = Math.round(o.ageMs / 60_000);
    console.log(`[mcp-orphan-sweeper] killing pid=${o.pid} age=${ageMin}m cmd=${o.cmd.slice(0, 80)}`);
    killGroup(o.pid, 'SIGTERM');
    // SIGKILL escalation in case SIGTERM is ignored.
    setTimeout(() => killGroup(o.pid, 'SIGKILL'), KILL_GRACE_MS).unref();
  }
}

export function startMcpOrphanSweeper(): NodeJS.Timeout {
  const tick = (): void => {
    sweepOnce().catch((err) => {
      console.error('[mcp-orphan-sweeper] tick failed:', (err as Error).message);
    });
  };
  // Fire once at boot (after a short delay so allen has time to spawn its
  // own first-load MCPs without us reaping them as "orphans").
  setTimeout(tick, 2 * 60_000);
  const handle = setInterval(tick, SWEEP_INTERVAL_MS);
  handle.unref();
  return handle;
}
