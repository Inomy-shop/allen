// ── Model Recovery: Node-Level Model/Provider Failure Recovery ─────────────
//
// This module detects recoverable model/provider errors and allows the user
// to retry a failed node with a different provider/model at execution time
// without mutating workflow YAML, agent definitions, or the model registry.
//
// All exported types and functions are part of the public @allen/engine
// surface consumed by the server and UI packages.
//
// PRD refs: AC1–AC17, R1–R13
// ─────────────────────────────────────────────────────────────────────────────

// ── Classification ─────────────────────────────────────────────────────────

/**
 * Categories of node execution failure. Recoverable categories can be
 * addressed by selecting an alternative provider or model at runtime.
 * Non-recoverable categories (task_failure, validation_failure,
 * cancellation) behave exactly as today — terminal failure.
 */
export type FailureCategory =
  | 'provider_server_error'
  | 'provider_auth_failed'
  | 'rate_limit_exhausted'
  | 'session_limit_exhausted'
  | 'insufficient_balance'
  | 'model_unavailable'
  | 'transient_connectivity'
  | 'task_failure'
  | 'validation_failure'
  | 'cancellation'
  | 'unknown';

/**
 * Result of classifying a node execution error.
 */
export interface ClassificationResult {
  /** True when the error is recoverable by switching provider/model. */
  recoverable: boolean;
  category: FailureCategory;
  /** The provider that was in use when the failure occurred, if known. */
  failedProvider?: string;
  /** The model that was in use when the failure occurred, if known. */
  failedModel?: string;
  /**
   * User-safe error description with secrets stripped. Always a string,
   * always <= 500 chars, always non-empty.
   */
  sanitizedSummary: string;
}

// ── Per-Execution Node Model Override ─────────────────────────────────────

/**
 * Execution-scoped override for a single node's provider/model on retry.
 * Stored in exec.state.__model_overrides[nodeName][].
 *
 * PRD refs: AC12 (execution-scoped, no persistent mutation),
 *           R11 (workflow/agent defaults unchanged)
 */
export interface NodeModelOverride {
  nodeName: string;
  provider: string;
  model: string;
  reasoningEffort?: 'off' | 'low' | 'medium' | 'high' | 'max';
  /** Which recovery attempt this override corresponds to (1-based). */
  attempt: number;
  /** ISO timestamp when the override was selected. */
  createdAt: string;
}

// ── Recovery State ────────────────────────────────────────────────────────

/**
 * Tracks the recovery lifecycle for a single node or parallel branch.
 * Stored on exec.state.__recovery_state as either a flat RecoveryState
 * (single node) or a Record<string, RecoveryState> keyed by branch node name
 * (parallel branches — each branch gets its own independent recovery state).
 *
 * PRD refs: AC16 (visible in trace), R10 (auditability), R13 (bounded attempts)
 */
export interface RecoveryOverrideHistoryEntry {
  attempt: number;
  selectedProvider: string;
  selectedModel: string;
  selectedAt: string;
  outcome: 'success' | 'recoverable_failure' | 'unrecoverable_failure' | 'cancelled';
  errorSummary?: string;
}

export interface RecoveryState {
  nodeName: string;
  failedProvider: string;
  failedModel: string;
  failureCategory: FailureCategory;
  sanitizedError: string;
  /** 1-based recovery attempt counter (1 after first failure). */
  attempt: number;
  maxAttempts: number;
  isParallelBranch: boolean;
  siblingBranches?: string[];
  joinPolicy?: 'wait-all' | 'wait-any' | 'fail-fast';
  /** ISO timestamp when recovery was first entered. */
  enteredAt: string;
  overrideHistory: RecoveryOverrideHistoryEntry[];
}

// ── Classification Implementation ─────────────────────────────────────────

/**
 * Inspect an unknown error and decide whether it is a recoverable
 * model/provider failure. Reads nested `.status`, `.code`, `.message`
 * from Error instances, plain objects, or any thrown value.
 *
 * @param err  Any thrown value (Error, object with .message, string, etc.)
 * @param ctx  Optional context with known provider/model for richer categorization
 */
