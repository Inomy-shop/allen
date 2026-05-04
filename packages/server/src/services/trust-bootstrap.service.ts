/**
 * Trust-bootstrap service.
 *
 * On server start, pre-answer the one-time "trust this directory?" prompt
 * that Codex CLI and Claude CLI (with --dangerously-skip-permissions)
 * show on first invocation inside a directory. Without this, the first
 * workflow spawn inside `<ALLEN_HOME>` (or a subdirectory depending on
 * each CLI's trust scope) stalls waiting for interactive input and the
 * subprocess hangs until SIGTERM.
 *
 * We run the answer in `<ALLEN_HOME>` — the root directory Allen uses
 * for all its repos + workspaces. The CLIs persist the trust decision
 * to their own config file (`~/.codex/...`, `~/.claude/...`) so
 * subsequent invocations never re-prompt.
 *
 * Fire-and-forget: we don't block the server boot waiting for the CLIs
 * to answer. Any failure (missing `expect`, missing CLI binary, prompt
 * mismatch, timeout) is logged as a warning and the server continues.
 */

import { spawn } from 'node:child_process';
import { resolveAllenHome } from '@allen/engine';

interface TrustResult {
  name: string;
  status: 'ok' | 'skipped' | 'error';
  message?: string;
}

/**
 * Shell out to `expect` with the given script. Runs with cwd set to
 * `<ALLEN_HOME>` so the spawned CLI sees that directory as its cwd
 * and issues the trust prompt there.
 */
function runExpectScript(name: string, script: string, cwd: string, timeoutMs = 15000): Promise<TrustResult> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (r: TrustResult) => {
      if (settled) return;
      settled = true;
      resolve(r);
    };

    const child = spawn('expect', ['-c', script], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    let stderrBuf = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrBuf += chunk.toString();
    });

    child.on('error', (err) => {
      // Usually ENOENT when `expect` isn't installed.
      settle({
        name,
        status: 'skipped',
        message: `expect unavailable: ${err.message}`,
      });
    });

    child.on('exit', (code) => {
      if (code === 0) {
        settle({ name, status: 'ok' });
      } else {
        settle({
          name,
          status: 'error',
          message: `expect exited with code ${code}${stderrBuf ? ` — ${stderrBuf.trim().slice(-200)}` : ''}`,
        });
      }
    });

    // Hard timeout so a hung expect / CLI doesn't leak a subprocess.
    setTimeout(() => {
      if (!settled) {
        try { child.kill('SIGTERM'); } catch { /* ignore */ }
        settle({ name, status: 'error', message: `timed out after ${timeoutMs}ms` });
      }
    }, timeoutMs);
  });
}

/**
 * Answer Codex CLI's "trust this directory?" prompt (menu option `1`
 * labeled "continue"). The prompt regex is loose on purpose — Codex
 * changes the wording periodically but keeps the numbered menu.
 */
const CODEX_SCRIPT = `
set timeout 10
spawn codex
expect {
  -re "1\\\\..*continue" { send "1\\r" }
  eof { exit 0 }
  timeout { exit 1 }
}
# Let the CLI write the trust decision to ~/.codex/, then exit.
sleep 1
catch {exec kill [exp_pid]}
exit 0
`;

/**
 * Answer Claude CLI's "trust this directory?" prompt.
 * `--dangerously-skip-permissions` is required to surface the
 * directory-trust dialog (without it Claude runs with its normal
 * permission model and doesn't show this prompt).
 */
const CLAUDE_SCRIPT = `
set timeout 10
spawn claude --dangerously-skip-permissions
expect {
  -re "1\\\\..*trust" { send "1\\r" }
  eof { exit 0 }
  timeout { exit 1 }
}
sleep 1
catch {exec kill [exp_pid]}
exit 0
`;

/**
 * Fire-and-forget bootstrap. Runs both CLIs' trust dialogs once with
 * cwd=<ALLEN_HOME>. Skipping is graceful — any tool that isn't
 * installed on this machine is logged as a warning, not an error.
 */
export async function runTrustBootstrap(): Promise<void> {
  const cwd = resolveAllenHome();
  const results = await Promise.all([
    runExpectScript('codex', CODEX_SCRIPT, cwd),
    runExpectScript('claude', CLAUDE_SCRIPT, cwd),
  ]);

  for (const r of results) {
    const prefix = `[trust-bootstrap] ${r.name}`;
    switch (r.status) {
      case 'ok':
        console.log(`${prefix} ✓ pre-trusted ${cwd}`);
        break;
      case 'skipped':
        console.warn(`${prefix} ⚠ skipped — ${r.message}`);
        break;
      case 'error':
        console.warn(`${prefix} ⚠ failed — ${r.message}`);
        break;
    }
  }
}
