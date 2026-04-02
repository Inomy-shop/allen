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

export interface NodeDef {
  type?: NodeType;               // default: 'agent'
  role?: string;                 // for agent nodes
  prompt?: string;               // for agent/human nodes
  outputs?: string[];
  output_format?: OutputFormat;
  output_extraction?: Record<string, string>;
  resume_on_retry?: boolean;
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

export interface InputFieldDef {
  type: string;
  required?: boolean;
  default?: unknown;
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

// ── Role ────────────────────────────────────────────────────────────────────

export interface RoleDef {
  system: string;
  model?: string;
  tools?: string[];
  icon?: string;
  color?: string;
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
  role?: string;
  inputState: Record<string, unknown>;
  renderedPrompt?: string;
  output: Record<string, unknown>;
  rawResponse?: string;
  activity: ActivityEntry[];
  sessionId?: string;
  cost: CostInfo;
  durationMs: number;
  startedAt: Date;
  completedAt?: Date;
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
  createdAt: Date;
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
  currentNodes: string[];
  completedNodes: string[];
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
  | 'parallel_joined';

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

export type BuiltInFunction = (
  config: Record<string, unknown>,
  state: Record<string, unknown>,
  emitter: EngineEventEmitter,
) => Promise<Record<string, unknown>>;
