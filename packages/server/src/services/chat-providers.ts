/**
 * Chat LLM Providers
 * Allen runs LLMs exclusively through CLI tools — no API-key-based providers.
 * Two providers: `codex` (OpenAI Codex CLI) and `claude-cli` (Anthropic Claude Code CLI).
 * Both authenticate via their CLI's local auth, both support MCP for tool access.
 */

import type { Db } from 'mongodb';
import type { ChatTraceEvent } from './chat-llm.js';
import { resolve, dirname } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import { aggregateTokenUsage, normalizeCodexUsage, type BuildMcpConfigOptions, type TokenUsageInfo } from '@allen/engine';
import {
  getRuntimeApiBaseUrl,
  getRuntimeConfigProvider,
  getRuntimeJwtAccessSecret,
  getRuntimePublicBaseUrl,
  getRuntimeSecretsProvider,
} from '../runtime/config.js';
import { buildMcpSourceEnvForServer } from '../runtime/mcp-credentials.js';

// `@allen/engine` is imported lazily inside the two functions that need
// MCP_SERVER_NAME. A static import here would fail at module-load time on
// fresh installs where `packages/engine/dist/` doesn't exist yet, which
// breaks the health check that setup.sh runs before `npm run build`.
let _mcpServerName: string | undefined;
async function getMcpServerName(): Promise<string> {
  if (_mcpServerName !== undefined) return _mcpServerName;
  const mod = await import('@allen/engine');
  _mcpServerName = mod.MCP_SERVER_NAME;
  return _mcpServerName;
}

/** Fallback cwd for chat/agent spawns when no workspace/repo is in scope.
 * Intentionally NOT `process.cwd()` — we don't want agents running inside
 * the server's own source tree by accident. Auto-created on use. */
export const AGENT_FALLBACK_CWD = '/tmp/allen';
import { fileURLToPath } from 'node:url';

// ── Shared Types ──

export type ChatProvider = 'codex' | 'claude-cli' | 'deepseek' | 'xiaomi-mimo';

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
  tokenUsage?: TokenUsageInfo | null;
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
  /** Whether this provider uses an open (user-supplied) model string. */
  open?: boolean;
  /** Suggested model strings for open providers. */
  modelSuggestions?: string[];
}

export interface ClaudeCompatibleProviderConfig {
  provider: Extract<ChatProvider, 'deepseek' | 'xiaomi-mimo'>;
  label: string;
  apiKeyEnv: string;
  baseUrlEnv: string;
  modelEnv: string;
  flashModelEnv: string;
  defaultBaseUrl: string;
  defaultModel: string;
  defaultFlashModel: string;
  modelSuggestions: string[];
  apiKeyPlaceholder: string;
  baseUrlDescription: string;
}

export const CLAUDE_COMPATIBLE_PROVIDER_CONFIGS: ClaudeCompatibleProviderConfig[] = [
  {
    provider: 'deepseek',
    label: 'DeepSeek',
    apiKeyEnv: 'ALLEN_DEEPSEEK_API_KEY',
    baseUrlEnv: 'ALLEN_DEEPSEEK_BASE_URL',
    modelEnv: 'ALLEN_DEEPSEEK_MODEL',
    flashModelEnv: 'ALLEN_DEEPSEEK_FLASH_MODEL',
    defaultBaseUrl: 'https://api.deepseek.com/anthropic',
    defaultModel: 'deepseek-v4-pro[1m]',
    defaultFlashModel: 'deepseek-v4-flash',
    modelSuggestions: ['deepseek-v4-pro[1m]', 'deepseek-v4-flash'],
    apiKeyPlaceholder: 'sk-...',
    baseUrlDescription: 'Leave blank to use the default DeepSeek Claude Code endpoint (https://api.deepseek.com/anthropic).',
  },
  {
    provider: 'xiaomi-mimo',
    label: 'Xiaomi MiMo',
    apiKeyEnv: 'ALLEN_XIAOMI_MIMO_API_KEY',
    baseUrlEnv: 'ALLEN_XIAOMI_MIMO_BASE_URL',
    modelEnv: 'ALLEN_XIAOMI_MIMO_MODEL',
    flashModelEnv: 'ALLEN_XIAOMI_MIMO_FLASH_MODEL',
    defaultBaseUrl: 'https://api.xiaomimimo.com/anthropic',
    defaultModel: 'mimo-v2.5-pro',
    defaultFlashModel: 'mimo-v2.5-pro',
    modelSuggestions: ['mimo-v2.5-pro'],
    apiKeyPlaceholder: 'xm-...',
    baseUrlDescription: 'Leave blank to use the default MiMo Anthropic-compatible endpoint (https://api.xiaomimimo.com/anthropic). Token Plan users can enter their subscription base URL.',
  },
];

