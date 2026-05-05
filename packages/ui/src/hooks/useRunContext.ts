import { useEffect, useState } from 'react';
import { executions as executionsApi, type RunStatus } from '../services/api';

function isLiveRun(context: RunStatus | null): boolean {
  if (!context) return false;
  const status = (context.execution.status || context.status || '').toLowerCase();
  return (
    status === 'pending'
    || status === 'queued'
    || status === 'running'
    || status === 'waiting_for_input'
    || status === 'paused'
    || context.humanInput.required
  );
}

export function useRunContext(executionId?: string | null) {
  const [runContext, setRunContext] = useState<RunStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!executionId) {
      setRunContext(null);
      setLoading(false);
      setError(null);
      return;
    }

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function load(initial: boolean) {
      if (initial) setLoading(true);
      try {
        const context = await executionsApi.context(executionId!);
        if (cancelled) return;
        setRunContext(context);
        setError(null);
        if (isLiveRun(context)) {
          timer = setTimeout(() => { void load(false); }, 3000);
        }
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Failed to load run context');
        timer = setTimeout(() => { void load(false); }, 5000);
      } finally {
        if (!cancelled && initial) setLoading(false);
      }
    }

    void load(true);

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [executionId]);

  return { runContext, loading, error };
}
