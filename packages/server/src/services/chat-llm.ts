/**
 * Chat LLM Router
 * Routes to the correct provider. All providers use MCP for tool access:
 * - Allen MCP server: our built-in tools (workflows, executions, agents, etc.)
 * - External MCP servers: Linear, GitHub, etc. (configured in Settings)
 */

import type { Db } from 'mongodb';
import { MCP_SERVER_NAME, normalizeModelAlias, getAllenMcpConfig, normalizeClaudeUsage, type TokenUsageInfo } from '@allen/engine';
import {
  type ChatProvider,
  type ProviderCallbacks,
  PROVIDERS,
  runCodexCLI,
  AGENT_FALLBACK_CWD,
  buildClaudeCompatibleEnvOverlay,
  isClaudeCompatibleProvider,
} from './chat-providers.js';
import { loadExternalMcpServers } from './chat-mcp.js';
import {
  toClaudeSdkOptions,
  type ResolvedSettings,
} from './agent-settings.js';
import { resolveClaudeCodeExecutable } from './claude-code-executable.js';
import { persistentChatRuntimeEnabled, runPersistentChatTurn } from './chat-runtime-manager.js';

// ── Types ──

export type { ChatProvider } from './chat-providers.js';
export { PROVIDERS } from './chat-providers.js';

export interface ChatLLMMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ChatLLMOptions {
  provider?: ChatProvider;
  model?: string;
  /**
   * Fully-resolved spawn settings from resolveAgentSettings(). When present, the
   * provider-specific effort/planMode flags will be emitted on top of the raw
   * provider+model values. Callers that don't pass this get the CLI defaults.
   */
  resolvedSettings?: ResolvedSettings;
  systemPrompt: string;
  messages: ChatLLMMessage[];
  resumeSessionId?: string;
  onText: (text: string) => void;
  onThinking?: (thinking: string) => void;
  onToolStart: (tool: string, args: Record<string, unknown>, toolUseId: string) => void;
  onToolResult: (tool: string, result: Record<string, unknown>, toolUseId: string, durationMs: number) => void;
  onSessionId?: (sessionId: string) => void;
  skipTools?: boolean;
  signal?: AbortSignal;
  cwd?: string;
  /**
   * Chat session id this LLM call is running under. Forwarded to the
   * Allen MCP subprocess as `ALLEN_ARTIFACT_ROOT_TYPE=chat` /
   * `ALLEN_ARTIFACT_ROOT_ID=<sessionId>` so `allen_save_artifact` calls
   * from the chat agent can file artifacts under this chat. Without it,
   * the MCP returns the "ALLEN_ARTIFACT_ROOT_TYPE / ALLEN_ARTIFACT_ROOT_ID
   * env vars not set" error and the save fails.
   */
  chatSessionId?: string;
}

export interface ChatTraceEvent {
  timestamp: Date;
  type: 'session_start' | 'thinking' | 'tool_call' | 'tool_result' | 'error' | 'complete';
  tool?: string;
  toolUseId?: string;
  args?: Record<string, unknown>;
  result?: Record<string, unknown>;
  durationMs?: number;
  isError?: boolean;
  text?: string;
}

export interface ChatLLMResult {
  text: string;
  costUsd: number;
  durationMs: number;
  model: string;
  provider: ChatProvider;
  sessionId?: string;
  trace: ChatTraceEvent[];
  tokenUsage?: TokenUsageInfo | null;
}

// ── Logger ──

const LOG = '\x1b[36m[chat]\x1b[0m';
function log(msg: string): void {
  console.log(`${LOG} ${new Date().toISOString().slice(11, 23)} ${msg}`);
}

// ── Claude CLI Provider (all tools via MCP) ──

