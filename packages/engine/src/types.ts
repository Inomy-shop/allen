// ── Node Types ──────────────────────────────────────────────────────────────

export type NodeType = 'agent' | 'code' | 'human' | 'workflow' | 'condition';

export type OutputFormat = 'json' | 'freeform';

export type OnFailure = 'fail' | 'skip' | 'fallback';

export type BackoffStrategy = 'exponential' | 'linear' | 'fixed';

/**
 * Auto-gate actions that any agent node can return to control graph flow.
 * - 'continue': normal behavior — follow edges (default if not returned)
 * - 'stop': task is already done or not needed — exit graph gracefully
 * - 'skip': skip remaining nodes — exit graph gracefully
 * - 'clarify': pause and ask human for more information
 */
export type AutoGateAction = 'continue' | 'stop' | 'skip' | 'clarify';

export type ClarifyAction = 'retry' | 'continue';

/**
 * Node outputs declaration. Object form — every output key MUST include a
 * description that explains what the value should contain. The descriptions
 * are injected into the agent's RESPONSE FORMAT block so the model knows
 * exactly what each key should produce. Values may be nested.
 *
 *   outputs:
 *     completeness: "fully_complete if all requirements MET, else partial"
 *     missing_items: "list of actionable file:line items when partial"
 */
export type OutputsSpec = Record<string, string>;

/**
 * Non-destructive per-node override of an agent's model/reasoning/plan settings.
 * Lives on the workflow-node doc only — never mutates the agent document.
 * All fields optional; `null` means "explicitly inherit parent" and is semantically
 * equivalent to omitting the field.
 */
export interface AgentOverrides {
  provider?: 'claude-cli' | 'codex' | null;
  model?: string | null;
  reasoningEffort?: 'off' | 'low' | 'medium' | 'high' | 'max' | null;
  planMode?: boolean | null;
}

export interface NodeDef {
  type?: NodeType;               // default: 'agent'
  agent?: string;                // for agent nodes
  /** Per-node override of the referenced agent's model/effort/planMode. Ephemeral. */
  agentOverrides?: AgentOverrides;
  prompt?: string;               // for agent/human nodes
  outputs?: OutputsSpec;
  output_format?: OutputFormat;
  output_extraction?: Record<string, string>;
  /** Resume the agent's prior session on retry. Default: true. Set to false for stateless nodes (e.g. reviewers) that should start fresh each run. */
  resume_on_retry?: boolean;
  /** Optional template for the persisted LLM session key. Defaults to the node name. Use loop state here when repeated visits to the same node should not share a session. */
  session_key?: string;
  timeout?: number;              // seconds

  // code nodes
  function?: string;
  config?: Record<string, unknown>;

  // human nodes
  fields?: HumanField[];
  timeout_action?: 'cancel' | 'default';

  // workflow nodes
  workflow?: string;
  input_map?: Record<string, string>;
  output_map?: Record<string, string>;

  // condition nodes
  conditions?: ConditionDef[];

  // retry config (code nodes)
  retries?: number;
  backoff?: BackoffStrategy;
  backoff_base_ms?: number;
  retry_on?: string[];
  on_failure?: OnFailure;
  fallback_value?: Record<string, unknown>;
}

export interface HumanField {
  name: string;
  type: 'string' | 'text' | 'boolean' | 'number' | 'select';
  label?: string;
  required?: boolean;
  options?: string[];
  default?: unknown;
}

export interface ConditionDef {
  name: string;
  expression: string;
}

// ── Edge Types ──────────────────────────────────────────────────────────────

export type JoinPolicy = 'wait-all' | 'wait-any' | 'fail-fast';

export type MergeStrategy = 'last' | 'concat' | 'min' | 'max' | 'all' | 'any';

export interface EdgeDef {
  from: string | string[];
  to: string | string[];
  condition?: string;
  parallel?: boolean;
  join?: JoinPolicy;
  merge?: Record<string, MergeStrategy>;
  max_retries?: number;
  retry_context?: string;
}

