/**
 * Chat LLM Router
 * Routes to the correct provider. All providers use MCP for tool access:
 * - FlowForge MCP server: our built-in tools (workflows, executions, agents, etc.)
 * - External MCP servers: Linear, GitHub, etc. (configured in Settings)
 */

import type { Db } from 'mongodb';
import {
  type ChatProvider,
  type ProviderCallbacks,
  PROVIDERS,
  runCodexCLI,
} from './chat-providers.js';
import { loadExternalMcpServers } from './chat-mcp.js';
import {
  toClaudeSdkOptions,
  type ResolvedSettings,
} from './agent-settings.js';

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
): Promise<{ text: string; costUsd: number; sessionId?: string; trace: ChatTraceEvent[] }> {
  const { query } = await import('@anthropic-ai/claude-code');
  const { resolve, dirname } = await import('node:path');

  // Build MCP servers: FlowForge + external
  const mcpServers: Record<string, unknown> = {};
  if (!skipTools) {
    // FlowForge MCP server (our built-in tools)
    // Resolve relative to THIS file — works in both dev (src/) and prod (dist/)
    const thisDir = dirname(new URL(import.meta.url).pathname);
    const tsPath = resolve(thisDir, 'flowforge-mcp-server.ts');
    const jsPath = resolve(thisDir, 'flowforge-mcp-server.js');
    const { existsSync } = await import('node:fs');
    // Dev: .ts file → run with npx tsx. Prod: .js file → run with node.
    const serverPath = existsSync(tsPath) ? tsPath : jsPath;
    const runner = serverPath.endsWith('.ts') ? { command: 'npx', args: ['tsx', serverPath] } : { command: 'node', args: [serverPath] };
    mcpServers.flowforge = {
      type: 'stdio',
      command: runner.command,
      args: runner.args,
      env: {
        FLOWFORGE_API_URL: `http://localhost:${process.env.PORT ?? '4023'}`,
        // Shared with the MCP subprocess so it can mint its own access token
        // when calling back into /api/* — see flowforge-mcp-server.ts.
        JWT_ACCESS_SECRET: process.env.JWT_ACCESS_SECRET ?? '',
      },
    };

    // External MCP servers (Linear, GitHub, etc.)
    const external = await loadExternalMcpServers(db);
    Object.assign(mcpServers, external);

    const names = Object.keys(mcpServers);
    systemPrompt += `\n\nYou have MCP tools from: ${names.join(', ')}. Use them directly. The "flowforge" tools provide workflow, execution, repo, agent, and dashboard data.`;
  }

  let lastUserMsg = messages.length > 0 ? messages[messages.length - 1].content : '';
  const trace: ChatTraceEvent[] = [];
  let llmSessionId: string | undefined = resumeSessionId;
  const activeMcpToolCalls = new Map<string, { tool: string; args: Record<string, unknown>; startMs: number }>();

  const sdkOptions: Record<string, unknown> = {
    model,
    maxTurns: 30,
    permissionMode: 'bypassPermissions',
    cwd: cwd || '/tmp/flowforge',
  };

  // Apply resolved agent settings (effort / planMode / model) if present.
  // - model / planMode map to native SDK options.
  // - reasoningEffort is injected into the user prompt as a trigger keyword
  //   (think / think hard / ultrathink). The SDK has no native effort flag
  //   and its bundled cli.js doesn't accept --effort — this is the only
  //   mechanism that actually works. See agent-settings.ts for details.
  if (resolved) {
    const fragment = toClaudeSdkOptions(resolved);
    if (fragment.model) sdkOptions.model = fragment.model;
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
      if ((message as any).subtype === 'success' && (message as any).result) {
        const rt = (message as any).result;
        if (rt !== fullText) { fullText = rt; callbacks.onText(fullText); }
      }
      if ((message as any).session_id) llmSessionId = (message as any).session_id;
    }
  }

  return { text: fullText, costUsd, sessionId: llmSessionId, trace };
}

// ── Main Router ──

export async function runChatLLM(db: Db, options: ChatLLMOptions): Promise<ChatLLMResult> {
  const provider = options.provider ?? 'codex';
  const providerConfig = PROVIDERS.find(p => p.provider === provider) ?? PROVIDERS[0];
  const model = options.model ?? providerConfig.defaultModel;

  log(`━━━ New message [${provider}/${model}] ━━━`);
  const prompt = options.messages.length > 0 ? options.messages[options.messages.length - 1].content : '';
  log(`Prompt: "${prompt.slice(0, 100)}${prompt.length > 100 ? '...' : ''}"`);
  if (options.resumeSessionId) log(`Resume: ${options.resumeSessionId.slice(0, 8)}...`);

  const startMs = Date.now();

  const callbacks: ProviderCallbacks = {
    onText: options.onText,
    onThinking: options.onThinking,
    onToolStart: options.onToolStart,
    onToolResult: options.onToolResult,
    onSessionId: options.onSessionId,
    signal: options.signal,
  };

  let result: { text: string; costUsd: number; sessionId?: string; trace: ChatTraceEvent[] };

  const resolved = options.resolvedSettings;
  if (resolved) {
    log(`Effort=${resolved.reasoningEffort ?? '(default)'} planMode=${resolved.planMode}`);
  }

  switch (provider) {
    case 'codex':
      result = await runCodexCLI(db, options.systemPrompt, options.messages, model, callbacks, options.resumeSessionId, options.skipTools, options.cwd, resolved);
      break;
    case 'claude-cli':
      result = await runClaudeCLI(db, options.systemPrompt, options.messages, model, callbacks, options.resumeSessionId, options.skipTools, options.cwd, resolved);
      break;
    default:
      throw new Error(`Unknown provider: ${provider}`);
  }

  const durationMs = Date.now() - startMs;
  log(`━━━ Complete [${provider}] | $${result.costUsd.toFixed(4)} | ${durationMs}ms | ${result.text.length} chars ━━━`);

  return { ...result, durationMs, model, provider };
}
