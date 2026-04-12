import type {
  NodeDef,
  NodeType,
  AgentDef,
  WorkflowDef,
  EngineEventEmitter,
  CostInfo,
  BuiltInFunction,
  ExecutionLog,
} from './types.js';
import { renderTemplate } from './template.js';
import { extractOutputs, buildOutputInstruction } from './output-extractor.js';
import { evaluateCondition } from './condition-parser.js';
import { executeCodexNode } from './codex-executor.js';

function emitLog(
  deps: NodeExecutorDeps,
  nodeName: string,
  entry: { level?: 'info' | 'debug' | 'warn' | 'error'; category: string; message: string; data?: unknown },
): void {
  if (!deps.executionId) return;
  const log: ExecutionLog = {
    executionId: deps.executionId,
    timestamp: new Date(),
    level: entry.level ?? 'info',
    category: entry.category as ExecutionLog['category'],
    node: nodeName,
    message: entry.message,
    data: entry.data,
  };
  deps.emitter.emit({ event: 'execution_log', data: log as unknown as Record<string, unknown> });
}

const COST_PER_TURN: Record<string, number> = {
  opus: 0.15,
  sonnet: 0.05,
  haiku: 0.01,
};

export interface NodeExecutorDeps {
  agents: Record<string, AgentDef>;
  builtIns: Record<string, BuiltInFunction>;
  workflows: Record<string, WorkflowDef>;
  emitter: EngineEventEmitter;
  runWorkflow: (workflow: WorkflowDef, input: Record<string, unknown>) => Promise<Record<string, unknown>>;
  executionId?: string;
  nodeContext?: string;
  db?: import('mongodb').Db;
  /** Abort signal — set by engine on cancel, checked/used by node executors to kill processes */
  abortSignal?: AbortSignal;
}

export interface NodeResult {
  outputs: Record<string, unknown>;
  rawResponse?: string;
  sessionId?: string;
  cost: CostInfo;
  durationMs: number;
}

export async function executeNode(
  nodeName: string,
  nodeDef: NodeDef,
  state: Record<string, unknown>,
  sessions: Record<string, string>,
  deps: NodeExecutorDeps,
): Promise<NodeResult> {
  const type: NodeType = nodeDef.type ?? 'agent';

  switch (type) {
    case 'agent': {
      const role = nodeDef.agent ? deps.agents[nodeDef.agent] : undefined;
      if (role?.provider === 'codex') {
        const existingSession = sessions[nodeName];
        return executeCodexNode(nodeName, nodeDef, state, role, deps.emitter, deps.executionId ?? '', existingSession, deps.nodeContext, deps.abortSignal);
      }
      return executeAgentNode(nodeName, nodeDef, state, sessions, deps);
    }
    case 'code':
      return executeCodeNode(nodeName, nodeDef, state, deps);
    case 'human':
      return executeHumanNode(nodeName, nodeDef, state, deps);
    case 'workflow':
      return executeWorkflowNode(nodeName, nodeDef, state, deps);
    case 'condition':
      return executeConditionNode(nodeName, nodeDef, state);
    default:
      throw new Error(`Unknown node type: ${type}`);
  }
}

