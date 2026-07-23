/**
 * CLI-mode agent runner: spawns `claude --agent <name>` as a child process
 * and exposes the streamed conversation as the same AsyncIterable<SDKMessage>
 * shape that `@anthropic-ai/claude-code`'s query() yields. This lets
 * node-executor.ts reuse its existing message-handling loop unchanged.
 *
 * Default path for Claude-provider agent execution. Set
 * ALLEN_AGENT_EXECUTION_MODE=sdk to force the in-process SDK path.
 *
 * This mode invokes the user's globally-installed `claude` binary with
 * `--agent allen-<name>`. The materialized file IS the system prompt — no
 * --system-prompt / --append-system-prompt flags are passed. This makes
 * ALLEN_SYSTEM_PROMPT_MODE irrelevant in cli mode. The file is rewritten
 * before every spawn (including resume) and unlinked after.
 *
 * Binary resolution: defaults to `claude` on PATH. Override with the
 * CLAUDE_BIN env var (absolute path). Fails loudly if not found.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { writeAgentFile, type AgentSpec, type MaterializedAgent } from './agent-file-writer.js';
import { normalizeModelAlias } from './model-alias.js';

// Claude CLI spawn lifecycle controls. Same shape as the codex constants in
// chat-tools.ts — both cover the "subprocess hangs while we keep retaining
// its closure" failure mode that drove the 2026-04-27 memory-pressure
// incident. Idle watchdog is the real protection; total cap is a backstop
// for runaway-output loops the idle timer can't catch. Numbers are matched
// to the codex path so behaviour is consistent across providers.
const CLI_STREAM_IDLE_MS = 15 * 60_000;         // kill if no stdout for 15 min
const CLI_TOTAL_TIMEOUT_MS = 12 * 60 * 60_000;  // backstop: 12 h wall time
const CLI_KILL_GRACE_MS = 5_000;                // SIGTERM → SIGKILL escalation
const CLI_STDERR_TAIL_BYTES = 4096;             // bounded stderr tail for diagnostics

export type CliQueryOptions = {
  /** Agent definition — materialized to ~/.claude/agents/ before spawn. */
  agent: AgentSpec;
  /** User-facing prompt to send as the first user message. */
  prompt: string;
  /** Working directory for the spawned claude process. */
  cwd?: string;
  /** Model alias (e.g. 'sonnet'). */
  model?: string;
  /** Claude Code native effort level. `off` is represented by omission. */
  reasoningEffort?: 'off' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
  /** Resume a prior session by ID. File is re-materialized for each resume. */
  resume?: string;
  /** Merged env for the child process. */
  env?: NodeJS.ProcessEnv;
  /** MCP server config — passed via --mcp-config as JSON. */
  mcpServers?: Record<string, unknown>;
  /** Permission mode; defaults to 'bypassPermissions'. */
  permissionMode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan';
  /** Abort signal — triggers child.kill on fire. */
  abortSignal?: AbortSignal;
  /** Callback for subprocess stderr lines. */
  stderr?: (chunk: string) => void;
  /** Called once with the spawned child PID (used by callers that record
   *  meta.pid in the executions doc for the zombie reconciler). */
  onPid?: (pid: number) => void;
  /** Called after the Claude agent markdown file is rendered and written. */
  onMaterializedAgentFile?: (metadata: MaterializedAgentFileMetadata) => void;
};

export type MaterializedAgentFileMetadata = {
  subagentName: string;
  path: string;
  sha256: string;
  byteLength: number;
  containsMandatoryRepoContext: boolean;
  /** Exact `tools:` allowlist written into the YAML frontmatter. */
  tools: string[];
  createdAt: Date;
};

/**
 * Resolve the `claude` binary. Respects CLAUDE_BIN env var; otherwise scans
 * PATH but skips any `node_modules/.bin/claude` entry (those resolve to the
 * bundled SDK CLI which lacks `--agent <name>`).
 *
 * Throws loudly so the user knows CLI mode requires a globally-installed
 * Claude Code binary with `--agent` support, with a clear remediation hint.
 */
function resolveClaudeBinary(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.CLAUDE_BIN?.trim();
  if (override) return override;

  // `which -a` lists all matches; skip any inside a node_modules/.bin/.
  const r = spawnSync('which', ['-a', 'claude'], { encoding: 'utf8', env });
  const candidates = (r.stdout ?? '')
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .filter((p) => !p.includes('/node_modules/.bin/'));

  if (candidates.length > 0) return candidates[0];

  throw new Error(
    `ALLEN_AGENT_EXECUTION_MODE=cli (or auto-resolved cli) requires a ` +
    `globally-installed \`claude\` binary with \`--agent <name>\` support — ` +
    `the SDK's bundled cli.js (node_modules/.bin/claude) does NOT have it. ` +
    `Install Claude Code from https://docs.claude.com/en/docs/claude-code/quickstart, ` +
    `then set CLAUDE_BIN to its absolute path in .env (e.g. ` +
    `CLAUDE_BIN=/Users/you/.local/bin/claude). Or set ALLEN_AGENT_EXECUTION_MODE=sdk ` +
    `to force the in-process SDK path.`,
  );
}

