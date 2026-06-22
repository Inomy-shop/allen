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
import { normalizeClaudeUsage, aggregateTokenUsage, type TokenUsageInfo } from './token-usage.js';
import { renderTemplate } from './template.js';
import { extractOutputs, buildOutputInstruction, outputKeys } from './output-extractor.js';
import { evaluateCondition } from './condition-parser.js';
import { executeCodexNode } from './codex-executor.js';
import { buildToolCallRecord, type ToolCallRecord } from './tool-call.js';
import { normalizeModelAlias } from './model-alias.js';
import { sanitizeErrorSummary } from './model-recovery.js';
import { buildCostInfo } from './cost-calculator.js';
import { hasRepoContextLoadingGuidance, withArtifactsGuidance, withMandatoryRepoContext, withNonInteractiveGuidance, withRepoContextLoadingGuidance } from './agent-file-writer.js';
import { withRepoContextUsageOutput } from './repo-context-usage.js';
import { renderClarificationResumePrompt, renderHumanIntervention, renderHumanResumePrompt, renderResumeContextPrompt, renderReviewFeedbackRetryPrompt } from './human-intervention.js';
import type { MaterializedAgentFileMetadata } from './cli-runner.js';
import { statSync, mkdirSync } from 'node:fs';

/** Agent-safe fallback cwd. Kept in sync with chat-providers.ts's
 * AGENT_FALLBACK_CWD — duplicated here because the engine package can't
 * import from the server package. Never fall back to process.cwd() because
 * that's the server's source tree. */
const AGENT_FALLBACK_CWD = '/tmp/allen';

export const MAIN_AGENT_CALL_MAX_ATTEMPTS = 2;
const AGENT_RETRY_DIAGNOSTIC_LIMIT = 8;

export function redactAgentRetryDiagnostic(input: string): string {
  return sanitizeErrorSummary(input)
    .replace(/(api\s*key\s*[:=]\s*)([^\s,;]+)/gi, '$1<REDACTED>')
    .replace(/(key\s*[:=]\s*)(sk-[^\s,;]+)/gi, '$1<REDACTED>')
    .replace(/([A-Za-z0-9_-]{6})[A-Za-z0-9_-]{12,}([A-Za-z0-9_-]{4})/g, '$1…$2');
}

function compactAgentRetryDiagnostic(input: string): string {
  return redactAgentRetryDiagnostic(input.replace(/\s+/g, ' ').trim()).slice(0, 600);
}

function isRetryableAgentFailure(message: string, diagnostics: string[]): boolean {
  const evidence = [message, ...diagnostics].join('\n');
  return /exited with code 1\b|ECONNRESET|ETIMEDOUT|fetch failed|socket hang up/i.test(message) ||
    /\b401\b.*\b(auth|authentication|unauthori[sz]ed|api\s*key|credential)/i.test(evidence) ||
    /\b(auth|authentication|unauthori[sz]ed|api\s*key|credential).*\b401\b/i.test(evidence) ||
    /\bauthentication\s+(fails?|failed|error)\b/i.test(evidence) ||
    /\binvalid\s+(api\s*)?key\b/i.test(evidence) ||
    /\bapi\s*key\b[^\n.]{0,120}\binvalid\b/i.test(evidence) ||
    /\binvalid\s+model\b/i.test(evidence) ||
    /\bmodel\s+not\s+found\b/i.test(evidence) ||
    /\bmodel\s+unavailable\b/i.test(evidence) ||
    /\bunknown\s+model\b/i.test(evidence) ||
    /\bunsupported\s+model\b/i.test(evidence) ||
    /\bmodel\s+is\s+not\s+supported\b/i.test(evidence);
}

export function buildAgentRetryExhaustedError(args: {
  attempts: number;
  lastError: Error;
  latestDiagnostics?: string[];
}): Error {
  const latestDiagnostics = (args.latestDiagnostics ?? [])
    .map(compactAgentRetryDiagnostic)
    .filter(Boolean)
    .slice(-AGENT_RETRY_DIAGNOSTIC_LIMIT);
  const lastMessage = compactAgentRetryDiagnostic(args.lastError.message || 'unknown');
  const details = latestDiagnostics.length > 0
    ? ` Latest diagnostic logs: ${latestDiagnostics.join(' | ')}`
    : '';
  const error = new Error(`_RETRY_EXHAUSTED Agent call failed after ${args.attempts} attempts. Last error: ${lastMessage}.${details}`);
  (error as Error & { cause?: unknown }).cause = args.lastError;
  (error as Error & { diagnosticEvidence?: string }).diagnosticEvidence = latestDiagnostics.join('\n');
  return error;
}
type ClaudeCompatibleAgentProvider = string;

function isClaudeCompatibleAgentProvider(provider: unknown): provider is ClaudeCompatibleAgentProvider {
  return typeof provider === 'string'
    && provider !== 'claude'
    && provider !== 'claude-cli' // legacy id for 'claude'
    && provider !== 'codex';
}

function isAgentProviderOverride(provider: unknown): provider is 'codex' | 'claude' | ClaudeCompatibleAgentProvider {
  return provider === 'codex' || provider === 'claude' || isClaudeCompatibleAgentProvider(provider);
}