async function executeAgentNode(
  nodeName: string,
  nodeDef: NodeDef,
  state: Record<string, unknown>,
  sessions: Record<string, string>,
  deps: NodeExecutorDeps,
): Promise<NodeResult> {
  const start = Date.now();
  const role = nodeDef.agent ? deps.agents[nodeDef.agent] : undefined;
  if (nodeDef.agent && !role) {
    throw new Error(`Role not found: ${nodeDef.agent}`);
  }

  let prompt = nodeDef.prompt ? renderTemplate(nodeDef.prompt, state) : '';
  prompt += buildOutputInstruction(nodeDef.outputs ?? [], nodeDef.output_format);
  if (deps.nodeContext) {
    prompt += deps.nodeContext;
  }

  deps.emitter.emit({
    event: 'node_started',
    data: { node: nodeName, agent: nodeDef.agent, attempt: (state.retry_count as number ?? 0) + 1 },
  });

  const cwd = state.worktree_path as string | undefined;
  const existingSession = sessions[nodeName];
  // Resume the agent's prior session by default — preserves context across
  // retry loops (build/test failures, clarify revisions, review verdicts).
  // Opt-out by setting `resume_on_retry: false` on a node that should start fresh.
  const resumeFlag = nodeDef.resume_on_retry !== false;
  const resume = resumeFlag && existingSession ? existingSession : undefined;
  let rawResponse = '';
  let sessionId: string | undefined;
  let turns = 0;
  let actualCost: number | null = null;

  // Throttle agent text logs: buffer text and emit when >= 100 chars or every 5th chunk
  let agentTextBuffer = '';
  let agentTextChunkCount = 0;

  const { query } = await import('@anthropic-ai/claude-code');

  // Load MCP servers so agent nodes can access Linear, Postgres, etc.
  let mcpServers: Record<string, unknown> | undefined;
  try {
    const { loadAllMcpServers } = await import('./mcp-loader.js');
    if (deps.db) mcpServers = await loadAllMcpServers(deps.db);
  } catch { /* MCP not available — continue without */ }

  /**
   * Shared helper to call the Claude Code SDK with the agent's full context.
   * Used for BOTH the initial agent turn AND any extraction retry turns.
   * Keeping the options identical is essential — a retry with missing
   * options (customSystemPrompt, allowedTools, mcpServers) against a
   * resumed session causes `Claude Code process exited with code 1`.
   */
  type CallAgentOpts = {
    promptText: string;
    resumeSession?: string;
    maxTurns?: number;
    emitText?: boolean; // whether to stream text as agent_text events
  };
  const callAgent = async (opts: CallAgentOpts): Promise<{ text: string; sessionId?: string; cost: number | null; turns: number }> => {
    let text = '';
    let localSessionId: string | undefined;
    let localTurns = 0;
    let localCost: number | null = null;

    const conv = query({
      prompt: opts.promptText,
      options: {
        customSystemPrompt: role?.system,
        model: role?.model ?? 'sonnet',
        allowedTools: role?.tools ?? [],
        cwd,
        resume: opts.resumeSession,
        maxTurns: opts.maxTurns ?? 50,
        permissionMode: 'bypassPermissions',
        ...(mcpServers && Object.keys(mcpServers).length > 0 ? { mcpServers: mcpServers as any } : {}),
        ...(deps.abortSignal ? { abortController: { signal: deps.abortSignal, abort() { /* handled by engine */ } } as any } : {}),
      },
    });

    for await (const message of conv) {
      if (message.type === 'assistant') {
        for (const block of (message as any).message.content) {
          if (block.type === 'text') {
            text += block.text;
            if (opts.emitText) {
              deps.emitter.emit({ event: 'agent_text', data: { node: nodeName, text: block.text } });
              agentTextBuffer += block.text;
              agentTextChunkCount++;
              if (agentTextBuffer.length >= 100 || agentTextChunkCount % 5 === 0) {
                emitLog(deps, nodeName, {
                  category: 'agent',
                  level: 'debug',
                  message: agentTextBuffer.slice(0, 200),
                });
                agentTextBuffer = '';
              }
            }
          } else if (block.type === 'tool_use' && opts.emitText) {
            deps.emitter.emit({
              event: 'agent_tool_start',
              data: { node: nodeName, tool: block.name, args: block.input },
            });
            const toolArgs = block.input as Record<string, unknown> | undefined;
            const argSummary = toolArgs ? Object.keys(toolArgs).join(', ') : '';
            emitLog(deps, nodeName, {
              category: 'tool',
              message: `Tool: ${block.name}${argSummary ? ` (${argSummary})` : ''}`,
              data: { tool: block.name, args: toolArgs },
            });
          }
        }
        localTurns++;
      } else if (message.type === 'result') {
        localSessionId = (message as any).session_id;
        localCost = (message as any).total_cost_usd ?? null;
        localTurns = (message as any).num_turns ?? localTurns;
      }
    }

    return { text, sessionId: localSessionId, cost: localCost, turns: localTurns };
  };

  // ── Initial agent call ────────────────────────────────────────────────
  const initial = await callAgent({
    promptText: prompt,
    resumeSession: resume,
    maxTurns: 50,
    emitText: true,
  });
  rawResponse = initial.text;
  sessionId = initial.sessionId;
  actualCost = initial.cost;
  turns = initial.turns;

  // Flush remaining agent text buffer
  if (agentTextBuffer.length > 0) {
    emitLog(deps, nodeName, {
      category: 'agent',
      level: 'debug',
      message: agentTextBuffer.slice(0, 200),
    });
  }

  const model = role?.model ?? 'sonnet';
  const extractLog = (msg: string) => emitLog(deps, nodeName, { level: 'debug', category: 'system', message: `[extraction] ${msg}` });
  const requiredOutputs = (nodeDef.outputs ?? []).filter(k => !k.startsWith('__'));
  const extractionFailed = (out: Record<string, unknown>) => {
    if (requiredOutputs.length === 0) return false;
    if (out.__action) return false; // gate actions override extraction
    return !requiredOutputs.some(k => k in out);
  };

  // ── Step 1: regex-only extraction (Layers 0-3, NO LLM) ─────────────────
  // Fast, reliable extraction from structured response text.
  let outputs = await extractOutputs(rawResponse, nodeDef, extractLog, /*skipLLMFallback*/ true);

  // ── Step 2: Agent-resume retry ─────────────────────────────────────────
  // Ask the SAME agent (via callAgent helper with identical options — same
  // system prompt, same tools, same mcpServers) to resend its response in
  // the expected JSON format. The agent is the smartest extractor because
  // it has full context — Haiku can only guess from whatever text is there.
  // Runs BEFORE Haiku so the original agent gets a chance to fix its own
  // formatting.
  //
  // Key: using callAgent() with resume:sessionId and the SAME options as
  // the original call avoids the "Claude Code process exited with code 1"
  // error that occurs when options drift between call and resume.
  const MAX_AGENT_RETRIES = 2;
  if (extractionFailed(outputs) && sessionId) {
    for (let attempt = 1; attempt <= MAX_AGENT_RETRIES; attempt++) {
      emitLog(deps, nodeName, {
        level: 'warn',
        category: 'system',
        message: `[extraction] Agent-resume retry ${attempt}/${MAX_AGENT_RETRIES} — asking agent to resend in expected JSON format (5s cooldown first)`,
      });

      // 5 second cooldown — gives the Claude Code SDK subprocess time to
      // fully clean up from the previous call. Fresh spawn under load can
      // exit with code 1 if prior subprocess state still holds ~/.claude/ locks.
      await new Promise(r => setTimeout(r, 5000));

      const reprompt = `Your previous response did not include the required output fields in a parseable JSON format. Please respond again with ONLY a JSON code block containing these exact keys: ${requiredOutputs.join(', ')}.

Required format:
\`\`\`json
{
${requiredOutputs.map(k => `  "${k}": ...`).join(',\n')}
}
\`\`\`

Rules:
- Include ALL keys listed above.
- Use null if you genuinely don't have a value for a field.
- Do not rename keys.
- Do not include any explanation before or after the JSON code block.`;

      try {
        const retry = await callAgent({
          promptText: reprompt,
          resumeSession: sessionId,
          maxTurns: 2,
          emitText: false,
        });

        if (retry.sessionId) sessionId = retry.sessionId;
        if (retry.cost != null) actualCost = (actualCost ?? 0) + retry.cost;
        turns += retry.turns;

        if (retry.text) {
          rawResponse += '\n\n--- Agent retry ' + attempt + ' ---\n' + retry.text;
          const retryOutputs = await extractOutputs(retry.text, nodeDef, extractLog, /*skipLLMFallback*/ true);
          outputs = { ...outputs, ...retryOutputs };
          if (!extractionFailed(outputs)) {
            emitLog(deps, nodeName, {
              level: 'info',
              category: 'system',
              message: `[extraction] Agent-resume retry ${attempt} succeeded — extracted [${Object.keys(retryOutputs).join(', ')}]`,
            });
            break;
          }
        } else {
          emitLog(deps, nodeName, {
            level: 'warn',
            category: 'system',
            message: `[extraction] Agent-resume retry ${attempt} returned empty response`,
          });
        }
      } catch (err) {
        emitLog(deps, nodeName, {
          level: 'warn',
          category: 'system',
          message: `[extraction] Agent-resume retry ${attempt} failed: ${(err as Error).message}`,
        });
        // Continue to next attempt
      }
    }
  }

  // ── Step 3: Haiku LLM fallback (Layer 4) ───────────────────────────────
  // If the agent-resume retries didn't produce output (SDK concurrency errors
  // or agent refused to cooperate), try a fresh Haiku call to extract from
  // the raw text as a last-ditch LLM attempt.
  if (extractionFailed(outputs)) {
    emitLog(deps, nodeName, {
      level: 'warn',
      category: 'system',
      message: `[extraction] Falling back to Haiku LLM extraction (5s cooldown first)`,
    });
    await new Promise(r => setTimeout(r, 5000));
    try {
      const haikuOutputs = await extractOutputs(rawResponse, nodeDef, extractLog, /*skipLLMFallback*/ false);
      outputs = { ...outputs, ...haikuOutputs };
    } catch (err) {
      emitLog(deps, nodeName, {
        level: 'warn',
        category: 'system',
        message: `[extraction] Haiku fallback failed: ${(err as Error).message}`,
      });
    }
  }

  // ── Step 4: Salvage defaults from raw response ─────────────────────────
  // Last-ditch effort: scan the raw response for "key: value" patterns and
  // fill in null defaults for anything still missing. Ensures downstream
  // conditions always see a value (the parser treats null as false).
  if (extractionFailed(outputs) && rawResponse.length > 0) {
    const salvaged: Record<string, unknown> = {};
    for (const key of requiredOutputs) {
      if (key in outputs) continue;
      const m = rawResponse.match(new RegExp(`${key}\\s*[:=]\\s*([^\\n]+)`, 'i'));
      if (m) {
        const v = m[1].trim().replace(/^["']|["',]$/g, '');
        if (v === 'true') salvaged[key] = true;
        else if (v === 'false') salvaged[key] = false;
        else if (v === 'null') salvaged[key] = null;
        else if (!isNaN(Number(v)) && v !== '') salvaged[key] = Number(v);
        else salvaged[key] = v;
      } else {
        salvaged[key] = null;
      }
    }
    outputs = { ...salvaged, ...outputs };
    emitLog(deps, nodeName, {
      level: 'info',
      category: 'system',
      message: `[extraction] Salvaged defaults from raw response for ${Object.keys(salvaged).join(', ')}`,
    });
  }

  if (extractionFailed(outputs)) {
    emitLog(deps, nodeName, {
      level: 'warn',
      category: 'system',
      message: `[extraction] All strategies failed — downstream conditions will evaluate missing values as false`,
    });
  }
  // ───────────────────────────────────────────────────────────────────────

  return {
    outputs,
    rawResponse,
    sessionId,
    cost: {
      actual: actualCost,
      estimated: (COST_PER_TURN[model] ?? 0.05) * turns,
      model,
      turns,
      method: actualCost != null ? 'sdk_reported' : 'estimated',
    },
    durationMs: Date.now() - start,
  };
}

async function executeCodeNode(
  nodeName: string,
  nodeDef: NodeDef,
  state: Record<string, unknown>,
  deps: NodeExecutorDeps,
): Promise<NodeResult> {
  const start = Date.now();
  const fnName = nodeDef.function;
  if (!fnName) throw new Error(`Code node ${nodeName} has no function defined`);

  const fn = deps.builtIns[fnName];
  if (!fn) throw new Error(`Built-in function not found: ${fnName}`);

  const config = nodeDef.config ?? {};
  let lastError: Error | null = null;
  const maxAttempts = (nodeDef.retries ?? 0) + 1;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      if (attempt > 0) {
        const delayMs = calculateBackoff(nodeDef, attempt);
        await sleep(delayMs);
      }
      const outputs = await fn(config, state, { emitter: deps.emitter, db: deps.db, executionId: deps.executionId });
      return {
        outputs,
        cost: { actual: null, estimated: 0, method: 'estimated' },
        durationMs: Date.now() - start,
      };
    } catch (err: unknown) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (nodeDef.retry_on && nodeDef.retry_on.length > 0) {
        const shouldRetry = nodeDef.retry_on.some(code => lastError!.message.includes(code));
        if (!shouldRetry) break;
      }
    }
  }

  if (nodeDef.on_failure === 'skip' || nodeDef.on_failure === 'fallback') {
    return {
      outputs: nodeDef.fallback_value ?? {},
      cost: { actual: null, estimated: 0, method: 'estimated' },
      durationMs: Date.now() - start,
    };
  }

  throw lastError ?? new Error(`Code node ${nodeName} failed`);
}

