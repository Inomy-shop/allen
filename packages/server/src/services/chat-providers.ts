/**
 * Chat LLM Providers
 * FlowForge runs LLMs exclusively through CLI tools — no API-key-based providers.
 * Two providers: `codex` (OpenAI Codex CLI) and `claude-cli` (Anthropic Claude Code CLI).
 * Both authenticate via their CLI's local auth, both support MCP for tool access.
 */

import type { Db } from 'mongodb';
import type { ChatTraceEvent } from './chat-llm.js';
import { resolve, dirname } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// ── Shared Types ──

export type ChatProvider = 'codex' | 'claude-cli';

export interface ProviderMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface ProviderCallbacks {
  onText: (text: string) => void;
  onThinking?: (thinking: string) => void;
  onToolStart: (tool: string, args: Record<string, unknown>, id: string) => void;
  onToolResult: (tool: string, result: Record<string, unknown>, id: string, durationMs: number) => void;
  /** Called as soon as the session/thread ID is known (for early persistence) */
  onSessionId?: (sessionId: string) => void;
  /** Abort signal — wired to the claude-cli subprocess so clicking Stop
   *  in chat kills the process instead of just closing the SSE connection. */
  signal?: AbortSignal;
}

export interface ProviderResult {
  text: string;
  costUsd: number;
  sessionId?: string;
  trace: ChatTraceEvent[];
}

export interface ProviderConfig {
  provider: ChatProvider;
  label: string;
  models: string[];
  defaultModel: string;
  requiresKey: string | null;  // env var name or null if no key needed
  supportsMcp: boolean;
  supportsStreaming: boolean;
  supportsSessionResume: boolean;
}

// ── Provider Registry ──

export const PROVIDERS: ProviderConfig[] = [
  {
    provider: 'codex',
    label: 'Codex (CLI)',
    models: ['gpt-5.4', 'o3', 'o4-mini', 'codex-mini'],
    defaultModel: 'gpt-5.4',
    requiresKey: null,
    supportsMcp: true,
    supportsStreaming: false,
    supportsSessionResume: true,
  },
  {
    provider: 'claude-cli',
    label: 'Claude (CLI)',
    models: ['sonnet', 'opus', 'haiku'],
    defaultModel: 'sonnet',
    requiresKey: null,
    supportsMcp: true,
    supportsStreaming: true,
    supportsSessionResume: true,
  },
];

// ── Logger ──

const LOG = '\x1b[36m[chat]\x1b[0m';
function log(msg: string, data?: unknown): void {
  const ts = new Date().toISOString().slice(11, 23);
  if (data !== undefined) {
    const str = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
    console.log(`${LOG} ${ts} ${msg}`, str.length > 500 ? str.slice(0, 500) + '...' : str);
  } else {
    console.log(`${LOG} ${ts} ${msg}`);
  }
}

// ── Sync MCP servers to Codex CLI ──

/** Path to the FlowForge MCP server script.
 * Uses import.meta.url to resolve relative to THIS file — works regardless of
 * process.cwd(). App is deployed under ~/flowforge/ so snap-installed codex
 * can access it (snap has home dir access). */
function getFlowForgeMcpServerPath(): string {
  const thisDir = dirname(fileURLToPath(import.meta.url));
  // In dev (tsx): thisDir = .../src/services, script is in the same dir
  const tsPath = resolve(thisDir, 'flowforge-mcp-server.ts');
  if (existsSync(tsPath)) return tsPath;
  // In prod (compiled): thisDir = .../dist/services, script is in the same dir
  return resolve(thisDir, 'flowforge-mcp-server.js');
}

