import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { normalizeCodexUsage, type TokenUsageInfo } from '@allen/engine';
import { AGENT_FALLBACK_CWD, type ChatProvider } from './chat-providers.js';
import { toCodexArgs } from './agent-settings.js';
import { buildControlledMcpConfig } from './chat-controlled-mcp.js';
import { logRuntimeEvent } from './chat-runtime-logs.js';
import type { PersistentChatRuntime, RuntimeCreateInput, RuntimeSlashCommand, RuntimeTurnInput, RuntimeTurnResult } from './chat-runtime-types.js';
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
  slashCommand?: RuntimeSlashCommand;
  sentAt: number;
  text: string;
  thinking: string;
  tokenUsage: TokenUsageInfo | null;
  tokenUsageSnapshot?: Record<string, unknown>;
  trace: ChatTraceEvent[];
  pendingTools: Map<string, PendingTool>;
  resolve: (result: RuntimeTurnResult) => void;
  reject: (error: Error) => void;
};

type ContextUsage = {
  totalTokens: number;
  modelContextWindow: number;
  estimated?: boolean;
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
  private threadCwd = '';
  private threadModel = '';
  private providerSessionId = '';
  private latestThreadStatus: Record<string, unknown> = { type: 'notLoaded' };
  private latestTokenUsage?: Record<string, unknown>;
  private latestRateLimits?: Record<string, unknown>;
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
        tokenUsage: null,
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

  async sendSlashCommand(input: RuntimeTurnInput, command: RuntimeSlashCommand): Promise<RuntimeTurnResult> {
    if (this.currentTurn) throw new Error('Codex runtime already has an active turn');
    await this.ensureStarted(input);

    const trace: ChatTraceEvent[] = [];
    let rejectTurn: (error: Error) => void = () => {};
    const completion = new Promise<RuntimeTurnResult>((resolve, reject) => {
      rejectTurn = reject;
      this.currentTurn = {
        input,
        slashCommand: command,
        sentAt: Date.now(),
        text: '',
        thinking: '',
        tokenUsage: null,
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
      event: 'slash_command_send',
      data: { threadId: this.threadId, command },
    });

    try {
      await this.dispatchSlashCommand(input, command);
    } catch (err) {
      rejectTurn(err instanceof Error ? err : new Error(String(err)));
      this.currentTurn = undefined;
      throw err;
    }

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
    this.threadCwd = cwd;
    this.threadModel = input.model;
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
      capabilities: {
        experimentalApi: true,
        optOutNotificationMethods: [],
      },
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
    this.providerSessionId = thread?.sessionId ?? '';
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

  private async dispatchSlashCommand(input: RuntimeTurnInput, command: RuntimeSlashCommand): Promise<void> {
    if (command.kind === 'skill' && command.path) {
      const items: Array<Record<string, unknown>> = [
        { type: 'skill', name: command.name.replace(/^\/+/, ''), path: command.path },
      ];
      if (command.args.trim()) {
        items.push({ type: 'text', text: command.args.trim(), text_elements: [] });
      }
      await this.request('turn/start', {
        threadId: this.threadId,
        cwd: input.cwd ?? AGENT_FALLBACK_CWD,
        model: input.model,
        effort: codexEffort(input),
        approvalPolicy: 'never',
        input: items,
      });
      return;
    }

    if (command.name === '/compact') {
      await this.request('thread/compact/start', { threadId: this.threadId });
      return;
    }

    if (command.name === '/review') {
      await this.request('review/start', {
        threadId: this.threadId,
        delivery: 'inline',
        target: codexReviewTarget(command.args),
      });
      return;
    }

    if (command.name === '/status') {
      const [readResult, accountResult, rateLimitResult] = await Promise.all([
        this.request('thread/read', {
          threadId: this.threadId,
          includeTurns: true,
        }).catch((err) => ({ readError: err instanceof Error ? err.message : String(err) })),
        this.request('account/read', { refreshToken: false })
          .catch((err) => ({ accountError: err instanceof Error ? err.message : String(err) })),
        this.request('account/rateLimits/read', null)
          .catch((err) => ({ rateLimitError: err instanceof Error ? err.message : String(err) })),
      ]);
      const contextEstimate = await this.estimateContextUsage(input, readResult);
      this.handleAgentMessage(this.currentTurn!, this.formatThreadStatus(readResult, accountResult, rateLimitResult, contextEstimate));
      this.finishSyntheticTurn('slash_status');
      return;
    }

    throw new Error(`Unsupported Codex slash command: ${command.name}`);
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
    if (method === 'thread/status/changed') {
      if (!params.threadId || params.threadId === this.threadId) {
        this.latestThreadStatus = asRecord(params.status);
      }
      return;
    }

    if (method === 'thread/tokenUsage/updated') {
      if (!params.threadId || params.threadId === this.threadId) {
        const tokenUsage = asRecord(params.tokenUsage);
        this.latestTokenUsage = tokenUsage;
        if (turn) turn.tokenUsageSnapshot = tokenUsage;
      }
      return;
    }

    if (method === 'account/rateLimits/updated') {
      this.latestRateLimits = asRecord(params.rateLimits);
      return;
    }

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
      this.appendThinking(turn, String(params.delta ?? ''));
      return;
    }

    if (method === 'item/reasoning/summaryPartAdded') {
      this.appendThinking(turn, reasoningPartText(params));
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
      done.tokenUsage = normalizeCodexRuntimeUsage(params.usage ?? params.tokenUsage ?? done.tokenUsageSnapshot);
      if (!done.text.trim()) {
        const fallback = slashCommandFallback(done.slashCommand);
        if (fallback) this.handleAgentMessage(done, fallback);
      }
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
        tokenUsage: done.tokenUsage,
      });
    }

    if (method === 'thread/compacted') {
      const done = this.currentTurn;
      if (!done) return;
      this.handleAgentMessage(done, 'Compacted Codex thread context.');
      this.finishSyntheticTurn('thread_compacted');
    }
  }

  private handleItemStarted(turn: ActiveTurn, item: Record<string, unknown>): void {
    const type = String(item.type ?? '');
    const id = String(item.id ?? '');
    if (isAgentMessageItemType(type)) {
      const text = agentMessageText(item);
      if (text) this.handleAgentMessage(turn, text);
      return;
    }
    if (isReasoningItemType(type)) {
      const text = reasoningItemText(item);
      if (text) this.mergeThinking(turn, text);
      return;
    }
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
    if (isAgentMessageItemType(type)) {
      const text = agentMessageText(item);
      if (text) this.handleAgentMessage(turn, text);
      return;
    }
    if (isReasoningItemType(type)) {
      const text = reasoningItemText(item);
      if (text) this.mergeThinking(turn, text);
      return;
    }
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

  private handleAgentMessage(turn: ActiveTurn, text: string): void {
    const clean = text.trim();
    if (!clean) return;
    if (clean === turn.text.trim()) return;
    turn.text = text;
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
  }

  private appendThinking(turn: ActiveTurn, delta: string): void {
    if (!delta) return;
    this.replaceThinking(turn, `${turn.thinking}${delta}`);
  }

  private mergeThinking(turn: ActiveTurn, text: string): void {
    const clean = text.trim();
    if (!clean) return;
    if (!turn.thinking) {
      this.replaceThinking(turn, clean);
      return;
    }
    if (turn.thinking.includes(clean)) return;
    if (clean.startsWith(turn.thinking)) {
      this.replaceThinking(turn, clean);
      return;
    }
    this.replaceThinking(turn, `${turn.thinking}\n\n${clean}`);
  }

  private replaceThinking(turn: ActiveTurn, text: string): void {
    if (!text || text === turn.thinking) return;
    turn.thinking = text;
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
  }

  private finishSyntheticTurn(reason: string): void {
    const done = this.currentTurn;
    if (!done) return;
    this.currentTurn = undefined;
    done.trace.push({ timestamp: new Date(), type: 'complete', text: reason });
    done.resolve({
      text: done.text,
      costUsd: 0,
      sessionId: this.threadId,
      trace: done.trace,
    });
  }

  private async estimateContextUsage(input: RuntimeTurnInput, readResult: Record<string, unknown>): Promise<ContextUsage | undefined> {
    const window = contextWindowForModel(this.threadModel || input.model);
    if (!window) return undefined;
    const thread = asRecord(readResult.thread);
    const threadText = collectText(thread.turns).trim();
    let text = threadText;
    if (!text && input.chatSessionId) {
      try {
        const messages = await input.db.collection('chat_messages')
          .find({ sessionId: input.chatSessionId, status: { $in: ['completed', 'streaming'] } })
          .sort({ createdAt: 1 })
          .project({ role: 1, content: 1, thinkingText: 1 })
          .toArray();
        text = messages.map((msg) => `${String(msg.role ?? '')}: ${String(msg.content ?? '')}\n${String(msg.thinkingText ?? '')}`).join('\n');
      } catch {}
    }
    const totalTokens = estimateTokens(text);
    return totalTokens > 0 ? { totalTokens, modelContextWindow: window, estimated: true } : undefined;
  }

  private formatThreadStatus(readResult: Record<string, unknown>, accountResult: Record<string, unknown>, rateLimitResult: Record<string, unknown>, contextEstimate?: ContextUsage): string {
    const thread = asRecord(readResult.thread);
    const account = asRecord(accountResult.account);
    const status = objectValue(thread.status) ?? this.latestThreadStatus;
    const tokenUsage = objectValue(thread.tokenUsage) ?? this.latestTokenUsage;
    const rateLimits = statusRateLimits(rateLimitResult, this.latestRateLimits);
    const statusType = String(status.type ?? this.latestThreadStatus.type ?? 'unknown');
    const activeFlags = Array.isArray(status.activeFlags) && status.activeFlags.length
      ? ` (${status.activeFlags.map(flagLabel).join(', ')})`
      : '';
    const session = this.providerSessionId || String(thread.sessionId ?? account.sessionId ?? (this.threadId || 'unknown'));
    const context = contextLine(tokenUsage, contextEstimate);
    const lines = [
      '**Status**',
      '',
      `Session: ${session}`,
      `Context: ${context || 'unknown'}`,
      `Runtime: ${statusType}${activeFlags}`,
      `Model: ${this.threadModel || String(thread.model ?? 'unknown')}`,
      `CWD: ${this.threadCwd || String(thread.cwd ?? 'unknown')}`,
    ];
    const limitLines = rateLimitLines(rateLimits);
    if (limitLines.length) lines.push('', ...limitLines);
    else if (rateLimitResult.rateLimitError) lines.push('', `Limits: unavailable (${rateLimitResult.rateLimitError})`);
    if (accountResult.accountError) lines.push('', `Account: unavailable (${accountResult.accountError})`);
    if (readResult.readError) lines.push(`- Thread read: ${readResult.readError}`);
    return lines.join('\n');
  }
}