/**
 * Resolve the session key for a node.
 *
 * Default: one session per node name, shared across all iterations of a
 * loop. Workflows that want per-iteration isolation (e.g. per-milestone)
 * declare `session_key: <template>` on the node; this renders against
 * state to produce a distinct key per iteration.
 *
 * Backwards-compatible: when `session_key` is absent (the common case),
 * returns `nodeName` exactly as before, so no existing workflow's session
 * behavior changes.
 */
export function resolveSessionKey(
  nodeName: string,
  nodeDef: NodeDef,
  state: Record<string, unknown>,
): string {
  if (!nodeDef.session_key) return nodeName;
  try {
    const rendered = renderTemplate(nodeDef.session_key, state).trim();
    return rendered || nodeName;
  } catch {
    return nodeName;
  }
}

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

export interface NodeExecutorDeps {
  agents: Record<string, AgentDef>;
  builtIns: Record<string, BuiltInFunction>;
  workflows: Record<string, WorkflowDef>;
  emitter: EngineEventEmitter;
  runWorkflow: (workflow: WorkflowDef, input: Record<string, unknown>) => Promise<Record<string, unknown>>;
  executionId?: string;
  nodeContext?: string;
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
  };
  /** Accumulated post-run feedback for this workflow execution. */
  feedbackContext?: string;
  db?: import('mongodb').Db;
  /** In-process service hooks exposed to built-ins (see EngineServices). */
  services?: import('./types.js').EngineServices;
  /** Abort signal — set by engine on cancel, checked/used by node executors to kill processes */
  abortSignal?: AbortSignal;
  /**
   * Optional discoverer that returns the full list of `mcp__<server>__<tool>`
   * names registered in the runtime. When the agent's authored `tools`
   * allowlist is non-empty, Claude Code treats it as a hard cap and
   * silently strips every MCP tool not in the list — the agent ends up
   * unable to see Linear / Postgres / GitHub MCPs even though their
   * servers are loaded. Engine consumers (server-side) inject this so
   * the materialized agent file's allowlist gets the discovered MCP
   * tools appended. Optional; if missing the file is written without
   * MCP-tool injection (existing behaviour).
   */
  discoverMcpToolNames?: () => Promise<string[]>;
  /** Resolved Claude Code executable path for CLI-mode workflow agents. */
  claudeCodeExecutable?: string;
  /**
   * Optional provider-specific env builder for Claude-compatible providers.
   * Server callers use this to resolve desktop/runtime secrets without the
   * engine package importing server runtime config.
   */
  buildClaudeCompatibleEnvOverlay?: (provider: ClaudeCompatibleAgentProvider, model?: string, db?: import('mongodb').Db) => Promise<Record<string, string>>;
  /** Registry-backed alias map: alias → fullId. Optional — static defaults used when absent. */
  aliasMap?: Record<string, string>;
  /** Registry-backed per-MTok cost map, keyed by alias and fullId. Optional — cost falls back to the provider-reported figure when absent. */
  costMap?: Record<string, import('./types.js').ModelCostInfo>;
}

function resolveExternalMcpServers(
  nodeDef: NodeDef,
  role: AgentDef | undefined,
): string[] {
  const override = nodeDef.agentOverrides?.externalMcpServers;
  if (override !== undefined) return Array.isArray(override) ? override : [];
  const agentDefault = role?.externalMcpServers;
  return Array.isArray(agentDefault) ? agentDefault : [];
}

function resolveDisabledMcpTools(
  nodeDef: NodeDef,
  role: AgentDef | undefined,
): Record<string, string[]> {
  const override = nodeDef.agentOverrides?.disabledMcpTools;
  const raw = override !== undefined ? override : role?.disabledMcpTools;
  const result: Record<string, string[]> = {};
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [server, tools] of Object.entries(raw)) {
      if (Array.isArray(tools)) result[server] = tools.filter((name): name is string => typeof name === 'string' && name.length > 0);
    }
  }
  const legacyOverride = nodeDef.agentOverrides?.disabledAllenMcpTools;
  const legacyAllen = legacyOverride !== undefined ? legacyOverride : role?.disabledAllenMcpTools;
  if (Array.isArray(legacyAllen)) {
    result.allen = [...new Set([...(result.allen ?? []), ...legacyAllen.filter((name): name is string => typeof name === 'string' && name.length > 0)])];
  }
  return result;
}

function filterExternalMcpToolNames(
  toolNames: string[],
  externalServerNames: string[] | undefined,
): string[] {
  if (externalServerNames === undefined) return toolNames;
  const allowed = new Set(externalServerNames);
  return toolNames.filter((name) => {
    const parts = name.split('__');
    return parts.length >= 3 && parts[0] === 'mcp' ? allowed.has(parts[1]) : false;
  });
}

