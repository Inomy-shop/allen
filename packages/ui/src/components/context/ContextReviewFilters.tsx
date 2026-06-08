import React from 'react';
import Select from '../common/Select';

export interface ReviewFilters {
  scope?: string;
  fixType?: string;
  riskLevel?: string;
  confidenceBand?: string;
  sourceType?: string;
  repoId?: string;
  severity?: string;
  classification?: string;
  status?: string;
}

interface Props {
  filters: ReviewFilters;
  onChange: (filters: ReviewFilters) => void;
  repos?: Array<{ _id: string; name: string }>;
}

const SCOPE_OPTIONS = [
  { value: '', label: 'All Scopes' },
  { value: 'workflow', label: 'workflow' },
  { value: 'node', label: 'node' },
  { value: 'chat_turn', label: 'chat_turn' },
  { value: 'spawned_agent', label: 'spawned_agent' },
  { value: 'learning', label: 'learning' },
  { value: 'cross_repo', label: 'cross_repo' },
  { value: 'global', label: 'global' },
];

const FIX_TYPE_OPTIONS = [
  { value: '', label: 'All Fix Types' },
  { value: 'curated_context_edit', label: 'curated_context_edit' },
  { value: 'curated_context_create', label: 'curated_context_create' },
  { value: 'curated_context_archive', label: 'curated_context_archive' },
  { value: 'code_fix', label: 'code_fix' },
  { value: 'learning_promotion', label: 'learning_promotion' },
  { value: 'no_action', label: 'no_action' },
  { value: 'mandatory_context_edit', label: 'mandatory_context_edit' },
  { value: 'mandatory_context_create', label: 'mandatory_context_create' },
  { value: 'curated_context_fix', label: 'curated_context_fix' },
  { value: 'mandatory_context_fix', label: 'mandatory_context_fix' },
  { value: 'global_context_fix', label: 'global_context_fix' },
  { value: 'cross_repo_context_fix', label: 'cross_repo_context_fix' },
  { value: 'learning_to_curated_context_fix', label: 'learning_to_curated_context_fix' },
  { value: 'learning_context_conflict_review', label: 'learning_context_conflict_review' },
  { value: 'ingestion_fix', label: 'ingestion_fix' },
  { value: 'retrieval_fix', label: 'retrieval_fix' },
  { value: 'reranking_fix', label: 'reranking_fix' },
  { value: 'injection_policy_fix', label: 'injection_policy_fix' },
  { value: 'prompt_contract_fix', label: 'prompt_contract_fix' },
  { value: 'task_split_required', label: 'task_split_required' },
  { value: 'no_fix', label: 'no_fix' },
];

const RISK_OPTIONS = [
  { value: '', label: 'All Risks' },
  { value: 'low', label: 'low' },
  { value: 'medium', label: 'medium' },
  { value: 'high', label: 'high' },
  { value: 'critical', label: 'critical' },
];

const CONFIDENCE_OPTIONS = [
  { value: '', label: 'All Confidence' },
  { value: 'high', label: 'high (≥0.8)' },
  { value: 'medium', label: 'medium (0.5–0.79)' },
  { value: 'low', label: 'low (<0.5)' },
];

const SOURCE_TYPE_OPTIONS = [
  { value: '', label: 'All Sources' },
  { value: 'workflow_run', label: 'workflow_run' },
  { value: 'spawned_agent_run', label: 'spawned_agent_run' },
  { value: 'chat_turn', label: 'chat_turn' },
  { value: 'context_usage_trace', label: 'context_usage_trace' },
  { value: 'deterministic_warning', label: 'deterministic_warning' },
  { value: 'human_feedback', label: 'human_feedback' },
  { value: 'chat_learning', label: 'chat_learning' },
  { value: 'stale_finding', label: 'stale_finding' },
];

const SEVERITY_OPTIONS = [
  { value: '', label: 'All Severities' },
  { value: 'info', label: 'info' },
  { value: 'warn', label: 'warn' },
  { value: 'error', label: 'error' },
  { value: 'critical', label: 'critical' },
];