async function executeHumanNode(
  nodeName: string,
  nodeDef: NodeDef,
  state: Record<string, unknown>,
  deps: NodeExecutorDeps,
): Promise<NodeResult> {
  const start = Date.now();
  const prompt = nodeDef.prompt ? renderTemplate(nodeDef.prompt, state) : '';

  deps.emitter.emit({
    event: 'input_required',
    data: { node: nodeName, prompt, fields: nodeDef.fields ?? [] },
  });

  return {
    outputs: { __waiting_for_input: true, __node: nodeName },
    cost: { actual: null, estimated: 0, method: 'estimated' },
    durationMs: Date.now() - start,
  };
}

async function executeWorkflowNode(
  nodeName: string,
  nodeDef: NodeDef,
  state: Record<string, unknown>,
  deps: NodeExecutorDeps,
): Promise<NodeResult> {
  const start = Date.now();
  const workflowName = nodeDef.workflow;
  if (!workflowName) throw new Error(`Workflow node ${nodeName} has no workflow defined`);

  const workflow = deps.workflows[workflowName];
  if (!workflow) throw new Error(`Workflow not found: ${workflowName}`);

  const childInput: Record<string, unknown> = {};
  if (nodeDef.input_map) {
    for (const [childKey, template] of Object.entries(nodeDef.input_map)) {
      childInput[childKey] = renderTemplate(template, state);
    }
  }

  const childOutput = await deps.runWorkflow(workflow, childInput);

  const outputs: Record<string, unknown> = {};
  if (nodeDef.output_map) {
    for (const [childKey, parentKey] of Object.entries(nodeDef.output_map)) {
      outputs[parentKey] = childOutput[childKey];
    }
  }

  // Extract child cost from the child state (the engine stores it in the execution record)
  // For now, estimate based on outputs presence
  const childCostEstimated = (childOutput.__cost_estimated as number) ?? 0;
  const childCostActual = (childOutput.__cost_actual as number | null) ?? null;

  return {
    outputs,
    cost: {
      actual: childCostActual,
      estimated: childCostEstimated,
      method: childCostActual != null ? 'sdk_reported' : 'estimated',
    },
    durationMs: Date.now() - start,
  };
}

async function executeConditionNode(
  _nodeName: string,
  nodeDef: NodeDef,
  state: Record<string, unknown>,
): Promise<NodeResult> {
  const start = Date.now();
  const conditions = nodeDef.conditions ?? [];
  const outputs: Record<string, unknown> = {};

  for (const cond of conditions) {
    const result = evaluateCondition(cond.expression, state);
    outputs[cond.name] = result;
  }

  return {
    outputs,
    cost: { actual: null, estimated: 0, method: 'estimated' },
    durationMs: Date.now() - start,
  };
}

function calculateBackoff(nodeDef: NodeDef, attempt: number): number {
  const base = nodeDef.backoff_base_ms ?? 1000;
  switch (nodeDef.backoff) {
    case 'exponential':
      return base * Math.pow(2, attempt - 1);
    case 'linear':
      return base * attempt;
    default:
      return base;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
