import { useEffect, useState } from 'react';
import {
  AlertCircle,
  ChevronDown,
  ChevronRight,
  Clock,
  Edit2,
  Eye,
  GitBranch,
  Loader2,
  MessageSquare,
  Play,
  Save,
} from 'lucide-react';
import { executions as api } from '../../services/api';
import CheckpointEditorModal from './CheckpointEditorModal';
import StateDiffModal from './StateDiffModal';
import type { WorkflowFeedbackEntry } from './WorkflowFeedbackDrawer';

interface CheckpointDoc {
  _id: string;
  executionId: string;
  afterNode: string;
  state: Record<string, unknown>;
  sessions: Record<string, string>;
  retryCounts: Record<string, number>;
  completedNodes: string[];
  createdAt: string;
  editedAt?: string;
  editedBy?: string;
}

interface Props {
  executionId: string;
  executionStatus: string;
  feedbackEntries?: WorkflowFeedbackEntry[];
  canAppendFeedback?: boolean;
  agentNodeNames?: string[];
  onFeedbackCreated?: (entries: WorkflowFeedbackEntry[]) => void;
  onRefreshExecution?: () => void | Promise<void>;
  onResumeStarted?: (node?: string) => void;
}

/**
 * "Checkpoints" panel on the ExecutionDetailPage. Lists every checkpoint
 * saved during the run and exposes per-checkpoint actions:
 *   - View    → expand inline full state
 *   - Edit    → opens CheckpointEditorModal (blocked if exec is active)
 *   - Run     → resume same execution id from this checkpoint (failed/cancelled only)
 *   - Fork    → create a new execution id seeded from this checkpoint
 */
