import { useEffect, useState } from 'react';
import { ArrowDown, Loader2 } from 'lucide-react';
import { executions as api } from '../../services/api';

interface Checkpoint {
  _id: string;
  afterNode: string;
  state: Record<string, unknown>;
  createdAt: string;
}

interface Props {
  executionId: string;
}

/**
 * Chronological log of how the execution's shared `state` object evolved
 * over time. Each step corresponds to a completed node — the diff between
 * that node's checkpoint and the previous one tells you exactly which state
 * keys that node added / changed.
 *
 * Useful for answering "which node set `brandList`?" or "where did the value
 * of `categoryId` come from?" without trawling individual traces.
 */
export default function StateTimeline({ executionId }: Props) {
  const [checkpoints, setCheckpoints] = useState<Checkpoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api.checkpoints.list(executionId)
      .then((list) => {
        if (cancelled) return;
        const sorted = (list as Checkpoint[])
          .slice()
          .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
        setCheckpoints(sorted);
      })
      .catch((e) => !cancelled && setError((e as Error).message))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, [executionId]);

  if (loading) {
    return (
      <div className="text-[11px] text-theme-muted flex items-center gap-2">
        <Loader2 className="w-3 h-3 animate-spin" /> loading…
      </div>
    );
  }
  if (error) return <div className="text-[11px] text-accent-red font-mono">{error}</div>;
  if (checkpoints.length === 0) {
    return (
      <div className="border border-dashed border-app rounded-md p-5 text-center">
        <div className="text-xs text-theme-muted font-body">
          No state changes yet.
        </div>
        <div className="text-[11px] text-theme-subtle font-body mt-1">
          A step appears here each time a node completes.
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <ol className="space-y-0">
        {checkpoints.map((cp, i) => {
          const prev = i > 0 ? checkpoints[i - 1].state : {};
          const diff = diffState(prev, cp.state);
          const isExpanded = expanded.has(cp._id);
          const totalChanges = diff.added.length + diff.modified.length;
          const isLast = i === checkpoints.length - 1;

          return (
            <li key={cp._id} className="relative">
              {/* Vertical connector line to the next step */}
              {!isLast && (
                <span className="absolute left-[15px] top-[30px] bottom-[-16px] w-px bg-border/40" aria-hidden />
              )}

              <button
                onClick={() => {
                  setExpanded((prev) => {
                    const next = new Set(prev);
                    if (next.has(cp._id)) next.delete(cp._id);
                    else next.add(cp._id);
                    return next;
                  });
                }}
                className="w-full flex items-start gap-3 rounded-md p-2 hover:bg-app-muted transition-colors text-left"
              >
                {/* Step number bubble */}
                <div className="shrink-0 w-8 h-8 rounded-full border border-accent-blue/40 bg-accent-blue/10 flex items-center justify-center text-[11px] font-mono font-semibold text-accent-blue">
                  {i + 1}
                </div>

                <div className="flex-1 min-w-0">
                  <div className="flex items-baseline gap-2 flex-wrap">
                    <span className="text-sm font-mono text-theme-primary">{cp.afterNode}</span>
                    <span className="text-[10px] text-theme-subtle">
                      finished at {new Date(cp.createdAt).toLocaleTimeString()}
                    </span>
                  </div>
                  <div className="text-[11px] text-theme-muted font-body mt-0.5">
                    {totalChanges === 0 ? (
                      <span>No state keys changed.</span>
                    ) : (
                      <span>
                        {diff.added.length > 0 && (
                          <>
                            Added <span className="text-accent-green font-mono">{diff.added.length}</span>{' '}
                            new key{diff.added.length === 1 ? '' : 's'}
                          </>
                        )}
                        {diff.added.length > 0 && diff.modified.length > 0 && ', '}
                        {diff.modified.length > 0 && (
                          <>
                            modified <span className="text-accent-yellow font-mono">{diff.modified.length}</span>{' '}
                            existing{' '}
                            {diff.modified.length === 1 ? 'key' : 'keys'}
                          </>
                        )}
                        .
                      </span>
                    )}
                  </div>
                </div>
                <ArrowDown
                  className={`w-3 h-3 text-theme-subtle shrink-0 mt-2 transition-transform ${isExpanded ? 'rotate-180' : ''}`}
                />
              </button>

              {isExpanded && totalChanges > 0 && (
                <div className="ml-11 mb-2 space-y-2">
                  {diff.added.length > 0 && (
                    <div>
                      <div className="overline text-accent-green mb-1">
                        New keys
                      </div>
                      <div className="space-y-1">
                        {diff.added.map((k) => (
                          <div key={`+${k}`} className="border-l-2 border-accent-green/40 pl-2 py-1">
                            <div className="text-[11px] font-mono text-theme-primary">{k}</div>
                            <div className="text-[11px] font-mono text-theme-muted break-all whitespace-pre-wrap">
                              {previewValue((cp.state as Record<string, unknown>)[k])}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  {diff.modified.length > 0 && (
                    <div>
                      <div className="overline text-accent-yellow mb-1">
                        Modified keys
                      </div>
                      <div className="space-y-1">
                        {diff.modified.map((k) => (
                          <div key={`~${k}`} className="border-l-2 border-amber-400/40 pl-2 py-1">
                            <div className="text-[11px] font-mono text-theme-primary">{k}</div>
                            <div className="text-[10px] font-mono text-accent-red/80 break-all whitespace-pre-wrap">
                              <span className="text-theme-subtle">before: </span>
                              {previewValue((prev as Record<string, unknown>)[k])}
                            </div>
                            <div className="text-[10px] font-mono text-accent-green/80 break-all whitespace-pre-wrap">
                              <span className="text-theme-subtle">after: </span>
                              {previewValue((cp.state as Record<string, unknown>)[k])}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function diffState(before: Record<string, unknown>, after: Record<string, unknown>): {
  added: string[]; modified: string[];
} {
  const added: string[] = [];
  const modified: string[] = [];
  for (const k of Object.keys(after)) {
    if (!(k in before)) added.push(k);
    else if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) modified.push(k);
  }
  return { added, modified };
}

function previewValue(v: unknown): string {
  if (v === undefined) return '(unset)';
  if (v === null) return 'null';
  if (typeof v === 'string') return v.length > 200 ? `"${v.slice(0, 200)}…"` : `"${v}"`;
  if (typeof v === 'object') {
    const s = JSON.stringify(v);
    return s.length > 200 ? `${s.slice(0, 200)}…` : s;
  }
  return String(v);
}
