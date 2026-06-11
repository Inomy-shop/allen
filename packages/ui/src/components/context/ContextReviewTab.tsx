import React, { useCallback, useEffect, useState } from 'react';
import { RotateCcw } from 'lucide-react';
import { contextQuality } from '../../services/api';
import type { LearningPromotionDoc, RemediationDoc, ReviewTaskDoc } from '../../services/contextQualityTypes';
import ContextReviewFilters, { type ReviewFilters } from './ContextReviewFilters';
import ContextReviewDetail from './ContextReviewDetail';
import { useToast } from '../common/Toast';

interface Props {
  repoId?: string;
  initialTaskId?: string;
}

type Queue =
  | 'open'
  | 'needs_review'
  | 'global_cross_repo'
  | 'learning_to_context'
  | 'auto_remediated'
  | 'dispatched'
  | 'needs_re_judge'
  | 'dismissed'
  | 'no_action'
  | 'history';

type SelectedReviewItem =
  | { kind: 'task'; id: string }
  | { kind: 'remediation'; id: string }
  | { kind: 'promotion'; id: string };

const QUEUE_LABELS: Record<Queue, string> = {
  open: 'Open',
  needs_review: 'Needs Review',
  global_cross_repo: 'Cross-Repo',
  learning_to_context: 'Learning',
  auto_remediated: 'Auto-Fixed',
  dispatched: 'Dispatched',
  needs_re_judge: 'Re-judge',
  dismissed: 'Dismissed',
  no_action: 'No Action',
  history: 'History',
};

const PAGE_SIZE = 50;

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

