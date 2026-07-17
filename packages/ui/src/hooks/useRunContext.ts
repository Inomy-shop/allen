import { useEffect, useState } from 'react';
import { executions as executionsApi, type RunStatus } from '../services/api';
import { useExecutionStore } from '../stores/executionStore';

export function useRunContext(executionId?: string | null) {
  const [runContext, setRunContext] = useState<RunStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const snapshot = useExecutionStore((state) => executionId ? state.entities[executionId] : undefined);

  useEffect(() => {
    if (!executionId) {
      setRunContext(null);
      setLoading(false);
      setError(null);
      return;
    }

    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const context = await executionsApi.context(executionId!);
        if (cancelled) return;
        useExecutionStore.getState().ingestExecution(context.execution as unknown as Record<string, unknown>);
        setRunContext(context);
        setError(null);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Failed to load run context');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void load();

    return () => {
      cancelled = true;
    };
  }, [executionId, snapshot?.revision, snapshot?.runGeneration]);

  const effectiveContext = runContext && snapshot
    ? {
        ...runContext,
        status: snapshot.status,
        execution: {
          ...runContext.execution,
          status: snapshot.status,
          revision: snapshot.revision,
          runGeneration: snapshot.runGeneration,
          updatedAt: snapshot.updatedAt,
          currentNodes: snapshot.currentNodes,
          completedNodes: snapshot.completedNodes,
          failedNode: snapshot.failedNode,
          errorMessage: snapshot.errorMessage,
          completedAt: snapshot.completedAt,
        },
        humanInput: {
          ...runContext.humanInput,
          required: snapshot.status === 'waiting_for_input',
        },
      }
    : runContext;

  return { runContext: effectiveContext, loading, error };
}
