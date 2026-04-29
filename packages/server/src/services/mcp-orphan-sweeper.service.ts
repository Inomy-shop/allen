/**
 * MCP orphan sweeper.
 *
 * Background loop that hunts down MCP server processes that have been
 * orphaned (PPID=1, reparented to systemd) and have been alive long
 * enough that no live execution could plausibly own them, then group-
 * kills each one. Catches the leak edge cases that escape the
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
 * Conservative by design — only touches processes that are
 *   (a) matching one of the known MCP command patterns,
 *   (b) currently orphans (PPID=1, so reparented to init), AND
 *   (c) older than MIN_ORPHAN_AGE_MS, so a freshly-spawned child
 *       mid-handshake (briefly orphan before the parent attaches) is
 *       never killed.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

const SWEEP_INTERVAL_MS = 5 * 60_000;     // every 5 min
const MIN_ORPHAN_AGE_MS = 10 * 60_000;    // only orphans alive >10 min
const KILL_GRACE_MS = 5_000;              // SIGTERM → SIGKILL escalation

/** cmdline substrings that identify allen-spawned MCP servers. */
const MCP_PATTERNS: string[] = [
  '_npx/fa13bc4275c777e5/node_modules/.bin/mongodb',  // mcp-mongo-server (bin name = mongodb)
  'mcp-server-github',
  'mcp-server-linear',
  '@henkey/postgres-mcp-server',
  'aws-server.mjs',
  'opensearch-server.mjs',
  'oxylabs-server.mjs',
  'api-caller-server.mjs',
  'allen-mcp-server',
];

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

async function findOrphanMcps(): Promise<OrphanProc[]> {
  // Use ppid=1 filter directly to keep ps output small.
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
    if (ppid !== 1) continue;
    if (!MCP_PATTERNS.some((p) => args.includes(p))) continue;
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
