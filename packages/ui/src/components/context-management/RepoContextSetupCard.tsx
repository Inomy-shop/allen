import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Circle,
  Loader2,
  MinusCircle,
  XCircle,
} from 'lucide-react';
import { useRepoContextSetup, type RepoContextSetupRun, type SetupPhaseSnapshot, type SetupPhaseStatus } from '../../hooks/useRepoContextSetup';

// ── Small local helpers ───────────────────────────────────────────────────────

function Card({ children }: { children: ReactNode }) {
  return (
    <div className="border border-app rounded bg-app-card/40 p-3 space-y-3">
      {children}
    </div>
  );
}

function Row({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center gap-2">{children}</div>;
}

// ── Phase chip ────────────────────────────────────────────────────────────────

type PhaseChipProps = {
  label: string;
  snapshot: SetupPhaseSnapshot;
};

function phaseIcon(status: SetupPhaseStatus) {
  switch (status) {
    case 'running':
      return <Loader2 className="w-3.5 h-3.5 animate-spin text-blue-500" />;
    case 'completed':
      return <CheckCircle2 className="w-3.5 h-3.5 text-green-500" />;
    case 'failed':
      return <XCircle className="w-3.5 h-3.5 text-red-500" />;
    case 'cancelled':
      return <MinusCircle className="w-3.5 h-3.5 text-theme-muted" />;
    case 'skipped':
    default:
      return <Circle className="w-3.5 h-3.5 text-theme-muted" />;
  }
}

function phaseTextClass(status: SetupPhaseStatus): string {
  switch (status) {
    case 'running':   return 'text-blue-500';
    case 'completed': return 'text-green-500';
    case 'failed':    return 'text-red-500';
    case 'skipped':   return 'text-theme-muted italic';
    case 'cancelled': return 'text-theme-muted line-through';
    default:          return 'text-theme-muted';
  }
}

function PhaseChip({ label, snapshot }: PhaseChipProps) {
  const { status } = snapshot;
  return (
    <div
      className={`flex items-center gap-1.5 rounded border border-app bg-app-card px-2 py-1 text-[11px] font-medium ${phaseTextClass(status)}`}
      title={snapshot.message ?? undefined}
    >
      {phaseIcon(status)}
      {label}
    </div>
  );
}

// ── Phase counts row ──────────────────────────────────────────────────────────

function phaseCounts(run: RepoContextSetupRun): Array<{ key: string; label: string; value: number | string | undefined }> {
  const p = run.phases;
  return [
    // Curation — M4: show "reused" for unchangedCount so "promoted 0" on pure-reuse runs is honest
    { key: 'reused',    label: 'reused',    value: p.curation.unchangedCount },
    { key: 'changed',   label: 'changed',   value: p.curation.changedCount },
    { key: 'promoted',  label: 'promoted',  value: p.curation.promotedCount },
    // Mandatory
    { key: 'mappings-saved',       label: 'mappings saved',       value: p.mandatoryMapping.savedMappingCount },
    { key: 'mappings-deactivated', label: 'mappings deactivated', value: p.mandatoryMapping.deactivatedMappingCount },
    // Graph
    { key: 'graph', label: 'graph status', value: p.contextRefresh.cogneeStatus },
  ].filter((item) => item.value !== undefined && item.value !== null);
}

function CountsRow({ run }: { run: RepoContextSetupRun }) {
  const items = phaseCounts(run);
  if (!items.length) return null;
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-theme-muted font-mono">
      {items.map((item) => (
        <span key={item.key}>{item.label} <span className="text-theme-primary">{String(item.value)}</span></span>
      ))}
    </div>
  );
}

// ── Last successful time ──────────────────────────────────────────────────────

