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
import { extractOutputs, buildOutputInstruction, outputKeys } from './output-extractor.js';
import { evaluateCondition } from './condition-parser.js';
import { executeCodexNode } from './codex-executor.js';
import { buildToolCallRecord, type ToolCallRecord } from './tool-call.js';
import { normalizeModelAlias } from './model-alias.js';
import { withArtifactsGuidance } from './agent-file-writer.js';
import { statSync, mkdirSync } from 'node:fs';

/** Agent-safe fallback cwd. Kept in sync with chat-providers.ts's
 * AGENT_FALLBACK_CWD — duplicated here because the engine package can't
 * import from the server package. Never fall back to process.cwd() because
 * that's the server's source tree. */
const AGENT_FALLBACK_CWD = '/tmp/allen';

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
  /** In-process service hooks exposed to built-ins (see EngineServices). */
  services?: import('./types.js').EngineServices;
  /** Abort signal — set by engine on cancel, checked/used by node executors to kill processes */
  abortSignal?: AbortSignal;
}

export interface NodeResult {
  outputs: Record<string, unknown>;
  rawResponse?: string;
  sessionId?: string;
  cost: CostInfo;
  durationMs: number;
  /** Per-tool-call log captured during the node's agent turn(s). Empty
   *  for non-agent node types. See tool-call.ts for record shape. */
  toolCalls?: ToolCallRecord[];

  // ── Phase 2 trace enrichments — all optional, populated by node-executor
  //    so the engine can merge them into the NodeTrace row at save time.

  /** Captured from the SDK's `system.init` message — full list of tool
   *  names the agent HAD access to during this spawn. UI diffs against
   *  toolCalls to show "had X, Y, Z available; used only X". */
  toolsAvailable?: string[];

  /** Snapshot of the spawn-time context for this node. cwd, resolved model,
   *  execution mode (sdk vs cli), system-prompt mode, MCP servers attached,
   *  list of env var names (not values). */
  runtimeContext?: {
    cwd?: string;
    executionMode?: 'sdk' | 'cli';
    systemPromptMode?: 'append' | 'custom';
    resolvedModel?: string;
    reasoningEffort?: string;
    planMode?: boolean;
    mcpServerNames?: string[];
    envKeys?: string[];
  };

  /** Effective agent settings + which layer set each (per-node override
   *  vs. agent default). */
  agentOverrides?: {
    model?: string;
    reasoningEffort?: string;
    planMode?: boolean;
    sources: Partial<Record<'model' | 'reasoningEffort' | 'planMode', 'node' | 'agent-default'>>;
  };

  /** Auto-gate verdict if the agent emitted one. */
  gateDecision?: {
    action: 'stop' | 'skip' | 'clarify';
    reason: string;
    clarifyAction?: 'retry' | 'continue';
    clarifyFields?: string[];
  };

