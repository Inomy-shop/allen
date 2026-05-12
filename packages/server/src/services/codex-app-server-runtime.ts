import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { AGENT_FALLBACK_CWD, type ChatProvider } from './chat-providers.js';
import { toCodexArgs } from './agent-settings.js';
import { buildControlledMcpConfig } from './chat-controlled-mcp.js';
import { logRuntimeEvent } from './chat-runtime-logs.js';
import type { PersistentChatRuntime, RuntimeCreateInput, RuntimeTurnInput, RuntimeTurnResult } from './chat-runtime-types.js';
import type { ChatTraceEvent } from './chat-llm.js';

type RpcPending = {
  method: string;
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

type PendingTool = {
  tool: string;
  args: Record<string, unknown>;
  startMs: number;
};

type ActiveTurn = {
  input: RuntimeTurnInput;
  sentAt: number;
  text: string;
  thinking: string;
  trace: ChatTraceEvent[];
  pendingTools: Map<string, PendingTool>;
  resolve: (result: RuntimeTurnResult) => void;
  reject: (error: Error) => void;
};

export class CodexAppServerRuntime implements PersistentChatRuntime {
  readonly id = `codex-${randomUUID()}`;
  readonly provider: ChatProvider = 'codex';
  readonly key: string;

  private proc?: ChildProcessWithoutNullStreams;
  private stdoutBuffer = '';
  private stderrBuffer = '';
  private nextId = 1;
  private pending = new Map<number, RpcPending>();
  private currentTurn?: ActiveTurn;
  private threadId = '';
  private initialized?: Promise<void>;
  private closed = false;

  constructor(private readonly createInput: RuntimeCreateInput) {
    this.key = createInput.key;
  }

  async sendTurn(input: RuntimeTurnInput): Promise<RuntimeTurnResult> {
    if (this.currentTurn) throw new Error('Codex runtime already has an active turn');
    await this.ensureStarted(input);

    const prompt = input.messages.at(-1)?.content ?? '';
    const trace: ChatTraceEvent[] = [];
    const completion = new Promise<RuntimeTurnResult>((resolve, reject) => {
      this.currentTurn = {
        input,
        sentAt: Date.now(),
        text: '',
        thinking: '',
        trace,
        pendingTools: new Map(),
        resolve,
        reject,
      };
    });

    logRuntimeEvent({
      db: input.db,
      sessionId: input.chatSessionId,
      provider: this.provider,
      runtimeId: this.id,
      eventType: 'lifecycle',
      event: 'turn_send',
      data: { threadId: this.threadId, promptPreview: prompt.slice(0, 300) },
    });

    await this.request('turn/start', {
      threadId: this.threadId,
      cwd: input.cwd ?? AGENT_FALLBACK_CWD,
      model: input.model,
      effort: codexEffort(input),
      approvalPolicy: 'never',
      input: [{ type: 'text', text: prompt, text_elements: [] }],
    });

    return completion;
  }

  async close(reason: string): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    logRuntimeEvent({
      db: this.createInput.db,
      sessionId: this.createInput.chatSessionId,
      provider: this.provider,
      runtimeId: this.id,
      eventType: 'lifecycle',
      event: 'runtime_close',
      data: { reason, threadId: this.threadId },
    });
    for (const item of this.pending.values()) {
      clearTimeout(item.timer);
      item.reject(new Error(`Codex runtime closed while waiting for ${item.method}`));
    }
    this.pending.clear();
    this.currentTurn?.reject(new Error(`Codex runtime closed: ${reason}`));
    this.currentTurn = undefined;
    this.proc?.stdin.end();
    setTimeout(() => {
      try { this.proc?.kill('SIGTERM'); } catch {}
    }, 1000).unref();
  }

  private async ensureStarted(input: RuntimeTurnInput): Promise<void> {
    this.initialized ??= this.start(input);
    return this.initialized;
  }

  private async start(input: RuntimeTurnInput): Promise<void> {
    const cwd = input.cwd ?? AGENT_FALLBACK_CWD;
    mkdirSync(cwd, { recursive: true });
    const mcp = await buildControlledMcpConfig({
      db: input.db,
      chatSessionId: input.chatSessionId,
      runtimeId: this.id,
      skipTools: input.skipTools,
    });
    const args = ['app-server', '--listen', 'stdio://', '-c', mcp.codexInlineConfig];
    this.proc = spawn('codex', args, {
      cwd,
      env: { ...process.env, ...(input.chatSessionId ? { ALLEN_CHAT_SESSION_ID: input.chatSessionId } : {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.proc.stdout.on('data', (chunk: Buffer) => this.handleStdout(chunk));
    this.proc.stderr.on('data', (chunk: Buffer) => { this.stderrBuffer += chunk.toString(); });
    this.proc.on('close', (code) => {
      logRuntimeEvent({
        db: input.db,
        sessionId: input.chatSessionId,
        provider: this.provider,
        runtimeId: this.id,
        eventType: 'lifecycle',
        event: 'process_closed',
        data: { code, stderr: this.stderrBuffer.slice(-2000) },
      });
      this.closed = true;
      this.currentTurn?.reject(new Error(`Codex app-server exited with code ${code}`));
      this.currentTurn = undefined;
    });
    this.proc.on('error', (err) => {
      this.closed = true;
      this.currentTurn?.reject(err);
    });

    await this.request('initialize', {
      clientInfo: { name: 'allen-chat', title: 'Allen Chat', version: '0.1.0' },
      capabilities: { experimentalApi: true },
    });

    const config = codexConfig(input);
    const threadParams = {
      cwd,
      model: input.model,
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
      baseInstructions: input.resumeSessionId ? undefined : input.systemPrompt,
      ephemeral: false,
      config: { ...config, ...mcpConfigObject(mcp.codexInlineConfig) },
    };

    const response = input.resumeSessionId
      ? await this.request('thread/resume', { threadId: input.resumeSessionId, ...threadParams })
      : await this.request('thread/start', threadParams);
    const thread = response.thread as { id?: string; sessionId?: string } | undefined;
    this.threadId = thread?.id ?? input.resumeSessionId ?? '';
    if (this.threadId) {
      input.callbacks.onSessionId?.(this.threadId);
    }
    logRuntimeEvent({
      db: input.db,
      sessionId: input.chatSessionId,
      provider: this.provider,
      runtimeId: this.id,
      eventType: 'lifecycle',
      event: input.resumeSessionId ? 'thread_resumed' : 'thread_started',
      data: { threadId: this.threadId, providerSessionId: thread?.sessionId },
    });
  }

  private request(method: string, params: unknown): Promise<Record<string, unknown>> {
    if (!this.proc || this.closed) throw new Error('Codex runtime is not running');
    const id = this.nextId++;
    this.proc.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for Codex app-server ${method}`));
      }, 120_000);
      timer.unref();
      this.pending.set(id, { method, resolve, reject, timer });
    });
  }

  private handleStdout(chunk: Buffer): void {
    this.stdoutBuffer += chunk.toString();
    const lines = this.stdoutBuffer.split('\n');
    this.stdoutBuffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line) as Record<string, unknown>;
        this.handleJsonRpc(msg);
      } catch {
        logRuntimeEvent({
          db: this.createInput.db,
          sessionId: this.createInput.chatSessionId,
          provider: this.provider,
          runtimeId: this.id,
          eventType: 'raw_provider',
          event: 'non_json_stdout',
          data: { line },
        });
      }
    }
  }

  private handleJsonRpc(msg: Record<string, unknown>): void {
    logRuntimeEvent({
      db: this.currentTurn?.input.db ?? this.createInput.db,
      sessionId: this.currentTurn?.input.chatSessionId ?? this.createInput.chatSessionId,
      provider: this.provider,
      runtimeId: this.id,
      eventType: 'raw_provider',
      event: 'json_rpc',
      data: msg,
    });

    if (msg.id !== undefined && ('result' in msg || 'error' in msg)) {
      const id = Number(msg.id);
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      clearTimeout(pending.timer);
      if (msg.error) pending.reject(new Error(JSON.stringify(msg.error)));
      else pending.resolve((msg.result ?? {}) as Record<string, unknown>);
      return;
    }

    if (msg.id !== undefined && typeof msg.method === 'string') {
      this.proc?.stdin.write(JSON.stringify({ id: msg.id, result: {} }) + '\n');
      return;
    }

    if (typeof msg.method === 'string') this.handleNotification(msg.method, (msg.params ?? {}) as Record<string, unknown>);
  }

  private handleNotification(method: string, params: Record<string, unknown>): void {
    const turn = this.currentTurn;
    if (method === 'thread/started') {
      const thread = params.thread as { id?: string } | undefined;
      if (thread?.id) {
        this.threadId = thread.id;
        turn?.input.callbacks.onSessionId?.(thread.id);
      }
      return;
    }

    if (!turn) return;

    if (method === 'item/agentMessage/delta') {
      turn.text += String(params.delta ?? '');
      logRuntimeEvent({
        db: turn.input.db,
        sessionId: turn.input.chatSessionId,
        provider: this.provider,
        runtimeId: this.id,
        eventType: 'normalized',
        event: 'message_delta',
        data: { text: turn.text },
      });
      turn.input.callbacks.onText(turn.text);
      return;
    }

    if (method === 'item/reasoning/textDelta' || method === 'item/reasoning/summaryTextDelta') {
      turn.thinking += String(params.delta ?? '');
      turn.trace.push({ timestamp: new Date(), type: 'thinking', text: turn.thinking });
      logRuntimeEvent({
        db: turn.input.db,
        sessionId: turn.input.chatSessionId,
        provider: this.provider,
        runtimeId: this.id,
        eventType: 'normalized',
        event: 'thinking',
        data: { text: turn.thinking },
      });
      turn.input.callbacks.onThinking?.(turn.thinking);
      return;
    }

    if (method === 'item/started') {
      const item = (params.item ?? {}) as Record<string, unknown>;
      this.handleItemStarted(turn, item);
      return;
    }

    if (method === 'item/completed') {
      const item = (params.item ?? {}) as Record<string, unknown>;
      this.handleItemCompleted(turn, item);
      return;
    }

    if (method === 'turn/completed') {
      const done = this.currentTurn;
      if (!done) return;
      this.currentTurn = undefined;
      done.trace.push({ timestamp: new Date(), type: 'complete', text: 'turn_completed' });
      logRuntimeEvent({
        db: done.input.db,
        sessionId: done.input.chatSessionId,
        provider: this.provider,
        runtimeId: this.id,
        eventType: 'lifecycle',
        event: 'turn_completed',
        data: { threadId: this.threadId },
      });
      done.resolve({
        text: done.text,
        costUsd: 0,
        sessionId: this.threadId,
        trace: done.trace,
      });
    }
  }

  private handleItemStarted(turn: ActiveTurn, item: Record<string, unknown>): void {
    const type = String(item.type ?? '');
    const id = String(item.id ?? '');
    if (type === 'mcpToolCall') {
      const server = String(item.server ?? '');
      const tool = String(item.tool ?? '');
      const fullName = `mcp__${server}__${tool}`;
      const args = asRecord(item.arguments);
      turn.pendingTools.set(id, { tool: fullName, args, startMs: Date.now() });
      turn.trace.push({ timestamp: new Date(), type: 'tool_call', tool: fullName, toolUseId: id, args });
      logRuntimeEvent({
        db: turn.input.db,
        sessionId: turn.input.chatSessionId,
        provider: this.provider,
        runtimeId: this.id,
        eventType: 'normalized',
        event: 'tool_start',
        data: { tool: fullName, args, toolUseId: id },
      });
      turn.input.callbacks.onToolStart(fullName, args, id);
      return;
    }
    if (type === 'commandExecution') {
      const args = { command: String(item.command ?? '') };
      turn.pendingTools.set(id, { tool: 'Bash', args, startMs: Date.now() });
      turn.trace.push({ timestamp: new Date(), type: 'tool_call', tool: 'Bash', toolUseId: id, args });
      logRuntimeEvent({
        db: turn.input.db,
        sessionId: turn.input.chatSessionId,
        provider: this.provider,
        runtimeId: this.id,
        eventType: 'normalized',
        event: 'tool_start',
        data: { tool: 'Bash', args, toolUseId: id },
      });
      turn.input.callbacks.onToolStart('Bash', args, id);
    }
  }

  private handleItemCompleted(turn: ActiveTurn, item: Record<string, unknown>): void {
    const type = String(item.type ?? '');
    const id = String(item.id ?? '');
    if (type === 'mcpToolCall') {
      const started = turn.pendingTools.get(id);
      const server = String(item.server ?? '');
      const tool = String(item.tool ?? '');
      const fullName = started?.tool ?? `mcp__${server}__${tool}`;
      const durationMs = typeof item.durationMs === 'number' ? item.durationMs : started ? Date.now() - started.startMs : 0;
      const result = mcpResult(item);
      turn.trace.push({ timestamp: new Date(), type: 'tool_result', tool: fullName, toolUseId: id, result, durationMs, isError: Boolean(item.error) });
      logRuntimeEvent({
        db: turn.input.db,
        sessionId: turn.input.chatSessionId,
        provider: this.provider,
        runtimeId: this.id,
        eventType: 'normalized',
        event: 'tool_result',
        data: { tool: fullName, result, toolUseId: id, durationMs, isError: Boolean(item.error) },
      });
      turn.input.callbacks.onToolResult(fullName, result, id, durationMs);
      turn.pendingTools.delete(id);
      return;
    }
    if (type === 'commandExecution') {
      const started = turn.pendingTools.get(id);
      const durationMs = typeof item.durationMs === 'number' ? item.durationMs : started ? Date.now() - started.startMs : 0;
      const result: Record<string, unknown> = { output: String(item.aggregatedOutput ?? '').slice(0, 10_000) };
      if (item.exitCode !== undefined && item.exitCode !== null) result.exit_code = item.exitCode;
      turn.trace.push({ timestamp: new Date(), type: 'tool_result', tool: 'Bash', toolUseId: id, result, durationMs, isError: item.status !== 'completed' });
      logRuntimeEvent({
        db: turn.input.db,
        sessionId: turn.input.chatSessionId,
        provider: this.provider,
        runtimeId: this.id,
        eventType: 'normalized',
        event: 'tool_result',
        data: { tool: 'Bash', result, toolUseId: id, durationMs, isError: item.status !== 'completed' },
      });
      turn.input.callbacks.onToolResult('Bash', result, id, durationMs);
      turn.pendingTools.delete(id);
    }
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function mcpResult(item: Record<string, unknown>): Record<string, unknown> {
  if (item.error) return { error: JSON.stringify(item.error) };
  const result = item.result as { content?: Array<{ type?: string; text?: string }> } | null | undefined;
  const text = result?.content?.filter((c) => c.type === 'text').map((c) => c.text ?? '').join('');
  if (!text) return {};
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { raw: text };
  }
}

function codexEffort(input: RuntimeTurnInput): string | undefined {
  return input.resolvedSettings?.reasoningEffort === 'max' ? 'high' : input.resolvedSettings?.reasoningEffort;
}

function codexConfig(input: RuntimeTurnInput): Record<string, unknown> {
  const args = input.resolvedSettings ? toCodexArgs(input.resolvedSettings) : [];
  const config: Record<string, unknown> = {
    model: input.model,
    ...(codexEffort(input) ? { model_reasoning_effort: codexEffort(input) } : {}),
  };
  for (let i = 0; i < args.length; i += 2) {
    const kv = args[i + 1] ?? '';
    const idx = kv.indexOf('=');
    if (idx <= 0) continue;
    const key = kv.slice(0, idx);
    const raw = kv.slice(idx + 1);
    try {
      config[key] = JSON.parse(raw);
    } catch {
      config[key] = raw.replace(/^"|"$/g, '');
    }
  }
  return config;
}

function mcpConfigObject(inline: string): Record<string, unknown> {
  return inline === 'mcp_servers={}' ? { mcp_servers: {} } : {};
}