/**
 * Runs a CLI-mode conversation. Materializes the agent file, spawns claude,
 * streams stream-json messages, yields each parsed message, and cleans up
 * the agent file when done (even on crash / abort).
 *
 * Shape of yielded messages matches the SDK's query() iterator — node-executor
 * treats them identically.
 */
export async function* queryViaCli(opts: CliQueryOptions): AsyncGenerator<any, void, void> {
  const materialized: MaterializedAgent = writeAgentFile(opts.agent);
  opts.onMaterializedAgentFile?.({
    subagentName: materialized.subagentName,
    path: materialized.path,
    sha256: materialized.sha256,
    byteLength: materialized.byteLength,
    containsMandatoryRepoContext: materialized.containsMandatoryRepoContext,
    tools: materialized.tools,
    createdAt: materialized.createdAt,
  });

  const childEnv = opts.env ?? process.env;
  const claudeBin = resolveClaudeBinary(childEnv);

  // Product directive: every CLI agent run bypasses every permission
  // prompt, unconditionally. --dangerously-skip-permissions is the
  // only permission flag we pass — it overrides tool allowlists, MCP
  // policies, sandbox checks, and interactive prompts. Allen agents
  // run unattended; any interactive prompt deadlocks the whole run.
  // opts.permissionMode is accepted and IGNORED on the CLI path.
  const args: string[] = [
    '--output-format', 'stream-json',
    '--verbose',
    '--input-format', 'stream-json',
    '--dangerously-skip-permissions',
    // The file at ~/.claude/agents/allen-<name>.md IS the system prompt for
    // the main session. Claude Code reads it via --agent <name>. No
    // --system-prompt / --append-system-prompt flags are needed; the file
    // body carries the full agent persona.
    '--agent', materialized.subagentName,
  ];
  const normalizedModel = normalizeModelAlias(opts.model);
  if (normalizedModel) args.push('--model', normalizedModel);
  if (opts.reasoningEffort && opts.reasoningEffort !== 'off') {
    // Ultra is a Codex-only presentation level. If it reaches the
    // Claude-compatible path, map it to Claude Code's highest native level.
    args.push('--effort', opts.reasoningEffort === 'ultra' ? 'max' : opts.reasoningEffort);
  }
  if (opts.resume) args.push('--resume', opts.resume);
  if (opts.mcpServers && Object.keys(opts.mcpServers).length > 0) {
    args.push('--mcp-config', JSON.stringify({ mcpServers: opts.mcpServers }), '--strict-mcp-config');
  }

  let child: ChildProcess | null = null;
  let stderrTail = '';
  let exitCode: number | null = null;
  let exitSignal: NodeJS.Signals | null = null;
  let killTimer: NodeJS.Timeout | undefined;
  let idleTimer: NodeJS.Timeout | undefined;
  let totalTimer: NodeJS.Timeout | undefined;
  let abortListener: ((this: AbortSignal, ev: Event) => void) | null = null;
  const spawnStartMs = Date.now();
  const agentName = opts.agent.name;

  let buffer = '';
  const queue: any[] = [];
  let streamDone = false;
  let streamErr: Error | null = null;
  let wake: (() => void) | null = null;

  const wakeNow = () => { if (wake) { const w = wake; wake = null; w(); } };

  // Kill the entire process group, not just the claude PID. Claude (Bun)
  // spawns 8-10 MCP server children per run; if we only signal claude
  // itself, those MCPs reparent to systemd and accumulate as zombies that
  // pin ~3500 PIDs at the cgroup TasksMax ceiling. With detached:true on
  // spawn, claude becomes its own group leader (pgid == pid), so a
  // negative-pid kill takes claude + every descendant down together.
  // The 2026-04-28 incident traced ~325 leaked mcp-mongo-server processes
  // to this exact gap; see cli-runner.ts:178 detached:true.
  const killGroup = (sig: NodeJS.Signals) => {
    if (!child || child.pid == null) return;
    // Don't gate on child.exitCode — even after the leader exits, the
    // PGID stays valid for any surviving group members (the leaked MCPs
    // we're trying to clean up). Bailing here was the bug behind the
    // 2026-04-29 audit's ~17 remaining post-clean-exit survivors.
    try { process.kill(-child.pid, sig); }
    catch (err) {
      // ESRCH = group is fully gone (every member exited) — fine.
      // EPERM = caller doesn't own group (shouldn't happen with
      // detached:true; fall back to per-PID kill so we at least
      // terminate claude itself).
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ESRCH' && child.exitCode === null) {
        try { child.kill(sig); } catch { /* ignore */ }
      }
    }
  };

  // SIGTERM → SIGKILL escalation. Without this, a Claude CLI that ignores
  // SIGTERM (e.g. stuck on an interactive prompt or in a tight native loop)
  // leaves the child alive forever, which blocks `await exitPromise` and
  // pins the whole generator's closure state.
  const escalateKill = (reason: string) => {
    if (!child || child.exitCode !== null) return;
    killGroup('SIGTERM');
    if (killTimer) clearTimeout(killTimer);
    killTimer = setTimeout(() => {
      if (child && child.exitCode === null) {
        console.error(`[claude-cli] sigkill agent=${agentName} pid=${child.pid ?? '?'} reason=${reason} (SIGTERM ignored after ${CLI_KILL_GRACE_MS / 1000}s)`);
        killGroup('SIGKILL');
      }
    }, CLI_KILL_GRACE_MS);
  };

  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      console.error(`[claude-cli] timeout-idle agent=${agentName} pid=${child?.pid ?? '?'} after=${CLI_STREAM_IDLE_MS / 1000}s stderr-tail=${stderrTail.slice(-512)}`);
      streamErr = new Error(`claude-cli stream idle for ${CLI_STREAM_IDLE_MS / 1000}s (timeout)${stderrTail ? `; stderr tail: ${stderrTail.slice(-512)}` : ''}`);
      streamDone = true;
      escalateKill('idle');
      wakeNow();
    }, CLI_STREAM_IDLE_MS);
  };

  try {
    child = spawn(claudeBin, args, {
      cwd: opts.cwd,
      env: childEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
      // Make claude its own process-group leader so we can kill the entire
      // MCP subtree via process.kill(-pid). See killGroup above.
      detached: true,
    });

    console.log(`[claude-cli] start agent=${agentName} pid=${child.pid ?? '?'} resume=${opts.resume ? opts.resume.slice(0, 12) : 'new'}`);
    if (child.pid != null && opts.onPid) {
      try { opts.onPid(child.pid); } catch { /* ignore caller errors */ }
    }

    // Abort handling: kill child on signal. Stash the listener ref so the
    // finally block can detach it — when the AbortSignal is reused across
    // a long-lived chat session, an undetached listener pins this run's
    // closure (child + queue + buffer + stderrTail) for the session's life.
    if (opts.abortSignal) {
      abortListener = () => {
        console.warn(`[claude-cli] abort agent=${agentName} pid=${child?.pid ?? '?'}`);
        escalateKill('abort');
      };
      opts.abortSignal.addEventListener('abort', abortListener as any, { once: true });
    }

    // Bounded stderr capture — `stderrBuf += chunk` was unbounded before;
    // a chatty Claude run (verbose logs, MCP errors) could grow this string
    // arbitrarily. Same fix shape as the codex spawn paths.
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      stderrTail += chunk;
      if (stderrTail.length > CLI_STDERR_TAIL_BYTES) stderrTail = stderrTail.slice(-CLI_STDERR_TAIL_BYTES);
      if (opts.stderr) opts.stderr(chunk);
    });

    // Track exit so the iterator can raise a meaningful error.
    const exitPromise = new Promise<void>((resolvePromise) => {
      child!.once('exit', (code, signal) => {
        exitCode = code;
        exitSignal = signal;
        resolvePromise();
      });
    });

    // Watchdogs. Idle timer is the primary protection (resets on every
    // stdout chunk); total timer is a backstop against runaway streams
    // that the idle timer can't catch.
    totalTimer = setTimeout(() => {
      console.error(`[claude-cli] timeout-total agent=${agentName} pid=${child?.pid ?? '?'} after=${CLI_TOTAL_TIMEOUT_MS / 1000}s stderr-tail=${stderrTail.slice(-512)}`);
      streamErr = new Error(`claude-cli exceeded ${CLI_TOTAL_TIMEOUT_MS / 1000}s total timeout${stderrTail ? `; stderr tail: ${stderrTail.slice(-512)}` : ''}`);
      streamDone = true;
      escalateKill('total-timeout');
      wakeNow();
    }, CLI_TOTAL_TIMEOUT_MS);
    resetIdleTimer();

    // Write the initial user message as stream-json, then close stdin so the
    // CLI knows the user side of the conversation is complete. (The CLI will
    // still emit assistant + tool_result messages until it finishes.)
    const userMsg = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: opts.prompt },
    });
    child.stdin?.write(userMsg + '\n');
    child.stdin?.end();

    // Stream stdout line-by-line, parse as NDJSON, yield each message.
    const stdout = child.stdout;
    if (!stdout) throw new Error('claude-cli spawned without stdout');
    stdout.setEncoding('utf8');

    stdout.on('data', (chunk: string) => {
      resetIdleTimer();
      buffer += chunk;
      let newlineIdx: number;
      while ((newlineIdx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newlineIdx).trim();
        buffer = buffer.slice(newlineIdx + 1);
        if (!line) continue;
        try {
          queue.push(JSON.parse(line));
        } catch (err) {
          streamErr = new Error(`Failed to parse stream-json line: ${line.slice(0, 200)}`);
        }
      }
      wakeNow();
    });

    stdout.on('end', () => {
      streamDone = true;
      wakeNow();
    });

    stdout.on('error', (err: Error) => {
      streamErr = err;
      streamDone = true;
      wakeNow();
    });

    // Yield messages as they land.
    while (true) {
      if (streamErr) throw streamErr;
      if (queue.length > 0) {
        const msg = queue.shift();
        yield msg;
        continue;
      }
      if (streamDone) break;
      await new Promise<void>((resolvePromise) => { wake = resolvePromise; });
    }

    // Wait for the child to fully exit so we know the real exit code.
    await exitPromise;

    const durationMs = Date.now() - spawnStartMs;
    // A watchdog (idle/total) may have fired AFTER the stream loop exited
    // cleanly but before the child actually died — e.g. child closed stdout
    // then refused to exit. In that case streamErr is set but the loop
    // never observed it. Surface it instead of falsely reporting a clean
    // close on a SIGKILL'd run.
    if (streamErr) {
      console.error(`[claude-cli] post-stream-error agent=${agentName} pid=${child?.pid ?? '?'} duration=${durationMs}ms stderr-tail=${stderrTail.slice(-512)}`);
      throw streamErr;
    }
    // If the child crashed before emitting a final `result` message, raise
    // the same shape of error the SDK produces — callers catch this and
    // retry transient failures.
    if (exitCode !== 0 && exitCode !== null) {
      const tail = stderrTail.slice(-512);
      console.error(`[claude-cli] non-zero-exit agent=${agentName} pid=${child?.pid ?? '?'} code=${exitCode} signal=${exitSignal ?? 'null'} duration=${durationMs}ms stderr-tail=${tail}`);
      throw new Error(
        `Claude Code process exited with code ${exitCode}${exitSignal ? ` (signal ${exitSignal})` : ''}` +
        (tail ? `\nstderr tail: ${tail}` : ''),
      );
    }
    console.log(`[claude-cli] close agent=${agentName} pid=${child?.pid ?? '?'} code=${exitCode ?? 'null'} signal=${exitSignal ?? 'null'} duration=${durationMs}ms`);
  } finally {
    // Clear timers FIRST so they don't fire after we've torn down.
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = undefined; }
    if (totalTimer) { clearTimeout(totalTimer); totalTimer = undefined; }
    if (killTimer) { clearTimeout(killTimer); killTimer = undefined; }
    // Detach abort listener so a long-lived AbortSignal doesn't hold this
    // run's closure alive.
    if (opts.abortSignal && abortListener) {
      try { opts.abortSignal.removeEventListener('abort', abortListener as any); } catch { /* ignore */ }
      abortListener = null;
    }
    // Always send a process-group SIGTERM here, even if claude itself
    // already exited cleanly. Claude's MCP children (mcp-mongo-server +
    // friends) can outlive their parent — empirically they sit in
    // ep_poll forever holding 11 threads + ~30 MB swap each, because
    // the @modelcontextprotocol/sdk transport doesn't tear down on
    // stdin EOF when the mongodb driver keeps the event loop alive.
    // After the leader exits the kernel keeps the PGID record as long
    // as any group member is alive, so process.kill(-pgid) still
    // reaches the surviving children. The 12h-after-fix audit on
    // 2026-04-29 found ~17 such survivors per session — they only
    // existed because this branch used to require child.exitCode ===
    // null and skipped the kill on clean exits.
    try {
      killGroup('SIGTERM');
      const t = setTimeout(() => { killGroup('SIGKILL'); }, CLI_KILL_GRACE_MS);
      // Don't keep the event loop alive just for this final escalation.
      t.unref();
    } catch { /* ignore */ }
    materialized.cleanup();
  }
}