export interface NodeResult {
  outputs: Record<string, unknown>;
  rawResponse?: string;
  /**
   * The actual prompt sent to the agent for this attempt. Set by both
   * `executeAgentNode` and `executeCodexNode`. The engine persists this on
   * the trace's `renderedPrompt` field. Without it, the engine falls back
   * to re-rendering `nodeDef.prompt` against state — which always produces
   * the full first-run prompt and misses retry/forward shapes, making the
   * UI's "Prompt" tab lie about what the agent actually received on
   * retries. See engine.ts trace-save sites.
   */
  prompt?: string;
  sessionId?: string;
  /**
   * Resolved session key used to track this run's SDK session in
   * `exec.sessions`. Equal to nodeName for nodes without `session_key`;
   * a rendered template (e.g. "milestone_implementer:m2") otherwise.
   * Engine uses this when persisting sessionId so per-iteration nodes
   * get isolated sessions.
   */
  sessionKey?: string;
  cost: CostInfo;
  /** Aggregate token usage for this node across all turns.
   *  Null when the provider did not report usage data. */
  tokenUsage?: TokenUsageInfo | null;
  /** Provider the node's agent ran on. Persisted on the trace so usage
   *  aggregations can group by provider. Unset for non-agent nodes. */
  provider?: string;
  /** For workflow nodes — the child execution id this node ran. The child's
   *  cost stays on the child's own traces; this is just the tree link. */
  childExecutionId?: string;
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
    systemPromptMode?: 'append' | 'custom' | 'prompt-prefix';
    repoContextLoadingGuidancePresent?: boolean;
    repoContextLoadingGuidanceInjected?: boolean;
    mandatoryRepoContextInjected?: boolean;
    mandatoryRepoContextInjectedCount?: number;
    mandatoryRepoContextSkippedProviderNativeCount?: number;
    mandatoryRepoContextTargetLayer?: string;
    materializedAgentFile?: {
      subagentName: string;
      path: string;
      sha256: string;
      byteLength: number;
      containsMandatoryRepoContext: boolean;
      /**
       * Exact `tools:` allowlist written into the agent file's YAML
       * frontmatter. Authoritative record of what we put on disk —
       * the SDK's `system/init` tools array (captured separately as
       * `toolsAvailable`) can race with MCP `tools/list` discovery and
       * under-report. Cross-checking the two distinguishes a true
       * "MCP tool dropped" bug from an init-race artifact.
       */
      tools: string[];
      createdAt: Date;
    };
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

  /** When a recovery override causes the old session to be discarded, record which session was dropped. */
  discardedSessionId?: string;

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
  const effectiveNodeDef = type === 'agent' && deps.repoKnowledgeContext
    ? withRepoContextUsageOutput(nodeDef)
    : nodeDef;