// ── Workflow ────────────────────────────────────────────────────────────────

export interface WorkflowContext {
  requires?: string[];
  tools?: string[];
  secrets?: string[];
  concurrency?: number;
}

/**
 * Workflow input field definition — describes one input parameter that
 * the workflow takes at run time. Drives the Run Workflow form in the UI,
 * the execution service's input validation, and the intervention system's
 * `user_request` extraction (see execution.service.ts).
 *
 * The `widget` field is a UI hint. If omitted, the UI picks a default
 * widget based on `type` + the field name.
 */
export interface InputFieldDef {
  /**
   * Data type. The engine only really distinguishes `boolean` vs
   * everything-else — string / number / object are all stored as-is.
   */
  type: 'string' | 'boolean' | 'number' | 'object' | 'array' | string;
  required?: boolean;
  default?: unknown;
  /**
   * Human-readable description. Shown as the field's placeholder in the
   * Run Workflow form and surfaced in the workflow graph's START node
   * properties panel.
   */
  description?: string;
  /**
   * Allowed values. When present, the UI renders a `<select>` dropdown
   * instead of a free-form input, regardless of `type`. Useful for
   * enums (e.g., `severity: [low, medium, high]`).
   */
  enum?: string[];
  /**
   * Explicit UI widget hint. Overrides the default widget picked from
   * `type`. One of:
   *   - `text`         — single-line text input
   *   - `textarea`     — multi-line text area (for long prose like user_request / bug_report)
   *   - `checkbox`     — boolean toggle (auto-picked for type: boolean)
   *   - `select`       — dropdown (auto-picked when `enum` is present)
   *   - `repo_picker`  — repo selector populated from registered repos
   *   - `number`       — numeric input (auto-picked for type: number)
   *
   * If omitted, the UI falls back to type-based defaults. If a hint is
   * present but doesn't match the value type, the UI uses the hint anyway
   * (the user knows what they want).
   */
  widget?: 'text' | 'textarea' | 'checkbox' | 'select' | 'repo_picker' | 'number';
  /**
   * Placeholder text for the form input. Falls back to `description`
   * when not set.
   */
  placeholder?: string;
  /**
   * Label for the form input. Falls back to the field's name (with
   * underscores replaced by spaces) when not set.
   */
  label?: string;
  /**
   * For number inputs. Inclusive bounds.
   */
  min?: number;
  max?: number;
}

export interface WorkflowDef {
  name: string;
  description?: string;
  version?: number;
  context?: WorkflowContext;
  input?: Record<string, InputFieldDef>;
  nodes: Record<string, NodeDef>;
  edges: EdgeDef[];
}

// ── Agent ───────────────────────────────────────────────────────────────────

export type AgentProvider = 'claude' | 'codex';

export interface AgentDef {
  system: string;
  model?: string;
  provider?: AgentProvider;  // default: 'claude'
  tools?: string[];
  icon?: string;
  color?: string;
  /** 'team' = orchestrator agent, 'technical' = execution agent */
  type?: 'team' | 'technical';
  displayName?: string;
  personality?: string;
  capabilities?: string[];
  canDelegateTo?: string[];
  canTrigger?: string[];
  /** Default reasoning effort for this agent. Can be overridden per node via `agentOverrides`. */
  reasoningEffort?: 'off' | 'low' | 'medium' | 'high' | 'max';
  /** Default plan-mode flag for this agent. Claude-only; silently ignored for Codex. */
  planMode?: boolean;
  /**
   * Absolute filesystem path the agent should run in when the caller
   * doesn't provide an explicit cwd. Populated for agents imported from a
   * registered repo's `.claude/agents/*.md` files — an imported agent
   * auto-runs in its source repo unless the workflow overrides `worktree_path`.
   */
  sourceRepoPath?: string;
}