export function classifyFailure(
  err: unknown,
  ctx?: { provider?: string; model?: string },
): ClassificationResult {
  const message = extractMessage(err);
  const status = extractStatus(err);
  const code = extractCode(err);
  const sanitized = sanitizeErrorSummary(message);

  // ── Recoverable categories (ordered by specificity) ──────────────────

  // Authentication/credential failures. A different provider/model can unblock
  // the node when the selected provider's key is invalid or unauthorized.
  if (
    status === 401 ||
    /\b401\b.*\b(auth|authentication|unauthori[sz]ed|api\s*key|credential)/i.test(message) ||
    /\b(auth|authentication|unauthori[sz]ed|api\s*key|credential).*\b401\b/i.test(message) ||
    /\bauthentication\s+(fails?|failed|error)\b/i.test(message) ||
    /\binvalid\s+(api\s*)?key\b/i.test(message) ||
    /\bapi\s*key\b[^\n.]{0,120}\binvalid\b/i.test(message) ||
    /\bunauthori[sz]ed\b/i.test(message)
  ) {
    return {
      recoverable: true,
      category: 'provider_auth_failed',
      failedProvider: ctx?.provider,
      failedModel: ctx?.model,
      sanitizedSummary: sanitized,
    };
  }

  // 5xx HTTP status, or message indicates server-side error
  if (
    (status !== undefined && status >= 500 && status < 600) ||
    /\binternal\s+server\s+error\b/i.test(message) ||
    /\bbad\s+gateway\b/i.test(message) ||
    /\bservice\s+unavailable\b/i.test(message)
  ) {
    return {
      recoverable: true,
      category: 'provider_server_error',
      failedProvider: ctx?.provider,
      failedModel: ctx?.model,
      sanitizedSummary: sanitized,
    };
  }

  // Status 429 or rate-limit / quota message
  if (
    status === 429 ||
    /\brate\s*limit\b/i.test(message) ||
    /\bquota\b/i.test(message) ||
    /\btokens\s+per\s+minute\b/i.test(message)
  ) {
    return {
      recoverable: true,
      category: 'rate_limit_exhausted',
      failedProvider: ctx?.provider,
      failedModel: ctx?.model,
      sanitizedSummary: sanitized,
    };
  }

  // Session/capacity limits
  if (
    /\bsession\s+limit\b/i.test(message) ||
    /\bconcurrent\s+session\b/i.test(message) ||
    /\bmax\s+sessions\b/i.test(message)
  ) {
    return {
      recoverable: true,
      category: 'session_limit_exhausted',
      failedProvider: ctx?.provider,
      failedModel: ctx?.model,
      sanitizedSummary: sanitized,
    };
  }

  // Billing / credits
  if (
    /\binsufficient\s+balance\b/i.test(message) ||
    /\binsufficient\s+credit/i.test(message) ||
    /\bpayment\s+required\b/i.test(message) ||
    /\bbilling\b/i.test(message)
  ) {
    return {
      recoverable: true,
      category: 'insufficient_balance',
      failedProvider: ctx?.provider,
      failedModel: ctx?.model,
      sanitizedSummary: sanitized,
    };
  }

  // Model unavailable / deprecated / not found
  if (
    /\bmodel\s+not\s+found\b/i.test(message) ||
    /\binvalid\s+model\b/i.test(message) ||
    /\bmodel\s+unavailable\b/i.test(message) ||
    /\bmodel\s+deprecated\b/i.test(message) ||
    /\bunknown\s+model\b/i.test(message) ||
    /\bunsupported\s+model\b/i.test(message) ||
    /\bmodel\s+is\s+not\s+supported\b/i.test(message) ||
    /\bsupported\s+(?:api\s+)?model\s+names?\b/i.test(message) ||
    /\bsupported\s+models?\b[\s\S]{0,200}\b(?:passed|provided|requested)\b/i.test(message)
  ) {
    return {
      recoverable: true,
      category: 'model_unavailable',
      failedProvider: ctx?.provider,
      failedModel: ctx?.model,
      sanitizedSummary: sanitized,
    };
  }

  // Transient connectivity errors. Only classify as recoverable when the
  // error code is a well-known network failure, or the message indicates
  // a transient/network/timeout condition AFTER internal retries failed.
  if (
    code === 'ETIMEDOUT' ||
    code === 'ECONNREFUSED' ||
    code === 'ECONNRESET' ||
    code === 'ENOTFOUND' ||
    code === 'EAI_AGAIN' ||
    (message.includes('_RETRY_EXHAUSTED') &&
      (/\bnetwork\b/i.test(message) || /\btimeout\b/i.test(message))) ||
    (/\[transient\]/i.test(message) &&
      (/\bnetwork\b/i.test(message) || /\btimeout\b/i.test(message)))
  ) {
    return {
      recoverable: true,
      category: 'transient_connectivity',
      failedProvider: ctx?.provider,
      failedModel: ctx?.model,
      sanitizedSummary: sanitized,
    };
  }

  // ── Non-recoverable categories ───────────────────────────────────────

  // Validation failures are terminal — the output didn't match schema
  if (
    /\bvalidation\s+failed\b/i.test(message) ||
    /\bschema\s+mismatch\b/i.test(message) ||
    /\boutput\s+validation\b/i.test(message)
  ) {
    return {
      recoverable: false,
      category: 'validation_failure',
      failedProvider: ctx?.provider,
      failedModel: ctx?.model,
      sanitizedSummary: sanitized,
    };
  }

  // Cancellation — already handled separately by the engine
  if (
    message === 'Execution cancelled' ||
    (/\bcancelled\b/i.test(message) && (
      status !== undefined || code !== undefined
    ))
  ) {
    return {
      recoverable: false,
      category: 'cancellation',
      failedProvider: ctx?.provider,
      failedModel: ctx?.model,
      sanitizedSummary: sanitized,
    };
  }

  // ── Default: non-recoverable task failure ────────────────────────

  return {
    recoverable: false,
    category: 'task_failure',
    failedProvider: ctx?.provider,
    failedModel: ctx?.model,
    sanitizedSummary: sanitized,
  };
}

