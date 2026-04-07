/**
 * Chat LLM Providers
 * Each provider implements the same interface but uses a different LLM backend.
 * All providers support tool calling with our 16 built-in tools.
 */

import type { Db } from 'mongodb';
import { chatTools, executeChatTool } from './chat-tools.js';
import { loadMcpTools, executeMcpTool, isMcpTool, mcpToolsToOpenAI, mcpToolsToAnthropic, mcpToolsToGemini, type McpTool } from './chat-mcp-client.js';
import type { ChatTraceEvent } from './chat-llm.js';

// ── Shared Types ──

export type ChatProvider = 'codex' | 'claude-cli' | 'gemini' | 'anthropic-api';

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
  {
    provider: 'gemini',
    label: 'Gemini',
    models: ['gemini-2.5-flash', 'gemini-2.5-pro'],
    defaultModel: 'gemini-2.5-flash',
    requiresKey: 'GEMINI_API_KEY',
    supportsMcp: false,
    supportsStreaming: true,
    supportsSessionResume: false,
  },
  {
    provider: 'anthropic-api',
    label: 'Claude (API)',
    models: ['claude-sonnet-4-20250514', 'claude-haiku-4-5-20251001'],
    defaultModel: 'claude-sonnet-4-20250514',
    requiresKey: 'ANTHROPIC_API_KEY',
    supportsMcp: false,
    supportsStreaming: true,
    supportsSessionResume: false,
  },
];

// ── Tool Definitions for API providers ──

function buildToolsForOpenAI(): Array<{ type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } }> {
  return chatTools.map(t => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
    },
  }));
}

function buildToolsForAnthropic(): Array<{ name: string; description: string; input_schema: Record<string, unknown> }> {
  return chatTools.map(t => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema,
  }));
}

