import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { AlertTriangle, RefreshCw, X, Layers, Cpu, Activity } from 'lucide-react';
import { executions as executionsApi } from '../../services/api';
import { useModelRegistry, getModelDisplay } from '../../hooks/useModelRegistry';
import { PROVIDER_COLORS } from '../../lib/model-catalog';

// ── Types ──────────────────────────────────────────────────────────────

interface ModelRecoveryPromptProps {
  executionId: string;
  interventionId?: string;        // when responding via the intervention API
  node: string;
  failedProvider: string;
  failedModel: string;
  failureCategory: string;        // FailureCategory string
  sanitizedError: string;
  isParallelBranch: boolean;
  siblingBranches?: string[];
  joinPolicy?: 'wait-all' | 'wait-any' | 'fail-fast';
  attempt: number;
  maxAttempts: number;
  onSubmitted?: () => void;
  onCancelled?: () => void;
}

/** Human-friendly label for each FailureCategory value. */
function failureCategoryLabel(category: string): string {
  const labels: Record<string, string> = {
    provider_server_error: 'Provider server error',
    rate_limit_exhausted: 'Rate limit exhausted',
    session_limit_exhausted: 'Session limit exhausted',
    insufficient_balance: 'Insufficient balance',
    model_unavailable: 'Model unavailable',
    transient_connectivity: 'Transient connectivity issue',
    task_failure: 'Task execution failure',
    validation_failure: 'Validation failure',
    cancellation: 'Cancelled',
    unknown: 'Unknown error',
  };
  return labels[category] ?? category.replace(/_/g, ' ');
}

/** Human-friendly join-policy label. */
function joinPolicyLabel(policy?: string): string {
  switch (policy) {
    case 'wait-all': return 'wait-all';
    case 'wait-any': return 'wait-any';
    case 'fail-fast': return 'fail-fast';
    default: return policy ?? 'wait-all';
  }
}

// ── Component ──────────────────────────────────────────────────────────