function codexReviewTarget(args: string): Record<string, string> {
  const instructions = args.trim();
  if (instructions) return { type: 'custom', instructions };
  return { type: 'uncommittedChanges' };
}

function slashCommandFallback(command?: RuntimeSlashCommand): string {
  if (!command) return '';
  if (command.name === '/compact') return 'Compacted Codex thread context.';
  if (command.name === '/status') return 'Codex status is ready.';
  if (command.name === '/review') return 'Codex review completed without a text response.';
  if (command.kind === 'skill') return `${command.name} completed without a text response.`;
  return `${command.name} completed.`;
}

function flagLabel(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    const rec = value as Record<string, unknown>;
    return String(rec.type ?? rec.name ?? JSON.stringify(rec));
  }
  return String(value);
}

function tokenUsageLine(tokenUsage: Record<string, unknown> | undefined): string {
  if (!tokenUsage) return '';
  const total = asRecord(tokenUsage.total);
  const last = asRecord(tokenUsage.last);
  const contextWindow = tokenUsage.modelContextWindow;
  const totalTokens = tokenCount(total);
  const lastTokens = tokenCount(last);
  const parts: string[] = [];
  if (totalTokens !== undefined) parts.push(`${totalTokens.toLocaleString()} total`);
  if (lastTokens !== undefined) parts.push(`${lastTokens.toLocaleString()} last turn`);
  if (typeof contextWindow === 'number') parts.push(`${contextWindow.toLocaleString()} context window`);
  return parts.join(', ');
}

