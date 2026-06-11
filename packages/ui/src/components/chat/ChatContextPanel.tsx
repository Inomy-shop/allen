import { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { chat as chatApi } from '../../services/api';
import { RepoContextInjectionPanel } from '../execution/NodeInspector';

export default function ChatContextPanel({ sessionId }: { sessionId?: string | null }) {
  const [report, setReport] = useState<any | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openAttemptId, setOpenAttemptId] = useState<string | null>(null);
  const attempts = (report?.attempts ?? []) as any[];

  useEffect(() => {
    if (!sessionId) {
      setReport(null);
      setOpenAttemptId(null);
      return;
    }
    let cancelled = false;
    const load = async (initial = false) => {
      if (initial) setLoading(true);
      setError(null);
      try {
        const payload = await chatApi.getContextUsage(sessionId);
        if (!cancelled) setReport(payload);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load chat context');
      } finally {
        if (!cancelled && initial) setLoading(false);
      }
    };
    void load(true);
    const interval = window.setInterval(() => { void load(false); }, 30000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [sessionId]);

  if (!sessionId) return <div className="cr-empty">Open a chat session to inspect context.</div>;
  if (loading && !report) return <div className="cr-empty">Loading chat context...</div>;
  if (error) return <div className="cr-empty">Failed to load chat context: {error}</div>;
  if (!attempts.length) return <div className="cr-empty">No chat context has been captured for this session yet.</div>;

  return (
    <div className="space-y-3 pb-6">
      <div className="cr-files-summary">
        <div>
          <span>chat context attempts</span>
          <strong>{attempts.length}</strong>
        </div>
      </div>
      {attempts.map((attempt, index) => {
        const attemptId = String(attempt.contextAttemptId ?? index);
        const open = openAttemptId === attemptId;
        const counts = chatContextAttemptCounts(attempt);
        const skipped = String(attempt.status ?? '').toLowerCase() === 'skipped';
        const skipReason = attempt.error ?? attempt.contextInjection?.skipReason ?? 'skipped';
        return (
          <div key={attempt.contextAttemptId ?? index} className="rounded-lg border border-app bg-app-card">
            <button
              type="button"
              onClick={() => setOpenAttemptId(open ? null : attemptId)}
              className="w-full p-2 text-left"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex items-start gap-2">
                  {open ? <ChevronDown className="mt-0.5 h-3.5 w-3.5 shrink-0 text-theme-subtle" /> : <ChevronRight className="mt-0.5 h-3.5 w-3.5 shrink-0 text-theme-subtle" />}
                  <div className="min-w-0">
                    <div className="text-[12px] font-medium text-theme-primary line-clamp-2">
                      {attempt.turnPreview ?? attempt.turnText ?? `Chat turn ${index + 1}`}
                    </div>
                    <div className="mt-0.5 text-[10px] font-mono text-theme-subtle break-all">
                      {[attempt.repoName ?? attempt.indexId, attempt.messageId ? `message ${attempt.messageId}` : undefined].filter(Boolean).join(' · ')}
                    </div>
                    {skipped ? (
                      <div className="mt-1 text-[10px] text-theme-subtle">
                        Skipped: {humanChatContextSkipReason(skipReason)}
                      </div>
                    ) : null}
                  </div>
                </div>
                <span className="shrink-0 rounded border border-app px-1.5 py-0.5 text-[10px] font-mono text-theme-subtle">
                  {skipped ? 'skipped · ' : ''}{counts.injected} injected · {counts.selected} selected · {counts.filtered} filtered
                </span>
              </div>
            </button>
            {open ? (
              <div className="border-t border-app p-2">
                {skipped ? (
                  <div className="cr-empty">Context retrieval skipped for this chat turn: {humanChatContextSkipReason(skipReason)}.</div>
                ) : (
                  <RepoContextInjectionPanel
                    contextAttempt={attempt}
                    title={attempt.contextInjection?.targetLayer === 'user_prompt' ? 'User-turn context injection' : 'Repo context injection'}
                    emptyText="No context refs captured for this chat turn."
                  />
                )}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function humanChatContextSkipReason(reason: any): string {
  if (String(reason ?? '') === 'low_signal_action_turn') return 'low-signal action turn';
  return String(reason ?? 'skipped').replace(/_/g, ' ');
}

function chatContextAttemptCounts(attempt: any): { injected: number; selected: number; filtered: number } {
  const refs = Array.isArray(attempt?.refs) ? attempt.refs : [];
  const previouslyInjected = (ref: any) => ref?.providerMetadata?.previouslyInjected === true || ref?.filterReason === 'previously_injected';
  return {
    injected: refs.filter((ref: any) => ref?.isInjected || ['injected', 'loaded', 'applied', 'provider_native'].includes(String(ref?.lifecycleStatus ?? ''))).length,
    selected: refs.filter((ref: any) => previouslyInjected(ref) || String(ref?.lifecycleStatus ?? '') === 'selected' || String(ref?.injectionMode ?? '') === 'manifest').length,
    filtered: refs.filter((ref: any) => !previouslyInjected(ref) && (ref?.isFiltered || ['filtered', 'rejected', 'skipped'].includes(String(ref?.lifecycleStatus ?? '')))).length,
  };
}
