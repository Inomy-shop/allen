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

  try {
    const { query } = await import('@anthropic-ai/claude-code');

    // Load MCP servers so agent nodes can access Linear, Postgres, etc.
    let mcpServers: Record<string, unknown> | undefined;
    try {
      const { loadAllMcpServers } = await import('./mcp-loader.js');
      if (deps.db) mcpServers = await loadAllMcpServers(deps.db);
    } catch { /* MCP not available — continue without */ }

    const conversation = query({
      prompt,
      options: {
        customSystemPrompt: role?.system,
        model: role?.model ?? 'sonnet',
        allowedTools: role?.tools ?? [],
        cwd,
        resume,
        maxTurns: 50,
        permissionMode: 'bypassPermissions',
        ...(mcpServers && Object.keys(mcpServers).length > 0 ? { mcpServers: mcpServers as any } : {}),
        ...(deps.abortSignal ? { abortController: { signal: deps.abortSignal, abort() { /* handled by engine */ } } as any } : {}),
      },
    });

    for await (const message of conversation) {
      if (message.type === 'assistant') {
        for (const block of message.message.content) {
          if (block.type === 'text') {
            rawResponse += block.text;
            deps.emitter.emit({ event: 'agent_text', data: { node: nodeName, text: block.text } });

            // Throttled agent text log
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
          } else if (block.type === 'tool_use') {
            deps.emitter.emit({
              event: 'agent_tool_start',
              data: { node: nodeName, tool: block.name, args: block.input },
            });

            // Tool call log
            const toolArgs = block.input as Record<string, unknown> | undefined;
            const argSummary = toolArgs ? Object.keys(toolArgs).join(', ') : '';
            emitLog(deps, nodeName, {
              category: 'tool',
              message: `Tool: ${block.name}${argSummary ? ` (${argSummary})` : ''}`,
              data: { tool: block.name, args: toolArgs },
            });
          }
        }
        turns++;
      } else if (message.type === 'result') {
        sessionId = message.session_id;
        actualCost = message.total_cost_usd ?? null;
        turns = message.num_turns;
      }
    }

    // Flush remaining agent text buffer
    if (agentTextBuffer.length > 0) {
      emitLog(deps, nodeName, {
        category: 'agent',
        level: 'debug',
        message: agentTextBuffer.slice(0, 200),
      });
    }

  } catch (err: unknown) {
    throw err;
  }

  const model = role?.model ?? 'sonnet';
  const extractLog = (msg: string) => emitLog(deps, nodeName, { level: 'debug', category: 'system', message: `[extraction] ${msg}` });
  let outputs = await extractOutputs(rawResponse, nodeDef, extractLog);

  // ── Extraction auto-retry ──────────────────────────────────────────────
  // If the agent produced a response but we couldn't extract the required
  // outputs, re-prompt the SAME session asking it to provide the JSON in the
  // expected format. This is NOT a workflow-level retry — max_retries on edges
  // is not incremented. We try up to MAX_EXTRACTION_RETRIES times.
  const MAX_EXTRACTION_RETRIES = 2;
  const requiredOutputs = (nodeDef.outputs ?? []).filter(k => !k.startsWith('__'));
  const extractionFailed = (out: Record<string, unknown>) => {
    if (requiredOutputs.length === 0) return false;
    // If any gate action fired (clarify/stop/skip), skip re-prompt
    if (out.__action) return false;
    // Missing if none of the required outputs are present
    return !requiredOutputs.some(k => k in out);
  };

  let extractAttempt = 0;
  while (extractionFailed(outputs) && extractAttempt < MAX_EXTRACTION_RETRIES && sessionId) {
    extractAttempt++;
    emitLog(deps, nodeName, {
      level: 'warn',
      category: 'system',
      message: `[extraction] Auto-retry ${extractAttempt}/${MAX_EXTRACTION_RETRIES} — agent response did not contain required outputs [${requiredOutputs.join(', ')}]. Asking agent to resend in expected JSON format.`,
    });

    const reprompt = `Your previous response did not include the required output fields in a parseable format. Please respond again with ONLY a JSON code block containing these exact keys: ${requiredOutputs.join(', ')}.

Wrap the response like this:
\`\`\`json
{
${requiredOutputs.map(k => `  "${k}": ...`).join(',\n')}
}
\`\`\`

Do not include any explanation before or after the JSON block. Just the JSON code block.`;

    try {
      const { query } = await import('@anthropic-ai/claude-code');
      let retryResponse = '';
      const retryConv = query({
        prompt: reprompt,
        options: {
          model: role?.model ?? 'sonnet',
          maxTurns: 1,
          permissionMode: 'bypassPermissions',
          resume: sessionId, // resume the same session so the agent has full context
          ...(deps.abortSignal ? { abortController: { signal: deps.abortSignal, abort() { /* handled */ } } as any } : {}),
        },
      });
      for await (const message of retryConv) {
        if (message.type === 'assistant') {
          for (const block of (message as any).message.content) {
            if (block.type === 'text') retryResponse += block.text;
          }
        } else if (message.type === 'result') {
          if ((message as any).session_id) sessionId = (message as any).session_id;
          const rc = (message as any).total_cost_usd;
          if (typeof rc === 'number') actualCost = (actualCost ?? 0) + rc;
          turns += (message as any).num_turns ?? 0;
        }
      }

      rawResponse += '\n\n--- Extraction retry ' + extractAttempt + ' ---\n' + retryResponse;
      outputs = await extractOutputs(retryResponse, nodeDef, extractLog);
      if (!extractionFailed(outputs)) {
        emitLog(deps, nodeName, {
          level: 'info',
          category: 'system',
          message: `[extraction] Auto-retry ${extractAttempt} succeeded — extracted [${Object.keys(outputs).join(', ')}]`,
        });
      }
    } catch (err) {
      emitLog(deps, nodeName, {
        level: 'warn',
        category: 'system',
        message: `[extraction] Auto-retry ${extractAttempt} failed: ${(err as Error).message}`,
      });
      break;
    }
  }

  if (extractionFailed(outputs)) {
    emitLog(deps, nodeName, {
      level: 'warn',
      category: 'system',
      message: `[extraction] Failed to extract required outputs after ${extractAttempt} auto-retries — downstream conditions may evaluate with undefined values`,
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