const STATUS_OPTIONS = [
  { value: '', label: 'All Statuses' },
  { value: 'pending', label: 'pending' },
  { value: 'in_review', label: 'in_review' },
  { value: 'changes_requested', label: 'changes_requested' },
  { value: 'approved', label: 'approved' },
  { value: 'in_remediation', label: 'in_remediation' },
  { value: 'done', label: 'done' },
  { value: 'rejected', label: 'rejected' },
];

const CLASSIFICATION_OPTIONS = [
  { value: '', label: 'All Classifications' },
  { value: 'missing_context', label: 'missing_context' },
  { value: 'missing_mandatory_context', label: 'missing_mandatory_context' },
  { value: 'wrong_context', label: 'wrong_context' },
  { value: 'stale_context', label: 'stale_context' },
  { value: 'context_bloat', label: 'context_bloat' },
  { value: 'ingestion_gap', label: 'ingestion_gap' },
  { value: 'retrieval_gap', label: 'retrieval_gap' },
  { value: 'reranker_gap', label: 'reranker_gap' },
  { value: 'injection_policy_gap', label: 'injection_policy_gap' },
  { value: 'learning_to_curated_context_candidate', label: 'learning → context candidate' },
  { value: 'learning_conflicts_with_context', label: 'learning conflict' },
  { value: 'false_positive', label: 'false_positive' },
  { value: 'judge_uncertain', label: 'judge_uncertain' },
];

export default function ContextReviewFilters({ filters, onChange, repos }: Props) {
  const repoOptions = [
    { value: '', label: 'All Repos' },
    ...(repos ?? []).map((r) => ({ value: r._id, label: r.name })),
  ];

  return (
    <div className="flex flex-wrap gap-2 items-center py-2">
      <Select
        value={filters.scope ?? ''}
        onChange={(v) => onChange({ ...filters, scope: v || undefined })}
        options={SCOPE_OPTIONS}
        placeholder="All Scopes"
        searchable={false}
        className="w-36"
      />
      <Select
        value={filters.fixType ?? ''}
        onChange={(v) => onChange({ ...filters, fixType: v || undefined })}
        options={FIX_TYPE_OPTIONS}
        placeholder="All Fix Types"
        searchable={false}
        className="w-44"
      />
      <Select
        value={filters.riskLevel ?? ''}
        onChange={(v) => onChange({ ...filters, riskLevel: v || undefined })}
        options={RISK_OPTIONS}
        placeholder="All Risks"
        searchable={false}
        className="w-32"
      />
      <Select
        value={filters.confidenceBand ?? ''}
        onChange={(v) => onChange({ ...filters, confidenceBand: v || undefined })}
        options={CONFIDENCE_OPTIONS}
        placeholder="All Confidence"
        searchable={false}
        className="w-40"
      />
      <Select
        value={filters.sourceType ?? ''}
        onChange={(v) => onChange({ ...filters, sourceType: v || undefined })}
        options={SOURCE_TYPE_OPTIONS}
        placeholder="All Sources"
        searchable={false}
        className="w-44"
      />
      <Select
        value={filters.severity ?? ''}
        onChange={(v) => onChange({ ...filters, severity: v || undefined })}
        options={SEVERITY_OPTIONS}
        placeholder="All Severities"
        searchable={false}
        className="w-36"
      />
      <Select
        value={filters.status ?? ''}
        onChange={(v) => onChange({ ...filters, status: v || undefined })}
        options={STATUS_OPTIONS}
        placeholder="All Statuses"
        searchable={false}
        className="w-36"
      />
      <Select
        value={filters.classification ?? ''}
        onChange={(v) => onChange({ ...filters, classification: v || undefined })}
        options={CLASSIFICATION_OPTIONS}
        placeholder="All Classifications"
        searchable={false}
        className="w-52"
      />
      {repoOptions.length > 1 && (
        <Select
          value={filters.repoId ?? ''}
          onChange={(v) => onChange({ ...filters, repoId: v || undefined })}
          options={repoOptions}
          placeholder="All Repos"
          searchable
          className="w-44"
        />
      )}
    </div>
  );
}
