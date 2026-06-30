import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { normalizeClaudeUsage, normalizeModelAlias, type TokenUsageInfo } from '@allen/engine';
import { AGENT_FALLBACK_CWD, buildClaudeCompatibleEnvOverlay, isClaudeCompatibleProvider, type ChatProvider } from './chat-providers.js';
import { toClaudeSdkOptions } from './agent-settings.js';
import { buildControlledMcpConfig, writeClaudeMcpConfigFile } from './chat-controlled-mcp.js';
import { logRuntimeEvent } from './chat-runtime-logs.js';
import { resolveClaudeCodeExecutable } from './claude-code-executable.js';
import { applyClaudeChatNativeToolPolicyToArgs } from './claude-chat-tool-policy.js';
import type { ChatTraceEvent } from './chat-llm.js';
import type { PersistentChatRuntime, RuntimeCreateInput, RuntimeSlashCommand, RuntimeTurnInput, RuntimeTurnResult } from './chat-runtime-types.js';

type PendingTool = {
  tool: string;
  args: Record<string, unknown>;
  startMs: number;
};

type ActiveTurn = {
  input: RuntimeTurnInput;
  text: string;
  thinking: string;
  costUsd: number;
  tokenUsage: TokenUsageInfo | null;
  trace: ChatTraceEvent[];
  pendingTools: Map<string, PendingTool>;
  resolve: (result: RuntimeTurnResult) => void;
  reject: (error: Error) => void;
};

export class ClaudePersistentRuntime implements PersistentChatRuntime {
  readonly id = `claude-${randomUUID()}`;
  readonly provider: ChatProvider;
  readonly key: string;

  private proc?: ChildProcessWithoutNullStreams;
  private stdoutBuffer = '';
  private stderrBuffer = '';
  private currentTurn?: ActiveTurn;
  private sessionId = '';
  private initialized?: Promise<void>;
  private closed = false;
  /** True between sending a steer interrupt and swallowing the aborted turn's
   *  terminal `error_during_execution` result, so the steered continuation
   *  streams into the same logical turn instead of orphaning. */
  private steerPending = false;

  constructor(private readonly createInput: RuntimeCreateInput) {
    this.key = createInput.key;
    this.provider = createInput.provider;
  }

  async sendTurn(input: RuntimeTurnInput): Promise<RuntimeTurnResult> {
    return this.sendUserText(input, claudePrompt(input), 'turn_send');
  }

  async sendSlashCommand(input: RuntimeTurnInput, command: RuntimeSlashCommand): Promise<RuntimeTurnResult> {
    return this.sendUserText(input, command.raw, 'slash_command_send', command);
  }