const CLAUDE_COMPATIBLE_PROVIDER_BY_ID = new Map(
  CLAUDE_COMPATIBLE_PROVIDER_CONFIGS.map((config) => [config.provider, config] as const),
);

export function isClaudeCompatibleProvider(provider: unknown): provider is ClaudeCompatibleProviderConfig['provider'] {
  return CLAUDE_COMPATIBLE_PROVIDER_BY_ID.has(provider as ClaudeCompatibleProviderConfig['provider']);
}

export function getClaudeCompatibleProviderConfig(provider: unknown): ClaudeCompatibleProviderConfig | undefined {
  return CLAUDE_COMPATIBLE_PROVIDER_BY_ID.get(provider as ClaudeCompatibleProviderConfig['provider']);
}

// ── Provider Registry ──

export const PROVIDERS: ProviderConfig[] = [
  {
    provider: 'codex',
    label: 'Codex (CLI)',
    models: ['gpt-5.5', 'gpt-5.4', 'o3', 'o4-mini', 'codex-mini'],
    defaultModel: 'gpt-5.5',
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
  ...CLAUDE_COMPATIBLE_PROVIDER_CONFIGS.map((config): ProviderConfig => ({
    provider: config.provider,
    label: config.label,
    models: [],
    modelSuggestions: config.modelSuggestions,
    open: true,
    defaultModel: config.defaultModel,
    requiresKey: config.apiKeyEnv,
    supportsMcp: true,
    supportsStreaming: true,
    supportsSessionResume: true,
  })),
];

/**
 * Resolve the default chat provider. Reads `ALLEN_DEFAULT_CHAT_PROVIDER` from
 * `.env` and validates it against the registered providers; falls back to
 * `'codex'` when unset or unrecognized.
 */
export function getDefaultChatProvider(): ChatProvider {
  const raw = process.env.ALLEN_DEFAULT_CHAT_PROVIDER?.trim();
  if (raw && PROVIDERS.some((p) => p.provider === raw)) {
    return raw as ChatProvider;
  }
  return 'codex';
}

/**
 * Return the registered providers with the env-configured default first, so
 * UI consumers that pick the head of the list naturally honor the setting.
 */
export function getProvidersInDefaultOrder(): ProviderConfig[] {
  const def = getDefaultChatProvider();
  return [...PROVIDERS].sort((a, b) => {
    if (a.provider === def && b.provider !== def) return -1;
    if (b.provider === def && a.provider !== def) return 1;
    return 0;
  });
}

async function isProviderEnabled(provider: ProviderConfig): Promise<boolean> {
  if (!provider.requiresKey) return true;
  const configValue = getRuntimeConfigProvider().get(provider.requiresKey);
  if (configValue) return true;
  const secretValue = await getRuntimeSecretsProvider().getSecret(provider.requiresKey).catch(() => undefined);
  return Boolean(secretValue);
}

/**
 * Return only providers that are enabled in runtime settings. CLI-backed
 * providers are always available; API providers are enabled by having their
 * configured secret/config key present.
 */
export async function getEnabledProvidersInDefaultOrder(): Promise<ProviderConfig[]> {
  const ordered = getProvidersInDefaultOrder();
  const enabled = await Promise.all(ordered.map(async (provider) => ({
    provider,
    enabled: await isProviderEnabled(provider),
  })));
  return enabled.filter((item) => item.enabled).map((item) => item.provider);
}

/**
 * Provider + model to use for chat-session title generation.
 * Reuses the same provider as chat (ALLEN_DEFAULT_CHAT_PROVIDER) with that
 * provider's default model — fast/cheap is preferred over capable for a
 * 10-word title.
 *
 * On claude-only installs this means title gen runs through claude-cli
 * instead of failing to spawn codex; on codex installs it matches the
 * previous hard-coded `codex` / `gpt-5.5` exactly.
 */
export function getTitleGenProviderModel(): { provider: ChatProvider; model: string } {
  const provider = getDefaultChatProvider();
  const cfg = PROVIDERS.find((p) => p.provider === provider);
  return { provider, model: cfg?.defaultModel ?? 'gpt-5.5' };
}

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

/** Path to the Allen MCP server script.
 * Uses import.meta.url to resolve relative to THIS file — works regardless of
 * process.cwd(). App is deployed under ~/allen/ so snap-installed codex
 * can access it (snap has home dir access). */
function getAllenMcpServerPath(): string {
  const thisDir = dirname(fileURLToPath(import.meta.url));
  // In dev (tsx): thisDir = .../src/services, script is in the same dir
  const tsPath = resolve(thisDir, 'allen-mcp-server.ts');
  if (existsSync(tsPath)) return tsPath;
  // In prod (compiled): thisDir = .../dist/services, script is in the same dir
  return resolve(thisDir, 'allen-mcp-server.js');
}

function getAllenMcpServerRunner(serverPath: string): { command: string; args: string[]; env: Record<string, string> } {
  if (serverPath.endsWith('.ts')) {
    return { command: 'npx', args: ['tsx', serverPath], env: {} };
  }
  if (serverPath.includes('.asar/')) {
    return {
      command: process.execPath,
      args: [serverPath],
      env: { ELECTRON_RUN_AS_NODE: '1' },
    };
  }
  return { command: 'node', args: [serverPath], env: {} };
}

export async function syncMcpToCodex(db: Db): Promise<void> {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execFileAsync = promisify(execFile);

  // Skip entirely if codex isn't on PATH (claude-only install). Otherwise
  // every boot logs "Failed to register Allen MCP with Codex: spawn codex
  // ENOENT" for the Allen MCP, each external server, etc.
  try {
    await execFileAsync('codex', ['--version'], { timeout: 2000 });
  } catch {
    log('codex CLI not available — skipping Codex MCP sync (claude-only install)');
    return;
  }

  const { McpService } = await import('./mcp.service.js');
  const service = new McpService(db);
  const servers = (await service.list()).filter(s => s.enabled && s.type === 'stdio');

  // Get current codex MCP servers
  let existingOutput = '';
  try {
    const { stdout } = await execFileAsync('codex', ['mcp', 'list'], { timeout: 5000 });
    existingOutput = stdout;
  } catch { /* no servers yet */ }

  // Always remove + re-add the Allen MCP entry so env changes (port,
  // JWT_ACCESS_SECRET rotations, etc.) propagate to Codex on every sync.
  // Older registrations won't have JWT_ACCESS_SECRET and would silently
  // 401 on every tool call — this is how we heal that drift.
  const mcpServerName = await getMcpServerName();
  try {
    if (existingOutput.includes(mcpServerName)) {
      await execFileAsync('codex', ['mcp', 'remove', mcpServerName], { timeout: 10000 }).catch(() => {});
    }
    const serverPath = getAllenMcpServerPath();
    const runner = getAllenMcpServerRunner(serverPath);
    const apiBaseUrl = getRuntimeApiBaseUrl();
    const publicBaseUrl = getRuntimePublicBaseUrl();
    const args = [
      'mcp', 'add', mcpServerName,
      '--env', `ALLEN_API_URL=${apiBaseUrl}`,
      // Shared with the MCP subprocess so it can mint its own access token
      // when calling back into /api/* — see allen-mcp-server.ts.
      '--env', `JWT_ACCESS_SECRET=${getRuntimeJwtAccessSecret()}`,
      '--env', `ALLEN_PUBLIC_URL=${publicBaseUrl}`,
    ];
    for (const [key, value] of Object.entries(runner.env)) {
      args.push('--env', `${key}=${value}`);
    }
    args.push('--', runner.command, ...runner.args);
    await execFileAsync('codex', args, { timeout: 10000 });
    log('Registered Allen MCP server with Codex CLI');
  } catch (err) {
    log(`Failed to register Allen MCP with Codex: ${(err as Error).message}`);
  }

  // Register external MCP servers using the shared spawn-config resolver so
  // preset, repo-sourced, and legacy bundle records all translate to Codex's
  // `codex mcp add` with the right command/args/env. Always remove + re-add
  // so config drift gets corrected on each sync.
  const { buildSingleServerConfig } = await import('@allen/engine');
  for (const server of servers) {
    try {
      if (server.type !== 'stdio') {
        log(`Skipped ${server.name}: Codex CLI sync currently supports stdio MCP servers only`);
        continue;
      }
      const options = { sourceEnv: await buildMcpSourceEnvForServer(server) } satisfies BuildMcpConfigOptions;
      const cfg = await buildSingleServerConfig(server as unknown as Record<string, unknown>, db, options);
      if (!cfg) {
        log(`Skipped ${server.name}: spawn config could not be resolved`);
        continue;
      }
      const resolvedCmd = (cfg.command as string) ?? server.command ?? '';
      const resolvedArgs = (cfg.args as string[]) ?? [];
      const resolvedEnv = (cfg.env as Record<string, string>) ?? {};
      // Remove first (may fail if not registered — that's fine)
      if (existingOutput.includes(server.name)) {
        await execFileAsync('codex', ['mcp', 'remove', server.name], { timeout: 5000 }).catch(() => {});
      }
      const cmdArgs = ['mcp', 'add', server.name];
      for (const [k, v] of Object.entries(resolvedEnv)) cmdArgs.push('--env', `${k}=${v}`);
      cmdArgs.push('--', resolvedCmd, ...resolvedArgs);
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
  chatSessionId?: string,
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

  // Per-call MCP env overrides for the Allen MCP. Codex stores the MCP
  // entry from `codex mcp add ...` with only the env vars passed at
  // registration time (ALLEN_API_URL, JWT_ACCESS_SECRET) — codex does
  // NOT forward its own runtime env to MCP children, despite the
  // earlier comment claiming otherwise. Without per-call overrides,
  // `allen_save_artifact` returns "ALLEN_ARTIFACT_ROOT_TYPE / ROOT_ID
  // env vars not set". Codex accepts dotted-key TOML overrides via -c,
  // including for MCP env values, so we inject the chat-scope vars here
  // on every codex exec.
  const disabledMcpArgs = skipTools ? ['-c', 'mcp_servers={}'] : [];
  const mcpEnvOverrides: string[] = [];
  if (chatSessionId && !skipTools) {
    const mcpServerName = await getMcpServerName();
    const apiBaseUrl = getRuntimeApiBaseUrl();
    const publicBaseUrl = getRuntimePublicBaseUrl();
    mcpEnvOverrides.push(
      '-c', `mcp_servers.${mcpServerName}.env.ALLEN_ARTIFACT_ROOT_TYPE="chat"`,
      '-c', `mcp_servers.${mcpServerName}.env.ALLEN_ARTIFACT_ROOT_ID="${chatSessionId}"`,
      '-c', `mcp_servers.${mcpServerName}.env.ALLEN_CHAT_SESSION_ID="${chatSessionId}"`,
      // Carry the existing required vars too — the override is a full
      // dict replacement in some codex versions, so re-state them to be
      // safe across CLI variants.
      '-c', `mcp_servers.${mcpServerName}.env.ALLEN_API_URL="${apiBaseUrl}"`,
      '-c', `mcp_servers.${mcpServerName}.env.JWT_ACCESS_SECRET="${getRuntimeJwtAccessSecret()}"`,
      '-c', `mcp_servers.${mcpServerName}.env.ALLEN_PUBLIC_URL="${publicBaseUrl}"`,
    );
  }

  const args: string[] = ['exec'];
  if (resumeSessionId) {
    args.push('resume', '--json', '--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check');
    // Apply resume-safe overrides (effort only) BEFORE the session id + prompt.
    if (resumeSafeArgs.length > 0) args.push(...resumeSafeArgs);
    if (disabledMcpArgs.length > 0) args.push(...disabledMcpArgs);
    if (mcpEnvOverrides.length > 0) args.push(...mcpEnvOverrides);
    args.push('--', resumeSessionId, prompt);
  } else {
    args.push('--json', '--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check');
    if (resolvedArgs.length > 0) {
      args.push(...resolvedArgs);
    } else if (model && model !== 'default') {
      args.push('-c', `model="${model}"`);
    }
    if (disabledMcpArgs.length > 0) args.push(...disabledMcpArgs);
    if (mcpEnvOverrides.length > 0) args.push(...mcpEnvOverrides);
    args.push(prompt);
  }

  // Note: MCP sync runs once on server boot, not per chat call.
  // Avoids races between parallel chats rewriting Codex's global config.

  log(`Spawning codex: ${args.slice(0, 4).join(' ')}...`);

  return new Promise<ProviderResult & { sessionId?: string }>((resolve, reject) => {
    const fallbackCwd = cwd || AGENT_FALLBACK_CWD;
    mkdirSync(fallbackCwd, { recursive: true });
    const proc = spawn('codex', args, {
      cwd: fallbackCwd,
      // Codex registers the Allen MCP server globally via `codex mcp add`,
      // which means we can't pass per-session env via the MCP config.
      // Instead we add it to codex's own process env — the MCP child
      // inherits it because Node's child_process spawn passes the
      // parent's env down by default (codex doesn't strip it). Same
      // mechanism as ALLEN_API_URL / JWT_ACCESS_SECRET work today.
      env: {
        ...process.env,
        ...(chatSessionId
          ? {
              ALLEN_ARTIFACT_ROOT_TYPE: 'chat',
              ALLEN_ARTIFACT_ROOT_ID: chatSessionId,
              // Session marker — Allen MCP forwards this as
              // x-allen-chat-session-id on outbound /api/chat/* calls so
              // the server-side tool dispatcher can resolve the right
              // chat context.
              ALLEN_CHAT_SESSION_ID: chatSessionId,
            }
          : {}),
      },
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
    let tokenUsage: TokenUsageInfo | null = null;

    // Codex emits `item.started` and `item.completed` separately for
    // MCP tools and shell commands. Pair them by item.id so duration
    // can be computed properly. Function calls (OpenAI-style) have only
    // a `completed` event — we stash them by call_id for pairing with
    // the matching `function_call_output` event.
    type PendingStart = { tool: string; args: Record<string, unknown>; startMs: number };
    const pendingStarts = new Map<string, PendingStart>();

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

          // ── MCP tool calls (Linear, Allen, GitHub, etc.) ─────────────
          if (event.type === 'item.started' && event.item?.type === 'mcp_tool_call') {
            const server = event.item.server ?? '';
            const tool = event.item.tool ?? '';
            const fullName = `mcp__${server}__${tool}`;
            const args = (event.item.arguments && typeof event.item.arguments === 'object') ? event.item.arguments : {};
            const id = event.item.id ?? '';
            pendingStarts.set(id, { tool: fullName, args, startMs: Date.now() });
            log(`🔧 MCP tool call: ${fullName}`, args);
            trace.push({ timestamp: new Date(), type: 'tool_call', tool: fullName, toolUseId: id, args });
            callbacks.onToolStart(fullName, args, id);
          }

          if (event.type === 'item.completed' && event.item?.type === 'mcp_tool_call') {
            const server = event.item.server ?? '';
            const tool = event.item.tool ?? '';
            const fullName = `mcp__${server}__${tool}`;
            const id = event.item.id ?? '';
            const started = pendingStarts.get(id);
            const durationMs = started ? Date.now() - started.startMs : 0;
            let resultData: Record<string, unknown> = {};
            if (event.item.result?.content) {
              const text = event.item.result.content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('');
              try { resultData = JSON.parse(text); } catch { resultData = { raw: text }; }
            }
            if (event.item.error) {
              resultData = { error: event.item.error.message ?? JSON.stringify(event.item.error) };
            }
            const isError = event.item.status === 'failed' || event.item.error !== undefined;
            log(`${isError ? '❌' : '✅'} MCP tool result: ${fullName}`, resultData);
            trace.push({ timestamp: new Date(), type: 'tool_result', tool: fullName, toolUseId: id, result: resultData, isError, durationMs });
            callbacks.onToolResult(fullName, resultData, id, durationMs);
            pendingStarts.delete(id);
          }

          // ── Function calls (OpenAI-style) ────────────────────────────
          // Codex emits function_call (with args) and function_call_output
          // (with result) as two separate `item.completed` events, paired
          // by call_id. Capture both sides so we don't silently drop the
          // tool's return value.
          if (event.type === 'item.completed' && event.item?.type === 'function_call') {
            const tn = event.item.name ?? 'unknown';
            const callId = event.item.call_id ?? event.item.id ?? '';
            let ta: Record<string, unknown> = {};
            try { ta = JSON.parse(event.item.arguments ?? '{}'); } catch {}
            pendingStarts.set(callId, { tool: tn, args: ta, startMs: Date.now() });
            log(`🔧 Codex tool: ${tn}`, ta);
            trace.push({ timestamp: new Date(), type: 'tool_call', tool: tn, toolUseId: callId, args: ta });
            callbacks.onToolStart(tn, ta, callId);
          }

          if (event.type === 'item.completed' && event.item?.type === 'function_call_output') {
            const callId = event.item.call_id ?? event.item.id ?? '';
            const started = pendingStarts.get(callId);
            const durationMs = started ? Date.now() - started.startMs : 0;
            const tn = started?.tool ?? event.item.name ?? '';
            let rd: Record<string, unknown> = {};
            try { rd = JSON.parse(event.item.output ?? '{}'); }
            catch { rd = { raw: String(event.item.output ?? '') }; }
            const isError = event.item.status === 'failed' || event.item.error !== undefined;
            trace.push({ timestamp: new Date(), type: 'tool_result', tool: tn, toolUseId: callId, result: rd, isError, durationMs });
            callbacks.onToolResult(tn, rd, callId, durationMs);
            pendingStarts.delete(callId);
          }

          // ── Command executions (Bash) — pair started/completed ─────
          if (event.type === 'item.started' && event.item?.type === 'command_execution') {
            const cmd = event.item.command ?? '';
            const id = event.item.id ?? '';
            pendingStarts.set(id, { tool: 'Bash', args: { command: cmd }, startMs: Date.now() });
            log(`🔧 Codex command: ${cmd}`);
            trace.push({ timestamp: new Date(), type: 'tool_call', tool: 'Bash', toolUseId: id, args: { command: cmd } });
            callbacks.onToolStart('Bash', { command: cmd }, id);
          }

          if (event.type === 'item.completed' && event.item?.type === 'command_execution') {
            const id = event.item.id ?? '';
            const started = pendingStarts.get(id);
            const durationMs = started ? Date.now() - started.startMs : 0;
            const cmd = event.item.command ?? started?.args.command ?? '';
            const output = event.item.aggregated_output ?? '';
            const isError = event.item.status !== 'completed';
            const result: Record<string, unknown> = { output: String(output).slice(0, 10_000) };
            if (event.item.exit_code !== undefined) result.exit_code = event.item.exit_code;
            trace.push({ timestamp: new Date(), type: 'tool_result', tool: 'Bash', toolUseId: id, result, isError, durationMs });
            callbacks.onToolResult('Bash', result, id, durationMs);
            pendingStarts.delete(id);
          }

          if (event.type === 'turn.completed' && event.usage) {
            tokenUsage = aggregateTokenUsage(tokenUsage, normalizeCodexUsage(event.usage));
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
      resolve({ text: rawResponse, costUsd: 0, sessionId: threadId, trace, tokenUsage });
    });
  });
}

// ════════════════════════════════════════════════════════════════════════════
// Claude-compatible API providers (via Claude Code env overlay)
// ════════════════════════════════════════════════════════════════════════════

const DEEPSEEK_ANTHROPIC_BASE_URL = 'https://api.deepseek.com/anthropic';

export function normalizeDeepSeekAnthropicBaseUrl(value?: string): string {
  const trimmed = value?.trim();
  if (!trimmed) return DEEPSEEK_ANTHROPIC_BASE_URL;
  const normalized = trimmed.replace(/\/+$/, '');
  if (normalized === 'https://api.deepseek.com' || normalized === 'https://api.deepseek.com/v1') {
    return DEEPSEEK_ANTHROPIC_BASE_URL;
  }
  return trimmed;
}

/**
 * Build a process-env overlay that redirects Claude Code SDK / CLI requests to
 * a registered Anthropic-compatible API provider. Adding a new provider should
 * only require a CLAUDE_COMPATIBLE_PROVIDER_CONFIGS entry and UI copy.
 */
export async function buildClaudeCompatibleEnvOverlay(provider: ChatProvider, model?: string): Promise<Record<string, string>> {
  const config = getClaudeCompatibleProviderConfig(provider);
  if (!config) throw new Error(`Provider ${provider} is not a Claude-compatible API provider.`);
  const runtimeConfig = getRuntimeConfigProvider();
  const runtimeSecrets = getRuntimeSecretsProvider();
  const apiKey = await runtimeSecrets.getSecret(config.apiKeyEnv)
    ?? runtimeConfig.get(config.apiKeyEnv)
    ?? process.env[config.apiKeyEnv]
    ?? '';
  const configuredBaseUrl = runtimeConfig.get(config.baseUrlEnv) ?? process.env[config.baseUrlEnv] ?? config.defaultBaseUrl;
  const baseUrl = provider === 'deepseek'
    ? normalizeDeepSeekAnthropicBaseUrl(configuredBaseUrl)
    : configuredBaseUrl;
  const defaultModel = runtimeConfig.get(config.modelEnv) ?? process.env[config.modelEnv] ?? config.defaultModel;
  const flashModel = runtimeConfig.get(config.flashModelEnv) ?? process.env[config.flashModelEnv] ?? config.defaultFlashModel;
  const effectiveModel = model && model !== 'default' ? model : defaultModel;
  if (!apiKey) throw new Error(`${config.apiKeyEnv} is not set. Configure this secret in Allen Settings > Secrets.`);
  return {
    ANTHROPIC_BASE_URL: baseUrl,
    ANTHROPIC_AUTH_TOKEN: apiKey,
    ANTHROPIC_MODEL: effectiveModel,
    ANTHROPIC_DEFAULT_OPUS_MODEL: effectiveModel,
    ANTHROPIC_DEFAULT_SONNET_MODEL: effectiveModel,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: flashModel,
    CLAUDE_CODE_SUBAGENT_MODEL: flashModel,
    CLAUDE_CODE_EFFORT_LEVEL: 'max',
  };
}

export function buildDeepSeekEnvOverlay(model?: string): Promise<Record<string, string>> {
  return buildClaudeCompatibleEnvOverlay('deepseek', model);
}

export function buildXiaomiMimoEnvOverlay(model?: string): Promise<Record<string, string>> {
  return buildClaudeCompatibleEnvOverlay('xiaomi-mimo', model);
}