export default function CheckpointsPanel({
  executionId,
  executionStatus,
  feedbackEntries = [],
  canAppendFeedback = false,
  agentNodeNames = [],
  onFeedbackCreated,
  onRefreshExecution,
  onResumeStarted,
}: Props) {
  const [checkpoints, setCheckpoints] = useState<CheckpointDoc[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<CheckpointDoc | null>(null);
  const [busy, setBusy] = useState<Record<string, 'run' | 'fork' | null>>({});
  const runningCheckpointId = Object.entries(busy).find(([, value]) => value === 'run')?.[0] ?? null;
  /** Multi-select set of checkpoint ids for diffing. When exactly 2 are
   *  selected, the "Compare selected" button lights up and opens the diff. */
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [diffing, setDiffing] = useState<[CheckpointDoc, CheckpointDoc] | null>(null);
  const [commonFeedback, setCommonFeedback] = useState('');
  const [commonTargets, setCommonTargets] = useState<string[]>([]);
  const [checkpointFeedbackOpen, setCheckpointFeedbackOpen] = useState<string | null>(null);
  const [checkpointFeedbackDrafts, setCheckpointFeedbackDrafts] = useState<Record<string, string>>({});
  const [feedbackBusy, setFeedbackBusy] = useState<string | null>(null);
  const [feedbackError, setFeedbackError] = useState<string | null>(null);

  const isActive = executionStatus === 'running' || executionStatus === 'waiting_for_input';
  const canRunFromCheckpoint = executionStatus === 'completed'
    || executionStatus === 'failed'
    || executionStatus === 'cancelled';

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      const list = await api.checkpoints.list(executionId);
      setCheckpoints(list as CheckpointDoc[]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { refresh(); }, [executionId]);

  function toggleExpand(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  async function handleRun(cp: CheckpointDoc) {
    setBusy((b) => ({ ...b, [cp._id]: 'run' }));
    try {
      onResumeStarted?.(cp.afterNode);
      await api.checkpoints.run(executionId, cp._id);
      window.setTimeout(() => { void onRefreshExecution?.(); }, 750);
    } catch (e) {
      alert(`Could not resume: ${(e as Error).message}`);
      await onRefreshExecution?.();
    } finally {
      setBusy((b) => ({ ...b, [cp._id]: null }));
    }
  }

  async function handleFork(cp: CheckpointDoc) {
    setBusy((b) => ({ ...b, [cp._id]: 'fork' }));
    try {
      const result = await api.checkpoints.fork(executionId, cp._id);
      // Navigate to the new execution
      window.location.href = `/executions/${result.newExecutionId}`;
    } catch (e) {
      alert(`Could not fork: ${(e as Error).message}`);
    } finally {
      setBusy((b) => ({ ...b, [cp._id]: null }));
    }
  }

  async function addCommonFeedback() {
    const trimmed = commonFeedback.trim();
    if (!trimmed) return;
    setFeedbackBusy('common');
    setFeedbackError(null);
    try {
      const targets = commonTargets.length > 0 ? commonTargets : undefined;
      const entry = await api.feedback.create(executionId, trimmed, targets);
      onFeedbackCreated?.([entry]);
      setCommonFeedback('');
      setCommonTargets([]);
      onRefreshExecution?.();
    } catch (e) {
      setFeedbackError((e as Error).message);
    } finally {
      setFeedbackBusy(null);
    }
  }

  async function addCheckpointFeedback(cp: CheckpointDoc) {
    const trimmed = (checkpointFeedbackDrafts[cp._id] ?? '').trim();
    if (!trimmed) return;
    if (!agentNodeNames.includes(cp.afterNode)) {
      setFeedbackError(`Feedback can only target agent nodes. ${cp.afterNode} is not an agent node.`);
      return;
    }
    setFeedbackBusy(cp._id);
    setFeedbackError(null);
    try {
      const entry = await api.feedback.create(executionId, trimmed, [cp.afterNode]);
      onFeedbackCreated?.([entry]);
      setCheckpointFeedbackDrafts((prev) => ({ ...prev, [cp._id]: '' }));
      setCheckpointFeedbackOpen(null);
      onRefreshExecution?.();
    } catch (e) {
      setFeedbackError((e as Error).message);
    } finally {
      setFeedbackBusy(null);
    }
  }

  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-app bg-surface p-3 space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <MessageSquare className="w-4 h-4 text-accent-blue" />
            <div>
              <div className="font-label text-xs uppercase tracking-widest text-theme-muted">Feedback</div>
              <div className="text-[10px] font-mono text-theme-subtle">
                {feedbackEntries.length} existing · shared or selected node targets
              </div>
            </div>
          </div>
        </div>
        {canAppendFeedback ? (
          <>
            <textarea
              value={commonFeedback}
              onChange={(e) => setCommonFeedback(e.target.value)}
              rows={3}
              className="w-full resize-y rounded-md border border-app bg-app-card px-3 py-2 text-xs text-theme-primary placeholder:text-theme-subtle focus:border-accent-blue focus:outline-none"
              placeholder="Common feedback for the next rerun..."
            />
            {agentNodeNames.length > 0 && (
              <div className="max-h-36 overflow-y-auto rounded-md border border-app bg-app-card p-2">
                <label className="flex items-center gap-2 py-1 font-mono text-[11px] text-theme-secondary">
                  <input
                    type="checkbox"
                    checked={commonTargets.length === 0}
                    onChange={() => setCommonTargets([])}
                    className="accent-accent-blue"
                  />
                  All agent nodes
                </label>
                <div className="grid grid-cols-2 gap-x-3">
                  {agentNodeNames.map((nodeName) => (
                    <label key={nodeName} className="flex min-w-0 items-center gap-2 py-1 font-mono text-[11px] text-theme-secondary">
                      <input
                        type="checkbox"
                        checked={commonTargets.includes(nodeName)}
                        onChange={() => {
                          setCommonTargets((prev) =>
                            prev.includes(nodeName)
                              ? prev.filter((node) => node !== nodeName)
                              : [...prev, nodeName],
                          );
                        }}
                        className="accent-accent-blue"
                      />
                      <span className="truncate" title={nodeName}>{nodeName}</span>
                    </label>
                  ))}
                </div>
              </div>
            )}
            <div className="flex items-center justify-between gap-3">
              <div className="font-mono text-[11px] text-theme-subtle">
                {commonTargets.length === 0 ? 'Applies to all agent nodes' : `Applies to ${commonTargets.length} selected node${commonTargets.length === 1 ? '' : 's'}`}
              </div>
              <button
                type="button"
                onClick={addCommonFeedback}
                disabled={feedbackBusy != null || !commonFeedback.trim()}
                className="btn-primary text-xs disabled:cursor-not-allowed disabled:opacity-40"
              >
                {feedbackBusy === 'common' ? 'Adding...' : 'Add Feedback'}
              </button>
            </div>
          </>
        ) : (
          <div className="rounded-md border border-dashed border-app px-3 py-2 text-center text-xs text-theme-muted">
            Feedback can be added after a run is completed, failed, or cancelled.
          </div>
        )}
        {feedbackError && <div className="font-mono text-[11px] text-accent-red">{feedbackError}</div>}
      </div>

      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Save className="w-4 h-4 text-accent-blue" />
          <h2 className="font-label text-xs uppercase tracking-widest text-theme-muted">Saved states to rerun from</h2>
          {!loading && <span className="text-[10px] font-mono text-theme-subtle">{checkpoints.length} saved</span>}
        </div>
        {runningCheckpointId && (
          <span className="inline-flex items-center gap-1.5 rounded-full border border-accent-blue/25 bg-accent-blue/10 px-2 py-1 font-mono text-[10px] text-accent-blue">
            <Loader2 className="h-3 w-3 animate-spin" />
            Resuming saved state…
          </span>
        )}
        {selected.size >= 2 && (
          <button
            onClick={() => {
              const arr = checkpoints.filter((c) => selected.has(c._id));
              if (arr.length >= 2) setDiffing([arr[arr.length - 1], arr[0]]);
            }}
            className="text-[11px] font-mono px-2 py-1 rounded-md border border-accent-blue/40 text-accent-blue hover:bg-accent-blue/10 transition-colors"
            title="Show state diff between the selected checkpoints"
          >
            Compare {selected.size}
          </button>
        )}
      </div>

      {error && <div className="text-xs text-accent-red font-mono">{error}</div>}

      {loading ? (
        <div className="text-xs text-theme-muted flex items-center gap-2">
          <Loader2 className="w-3 h-3 animate-spin" /> loading…
        </div>
      ) : checkpoints.length === 0 ? (
        <div className="border border-dashed border-app rounded-lg p-6 text-center">
          <AlertCircle className="w-5 h-5 mx-auto text-theme-subtle mb-1.5" />
          <div className="text-xs text-theme-muted font-body">
            No saved states are available yet.
          </div>
          <div className="text-[11px] text-theme-subtle font-body mt-1">
            A saved state is written after each node completes successfully.
          </div>
        </div>
      ) : (
        <div className="space-y-1.5">
          {checkpoints.map((cp) => (
            <div
              key={cp._id}
              className="border border-app rounded-lg bg-app-card overflow-hidden"
            >
              <div className="flex items-center gap-3 px-3 py-2">
                <input
                  type="checkbox"
                  checked={selected.has(cp._id)}
                  onChange={() => {
                    setSelected((prev) => {
                      const next = new Set(prev);
                      if (next.has(cp._id)) next.delete(cp._id);
                      else next.add(cp._id);
                      return next;
                    });
                  }}
                  className="accent-accent-blue"
                  title="Select for comparison"
                />
                <button
                  onClick={() => toggleExpand(cp._id)}
                  className="text-theme-muted hover:text-theme-secondary"
                  title={expanded.has(cp._id) ? 'Collapse' : 'Expand details'}
                >
                  {expanded.has(cp._id)
                    ? <ChevronDown className="w-4 h-4" />
                    : <ChevronRight className="w-4 h-4" />}
                </button>
                <Clock className="w-3.5 h-3.5 text-theme-subtle shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-mono text-theme-primary">
                      {cp.afterNode}
                    </span>
                    <span className="text-[10px] font-mono text-theme-subtle">
                      {new Date(cp.createdAt).toLocaleString()}
                    </span>
                    {cp.editedAt && (
                      <span
                        className="text-[10px] font-mono text-accent-yellow flex items-center gap-0.5"
                        title={`Edited ${new Date(cp.editedAt).toLocaleString()}`}
                      >
                        <Edit2 className="w-2.5 h-2.5" /> edited
                      </span>
                    )}
                  </div>
                  <div className="text-[10px] text-theme-muted font-mono truncate">
                    {cp.completedNodes.length} node{cp.completedNodes.length === 1 ? '' : 's'} completed · {Object.keys(cp.state).length} state keys
                  </div>
                </div>

                <div className="flex items-center gap-1 shrink-0">
                  <button
                    onClick={() => toggleExpand(cp._id)}
                    className="p-1.5 rounded-md hover:bg-app-muted text-theme-muted hover:text-accent-blue transition-colors"
                    title="View full state"
                  >
                    <Eye className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={() => setEditing(cp)}
                    disabled={isActive}
                    className="p-1.5 rounded-md hover:bg-app-muted text-theme-muted hover:text-accent-yellow disabled:opacity-30 transition-colors"
                    title={isActive ? 'Can\'t edit while execution is active' : 'Edit state'}
                  >
                    <Edit2 className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={() => handleRun(cp)}
                    disabled={!canRunFromCheckpoint || runningCheckpointId != null || busy[cp._id] === 'run'}
                    className="p-1.5 rounded-md hover:bg-app-muted text-theme-muted hover:text-accent-green disabled:opacity-30 transition-colors"
                    title={canRunFromCheckpoint
                      ? 'Resume this execution from this saved state'
                      : 'Only completed, failed, or cancelled executions can resume'}
                  >
                    {busy[cp._id] === 'run'
                      ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      : <Play className="w-3.5 h-3.5" />}
                  </button>
                  <button
                    onClick={() => handleFork(cp)}
                    disabled={runningCheckpointId != null || busy[cp._id] === 'fork'}
                    className="p-1.5 rounded-md hover:bg-app-muted text-theme-muted hover:text-accent-blue disabled:opacity-30 transition-colors"
                    title="Fork: create a new execution from this saved state"
                  >
                    {busy[cp._id] === 'fork'
                      ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      : <GitBranch className="w-3.5 h-3.5" />}
                  </button>
                  <button
                    onClick={() => {
                      setCheckpointFeedbackOpen((current) => current === cp._id ? null : cp._id);
                      setFeedbackError(null);
                    }}
                    disabled={!canAppendFeedback || !agentNodeNames.includes(cp.afterNode)}
                    className="p-1.5 rounded-md hover:bg-app-muted text-theme-muted hover:text-accent-blue disabled:opacity-30 transition-colors"
                    title={
                      !canAppendFeedback
                        ? 'Feedback can be added after the run is terminal'
                        : agentNodeNames.includes(cp.afterNode)
                          ? `Add feedback for ${cp.afterNode}`
                          : 'Feedback can only target agent nodes'
                    }
                  >
                    <MessageSquare className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>

              {checkpointFeedbackOpen === cp._id && (
                <div className="border-t border-app bg-surface-200/20 px-3 py-3 space-y-2">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="text-[11px] font-semibold text-theme-primary">Feedback for {cp.afterNode}</div>
                      <div className="text-[10px] font-mono text-theme-subtle">Targets this checkpoint node on the next rerun.</div>
                    </div>
                    <button
                      type="button"
                      onClick={() => setCheckpointFeedbackOpen(null)}
                      className="text-[10px] font-mono text-theme-muted hover:text-theme-primary"
                    >
                      Close
                    </button>
                  </div>
                  <textarea
                    value={checkpointFeedbackDrafts[cp._id] ?? ''}
                    onChange={(e) => setCheckpointFeedbackDrafts((prev) => ({ ...prev, [cp._id]: e.target.value }))}
                    rows={3}
                    className="w-full resize-y rounded-md border border-app bg-app-card px-3 py-2 text-xs text-theme-primary placeholder:text-theme-subtle focus:border-accent-blue focus:outline-none"
                    placeholder={`Feedback for ${cp.afterNode}`}
                  />
                  <div className="flex justify-end">
                    <button
                      type="button"
                      onClick={() => addCheckpointFeedback(cp)}
                      disabled={feedbackBusy != null || !(checkpointFeedbackDrafts[cp._id] ?? '').trim()}
                      className="btn-primary text-xs disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      {feedbackBusy === cp._id ? 'Adding...' : 'Add Node Feedback'}
                    </button>
                  </div>
                </div>
              )}

              {expanded.has(cp._id) && (
                <div className="border-t border-app bg-surface-200/20 px-3 py-3 space-y-2">
                  <div className="flex gap-3 text-xs">
                    <div className="w-24 shrink-0 overline pt-0.5">
                      Completed
                    </div>
                    <div className="flex-1 font-mono text-[11px] text-theme-secondary break-all">
                      {cp.completedNodes.length > 0 ? cp.completedNodes.join(' · ') : '(none)'}
                    </div>
                  </div>
                  <div className="flex gap-3 text-xs">
                    <div className="w-24 shrink-0 overline pt-0.5">
                      State
                    </div>
                    <div className="flex-1 min-w-0">
                      <pre className="bg-app-card border border-app rounded p-2 font-mono text-[10px] text-theme-secondary overflow-x-auto max-h-64">
                        {JSON.stringify(cp.state, null, 2)}
                      </pre>
                    </div>
                  </div>
                  {Object.keys(cp.sessions).length > 0 && (
                    <div className="flex gap-3 text-xs">
                      <div className="w-24 shrink-0 overline pt-0.5">
                        Sessions
                      </div>
                      <div className="flex-1 font-mono text-[11px] text-theme-subtle">
                        {Object.entries(cp.sessions).map(([k, v]) => (
                          <div key={k}>
                            <span className="text-theme-secondary">{k}</span> · {v}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {editing && (
        <CheckpointEditorModal
          executionId={executionId}
          checkpointId={editing._id}
          initialState={editing.state}
          afterNode={editing.afterNode}
          locked={isActive}
          lockedReason={isActive ? `Execution is ${executionStatus}.` : undefined}
          onClose={() => setEditing(null)}
          onSaved={refresh}
        />
      )}

      {diffing && (
        <StateDiffModal
          titleLeft={`${diffing[0].afterNode} @ ${new Date(diffing[0].createdAt).toLocaleTimeString()}`}
          titleRight={`${diffing[1].afterNode} @ ${new Date(diffing[1].createdAt).toLocaleTimeString()}`}
          left={diffing[0].state}
          right={diffing[1].state}
          onClose={() => setDiffing(null)}
        />
      )}
    </div>
  );
}