  /** Per-tool-call token usage + estimated cost. Estimate only — Anthropic
   *  doesn't expose per-tool billing. Derived from the tool_result input_
   *  tokens proportion of total node cost. */
  tokenUsagePerTool?: Array<{
    toolUseId: string;
    tool: string;
    inputTokens: number;
    outputTokens: number;
    estimatedCost: number;
  }>;
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
      // Effective provider: per-node override wins over agent default.
      // This lets a workflow cross-override a Claude agent to run on Codex
      // (or vice versa) without mutating the agent document.
      const overrideProvider = nodeDef.agentOverrides?.provider;
      const effectiveProvider =
        overrideProvider === 'codex' || overrideProvider === 'claude-cli'
          ? overrideProvider
          : role?.provider === 'codex'
            ? 'codex'
            : 'claude';
      if (effectiveProvider === 'codex') {
        const existingSession = sessions[nodeName];
        return executeCodexNode(
          nodeName,
          nodeDef,
          state,
          role,
          deps.emitter,
          deps.executionId ?? '',
          existingSession,
          deps.nodeContext,
          deps.abortSignal,
        );
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

  // Resolve cwd in priority order:
  //   1. worktree_path — set by create-workspace once an isolated git worktree exists.
  //   2. repo_path     — the user-supplied target repo, used by nodes that run BEFORE
  //                      the worktree is created (e.g. bug-investigator's repro step).
  //                      Without this, early nodes fall through to process.cwd() and
  //                      investigate whatever repo the engine was spawned from.
  //   3. agent.sourceRepoPath — populated for agents imported from a registered repo's
  //                      `.claude/agents/*.md` file, so an imported agent auto-runs in
  //                      its source repo without threading inputs through the workflow.
  //
  // Each candidate is validated as an existing directory before we accept it.
  // Without this, a stale /tmp path (after macOS /tmp cleanup, a deleted
  // worktree, or a path that was valid on the workflow author's laptop but
  // not on this host) causes `child_process.spawn({ cwd })` to fail with
  // `spawn node ENOENT` — Node's error formatter blames the executable even
  // though the real problem is the missing cwd, which is maximally confusing.
  const dirExists = (p: string | undefined): boolean => {
    if (!p || typeof p !== 'string') return false;
    try { return statSync(p).isDirectory(); } catch { return false; }
  };
  const cwdCandidates: [string, string | undefined][] = [
    ['worktree_path', state.worktree_path as string | undefined],
    ['repo_path', state.repo_path as string | undefined],
    ['sourceRepoPath', role?.sourceRepoPath],
  ];
  let cwd: string | undefined;
  for (const [label, path] of cwdCandidates) {
    if (!path) continue;
    if (dirExists(path)) { cwd = path; break; }
    emitLog(deps, nodeName, {
      level: 'warn',
      category: 'system',
      message: `[cwd] ${label}="${path}" does not exist — falling through to next candidate`,
    });
  }
  if (!cwd) {
    const declared = cwdCandidates.filter(([, p]) => p).map(([l, p]) => `${l}="${p}"`).join(', ');
    if (declared) {
      emitLog(deps, nodeName, {
        level: 'warn',
        category: 'system',
        message: `[cwd] no candidate directory exists (${declared}); falling back to ${AGENT_FALLBACK_CWD}`,
      });
    }
    // Never inherit the engine's own cwd — that would run the agent inside
    // the server source tree. Use a dedicated scratch dir instead.
    mkdirSync(AGENT_FALLBACK_CWD, { recursive: true });
    cwd = AGENT_FALLBACK_CWD;
  }
  const existingSession = sessions[nodeName];
  // A node re-enters the executor in two distinct shapes, and the prompt
  // we send is different for each. In BOTH cases we resume the prior
  // session — the resumed conversation already carries the agent's role,
  // task history, tool calls, and output schema, and sending the full
  // rendered prompt again on top of replayed session history is what
  // overflows the model's context window and causes the opaque
  // `Claude Code process exited with code 1` at subprocess startup.
  //
  //   (a) Direct retry target — an edge looped back to this node
  //       (`qa→develop→qa` after `qa_verdict='fail'`). `state.__retry_target`
  //       contains this node's name and `retry_context` carries the gate
  //       feedback.
  //         → "RETRY FEEDBACK" prompt: "you failed a downstream gate, fix
  //           the issues below, re-emit your output."
  //
  //   (b) Forward-path re-entry — an UPSTREAM node retried, completed, and
  //       routing arrived back at this node on the forward path. The engine
  //       already consumed the retry payload when the upstream target
  //       completed, so `__retry_target` no longer contains this node.
  //       Critically, the upstream re-run produced DIFFERENT outputs
  //       (new files_changed, developer_output, review feedback), so the
  //       agent's prior analysis is now stale.
  //         → "UPSTREAM RE-RUN" prompt: "your upstream dependency re-ran,
  //           your prior outputs are stale, re-read the current state and
  //           re-execute your contract."
  //
  // `resume_on_retry: false` disables resume entirely — those nodes always
  // start fresh with the full rendered prompt.
  const retryTargets = state.__retry_target as string[] | undefined;
  const isRetryTarget = Array.isArray(retryTargets) && retryTargets.includes(nodeName);
  const resumeFlag = nodeDef.resume_on_retry !== false;
  const resume = resumeFlag && existingSession ? existingSession : undefined;
  // Three possible prompt shapes, decided together:
  //   retry        — isRetryTarget && resume  — gate feedback
  //   forward      — !isRetryTarget && resume — upstream re-ran
  //   full         — no resume (first run, or resume_on_retry:false)
  const promptShape: 'retry' | 'forward' | 'full' =
    resume !== undefined && isRetryTarget ? 'retry'
    : resume !== undefined ? 'forward'
    : 'full';

  // Log forward-path re-entries so operators can correlate the upstream
  // retry with this node's re-invocation — silent re-runs are hard to debug.
  if (promptShape === 'forward') {
    emitLog(deps, nodeName, {
      level: 'debug',
      category: 'system',
      message: `[session] forward-path re-entry — resuming session ${existingSession!.slice(0, 8)} with upstream-re-ran prompt`,
    });
  }

  // Helper used by both resume-shape branches. Serializes a state value for
  // inlining in the minimal retry prompt. Strings are shown verbatim (up to
  // 800 chars); numbers/booleans/null are shown as-is; arrays/objects are
  // JSON-stringified then truncated. The truncation ceiling is deliberately
  // generous — we want the agent to see enough of the updated value to
  // compare against its session memory, but not enough to overflow the
  // context window when the value is e.g. an entire rawResponse dump.
  const formatStateValue = (v: unknown): string => {
    if (v == null) return String(v);
    if (typeof v === 'string') {
      return v.length > 800 ? v.slice(0, 800) + ` ... (${v.length - 800} chars truncated)` : v;
    }
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
      // Skip the retry plumbing itself even though it doesn't start with __ —
      // the agent has no use for these and they'd confuse the snapshot.
      if (k === 'retry_context' || k === 'retry_count') continue;
      lines.push(`${k}: ${formatStateValue(v)}`);
    }
    return lines.length > 0 ? lines.join('\n') : '(no top-level state fields)';
  };