export default function ContextReviewTab({ repoId, initialTaskId }: Props) {
  const toast = useToast();
  const [activeQueue, setActiveQueue] = useState<Queue>('open');
  const [filters, setFilters] = useState<ReviewFilters>({});
  const [tasks, setTasks] = useState<ReviewTaskDoc[]>([]);
  const [promotions, setPromotions] = useState<LearningPromotionDoc[]>([]);
  const [dispatchedRemediations, setDispatchedRemediations] = useState<RemediationDoc[]>([]);
  const [queues, setQueues] = useState<Record<string, number>>({});
  const [selectedItem, setSelectedItem] = useState<SelectedReviewItem | null>(initialTaskId ? { kind: 'task', id: initialTaskId } : null);
  const [page, setPage] = useState(0);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [decisionLoading, setDecisionLoading] = useState(false);
  const [runLoading, setRunLoading] = useState(false);

  const resolvedRepoId = repoId && repoId !== 'all' ? repoId : undefined;

  const loadQueues = useCallback(async () => {
    try {
      const counts = await contextQuality.getQueues();
      setQueues(counts);
    } catch {
      // non-critical, swallow
    }
  }, []);

  const loadTasks = useCallback(async () => {
    setLoading(true);
    try {
      const offset = page * PAGE_SIZE;
      const apiParams: Record<string, string | number | boolean | undefined> = {
        repoId: resolvedRepoId,
        scope: filters.scope || undefined,
        fixType: filters.fixType || undefined,
        risk: filters.riskLevel || undefined,
        confidenceBand: filters.confidenceBand || undefined,
        sourceType: filters.sourceType || undefined,
        severity: filters.severity || undefined,
        classification: filters.classification || undefined,
        status: filters.status || undefined,
        limit: PAGE_SIZE,
        offset,
      };
      // Remove undefined values
      const cleanParams: Record<string, string | number | boolean> = {};
      for (const [k, v] of Object.entries(apiParams)) {
        if (v !== undefined) cleanParams[k] = v;
      }
      if (activeQueue === 'learning_to_context') {
        const results = await contextQuality.listPromotionsPaged({
          repoId: resolvedRepoId,
          status: filters.status || undefined,
          limit: PAGE_SIZE,
          offset,
        });
        setPromotions(results.items);
        setDispatchedRemediations([]);
        setTasks([]);
        setTotal(results.total);
      } else if (activeQueue === 'dispatched') {
        const results = await contextQuality.listRemediationsPaged({
          repoId: resolvedRepoId,
          status: 'dispatched,running',
          includeAssignments: true,
          includeRevisions: true,
          limit: PAGE_SIZE,
          offset,
        });
        setDispatchedRemediations(results.items);
        setPromotions([]);
        setTasks([]);
        setTotal(results.total);
      } else if (activeQueue === 'auto_remediated') {
        const results = await contextQuality.listRemediationsPaged({ repoId: resolvedRepoId, status: 'completed', includeAssignments: true, includeRevisions: true, limit: PAGE_SIZE, offset });
        setDispatchedRemediations(results.items);
        setPromotions([]);
        setTasks([]);
        setTotal(results.total);
      } else if (activeQueue === 'history') {
        const results = await contextQuality.listRemediationsPaged({ repoId: resolvedRepoId, status: 'failed', includeAssignments: true, includeRevisions: true, limit: PAGE_SIZE, offset });
        setDispatchedRemediations(results.items);
        setPromotions([]);
        setTasks([]);
        setTotal(results.total);
      } else {
        const results = await contextQuality.listQueuePaged(activeQueue, cleanParams);
        setTasks(results.items);
        setPromotions([]);
        setDispatchedRemediations([]);
        setTotal(results.total);
      }
    } catch (e: unknown) {
      const err = e as Error;
      toast.error(err.message ?? 'Failed to load review tasks');
    } finally {
      setLoading(false);
    }
  }, [activeQueue, filters, page, resolvedRepoId, toast]);

  useEffect(() => {
    void loadTasks();
    void loadQueues();
  }, [loadTasks, loadQueues]);

  const handleDecision = async (taskId: string, action: string, notes?: string) => {
    setDecisionLoading(true);
    try {
      await contextQuality.addDecision(taskId, { actor: 'user', action, notes });
      toast.success(`Decision recorded: ${action}`);
      setSelectedItem(null);
      await loadTasks();
      await loadQueues();
    } catch {
      toast.error('Failed to record decision');
    } finally {
      setDecisionLoading(false);
    }
  };

  const handleTriggerJudge = async () => {
    setRunLoading(true);
    try {
      const body: { repoId?: string; triggeredBy: string; global?: boolean } = { triggeredBy: 'ui' };
      if (resolvedRepoId) {
        body.repoId = resolvedRepoId;
      } else {
        body.global = true;
      }
      await contextQuality.triggerOrchestrator(body);
      toast.success(resolvedRepoId ? `Context judge triggered for repo ${resolvedRepoId}` : 'Context judge triggered globally');
    } catch {
      toast.error('Failed to trigger context judge');
    } finally {
      setRunLoading(false);
    }
  };

  const handleRejudge = async (judgeRunId: string) => {
    try {
      await contextQuality.rejudge(judgeRunId);
      toast.success('Re-judge triggered');
      await loadTasks();
    } catch {
      toast.error('Failed to trigger re-judge');
    }
  };

  const selectedTask = selectedItem?.kind === 'task' ? tasks.find((t) => t.taskId === selectedItem.id) ?? null : null;
  const selectedRemediation = selectedItem?.kind === 'remediation' ? dispatchedRemediations.find((r) => r.remediationId === selectedItem.id) ?? null : null;
  const selectedPromotion = selectedItem?.kind === 'promotion' ? promotions.find((p) => p.promotionId === selectedItem.id) ?? null : null;
  const hasSelectedItem = Boolean(selectedTask || selectedRemediation || selectedPromotion);
  const learningTabActive = activeQueue === 'learning_to_context';
  const dispatchedTabActive = activeQueue === 'dispatched';
  const remediationTabActive = dispatchedTabActive || activeQueue === 'auto_remediated' || activeQueue === 'history';
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const pageStart = total === 0 ? 0 : page * PAGE_SIZE + 1;
  const pageEnd = Math.min((page + 1) * PAGE_SIZE, total);
  const paginationVisible = total > PAGE_SIZE;

  useEffect(() => {
    setPage(0);
    setSelectedItem(null);
  }, [resolvedRepoId]);

  useEffect(() => {
    if (page > 0 && page >= pageCount) {
      setPage(pageCount - 1);
      setSelectedItem(null);
    }
  }, [page, pageCount]);

  const handleFiltersChange = (nextFilters: ReviewFilters) => {
    setFilters(nextFilters);
    setPage(0);
    setSelectedItem(null);
  };

  const goToPage = (nextPage: number) => {
    setPage(Math.max(0, Math.min(pageCount - 1, nextPage)));
    setSelectedItem(null);
  };

  return (
    <div className="flex flex-col gap-3">
      {/* Run Judge control */}
      <div className="flex justify-end mb-1">
        <button
          type="button"
          onClick={() => { void handleTriggerJudge(); }}
          disabled={runLoading}
          className="btn btn-sm btn-primary flex items-center gap-1.5"
          title={resolvedRepoId ? `Run context judge for this repo` : 'Run context judge globally'}
        >
          {runLoading ? (
            <span className="animate-spin inline-block w-3 h-3 border border-current border-t-transparent rounded-full" />
          ) : (
            <RotateCcw className="w-3 h-3" />
          )}
          {runLoading ? 'Triggering…' : 'Run Judge'}
        </button>
      </div>

      {/* Queue tabs */}
      <div className="border-b border-app flex gap-1">
        {(Object.keys(QUEUE_LABELS) as Queue[]).map((q) => (
          <button
            key={q}
            type="button"
            onClick={() => {
              setActiveQueue(q);
              setPage(0);
              setSelectedItem(null);
            }}
            className={`px-3 py-2 text-xs rounded-t inline-flex items-center gap-1.5 ${
              activeQueue === q
                ? 'bg-app-muted text-theme-primary'
                : 'text-theme-muted hover:text-theme-primary'
            }`}
          >
            {QUEUE_LABELS[q]}
            {queues[q] != null && (
              <span className="badge badge-muted ml-0.5">{queues[q]}</span>
            )}
          </button>
        ))}
      </div>

      {/* Filter bar */}
      <ContextReviewFilters filters={filters} onChange={handleFiltersChange} />

      {/* Content area: list + detail */}
      <div className="flex gap-0 min-h-[400px]">
        {/* Task list */}
        <div className={`flex-1 min-w-0 ${hasSelectedItem ? 'max-w-[55%]' : ''}`}>
          {loading ? (
            <div className="text-xs text-theme-muted animate-pulse py-6 text-center">Loading tasks…</div>
          ) : remediationTabActive ? (
            dispatchedRemediations.length === 0 ? (
              <div className="py-12 text-center text-sm text-theme-muted">No remediation records</div>
            ) : (
              <div className="divide-y divide-app">
                {dispatchedRemediations.map((remediation) => (
                  <button
                    type="button"
                    key={remediation.remediationId}
                    onClick={() => setSelectedItem(remediation.remediationId === selectedItem?.id ? null : { kind: 'remediation', id: remediation.remediationId })}
                    className={`w-full text-left px-3 py-2.5 flex items-start gap-3 hover:bg-app-muted transition-colors ${
                      remediation.remediationId === selectedItem?.id ? 'bg-app-muted' : ''
                    }`}
                    aria-pressed={remediation.remediationId === selectedItem?.id}
                  >
                    <div className="flex flex-col gap-1 shrink-0 mt-0.5">
                      <span className={statusBadgeClass(remediation.status)}>{remediation.status.replace(/_/g, ' ')}</span>
                      {remediation.estimatedRisk && <span className={riskBadgeClass(remediation.estimatedRisk)}>{remediation.estimatedRisk}</span>}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-xs font-medium text-theme-primary truncate">{remediation.actionKind.replace(/_/g, ' ')}</div>
                      {remediation.remediationKind && (
                        <div className="text-[10.5px] text-theme-subtle truncate">{remediation.remediationKind.replace(/_/g, ' ')}</div>
                      )}
                      <div className="text-[11px] text-theme-muted mt-0.5 flex items-center gap-2 flex-wrap">
                        {typeof remediation.confidence === 'number' && <span>Confidence: {Math.round(remediation.confidence * 100)}%</span>}
                        {remediation.workerRole && <span className="badge badge-muted">{remediation.workerRole}</span>}
                        {remediation.targetRepoId && <span className="badge badge-muted">target: repo</span>}
                        {remediation.humanGateRequired && <span className="badge badge-warn">needs review</span>}
                        {remediation.targetEntryIds && remediation.targetEntryIds.length > 0 && (
                          <span className="badge badge-info">{remediation.targetEntryIds.length} entries</span>
                        )}
                      </div>
                    </div>
                    <div className="shrink-0 text-[11px] text-theme-muted">
                      {new Date(remediation.createdAt).toLocaleDateString()}
                    </div>
                  </button>
                ))}
              </div>
            )
          ) : learningTabActive ? (
            promotions.length === 0 ? (
              <div className="py-12 text-center text-sm text-theme-muted">No learning promotions in this queue</div>
            ) : (
              <div className="divide-y divide-app">
                {promotions.map((promotion) => (
                  <button
                    type="button"
                    key={promotion.promotionId}
                    onClick={() => setSelectedItem(promotion.promotionId === selectedItem?.id ? null : { kind: 'promotion', id: promotion.promotionId })}
                    className={`w-full text-left px-3 py-2.5 flex items-start gap-3 hover:bg-app-muted transition-colors ${
                      promotion.promotionId === selectedItem?.id ? 'bg-app-muted' : ''
                    }`}
                    aria-pressed={promotion.promotionId === selectedItem?.id}
                  >
                    <div className="flex flex-col gap-1 shrink-0 mt-0.5">
                      <span className={statusBadgeClass(promotion.status)}>{promotion.status.replace(/_/g, ' ')}</span>
                      {promotion.remediationStatus && (
                        <span className={statusBadgeClass(promotion.remediationStatus)}>{promotion.remediationStatus.replace(/_/g, ' ')}</span>
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-xs font-medium text-theme-primary truncate">{promotion.action.replace(/_/g, ' ')}</div>
                      <div className="text-[10.5px] text-theme-subtle truncate">{promotion.learningId}</div>
                      <div className="text-[11px] text-theme-muted mt-0.5 flex items-center gap-2 flex-wrap">
                        {typeof promotion.confidence === 'number' && <span>Confidence: {Math.round(promotion.confidence * 100)}%</span>}
                        {promotion.estimatedRisk && <span className={riskBadgeClass(promotion.estimatedRisk)}>{promotion.estimatedRisk}</span>}
                        {promotion.scope && <span className="badge badge-muted">source: {promotion.scope}</span>}
                        {promotion.targetRepoId && <span className="badge badge-muted">target: repo</span>}
                        {promotion.humanGateRequired && <span className="badge badge-warn">needs review</span>}
                        {promotion.remediationId && <span className="badge badge-info">mapped</span>}
                      </div>
                      {(promotion.proposedCuratedText || promotion.suggestedContent) && (
                        <div className="text-[11px] text-theme-muted mt-1 line-clamp-2">
                          {promotion.proposedCuratedText ?? promotion.suggestedContent}
                        </div>
                      )}
                    </div>
                    <div className="shrink-0 text-[11px] text-theme-muted">
                      {new Date(promotion.createdAt).toLocaleDateString()}
                    </div>
                  </button>
                ))}
              </div>
            )
          ) : tasks.length === 0 ? (
            <div className="py-12 text-center text-sm text-theme-muted">No tasks in this queue</div>
          ) : (
            <div className="divide-y divide-app">
              {tasks.map((task) => (
                <button
                  key={task.taskId}
                  type="button"
                  onClick={() => setSelectedItem(task.taskId === selectedItem?.id ? null : { kind: 'task', id: task.taskId })}
                  className={`w-full text-left px-3 py-2.5 flex items-start gap-3 hover:bg-app-muted transition-colors ${
                    task.taskId === selectedItem?.id ? 'bg-app-muted' : ''
                  }`}
                  aria-pressed={task.taskId === selectedItem?.id}
                >
                  {/* Risk + status + severity badges */}
                  <div className="flex flex-col gap-1 shrink-0 mt-0.5">
                    <span className={riskBadgeClass(task.risk)}>{task.risk}</span>
                    <span className={statusBadgeClass(task.status)}>{task.status.replace(/_/g, ' ')}</span>
                    {task.severity && <span className="badge badge-muted">{task.severity}</span>}
                  </div>

                  {/* Main info */}
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-medium text-theme-primary truncate">{task.fixType}</div>
                    {task.classification && (
                      <div className="text-[10.5px] text-theme-subtle truncate">{task.classification}</div>
                    )}
                    <div className="text-[11px] text-theme-muted mt-0.5 flex items-center gap-2 flex-wrap">
                      <span>Confidence: {Math.round(task.confidence * 100)}%</span>
                      <span className="badge badge-muted">{task.reliabilityLabel}</span>
                      <span className="badge badge-muted">{task.scope}</span>
                      {task.affectedRepos && task.affectedRepos.length > 0 && (
                        <span className="badge badge-info">{task.affectedRepos.length} repos</span>
                      )}
                      {task.learningId && (
                        <span className="badge badge-muted">learning</span>
                      )}
                    </div>
                  </div>

                  {/* Date + re-judge */}
                  <div className="shrink-0 text-[11px] text-theme-muted flex items-center gap-1">
                    {new Date(task.createdAt).toLocaleDateString()}
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        void handleRejudge(task.judgeRunId);
                      }}
                      className="shrink-0 text-theme-muted hover:text-theme-primary transition-colors ml-1"
                      title="Re-judge"
                      aria-label="Re-judge"
                    >
                      <RotateCcw className="w-3 h-3" />
                    </button>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Detail panel */}
        {hasSelectedItem && (
          <div className="w-[45%] shrink-0 border-l border-app">
            {selectedTask && (
              <ContextReviewDetail
                task={selectedTask}
                onDecision={handleDecision}
                onClose={() => setSelectedItem(null)}
                loading={decisionLoading}
              />
            )}
            {selectedRemediation && (
              <RemediationDetail remediation={selectedRemediation} onClose={() => setSelectedItem(null)} />
            )}
            {selectedPromotion && (
              <PromotionDetail promotion={selectedPromotion} onClose={() => setSelectedItem(null)} />
            )}
          </div>
        )}
      </div>

      {total > 0 && (
        <div className="flex items-center justify-between border-t border-app pt-3 text-[11px] text-theme-muted">
          <span className="font-mono">
            Showing {pageStart}-{pageEnd} of {total}
          </span>
          {paginationVisible && (
            <div className="flex items-center gap-3">
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                disabled={page === 0 || loading}
                onClick={() => goToPage(page - 1)}
                aria-label="Previous page"
              >
                Previous
              </button>
              <span className="font-mono">Page {page + 1} of {pageCount}</span>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                disabled={page >= pageCount - 1 || loading}
                onClick={() => goToPage(page + 1)}
                aria-label="Next page"
              >
                Next
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function DetailShell({ title, status, onClose, children, updatedAt }: { title: string; status: string; onClose: () => void; children: React.ReactNode; updatedAt?: string }) {
  return (
    <div className="relative flex flex-col h-full border-l border-app bg-app overflow-y-auto">
      <div className="flex items-center justify-between gap-2 px-4 py-3 border-b border-app sticky top-0 bg-app z-[1]">
        <div className="min-w-0">
          <div className="text-xs font-medium text-theme-primary truncate">{title}</div>
          <span className={statusBadgeClass(status)}>{status.replace(/_/g, ' ')}</span>
        </div>
        <button type="button" onClick={onClose} className="text-theme-muted hover:text-theme-primary text-lg leading-none" aria-label="Close detail panel">×</button>
      </div>
      <div className="flex-1 px-4 py-3 space-y-4">{children}</div>
      {updatedAt && <div className="px-4 py-2 border-t border-app text-[11px] text-theme-muted">Updated {new Date(updatedAt).toLocaleString()}</div>}
    </div>
  );
}

function JsonBlock({ title, value }: { title: string; value: unknown }) {
  if (value === undefined || value === null || (Array.isArray(value) && value.length === 0)) return null;
  return (
    <section>
      <h3 className="text-[11px] font-semibold uppercase tracking-wide text-theme-muted mb-1.5">{title}</h3>
      <pre className="rounded-md bg-app-muted border border-app px-3 py-2 text-[11px] font-mono text-theme-secondary whitespace-pre-wrap break-all">
        {typeof value === 'string' ? value : JSON.stringify(value, null, 2)}
      </pre>
    </section>
  );
}

function RemediationDetail({ remediation, onClose }: { remediation: RemediationDoc; onClose: () => void }) {
  return (
    <DetailShell title={remediation.actionKind.replace(/_/g, ' ')} status={remediation.status} onClose={onClose} updatedAt={remediation.updatedAt}>
      <section className="flex flex-wrap gap-1.5 text-xs">
        {remediation.remediationKind && <span className="badge badge-info">{remediation.remediationKind.replace(/_/g, ' ')}</span>}
        {remediation.workerRole && <span className="badge badge-muted">{remediation.workerRole}</span>}
        {remediation.estimatedRisk && <span className={riskBadgeClass(remediation.estimatedRisk)}>{remediation.estimatedRisk} risk</span>}
        {typeof remediation.confidence === 'number' && <span className="badge badge-muted">Confidence {Math.round(remediation.confidence * 100)}%</span>}
        {remediation.humanGateRequired && <span className="badge badge-warn">needs review</span>}
      </section>
      <JsonBlock title="Proposed Patch" value={remediation.proposedPatch} />
      <JsonBlock title="Target Entries" value={remediation.targetEntryIds} />
      <JsonBlock title="Affected Refs" value={remediation.affectedRefIds ?? remediation.targetRefIds} />
      <JsonBlock title="Validation Plan" value={remediation.validationPlan} />
      <JsonBlock title="Applied Revisions" value={remediation.appliedRevisionIds ?? remediation.revisions?.map((revision) => ({ revisionId: revision.revisionId, entryId: revision.entryId, diff: revision.diff }))} />
      <JsonBlock title="Worker Assignments" value={remediation.assignments?.map((assignment) => ({
        assignmentId: assignment.assignmentId,
        status: assignment.status,
        agentExecutionId: assignment.agentExecutionId,
        notes: assignment.notes,
        result: assignment.result,
      }))} />
      <JsonBlock title="Result" value={remediation.result} />
      <JsonBlock title="Error" value={remediation.error} />
      <section className="text-[11px] text-theme-muted font-mono break-all">
        {remediation.remediationId}
      </section>
    </DetailShell>
  );
}

function PromotionDetail({ promotion, onClose }: { promotion: LearningPromotionDoc; onClose: () => void }) {
  return (
    <DetailShell title={promotion.action.replace(/_/g, ' ')} status={promotion.remediationStatus ?? promotion.status} onClose={onClose} updatedAt={promotion.updatedAt}>
      <section className="flex flex-wrap gap-1.5 text-xs">
        {promotion.scope && <span className="badge badge-muted">source: {promotion.scope}</span>}
        {promotion.targetRepoId && <span className="badge badge-muted">target: repo</span>}
        {promotion.estimatedRisk && <span className={riskBadgeClass(promotion.estimatedRisk)}>{promotion.estimatedRisk} risk</span>}
        {typeof promotion.confidence === 'number' && <span className="badge badge-muted">Confidence {Math.round(promotion.confidence * 100)}%</span>}
        {promotion.humanGateRequired && <span className="badge badge-warn">needs review</span>}
        {promotion.remediationId && <span className="badge badge-info">mapped</span>}
      </section>
      <JsonBlock title="Quality Warnings" value={promotion.curationQualityWarnings} />
      <JsonBlock title="Proposed Patch" value={promotion.proposedPatch} />
      <JsonBlock title="Suggested Content" value={promotion.suggestedContent ?? promotion.proposedCuratedText} />
      <JsonBlock title="Target Entries" value={promotion.targetEntryIds ?? promotion.targetEntryId} />
      <JsonBlock title="Affected Refs" value={promotion.affectedRefIds ?? promotion.targetRefIds} />
      <JsonBlock title="Source Evaluations" value={promotion.sourceEvaluationIds} />
      <section className="text-[11px] text-theme-muted font-mono break-all">
        Learning {promotion.learningId}<br />
        Promotion {promotion.promotionId}
      </section>
    </DetailShell>
  );
}
