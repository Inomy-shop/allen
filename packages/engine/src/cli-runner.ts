/**
 * CLI-mode agent runner: spawns `claude --agent <name>` as a child process
 * and exposes the streamed conversation as the same AsyncIterable<SDKMessage>
 * shape that `@anthropic-ai/claude-code`'s query() yields. This lets
 * node-executor.ts reuse its existing message-handling loop unchanged.
 *
 * Activated when ALLEN_AGENT_EXECUTION_MODE=cli. The default remains `sdk`.
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

export type CliQueryOptions = {
  /** Agent definition — materialized to ~/.claude/agents/ before spawn. */
  agent: AgentSpec;
  /** User-facing prompt to send as the first user message. */
  prompt: string;
  /** Working directory for the spawned claude process. */
  cwd?: string;
  /** Model alias (e.g. 'sonnet'). */
  model?: string;
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
};

/**
 * Resolve the `claude` binary. Respects CLAUDE_BIN env var; otherwise scans
 * PATH but skips any `node_modules/.bin/claude` entry (those resolve to the
 * bundled SDK CLI which lacks `--agent <name>`).
 *
 * Throws loudly so the user knows CLI mode requires a globally-installed
 * Claude Code binary with `--agent` support, with a clear remediation hint.
 */
function resolveClaudeBinary(): string {
  const override = process.env.CLAUDE_BIN?.trim();
  if (override) return override;

  // `which -a` lists all matches; skip any inside a node_modules/.bin/.
  const r = spawnSync('which', ['-a', 'claude'], { encoding: 'utf8' });
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

  const claudeBin = resolveClaudeBinary();

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
  if (opts.resume) args.push('--resume', opts.resume);
  if (opts.mcpServers && Object.keys(opts.mcpServers).length > 0) {
    args.push('--mcp-config', JSON.stringify({ mcpServers: opts.mcpServers }));
  }

  let child: ChildProcess | null = null;
  let stderrBuf = '';
  let exitCode: number | null = null;
  let exitSignal: NodeJS.Signals | null = null;

  try {
    child = spawn(claudeBin, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Abort handling: kill child on signal.
    const onAbort = () => {
      try { child?.kill('SIGTERM'); } catch { /* ignore */ }
    };
    opts.abortSignal?.addEventListener('abort', onAbort, { once: true });

    // Stderr capture.
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      stderrBuf += chunk;
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

    let buffer = '';
    const queue: any[] = [];
    let streamDone = false;
    let streamErr: Error | null = null;
    let wake: (() => void) | null = null;

    stdout.on('data', (chunk: string) => {
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
      if (wake) { const w = wake; wake = null; w(); }
    });

    stdout.on('end', () => {
      streamDone = true;
      if (wake) { const w = wake; wake = null; w(); }
    });

    stdout.on('error', (err: Error) => {
      streamErr = err;
      streamDone = true;
      if (wake) { const w = wake; wake = null; w(); }
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

    // If the child crashed before emitting a final `result` message, raise
    // the same shape of error the SDK produces — callers catch this and
    // retry transient failures.
    if (exitCode !== 0 && exitCode !== null) {
      const tail = stderrBuf.slice(-500);
      throw new Error(
        `Claude Code process exited with code ${exitCode}${exitSignal ? ` (signal ${exitSignal})` : ''}` +
        (tail ? `\nstderr tail: ${tail}` : ''),
      );
    }
  } finally {
    try {
      if (child && child.exitCode === null) child.kill('SIGTERM');
    } catch { /* ignore */ }
    materialized.cleanup();
  }
}
