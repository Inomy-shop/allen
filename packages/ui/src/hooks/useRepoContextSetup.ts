import { useCallback, useEffect, useState } from 'react';
import { repos as repoApi } from '../services/api';

// ── Types ─────────────────────────────────────────────────────────────────────

export type SetupPhaseStatus =
  | 'pending'
  | 'running'
  | 'skipped'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type SetupStatus =
  | 'running'
  | 'completed'
  | 'partial'
  | 'failed'
  | 'cancelled'
  | 'stopped';

export type SetupLabel =
  | 'prepare'
  | 'view_progress'
  | 'resume_setup'
  | 'check_for_updates'
  | 'refresh_stale_graph';

export type SetupPhaseSnapshot = {
  status: SetupPhaseStatus;
  startedAt?: string;
  completedAt?: string;
  message?: string;
  // Curation phase
  unchangedCount?: number;
  changedCount?: number;
  retryCount?: number;
  stagedCount?: number;
  promotedCount?: number;
  promotable?: boolean;
  // Mandatory phase
  savedMappingCount?: number;
  deactivatedMappingCount?: number;
  // Cognee phase
  cogneeStatus?: string;
  cogneeStage?: string;
  cogneeMessage?: string;
};

export type RepoContextSetupRun = {
  setupRunId: string;
  repoId: string;
  status: SetupStatus;
  currentPhase: string;
  requestedAt: string;
  completedAt?: string;
  message?: string;
  phases: {
    preflight: SetupPhaseSnapshot;
    curation: SetupPhaseSnapshot;
    mandatoryMapping: SetupPhaseSnapshot;
    contextRefresh: SetupPhaseSnapshot;
  };
  options: {
    cleanRebuildCognee?: boolean;
    skipCognee?: boolean;
    forceCuration?: boolean;
  };
  resumeCount: number;
};

type ContextSetupResponse = {
  active: boolean;
  setupRun: RepoContextSetupRun | null;
  label: SetupLabel;
};

// ── Hook ──────────────────────────────────────────────────────────────────────

export function useRepoContextSetup(repoId: string) {
  const [setupRun, setSetupRun] = useState<RepoContextSetupRun | null>(null);
  const [label, setLabel] = useState<SetupLabel>('prepare');
  const [active, setActive] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** Manual refresh — used after user-initiated actions (start / cancel / resume). */
  const refresh = useCallback(async () => {
    if (!repoId) return;
    try {
      const data = (await repoApi.contextSetup.current(repoId)) as ContextSetupResponse;
      setSetupRun(data.setupRun);
      setLabel(data.label ?? 'prepare');
      setActive(Boolean(data.active));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load context setup status');
    }
  }, [repoId]);

  /**
   * Background polling effect — mirrors `useRunContext` pattern.
   * Polls every 3 s while active, backs off to 30 s on terminal states.
   */
  useEffect(() => {
    if (!repoId) return;

    let cancelled = false;
    let timerId: ReturnType<typeof setTimeout> | undefined;

    async function poll(initial: boolean) {
      if (initial) setIsLoading(true);
      try {
        const data = (await repoApi.contextSetup.current(repoId)) as ContextSetupResponse;
        if (cancelled) return;
        setSetupRun(data.setupRun);
        setLabel(data.label ?? 'prepare');
        setActive(Boolean(data.active));
        setError(null);
        const delay = data.active ? 3000 : 30000;
        timerId = setTimeout(() => { void poll(false); }, delay);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Failed to load context setup status');
        // Retry on error after 10 s
        timerId = setTimeout(() => { void poll(false); }, 10000);
      } finally {
        if (!cancelled && initial) setIsLoading(false);
      }
    }

    void poll(true);

    return () => {
      cancelled = true;
      if (timerId !== undefined) clearTimeout(timerId);
    };
  }, [repoId]);

  // ── Actions ──────────────────────────────────────────────────────────────────

  const startSetup = useCallback(async (options?: Record<string, unknown>) => {
    if (!repoId) return;
    try {
      await repoApi.contextSetup.start(repoId, options);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start context setup');
    }
  }, [refresh, repoId]);

  const cancelSetup = useCallback(async (runId: string) => {
    if (!repoId) return;
    try {
      await repoApi.contextSetup.cancel(repoId, runId);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to cancel context setup');
    }
  }, [refresh, repoId]);

  const resumeSetup = useCallback(async (runId: string) => {
    if (!repoId) return;
    try {
      await repoApi.contextSetup.resume(repoId, runId);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to resume context setup');
    }
  }, [refresh, repoId]);

  return {
    setupRun,
    label,
    active,
    isLoading,
    error,
    startSetup,
    cancelSetup,
    resumeSetup,
  };
}