export async function syncMcpToCodex(db: Db): Promise<void> {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execFileAsync = promisify(execFile);
  const { McpService } = await import('./mcp.service.js');
  const service = new McpService(db);
  const servers = (await service.list()).filter(s => s.enabled && s.type === 'stdio');

  // Get current codex MCP servers
  let existingOutput = '';
  try {
    const { stdout } = await execFileAsync('codex', ['mcp', 'list'], { timeout: 5000 });
    existingOutput = stdout;
  } catch { /* no servers yet */ }

  // Always remove + re-add the FlowForge MCP entry so env changes (port,
  // JWT_ACCESS_SECRET rotations, etc.) propagate to Codex on every sync.
  // Older registrations won't have JWT_ACCESS_SECRET and would silently
  // 401 on every tool call — this is how we heal that drift.
  try {
    if (existingOutput.includes('flowforge')) {
      await execFileAsync('codex', ['mcp', 'remove', 'flowforge'], { timeout: 10000 }).catch(() => {});
    }
    const serverPath = getFlowForgeMcpServerPath();
    // In dev: .ts file → run with npx tsx. In prod: .js file → run with node.
    const runner = serverPath.endsWith('.ts') ? ['npx', 'tsx'] : ['node'];
    await execFileAsync('codex', [
      'mcp', 'add', 'flowforge',
      '--env', `FLOWFORGE_API_URL=http://localhost:${process.env.PORT ?? '4023'}`,
      // Shared with the MCP subprocess so it can mint its own access token
      // when calling back into /api/* — see flowforge-mcp-server.ts.
      '--env', `JWT_ACCESS_SECRET=${process.env.JWT_ACCESS_SECRET ?? ''}`,
      '--', ...runner, serverPath,
    ], { timeout: 10000 });
    log('Registered FlowForge MCP server with Codex CLI');
  } catch (err) {
    log(`Failed to register FlowForge MCP with Codex: ${(err as Error).message}`);
  }

  // Register external MCP servers — resolve @secret: refs in env AND args
  // so Codex gets plaintext values. Also silence dotenv's stdout banner.
  // Always remove and re-add so config drift (e.g. missing DOTENV_CONFIG_QUIET
  // from older registrations) gets corrected every sync.
  const { resolveEnvSecrets, resolveArgSecrets } = await import('./mcp.service.js');
  for (const server of servers) {
    try {
      const [resolvedEnv, resolvedArgs] = await Promise.all([
        resolveEnvSecrets(server.env, db),
        resolveArgSecrets(server.args, db),
      ]);
      const envWithQuiet = { ...resolvedEnv, DOTENV_CONFIG_QUIET: 'true' };
      // Remove first (may fail if not registered — that's fine)
      if (existingOutput.includes(server.name)) {
        await execFileAsync('codex', ['mcp', 'remove', server.name], { timeout: 5000 }).catch(() => {});
      }
      const cmdArgs = ['mcp', 'add', server.name];
      for (const [k, v] of Object.entries(envWithQuiet)) cmdArgs.push('--env', `${k}=${v}`);
      cmdArgs.push('--', server.command!, ...resolvedArgs);
      await execFileAsync('codex', cmdArgs, { timeout: 10000 });
      log(`Registered MCP server with Codex CLI: ${server.name}`);
    } catch (err) {
      log(`Failed to register ${server.name} with Codex: ${(err as Error).message}`);
    }
  }
}

// ════════════════════════════════════════════════════════════════════════════
// PROVIDER: Codex CLI (default — no API key needed)
// ════════════════════════════════════════════════════════════════════════════

