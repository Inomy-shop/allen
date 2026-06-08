import React, { useEffect, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle,
  Edit2,
  GitBranch,
  Loader2,
  MinusCircle,
  RefreshCw,
  X,
  XCircle,
  XOctagon,
} from 'lucide-react';
import { contextQuality } from '../../services/api';
import type { ReviewDecisionDoc, ReviewTaskDoc } from '../../services/contextQualityTypes';
import { useToast } from '../common/Toast';

interface Props {
  task: ReviewTaskDoc;
  onDecision: (taskId: string, action: string, notes?: string) => void;
  onClose: () => void;
  loading?: boolean;
}

interface EvidenceRef {
  kind: string;
  snippet?: string;
  score?: number;
  label?: string;
}

type TaskWithEvidence = ReviewTaskDoc & { evidence?: EvidenceRef[] };

function riskBadgeClass(risk: string): string {
  if (risk === 'critical' || risk === 'high') return 'badge badge-err';
  if (risk === 'medium') return 'badge badge-warn';
  return 'badge badge-ok';
}

function statusBadgeClass(status: string): string {
  if (status === 'done' || status === 'approved') return 'badge badge-ok';
  if (status === 'rejected' || status === 'remediation_failed') return 'badge badge-err';
  if (status === 'in_review' || status === 'in_remediation') return 'badge badge-info';
  if (status === 'changes_requested') return 'badge badge-warn';
  return 'badge badge-muted';
}

function queueBadgeClass(queue: string): string {
  if (queue === 'open') return 'badge badge-warn';
  if (queue === 'auto_remediated') return 'badge badge-ok';
  if (queue === 'dispatched') return 'badge badge-info';
  return 'badge badge-muted';
}

const DECISION_ACTIONS = [
  { action: 'approve', label: 'Approve', icon: CheckCircle, cls: 'btn btn-primary btn-sm' },
  { action: 'reject', label: 'Reject', icon: XCircle, cls: 'btn btn-danger btn-sm' },
  { action: 'request_changes', label: 'Request Changes', icon: Edit2, cls: 'btn btn-secondary btn-sm' },
];

const SHOW_ACTIONS_STATUSES = new Set(['pending', 'in_review', 'changes_requested']);