export default function ModelRecoveryPrompt({
  executionId,
  node,
  failedProvider,
  failedModel,
  failureCategory,
  sanitizedError,
  isParallelBranch,
  siblingBranches,
  joinPolicy,
  attempt,
  maxAttempts,
  onSubmitted,
  onCancelled,
}: ModelRecoveryPromptProps) {
  const { models } = useModelRegistry();
  const providerSelectRef = useRef<HTMLSelectElement>(null);

  // Form state
  const [selectedProvider, setSelectedProvider] = useState(failedProvider);
  const [selectedModel, setSelectedModel] = useState('');
  const [reasoningEffort, setReasoningEffort] = useState<string | undefined>(undefined);
  const [submitting, setSubmitting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showCancelConfirm, setShowCancelConfirm] = useState(false);

  // Focus provider select on mount
  useEffect(() => {
    providerSelectRef.current?.focus();
  }, []);

  // Reset model when provider changes
  useEffect(() => {
    setSelectedModel('');
  }, [selectedProvider]);

  // ── Derived data from registry ──────────────────────────────────────

  // Unique providers from the model registry, with the failed provider first
  const providerOptions = useMemo(() => {
    const seen = new Set<string>();
    const options: Array<{ value: string; label: string }> = [];
    for (const m of models) {
      if (!seen.has(m.provider)) {
        seen.add(m.provider);
        const display = getModelDisplay(m.provider);
        options.push({ value: m.provider, label: display.providerLabel });
      }
    }
    // Sort: failed provider first, then alphabetical
    const failed = options.filter((o) => o.value === failedProvider);
    const rest = options
      .filter((o) => o.value !== failedProvider)
      .sort((a, b) => a.label.localeCompare(b.label));
    return [...failed, ...rest];
  }, [models, failedProvider]);

  // Model options for the selected provider
  const modelOptions = useMemo(() => {
    if (!selectedProvider) return [];
    return models
      .filter((m) => m.provider === selectedProvider && m.isActive)
      .map((m) => ({
        label: m.displayName?.trim() || m.fullId,
        value: m.fullId,
      }));
  }, [models, selectedProvider]);

  // Derived: can submit
  const canSubmit = selectedProvider.trim() && selectedModel.trim() && !submitting && !cancelling;

  // ── Handlers ────────────────────────────────────────────────────────

  const handleSubmit = useCallback(async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const body: { node: string; provider: string; model: string; reasoningEffort?: string } = {
        node,
        provider: selectedProvider,
        model: selectedModel,
      };
      if (reasoningEffort && reasoningEffort !== 'off') {
        body.reasoningEffort = reasoningEffort;
      }
      await executionsApi.recoverModel(executionId, body);
      onSubmitted?.();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to submit model recovery';
      // Attempt to extract a cleaner server error if it's a structured response
      try {
        const parsed = JSON.parse(message);
        setError(parsed.code ? `${parsed.code}: ${parsed.message ?? parsed.error ?? message}` : parsed.message ?? parsed.error ?? message);
      } catch {
        setError(message);
      }
    } finally {
      setSubmitting(false);
    }
  }, [canSubmit, node, selectedProvider, selectedModel, reasoningEffort, executionId, onSubmitted]);

  const handleCancel = useCallback(async () => {
    setShowCancelConfirm(false);
    setCancelling(true);
    setError(null);
    try {
      await executionsApi.cancel(executionId);
      onCancelled?.();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to cancel workflow');
    } finally {
      setCancelling(false);
    }
  }, [executionId, onCancelled]);

  // ESC key → show cancel confirm
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !submitting && !cancelling) {
        setShowCancelConfirm(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [submitting, cancelling]);

  // ── Render ──────────────────────────────────────────────────────────

  const categoryLabel = failureCategoryLabel(failureCategory);
  const failedDisplay = getModelDisplay(failedProvider, failedModel);

  return (
    <div className="flex flex-col gap-4" role="region" aria-label={`Model recovery for node ${node}`}>
      {/* Header */}
      <div className="flex items-center gap-2">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg border border-accent-orange/30 bg-accent-orange/10">
          <Cpu className="h-4 w-4 text-accent-orange" />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="text-[13px] font-semibold text-theme-primary tracking-tight">
            Model Recovery — <span className="font-mono">{node}</span>
          </h3>
        </div>
        <span className="inline-flex items-center gap-1 rounded-full border border-accent-orange/30 bg-accent-orange/10 px-2 py-0.5 text-[9px] font-mono uppercase tracking-wider text-accent-orange">
          <AlertTriangle className="h-2.5 w-2.5" />
          Recovery needed
        </span>
      </div>

      {/* Failure summary */}
      <div className="rounded-lg border border-app bg-app-muted/40 p-3 space-y-2">
        <div className="flex items-center gap-2 text-[11px] font-mono">
          <Activity className="h-3.5 w-3.5 text-accent-orange shrink-0" />
          <span className="font-semibold text-theme-primary">{categoryLabel}</span>
        </div>

        <div className="rounded border border-app bg-app-card px-3 py-2">
          <pre className="text-[10px] font-mono text-theme-secondary whitespace-pre-wrap leading-relaxed max-h-20 overflow-y-auto">
            {sanitizedError}
          </pre>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[10px] font-mono text-theme-muted">Failed provider:</span>
          <span className="inline-flex items-center gap-1 rounded-full border border-app bg-app-card px-2 py-0.5 text-[10px] font-mono text-theme-secondary">
            <span className={`h-1.5 w-1.5 rounded-full ${PROVIDER_COLORS[failedProvider]?.dotBg ?? 'bg-theme-muted'}`} />
            {failedDisplay.providerLabel}
          </span>
          <span className="text-[10px] font-mono text-theme-muted">model:</span>
          <span className="inline-flex items-center gap-1 rounded-full border border-app bg-app-card px-2 py-0.5 text-[10px] font-mono text-theme-secondary">
            {failedDisplay.modelLabel}
          </span>
        </div>
      </div>

      {/* Topology context */}
      {isParallelBranch ? (
        <div className="flex items-center gap-2 rounded border border-accent-blue/20 bg-accent-blue/5 px-3 py-2 text-[10px] font-mono text-theme-secondary">
          <Layers className="h-3 w-3 text-accent-blue shrink-0" />
          <span>
            Branch in parallel {joinPolicyLabel(joinPolicy)} fork
            {siblingBranches && siblingBranches.length > 0 && (
              <span className="text-theme-muted ml-1">
                ({siblingBranches.length} other branch{siblingBranches.length !== 1 ? 'es' : ''} preserved)
              </span>
            )}
          </span>
        </div>
      ) : (
        <div className="flex items-center gap-2 rounded border border-app bg-app-muted/30 px-3 py-2 text-[10px] font-mono text-theme-secondary">
          <Activity className="h-3 w-3 text-theme-muted shrink-0" />
          <span>Sequential node</span>
        </div>
      )}

      {/* Attempt counter */}
      <div className="flex items-center gap-1 text-[10px] font-mono text-theme-muted">
        <RefreshCw className="h-3 w-3" />
        Attempt {attempt} of {maxAttempts}
      </div>

      {/* Form */}
      <div className="space-y-3">
        {/* Provider select */}
        <label className="block">
          <span className="text-[11px] font-semibold text-theme-primary block mb-1">Provider</span>
          <select
            ref={providerSelectRef}
            value={selectedProvider}
            onChange={(e) => setSelectedProvider(e.target.value)}
            className="w-full rounded-md border border-app bg-app-card px-3 py-2 text-[12px] font-mono text-theme-primary outline-none transition-colors focus:border-accent focus:shadow-[var(--focus-ring)]"
            aria-label="Select provider"
          >
            {providerOptions.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}{opt.value === failedProvider ? ' (current, failed)' : ''}
              </option>
            ))}
          </select>
        </label>

        {/* Model select */}
        <label className="block">
          <span className="text-[11px] font-semibold text-theme-primary block mb-1">Model</span>
          <select
            value={selectedModel}
            onChange={(e) => setSelectedModel(e.target.value)}
            disabled={modelOptions.length === 0}
            className="w-full rounded-md border border-app bg-app-card px-3 py-2 text-[12px] font-mono text-theme-primary outline-none transition-colors focus:border-accent focus:shadow-[var(--focus-ring)] disabled:cursor-not-allowed disabled:opacity-50"
            aria-label="Select model"
          >
            <option value="">Select a model</option>
            {modelOptions.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </label>

        {/* Reasoning effort select */}
        <label className="block">
          <span className="text-[11px] font-semibold text-theme-primary block mb-1">
            Reasoning effort{' '}
            <span className="text-theme-muted font-normal">(optional)</span>
          </span>
          <select
            value={reasoningEffort ?? ''}
            onChange={(e) => setReasoningEffort(e.target.value || undefined)}
            className="w-full rounded-md border border-app bg-app-card px-3 py-2 text-[12px] font-mono text-theme-primary outline-none transition-colors focus:border-accent focus:shadow-[var(--focus-ring)]"
            aria-label="Select reasoning effort"
          >
            <option value="">No selection</option>
            <option value="off">off</option>
            <option value="low">low</option>
            <option value="medium">medium</option>
            <option value="high">high</option>
            <option value="max">max</option>
          </select>
        </label>
      </div>

      {/* Error message */}
      {error && (
        <div className="rounded border border-accent-red/30 bg-accent-red/5 px-3 py-2 text-[11px] font-mono text-accent-red">
          {error}
        </div>
      )}

      {/* Buttons */}
      <div className="flex items-center justify-between gap-3 border-t border-app pt-3">
        {/* Cancel confirm dialog */}
        {showCancelConfirm ? (
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-mono text-accent-red">Cancel entire workflow?</span>
            <button
              type="button"
              onClick={handleCancel}
              disabled={cancelling}
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-accent-red/40 bg-accent-red/10 px-3 text-[11px] font-semibold text-accent-red transition-colors hover:bg-accent-red/20 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {cancelling ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <X className="h-3.5 w-3.5" />}
              {cancelling ? 'Cancelling...' : 'Yes, cancel'}
            </button>
            <button
              type="button"
              onClick={() => setShowCancelConfirm(false)}
              className="inline-flex h-8 items-center rounded-md border border-app bg-app-card px-3 text-[11px] font-medium text-theme-secondary transition-colors hover:bg-app-muted"
            >
              Keep waiting
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setShowCancelConfirm(true)}
            disabled={submitting || cancelling}
            className="inline-flex h-8 items-center rounded-md border border-app bg-app-card px-3 text-[11px] font-medium text-theme-muted transition-colors hover:border-app-strong hover:text-theme-primary disabled:cursor-not-allowed disabled:opacity-50"
          >
            Cancel workflow
          </button>
        )}

        <button
          type="button"
          onClick={handleSubmit}
          disabled={!canSubmit}
          className="inline-flex h-8 items-center gap-1.5 rounded-md bg-accent px-4 text-[11px] font-semibold text-white transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
          aria-label="Retry with selected model"
        >
          {submitting ? (
            <RefreshCw className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCw className="h-3.5 w-3.5" />
          )}
          {submitting ? 'Submitting...' : 'Retry with selected model'}
        </button>
      </div>
    </div>
  );
}