function contextLine(tokenUsage: Record<string, unknown> | undefined, estimate?: ContextUsage): string {
  if (!tokenUsage) return estimate ? contextUsageLine(estimate) : '';
  const total = tokenCount(objectValue(tokenUsage.total));
  const window = tokenUsage.modelContextWindow;
  if (typeof total !== 'number' || typeof window !== 'number' || window <= 0) {
    return tokenUsageLine(tokenUsage) || (estimate ? contextUsageLine(estimate) : '');
  }
  return contextUsageLine({ totalTokens: total, modelContextWindow: window });
}

function contextUsageLine(usage: ContextUsage): string {
  const total = usage.totalTokens;
  const window = usage.modelContextWindow;
  const usedPercent = Math.min(100, Math.round((total / window) * 100));
  const leftPercent = Math.max(0, 100 - usedPercent);
  return `${usedPercent}% used, ${leftPercent}% left (${total.toLocaleString()} used / ${compactNumber(window)})${usage.estimated ? ' estimated' : ''}`;
}

function statusRateLimits(readResult: Record<string, unknown>, cached: Record<string, unknown> | undefined): Record<string, unknown>[] {
  const byId = objectValue(readResult.rateLimitsByLimitId);
  if (byId) return Object.values(byId).filter(isRecord);
  const primary = objectValue(readResult.rateLimits);
  if (primary) return [primary];
  return cached ? [cached] : [];
}