  switch (type) {
    case 'agent': {
      const role = effectiveNodeDef.agent ? deps.agents[effectiveNodeDef.agent] : undefined;
      // Effective provider: recovery override wins, then per-node override,
      // then agent default. This lets a workflow cross-override a Claude agent
      // to run on Codex (or vice versa) without mutating the agent document.
      // Recovery overrides are execution-scoped and never persist.
      // PRD refs: AC12 (execution-scoped override), AC17 (no persistent mutation)
      const recoveryOverrides = state.__model_overrides as Record<string, import('./model-recovery.js').NodeModelOverride[]> | undefined;
      const latestRecoveryOverride = recoveryOverrides?.[nodeName]?.at(-1);
      const overrideProvider = latestRecoveryOverride?.provider ?? nodeDef.agentOverrides?.provider;
      const effectiveProvider =
        isAgentProviderOverride(overrideProvider)
          ? overrideProvider
          : role?.provider === 'codex'
            ? 'codex'
            : isClaudeCompatibleAgentProvider(role?.provider)
              ? role.provider
              : 'claude';
      if (effectiveProvider === 'codex') {
        const existingSession = sessions[resolveSessionKey(nodeName, nodeDef, state)];
        const codexResult = await executeCodexNode(
          nodeName,
          effectiveNodeDef,
          state,
          role,
          deps.emitter,
          deps.executionId ?? '',
          existingSession,
          deps.nodeContext,
          deps.feedbackContext,
          deps.abortSignal,
          deps.repoKnowledgeContext,
        );
        // Codex reports no cost of its own — price the accumulated token
        // usage with registry per-MTok rates here, where costMap is in scope.
        return {
          ...codexResult,
          provider: effectiveProvider,
          cost: buildCostInfo({
            usage: codexResult.tokenUsage,
            costInfo: codexResult.cost.model ? deps.costMap?.[codexResult.cost.model] : undefined,
            reported: null,
            model: codexResult.cost.model,
            turns: codexResult.cost.turns,
          }),
        };
      }
      const agentResult = await executeAgentNode(nodeName, effectiveNodeDef, state, sessions, deps);
      return { ...agentResult, provider: effectiveProvider };
    }
    case 'code':
      return executeCodeNode(nodeName, effectiveNodeDef, state, deps);
    case 'human':
      return executeHumanNode(nodeName, effectiveNodeDef, state, deps);
    case 'workflow':
      return executeWorkflowNode(nodeName, effectiveNodeDef, state, deps);
    case 'condition':
      return executeConditionNode(nodeName, effectiveNodeDef, state);
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
  let discardedSessionId: string | undefined;
  const role = nodeDef.agent ? deps.agents[nodeDef.agent] : undefined;
  if (nodeDef.agent && !role) {
    throw new Error(`Role not found: ${nodeDef.agent}`);
  }

  // Detect Claude-compatible API providers so queryViaCli can receive an env
  // overlay that redirects the Claude Code CLI away from Anthropic.
  // Recovery overrides (execution-scoped) take highest precedence.
  const recoveryOverridesForAgent = state.__model_overrides as Record<string, import('./model-recovery.js').NodeModelOverride[]> | undefined;
  const latestRecoveryOverrideForAgent = recoveryOverridesForAgent?.[nodeName]?.at(-1);
  const overrideProviderForAgent = latestRecoveryOverrideForAgent?.provider ?? nodeDef.agentOverrides?.provider;
  const claudeCompatibleProvider = isClaudeCompatibleAgentProvider(overrideProviderForAgent)
    ? overrideProviderForAgent
    : isClaudeCompatibleAgentProvider(role?.provider)
      ? role.provider
      : undefined;

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
  const sessionKey = resolveSessionKey(nodeName, nodeDef, state);
  const existingSession = sessions[sessionKey];
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
    }
  } else {
    // Full prompt — fresh run (first attempt) or retry with a reset session.
    const renderedTaskPrompt = nodeDef.prompt ? renderTemplate(nodeDef.prompt, state) : '';
    prompt = deps.nodeContext ? `${deps.nodeContext}\n\n${renderedTaskPrompt}` : renderedTaskPrompt;
    prompt += buildOutputInstruction(nodeDef.outputs, nodeDef.output_format);

    // Retry with no session resume — we can't rely on prior context, so
    // still append the feedback block after the full re-rendered prompt.
    if (isRetryTarget) {
      const source = (state.__retry_source as string) ?? 'previous step';
      const clarificationContext = renderClarificationResumePrompt(state.resume_context)
        || renderClarificationResumePrompt(state.human_input);
      const resumeContext = clarificationContext ? '' : renderResumeContextPrompt(state.resume_context);
      const humanContext = clarificationContext || resumeContext ? '' : renderHumanResumePrompt(state.human_input);
      const retryContext = (state.retry_context as string) ?? '';
      const context = clarificationContext || [resumeContext || humanContext, retryContext && retryContext !== resumeContext && retryContext !== humanContext ? retryContext : '']
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

  if (deps.feedbackContext) {
    prompt += deps.feedbackContext;
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
  let executionTokenUsage: TokenUsageInfo | null = null;

  // Throttle agent text logs: buffer text and emit when >= 100 chars or every 5th chunk
  let agentTextBuffer = '';
  let agentTextChunkCount = 0;
  let currentAttemptDiagnostics: string[] = [];
  const recordAttemptDiagnostic = (message: string) => {
    const compact = compactAgentRetryDiagnostic(message);
    if (!compact) return;
    currentAttemptDiagnostics.push(compact);
    if (currentAttemptDiagnostics.length > AGENT_RETRY_DIAGNOSTIC_LIMIT) {
      currentAttemptDiagnostics = currentAttemptDiagnostics.slice(-AGENT_RETRY_DIAGNOSTIC_LIMIT);
    }
  };

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
    ...(deps.repoKnowledgeContext ? {
      ALLEN_REPO_KNOWLEDGE_PACKET_ID: deps.repoKnowledgeContext.packetId,
      ALLEN_REPO_KNOWLEDGE_REPO_ID: deps.repoKnowledgeContext.repoId,
      ALLEN_REPO_KNOWLEDGE_INDEX_ID: deps.repoKnowledgeContext.indexId ?? '',
      ALLEN_REPO_KNOWLEDGE_REPO_NAME: deps.repoKnowledgeContext.repoName ?? '',
      ALLEN_REPO_KNOWLEDGE_FRESHNESS: deps.repoKnowledgeContext.indexFreshness ?? '',
    } : {}),
  };

  // Load MCP servers so agent nodes can access Linear, Postgres, etc.
  // We stamp the spawn-tree context onto the Allen MCP server's env
  // block here so it's carried as a first-class subprocess env, not left
  // to the SDK's undocumented merge behavior.
  let mcpServers: Record<string, unknown> | undefined;
  const externalMcpServers = resolveExternalMcpServers(nodeDef, role);
  const disabledMcpTools = resolveDisabledMcpTools(nodeDef, role);
  const disallowedMcpToolNames = Object.entries(disabledMcpTools).flatMap(([server, tools]) =>
    tools.map((tool) => tool.startsWith('mcp__') ? tool : `mcp__${server}__${tool}`),
  );
  try {
    const { loadAllMcpServers } = await import('./mcp-loader.js');
    if (deps.db) {
      mcpServers = await loadAllMcpServers(deps.db, {
        extraEnv: spawnContextEnv,
        externalServerNames: externalMcpServers,
      });
    }
  } catch { /* MCP not available — continue without */ }

  // Build the effective system prompt with live org chart + spawn targets
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
  // Universal artifact guidance is always visible. Repo-context guidance is
  // only visible when a repo knowledge packet exists; otherwise workflows with
  // the context provider disabled should not ask agents to load repo context.
  const repoContextLoadingGuidanceAlreadyPresent = hasRepoContextLoadingGuidance(effectiveSystem);
  effectiveSystem = withArtifactsGuidance(effectiveSystem);
  if (deps.repoKnowledgeContext) {
    effectiveSystem = withRepoContextLoadingGuidance(effectiveSystem);
    effectiveSystem = withMandatoryRepoContext(effectiveSystem, deps.repoKnowledgeContext.systemPromptBlock);
  }
  const repoContextLoadingGuidancePresent = hasRepoContextLoadingGuidance(effectiveSystem);
  const repoContextLoadingGuidanceInjected =
    !repoContextLoadingGuidanceAlreadyPresent && repoContextLoadingGuidancePresent;
  // Non-interactive guidance — workflow node runs have no live user, so
  // chat-only ask/input tools must be disabled. Goes last so it overrides
  // any stale interactive instruction that came in via role.system or the
  // org-chart block above.
  effectiveSystem = withNonInteractiveGuidance(effectiveSystem);

  // Captured across all callAgent invocations for this node. First-seen
  // init message's `tools` array — the agent's full tool allowlist. Used
  // to populate NodeResult.toolsAvailable so the UI can diff against the
  // set of tools actually invoked.
  let capturedToolsAvailable: string[] | undefined;
  let materializedAgentFile: MaterializedAgentFileMetadata | undefined;

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
    usage: TokenUsageInfo | null;
    turns: number;
    toolCalls: ToolCallRecord[];
  };
  const callAgent = async (opts: CallAgentOpts): Promise<CallAgentResult> => {
    let text = '';
    let localSessionId: string | undefined;
    let localTurns = 0;
    let localCost: number | null = null;
    let localUsage: TokenUsageInfo | null = null;
    const localToolCalls: ToolCallRecord[] = [];
    const pendingTools = new Map<string, { tool: string; args: Record<string, unknown>; startedAt: Date; startMs: number }>();

    // Resolve per-node agent settings overrides. The node may specify
    // `agentOverrides` to override the agent's default model / reasoning
    // effort / plan mode for just this node. The agent document itself is
    // read-only from here.
    //
    // Execution-scoped recovery overrides (NodeModelOverride from
    // state.__model_overrides) take highest precedence. They are set
    // by the model-recovery system when a user retries a failed node
    // with a different provider/model at execution time.
    // PRD refs: AC12 (execution-scoped override), AC17 (no persistent mutation)
    const recoveryOverrides = state.__model_overrides as Record<string, import("./model-recovery.js").NodeModelOverride[]> | undefined;
    const latestRecoveryOverride = recoveryOverrides?.[nodeName]?.at(-1);
    const override = nodeDef.agentOverrides ?? {};
    // Recovery override wins, then node-level agentOverrides, then agent default.
    const rawModel = (latestRecoveryOverride?.model ?? override.model ?? role?.model) ?? 'sonnet';
    const resolvedModel = normalizeModelAlias(rawModel, deps.aliasMap) ?? rawModel;
    const resolvedEffort = latestRecoveryOverride?.reasoningEffort ?? override.reasoningEffort ?? role?.reasoningEffort;
    const resolvedPlanMode = override.planMode ?? role?.planMode ?? false;
    /**
     * When the node is running with a recovery override that changes
     * the provider or model, AND is entering on a retry (existing
     * session from a prior attempt with a different model), discard
     * the old session so the agent starts fresh with the replacement
     * model.
     *
     * PRD refs: AC13 (fresh session after model change)
     */
    const isRecoveryRetry = latestRecoveryOverride !== undefined && latestRecoveryOverride.attempt > 0;
    // Capture discarded session id before deletion so the engine can
    // record it on the NodeTrace (PRD AC13: fresh session after model change).
    if (isRecoveryRetry) {
      // Delete the stale session so the next resume query returns
      // undefined, forcing a full fresh start.
      const prevSessionKey = resolveSessionKey(nodeName, nodeDef, state);
      if (sessions[prevSessionKey]) {
        discardedSessionId = sessions[prevSessionKey];
        delete sessions[prevSessionKey];
      }
    }

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

    // Execution mode. Claude-provider nodes default to CLI mode. Explicit
    // ALLEN_AGENT_EXECUTION_MODE=sdk is the only way to force the in-process
    // SDK path. Both modes yield the same SDKMessage stream so the consumer
    // loop below is identical.
    const explicitMode = process.env.ALLEN_AGENT_EXECUTION_MODE;
    const executionMode: 'sdk' | 'cli' =
      explicitMode === 'cli' ? 'cli' :
      explicitMode === 'sdk' ? 'sdk' :
      'cli';

    let conv: AsyncIterable<any>;
    if (executionMode === 'cli') {
      const { queryViaCli } = await import('./cli-runner.js');
      // Discover registered MCP tool names so the materialized agent
      // file's allowlist (when the agent has one) doesn't silently
      // hide every mcp__* tool. Server-side dep injection — falls back
      // to no extra injection if the host didn't wire the discoverer.
      let discoveredMcpTools: string[] = [];
      if (deps.discoverMcpToolNames) {
        try {
          discoveredMcpTools = await deps.discoverMcpToolNames();
          discoveredMcpTools = filterExternalMcpToolNames(discoveredMcpTools, externalMcpServers);
        } catch (err) {
          console.warn(`[node:${nodeName}] MCP tool discovery failed:`, (err as Error).message);
        }
      }
      // For Claude-compatible API providers, overlay credentials so the claude
      // binary redirects requests to the configured provider instead of Anthropic.
      let claudeCompatibleEnvOverlay: Record<string, string> = {};
      if (claudeCompatibleProvider) {
        if (!deps.buildClaudeCompatibleEnvOverlay) {
          throw new Error(`Claude-compatible provider ${claudeCompatibleProvider} requires buildClaudeCompatibleEnvOverlay`);
        }
        claudeCompatibleEnvOverlay = await deps.buildClaudeCompatibleEnvOverlay(claudeCompatibleProvider, resolvedModel, deps.db);
      }
      const resolvedEnv: NodeJS.ProcessEnv = (() => {
        return {
          ...process.env,
          ...spawnContextEnv,
          ...(deps.claudeCodeExecutable ? { CLAUDE_BIN: deps.claudeCodeExecutable } : {}),
          ...claudeCompatibleEnvOverlay,
        };
      })();
      conv = queryViaCli({
        agent: {
          name: nodeDef.agent ?? 'unknown',
          description: (role as any)?.description,
          system: effectiveSystem ?? '',
          model: resolvedModel,
          tools: Array.isArray((role as any)?.tools) ? (role as any).tools : undefined,
          mcpToolNames: discoveredMcpTools,
          disabledMcpTools,
          materializedNameSuffix: deps.repoKnowledgeContext?.systemPromptBlock ? `${deps.executionId ?? 'exec'}-${nodeName}-${deps.repoKnowledgeContext.packetId}` : undefined,
          includeRepoContextLoadingGuidance: Boolean(deps.repoKnowledgeContext),
        },
        prompt: effectivePrompt,
        cwd,
        model: resolvedModel,
        resume: opts.resumeSession,
        permissionMode: resolvedPlanMode ? 'plan' : 'bypassPermissions',
        env: resolvedEnv,
        mcpServers: mcpServers && Object.keys(mcpServers).length > 0 ? (mcpServers as Record<string, unknown>) : undefined,
        abortSignal: deps.abortSignal,
        onMaterializedAgentFile: (metadata) => {
          materializedAgentFile = metadata;
          emitLog(deps, nodeName, {
            level: 'info',
            category: 'system',
            message: `[claude-cli] Materialized agent file ${metadata.subagentName}`,
            data: {
              subagentName: metadata.subagentName,
              path: metadata.path,
              sha256: metadata.sha256,
              byteLength: metadata.byteLength,
              containsMandatoryRepoContext: metadata.containsMandatoryRepoContext,
              createdAt: metadata.createdAt,
            },
          });
          // Dedicated audit event — what tools we passed into the agent file.
          // Greppable prefix lets ops filter the log stream:
          //   GET /api/executions/<id>/logs?category=system  → then filter
          //   message starting with "[agent-tools]".
          // Pairs with the post-init "[agent-tools] runtime" log below so
          // file-passed vs runtime-reported can be diffed for the same node.
          emitLog(deps, nodeName, {
            level: 'info',
            category: 'system',
            message: `[agent-tools] passed to agent file (${metadata.tools.length} tools)`,
            data: {
              source: 'frontmatter',
              agent: nodeDef.agent ?? null,
              subagentName: metadata.subagentName,
              toolCount: metadata.tools.length,
              nativeCount: metadata.tools.filter((t) => !t.startsWith('mcp__')).length,
              mcpCount: metadata.tools.filter((t) => t.startsWith('mcp__')).length,
              tools: metadata.tools,
            },
          });
        },
        stderr: (chunk) => {
          const message = `[claude-cli stderr] ${chunk.slice(0, 4000)}`;
          recordAttemptDiagnostic(message);
          emitLog(deps, nodeName, { level: 'debug', category: 'system', message });
        },
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
          ...(disallowedMcpToolNames.length > 0 ? { disallowedTools: disallowedMcpToolNames } : {}),
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
                const message = agentTextBuffer.slice(0, 200);
                recordAttemptDiagnostic(`[agent] ${message}`);
                emitLog(deps, nodeName, {
                  category: 'agent',
                  level: 'debug',
                  message,
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
        const rawUsage = (message as any).usage ?? null;
        localUsage = normalizeClaudeUsage(rawUsage);
        // REQ-009 observability logs
        if (rawUsage == null) {
          emitLog(deps, nodeName, {
            level: 'debug',
            category: 'system',
            message: '[token-usage] absent — Claude SDK result message has no usage field',
          });
        } else if (localUsage === null) {
          const rawSample = JSON.stringify(rawUsage).slice(0, 400);
          emitLog(deps, nodeName, {
            level: 'warn',
            category: 'system',
            message: `[token-usage] unrecognized — Claude usage shape has no expected fields: ${rawSample}`,
          });
        } else {
          const nullFields = Object.entries(localUsage).filter(([, v]) => v === null).map(([k]) => k);
          if (nullFields.length > 0) {
            emitLog(deps, nodeName, {
              level: 'debug',
              category: 'system',
              message: `[token-usage] partial — Claude usage has null sub-fields: ${nullFields.join(', ')}`,
            });
          }
          emitLog(deps, nodeName, {
            level: 'debug',
            category: 'system',
            message: `[token-usage] claude result — inputCachedTokens: ${localUsage.inputCachedTokens}, inputNonCachedTokens: ${localUsage.inputNonCachedTokens}, outputTokens: ${localUsage.outputTokens}`,
          });
        }
      } else if ((message as any).type === 'system' && (message as any).subtype === 'init') {
        // Capture the list of tools the agent was spawned with on first
        // init. Subsequent retries (JSON-extraction re-prompt, agent-
        // resume) emit their own init with the same list — keep the first
        // one for the trace.
        if (!capturedToolsAvailable) {
          const tools = (message as any).tools;
          if (Array.isArray(tools)) {
            capturedToolsAvailable = tools as string[];
            // Audit log — what tools the SDK actually exposed at first
            // init. Pairs with the "[agent-tools] passed" log above (CLI
            // path) so ops can diff intent vs runtime for any node.
            const initTools = capturedToolsAvailable;
            emitLog(deps, nodeName, {
              level: 'info',
              category: 'system',
              message: `[agent-tools] available at runtime (${initTools.length} tools)`,
              data: {
                source: 'sdk-init',
                agent: nodeDef.agent ?? null,
                toolCount: initTools.length,
                nativeCount: initTools.filter((t) => !t.startsWith('mcp__')).length,
                mcpCount: initTools.filter((t) => t.startsWith('mcp__')).length,
                tools: initTools,
              },
            });
            // Mismatch detector — CLI path only, since SDK path has no
            // frontmatter to compare against. Catches the known SDK init
            // race (engineering-lead reported 7 vs the 88 we wrote) so
            // ops aren't left guessing whether MCP tools got dropped.
            if (materializedAgentFile && materializedAgentFile.tools.length > initTools.length) {
              const missing = materializedAgentFile.tools.filter((t) => !initTools.includes(t));
              emitLog(deps, nodeName, {
                level: 'warn',
                category: 'system',
                message: `[agent-tools] runtime tools (${initTools.length}) < frontmatter tools (${materializedAgentFile.tools.length}) — ${missing.length} entries missing from SDK init (likely race with MCP tools/list; later tool calls may still succeed)`,
                data: {
                  agent: nodeDef.agent ?? null,
                  frontmatterCount: materializedAgentFile.tools.length,
                  runtimeCount: initTools.length,
                  missingCount: missing.length,
                  missing,
                },
              });
            }
          }
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

    return { text, sessionId: localSessionId, cost: localCost, usage: localUsage, turns: localTurns, toolCalls: localToolCalls };
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
  const MAIN_CALL_MAX_ATTEMPTS = MAIN_AGENT_CALL_MAX_ATTEMPTS;
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
    currentAttemptDiagnostics = [];
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
      recordAttemptDiagnostic(`[agent-call error] ${lastMainError.message}`);
      const latestDiagnostics = [...currentAttemptDiagnostics];
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

      // Retry only provider/model/runtime errors that can plausibly be
      // resolved by a second attempt or by model-selection HITL after
      // exhaustion. Genuine task/logic errors keep their original shape.
      const isRetryable = isRetryableAgentFailure(msg, latestDiagnostics);
      if (!isRetryable) {
        throw lastMainError;
      }
      if (attempt === MAIN_CALL_MAX_ATTEMPTS) {
        throw buildAgentRetryExhaustedError({
          attempts: attempt,
          lastError: lastMainError,
          latestDiagnostics,
        });
      }
    }
  }
  if (!initial) {
    if (lastMainError) {
      throw buildAgentRetryExhaustedError({
        attempts: MAIN_CALL_MAX_ATTEMPTS,
        lastError: lastMainError,
        latestDiagnostics: currentAttemptDiagnostics,
      });
    }
    throw new Error('Agent call failed after retries');
  }
  allToolCalls.push(...initial.toolCalls);

  rawResponse = initial.text;
  sessionId = initial.sessionId;
  actualCost = initial.cost;
  executionTokenUsage = aggregateTokenUsage(executionTokenUsage, initial.usage);
  turns = initial.turns;

  // Flush remaining agent text buffer
  if (agentTextBuffer.length > 0) {
    const message = agentTextBuffer.slice(0, 200);
    recordAttemptDiagnostic(`[agent] ${message}`);
    emitLog(deps, nodeName, {
      category: 'agent',
      level: 'debug',
      message,
    });
  }

  // NOTE: do NOT read model here — the effective model (considering agentOverrides)
  // is computed in the Phase 2 block below as `resolvedModel2` and used for cost.
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
        executionTokenUsage = aggregateTokenUsage(executionTokenUsage, retry.usage);
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

  // ── Phase 2: build the trace enrichments bundle ────────────────────────
  // All optional; engine stitches them into NodeTrace at save time.
  // Re-derive the settings the same way callAgent does internally (see
  // line ~527). These aren't visible in the outer scope so we recompute
  // them here from nodeDef + role.
  const recoveryOverrides2 = state.__model_overrides as Record<string, import('./model-recovery.js').NodeModelOverride[]> | undefined;
  const latestRecoveryOverride2 = recoveryOverrides2?.[nodeName]?.at(-1);
  const override2 = nodeDef.agentOverrides ?? {};
  const rawModel2 = (latestRecoveryOverride2?.model ?? override2.model ?? role?.model) ?? 'sonnet';
  // Pass deps.aliasMap so the re-derived model matches exactly what callAgent used above.
  const resolvedModel2 = normalizeModelAlias(rawModel2, deps.aliasMap) ?? rawModel2;
  const resolvedEffort2 = latestRecoveryOverride2?.reasoningEffort ?? override2.reasoningEffort ?? role?.reasoningEffort;
  const resolvedPlanMode2 = override2.planMode ?? role?.planMode ?? false;
  const systemPromptMode2: 'append' | 'custom' =
    process.env.ALLEN_SYSTEM_PROMPT_MODE === 'custom' ? 'custom' : 'append';
  const explicitMode = process.env.ALLEN_AGENT_EXECUTION_MODE;
  const executionMode2: 'sdk' | 'cli' =
    explicitMode === 'cli' ? 'cli' :
    explicitMode === 'sdk' ? 'sdk' :
    'cli';

  const overrideSources: Partial<Record<'model' | 'reasoningEffort' | 'planMode', 'node' | 'agent-default'>> = {};
  if (latestRecoveryOverride2?.model !== undefined || override2.model !== undefined) overrideSources.model = 'node';
  else if (role?.model !== undefined) overrideSources.model = 'agent-default';
  if (latestRecoveryOverride2?.reasoningEffort !== undefined || override2.reasoningEffort !== undefined) overrideSources.reasoningEffort = 'node';
  else if (role?.reasoningEffort !== undefined) overrideSources.reasoningEffort = 'agent-default';
  if (override2.planMode !== undefined) overrideSources.planMode = 'node';
  else if (role?.planMode !== undefined) overrideSources.planMode = 'agent-default';

  const runtimeContext: NodeResult['runtimeContext'] = {
    cwd,
    executionMode: executionMode2,
    systemPromptMode: systemPromptMode2,
    repoContextLoadingGuidancePresent,
    repoContextLoadingGuidanceInjected,
    mandatoryRepoContextInjected: Boolean(deps.repoKnowledgeContext?.systemPromptBlock),
    mandatoryRepoContextInjectedCount: deps.repoKnowledgeContext?.mandatoryContextInjectedCount,
    mandatoryRepoContextSkippedProviderNativeCount: deps.repoKnowledgeContext?.mandatoryContextSkippedProviderNativeCount,
    mandatoryRepoContextTargetLayer: deps.repoKnowledgeContext?.mandatoryContextTargetLayer,
    materializedAgentFile,
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
    prompt,
    sessionId,
    sessionKey,
    cost: buildCostInfo({
      usage: executionTokenUsage,
      // resolvedModel2 is override-aware (agentOverrides.model wins over role?.model)
      // and normalized via aliasMap — it matches exactly what callAgent ran with.
      costInfo: deps.costMap?.[resolvedModel2],
      reported: actualCost,
      model: resolvedModel2,
      turns,
    }),
    tokenUsage: executionTokenUsage,
    durationMs: Date.now() - start,
    toolCalls: allToolCalls,
    // Enrichments
    toolsAvailable: capturedToolsAvailable,
    runtimeContext,
    agentOverrides,
    gateDecision,
    discardedSessionId,
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
        cost: { actual: null, estimated: 0, method: 'unavailable' },
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
      cost: { actual: null, estimated: 0, method: 'unavailable' },
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
  const intervention = renderHumanIntervention(nodeName, nodeDef, state);

  deps.emitter.emit({
    event: 'input_required',
    data: {
      node: nodeName,
      prompt: intervention.question || prompt,
      fields: intervention.fields,
      intervention,
    },
  });

  return {
    outputs: { __waiting_for_input: true, __node: nodeName },
    cost: { actual: null, estimated: 0, method: 'unavailable' },
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

  // The child workflow ran as its own execution with its own traces — its
  // cost lives there and ONLY there. This trace records zero cost and links
  // the child so readers roll up the tree on demand instead of finding the
  // same dollars stored twice (child traces + here) and three times
  // (parent executions.cost).
  const childExecutionId = childOutput.__child_execution_id as string | undefined;

  return {
    outputs,
    cost: { actual: null, estimated: 0, method: 'child_execution' },
    childExecutionId,
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
    cost: { actual: null, estimated: 0, method: 'unavailable' },
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