function buildToolsForGemini(): Array<{ functionDeclarations: Array<{ name: string; description: string; parameters: Record<string, unknown> }> }> {
  return [{
    functionDeclarations: chatTools.map(t => ({
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
    })),
  }];
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

// ── Get API Key ──

async function getKey(envVar: string, db: Db): Promise<string> {
  if (process.env[envVar]) return process.env[envVar]!;
  const secret = await db.collection('secrets').findOne({ key: envVar });
  if (secret?.value) return secret.value as string;
  throw new Error(`${envVar} not found. Set it as an environment variable or add it via Settings > Secrets.`);
}

// ════════════════════════════════════════════════════════════════════════════
// PROVIDER: OpenAI / Codex (DEFAULT)
// ════════════════════════════════════════════════════════════════════════════

/**
 * Execute a tool call — routes to built-in or MCP based on name.
 */
async function executeToolCall(name: string, args: Record<string, unknown>, db: Db): Promise<Record<string, unknown>> {
  if (isMcpTool(name)) {
    return executeMcpTool(name, args);
  }
  return executeChatTool(name, args, db);
}

export async function runOpenAI(
  db: Db,
  systemPrompt: string,
  messages: ProviderMessage[],
  model: string,
  callbacks: ProviderCallbacks,
  skipTools?: boolean,
): Promise<ProviderResult> {
  const OpenAI = (await import('openai')).default;
  const client = new OpenAI({ apiKey: await getKey('OPENAI_API_KEY', db) });

  const trace: ChatTraceEvent[] = [];
  let fullText = '';
  let totalCost = 0;

  const apiMessages: Array<{ role: string; content: string; tool_call_id?: string }> = [
    { role: 'system', content: systemPrompt },
    ...messages.map(m => ({ role: m.role, content: m.content })),
  ];

  // Load built-in + MCP tools
  let tools: ReturnType<typeof buildToolsForOpenAI> | undefined;
  if (!skipTools) {
    tools = buildToolsForOpenAI();
    const mcpTools = await loadMcpTools(db);
    if (mcpTools.length > 0) {
      tools.push(...mcpToolsToOpenAI(mcpTools));
      log(`Loaded ${mcpTools.length} MCP tools: ${mcpTools.map(t => t.serverName).filter((v, i, a) => a.indexOf(v) === i).join(', ')}`);
    }
  }
  const MAX_ROUNDS = 10;

  for (let round = 0; round < MAX_ROUNDS; round++) {
    log(`${round > 0 ? `── Tool round ${round} ──` : ''}Calling ${model}...`);

    const stream = await client.chat.completions.create({
      model,
      messages: apiMessages as any,
      tools,
      stream: true,
    });

    let currentText = '';
    let toolCalls: Array<{ id: string; name: string; arguments: string }> = [];
    let finishReason = '';

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta;
      if (!delta) continue;

      if (delta.content) {
        currentText += delta.content;
        fullText = fullText ? fullText.slice(0, fullText.length - currentText.length + delta.content.length) : '';
        fullText += currentText;
        // For simplicity in streaming, just send accumulated text
      }

      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          if (tc.index !== undefined) {
            while (toolCalls.length <= tc.index) toolCalls.push({ id: '', name: '', arguments: '' });
            if (tc.id) toolCalls[tc.index].id = tc.id;
            if (tc.function?.name) toolCalls[tc.index].name = tc.function.name;
            if (tc.function?.arguments) toolCalls[tc.index].arguments += tc.function.arguments;
          }
        }
      }

      finishReason = chunk.choices[0]?.finish_reason ?? finishReason;
    }

    if (currentText) {
      fullText = currentText;
      callbacks.onText(fullText);
    }

    // If no tool calls, we're done
    if (finishReason !== 'tool_calls' || toolCalls.length === 0) {
      break;
    }

    // Add assistant message with tool calls
    apiMessages.push({
      role: 'assistant',
      content: currentText || '',
      ...({ tool_calls: toolCalls.map(tc => ({ id: tc.id, type: 'function', function: { name: tc.name, arguments: tc.arguments } })) } as any),
    });

    // Execute tools and add results
    for (const tc of toolCalls) {
      let args: Record<string, unknown> = {};
      try { args = JSON.parse(tc.arguments); } catch {}

      log(`🔧 Tool call: ${tc.name}`, args);
      trace.push({ timestamp: new Date(), type: 'tool_call', tool: tc.name, toolUseId: tc.id, args });
      callbacks.onToolStart(tc.name, args, tc.id);

      const startMs = Date.now();
      const result = await executeToolCall(tc.name, args, db);
      const durationMs = Date.now() - startMs;

      log(`✅ Tool result: ${tc.name} (${durationMs}ms)`, result);
      trace.push({ timestamp: new Date(), type: 'tool_result', tool: tc.name, toolUseId: tc.id, result, durationMs });
      callbacks.onToolResult(tc.name, result, tc.id, durationMs);

      apiMessages.push({
        role: 'tool' as any,
        content: JSON.stringify(result),
        tool_call_id: tc.id,
      } as any);
    }
  }

  trace.push({ timestamp: new Date(), type: 'complete', text: `cost=$${totalCost.toFixed(4)}` });
  return { text: fullText, costUsd: totalCost, trace };
}

// ── Sync MCP servers to Codex CLI ──

