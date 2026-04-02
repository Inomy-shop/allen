import type {
  NodeDef,
  NodeType,
  RoleDef,
  WorkflowDef,
  EngineEventEmitter,
  CostInfo,
  BuiltInFunction,
} from './types.js';
import { renderTemplate } from './template.js';
import { extractOutputs, buildOutputInstruction } from './output-extractor.js';
// extractOutputs is now async (supports LLM fallback)
import { evaluateCondition } from './condition-parser.js';

const COST_PER_TURN: Record<string, number> = {
  opus: 0.15,
  sonnet: 0.05,
  haiku: 0.01,
};

export interface NodeExecutorDeps {
  roles: Record<string, RoleDef>;
  builtIns: Record<string, BuiltInFunction>;
  workflows: Record<string, WorkflowDef>;
  emitter: EngineEventEmitter;
  runWorkflow: (workflow: WorkflowDef, input: Record<string, unknown>) => Promise<Record<string, unknown>>;
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
    case 'agent':
      return executeAgentNode(nodeName, nodeDef, state, sessions, deps);
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
  const role = nodeDef.role ? deps.roles[nodeDef.role] : undefined;
  if (nodeDef.role && !role) {
    throw new Error(`Role not found: ${nodeDef.role}`);
  }

  let prompt = nodeDef.prompt ? renderTemplate(nodeDef.prompt, state) : '';
  prompt += buildOutputInstruction(nodeDef.outputs ?? [], nodeDef.output_format);

  deps.emitter.emit({
    event: 'node_started',
    data: { node: nodeName, role: nodeDef.role, attempt: (state.retry_count as number ?? 0) + 1 },
  });

  const cwd = state.worktree_path as string | undefined;
  const existingSession = sessions[nodeName];
  const resume = nodeDef.resume_on_retry && existingSession ? existingSession : undefined;
  const timeoutMs = (nodeDef.timeout ?? 600) * 1000;

  let rawResponse = '';
  let sessionId: string | undefined;
  let turns = 0;
  let actualCost: number | null = null;

  try {
    const { query } = await import('@anthropic-ai/claude-code');

    const abortController = new AbortController();
    const timer = setTimeout(() => abortController.abort(), timeoutMs);

    const conversation = query({
      prompt,
      options: {
        customSystemPrompt: role?.system,
        model: role?.model ?? 'sonnet',
        allowedTools: role?.tools ?? [],
        cwd,
        resume,
        abortController,
        maxTurns: 50,
        permissionMode: 'bypassPermissions',
      },
    });

    for await (const message of conversation) {
      if (message.type === 'assistant') {
        for (const block of message.message.content) {
          if (block.type === 'text') {
            rawResponse += block.text;
            deps.emitter.emit({ event: 'agent_text', data: { node: nodeName, text: block.text } });
          } else if (block.type === 'tool_use') {
            deps.emitter.emit({
              event: 'agent_tool_start',
              data: { node: nodeName, tool: block.name, args: block.input },
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

    clearTimeout(timer);
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    if (errMsg.includes('abort') || errMsg.includes('Abort')) {
      throw new Error(`Agent node ${nodeName} timed out after ${nodeDef.timeout ?? 600}s`);
    }
    throw err;
  }

  const model = role?.model ?? 'sonnet';
  const outputs = await extractOutputs(rawResponse, nodeDef);

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
      const outputs = await fn(config, state, deps.emitter);
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