  private async sendUserText(
    input: RuntimeTurnInput,
    text: string,
    event: 'turn_send' | 'slash_command_send',
    command?: RuntimeSlashCommand,
  ): Promise<RuntimeTurnResult> {
    if (this.currentTurn) throw new Error('Claude runtime already has an active turn');
    await this.ensureStarted(input);

    const trace: ChatTraceEvent[] = [];
    const completion = new Promise<RuntimeTurnResult>((resolve, reject) => {
      this.currentTurn = {
        input,
        text: '',
        thinking: '',
        costUsd: 0,
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
      event,
      data: {
        providerSessionId: this.sessionId,
        promptPreview: text.slice(0, 300),
        ...(command ? { command } : {}),
      },
    });

    this.proc?.stdin.write(JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'text', text }],
      },
    }) + '\n');

    return completion;
  }

  /** Inject a user message into the active turn mid-stream.
   *  Returns `true` if accepted, `false` if no active turn or stdin unavailable. */
  steer(text: string): boolean {
    if (!this.currentTurn) {
      logRuntimeEvent({
        db: this.createInput.db,
        sessionId: this.createInput.chatSessionId,
        provider: this.provider,
        runtimeId: this.id,
        eventType: 'lifecycle',
        event: 'runtime_steer_declined',
        data: { reason: 'no_current_turn', providerSessionId: this.sessionId },
      });
      return false;
    }
    if (!this.proc?.stdin) {
      logRuntimeEvent({
        db: this.createInput.db,
        sessionId: this.createInput.chatSessionId,
        provider: this.provider,
        runtimeId: this.id,
        eventType: 'lifecycle',
        event: 'runtime_steer_declined',
        data: { reason: 'no_stdin', providerSessionId: this.sessionId },
      });
      return false;
    }
    try {
      // `claude -p` does not read a new stdin user message mid-turn — it finishes
      // the active turn first, so a plain user-message write does NOT steer (it
      // runs as a separate follow-up turn whose output Allen would drop). To steer
      // mid-stream we must first interrupt the running turn via a control_request
      // (which the CLI reads asynchronously), then send the new user message as the
      // continuation. The interrupt's terminal `result: error_during_execution` is
      // swallowed in handleClaudeEvent so the steered turn streams into the same turn.
      this.steerPending = true;
      this.proc.stdin.write(JSON.stringify({
        type: 'control_request',
        request_id: randomUUID(),
        request: { subtype: 'interrupt' },
      }) + '\n');
      this.proc.stdin.write(JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'text', text }],
        },
      }) + '\n');

      logRuntimeEvent({
        db: this.createInput.db,
        sessionId: this.createInput.chatSessionId,
        provider: this.provider,
        runtimeId: this.id,
        eventType: 'lifecycle',
        event: 'runtime_steer',
        data: { providerSessionId: this.sessionId, textPreview: text.slice(0, 300) },
      });

      return true;
    } catch (err) {
      this.steerPending = false;
      logRuntimeEvent({
        db: this.createInput.db,
        sessionId: this.createInput.chatSessionId,
        provider: this.provider,
        runtimeId: this.id,
        eventType: 'lifecycle',
        event: 'runtime_steer_failed',
        data: { providerSessionId: this.sessionId, error: (err as Error).message },
      });
      return false;
    }
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
      data: { reason, providerSessionId: this.sessionId },
    });
    this.currentTurn?.reject(new Error(`Claude runtime closed: ${reason}`));
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

    const args = [
      '-p',
      '--verbose',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--include-partial-messages',
      '--permission-mode', claudePermissionMode(input),
    ];
    if (claudeSupportsHookEvents()) args.push('--include-hook-events');
    applyClaudeChatNativeToolPolicyToArgs(args);

    const model = normalizeModelAlias(input.model) ?? input.model;
    if (model && model !== 'default') args.push('--model', model);
    if (input.resumeSessionId) args.push('--resume', input.resumeSessionId);
    else if (input.systemPrompt) {
      args.push(claudeSupportsSystemPrompt() ? '--system-prompt' : '--append-system-prompt', input.systemPrompt);
    }
    if (Object.keys(mcp.servers).length > 0) {
      args.push('--mcp-config', writeClaudeMcpConfigFile(this.id, mcp.servers), '--strict-mcp-config');
    }

    const env: NodeJS.ProcessEnv = { ...process.env };
    if (isClaudeCompatibleProvider(input.provider)) {
      Object.assign(env, await buildClaudeCompatibleEnvOverlay(input.provider, input.model, input.db));
    }
    if (input.chatSessionId) env.ALLEN_CHAT_SESSION_ID = input.chatSessionId;

    this.proc = spawn(resolveClaudeBin(), args, {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.proc.stdout.on('data', (chunk: Buffer) => this.handleStdout(chunk));
    this.proc.stderr.on('data', (chunk: Buffer) => { this.stderrBuffer += chunk.toString(); });
    this.proc.on('close', (code) => {
      const stderrTail = this.stderrBuffer.slice(-2000);
      logRuntimeEvent({
        db: input.db,
        sessionId: input.chatSessionId,
        provider: this.provider,
        runtimeId: this.id,
        eventType: 'lifecycle',
        event: 'process_closed',
        data: { code, stderr: stderrTail },
      });
      this.closed = true;
      const detail = stderrTail.trim() ? `: ${stderrTail.trim().slice(-500)}` : '';
      this.currentTurn?.reject(new Error(`Claude CLI exited with code ${code}${detail}`));
      this.currentTurn = undefined;
    });
    this.proc.on('error', (err) => {
      this.closed = true;
      this.currentTurn?.reject(err);
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
        this.handleClaudeEvent(msg);
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

  private handleClaudeEvent(msg: Record<string, unknown>): void {
    const input = this.currentTurn?.input ?? this.createInput;
    logRuntimeEvent({
      db: input.db,
      sessionId: input.chatSessionId,
      provider: this.provider,
      runtimeId: this.id,
      eventType: 'raw_provider',
      event: 'stream_json',
      data: msg,
    });

    const sessionId = typeof msg.session_id === 'string' ? msg.session_id : undefined;
    if (sessionId && !this.sessionId) {
      this.sessionId = sessionId;
      const turn = this.currentTurn;
      turn?.trace.push({ timestamp: new Date(), type: 'session_start', text: sessionId });
      turn?.input.callbacks.onSessionId?.(sessionId);
    }

    const turn = this.currentTurn;
    if (!turn) return;

    if (msg.type === 'stream_event') {
      this.handleStreamEvent(turn, (msg.event ?? {}) as Record<string, unknown>);
      return;
    }

    if (msg.type === 'assistant') {
      const message = msg.message as { content?: Array<Record<string, unknown>> } | undefined;
      this.handleAssistantBlocks(turn, message?.content ?? []);
      return;
    }

    if (msg.type === 'user') {
      const message = msg.message as { content?: Array<Record<string, unknown>> } | undefined;
      this.handleUserBlocks(turn, message?.content ?? []);
      return;
    }

    if (msg.type === 'result') {
      // A steer interrupt produces a terminal `error_during_execution` result for
      // the aborted turn. Swallow it once and keep the turn open + reset its
      // accumulators so the steered continuation streams into the same assistant
      // message rather than resolving (and orphaning) the turn.
      if (this.steerPending && msg.subtype === 'error_during_execution') {
        this.steerPending = false;
        turn.text = '';
        turn.thinking = '';
        turn.pendingTools.clear();
        turn.input.callbacks.onText('');
        return;
      }
      this.steerPending = false;
      const resultText = typeof msg.result === 'string' ? msg.result : turn.text;
      if (resultText && resultText !== turn.text) {
        turn.text = resultText;
        turn.input.callbacks.onText(turn.text);
      }
      turn.costUsd = typeof msg.total_cost_usd === 'number' ? msg.total_cost_usd : 0;
      turn.tokenUsage = normalizeClaudeUsage(msg.usage as Record<string, unknown> | undefined | null);
      if (sessionId) this.sessionId = sessionId;
      const done = this.currentTurn;
      this.currentTurn = undefined;
      done?.trace.push({ timestamp: new Date(), type: 'complete', text: 'result' });
      done?.resolve({
        text: done.text,
        costUsd: done.costUsd,
        sessionId: this.sessionId,
        trace: done.trace,
        tokenUsage: done.tokenUsage,
      });
    }
  }

  private handleStreamEvent(turn: ActiveTurn, event: Record<string, unknown>): void {
    if (event.type === 'content_block_delta') {
      const delta = (event.delta ?? {}) as Record<string, unknown>;
      if (delta.type === 'text_delta') {
        turn.text += String(delta.text ?? '');
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
      } else if (String(delta.type ?? '').includes('thinking')) {
        turn.thinking += String(delta.thinking ?? delta.text ?? '');
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
    }

    if (event.type === 'content_block_start') {
      const block = (event.content_block ?? {}) as Record<string, unknown>;
      if (block.type === 'tool_use') this.handleToolUse(turn, block);
    }
  }

  private handleAssistantBlocks(turn: ActiveTurn, blocks: Array<Record<string, unknown>>): void {
    const text = blocks.filter((b) => b.type === 'text').map((b) => String(b.text ?? '')).join('');
    if (text && text !== turn.text) {
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
    const thinking = blocks.filter((b) => b.type === 'thinking').map((b) => String(b.thinking ?? b.text ?? '')).join('');
    if (thinking) {
      turn.thinking = thinking;
      turn.trace.push({ timestamp: new Date(), type: 'thinking', text: thinking });
      logRuntimeEvent({
        db: turn.input.db,
        sessionId: turn.input.chatSessionId,
        provider: this.provider,
        runtimeId: this.id,
        eventType: 'normalized',
        event: 'thinking',
        data: { text: thinking },
      });
      turn.input.callbacks.onThinking?.(thinking);
    }
    for (const block of blocks) {
      if (block.type === 'tool_use') this.handleToolUse(turn, block);
    }
  }

  private handleToolUse(turn: ActiveTurn, block: Record<string, unknown>): void {
    const id = String(block.id ?? '');
    const tool = String(block.name ?? '');
    if (!id || !tool || turn.pendingTools.has(id)) return;
    const args = block.input && typeof block.input === 'object' && !Array.isArray(block.input)
      ? block.input as Record<string, unknown>
      : {};
    turn.pendingTools.set(id, { tool, args, startMs: Date.now() });
    turn.trace.push({ timestamp: new Date(), type: 'tool_call', tool, toolUseId: id, args });
    logRuntimeEvent({
      db: turn.input.db,
      sessionId: turn.input.chatSessionId,
      provider: this.provider,
      runtimeId: this.id,
      eventType: 'normalized',
      event: 'tool_start',
      data: { tool, args, toolUseId: id },
    });
    turn.input.callbacks.onToolStart(tool, args, id);
  }

  private handleUserBlocks(turn: ActiveTurn, blocks: Array<Record<string, unknown>>): void {
    for (const block of blocks) {
      if (block.type !== 'tool_result') continue;
      const id = String(block.tool_use_id ?? '');
      const pending = turn.pendingTools.get(id);
      if (!pending) continue;
      const durationMs = Date.now() - pending.startMs;
      const result = parseToolResult(block.content);
      turn.trace.push({ timestamp: new Date(), type: 'tool_result', tool: pending.tool, toolUseId: id, result, durationMs });
      logRuntimeEvent({
        db: turn.input.db,
        sessionId: turn.input.chatSessionId,
        provider: this.provider,
        runtimeId: this.id,
        eventType: 'normalized',
        event: 'tool_result',
        data: { tool: pending.tool, result, toolUseId: id, durationMs },
      });
      turn.input.callbacks.onToolResult(pending.tool, result, id, durationMs);
      turn.pendingTools.delete(id);
    }
  }
}

function claudePrompt(input: RuntimeTurnInput): string {
  let prompt = input.messages.at(-1)?.content ?? '';
  if (input.resolvedSettings) {
    const fragment = toClaudeSdkOptions(input.resolvedSettings);
    if (fragment.promptPrefix) prompt = `${fragment.promptPrefix}\n\n${prompt}`;
  }
  return prompt;
}

function claudePermissionMode(input: RuntimeTurnInput): string {
  if (input.resolvedSettings) {
    const fragment = toClaudeSdkOptions(input.resolvedSettings);
    if (fragment.permissionMode === 'plan') return 'plan';
  }
  return 'bypassPermissions';
}

function parseToolResult(content: unknown): Record<string, unknown> {
  let raw = '';
  if (Array.isArray(content)) {
    raw = content.map((item) => {
      if (item && typeof item === 'object' && 'text' in item) return String((item as { text?: unknown }).text ?? '');
      return String(item ?? '');
    }).join('');
  } else if (typeof content === 'string') {
    raw = content;
  } else {
    raw = JSON.stringify(content ?? {});
  }
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return { raw };
  }
}

let hookEventsSupported: boolean | undefined;
function claudeSupportsHookEvents(): boolean {
  hookEventsSupported ??= claudeHelpText().includes('--include-hook-events');
  return hookEventsSupported;
}

let systemPromptSupported: boolean | undefined;
function claudeSupportsSystemPrompt(): boolean {
  systemPromptSupported ??= claudeHelpText().includes('--system-prompt');
  return systemPromptSupported;
}

let claudeHelp: string | undefined;
function claudeHelpText(): string {
  claudeHelp ??= (() => {
    const result = spawnSync(resolveClaudeBin(), ['--help'], { encoding: 'utf8' });
    return `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  })();
  return claudeHelp;
}

let claudeBinCache: string | undefined;
function resolveClaudeBin(): string {
  if (claudeBinCache) return claudeBinCache;
  const override = process.env.CLAUDE_BIN?.trim();
  if (override) {
    claudeBinCache = override;
    return claudeBinCache;
  }
  const resolved = resolveClaudeCodeExecutable();
  if (resolved) {
    claudeBinCache = resolved;
    return claudeBinCache;
  }
  const r = spawnSync('which', ['-a', 'claude'], { encoding: 'utf8' });
  const candidate = (r.stdout ?? '')
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .find((p) => !p.includes('/node_modules/.bin/'));
  claudeBinCache = candidate ?? 'claude';
  return claudeBinCache;
}