// ── Router ──────────────────────────────────────────────────────────────────

export interface RouterRule {
  match: string[];
  has_input?: string[];
  workflow: string;
}

export interface RouterConfig {
  rules: RouterRule[];
  fallback: string;
}

// ── Execution ───────────────────────────────────────────────────────────────

export type ExecutionStatus =
  | 'queued'
  | 'running'
  | 'waiting_for_input'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type NodeStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'skipped';

export interface NodeTrace {
  node: string;
  attempt: number;
  status: NodeStatus;
  type: NodeType;
  agent?: string;
  inputState: Record<string, unknown>;
  renderedPrompt?: string;
  output: Record<string, unknown>;
  rawResponse?: string;
  activity: ActivityEntry[];
  sessionId?: string;
  sessionKey?: string;
  cost: CostInfo;
  durationMs: number;
  startedAt: Date;
  completedAt?: Date;
  /** Every tool invocation the agent made during this node attempt —
   *  captured from both Claude SDK and Codex CLI providers. See
   *  ./tool-call.ts for the record shape. */
  toolCalls?: import('./tool-call.js').ToolCallRecord[];

  // ── Phase 2 enrichments (all optional — older traces render gracefully) ──

  /** Why this attempt was triggered. `undefined` for attempt 1 of the initial
   *  run. On retry rows, classifies the cause so the UI can surface it. */
  retryReason?:
    | 'transient'          // SDK exited with a retryable error (exit 1, ETIMEDOUT, …)
    | 'extraction-failed'  // output didn't match required JSON shape
    | 'gate-clarify'       // agent asked for clarification via __action:clarify
    | 'manual'             // user clicked retry-from-node
    | 'max-turns'          // SDK result.subtype === 'error_max_turns'
    | 'error-during-execution';

  /** Template placeholder → resolved value bindings, captured from
   *  renderTemplate. Helps diagnose "why is my prompt empty" without a re-run.
   *  Secrets are redacted (keys matching /secret|token|password|key/i get
   *  `status: 'redacted'` and `resolved: undefined`). */
  templateBindings?: Array<{
    placeholder: string;
    resolved: unknown;
    status?: 'missing' | 'redacted';
  }>;

  /** Full list of tool names the agent was allowed to use. UI diffs against
   *  toolCalls to show "had access to X, Y, Z but only used X". */
  toolsAvailable?: string[];

  /** Structured auto-gate decision when the node emits __action. */
  gateDecision?: {
    action: 'stop' | 'skip' | 'clarify';
    reason: string;
    clarifyAction?: 'retry' | 'continue';
    clarifyFields?: string[];
  };

  /** For condition/router nodes — the expression evaluated + its result. */
  routingDecision?: {
    expression: string;
    result: unknown;
  };

  /** Spawn-time context snapshot. Captures cwd, exec mode, resolved model,
   *  permission mode, MCP server names attached, the env keys present
   *  (names only, not values). */
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

  /** Learnings injected into the prompt for this node. Pinned to the trace
   *  so the UI can show them alongside the renderedPrompt. */
  learningsInjected?: Array<{
    id?: string;
    content: string;     // truncated to ~500 chars at write time
    contextTags?: string[];
  }>;

  /** Execution-level corrective feedback entries injected into this agent attempt. */
  feedbackInjected?: Array<{
    id: string;
    createdAt: Date;
  }>;

  /** Effective agent settings at spawn time + which layer set each. */
  agentOverrides?: {
    model?: string;
    reasoningEffort?: string;
    planMode?: boolean;
    sources: Partial<Record<'model' | 'reasoningEffort' | 'planMode', 'node' | 'agent-default'>>;
  };

  /** Per-tool-call token usage + estimated cost. Estimated because the
   *  Anthropic API doesn't expose per-tool billing; derived from the
   *  tool_result input_tokens proportion. */
  tokenUsagePerTool?: Array<{
    toolUseId: string;
    tool: string;
    inputTokens: number;
    outputTokens: number;
    estimatedCost: number;
  }>;