async function runClaudeCLI(
  db: Db,
  systemPrompt: string,
  messages: ChatLLMMessage[],
  model: string,
  callbacks: ProviderCallbacks,
  resumeSessionId?: string,
  skipTools?: boolean,
  cwd?: string,
  resolved?: ResolvedSettings,
  chatSessionId?: string,
): Promise<{ text: string; costUsd: number; sessionId?: string; trace: ChatTraceEvent[]; tokenUsage?: TokenUsageInfo | null }> {
  const { query } = await import('@anthropic-ai/claude-code');

  // Build MCP servers: Allen + external
  const mcpServers: Record<string, unknown> = {};
  if (!skipTools) {
    // Allen MCP — chat-scoped. The helper resolves the server file
    // (module-anchored, .ts→.js, with ALLEN_MCP_SERVER_PATH override),
    // picks the right runner, and assembles env. Returns null if the
    // server file can't be found, in which case the chat session falls
    // back to external MCPs only.
    const allenConfig = getAllenMcpConfig({
      ...(chatSessionId
        ? {
            ALLEN_ARTIFACT_ROOT_TYPE: 'chat',
            ALLEN_ARTIFACT_ROOT_ID: chatSessionId,
            // Session-scope marker. The MCP forwards this as an
            // x-allen-chat-session-id header on every outbound
            // /api/chat/* call so the server can route tools to the
            // exact chat context.
            ALLEN_CHAT_SESSION_ID: chatSessionId,
          }
        : {}),
    });
    if (allenConfig) mcpServers[MCP_SERVER_NAME] = allenConfig;

    // External MCP servers (Linear, GitHub, etc.)
    const external = await loadExternalMcpServers(db);
    Object.assign(mcpServers, external);

    const names = Object.keys(mcpServers);
    systemPrompt += `\n\nYou have MCP tools from: ${names.join(', ')}. Use them directly. The "allen" tools provide workflow, execution, repo, agent, and dashboard data.`;
  }

  let lastUserMsg = messages.length > 0 ? messages[messages.length - 1].content : '';
  const trace: ChatTraceEvent[] = [];
  let llmSessionId: string | undefined = resumeSessionId;
  const activeMcpToolCalls = new Map<string, { tool: string; args: Record<string, unknown>; startMs: number }>();

  // Resolve cwd and ensure it exists — child_process.spawn throws ENOENT
  // for a missing cwd but Node formats it as "spawn node ENOENT", which
  // misleadingly blames the executable. See smoke-claude.ts:97-101.
  // Fallback is AGENT_FALLBACK_CWD (/tmp/allen), NOT process.cwd(),
  // so agents never run inside the server's own source tree.
  const resolvedCwd = cwd || AGENT_FALLBACK_CWD;
  const { mkdirSync } = await import('node:fs');
  mkdirSync(resolvedCwd, { recursive: true });

  // Normalize model alias to full ID (haiku → claude-haiku-4-5-20251001 etc.)
  // so we don't rely on the bundled Claude Code CLI's stale alias table.
  const sdkOptions: Record<string, unknown> = {
    model: normalizeModelAlias(model) ?? model,
    permissionMode: 'bypassPermissions',
    cwd: resolvedCwd,
  };
  const claudeCodeExecutable = resolveClaudeCodeExecutable();
  if (claudeCodeExecutable) {
    sdkOptions.pathToClaudeCodeExecutable = claudeCodeExecutable;
  }

  // Apply resolved agent settings (effort / planMode / model) if present.
  // - model / planMode map to native SDK options.
  // - reasoningEffort is injected into the user prompt as a trigger keyword
  //   (think / think hard / ultrathink). The SDK has no native effort flag
  //   and its bundled cli.js doesn't accept --effort — this is the only
  //   mechanism that actually works. See agent-settings.ts for details.
  if (resolved) {
    const fragment = toClaudeSdkOptions(resolved);
    // Re-normalize — fragment.model may carry a raw alias (haiku/sonnet/opus)
    // that would reintroduce the bundled-CLI stale-alias 404.
    if (fragment.model) sdkOptions.model = normalizeModelAlias(fragment.model) ?? fragment.model;
    if (fragment.permissionMode === 'plan') sdkOptions.permissionMode = 'plan';
    if (fragment.promptPrefix) {
      lastUserMsg = `${fragment.promptPrefix}\n\n${lastUserMsg}`;
    }
  }

  if (resumeSessionId) sdkOptions.resume = resumeSessionId;
  else sdkOptions.customSystemPrompt = systemPrompt;
  if (Object.keys(mcpServers).length > 0) sdkOptions.mcpServers = mcpServers;
  // Wire the abort signal so clicking "Stop" in chat kills the claude-cli
  // subprocess (SIGTERM) instead of just closing the SSE connection.
  if (callbacks.signal) {
    sdkOptions.abortController = { signal: callbacks.signal, abort() { /* handled by chat.service */ } };
  }

  let fullText = '';
  let costUsd = 0;
  let tokenUsage: TokenUsageInfo | null = null;
  const conversation = query({ prompt: lastUserMsg, options: sdkOptions as any });

  for await (const message of conversation) {
    if ('session_id' in message && message.session_id && !llmSessionId) {
      llmSessionId = message.session_id as string;
      trace.push({ timestamp: new Date(), type: 'session_start', text: llmSessionId });
      callbacks.onSessionId?.(llmSessionId);
    }

    if (message.type === 'assistant') {
      const blocks = message.message.content as Array<{ type: string; text?: string; thinking?: string; name?: string; input?: unknown; id?: string }>;
      const text = blocks.filter(b => b.type === 'text').map(b => b.text || '').join('');
      if (text && text !== fullText) { fullText = text; callbacks.onText(fullText); }

      if (callbacks.onThinking) {
        const thinking = blocks.filter(b => b.type === 'thinking').map(b => b.thinking || b.text || '').join('');
        if (thinking) { trace.push({ timestamp: new Date(), type: 'thinking', text: thinking }); callbacks.onThinking(thinking); }
      }

      for (const block of blocks) {
        if (block.type === 'tool_use' && block.name && block.id) {
          const args = (block.input as Record<string, unknown>) ?? {};
          activeMcpToolCalls.set(block.id, { tool: block.name, args, startMs: Date.now() });
          trace.push({ timestamp: new Date(), type: 'tool_call', tool: block.name, toolUseId: block.id, args });
          callbacks.onToolStart(block.name, args, block.id);
        }
      }
    }

    if (message.type === 'user') {
      const content = (message as any).message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'tool_result' && block.tool_use_id) {
            const pending = activeMcpToolCalls.get(block.tool_use_id);
            if (pending) {
              const durationMs = Date.now() - pending.startMs;
              let resultData: Record<string, unknown> = {};
              try {
                const rc = Array.isArray(block.content) ? block.content.map((c: any) => c.text || '').join('') : typeof block.content === 'string' ? block.content : JSON.stringify(block.content);
                resultData = JSON.parse(rc);
              } catch { resultData = { raw: String(block.content) }; }
              trace.push({ timestamp: new Date(), type: 'tool_result', tool: pending.tool, toolUseId: block.tool_use_id, result: resultData, durationMs });
              callbacks.onToolResult(pending.tool, resultData, block.tool_use_id, durationMs);
              activeMcpToolCalls.delete(block.tool_use_id);
            }
          }
        }
      }
    }

    if (message.type === 'result') {
      costUsd = (message as any).total_cost_usd ?? 0;
      tokenUsage = normalizeClaudeUsage((message as any).usage ?? null);
      if ((message as any).subtype === 'success' && (message as any).result) {
        const rt = (message as any).result;
        if (rt !== fullText) { fullText = rt; callbacks.onText(fullText); }
      }
      if ((message as any).session_id) llmSessionId = (message as any).session_id;
    }
  }

  return { text: fullText, costUsd, sessionId: llmSessionId, trace, tokenUsage };
}