export default function ContextReviewDetail({ task, onDecision, onClose, loading = false }: Props) {
  const toast = useToast();
  const [notes, setNotes] = useState('');
  const [decisions, setDecisions] = useState<ReviewDecisionDoc[]>([]);

  useEffect(() => {
    contextQuality.listHistory({ taskId: task.taskId, limit: 10 }).then(setDecisions).catch(() => {});
  }, [task.taskId]);

  const showActions = task.requiresHumanReview || SHOW_ACTIONS_STATUSES.has(task.status);

  const handleDecision = (action: string) => {
    onDecision(task.taskId, action, notes || undefined);
  };

  const handleExtraAction = async (action: string) => {
    try {
      await contextQuality.addDecision(task.taskId, { actor: 'user', action, notes: notes || undefined });
      toast.success(`Marked as ${action.replace(/_/g, ' ')}`);
      onClose();
    } catch {
      toast.error(`Failed to mark as ${action}`);
    }
  };

  const handleRejudge = async () => {
    try {
      await contextQuality.rejudge(task.judgeRunId);
      toast.success('Re-judge triggered');
      onClose();
    } catch {
      toast.error('Failed to trigger re-judge');
    }
  };

  const handleSplitTask = async () => {
    if (!task.affectedRepos?.length) return;
    try {
      await contextQuality.splitTask(task.taskId, { repoIds: task.affectedRepos });
      toast.success('Task split into repo-scoped tasks');
      onClose();
    } catch {
      toast.error('Failed to split task');
    }
  };

  const taskIdShort = task.taskId.length > 16 ? `…${task.taskId.slice(-12)}` : task.taskId;

  const evidence = (task as TaskWithEvidence).evidence;

  return (
    <div className="relative flex flex-col h-full border-l border-app bg-app overflow-y-auto">
      {/* Loading overlay */}
      {loading && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-app/70">
          <Loader2 className="w-6 h-6 animate-spin text-theme-muted" />
        </div>
      )}

      {/* Header */}
      <div className="flex items-center justify-between gap-2 px-4 py-3 border-b border-app sticky top-0 bg-app z-[1]">
        <div className="flex items-center gap-2 min-w-0">
          <span className="font-mono text-xs text-theme-muted truncate" title={task.taskId}>{taskIdShort}</span>
          <span className={queueBadgeClass(task.queue)}>{task.queue}</span>
          <span className={statusBadgeClass(task.status)}>{task.status.replace(/_/g, ' ')}</span>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="shrink-0 text-theme-muted hover:text-theme-primary transition-colors"
          aria-label="Close detail panel"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="flex-1 px-4 py-3 space-y-4">
        {/* Human review gate */}
        {task.requiresHumanReview && task.humanReviewReason && (
          <div className="flex items-start gap-2 rounded-md border border-app bg-app-muted px-3 py-2.5 text-xs text-theme-primary">
            <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0 text-accent-yellow" />
            <span><strong>Human review required:</strong> {task.humanReviewReason}</span>
          </div>
        )}

        {/* Classification / Fix Type */}
        <section>
          <h3 className="text-[11px] font-semibold uppercase tracking-wide text-theme-muted mb-1.5">Classification</h3>
          <div className="flex flex-wrap gap-1.5 text-xs">
            <span className="badge badge-muted">{task.scope}</span>
            <span className="badge badge-info">{task.fixType}</span>
          </div>
        </section>

        {/* Evidence refs */}
        {evidence && evidence.length > 0 && (
          <section>
            <h3 className="text-[11px] font-semibold uppercase tracking-wide text-theme-muted mb-1.5">Evidence</h3>
            <ul className="space-y-1">
              {evidence.map((ref, i) => (
                <li key={i} className="text-xs text-theme-secondary bg-app-muted rounded px-2 py-1.5">
                  <span className="badge badge-muted mr-1.5">{ref.kind}</span>
                  {ref.snippet && <span className="text-theme-primary">{ref.snippet}</span>}
                  {ref.score !== undefined && <span className="text-theme-muted ml-1">(score: {ref.score.toFixed(2)})</span>}
                  {ref.label && <span className="text-theme-muted ml-1">— {ref.label}</span>}
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* Scope Details for cross_repo / global */}
        {(task.scope === 'cross_repo' || task.scope === 'global') && (
          <section>
            <h3 className="text-[11px] font-semibold uppercase tracking-wide text-theme-muted mb-1.5">Scope Details</h3>
            <div className="text-xs space-y-1">
              {task.parentTaskId && (
                <div className="text-theme-muted">
                  Parent task: <span className="font-mono text-theme-secondary">{task.parentTaskId.slice(-8)}</span>
                </div>
              )}
              {task.childTaskIds && task.childTaskIds.length > 0 && (
                <div className="text-theme-muted">Child tasks: {task.childTaskIds.length} repo-scoped tasks</div>
              )}
            </div>
          </section>
        )}

        {/* Confidence / Risk / Reliability */}
        <section>
          <h3 className="text-[11px] font-semibold uppercase tracking-wide text-theme-muted mb-1.5">Assessment</h3>
          <div className="flex flex-wrap gap-2 text-xs">
            <div className="flex items-center gap-1 text-theme-secondary">
              <span className="text-theme-muted">Confidence:</span>
              <span className="font-medium text-theme-primary">{Math.round(task.confidence * 100)}%</span>
            </div>
            <span className={riskBadgeClass(task.risk)}>{task.risk} risk</span>
            <span className="badge badge-muted">{task.reliabilityLabel}</span>
            {task.severity && (
              <div className="flex items-center gap-1.5">
                <span className="text-theme-muted text-xs">Severity:</span>
                <span className="badge badge-muted">{task.severity}</span>
              </div>
            )}
            <span className="text-theme-muted text-[10.5px]">
              {task.reliabilityLabel === 'confirmed' && '(score ≥ 0.80 — high reliability)'}
              {task.reliabilityLabel === 'needs_judge' && '(score 0.50–0.79 — needs review)'}
              {task.reliabilityLabel === 'signal_only' && '(score 0.20–0.49 — advisory only)'}
              {task.reliabilityLabel === 'rejected' && '(score < 0.20 — low signal)'}
            </span>
          </div>
        </section>

        {/* Affected Repos */}
        {task.affectedRepos && task.affectedRepos.length > 0 && (
          <section>
            <h3 className="text-[11px] font-semibold uppercase tracking-wide text-theme-muted mb-1.5">Affected Repos</h3>
            <div className="flex flex-wrap gap-1">
              {task.affectedRepos.map((r) => (
                <span key={r} className="badge badge-muted">{r}</span>
              ))}
            </div>
          </section>
        )}

        {/* Judge Rationale */}
        {(task as any).judgeRationale && (
          <section>
            <h3 className="text-[11px] font-semibold uppercase tracking-wide text-theme-muted mb-1.5">Judge Rationale</h3>
            <p className="text-xs text-theme-secondary bg-app-muted rounded px-3 py-2">{(task as any).judgeRationale}</p>
          </section>
        )}

        {/* Learning link */}
        {task.learningId && (
          <section>
            <h3 className="text-[11px] font-semibold uppercase tracking-wide text-theme-muted mb-1.5">Linked Learning</h3>
            <div className="text-xs font-mono text-theme-secondary">{task.learningId}</div>
          </section>
        )}

        {/* Linked Remediation */}
        {task.remediationId && (
          <section>
            <h3 className="text-[11px] font-semibold uppercase tracking-wide text-theme-muted mb-1.5">Remediation Task</h3>
            <div className="text-xs font-mono text-theme-secondary">{task.remediationId.slice(-16)}</div>
          </section>
        )}

        {/* Split Task (cross_repo / global with multiple affected repos and no children yet) */}
        {(task.scope === 'cross_repo' || task.scope === 'global') && !task.childTaskIds?.length && task.affectedRepos && task.affectedRepos.length > 1 && (
          <section>
            <h3 className="text-[11px] font-semibold uppercase tracking-wide text-theme-muted mb-1.5">Split into Repo Tasks</h3>
            <p className="text-xs text-theme-muted mb-2">Split this cross-repo finding into individual repo-scoped tasks.</p>
            <button
              type="button"
              onClick={() => { void handleSplitTask(); }}
              disabled={loading}
              className="btn btn-secondary btn-sm"
            >
              <GitBranch className="w-3.5 h-3.5" />
              Split Task
            </button>
          </section>
        )}

        {/* Suggested fix */}
        {task.suggestedRemediation && (
          <section>
            <h3 className="text-[11px] font-semibold uppercase tracking-wide text-theme-muted mb-1.5">Suggested Fix</h3>
            <pre className="rounded-md bg-app-muted border border-app px-3 py-2 text-[11.5px] font-mono text-theme-secondary whitespace-pre-wrap break-all">
              {task.suggestedRemediation}
            </pre>
          </section>
        )}

        {/* Decision actions */}
        {showActions && (
          <section>
            <h3 className="text-[11px] font-semibold uppercase tracking-wide text-theme-muted mb-2">Decision</h3>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Optional notes…"
              rows={2}
              className="w-full rounded-md border border-app bg-app-muted px-3 py-2 text-[12px] text-theme-primary placeholder:text-theme-subtle resize-none focus:outline-none focus:border-accent mb-2"
              aria-label="Decision notes"
            />
            <div className="flex flex-wrap gap-2">
              {DECISION_ACTIONS.map(({ action, label, icon: Icon, cls }) => {
                // Only show Approve if human review is required
                if (action === 'approve' && !task.requiresHumanReview) return null;
                return (
                  <button
                    key={action}
                    type="button"
                    onClick={() => handleDecision(action)}
                    disabled={loading}
                    className={cls}
                    aria-label={label}
                  >
                    <Icon className="w-3.5 h-3.5" />
                    {label}
                  </button>
                );
              })}
            </div>

            {/* Extra actions */}
            <div className="flex flex-wrap gap-2 mt-2 pt-2 border-t border-app">
              <button
                type="button"
                onClick={() => { void handleExtraAction('no_action'); }}
                disabled={loading}
                className="btn btn-secondary btn-sm"
              >
                <MinusCircle className="w-3.5 h-3.5" />
                No Action
              </button>
              <button
                type="button"
                onClick={() => { void handleExtraAction('mark_false_positive'); }}
                disabled={loading}
                className="btn btn-secondary btn-sm"
              >
                <XOctagon className="w-3.5 h-3.5" />
                False Positive
              </button>
              <button
                type="button"
                onClick={() => { void handleRejudge(); }}
                disabled={loading}
                className="btn btn-secondary btn-sm"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                Re-judge
              </button>
            </div>
          </section>
        )}

        {/* Decision History */}
        {decisions.length > 0 && (
          <section>
            <h3 className="text-[11px] font-semibold uppercase tracking-wide text-theme-muted mb-1.5">Decision History</h3>
            <ul className="space-y-1">
              {decisions.map((d) => (
                <li key={d.decisionId} className="flex items-center gap-2 text-xs text-theme-secondary">
                  <span className="badge badge-muted">{d.action}</span>
                  <span className="text-theme-muted">{d.actor}</span>
                  {d.notes && <span className="text-theme-muted truncate">— {d.notes}</span>}
                  <span className="text-theme-subtle ml-auto">{new Date(d.createdAt).toLocaleTimeString()}</span>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>

      {/* Audit strip */}
      <div className="px-4 py-2 border-t border-app text-[11px] text-theme-muted">
        Created {new Date(task.createdAt).toLocaleString()} · Updated {new Date(task.updatedAt).toLocaleString()}
      </div>
    </div>
  );
}