function rateLimitLines(rateLimits: Record<string, unknown>[]): string[] {
  return rateLimits.flatMap((snapshot) => {
    const labelBase = String(snapshot.limitName ?? snapshot.limitId ?? 'usage');
    const primary = rateWindowLine('5h limit', objectValue(snapshot.primary));
    const secondary = rateWindowLine('7d limit', objectValue(snapshot.secondary));
    const lines = [primary, secondary].filter(Boolean) as string[];
    if (!lines.length) return [];
    return labelBase === 'usage' || labelBase === 'codex' ? lines : [`${labelBase}:`, ...lines.map(line => `  ${line}`)];
  });
}

function rateWindowLine(label: string, window: Record<string, unknown> | undefined): string {
  if (!window) return '';
  const usedPercent = numberValue(window.usedPercent);
  const leftPercent = usedPercent === undefined ? undefined : Math.max(0, 100 - usedPercent);
  const reset = resetText(numberValue(window.resetsAt));
  const duration = numberValue(window.windowDurationMins);
  const finalLabel = duration ? `${Math.round(duration / 60) || duration}h limit` : label;
  return `${finalLabel}: ${leftPercent ?? '?'}% left${reset ? ` (resets ${reset})` : ''}`;
}

function resetText(epochSeconds: number | undefined): string {
  if (!epochSeconds) return '';
  const ms = epochSeconds > 10_000_000_000 ? epochSeconds : epochSeconds * 1000;
  const diff = ms - Date.now();
  if (diff <= 0) return 'soon';
  const minutes = Math.round(diff / 60_000);
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (hours < 24) return `${hours}:${String(mins).padStart(2, '0')}`;
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return `${days}d ${remHours}h`;
}