  /** Populated on failed/cancelled traces — short error message so the UI
   *  can show "why this node stopped" without needing a separate log lookup.
   *  Always undefined on completed traces. */
  error?: string;
}

export interface ActivityEntry {
  timestamp: Date;
  type: 'text' | 'tool_start' | 'tool_complete' | 'tool_error';
  tool?: string;
  content: string;
}

export interface CostInfo {
  actual: number | null;
  estimated: number;
  model?: string;
  turns?: number;
  method: 'sdk_reported' | 'estimated';
}

export interface Checkpoint {
  executionId: string;
  afterNode: string;
  state: Record<string, unknown>;
  sessions: Record<string, string>;
  retryCounts: Record<string, number>;
  completedNodes: string[];
  /** Per-node attempt counters. Survives splicing during retry rewinds
   *  so every node's trace rows carry a monotonically-increasing attempt
   *  number (1, 2, 3…) across the whole execution, including on resume.
   *  Absent on older checkpoints — engine treats missing as {}. */
  nodeAttempts?: Record<string, number>;
  createdAt: Date;
}

export interface WorkflowFeedbackEntry {
  id: string;
  content: string;
  /** Agent node names this feedback applies to. Missing/empty means all agent nodes. */
  targetNodes?: string[];
  createdAt: Date;
  createdBy?: string;
}

// ── Execution State (runtime) ───────────────────────────────────────────────

export interface ExecutionState {
  id: string;
  workflowId: string;
  workflowName: string;
  workflowVersion: number;
  status: ExecutionStatus;
  input: Record<string, unknown>;
  state: Record<string, unknown>;
  sessions: Record<string, string>;
  retryCounts: Record<string, number>;
  feedbackEntries?: WorkflowFeedbackEntry[];
  currentNodes: string[];
  completedNodes: string[];
  /** Per-node attempt counters, monotonically increasing across the whole
   *  execution. Independent of completedNodes (which gets spliced during
   *  retry rewinds) — so every node's trace rows carry the right attempt
   *  number even when the node is downstream of a retry target. */
  nodeAttempts: Record<string, number>;
  failedNode?: string;
  errorMessage?: string;
  cost: { actual: number | null; estimated: number };
  durationMs: number;
  worktreePath?: string;
  startedAt: Date;
  completedAt?: Date;
}

// ── SSE Events ──────────────────────────────────────────────────────────────

export type SSEEventType =
  | 'execution_started'
  | 'execution_completed'
  | 'execution_failed'
  | 'node_started'
  | 'node_completed'
  | 'node_failed'
  | 'node_retrying'
  | 'agent_text'
  | 'agent_tool_start'
  | 'agent_tool_complete'
  | 'input_required'
  | 'input_received'
  | 'parallel_started'
  | 'parallel_branch_done'
  | 'parallel_joined'
  | 'execution_log';

// ── Execution Log ──────────────────────────────────────────────────────────

export type LogCategory = 'agent' | 'tool' | 'condition' | 'routing' | 'system' | 'gate';
export type LogLevel = 'info' | 'debug' | 'warn' | 'error';

export interface ExecutionLog {
  executionId: string;
  timestamp: Date;
  level: LogLevel;
  category: LogCategory;
  node?: string;
  message: string;
  data?: unknown;
}

export interface SSEEvent {
  event: SSEEventType;
  data: Record<string, unknown>;
}

// ── Event Emitter Interface ─────────────────────────────────────────────────

export interface EngineEventEmitter {
  emit(event: SSEEvent): void;
}

// ── Validation ──────────────────────────────────────────────────────────────

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

// ── Built-in Function ───────────────────────────────────────────────────────

/**
 * Context passed to built-in functions at execution time.
 * `db` is available when the engine runs with a MongoDB connection (normal
 * server path); offline runs may omit it.
 */