  let prompt: string;
  if (promptShape === 'retry') {
    // Gate-feedback retry — a downstream reviewer rejected this node's
    // previous output and fired the retry edge. The resumed session carries
    // the original task and the agent's prior turns; we only hand back the
    // reviewer's feedback. The agent decides what re-work that requires.
    //
    // NOTE on `__retry_source`: this is the REVIEWING node (qa, code_review,
    // validator, etc.) — the one that decided the retry — NOT the current
    // node being re-run. The prompt is worded accordingly.
    const attempt = (state.__retry_attempt as number) ?? 2;
    const source = (state.__retry_source as string) ?? 'downstream step';
    const context = (state.retry_context as string) ?? '';
    prompt = `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
REVIEW FEEDBACK — ATTEMPT ${attempt}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Your previous output was rejected by the ${source} step's review. Their
feedback is below. Apply the fixes and re-emit your JSON output block.

Do NOT redo analysis that is still valid — apply the feedback as a
targeted fix. You decide what tool calls that requires: re-read the
files you're about to change, re-run tests after editing, whatever
your role's contract needs. Do not skip verification to save turns.

━━━ FEEDBACK FROM ${source} ━━━
${context}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
  } else if (promptShape === 'forward') {
    // Upstream re-ran. Your task is unchanged, but your inputs changed and
    // your prior outputs are stale.
    //
    // Example — qa after a develop retry loop:
    //   qa ran, failed develop, fired retry edge → develop re-ran, produced
    //   new files_changed + developer_output → qa re-enters on the forward
    //   path → qa must re-run build/lint/tests against the NEW files, not
    //   return its prior "fail" verdict from session memory.
    //
    // Example — code_review after a downstream-triggered rewind:
    //   code_review approved → downstream node failed → retry-from-node
    //   rewound past code_review to develop → develop re-ran → code_review
    //   re-enters on the forward path → code_review must review the NEW
    //   diff, not return its prior "APPROVED" verdict.
    //
    // CRITICAL: the agent has no way to query workflow state at runtime.
    // It can only see what we put in the prompt, its session memory, and
    // what it reads from disk via tools. The agent's session memory has
    // the ORIGINAL interpolated state values from the first full prompt —
    // those are stale. So we MUST dump the current values in the prompt.
    // Skipping this is what makes a naive forward-re-entry prompt operate
    // on stale data and silently return wrong answers.
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
  } else {
    // Full prompt — fresh run (first attempt) or retry with a reset session.
    prompt = nodeDef.prompt ? renderTemplate(nodeDef.prompt, state) : '';
    prompt += buildOutputInstruction(nodeDef.outputs, nodeDef.output_format);
    if (deps.nodeContext) {
      prompt += deps.nodeContext;
    }

    // Retry with no session resume — we can't rely on prior context, so
    // still append the feedback block after the full re-rendered prompt.
    if (isRetryTarget) {
      const attempt = (state.__retry_attempt as number) ?? 2;
      const source = (state.__retry_source as string) ?? 'previous step';
      const context = (state.retry_context as string) ?? '';
      prompt += `

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
RETRY FEEDBACK — ATTEMPT ${attempt}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
You are being re-run because the previous attempt of ${source} produced a
result that failed a downstream gate. Address the feedback below in this
run. Do NOT redo work that is already correct — focus on the issues called
out here.

${context}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
    }
  }

  deps.emitter.emit({
    event: 'node_started',
    data: {
      node: nodeName,
      agent: nodeDef.agent,
      attempt: (state.retry_count as number ?? 0) + 1,
      // Ship the rendered prompt and input state with the start event so
      // the UI can show them immediately — without waiting for the trace
      // that's only written after the node completes.
      renderedPrompt: prompt,
      inputState: { ...state },
    },
  });
  let rawResponse = '';
  let sessionId: string | undefined;
  let turns = 0;
  let actualCost: number | null = null;

  // Throttle agent text logs: buffer text and emit when >= 100 chars or every 5th chunk
  let agentTextBuffer = '';
  let agentTextChunkCount = 0;

  const { query } = await import('@anthropic-ai/claude-code');

  // Spawn-tree context vars — propagated to claude-cli (and on to the
  // Allen MCP server it spawns) so any `spawn_agent` tool call made
  // inside this agent's session can tag the resulting execution row with
  // its caller. Root id lets the Phase 3 log fan-out broadcast grandchild
  // events up to the top of the tree in one indexed lookup. See
  // chat-tools.ts:spawnAgent for where these are consumed.
  const spawnContextEnv: Record<string, string> = {
    ALLEN_PARENT_EXECUTION_ID: deps.executionId ?? '',
    ALLEN_PARENT_CALLER: nodeName,
    ALLEN_ROOT_EXECUTION_ID:
      process.env.ALLEN_ROOT_EXECUTION_ID || deps.executionId || '',
    // Artifact-root context — the Allen MCP's allen_save_artifact tool
    // reads these to decide which root directory to file user-visible
    // artifacts under. Inherit from parent env when set (so a workflow
    // that spawns agents keeps EVERY sub-agent's artifacts under the
    // same top-level workflow execution id). Otherwise, this node is
    // the root and fills it in.
    ALLEN_ARTIFACT_ROOT_TYPE:
      process.env.ALLEN_ARTIFACT_ROOT_TYPE || 'workflow',
    ALLEN_ARTIFACT_ROOT_ID:
      process.env.ALLEN_ARTIFACT_ROOT_ID
      || process.env.ALLEN_ROOT_EXECUTION_ID
      || deps.executionId
      || '',
    ALLEN_ARTIFACT_NODE_NAME: nodeName,
    ALLEN_ARTIFACT_AGENT_NAME: nodeDef.agent ?? '',
    ALLEN_ARTIFACT_AGENT_EXECUTION_ID: deps.executionId ?? '',
    ALLEN_ARTIFACT_PARENT_ID: deps.executionId ?? '',
  };

  // Load MCP servers so agent nodes can access Linear, Postgres, etc.
  // We stamp the spawn-tree context onto the Allen MCP server's env
  // block here so it's carried as a first-class subprocess env, not left
  // to the SDK's undocumented merge behavior.
  let mcpServers: Record<string, unknown> | undefined;
  try {
    const { loadAllMcpServers } = await import('./mcp-loader.js');
    if (deps.db) mcpServers = await loadAllMcpServers(deps.db, spawnContextEnv);
  } catch { /* MCP not available — continue without */ }

  // Build the effective system prompt with live org chart + delegation targets
  // appended. Runtime injection keeps chat and workflow agent behavior aligned
  // and avoids prompt drift when agents are added/renamed.
  let effectiveSystem: string | undefined = role?.system;
  if (deps.db && nodeDef.agent && role?.system) {
    try {
      const { buildOrgContextBlock } = await import('./org-context.js');
      const orgBlock = await buildOrgContextBlock(deps.db, {
        forAgent: nodeDef.agent,
        includeFullChart: true,
        includeMeta: true,
      });
      if (orgBlock) {
        effectiveSystem = `${role.system}\n\n${orgBlock}`;
      }
    } catch { /* org-context unavailable — fall back to plain system prompt */ }
  }
  // Universal artifact guidance — every workflow agent (Claude SDK, Claude
  // CLI, Codex below) gets the instruction to save deliverables via
  // allen_save_artifact. Idempotent: skipped if already present.
  if (effectiveSystem !== undefined) effectiveSystem = withArtifactsGuidance(effectiveSystem);

  // Captured across all callAgent invocations for this node. First-seen
  // init message's `tools` array — the agent's full tool allowlist. Used
  // to populate NodeResult.toolsAvailable so the UI can diff against the
  // set of tools actually invoked.
  let capturedToolsAvailable: string[] | undefined;

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
    emitText?: boolean; // whether to stream text as agent_text events
  };
  type CallAgentResult = {
    text: string;
    sessionId?: string;
    cost: number | null;
    turns: number;
    toolCalls: ToolCallRecord[];
  };
  const callAgent = async (opts: CallAgentOpts): Promise<CallAgentResult> => {
    let text = '';
    let localSessionId: string | undefined;
    let localTurns = 0;
    let localCost: number | null = null;
    const localToolCalls: ToolCallRecord[] = [];
    const pendingTools = new Map<string, { tool: string; args: Record<string, unknown>; startedAt: Date; startMs: number }>();

    // Resolve per-node agent settings overrides. The node may specify
    // `agentOverrides` to override the agent's default model / reasoning
    // effort / plan mode for just this node. The agent document itself is
    // read-only from here.
    const override = nodeDef.agentOverrides ?? {};
    // Normalize aliases (haiku/sonnet/opus) to fully-qualified model IDs so
    // we don't depend on Claude Code CLI's (possibly stale) alias tables and
    // trigger API 404s on deprecated versions like claude-3-5-haiku-20241022.
    const rawModel = (override.model ?? role?.model) ?? 'sonnet';
    const resolvedModel = normalizeModelAlias(rawModel) ?? rawModel;
    const resolvedEffort = override.reasoningEffort ?? role?.reasoningEffort;
    const resolvedPlanMode = override.planMode ?? role?.planMode ?? false;

    // Map effort to Anthropic's documented prompt-keyword triggers. The
    // Claude Code SDK's bundled cli.js doesn't accept --effort in any
    // published version, so we inject the keyword into the prompt instead.
    // See packages/server/src/services/agent-settings.ts for details.
    let effectivePrompt = opts.promptText;
    if (resolvedEffort) {
      const keyword =
        resolvedEffort === 'max' ? 'ultrathink' :
        resolvedEffort === 'high' ? 'think hard' :
        resolvedEffort === 'medium' ? 'think' :
        undefined;
      if (keyword) {
        effectivePrompt = `${keyword}\n\n${effectivePrompt}`;
      }
    }

    // System-prompt wiring. `append` (default) layers the agent prompt on top
    // of Claude Code's built-in agentic scaffolding so the model keeps iterating
    // until the task is done. Set ALLEN_SYSTEM_PROMPT_MODE=custom to revert
    // to full replacement (previous behavior).
    const systemPromptMode = process.env.ALLEN_SYSTEM_PROMPT_MODE === 'custom' ? 'custom' : 'append';

    // Execution mode. Auto-picks based on cwd: real repo/workspace → CLI
    // (file-based agent spawn via `claude --agent allen-<name>`, best when
    // the agent has filesystem access), ephemeral /tmp → SDK. Explicit
    // ALLEN_AGENT_EXECUTION_MODE=cli|sdk overrides. Both modes yield the
    // same SDKMessage stream so the consumer loop below is identical.
    const explicitMode = process.env.ALLEN_AGENT_EXECUTION_MODE;
    const isEphemeral = (() => {
      if (!cwd) return false;
      const n = cwd.replace(/\/+$/, '');
      return n === '/tmp' || n.startsWith('/tmp/') ||
        n === '/var/tmp' || n.startsWith('/var/tmp/') ||
        n === '/private/tmp' || n.startsWith('/private/tmp/');
    })();
    const executionMode: 'sdk' | 'cli' =
      explicitMode === 'cli' ? 'cli' :
      explicitMode === 'sdk' ? 'sdk' :
      isEphemeral ? 'sdk' : 'cli';

    let conv: AsyncIterable<any>;
    if (executionMode === 'cli') {
      const { queryViaCli } = await import('./cli-runner.js');
      conv = queryViaCli({
        agent: {
          name: nodeDef.agent ?? 'unknown',
          description: (role as any)?.description,
          system: effectiveSystem ?? '',
          model: resolvedModel,
          tools: Array.isArray((role as any)?.tools) ? (role as any).tools : undefined,
        },
        prompt: effectivePrompt,
        cwd,
        model: resolvedModel,
        resume: opts.resumeSession,
        permissionMode: resolvedPlanMode ? 'plan' : 'bypassPermissions',
        env: { ...process.env, ...spawnContextEnv },
        mcpServers: mcpServers && Object.keys(mcpServers).length > 0 ? (mcpServers as Record<string, unknown>) : undefined,
        abortSignal: deps.abortSignal,
        stderr: (chunk) => emitLog(deps, nodeName, { level: 'debug', category: 'system', message: `[claude-cli stderr] ${chunk.slice(0, 300)}` }),
      });
    } else {
      conv = query({
        prompt: effectivePrompt,
        options: {
          ...(systemPromptMode === 'custom'
            ? { customSystemPrompt: effectiveSystem }
            : { appendSystemPrompt: effectiveSystem }),
          model: resolvedModel,
          cwd,
          resume: opts.resumeSession,
          permissionMode: resolvedPlanMode ? 'plan' : 'bypassPermissions',
          // Merge parent env so PATH / HOME / ANTHROPIC_API_KEY / etc survive,
          // then overlay our spawn-tree vars.
          env: { ...process.env, ...spawnContextEnv },
          ...(mcpServers && Object.keys(mcpServers).length > 0 ? { mcpServers: mcpServers as any } : {}),
          ...(deps.abortSignal ? { abortController: { signal: deps.abortSignal, abort() { /* handled by engine */ } } as any } : {}),
        } as Record<string, unknown>,
      });
    }

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
          } else if (block.type === 'tool_use' && block.name && block.id) {
            const toolArgs = (block.input as Record<string, unknown>) ?? {};
            const startedAt = new Date();
            pendingTools.set(block.id, { tool: block.name, args: toolArgs, startedAt, startMs: Date.now() });
            if (opts.emitText) {
              deps.emitter.emit({
                event: 'agent_tool_start',
                data: { node: nodeName, tool: block.name, args: toolArgs, toolUseId: block.id },
              });
              const argSummary = Object.keys(toolArgs).join(', ');
              emitLog(deps, nodeName, {
                category: 'tool',
                message: `Tool: ${block.name}${argSummary ? ` (${argSummary})` : ''}`,
                // Include toolUseId so the UI's persisted-log resolver can
                // exact-match this row to the streamed ToolCallRecord.
                data: { tool: block.name, args: toolArgs, toolUseId: block.id },
              });
            }
          }
        }
        localTurns++;
      } else if (message.type === 'user') {
        // tool_result blocks are delivered back to the assistant as a user
        // message in the SDK's transcript. We pair each by tool_use_id
        // with the pending start we recorded above so durationMs and the
        // final result land on the same record.
        const content = (message as any).message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'tool_result' && block.tool_use_id) {
              const pending = pendingTools.get(block.tool_use_id);
              if (!pending) continue;
              const durationMs = Date.now() - pending.startMs;
              let resultData: unknown;
              try {
                const rc = Array.isArray(block.content)
                  ? block.content.map((c: any) => c.text || '').join('')
                  : typeof block.content === 'string' ? block.content
                  : JSON.stringify(block.content);
                resultData = JSON.parse(rc);
              } catch {
                resultData = { raw: String(block.content) };
              }
              const record = buildToolCallRecord({
                tool: pending.tool,
                args: pending.args,
                result: resultData,
                durationMs,
                startedAt: pending.startedAt,
                isError: block.is_error === true,
                toolUseId: block.tool_use_id,
              });
              localToolCalls.push(record);
              pendingTools.delete(block.tool_use_id);
              if (opts.emitText) {
                deps.emitter.emit({
                  event: 'agent_tool_complete',
                  data: { node: nodeName, toolUseId: block.tool_use_id, record },
                });
              }
            }
          }
        }
      } else if (message.type === 'result') {
        localSessionId = (message as any).session_id;
        localCost = (message as any).total_cost_usd ?? null;
        localTurns = (message as any).num_turns ?? localTurns;
      } else if ((message as any).type === 'system' && (message as any).subtype === 'init') {
        // Capture the list of tools the agent was spawned with on first
        // init. Subsequent retries (JSON-extraction re-prompt, agent-
        // resume) emit their own init with the same list — keep the first
        // one for the trace.
        if (!capturedToolsAvailable) {
          const tools = (message as any).tools;
          if (Array.isArray(tools)) capturedToolsAvailable = tools as string[];
        }
      }
    }

    // Any tool_use that never got a tool_result (SDK crashed mid-flight or
    // was aborted) — flush with what we have so the log shows the attempt.
    for (const [id, pending] of pendingTools) {
      localToolCalls.push(buildToolCallRecord({
        tool: pending.tool,
        args: pending.args,
        durationMs: Date.now() - pending.startMs,
        startedAt: pending.startedAt,
        isError: true,
        toolUseId: id,
      }));
    }

    return { text, sessionId: localSessionId, cost: localCost, turns: localTurns, toolCalls: localToolCalls };
  };

  // Accumulator for every tool call across the main turn + any extraction
  // retry turns below. Persisted on the NodeTrace so the UI can render a
  // per-execution tool log.
  const allToolCalls: ToolCallRecord[] = [];

  // ── Initial agent call (with transient-error retry) ──────────────────
  // The Claude Code SDK sometimes exits with code 1 when multiple subprocesses
  // spawn in rapid succession (e.g. after a parallel fork that just completed).
  // Retry transparently with a cooldown so transient failures don't crash the
  // whole workflow execution.
  const MAIN_CALL_MAX_ATTEMPTS = 3;
  let initial: Awaited<ReturnType<typeof callAgent>> | null = null;
  let lastMainError: Error | null = null;
  for (let attempt = 1; attempt <= MAIN_CALL_MAX_ATTEMPTS; attempt++) {
    // Short-circuit on cancel. The abort signal is fired by the engine's
    // cancelExecution path; if it's already set we must NOT respawn the
    // subprocess — that would just produce another exit-143 that gets
    // retried in a loop. Emit a clear "cancelled by user" log and throw
    // a stable sentinel the engine catch recognises as a cancel.
    if (deps.abortSignal?.aborted) {
      emitLog(deps, nodeName, {
        level: 'warn',
        category: 'system',
        message: `[agent-call] Cancelled by user before attempt ${attempt}`,
      });
      throw new Error('Execution cancelled');
    }
    try {
      if (attempt > 1) {
        emitLog(deps, nodeName, {
          level: 'warn',
          category: 'system',
          message: `[agent-call] Transient error on attempt ${attempt - 1}, retrying after 5s cooldown: ${lastMainError?.message ?? 'unknown'}`,
        });
        await new Promise(r => setTimeout(r, 5000));
      }
      initial = await callAgent({
        promptText: prompt,
        resumeSession: resume,
        emitText: true,
      });
      break; // success
    } catch (err) {
      lastMainError = err instanceof Error ? err : new Error(String(err));
      const msg = lastMainError.message;

      // Cancel path: if the abort fired mid-call the subprocess was
      // SIGTERM'd and exits with code 143. Treat that as a cancel, not a
      // transient error — no retry, no scary log, just unwind cleanly.
      // Must check the signal BEFORE the transient regex, because the
      // regex below deliberately excludes 143 and would fall through to
      // re-throw; but we want a specific "Execution cancelled" message
      // for the engine's catch block to classify this as status=cancelled.
      if (deps.abortSignal?.aborted || /exited with code 143|SIGTERM/i.test(msg)) {
        emitLog(deps, nodeName, {
          level: 'warn',
          category: 'system',
          message: `[agent-call] Cancelled by user on attempt ${attempt} (subprocess exited with SIGTERM)`,
        });
        throw new Error('Execution cancelled');
      }

      // Only retry transient SDK errors — not genuine logic errors or
      // cancels. The `\b` boundary prevents "exited with code 143" from
      // being matched as a substring of "exited with code 1".
      const isTransient = /exited with code 1\b|ECONNRESET|ETIMEDOUT|fetch failed|socket hang up/i.test(msg);
      if (!isTransient || attempt === MAIN_CALL_MAX_ATTEMPTS) {
        throw lastMainError;
      }
    }
  }
  if (!initial) {
    throw lastMainError ?? new Error('Agent call failed after retries');
  }
  allToolCalls.push(...initial.toolCalls);

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
  const requiredOutputs = outputKeys(nodeDef.outputs).filter(k => !k.startsWith('__'));
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
      // Cancel short-circuit — don't respawn the agent to re-ask for JSON
      // if the user already cancelled. Stable sentinel so the engine
      // catch block classifies this as status=cancelled.
      if (deps.abortSignal?.aborted) {
        throw new Error('Execution cancelled');
      }
      emitLog(deps, nodeName, {
        level: 'warn',
        category: 'system',
        message: `[extraction] Agent-resume retry ${attempt}/${MAX_AGENT_RETRIES} — asking agent to resend in expected JSON format (5s cooldown first)`,
      });

      // 5 second cooldown — gives the Claude Code SDK subprocess time to
      // fully clean up from the previous call. Fresh spawn under load can
      // exit with code 1 if prior subprocess state still holds ~/.claude/ locks.
      await new Promise(r => setTimeout(r, 5000));

      const reprompt = `Your previous response did not include the required output fields in a parseable JSON format. Please respond again with ONLY a JSON code block.

Required format (all keys must be present):
\`\`\`json
{
${requiredOutputs.map(k => `  "${k}": ...`).join(',\n')}
}
\`\`\`

Rules:
- Include ALL keys listed above.
- Use null if you genuinely don't have a value for a field.
- Do not rename keys.
- Do not include any explanation before or after the JSON code block.

OR — if you genuinely cannot produce the required outputs because the task is impossible, the input is broken, or you need human clarification, return an auto-gate signal instead:
\`\`\`json
{
  "__action": "stop" | "skip" | "clarify",
  "__reason": "brief explanation of why",
  "__clarify_action": "retry" | "continue"
}
\`\`\`
Use auto-gate only if the original prompt's workflow context explicitly allowed it for this node.`;

      try {
        const retry = await callAgent({
          promptText: reprompt,
          resumeSession: sessionId,
          emitText: false,
        });

        if (retry.sessionId) sessionId = retry.sessionId;
        if (retry.cost != null) actualCost = (actualCost ?? 0) + retry.cost;
        turns += retry.turns;
        allToolCalls.push(...retry.toolCalls);

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
        const msg = (err as Error).message;
        // If the agent-resume subprocess was SIGTERM'd by our cancel
        // path, propagate as cancel instead of "failed: exit 143".
        if (deps.abortSignal?.aborted || /exited with code 143|SIGTERM/i.test(msg)) {
          throw new Error('Execution cancelled');
        }
        emitLog(deps, nodeName, {
          level: 'warn',
          category: 'system',
          message: `[extraction] Agent-resume retry ${attempt} failed: ${msg}`,
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
    if (deps.abortSignal?.aborted) {
      throw new Error('Execution cancelled');
    }
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

  // ── Phase 2: build the trace enrichments bundle ────────────────────────
  // All optional; engine stitches them into NodeTrace at save time.
  // Re-derive the settings the same way callAgent does internally (see
  // line ~527). These aren't visible in the outer scope so we recompute
  // them here from nodeDef + role.
  const override2 = nodeDef.agentOverrides ?? {};
  const rawModel2 = (override2.model ?? role?.model) ?? 'sonnet';
  const resolvedModel2 = normalizeModelAlias(rawModel2) ?? rawModel2;
  const resolvedEffort2 = override2.reasoningEffort ?? role?.reasoningEffort;
  const resolvedPlanMode2 = override2.planMode ?? role?.planMode ?? false;
  const systemPromptMode2: 'append' | 'custom' =
    process.env.ALLEN_SYSTEM_PROMPT_MODE === 'custom' ? 'custom' : 'append';
  const explicitMode = process.env.ALLEN_AGENT_EXECUTION_MODE;
  const isEphemeral2 = (() => {
    if (!cwd) return false;
    const n = cwd.replace(/\/+$/, '');
    return n === '/tmp' || n.startsWith('/tmp/') ||
      n === '/var/tmp' || n.startsWith('/var/tmp/') ||
      n === '/private/tmp' || n.startsWith('/private/tmp/');
  })();
  const executionMode2: 'sdk' | 'cli' =
    explicitMode === 'cli' ? 'cli' :
    explicitMode === 'sdk' ? 'sdk' :
    isEphemeral2 ? 'sdk' : 'cli';

  const overrideSources: Partial<Record<'model' | 'reasoningEffort' | 'planMode', 'node' | 'agent-default'>> = {};
  if (override2.model !== undefined) overrideSources.model = 'node';
  else if (role?.model !== undefined) overrideSources.model = 'agent-default';
  if (override2.reasoningEffort !== undefined) overrideSources.reasoningEffort = 'node';
  else if (role?.reasoningEffort !== undefined) overrideSources.reasoningEffort = 'agent-default';
  if (override2.planMode !== undefined) overrideSources.planMode = 'node';
  else if (role?.planMode !== undefined) overrideSources.planMode = 'agent-default';

  const runtimeContext: NodeResult['runtimeContext'] = {
    cwd,
    executionMode: executionMode2,
    systemPromptMode: systemPromptMode2,
    resolvedModel: resolvedModel2,
    reasoningEffort: resolvedEffort2,
    planMode: resolvedPlanMode2,
    mcpServerNames: mcpServers ? Object.keys(mcpServers) : [],
  };

  const agentOverrides: NodeResult['agentOverrides'] = {
    model: resolvedModel2,
    reasoningEffort: resolvedEffort2,
    planMode: resolvedPlanMode2,
    sources: overrideSources,
  };

  // Gate decision — derived from the parsed __action in outputs (if any).
  const gateActionRaw = (outputs as Record<string, unknown>).__action;
  const gateDecision: NodeResult['gateDecision'] | undefined =
    gateActionRaw === 'stop' || gateActionRaw === 'skip' || gateActionRaw === 'clarify'
      ? {
          action: gateActionRaw,
          reason: String((outputs as Record<string, unknown>).__reason ?? ''),
          clarifyAction: (outputs as Record<string, unknown>).__clarify_action as 'retry' | 'continue' | undefined,
          clarifyFields: Array.isArray((outputs as Record<string, unknown>).__clarify_fields)
            ? ((outputs as Record<string, unknown>).__clarify_fields as unknown[]).map((f) =>
                typeof f === 'object' && f !== null && 'name' in f
                  ? String((f as Record<string, unknown>).name)
                  : String(f),
              )
            : undefined,
        }
      : undefined;

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
    toolCalls: allToolCalls,
    // Enrichments
    toolsAvailable: capturedToolsAvailable,
    runtimeContext,
    agentOverrides,
    gateDecision,
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
    // Cancel short-circuit. A code node in a retry loop must NOT be
    // re-invoked after user cancel — the engine's cancelExecution has
    // already signalled we're unwinding. Throw the stable sentinel so
    // the engine catch classifies this as status=cancelled, not failed.
    if (deps.abortSignal?.aborted) {
      throw new Error('Execution cancelled');
    }
    try {
      if (attempt > 0) {
        const delayMs = calculateBackoff(nodeDef, attempt);
        await sleep(delayMs);
      }
      const outputs = await fn(config, state, {
        emitter: deps.emitter,
        db: deps.db,
        executionId: deps.executionId,
        services: deps.services,
      });
      return {
        outputs,
        cost: { actual: null, estimated: 0, method: 'estimated' },
        durationMs: Date.now() - start,
      };
    } catch (err: unknown) {
      lastError = err instanceof Error ? err : new Error(String(err));
      // If the abort fired mid-call, the thrown error is the cancel —
      // don't retry, just propagate the cancel sentinel.
      if (deps.abortSignal?.aborted) {
        throw new Error('Execution cancelled');
      }
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
