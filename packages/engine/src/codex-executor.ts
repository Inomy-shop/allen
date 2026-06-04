import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import type { NodeDef, AgentDef, EngineEventEmitter } from './types.js';
import { normalizeCodexUsage, aggregateTokenUsage, type TokenUsageInfo } from './token-usage.js';
import { renderTemplate } from './template.js';
import { extractOutputs, buildOutputInstruction } from './output-extractor.js';
import { buildToolCallRecord, type ToolCallRecord } from './tool-call.js';
import { hasRepoContextLoadingGuidance, withArtifactsGuidance, withMandatoryRepoContext, withNonInteractiveGuidance, withRepoContextLoadingGuidance } from './agent-file-writer.js';
import { MCP_SERVER_NAME } from './brand.js';
import { renderClarificationResumePrompt, renderHumanResumePrompt, renderResumeContextPrompt, renderReviewFeedbackRetryPrompt } from './human-intervention.js';

/** Scratch dir when no worktree/repo is in scope. Never fall back to
 * process.cwd() — that's the engine's own source tree. */
const AGENT_FALLBACK_CWD = '/tmp/allen';

interface CodexResult {
  outputs: Record<string, unknown>;
  rawResponse: string;
  /**
   * The prompt actually sent to codex for this attempt — minimal feedback
   * resume, upstream-re-ran forward prompt, or full template depending on
   * the resolved promptShape. Surfaced so the engine can persist the truth
   * on the trace's renderedPrompt instead of re-rendering the template
   * (which always produces the full first-run prompt regardless of attempt).
   */
  prompt: string;
  sessionId?: string;
  cost: {
    actual: number | null;
    estimated: number;
    model: string;
    turns: number;
    method: 'sdk_reported' | 'estimated';
  };
  tokenUsage?: TokenUsageInfo | null;
  durationMs: number;
  toolCalls?: ToolCallRecord[];
  runtimeContext?: {
    cwd?: string;
    executionMode?: 'cli';
    systemPromptMode?: 'prompt-prefix';
    repoContextLoadingGuidancePresent?: boolean;
    repoContextLoadingGuidanceInjected?: boolean;
    mandatoryRepoContextInjected?: boolean;
    mandatoryRepoContextInjectedCount?: number;
    mandatoryRepoContextSkippedProviderNativeCount?: number;
    mandatoryRepoContextTargetLayer?: string;
    resolvedModel?: string;
    reasoningEffort?: string;
    planMode?: boolean;
    mcpServerNames?: string[];
    envKeys?: string[];
  };
}

interface PendingCodexTool {
  tool: string;
  args: Record<string, unknown>;
  startedAt: Date;
  startMs: number;
}

/**
 * Execute an agent node using OpenAI Codex CLI (`codex exec --json`).
 * Spawns codex as a subprocess and parses JSONL output.
 */