function compactNumber(value: number): string {
  if (value >= 1_000_000) return `${Math.round(value / 100_000) / 10}M`;
  if (value >= 1_000) return `${Math.round(value / 1000)}K`;
  return value.toLocaleString();
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function estimateTokens(text: string): number {
  const clean = text.trim();
  if (!clean) return 0;
  const wordish = clean.match(/[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu)?.length ?? 0;
  return Math.max(1, Math.ceil(Math.max(clean.length / 4, wordish * 0.75)));
}

function collectText(value: unknown, depth = 0): string {
  if (depth > 8 || value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return '';
  if (Array.isArray(value)) return value.map(item => collectText(item, depth + 1)).filter(Boolean).join('\n');
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const direct = ['text', 'content', 'message', 'summary', 'command', 'aggregatedOutput']
      .map(key => collectText(record[key], depth + 1))
      .filter(Boolean);
    if (direct.length) return direct.join('\n');
    return Object.entries(record)
      .filter(([key]) => !/^(id|type|status|createdAt|updatedAt|startedAt|completedAt|durationMs)$/i.test(key))
      .map(([, item]) => collectText(item, depth + 1))
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

function contextWindowForModel(model: string): number {
  const normalized = model.toLowerCase();
  if (normalized.includes('gpt-5.5') || normalized.includes('gpt-5.4') || normalized.includes('gpt-5.3') || normalized.includes('gpt-5.2')) return 258_000;
  return 258_000;
}

function tokenCount(value: Record<string, unknown> | undefined): number | undefined {
  if (!value) return undefined;
  const direct = value.totalTokens ?? value.total_tokens ?? value.tokens;
  if (typeof direct === 'number') return direct;
  const input = value.inputTokens ?? value.input_tokens;
  const output = value.outputTokens ?? value.output_tokens;
  if (typeof input === 'number' || typeof output === 'number') return (typeof input === 'number' ? input : 0) + (typeof output === 'number' ? output : 0);
  let sum = 0;
  for (const item of Object.values(value)) {
    if (typeof item === 'number') sum += item;
  }
  return sum > 0 ? sum : undefined;
}

export function normalizeCodexRuntimeUsage(value: unknown): TokenUsageInfo | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const turn = objectValue(record.last) ?? record;
  return normalizeCodexUsage({
    input_tokens: turn.input_tokens ?? turn.inputTokens,
    output_tokens: turn.output_tokens ?? turn.outputTokens,
    cached_input_tokens: turn.cached_input_tokens ?? turn.cachedInputTokens,
  });
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(objectValue(value));
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function isReasoningItemType(type: string): boolean {
  return type === 'reasoning' || type === 'agentReasoning' || type === 'agent_reasoning';
}

function isAgentMessageItemType(type: string): boolean {
  return type === 'agentMessage' || type === 'agent_message';
}

function agentMessageText(item: Record<string, unknown>): string {
  const direct = item.text ?? item.message;
  if (typeof direct === 'string') return direct;
  const content = item.content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === 'string') return part;
      if (part && typeof part === 'object') {
        const rec = part as Record<string, unknown>;
        return String(rec.text ?? rec.content ?? rec.message ?? '');
      }
      return '';
    }).join('');
  }
  return '';
}

function reasoningPartText(params: Record<string, unknown>): string {
  const part = params.part ?? params.summaryPart ?? params.delta;
  if (typeof part === 'string') return part;
  if (part && typeof part === 'object') {
    const rec = part as Record<string, unknown>;
    return String(rec.text ?? rec.summary ?? rec.content ?? '');
  }
  return '';
}

function reasoningItemText(item: Record<string, unknown>): string {
  const direct = item.text ?? item.summary ?? item.content;
  if (typeof direct === 'string') return direct;
  const parts = item.summaryParts ?? item.summary ?? item.parts ?? item.content;
  if (Array.isArray(parts)) {
    return parts.map((part) => {
      if (typeof part === 'string') return part;
      if (part && typeof part === 'object') {
        const rec = part as Record<string, unknown>;
        return String(rec.text ?? rec.summary ?? rec.content ?? '');
      }
      return '';
    }).join('');
  }
  return '';
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

function codexReasoningSummary(): string {
  const value = process.env.CODEX_REASONING_SUMMARY;
  if (value === 'none' || value === 'concise' || value === 'detailed' || value === 'auto') return value;
  return 'auto';
}

function codexConfig(input: RuntimeTurnInput): Record<string, unknown> {
  const args = input.resolvedSettings ? toCodexArgs(input.resolvedSettings) : [];
  const config: Record<string, unknown> = {
    model: input.model,
    ...(codexEffort(input) ? { model_reasoning_effort: codexEffort(input) } : {}),
    model_reasoning_summary: codexReasoningSummary(),
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