export async function runCodexCLI(
  db: Db,
  systemPrompt: string,
  messages: ProviderMessage[],
  model: string,
  callbacks: ProviderCallbacks,
  resumeSessionId?: string,
  skipTools?: boolean,
  cwd?: string,
  resolved?: import('./agent-settings.js').ResolvedSettings,
): Promise<ProviderResult & { sessionId?: string }> {
  const { spawn } = await import('node:child_process');
  const { toCodexArgs } = await import('./agent-settings.js');
  const trace: ChatTraceEvent[] = [];
  const lastUserMsg = messages.length > 0 ? messages[messages.length - 1].content : '';

  let prompt = lastUserMsg;
  if (!resumeSessionId && !skipTools) {
    prompt = `${systemPrompt}\n\n${lastUserMsg}`;
  }

  // Extra -c flags from the resolved settings (model, model_reasoning_effort).
  // Codex accepts `-c key=value` on both `exec` and `exec resume`, so we
  // forward these on *every* call — otherwise mid-session effort overrides
  // get silently dropped on resumed threads.
  //
  // On resume we intentionally strip the `model=...` pair, because a thread
  // is pinned to the model it was created with — Codex will reject a model
  // change on resume. Reasoning-effort changes ARE supported mid-thread.
  const resolvedArgs = resolved ? toCodexArgs(resolved) : [];
  const resumeSafeArgs: string[] = [];
  for (let i = 0; i < resolvedArgs.length; i += 2) {
    const flag = resolvedArgs[i];      // '-c'
    const kv = resolvedArgs[i + 1] ?? ''; // 'model="..."' or 'model_reasoning_effort="..."'
    if (kv.startsWith('model=')) continue;
    resumeSafeArgs.push(flag, kv);
  }

  const args: string[] = ['exec'];
  if (resumeSessionId) {
    args.push('resume', '--json', '--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check');
    // Apply resume-safe overrides (effort only) BEFORE the session id + prompt.
    if (resumeSafeArgs.length > 0) args.push(...resumeSafeArgs);
    args.push(resumeSessionId, prompt);
  } else {
    args.push('--json', '--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check');
    if (resolvedArgs.length > 0) {
      args.push(...resolvedArgs);
    } else if (model && model !== 'default') {
      args.push('-c', `model="${model}"`);
    }
    args.push(prompt);
  }

  // Note: MCP sync runs once on server boot, not per chat call.
  // Avoids races between parallel chats rewriting Codex's global config.

  log(`Spawning codex: ${args.slice(0, 4).join(' ')}...`);

  return new Promise<ProviderResult & { sessionId?: string }>((resolve, reject) => {
    const fallbackCwd = cwd || process.cwd();
    const proc = spawn('codex', args, {
      cwd: fallbackCwd,
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    proc.on('error', (err) => {
      reject(new Error(`Failed to spawn codex: ${err.message}. Is codex CLI installed?`));
    });

    // Wire abort signal so clicking Stop in chat kills the Codex subprocess.
    if (callbacks.signal) {
      const onAbort = () => {
        try { proc.kill('SIGTERM'); } catch { /* already dead */ }
      };
      if (callbacks.signal.aborted) {
        onAbort();
      } else {
        callbacks.signal.addEventListener('abort', onAbort, { once: true });
      }
    }

    proc.stdin.end();

    let rawResponse = '';
    let threadId: string | undefined = resumeSessionId;
    let lineBuffer = '';

    proc.stdout.on('data', (chunk: Buffer) => {
      lineBuffer += chunk.toString();
      const lines = lineBuffer.split('\n');
      lineBuffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);

          if (event.type === 'thread.started' && event.thread_id) {
            threadId = event.thread_id;
            trace.push({ timestamp: new Date(), type: 'session_start', text: threadId });
            log(`Codex thread: ${threadId}`);
            if (threadId) callbacks.onSessionId?.(threadId);
          }

          if (event.type === 'item.completed' && event.item?.type === 'agent_message') {
            // Codex CLI uses item.text directly, or item.content[].text
            const text = event.item.text
              ?? event.item.content?.filter((c: any) => c.type === 'output_text').map((c: any) => c.text).join('')
              ?? '';
            if (text) { rawResponse = text; callbacks.onText(rawResponse); }
          }

          // MCP tool calls (Linear, FlowForge, GitHub, etc.)
          if (event.type === 'item.started' && event.item?.type === 'mcp_tool_call') {
            const server = event.item.server ?? '';
            const tool = event.item.tool ?? '';
            const fullName = `mcp__${server}__${tool}`;
            const args = event.item.arguments ?? {};
            log(`🔧 MCP tool call: ${fullName}`, args);
            trace.push({ timestamp: new Date(), type: 'tool_call', tool: fullName, toolUseId: event.item.id, args });
            callbacks.onToolStart(fullName, args, event.item.id ?? '');
          }

          if (event.type === 'item.completed' && event.item?.type === 'mcp_tool_call') {
            const server = event.item.server ?? '';
            const tool = event.item.tool ?? '';
            const fullName = `mcp__${server}__${tool}`;
            let resultData: Record<string, unknown> = {};
            if (event.item.result?.content) {
              const text = event.item.result.content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('');
              try { resultData = JSON.parse(text); } catch { resultData = { raw: text }; }
            }
            if (event.item.error) {
              resultData = { error: event.item.error.message ?? JSON.stringify(event.item.error) };
            }
            const isError = event.item.status === 'failed';
            log(`${isError ? '❌' : '✅'} MCP tool result: ${fullName}`, resultData);
            trace.push({ timestamp: new Date(), type: 'tool_result', tool: fullName, toolUseId: event.item.id, result: resultData, isError });
            callbacks.onToolResult(fullName, resultData, event.item.id ?? '', 0);
          }

          // Function calls (OpenAI-style)
          if (event.type === 'item.completed' && event.item?.type === 'function_call') {
            const tn = event.item.name ?? 'unknown';
            let ta: Record<string, unknown> = {};
            try { ta = JSON.parse(event.item.arguments ?? '{}'); } catch {}
            log(`🔧 Codex tool: ${tn}`, ta);
            trace.push({ timestamp: new Date(), type: 'tool_call', tool: tn, args: ta });
            callbacks.onToolStart(tn, ta, event.item.call_id ?? '');
          }

          if (event.type === 'item.completed' && event.item?.type === 'function_call_output') {
            let rd: Record<string, unknown> = {};
            try { rd = JSON.parse(event.item.output ?? '{}'); } catch { rd = { raw: event.item.output }; }
            trace.push({ timestamp: new Date(), type: 'tool_result', tool: event.item.name ?? '', result: rd });
            callbacks.onToolResult(event.item.name ?? '', rd, event.item.call_id ?? '', 0);
          }

          // Command executions (Bash)
          if (event.type === 'item.completed' && event.item?.type === 'command_execution') {
            const cmd = event.item.command ?? '';
            log(`🔧 Codex command: ${cmd}`);
            trace.push({ timestamp: new Date(), type: 'tool_call', tool: 'Bash', args: { command: cmd } });
            callbacks.onToolStart('Bash', { command: cmd }, event.item.id ?? '');
          }
        } catch { /* skip non-JSON */ }
      }
    });

    let stderrBuffer = '';
    proc.stderr.on('data', (chunk: Buffer) => {
      const msg = chunk.toString().trim();
      stderrBuffer += msg + '\n';
      if (msg && !msg.includes('ERROR codex_core') && !msg.includes('Reading additional')) {
        log(`[codex] ${msg}`);
      }
    });

    // No hard timeout — agents can take as long as they need

    proc.on('close', (code) => {
      trace.push({ timestamp: new Date(), type: 'complete', text: `exit=${code}` });
      // If the process exited non-zero with no response text, something
      // went wrong (e.g. "no rollout found" after a cancelled turn).
      // REJECT so runLLM's catch block can handle it — the "no rollout
      // found" fallback clears the stale session and retries as fresh.
      if (code !== 0 && !rawResponse) {
        const errMsg = stderrBuffer.trim() || `Codex exited with code ${code}`;
        reject(new Error(errMsg));
        return;
      }
      resolve({ text: rawResponse, costUsd: 0, sessionId: threadId, trace });
    });
  });
}