export async function executeCodexNode(
  nodeName: string,
  nodeDef: NodeDef,
  state: Record<string, unknown>,
  role: AgentDef | undefined,
  emitter: EngineEventEmitter,
  executionId: string,
  sessionId?: string,
  nodeContext?: string,
  feedbackContext?: string,
  abortSignal?: AbortSignal,
  repoKnowledgeContext?: {
    packetId: string;
    repoId: string;
    repoName?: string;
    indexId?: string;
    indexFreshness?: 'fresh' | 'stale' | 'partial' | 'missing';
    systemPromptBlock?: string;
    mandatoryContextInjectedCount?: number;
    mandatoryContextSkippedProviderNativeCount?: number;
    mandatoryContextTargetLayer?: string;
  },
): Promise<CodexResult> {
  const start = Date.now();
  // Apply per-node overrides first, then agent defaults.
  const override = nodeDef.agentOverrides ?? {};
  const model = (override.model ?? role?.model) ?? 'default';
  const reasoningEffort = (override.reasoningEffort ?? role?.reasoningEffort) ?? undefined;
  // Codex doesn't support 'max' — clamp to 'high'. 'off' means "don't emit".
  const codexEffort =
    reasoningEffort && reasoningEffort !== 'off'
      ? reasoningEffort === 'max'
        ? 'high'
        : reasoningEffort
      : undefined;
  // Resume by default unless explicitly disabled on the node
  const isResume = !!((nodeDef.resume_on_retry !== false) && sessionId);

  // Retry plumbing — the engine writes __retry_target before re-running this
  // node as the target of a retry edge, and consumes it after the run
  // (engine.ts:1232-1236). When this node is the retry target AND the codex
  // session is being resumed, the agent's thread already carries the original
  // task; we only need to hand back the gate feedback. When we're NOT the
  // retry target but the session is being resumed anyway (forward-path
  // re-entry after an upstream re-run), the agent's prior outputs are stale
  // and we need to dump the current state so it doesn't return cached
  // answers. Mirrors executeAgentNode in node-executor.ts:360-512 so codex
  // and claude code paths behave identically with respect to retry feedback.
  const retryTargets = state.__retry_target as string[] | undefined;
  const isRetryTarget = Array.isArray(retryTargets) && retryTargets.includes(nodeName);
  const repoContextLoadingGuidanceAlreadyPresent = hasRepoContextLoadingGuidance(role?.system);
  let repoContextLoadingGuidancePresent = false;
  let repoContextLoadingGuidanceInjected = false;

  const promptShape: 'retry' | 'forward' | 'full' =
    isResume && isRetryTarget ? 'retry'
    : isResume                 ? 'forward'
                               : 'full';

  // Log forward-path re-entries so operators can correlate the upstream
  // retry with this node's re-invocation. Mirrors node-executor.ts:375-381.
  if (promptShape === 'forward') {
    emitter.emit({
      event: 'execution_log',
      data: {
        executionId,
        timestamp: new Date(),
        level: 'debug',
        category: 'system',
        node: nodeName,
        message: `[session] forward-path re-entry — resuming session ${sessionId!.slice(0, 8)} with upstream-re-ran prompt`,
      },
    });
  }

  // Helpers for the 'forward' shape — dump current top-level state so the
  // resumed agent doesn't operate on stale session memory.
  const formatStateValue = (v: unknown): string => {
    if (v === null) return 'null';
    if (v === undefined) return 'undefined';
    if (typeof v === 'string') return v.length > 800 ? v.slice(0, 800) + ` ... (${v.length - 800} chars truncated)` : v;
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    let json: string;
    try { json = JSON.stringify(v, null, 2); }
    catch { json = String(v); }
    return json.length > 800 ? json.slice(0, 800) + ` ... (${json.length - 800} chars truncated)` : json;
  };
  const renderCurrentState = (): string => {
    const lines: string[] = [];
    for (const [k, v] of Object.entries(state)) {
      if (k.startsWith('__')) continue;
      if (k === 'retry_context' || k === 'retry_count') continue;
      lines.push(`${k}: ${formatStateValue(v)}`);
    }
    return lines.length > 0 ? lines.join('\n') : '(no top-level state fields)';
  };

  let prompt: string;
  if (promptShape === 'retry') {
    const clarificationContext = renderClarificationResumePrompt(state.resume_context)
      || renderClarificationResumePrompt(state.human_input);
    if (clarificationContext) {
      prompt = clarificationContext;
    } else {
      prompt = renderReviewFeedbackRetryPrompt({
        resumeContext: state.resume_context,
        humanInput: state.human_input,
        retryContext: state.retry_context,
      });
    }
  } else if (promptShape === 'forward') {
    const resumeContext = renderResumeContextPrompt(state.resume_context);
    const humanContext = renderHumanResumePrompt(state.human_input);
    const focusedContext = resumeContext || humanContext;
    if (focusedContext) {
      prompt = `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
HUMAN INPUT — RESUME WORKFLOW
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Your role, task, tools, and output schema are UNCHANGED. A human responded
to a workflow pause. Continue using only the focused human input below and
the relevant artifacts/outputs already available to this node.

${focusedContext}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
    } else {
    // Forward-path re-entry after an upstream re-ran. Agent's role and task
    // are unchanged but its prior outputs are stale; dump the current state.
    prompt = `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
UPSTREAM RE-RUN — INPUTS CHANGED
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
An upstream node in this workflow re-ran since your last turn and
produced different outputs. The workflow inputs you operated on
previously are now stale — do not trust anything in your prior turns'
analysis, tool outputs, or returned JSON.

Your role, task, tools, and output schema are UNCHANGED. Your job is to
re-execute your original task against the CURRENT inputs shown below and
emit a fresh JSON output block.

Compare each field against what you remember from your prior turn. Where
they differ, your earlier work on that field is invalid. Where they
match, your earlier analysis may still apply — but verify, don't assume.

Do NOT copy your prior JSON output verbatim. Produce values that reflect
the current inputs, even if they happen to match your prior values.

━━━ CURRENT WORKFLOW STATE ━━━
${renderCurrentState()}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
    }
  } else {
    // Full prompt — fresh run (first attempt) or resume disabled.
    prompt = nodeDef.prompt ? renderTemplate(nodeDef.prompt, state) : '';
    if (!isResume) {
      // Only prepend system prompt on first run — resume already has context.
      // Repo-context, artifact, and non-interactive guidance are layered idempotently.
      let systemPrefix = withArtifactsGuidance(role?.system);
      if (repoKnowledgeContext) {
        systemPrefix = withRepoContextLoadingGuidance(systemPrefix);
        systemPrefix = withMandatoryRepoContext(systemPrefix, repoKnowledgeContext.systemPromptBlock);
      }
      systemPrefix = withNonInteractiveGuidance(systemPrefix);
      repoContextLoadingGuidancePresent = hasRepoContextLoadingGuidance(systemPrefix);
      repoContextLoadingGuidanceInjected =
        !repoContextLoadingGuidanceAlreadyPresent && repoContextLoadingGuidancePresent;
      prompt = `${systemPrefix}\n\n${prompt}`;
    }
    prompt += buildOutputInstruction(nodeDef.outputs, nodeDef.output_format);
    if (nodeContext) {
      prompt += nodeContext;
    }
    // Retry without session resume (resume_on_retry: false, or the session
    // didn't persist) — can't rely on prior turns, so append the feedback
    // block after the full re-rendered prompt.
    if (isRetryTarget) {
      const source = (state.__retry_source as string) ?? 'previous step';
      const clarificationContext = renderClarificationResumePrompt(state.resume_context)
        || renderClarificationResumePrompt(state.human_input);
      const resumeContext = clarificationContext ? '' : renderResumeContextPrompt(state.resume_context);
      const humanContext = clarificationContext || resumeContext ? '' : renderHumanResumePrompt(state.human_input);
      const retryContext = (state.retry_context as string) ?? '';
      const context = clarificationContext || [resumeContext || humanContext, retryContext && retryContext !== humanContext && retryContext !== resumeContext ? retryContext : '']
          .filter((part) => part.trim().length > 0)
          .join('\n\n');
      const title = clarificationContext ? '' : 'RETRY FEEDBACK';
      const intro = clarificationContext
        ? ''
        : `You are being re-run because the previous output from ${source} produced a
result that failed a downstream gate. Address the feedback below in this
run. Do NOT redo work that is already correct — focus on the issues called
out here.`;
      prompt += clarificationContext ? `

${context}` : `

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${title}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${intro}

${context}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
    }
  }

  // Operator-supplied workflow feedback entries — separate from
  // state.retry_context (which is gate-feedback from a downstream review
  // node). feedbackContext is built by engine.ts:1146 from feedback entries
  // an operator added through the UI. Append AFTER the shape branching so
  // resumed retry / forward shapes also see it — mirrors node-executor.ts:514-516.
  if (feedbackContext) {
    prompt += feedbackContext;
  }

  // Real attempt counter — matches node-executor.ts:518-523. `retry_count`
  // is incremented by the engine before each retry; emitting +1 so the UI's
  // first-attempt display reads "1" rather than "0".
  const currentAttempt = (state.retry_count as number ?? 0) + 1;
  emitter.emit({
    event: 'node_started',
    data: {
      node: nodeName,
      agent: nodeDef.agent,
      attempt: currentAttempt,
      // Ship the actual prompt (retry/forward/full shape) so the UI's live
      // view shows the truth instead of falling back to a re-rendered
      // template. Mirrors node-executor.ts:518-528.
      renderedPrompt: prompt,
      inputState: { ...state },
    },
  });

  emitter.emit({
    event: 'execution_log',
    data: {
      executionId,
      timestamp: new Date(),
      level: 'info',
      category: 'system',
      node: nodeName,
      message: `Node started (provider: codex, model: ${model}${isResume ? ', resuming session ' + sessionId : ''})`,
    },
  });

  const cwd = (state.worktree_path as string) ?? (state.repo_path as string) ?? AGENT_FALLBACK_CWD;
  mkdirSync(cwd, { recursive: true });

  // Per-call MCP env overrides for the Allen MCP. Codex stores its MCP
  // entries with only the env vars passed at registration time and does
  // NOT forward its own runtime env to MCP children, so inheriting via
  // process.env is not enough. Without these `-c` overrides, the agent's
  // allen_save_artifact call returns "...artifact root is unknown..."
  // and no artifacts are created. Mirrors the chat-tools.ts spawn_agent
  // path (search: mcp_servers.${MCP_SERVER_NAME}.env).
  const escape = (v: string) => v.replace(/"/g, '\\"');
  const set = (k: string, v: string) =>
    ['-c', `mcp_servers.${MCP_SERVER_NAME}.env.${k}="${escape(v)}"`];
  const rootExecutionId = process.env.ALLEN_ROOT_EXECUTION_ID || executionId;
  const mcpEnvOverrides: string[] = [
    ...set('ALLEN_ARTIFACT_ROOT_TYPE', process.env.ALLEN_ARTIFACT_ROOT_TYPE || 'workflow'),
    ...set('ALLEN_ARTIFACT_ROOT_ID', process.env.ALLEN_ARTIFACT_ROOT_ID || rootExecutionId),
    ...set('ALLEN_ARTIFACT_NODE_NAME', nodeName),
    ...set('ALLEN_ARTIFACT_AGENT_NAME', nodeDef.agent ?? ''),
    ...set('ALLEN_ARTIFACT_AGENT_EXECUTION_ID', executionId),
    ...set('ALLEN_ARTIFACT_PARENT_ID', executionId),
    ...set('ALLEN_PARENT_EXECUTION_ID', executionId),
    ...set('ALLEN_PARENT_CALLER', nodeName),
    ...set('ALLEN_ROOT_EXECUTION_ID', rootExecutionId),
    ...(repoKnowledgeContext ? [
      ...set('ALLEN_REPO_KNOWLEDGE_PACKET_ID', repoKnowledgeContext.packetId),
      ...set('ALLEN_REPO_KNOWLEDGE_REPO_ID', repoKnowledgeContext.repoId),
      ...set('ALLEN_REPO_KNOWLEDGE_INDEX_ID', repoKnowledgeContext.indexId ?? ''),
      ...set('ALLEN_REPO_KNOWLEDGE_REPO_NAME', repoKnowledgeContext.repoName ?? ''),
      ...set('ALLEN_REPO_KNOWLEDGE_FRESHNESS', repoKnowledgeContext.indexFreshness ?? ''),
    ] : []),
    // Re-state the registration-time vars: in some Codex versions the -c
    // override replaces the env dict wholesale, so omitting these would
    // strip out ALLEN_API_URL / JWT_ACCESS_SECRET and break MCP auth.
    ...set('ALLEN_API_URL', `http://localhost:${process.env.PORT ?? '4023'}`),
    ...set('ALLEN_PUBLIC_URL', process.env.ALLEN_PUBLIC_URL ?? `http://localhost:${process.env.PORT ?? '4023'}`),
    ...set('JWT_ACCESS_SECRET', process.env.JWT_ACCESS_SECRET ?? ''),
  ];

  return new Promise<CodexResult>((resolve, reject) => {
    const args: string[] = ['exec'];

    if (isResume) {
      // Resume previous session
      args.push('resume', '--json', '--dangerously-bypass-approvals-and-sandbox');
      args.push(...mcpEnvOverrides);
      args.push(sessionId!, prompt);
    } else {
      // Fresh session — bypass approvals so MCP tools work
      args.push('--json', '--dangerously-bypass-approvals-and-sandbox');
      if (model && model !== 'default') {
        args.push('-c', `model="${model}"`);
      }
      if (codexEffort) {
        args.push('-c', `model_reasoning_effort="${codexEffort}"`);
      }
      args.push(...mcpEnvOverrides);
      args.push(prompt);
    }

    const proc = spawn('codex', args, {
      cwd,
      env: {
        ...process.env,
        ALLEN_PARENT_EXECUTION_ID: executionId,
        ALLEN_PARENT_CALLER: nodeName,
        ALLEN_ROOT_EXECUTION_ID: rootExecutionId,
        ...(repoKnowledgeContext ? {
          ALLEN_REPO_KNOWLEDGE_PACKET_ID: repoKnowledgeContext.packetId,
          ALLEN_REPO_KNOWLEDGE_REPO_ID: repoKnowledgeContext.repoId,
          ALLEN_REPO_KNOWLEDGE_INDEX_ID: repoKnowledgeContext.indexId ?? '',
          ALLEN_REPO_KNOWLEDGE_REPO_NAME: repoKnowledgeContext.repoName ?? '',
          ALLEN_REPO_KNOWLEDGE_FRESHNESS: repoKnowledgeContext.indexFreshness ?? '',
        } : {}),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Close stdin immediately so codex doesn't wait for input
    proc.stdin.end();

    // Kill process on abort signal (cancel)
    if (abortSignal) {
      if (abortSignal.aborted) { proc.kill('SIGTERM'); reject(new Error('Execution cancelled')); return; }
      abortSignal.addEventListener('abort', () => { try { proc.kill('SIGTERM'); } catch {} }, { once: true });
    }

    let rawResponse = '';
    let turns = 0;
    let threadId: string | undefined = isResume ? sessionId : undefined;
    const toolCalls: ToolCallRecord[] = [];
    const usageAccumulator: { value: TokenUsageInfo | null } = { value: null };
    const pendingTools = new Map<string, PendingCodexTool>();

    // Parse JSONL from stdout
    let lineBuffer = '';
    proc.stdout.on('data', (chunk: Buffer) => {
      lineBuffer += chunk.toString();
      const lines = lineBuffer.split('\n');
      lineBuffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          // Capture thread ID for session resume
          if (event.type === 'thread.started' && event.thread_id) {
            threadId = event.thread_id;
          }

          // Check for error events
          if (event.type === 'error' || event.type === 'turn.failed') {
            const errMsg = event.message ?? event.error?.message ?? JSON.stringify(event);
            // Codex emits transient self-recovery events (MCP child-process
            // reconnects) as `event.type === 'error'` even though it then
            // succeeds. Logging those at level=error makes the UI flag
            // healthy runs as failed and pollutes rawResponse with
            // ERROR: lines that confuse downstream JSON extraction.
            const isTransient = /Reconnecting|timeout waiting for child process/i.test(errMsg);
            emitter.emit({
              event: 'execution_log',
              data: {
                executionId,
                timestamp: new Date(),
                level: isTransient ? 'warn' : 'error',
                category: 'agent',
                node: nodeName,
                message: `${isTransient ? 'Codex transient' : 'Codex error'}: ${errMsg}`,
              },
            });
            if (!isTransient) {
              rawResponse += `ERROR: ${errMsg}\n`;
            }
          }

          handleCodexEvent(event, nodeName, emitter, executionId, (text) => {
            rawResponse += text;
          }, toolCalls, pendingTools, usageAccumulator);
          if (event.type === 'turn.completed') {
            turns++;
          }
        } catch {
          // Not JSON — treat as raw text
          rawResponse += line + '\n';
          emitter.emit({
            event: 'agent_text',
            data: { node: nodeName, text: line + '\n' },
          });
        }
      }
    });

    let stderrText = '';
    proc.stderr.on('data', (chunk: Buffer) => {
      stderrText += chunk.toString();
    });

    proc.on('close', async (code) => {


      // Process any remaining buffer
      if (lineBuffer.trim()) {
        rawResponse += lineBuffer;
      }

      if (code !== 0 && !rawResponse) {
        reject(new Error(`Codex process exited with code ${code}: ${stderrText.slice(0, 500)}`));
        return;
      }
      // If rawResponse only contains errors, still fail
      if (code !== 0 && rawResponse.startsWith('ERROR:')) {
        reject(new Error(rawResponse.slice(0, 500)));
        return;
      }

      try {
        const extractLog = (msg: string) => emitter.emit({
          event: 'execution_log',
          data: { executionId, timestamp: new Date(), level: 'debug', category: 'system', node: nodeName, message: `[extraction] ${msg}` },
        });
        const outputs = await extractOutputs(rawResponse, nodeDef, extractLog);

        emitter.emit({
          event: 'execution_log',
          data: {
            executionId,
            timestamp: new Date(),
            level: 'info',
            category: 'system',
            node: nodeName,
            message: `Outputs extracted: ${Object.keys(outputs).join(', ') || 'none'}`,
          },
        });

        // Flush any tool still marked pending (subprocess died mid-call).
        for (const [id, pending] of pendingTools) {
          toolCalls.push(buildToolCallRecord({
            tool: pending.tool,
            args: pending.args,
            durationMs: Date.now() - pending.startMs,
            startedAt: pending.startedAt,
            isError: true,
            toolUseId: id,
          }));
        }

        resolve({
          outputs,
          rawResponse,
          prompt,
          sessionId: threadId,
          cost: {
            actual: null,
            estimated: 0.02 * Math.max(turns, 1),
            model,
            turns: Math.max(turns, 1),
            method: 'estimated',
          },
          tokenUsage: usageAccumulator.value,
          durationMs: Date.now() - start,
          toolCalls,
          runtimeContext: {
            cwd,
            executionMode: 'cli',
            systemPromptMode: 'prompt-prefix',
            repoContextLoadingGuidancePresent,
            repoContextLoadingGuidanceInjected,
            mandatoryRepoContextInjected: Boolean(repoKnowledgeContext?.systemPromptBlock),
            mandatoryRepoContextInjectedCount: repoKnowledgeContext?.mandatoryContextInjectedCount,
            mandatoryRepoContextSkippedProviderNativeCount: repoKnowledgeContext?.mandatoryContextSkippedProviderNativeCount,
            mandatoryRepoContextTargetLayer: repoKnowledgeContext?.mandatoryContextTargetLayer ?? (repoKnowledgeContext?.systemPromptBlock ? 'codex_prompt_instruction_prefix' : undefined),
            resolvedModel: model,
            reasoningEffort,
            planMode: false,
            mcpServerNames: [MCP_SERVER_NAME],
          },
        });
      } catch (err: unknown) {
        reject(err);
      }
    });

    proc.on('error', (err) => {

      reject(new Error(`Failed to spawn codex: ${err.message}`));
    });
  });
}

function handleCodexEvent(
  event: any,
  nodeName: string,
  emitter: EngineEventEmitter,
  executionId: string,
  appendText: (text: string) => void,
  toolCalls: ToolCallRecord[],
  pendingTools: Map<string, PendingCodexTool>,
  usageAccumulator?: { value: TokenUsageInfo | null },
) {
  const type = event.type;
  const item = event.item;

  // Agent text message
  if (type === 'item.completed' && item?.type === 'agent_message' && item.text) {
    appendText(item.text);
    emitter.emit({
      event: 'agent_text',
      data: { node: nodeName, text: item.text },
    });
    emitter.emit({
      event: 'execution_log',
      data: {
        executionId,
        timestamp: new Date(),
        level: 'info',
        category: 'agent',
        node: nodeName,
        message: item.text.slice(0, 200),
      },
    });
  }

  // ── Bash / shell command ─────────────────────────────────────────────
  if (type === 'item.started' && item?.type === 'command_execution') {
    const cmd = item.command ?? 'unknown';
    pendingTools.set(item.id, {
      tool: 'Bash',
      args: { command: cmd },
      startedAt: new Date(),
      startMs: Date.now(),
    });
    emitter.emit({
      event: 'agent_tool_start',
      data: { node: nodeName, tool: 'Bash', args: { command: cmd }, toolUseId: item.id },
    });
    emitter.emit({
      event: 'execution_log',
      data: {
        executionId, timestamp: new Date(), level: 'info', category: 'tool',
        node: nodeName, message: `Running: ${cmd.slice(0, 150)}`,
      },
    });
  }
  if (type === 'item.completed' && item?.type === 'command_execution') {
    const pending = pendingTools.get(item.id);
    const startedAt = pending?.startedAt ?? new Date();
    const startMs = pending?.startMs ?? Date.now();
    const cmd = item.command ?? pending?.args.command ?? 'unknown';
    const output = item.aggregated_output ?? '';
    const isError = item.status !== 'completed';
    const record = buildToolCallRecord({
      tool: 'Bash',
      args: { command: cmd },
      result: output,
      durationMs: Date.now() - startMs,
      startedAt,
      isError,
      toolUseId: item.id,
    });
    toolCalls.push(record);
    pendingTools.delete(item.id);
    emitter.emit({
      event: 'agent_tool_complete',
      data: { node: nodeName, toolUseId: item.id, record },
    });
    emitter.emit({
      event: 'execution_log',
      data: {
        executionId, timestamp: new Date(),
        level: isError ? 'warn' : 'info', category: 'tool',
        node: nodeName,
        message: `${isError ? '✗' : '✓'} ${String(cmd).slice(0, 100)}${output ? ' → ' + String(output).slice(0, 100) : ''}`,
      },
    });
  }

  // ── MCP tool call (mcp__<server>__<tool>) ────────────────────────────
  if (type === 'item.started' && item?.type === 'mcp_tool_call') {
    const server = item.server ?? 'unknown';
    const fn = item.tool ?? 'call';
    const tool = `mcp__${server}__${fn}`;
    const args = (item.arguments && typeof item.arguments === 'object') ? item.arguments : {};
    pendingTools.set(item.id, { tool, args, startedAt: new Date(), startMs: Date.now() });
    emitter.emit({
      event: 'agent_tool_start',
      data: { node: nodeName, tool, args, toolUseId: item.id },
    });
  }
  if (type === 'item.completed' && item?.type === 'mcp_tool_call') {
    const pending = pendingTools.get(item.id);
    const startedAt = pending?.startedAt ?? new Date();
    const startMs = pending?.startMs ?? Date.now();
    const tool = pending?.tool ?? `mcp__${item.server ?? 'unknown'}__${item.tool ?? 'call'}`;
    const args = pending?.args ?? {};
    const resultText = Array.isArray(item.result?.content)
      ? item.result.content.map((c: any) => c.text ?? '').join('')
      : item.result;
    let resultData: unknown = resultText;
    if (typeof resultText === 'string') {
      try { resultData = JSON.parse(resultText); } catch { /* keep as string */ }
    }
    const isError = item.isError === true || item.error !== undefined;
    const record = buildToolCallRecord({
      tool, args, result: resultData,
      durationMs: Date.now() - startMs,
      startedAt,
      isError,
      toolUseId: item.id,
    });
    toolCalls.push(record);
    pendingTools.delete(item.id);
    emitter.emit({
      event: 'agent_tool_complete',
      data: { node: nodeName, toolUseId: item.id, record },
    });
  }

  // ── Function calls (OpenAI-style function/tool) ──────────────────────
  if (type === 'item.completed' && item?.type === 'function_call') {
    let args: Record<string, unknown> = {};
    try {
      args = typeof item.arguments === 'string' ? JSON.parse(item.arguments) : (item.arguments ?? {});
    } catch { args = { __raw__: String(item.arguments) }; }
    pendingTools.set(item.id, {
      tool: item.name ?? 'function',
      args,
      startedAt: new Date(),
      startMs: Date.now(),
    });
    emitter.emit({
      event: 'agent_tool_start',
      data: { node: nodeName, tool: item.name, args, toolUseId: item.id },
    });
  }
  if (type === 'item.completed' && item?.type === 'function_call_output') {
    // Paired with an earlier function_call via item.call_id (or id).
    const id = item.call_id ?? item.id;
    const pending = pendingTools.get(id);
    if (!pending) return;
    const record = buildToolCallRecord({
      tool: pending.tool,
      args: pending.args,
      result: item.output,
      durationMs: Date.now() - pending.startMs,
      startedAt: pending.startedAt,
      toolUseId: id,
    });
    toolCalls.push(record);
    pendingTools.delete(id);
    emitter.emit({
      event: 'agent_tool_complete',
      data: { node: nodeName, toolUseId: id, record },
    });
  }

  // Turn completed — usage info
  if (type === 'turn.completed') {
    if (event.usage) {
      const turnUsage = normalizeCodexUsage(event.usage);
      if (turnUsage) {
        if (usageAccumulator) {
          usageAccumulator.value = aggregateTokenUsage(usageAccumulator.value, turnUsage);
        }
        const nullFields = Object.entries(turnUsage)
          .filter(([, v]) => v === null)
          .map(([k]) => k);
        if (nullFields.length > 0) {
          emitter.emit({
            event: 'execution_log',
            data: {
              executionId,
              timestamp: new Date(),
              level: 'debug',
              category: 'system',
              node: nodeName,
              message: `[token-usage] partial — Codex turn has null sub-fields: ${nullFields.join(', ')}`,
            },
          });
        }
        emitter.emit({
          event: 'execution_log',
          data: {
            executionId,
            timestamp: new Date(),
            level: 'info',
            category: 'system',
            node: nodeName,
            message: `[token-usage] codex turn — inputCachedTokens: ${turnUsage.inputCachedTokens}, inputNonCachedTokens: ${turnUsage.inputNonCachedTokens}, outputTokens: ${turnUsage.outputTokens}`,
          },
        });
      } else {
        // usage object present but no expected fields matched
        const rawSample = JSON.stringify(event.usage).slice(0, 400);
        emitter.emit({
          event: 'execution_log',
          data: {
            executionId,
            timestamp: new Date(),
            level: 'warn',
            category: 'system',
            node: nodeName,
            message: `[token-usage] unrecognized — Codex usage shape has no expected fields: ${rawSample}`,
          },
        });
      }
    } else {
      // provider did not report usage for this turn
      emitter.emit({
        event: 'execution_log',
        data: {
          executionId,
          timestamp: new Date(),
          level: 'debug',
          category: 'system',
          node: nodeName,
          message: '[token-usage] absent — Codex turn.completed event has no usage field',
        },
      });
    }
  }
}