/**
 * In-process service hooks the host (normally the server) can pass into the
 * engine so built-ins can reach infrastructure without looping back through
 * HTTP. Kept structural so the engine stays decoupled from server types.
 */
export interface EngineServices {
  workspaces?: {
    create: (payload: {
      repoId: string;
      repoName: string;
      repoPath: string;
      branch: string;
      baseBranch: string;
      name: string;
    }) => Promise<Record<string, unknown>>;
    get: (id: string) => Promise<Record<string, unknown> | null>;
  };
  /** Auto-capture hook — called after a node completes so the engine can
   *  file eligible outputs (markdown/json strings) as user-visible
   *  artifacts without workflow authors scaffolding upload_file calls.
   *  Implementation lives in the server process; engine stays decoupled. */
  artifacts?: {
    save: (input: {
      rootType: 'chat' | 'workflow' | 'agent';
      rootId: string;
      filename: string;
      content: string;
      contentType?: 'markdown' | 'json' | 'csv' | 'text' | 'code' | 'binary';
      description?: string;
      overwrite?: boolean;
      spawnContext?: {
        originType: 'chat' | 'workflow_node' | 'spawn_agent' | 'standalone' | 'system';
        nodeName?: string;
        agentName?: string;
        agentExecutionId?: string;
        parentId?: string;
      };
    }) => Promise<{ artifactId: string; url: string }>;
    /** List artifacts filed under this run for prompt injection — the
     *  engine injects a short summary of upstream artifacts into every
     *  downstream agent's system prompt so agents can decide to fetch
     *  full content via the MCP tool when templated state is truncated. */
    listForRoot?: (input: {
      rootType: 'chat' | 'workflow' | 'agent';
      rootId: string;
      limit?: number;
    }) => Promise<Array<{
      artifactId: string;
      filename: string;
      relativePath: string;
      contentType: string;
      sizeBytes: number;
      nodeName?: string;
    }>>;
  };
}

export interface BuiltInContext {
  emitter: EngineEventEmitter;
  db?: import('mongodb').Db;
  executionId?: string;
  services?: EngineServices;
}

export type BuiltInFunction = (
  config: Record<string, unknown>,
  state: Record<string, unknown>,
  ctx: BuiltInContext,
) => Promise<Record<string, unknown>>;

// ── Learning System ────────────────────────────────────────────────────────

export type LearningType = 'fact' | 'pattern' | 'mistake' | 'preference' | 'skill' | 'optimization';

/**
 * 'agent' — injected into agent prompts to improve node execution quality
 * 'system' — shown to humans/engine for workflow design, model selection, input schema improvements
 *            NEVER injected into agent prompts
 */
export type LearningTarget = 'agent' | 'system';

export interface Learning {
  _id?: any;
  content: string;
  type: LearningType;
  target: LearningTarget;  // who this learning is for
  tags: string[];
  scope: {
    level: 'global' | 'workflow' | 'context' | 'agent' | 'node_pattern';
    workflowName?: string;
    contextTags?: string[];
    agentName?: string;
    nodePattern?: string;
  };
  source: {
    executionId: string;
    nodeName: string;
    workflowName: string;
    sourceType: 'retry_delta' | 'auto_gate' | 'human_correction' | 'agent_explicit' | 'post_execution_review' | 'manual';
    timestamp: Date;
  };
  confidence: number;
  confirmations: number;
  contradictions: number;
  usageCount: number;
  lastUsedAt?: Date;
  lastConfirmedAt?: Date;
  validFrom: Date;
  supersededBy?: any;
  supersededAt?: Date;
  tokenCount: number;
  status: 'active' | 'archived' | 'superseded' | 'evolved';
  evolvedAt?: Date;
  evolvedIntoAgent?: string;
  createdAt: Date;
  updatedAt: Date;
}