/**
 * Read the environment variable ALLEN_MAX_RECOVERY_ATTEMPTS.
 * Returns the parsed integer if valid, or 3 as the default.
 *
 * PRD refs: R13 (bounded attempts, configurable via env)
 */
export function defaultMaxRecoveryAttempts(): number {
  const raw = process.env.ALLEN_MAX_RECOVERY_ATTEMPTS;
  if (raw !== undefined && raw !== '') {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed >= 1 && Number.isInteger(parsed)) {
      return parsed;
    }
  }
  return 3;
}

/**
 * Build a fresh RecoveryState for a node that just failed with a
 * recoverable error.
 */
export function buildRecoveryState(args: {
  nodeName: string;
  classification: ClassificationResult;
  isParallelBranch: boolean;
  siblingBranches?: string[];
  joinPolicy?: 'wait-all' | 'wait-any' | 'fail-fast';
  maxAttempts?: number;
}): RecoveryState {
  return {
    nodeName: args.nodeName,
    failedProvider: args.classification.failedProvider ?? '',
    failedModel: args.classification.failedModel ?? '',
    failureCategory: args.classification.category,
    sanitizedError: args.classification.sanitizedSummary,
    attempt: 1,
    maxAttempts: args.maxAttempts ?? defaultMaxRecoveryAttempts(),
    isParallelBranch: args.isParallelBranch,
    siblingBranches: args.siblingBranches,
    joinPolicy: args.joinPolicy,
    enteredAt: new Date().toISOString(),
    overrideHistory: [],
  };
}

// ── Sanitization ──────────────────────────────────────────────────────────

/**
 * Sanitize raw error text: strip API keys, bearer tokens, env-style
 * secrets, and trim to 500 characters. Always returns a non-empty string.
 *
 * Redacted patterns:
 *   - `sk-...` Anthropic/OpenAI-style secret keys (sk- followed by 8+ chars)
 *   - `Bearer <token>` authorization headers
 *   - `KEY=value` env-style secret assignments (uppercase key prefix)
 */
export function sanitizeErrorSummary(input: string): string {
  if (!input) return 'Unknown error';

  let result = input;

  // Anthropic/OpenAI secret keys: sk-<alphanumeric+hyphen+underscore>
  result = result.replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-<REDACTED>');

  // Bearer tokens in headers or URLs
  result = result.replace(/Bearer\s+[A-Za-z0-9._-]+/g, 'Bearer <REDACTED>');

  // Env-style secrets: UPPERCASE_KEY=value
  result = result.replace(/\b[A-Z][A-Z0-9_]*_KEY=\S+/g, (match) => {
    const eqIdx = match.indexOf('=');
    return match.slice(0, eqIdx + 1) + '<REDACTED>';
  });

  // Provider messages sometimes print generic API key labels instead of env names.
  result = result.replace(/(api\s*key\s*[:=]\s*)([^\s,;]+)/gi, '$1<REDACTED>');

  // Trim to 500 chars, keeping whole words where possible
  if (result.length > 500) {
    const trimmed = result.slice(0, 497);
    const lastSpace = trimmed.lastIndexOf(' ');
    result = lastSpace > 0 ? trimmed.slice(0, lastSpace) + '...' : trimmed + '...';
  }

  return result || 'Unknown error';
}

// ── Internal Helpers ──────────────────────────────────────────────────────

/**
 * Extract a human-readable message from any thrown value.
 */
function extractMessage(err: unknown): string {
  if (err instanceof Error) {
    const diagnosticEvidence = typeof (err as Error & { diagnosticEvidence?: unknown }).diagnosticEvidence === 'string'
      ? (err as Error & { diagnosticEvidence?: string }).diagnosticEvidence
      : '';
    return [err.message || String(err), diagnosticEvidence].filter(Boolean).join('\n');
  }
  if (err && typeof err === 'object') {
    const obj = err as Record<string, unknown>;
    if (typeof obj.message === 'string') return obj.message;
    if (typeof obj.error === 'string') return obj.error;
    if (typeof obj.reason === 'string') return obj.reason;
  }
  return String(err);
}

/**
 * Extract an HTTP status code from any thrown value.
 * Returns undefined if not present.
 */
function extractStatus(err: unknown): number | undefined {
  if (err && typeof err === 'object') {
    const obj = err as Record<string, unknown>;
    if (typeof obj.status === 'number') return obj.status;
    if (typeof obj.statusCode === 'number') return obj.statusCode;
    const response = obj.response;
    if (response && typeof response === 'object') {
      const resp = response as Record<string, unknown>;
      if (typeof resp.status === 'number') return resp.status;
    }
  }
  return undefined;
}

/**
 * Extract an error code (e.g. ETIMEDOUT) from any thrown value.
 */
function extractCode(err: unknown): string | undefined {
  if (err instanceof Error && 'code' in err) {
    const code = (err as Error & { code: unknown }).code;
    if (typeof code === 'string') return code;
  }
  if (err && typeof err === 'object') {
    const obj = err as Record<string, unknown>;
    if (typeof obj.code === 'string') return obj.code;
  }
  return undefined;
}