function formatDateShort(iso?: string): string {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

// ── Failed/stopped banner ─────────────────────────────────────────────────────

function failedPhaseLabel(run: RepoContextSetupRun): string | null {
  const phases: Array<[string, SetupPhaseSnapshot]> = [
    ['Preflight', run.phases.preflight],
    ['Curation', run.phases.curation],
    ['Mandatory', run.phases.mandatoryMapping],
    ['Graph', run.phases.contextRefresh],
  ];
  const failed = phases.find(([, p]) => p.status === 'failed');
  return failed ? failed[0] : null;
}

// ── M1: throttle constant ─────────────────────────────────────────────────────

const COGNEE_ACTIVITY_THROTTLE_MS = 5_000;

// ── Main component ────────────────────────────────────────────────────────────

export default function RepoContextSetupCard({
  repoId,
  onCogneeActivity,
}: {
  repoId: string;
  /** M1: called (throttled to once per 5 s) when contextRefresh phase is running,
   * so the parent page can discover an externally-started Cognee build. */
  onCogneeActivity?: () => void;
}) {
  const { setupRun, label, active, isLoading, error, startSetup, cancelSetup, resumeSetup } = useRepoContextSetup(repoId);

  const [showProgress, setShowProgress] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [cleanRebuild, setCleanRebuild] = useState(false);
  const [forceCuration, setForceCuration] = useState(false);
  const [acting, setActing] = useState(false);

  // M3: collapsed state — auto-collapsed for completed runs, expanded for everything else.
  // manuallyExpanded lets the user override the auto-collapse by clicking the chevron.
  const isCompletedTerminal = !active && setupRun?.status === 'completed';
  const [manuallyExpanded, setManuallyExpanded] = useState(false);
  const collapsed = isCompletedTerminal && !manuallyExpanded;

  // Reset user override when the run transitions away from completed (new run started).
  const prevStatusRef = useRef(setupRun?.status);
  useEffect(() => {
    if (prevStatusRef.current !== setupRun?.status) {
      prevStatusRef.current = setupRun?.status;
      if (setupRun?.status !== 'completed') setManuallyExpanded(false);
    }
  }, [setupRun?.status]);

  // M1: notify parent when the contextRefresh phase is actively running.
  // Depends on setupRun's object identity (the poll replaces the object every few
  // seconds), so the effect re-runs on each poll tick while the phase is running —
  // depending on the status string alone would fire only once per transition and
  // break the periodic re-signal. The ref timestamp throttles actual callbacks to
  // once per COGNEE_ACTIVITY_THROTTLE_MS so we don't spam refreshCogneeStatus.
  const lastActivitySignalRef = useRef(0);
  useEffect(() => {
    if (!onCogneeActivity) return;
    if (setupRun?.phases.contextRefresh.status !== 'running') return;
    const now = Date.now();
    if (now - lastActivitySignalRef.current < COGNEE_ACTIVITY_THROTTLE_MS) return;
    lastActivitySignalRef.current = now;
    onCogneeActivity();
  }, [setupRun, onCogneeActivity]);

  const act = async (fn: () => Promise<void>) => {
    setActing(true);
    try { await fn(); } finally { setActing(false); }
  };

  // ── Primary button logic ──────────────────────────────────────────────────

  const handlePrimary = () => {
    switch (label) {
      case 'prepare':
        void act(() => startSetup(advancedOpen ? { cleanRebuildCognee: cleanRebuild, forceCuration } : undefined));
        break;
      case 'view_progress':
        setShowProgress((v) => !v);
        break;
      case 'resume_setup':
        if (setupRun) void act(() => resumeSetup(setupRun.setupRunId));
        break;
      case 'check_for_updates':
        void act(() => startSetup({ forceCuration: false }));
        break;
      case 'refresh_stale_graph':
        void act(() => startSetup({ cleanRebuildCognee: false }));
        break;
    }
  };

  const primaryLabel: Record<typeof label, string> = {
    prepare:             'Prepare repo context',
    view_progress:       'View progress',
    resume_setup:        'Resume setup',
    check_for_updates:   'Check for updates',
    refresh_stale_graph: 'Refresh stale context graph',
  };

  // ── Derived display state ─────────────────────────────────────────────────

  const isFailed = setupRun && (
    setupRun.status === 'failed' ||
    setupRun.status === 'partial' ||
    setupRun.status === 'stopped'
  );
  const failedPhase = setupRun ? failedPhaseLabel(setupRun) : null;
  const showCancel = setupRun && (setupRun.status === 'running' || setupRun.status === 'partial');

  const lastSuccessfulAt = setupRun?.status === 'completed' ? setupRun.completedAt : undefined;

  const busy = acting || (isLoading && !setupRun);

  // ── M3: collapsed view for completed runs ─────────────────────────────────

  if (collapsed) {
    return (
      <Card>
        <Row>
          <button
            type="button"
            onClick={handlePrimary}
            disabled={busy}
            className="btn btn-primary btn-sm"
            aria-label={primaryLabel[label]}
          >
            {primaryLabel[label]}
          </button>
          <CheckCircle2 className="w-3.5 h-3.5 text-green-500 shrink-0" />
          <span className="text-[11px] text-green-600">Context setup completed successfully</span>
          {lastSuccessfulAt && (
            <span className="text-[11px] text-theme-muted font-mono">
              Last completed: {formatDateShort(lastSuccessfulAt)}
            </span>
          )}
          <button
            type="button"
            onClick={() => setManuallyExpanded(true)}
            className="ml-auto btn btn-ghost btn-sm"
            aria-label="Expand setup details"
            title="Show setup details"
          >
            <ChevronDown className="w-3.5 h-3.5" />
          </button>
        </Row>
      </Card>
    );
  }

  return (
    <Card>
      {/* ── Header row ──────────────────────────────────────────────────────── */}
      <Row>
        <button
          type="button"
          onClick={handlePrimary}
          disabled={busy}
          className="btn btn-primary btn-sm"
          aria-label={primaryLabel[label]}
        >
          {busy && label !== 'view_progress' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
          {primaryLabel[label]}
        </button>

        {setupRun?.message && (
          <span className="text-[11px] text-theme-muted">{setupRun.message}</span>
        )}

        {error && (
          <span className="text-[11px] text-red-500">{error}</span>
        )}

        {lastSuccessfulAt && (
          <span className="text-[11px] text-theme-muted font-mono ml-auto">
            Last completed: {formatDateShort(lastSuccessfulAt)}
          </span>
        )}

        {/* M3: collapse button shown when in expanded-completed view */}
        {isCompletedTerminal && (
          <button
            type="button"
            onClick={() => setManuallyExpanded(false)}
            className="btn btn-ghost btn-sm"
            aria-label="Collapse setup details"
            title="Collapse setup details"
          >
            <ChevronUp className="w-3.5 h-3.5" />
          </button>
        )}
      </Row>

      {/* ── Phase strip ──────────────────────────────────────────────────────── */}
      {setupRun && (
        <Row>
          <PhaseChip label="Preflight"  snapshot={setupRun.phases.preflight} />
          <PhaseChip label="Curation"   snapshot={setupRun.phases.curation} />
          <PhaseChip label="Mandatory"  snapshot={setupRun.phases.mandatoryMapping} />
          <PhaseChip label="Graph"      snapshot={setupRun.phases.contextRefresh} />
        </Row>
      )}

      {/* ── Counts row ──────────────────────────────────────────────────────── */}
      {setupRun && <CountsRow run={setupRun} />}

      {/* ── Progress pane (toggled by "View progress") ───────────────────────── */}
      {(active || showProgress) && setupRun && (
        <div className="rounded border border-app bg-app-elevated/60 p-2 space-y-1 text-[11px] font-mono text-theme-muted">
          <div>Phase: <span className="text-theme-primary">{setupRun.currentPhase}</span></div>
          <div>Status: <span className="text-theme-primary">{setupRun.status}</span></div>
          {setupRun.phases.contextRefresh.cogneeStage && (
            <div>Graph stage: <span className="text-theme-primary">{setupRun.phases.contextRefresh.cogneeStage}</span></div>
          )}
        </div>
      )}

      {/* ── Failed-phase banner ──────────────────────────────────────────────── */}
      {isFailed && (
        <div className="rounded border border-red-500/40 bg-red-500/10 px-3 py-2 flex flex-wrap items-center gap-2">
          <XCircle className="w-3.5 h-3.5 text-red-500 shrink-0" />
          <span className="text-xs text-red-400 grow">
            {failedPhase ? `Setup stopped at ${failedPhase} phase` : 'Setup did not complete'}
            {setupRun?.status === 'stopped' ? ' — server was restarted' : ''}
          </span>
          <button
            type="button"
            disabled={acting}
            onClick={() => void act(() => resumeSetup(setupRun!.setupRunId))}
            className="btn btn-secondary btn-sm"
          >
            {acting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
            Resume
          </button>
          {showCancel && (
            <button
              type="button"
              disabled={acting}
              onClick={() => void act(() => cancelSetup(setupRun!.setupRunId))}
              className="btn btn-ghost btn-sm"
            >
              Cancel
            </button>
          )}
        </div>
      )}

      {/* ── Advanced disclosure ──────────────────────────────────────────────── */}
      <div>
        <button
          type="button"
          onClick={() => setAdvancedOpen((v) => !v)}
          className="inline-flex items-center gap-1 text-[11px] text-theme-secondary hover:text-theme-primary"
        >
          {advancedOpen ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
          Advanced options
        </button>
        {advancedOpen && (
          <div className="mt-2 space-y-2 pl-4">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={cleanRebuild}
                onChange={(e) => setCleanRebuild(e.target.checked)}
                className="rounded"
              />
              <span className="text-[11px] text-theme-muted">Clean rebuild context graph</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={forceCuration}
                onChange={(e) => setForceCuration(e.target.checked)}
                className="rounded"
              />
              <span className="text-[11px] text-theme-muted">Force re-curation (re-curate all files)</span>
            </label>
          </div>
        )}
      </div>
    </Card>
  );
}