/** Path to the FlowForge MCP server script */
function getFlowForgeMcpServerPath(): string {
  const { resolve } = require('node:path') as typeof import('node:path');
  // In dev (tsx), use .ts file. In prod (compiled), use .js
  const tsPath = resolve(process.cwd(), 'src/services/flowforge-mcp-server.ts');
  const { existsSync } = require('node:fs') as typeof import('node:fs');
  if (existsSync(tsPath)) return tsPath;
  return resolve(process.cwd(), 'dist/services/flowforge-mcp-server.js');
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

  // Register FlowForge MCP server if not present
  if (!existingOutput.includes('flowforge')) {
    try {
      const serverPath = getFlowForgeMcpServerPath();
      await execFileAsync('codex', [
        'mcp', 'add', 'flowforge',
        '--env', `FLOWFORGE_API_URL=http://localhost:${process.env.PORT ?? '4023'}`,
        '--', 'npx', 'tsx', serverPath,
      ], { timeout: 10000 });
      log('Registered FlowForge MCP server with Codex CLI');
    } catch (err) {
      log(`Failed to register FlowForge MCP with Codex: ${(err as Error).message}`);
    }
  }

  // Register external MCP servers
  for (const server of servers) {
    if (existingOutput.includes(server.name)) continue;

    try {
      const cmdArgs = ['mcp', 'add', server.name];
      if (server.env) {
        for (const [k, v] of Object.entries(server.env)) {
          cmdArgs.push('--env', `${k}=${v}`);
        }
      }
      cmdArgs.push('--', server.command!, ...(server.args ?? []));
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
): Promise<ProviderResult & { sessionId?: string }> {
  const { spawn } = await import('node:child_process');
  const trace: ChatTraceEvent[] = [];
  const lastUserMsg = messages.length > 0 ? messages[messages.length - 1].content : '';

  let prompt = lastUserMsg;
  if (!resumeSessionId && !skipTools) {
    prompt = `${systemPrompt}\n\n${lastUserMsg}`;
  }

  const args: string[] = ['exec'];
  if (resumeSessionId) {
    args.push('resume', '--json', '--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check', resumeSessionId, prompt);
  } else {
    args.push('--json', '--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check');
    if (model && model !== 'default') args.push('-c', `model="${model}"`);
    args.push(prompt);
  }

  // Sync MCP servers to Codex CLI config
  if (!skipTools) {
    await syncMcpToCodex(db);
  }

  log(`Spawning codex: ${args.slice(0, 4).join(' ')}...`);

  return new Promise<ProviderResult & { sessionId?: string }>((resolve, reject) => {
    const proc = spawn('codex', args, {
      cwd: '/tmp',
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
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

    proc.stderr.on('data', (chunk: Buffer) => {
      const msg = chunk.toString().trim();
      if (msg && !msg.includes('ERROR codex_core') && !msg.includes('Reading additional')) {
        log(`[codex] ${msg}`);
      }
    });

    // No hard timeout — agents can take as long as they need

    proc.on('close', (code) => {
      trace.push({ timestamp: new Date(), type: 'complete', text: `exit=${code}` });
      resolve({ text: rawResponse, costUsd: 0, sessionId: threadId, trace });
    });
  });
}

// ════════════════════════════════════════════════════════════════════════════
// PROVIDER: Anthropic API
// ════════════════════════════════════════════════════════════════════════════

export async function runAnthropicAPI(
  db: Db,
  systemPrompt: string,
  messages: ProviderMessage[],
  model: string,
  callbacks: ProviderCallbacks,
  skipTools?: boolean,
): Promise<ProviderResult> {
  const Anthropic = (await import('@anthropic-ai/sdk')).default;
  const client = new Anthropic({ apiKey: await getKey('ANTHROPIC_API_KEY', db) });

  const trace: ChatTraceEvent[] = [];
  let fullText = '';
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  const apiMessages = messages.map(m => ({ role: m.role as 'user' | 'assistant', content: m.content }));
  let tools: ReturnType<typeof buildToolsForAnthropic> | undefined;
  if (!skipTools) {
    tools = buildToolsForAnthropic();
    const mcpTools = await loadMcpTools(db);
    if (mcpTools.length > 0) tools.push(...mcpToolsToAnthropic(mcpTools));
  }
  const MAX_ROUNDS = 10;

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const streamParams: Record<string, unknown> = { model, max_tokens: 8192, system: systemPrompt, messages: apiMessages };
    if (tools) streamParams.tools = tools;

    const stream = (client.messages as any).stream(streamParams);
    let currentText = '';
    const toolUseBlocks: Array<{ id: string; name: string; input: Record<string, unknown> }> = [];

    stream.on('text', (text: string) => {
      currentText += text;
      fullText += text;
      callbacks.onText(fullText);
    });

    const response = await stream.finalMessage();
    totalInputTokens += response.usage.input_tokens;
    totalOutputTokens += response.usage.output_tokens;

    for (const block of response.content) {
      if (block.type === 'tool_use') {
        toolUseBlocks.push({ id: block.id, name: block.name, input: block.input as Record<string, unknown> });
      }
    }

    if (response.stop_reason !== 'tool_use' || toolUseBlocks.length === 0) break;

    apiMessages.push({ role: 'assistant', content: response.content } as any);

    const toolResults: any[] = [];
    for (const tb of toolUseBlocks) {
      log(`🔧 Tool call: ${tb.name}`, tb.input);
      trace.push({ timestamp: new Date(), type: 'tool_call', tool: tb.name, toolUseId: tb.id, args: tb.input });
      callbacks.onToolStart(tb.name, tb.input, tb.id);

      const startMs = Date.now();
      const result = await executeToolCall(tb.name, tb.input, db);
      const durationMs = Date.now() - startMs;

      log(`✅ Tool result: ${tb.name} (${durationMs}ms)`, result);
      trace.push({ timestamp: new Date(), type: 'tool_result', tool: tb.name, toolUseId: tb.id, result, durationMs });
      callbacks.onToolResult(tb.name, result, tb.id, durationMs);

      toolResults.push({ type: 'tool_result', tool_use_id: tb.id, content: JSON.stringify(result) });
    }
    apiMessages.push({ role: 'user', content: toolResults } as any);
  }

  const costUsd = (totalInputTokens * 3 + totalOutputTokens * 15) / 1_000_000;
  trace.push({ timestamp: new Date(), type: 'complete', text: `cost=$${costUsd.toFixed(4)}` });
  return { text: fullText, costUsd, trace };
}

// ════════════════════════════════════════════════════════════════════════════
// PROVIDER: Gemini
// ════════════════════════════════════════════════════════════════════════════

export async function runGemini(
  db: Db,
  systemPrompt: string,
  messages: ProviderMessage[],
  model: string,
  callbacks: ProviderCallbacks,
  skipTools?: boolean,
): Promise<ProviderResult> {
  const { GoogleGenerativeAI } = await import('@google/generative-ai');
  const client = new GoogleGenerativeAI(await getKey('GEMINI_API_KEY', db));

  const trace: ChatTraceEvent[] = [];
  let fullText = '';

  // Build Gemini contents
  const contents = messages.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));

  let tools: ReturnType<typeof buildToolsForGemini> | undefined;
  if (!skipTools) {
    tools = buildToolsForGemini();
    const mcpTools = await loadMcpTools(db);
    if (mcpTools.length > 0) {
      tools[0].functionDeclarations.push(...mcpToolsToGemini(mcpTools));
    }
  }
  const MAX_ROUNDS = 10;

  const genModel = client.getGenerativeModel({
    model,
    systemInstruction: systemPrompt,
    tools: tools as any,
  });

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const response = await genModel.generateContent({ contents } as any);
    const result = response.response;

    const parts = result.candidates?.[0]?.content?.parts ?? [];
    let textPart = '';
    const functionCalls: Array<{ name: string; args: Record<string, unknown> }> = [];

    for (const part of parts) {
      if (part.text) textPart += part.text;
      if (part.functionCall) {
        functionCalls.push({ name: part.functionCall.name!, args: (part.functionCall.args ?? {}) as Record<string, unknown> });
      }
    }

    if (textPart) {
      fullText = textPart;
      callbacks.onText(fullText);
    }

    if (functionCalls.length === 0) break;

    // Add model response to contents
    contents.push({ role: 'model', parts: parts as any });

    // Execute tools
    const functionResponses: any[] = [];
    for (const fc of functionCalls) {
      const toolId = `gemini_${round}_${fc.name}`;
      log(`🔧 Tool call: ${fc.name}`, fc.args);
      trace.push({ timestamp: new Date(), type: 'tool_call', tool: fc.name, toolUseId: toolId, args: fc.args });
      callbacks.onToolStart(fc.name, fc.args, toolId);

      const startMs = Date.now();
      const result = await executeToolCall(fc.name, fc.args, db);
      const durationMs = Date.now() - startMs;

      log(`✅ Tool result: ${fc.name} (${durationMs}ms)`, result);
      trace.push({ timestamp: new Date(), type: 'tool_result', tool: fc.name, toolUseId: toolId, result, durationMs });
      callbacks.onToolResult(fc.name, result, toolId, durationMs);

      functionResponses.push({ functionResponse: { name: fc.name, response: result } });
    }

    contents.push({ role: 'user', parts: functionResponses });
  }

  trace.push({ timestamp: new Date(), type: 'complete' });
  return { text: fullText, costUsd: 0, trace };
}