async function runClaudeCompatibleChatCLI(
  provider: ChatProvider,
  db: Db,
  systemPrompt: string,
  messages: ChatLLMMessage[],
  model: string,
  callbacks: ProviderCallbacks,
  resumeSessionId?: string,
  skipTools?: boolean,
  cwd?: string,
  resolved?: ResolvedSettings,
  chatSessionId?: string,
): Promise<{ text: string; costUsd: number; sessionId?: string; trace: ChatTraceEvent[]; tokenUsage?: TokenUsageInfo | null }> {
  const overlay = await buildClaudeCompatibleEnvOverlay(provider, model);
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(overlay)) {
    saved[key] = process.env[key];
    process.env[key] = overlay[key];
  }
  try {
    return await runClaudeCLI(db, systemPrompt, messages, model, callbacks, resumeSessionId, skipTools, cwd, resolved, chatSessionId);
  } finally {
    for (const key of Object.keys(overlay)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

// ── Main Router ──

export async function runChatLLM(db: Db, options: ChatLLMOptions): Promise<ChatLLMResult> {
  const provider = options.provider ?? 'codex';
  const providerConfig = PROVIDERS.find(p => p.provider === provider) ?? PROVIDERS[0];
  const model = options.model ?? providerConfig.defaultModel;

  log(`━━━ New message [${provider}/${model}] ━━━`);
  const prompt = options.messages.length > 0 ? options.messages[options.messages.length - 1].content : '';
  log(`Prompt: "${prompt.slice(0, 100)}${prompt.length > 100 ? '...' : ''}"`);
  const usePersistentRuntime = persistentChatRuntimeEnabled()
    && options.chatSessionId
    && (provider === 'codex' || provider === 'claude-cli' || isClaudeCompatibleProvider(provider));
  if (options.resumeSessionId) {
    log(usePersistentRuntime
      ? `Provider session: ${options.resumeSessionId.slice(0, 8)}...`
      : `Resume: ${options.resumeSessionId.slice(0, 8)}...`);
  }

  const startMs = Date.now();

  const callbacks: ProviderCallbacks = {
    onText: options.onText,
    onThinking: options.onThinking,
    onToolStart: options.onToolStart,
    onToolResult: options.onToolResult,
    onSessionId: options.onSessionId,
    signal: options.signal,
  };

  let result: { text: string; costUsd: number; sessionId?: string; trace: ChatTraceEvent[]; tokenUsage?: TokenUsageInfo | null };

  const resolved = options.resolvedSettings;
  if (resolved) {
    log(`Effort=${resolved.reasoningEffort ?? '(default)'} planMode=${resolved.planMode}`);
  }

  if (
    usePersistentRuntime
  ) {
    result = await runPersistentChatTurn({
      db,
      chatSessionId: options.chatSessionId,
      provider,
      model,
      resolvedSettings: resolved,
      systemPrompt: options.systemPrompt,
      messages: options.messages,
      resumeSessionId: options.resumeSessionId,
      skipTools: options.skipTools,
      cwd: options.cwd,
      callbacks,
    });
  } else {
    switch (provider) {
      case 'codex':
        result = await runCodexCLI(db, options.systemPrompt, options.messages, model, callbacks, options.resumeSessionId, options.skipTools, options.cwd, resolved, options.chatSessionId);
        break;
      case 'claude-cli':
        result = await runClaudeCLI(db, options.systemPrompt, options.messages, model, callbacks, options.resumeSessionId, options.skipTools, options.cwd, resolved, options.chatSessionId);
        break;
      default:
        if (!isClaudeCompatibleProvider(provider)) throw new Error(`Unknown provider: ${provider}`);
        result = await runClaudeCompatibleChatCLI(provider, db, options.systemPrompt, options.messages, model, callbacks, options.resumeSessionId, options.skipTools, options.cwd, resolved, options.chatSessionId);
        break;
    }
  }

  const durationMs = Date.now() - startMs;
  log(`━━━ Complete [${provider}] | $${result.costUsd.toFixed(4)} | ${durationMs}ms | ${result.text.length} chars ━━━`);

  return { ...result, durationMs, model, provider };
}
