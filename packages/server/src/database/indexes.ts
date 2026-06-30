import type { Db } from 'mongodb';

export async function ensureIndexes(db: Db): Promise<void> {
  // Workflows
  await db.collection('workflows').createIndex({ name: 1 }, { unique: true });
  await db.collection('workflows').createIndex({ tags: 1 });

  // Skills — reusable routing/playbook knowledge used by the chat assistant.
  await db.collection('skills').createIndex({ name: 1 }, { unique: true });
  await db.collection('skills').createIndex({ enabled: 1, priority: -1 });
  await db.collection('skills').createIndex({ category: 1 });
  await db.collection('skills').createIndex({ triggers: 1 });

  // Agents
  const legacySpawnTargetsField = 'can' + 'DelegateTo';
  // Copy the legacy field onto spawnTargets via $rename rather than an
  // aggregation-pipeline update ([{ $set: ... }]): AWS DocumentDB does not
  // support pipeline-form updates and rejects them with
  // "MongoServerError: Wrong type for parameter u", which crash-loops boot.
  // $rename moves the field, so only docs that had BOTH fields still carry
  // the legacy key afterwards — the $unset below mops those up.
  await db.collection('agents').updateMany(
    { spawnTargets: { $exists: false }, [legacySpawnTargetsField]: { $exists: true } },
    { $rename: { [legacySpawnTargetsField]: 'spawnTargets' } },
  );
  await db.collection('agents').updateMany(
    { [legacySpawnTargetsField]: { $exists: true } },
    { $unset: { [legacySpawnTargetsField]: '' } },
  );
  await db.collection('agents').createIndex({ name: 1 }, { unique: true });
  // Lookup imported agents by source repo — used by the import preview to
  // detect "already imported" rows and by the UI to badge agents by origin.
  await db.collection('agents').createIndex(
    { sourceRepoId: 1 },
    { partialFilterExpression: { sourceRepoId: { $exists: true } } },
  );

  // Design Docs — one per feature-plan run, holds PRD + HLA + TDD
  // sections with per-section versioning. Queried by chatSessionId when
  // resuming a session, by workflowRunId when loading the execution view,
  // and by status when filtering the Design Docs list page.
  await db.collection('design_docs').createIndex({ chatSessionId: 1 });
  await db.collection('design_docs').createIndex({ workflowRunId: 1 });
  await db.collection('design_docs').createIndex({ status: 1, updatedAt: -1 });

  // Workflow Interventions — every human pause in any workflow (HIP).
  // Queried heavily by workflow_run_id (execution page sidebar), by
  // started_by_user_id (user's pending interventions list), by status +
  // deadline (future timeout sweeping).
  await db.collection('workflow_interventions').createIndex(
    { workflow_run_id: 1, created_at: 1 },
  );
  await db.collection('workflow_interventions').createIndex(
    { started_by_user_id: 1, status: 1 },
  );
  await db.collection('workflow_interventions').createIndex(
    { status: 1, deadline: 1 },
  );
  // Unique lookup by short intervention ID for deep links
  await db.collection('workflow_interventions').createIndex(
    { intervention_id: 1 },
    { unique: true },
  );
  // Context judge human_feedback discovery: answered interventions ordered by answered_at.
  // Partial filter keeps the index small — only answered records are eligible.
  await db.collection('workflow_interventions').createIndex(
    { status: 1, answered_at: 1 },
    { partialFilterExpression: { status: 'answered' } },
  );
  // Batch repo-ID resolution: context_attempts lookup by executionId (= workflow_run_id)
  // is already covered by the existing context_attempts executionId index above.

  // Executions
  await db.collection('executions').createIndex({ id: 1 }, { unique: true });
  await db.collection('executions').createIndex({ workflowId: 1 });
  await db.collection('executions').createIndex({ workflowName: 1 });
  await db.collection('executions').createIndex({ status: 1 });
  await db.collection('executions').createIndex({ startedAt: -1 });
  await db.collection('executions').createIndex({ status: 1, startedAt: -1 });
  await db.collection('executions').createIndex(
    { status: 1, 'meta.chatSessionId': 1 },
    { partialFilterExpression: { 'meta.chatSessionId': { $exists: true } } },
  );
  // Compound index for concurrency limit checks
  await db.collection('executions').createIndex({ workflowName: 1, status: 1 });
  // Spawn-tree indexes — parentExecutionId powers the "direct children of
  // this node" query on the execution detail page, rootExecutionId powers
  // the "every descendant of this workflow run" query (Phase 2 "Show all
  // descendants" toggle + Phase 3 log fan-out).
  await db.collection('executions').createIndex({ parentExecutionId: 1, startedAt: 1 });
  await db.collection('executions').createIndex({ rootExecutionId: 1, startedAt: 1 });

  // Traces
  await db.collection('execution_traces').createIndex({ executionId: 1, node: 1, attempt: 1 });
  await db.collection('execution_traces').createIndex({ executionTraceId: 1 }, { sparse: true });
  await db.collection('execution_traces').createIndex({ executionId: 1, startedAt: 1 });
  await db.collection('execution_traces').createIndex({ executionId: 1, type: 1, startedAt: 1 });
  // Usage dashboard range scans — traces are the per-LLM-run cost source of
  // truth, aggregated by time window across all executions.
  await db.collection('execution_traces').createIndex({ startedAt: 1 });

  // Checkpoints
  await db.collection('checkpoints').createIndex({ executionId: 1, createdAt: -1 });

  // Failure reports — one per failed execution, queried by executionId
  await db.collection('execution_failure_reports').createIndex({ executionId: 1 }, { unique: true });
  await db.collection('execution_failure_reports').createIndex({ failedAt: -1 });

  // Secrets
  await db.collection('secrets').createIndex({ key: 1 }, { unique: true });

  // Repos
  await db.collection('repos').createIndex({ path: 1 }, { unique: true });
  await db.collection('repos').createIndex({ tags: 1 });
  await db.collection('repos').createIndex({ status: 1, lastUsedAt: -1 });

  // MCP servers — user-scoped. Compound unique (ownerId, name) lets
  // different users register MCP servers with the same name without colliding.
  // `ownerId: null` counts as a distinct value, matching the "implicit admin
  // ownership" rule for pre-refactor legacy records.
  await db.collection('mcp_servers').createIndex(
    { ownerId: 1, name: 1 },
    { unique: true },
  );
  // Hot lookup at agent-execution time: enabled servers for a given user.
  await db.collection('mcp_servers').createIndex({ ownerId: 1, enabled: 1 });

  // Repo Contexts (deep agent-generated markdown context)
  // Lookup by repoId is hot — every agent spawn into a registered repo hits this.
  await db.collection('repo_contexts').createIndex({ repoId: 1 }, { unique: true });

  await db.collection('context_attempts').createIndex({ executionId: 1, nodeName: 1, attempt: 1 });
  await db.collection('context_attempts').createIndex({ executionId: 1, createdAt: 1 });
  await db.collection('context_attempts').createIndex({ contextAttemptId: 1 }, { unique: true });
  await db.collection('context_attempts').createIndex({ rootExecutionId: 1, createdAt: 1 });
  await db.collection('context_attempts').createIndex({ parentExecutionId: 1, createdAt: 1 });
  // Discovery indexes for ContextEvaluationScheduler observability-based discovery
  await db.collection('context_attempts').createIndex({ repoId: 1, status: 1, createdAt: 1 });
  await db.collection('context_attempts').createIndex({ executionKind: 1, status: 1, createdAt: 1 });
  await db.collection('context_attempts').createIndex({ repoId: 1, executionKind: 1, status: 1, createdAt: 1 });
  await db.collection('context_refs').createIndex({ contextAttemptId: 1, refId: 1 }, { unique: true });
  await db.collection('context_refs').createIndex({ executionId: 1, nodeName: 1, attempt: 1 });
  await db.collection('context_refs').createIndex({ executionId: 1, rank: 1, createdAt: 1 });
  await db.collection('context_refs').createIndex({ contextAttemptId: 1, rank: 1, createdAt: 1 });
  await db.collection('context_refs').createIndex({ providerId: 1, cogneeScore: -1 });
  await db.collection('context_ref_events').createIndex({ contextAttemptId: 1, refId: 1, createdAt: 1 });
  await db.collection('context_ref_events').createIndex({ executionId: 1, nodeName: 1, attempt: 1 });
  await db.collection('context_ref_events').createIndex({ executionId: 1, createdAt: 1 });
  await db.collection('context_ref_events').createIndex({ contextAttemptId: 1, createdAt: 1 });
  await db.collection('context_ref_events').createIndex({ executionTraceId: 1 }, { sparse: true });
  await db.collection('context_ref_events').createIndex({ usageTraceId: 1 }, { sparse: true });
  await db.collection('context_ref_events').createIndex({ rootExecutionId: 1, createdAt: 1 });
  await db.collection('context_ref_events').createIndex({ parentExecutionId: 1, createdAt: 1 });
  await db.collection('context_ref_events').createIndex({ type: 1, createdAt: 1 });
  await db.collection('context_artifacts').createIndex({ hash: 1 }, { unique: true });
  await db.collection('context_artifacts').createIndex({ kind: 1, createdAt: -1 });
  await db.collection('context_evaluations').createIndex({ executionId: 1, nodeName: 1, attempt: 1, active: 1 });
  await db.collection('context_evaluations').createIndex({ executionId: 1, active: 1, createdAt: 1 });
  await db.collection('context_evaluations').createIndex({ evaluationId: 1 }, { unique: true });
  await db.collection('context_evaluations').createIndex({ traceId: 1 }, { unique: true });
  await db.collection('context_evaluations').createIndex({ contextAttemptId: 1, usageTraceId: 1, scope: 1, active: 1 });
  await db.collection('context_evaluations').createIndex({ repoId: 1, indexId: 1, createdAt: -1 });
  await db.collection('context_evaluations').createIndex({ status: 1, active: 1, createdAt: -1 });
  await db.collection('context_evaluations').createIndex({ 'semantic.status': 1, 'semantic.nextRetryAt': 1, active: 1, createdAt: 1 });
  await db.collection('repo_cognee_datasets').createIndex({ repoId: 1 }, { unique: true });
  await db.collection('repo_cognee_datasets').createIndex({ status: 1, updatedAt: -1 });
  await db.collection('repo_context_metadata').createIndex(
    { repoId: 1, path: 1, fileHash: 1, schemaVersion: 1 },
    { unique: true },
  );
  await db.collection('repo_context_metadata').createIndex({ repoId: 1, active: 1, path: 1 });

  // Versioned curated context entries. Runtime paths must use active rows only;
  // inactive rows are retained for audit/history.
  await db.collection('repo_context_curation_entries').createIndex({ entryVersionId: 1 }, { unique: true, sparse: true });
  await db.collection('repo_context_curation_entries').dropIndex('repoId_1_entryId_1_version_1').catch(ignoreMissingIndex);
  await db.collection('repo_context_curation_entries').createIndex(
    { repoId: 1, entryId: 1, active: 1 },
    { unique: true, partialFilterExpression: { active: true } },
  );
  await db.collection('repo_context_curation_entries').createIndex({ repoId: 1, active: 1, path: 1 });
  await db.collection('repo_context_curation_entries').createIndex({ repoId: 1, active: 1, inclusion: 1 });

  // Guarded partial unique indexes for active curated entries — title and path uniqueness.
  // Wrapped in try-catch: if existing data has duplicates, log and skip without breaking startup.
  // Clash detection in the portability service is the primary guard at import time; these indexes
  // add a last-resort uniqueness constraint for concurrent writes.
  try {
    await db.collection('repo_context_curation_entries').createIndex(
      { repoId: 1, title: 1 },
      {
        unique: true,
        partialFilterExpression: { inclusion: 'include', active: true, title: { $type: 'string' } },
        name: 'portability_active_curated_title_unique',
      },
    );
  } catch (err) {
    console.warn('[indexes] Could not create active curated title unique index (existing duplicates?):', (err as Error).message);
  }
  try {
    await db.collection('repo_context_curation_entries').createIndex(
      { repoId: 1, path: 1 },
      {
        unique: true,
        partialFilterExpression: { inclusion: 'include', active: true, path: { $type: 'string' } },
        name: 'portability_active_curated_path_unique',
      },
    );
  } catch (err) {
    console.warn('[indexes] Could not create active curated path unique index (existing duplicates?):', (err as Error).message);
  }

  // Cron Jobs — generic scheduler for agents/workflows/system actions
  await db.collection('cron_jobs').createIndex({ name: 1 }, { unique: true });
  // Hot path: every tick queries `enabled: true, nextRunAt <= now`
  await db.collection('cron_jobs').createIndex({ enabled: 1, nextRunAt: 1 });

  // Cron Runs — per-execution history
  await db.collection('cron_runs').createIndex({ cronJobId: 1, startedAt: -1 });
  // 90-day TTL on run history
  await db.collection('cron_runs').createIndex(
    { startedAt: 1 },
    { expireAfterSeconds: 90 * 24 * 60 * 60 },
  );

  // Execution Logs
  await db.collection('execution_logs').createIndex({ executionId: 1, timestamp: 1 });
  await db.collection('execution_logs').createIndex({ executionId: 1, node: 1, timestamp: 1 });

  // Pull Requests
  await db.collection('pull_requests').createIndex({ updatedAt: -1 });
  await db.collection('pull_requests').createIndex({ status: 1, updatedAt: -1 });
  await db.collection('pull_requests').createIndex({ repoId: 1, status: 1, updatedAt: -1 });

  // Workspaces
  await db.collection('workspaces').createIndex({ status: 1, updatedAt: -1 });
  await db.collection('workspaces').createIndex({ updatedAt: -1 });
  // CWD resolution: findOne({ chatSessionId: sessionId }) in chat.service.ts (TDD §1.1)
  await db.collection('workspaces').createIndex({ chatSessionId: 1 });

  // Alerts
  await db.collection('alerts').createIndex({ read: 1, createdAt: -1 });

  // Learnings
  await db.collection('learnings').createIndex({ 'scope.level': 1, status: 1, confidence: -1 });
  await db.collection('learnings').createIndex({ 'scope.contextTags': 1 });
  await db.collection('learnings').createIndex({ 'scope.workflowName': 1 });
  await db.collection('learnings').createIndex({ 'scope.agentName': 1 });
  await db.collection('learnings').createIndex({ tags: 1 });
  await db.collection('learnings').createIndex({ status: 1, lastUsedAt: 1 });
  await db.collection('learnings').createIndex({ 'source.executionId': 1 });
  await db.collection('learnings').createIndex({ repoId: 1, contextEligibility: 1, createdAt: -1 });

  // Scheduler cursors are scoped; sourceType alone is not unique anymore.
  // Drop the legacy unique index defensively so boot does not fail on DBs that
  // already have multiple scoped chat_learning cursor rows.
  await db.collection('context_judge_scheduler_state').dropIndex('sourceType_1').catch(ignoreMissingIndex);
  await db.collection('context_judge_scheduler_state').createIndex(
    { sourceType: 1, scopeType: 1, scopeKey: 1 },
    { unique: true, sparse: true },
  );

  // Self-healing monitoring
  await db.collection('monitoring_incidents').createIndex({ fingerprint: 1 }, { unique: true });
  await db.collection('monitoring_incidents').createIndex({ status: 1, lastSeenAt: -1 });
  await db.collection('monitoring_incidents').createIndex({ sourceType: 1, lastSeenAt: -1 });
  await db.collection('monitoring_incidents').createIndex({ linearIssueId: 1 });
  await db.collection('monitoring_incidents').createIndex({ dispatchExecutionId: 1 });
  await db.collection('monitoring_scan_state').createIndex({ name: 1 }, { unique: true });
  await db.collection('monitoring_events').createIndex({ createdAt: -1 });
  await db.collection('monitoring_evidence_bundles').createIndex({ createdAt: -1 });
  await db.collection('monitoring_evidence_bundles').createIndex({ createdByExecutionId: 1, createdAt: -1 });
  await db.collection('memory_injection_audits').createIndex({ rootType: 1, rootId: 1 });
  await db.collection('memory_injection_audits').createIndex({ agentName: 1, createdAt: -1 });
  await db.collection('memory_injection_audits').createIndex({ createdAt: -1 });

  // Chat Sessions
  await db.collection('chat_sessions').createIndex({ status: 1, lastMessageAt: -1 });
  await db.collection('chat_sessions').createIndex({ llmSessionId: 1 });
  // Automation sessions: one persistent thread per cron job (keyed by automationKey).
  // Sparse so sessions without an automationKey don't consume index space.
  await db.collection('chat_sessions').createIndex(
    { automationKey: 1 },
    { unique: true, sparse: true, name: 'automationKey_unique_sparse' },
  );
  // Workspace-linked chat lookups and tab ordering (REQ-04, REQ-13)
  await db.collection('chat_sessions').createIndex({ workspaceId: 1, lastMessageAt: -1 });

  // Chat Messages
  await db.collection('chat_messages').createIndex({ sessionId: 1, createdAt: 1 });
  // Usage dashboard range scans over assistant turns across all sessions.
  await db.collection('chat_messages').createIndex({ createdAt: 1 });
  // Sparse compound index to support owner lookups in listSessions() aggregation
  // (senderUserId is only populated on user-sent messages, sparse avoids indexing nulls)
  await db.collection('chat_messages').createIndex(
    { senderUserId: 1, sessionId: 1, createdAt: 1 },
    { name: 'idx_msg_sender_session_created', sparse: true },
  );

  // Model Registry
  await db.collection('model_registry').dropIndex('provider_1_alias_1').catch(() => {});
  await db.collection('model_registry').createIndex({ provider: 1, fullId: 1 }, { unique: true });
  await db.collection('model_registry').createIndex({ provider: 1, isActive: 1, sortOrder: 1 });
  await db.collection('model_registry').createIndex({ isActive: 1 });
  // Chat sessions model index for migration updateMany performance
  await db.collection('chat_sessions').createIndex({ model: 1 });

  // Historical agent conversations
  await db.collection('agent_conversations').createIndex({ chatSessionId: 1, startedAt: -1 });
  await db.collection('agent_conversations').createIndex({ fromAgent: 1, toAgent: 1 });
  await db.collection('agent_conversations').createIndex({ status: 1 });

  // Agent Activity — running log of intermediate events emitted by
  // spawned-agent executions. Queried by refId for wait tools
  // and UI replay; TTL keeps the collection bounded (7 days) because the
  // final response is already persisted in agent_conversations/traces.
  await db.collection('agent_activity').createIndex({ refId: 1, timestamp: 1 });
  await db.collection('agent_activity').createIndex({ chatSessionId: 1, timestamp: 1 });
  await db.collection('agent_activity').createIndex(
    { timestamp: 1 },
    { expireAfterSeconds: 7 * 24 * 60 * 60 },
  );

  // Teams (org-chart grouping for agents — phase 1 of teams architecture)
  await db.collection('teams').createIndex({ name: 1 }, { unique: true });
  await db.collection('teams').createIndex({ parentTeamName: 1 });
  await db.collection('teams').createIndex({ leadAgentName: 1 });
  // Also index agents.teamName so listMembers / lookups are fast
  await db.collection('agents').createIndex({ teamName: 1 });
  // Hard guarantee: only ONE lead per team. Partial unique index gives the
  // database itself the responsibility — no race window. The application also
  // checks before insert so callers get a friendly error message.
  // EXPLICIT NAME REQUIRED: there's already a non-unique index on { teamName: 1 }
  // a few lines above. MongoDB auto-generates the same name `teamName_1` for
  // both, causing IndexKeySpecsConflict. Naming this one explicitly avoids
  // the collision.
  await db.collection('agents').createIndex(
    { teamName: 1 },
    {
      unique: true,
      partialFilterExpression: { teamRole: 'lead' },
      name: 'teamName_lead_unique',
    },
  );

  // Users (auth)
  await db.collection('users').createIndex({ email: 1 }, { unique: true });
  await db.collection('users').createIndex({ role: 1 });

  // Refresh Tokens (auth sessions)
  await db.collection('refresh_tokens').createIndex({ tokenHash: 1 }, { unique: true });
  await db.collection('refresh_tokens').createIndex({ jti: 1 }, { unique: true });
  await db.collection('refresh_tokens').createIndex({ userId: 1 });
  // TTL: auto-purge expired refresh tokens
  await db.collection('refresh_tokens').createIndex(
    { expiresAt: 1 },
    { expireAfterSeconds: 0 },
  );

  // Slack Thread Mappings (Slack thread → Allen chat session)
  await db.collection('slack_thread_mappings').createIndex(
    { slackTeamId: 1, slackChannelId: 1, slackThreadTs: 1 },
    { unique: true },
  );
  await db.collection('slack_thread_mappings').createIndex({ chatSessionId: 1 });

  // Slack Processed Events (idempotency for Slack event retries)
  await db.collection('slack_processed_events').createIndex({ eventId: 1 }, { unique: true });
  await db.collection('slack_processed_events').createIndex(
    { processedAt: 1 },
    { expireAfterSeconds: 86400 }, // 24h TTL
  );

  // Uploaded Files — flat /api/files uploads metadata.
  // fileId is the stored filename (UUID + ext) — unique lookup key for
  // the public GET /api/files/:filename route to find the storage location.
  await db.collection('uploaded_files').createIndex({ fileId: 1 }, { unique: true });
  await db.collection('uploaded_files').createIndex({ createdAt: -1 });

  // ── Context Quality / Judge Layer ──────────────────────────────────────────
  // context_judge_runs
  await db.collection('context_judge_runs').createIndex({ judgeRunId: 1 }, { unique: true });
  await db.collection('context_judge_runs').createIndex({ scope: 1 });
  await db.collection('context_judge_runs').createIndex({ status: 1 });
  await db.collection('context_judge_runs').createIndex({ validFrom: -1 });
  await db.collection('context_judge_runs').createIndex({ sourceId: 1, scope: 1, active: 1 });

  // context_findings
  await db.collection('context_findings').createIndex({ findingId: 1 }, { unique: true });
  await db.collection('context_findings').createIndex({ judgeRunId: 1 });
  await db.collection('context_findings').createIndex({ scope: 1 });
  await db.collection('context_findings').createIndex({ status: 1 });
  await db.collection('context_findings').createIndex({ reliabilityLabel: 1 });
  await db.collection('context_findings').createIndex({ scope: 1, status: 1, active: 1 });

  // context_review_tasks
  await db.collection('context_review_tasks').createIndex({ taskId: 1 }, { unique: true });
  await db.collection('context_review_tasks').createIndex({ scope: 1 });
  await db.collection('context_review_tasks').createIndex({ status: 1 });
  await db.collection('context_review_tasks').createIndex({ risk: 1 });
  await db.collection('context_review_tasks').createIndex({ scope: 1, status: 1, risk: 1 });
  await db.collection('context_review_tasks').createIndex(
    { status: 1, remediationStatus: 1, requiresHumanReview: 1, fixType: 1 },
    { name: 'idx_review_tasks_remediation_ready' },
  );

  // context_review_decisions
  await db.collection('context_review_decisions').createIndex({ decisionId: 1 }, { unique: true });
  await db.collection('context_review_decisions').createIndex({ taskId: 1, createdAt: 1 });

  // context_remediations
  await db.collection('context_remediations').createIndex({ remediationId: 1 }, { unique: true });
  await db.collection('context_remediations').createIndex({ taskId: 1 });
  await db.collection('context_remediations').createIndex({ findingId: 1 });
  await db.collection('context_remediations').createIndex({ workerRole: 1, status: 1 });
  await db.collection('context_remediations').createIndex({ targetRefIds: 1 }, { sparse: true });
  await db.collection('context_remediations').createIndex({ targetEntryIds: 1 }, { sparse: true });
  await db.collection('context_remediations').createIndex({ status: 1 });

  // repo_context_curation_entry_revisions
  await db.collection('repo_context_curation_entry_revisions').createIndex({ revisionId: 1 }, { unique: true });
  await db.collection('repo_context_curation_entry_revisions').createIndex({ repoId: 1, entryId: 1, createdAt: 1 });

  // context_learning_promotions
  await db.collection('context_learning_promotions').createIndex({ promotionId: 1 }, { unique: true });
  await db.collection('context_learning_promotions').createIndex({ learningId: 1 });
  await db.collection('context_learning_promotions').createIndex({ decision: 1 });

  // context_judge_config (singleton)
  await db.collection('context_judge_config').createIndex({ configId: 1 }, { unique: true });

  // context_review_worker_assignments
  await db.collection('context_review_worker_assignments').createIndex({ assignmentId: 1 }, { unique: true });
  await db.collection('context_review_worker_assignments').createIndex({ status: 1 });
  await db.collection('context_review_worker_assignments').createIndex({ workerAgentName: 1 });
  await db.collection('context_review_worker_assignments').createIndex({ workerRole: 1, status: 1 });
  await db.collection('context_review_worker_assignments').createIndex({ remediationIds: 1 }, { sparse: true });
  await db.collection('context_review_worker_assignments').createIndex({ learningIds: 1 }, { sparse: true });
  await db.collection('context_review_worker_assignments').createIndex(
    { workerRole: 1, status: 1, taskIds: 1 },
    { name: 'idx_worker_assignments_role_status_tasks' },
  );

  // context_trace_analysis_assignments
  await db.collection('context_trace_analysis_assignments').createIndex({ assignmentId: 1 }, { unique: true });
  await db.collection('context_trace_analysis_assignments').createIndex({ sessionId: 1, status: 1 });
  await db.collection('context_trace_analysis_assignments').createIndex({ sourceIds: 1 });
  await db.collection('context_trace_analysis_assignments').createIndex({ retryOfAssignmentId: 1 }, { sparse: true });
  await db.collection('context_trace_analysis_assignments').createIndex({ terminalReason: 1 }, { sparse: true });

  // context_agent_dispatch_queue — AUDIT/FALLBACK only.
  // The primary worker-start mechanism is mcp__allen__spawn_agent called by the orchestrator agent.
  // This collection records dispatch attempts for audit purposes only and is NOT used to trigger
  // execution. Indexes support status polling and cleanup without blocking the primary spawn path.
  await db.collection('context_agent_dispatch_queue').createIndex({ recordId: 1 }, { unique: true });
  await db.collection('context_agent_dispatch_queue').createIndex({ assignmentId: 1 });
  await db.collection('context_agent_dispatch_queue').createIndex({ status: 1 });
  await db.collection('context_agent_dispatch_queue').createIndex({ createdAt: -1 });

  // sourceKey deduplication index (sparse — only present when sourceKind+sourceId set)
  await db.collection('context_judge_runs').createIndex(
    { sourceKey: 1, status: 1, active: 1 },
    { sparse: true, name: 'sourceKey_status_active' },
  );
  await db.collection('context_judge_runs').createIndex({ sourceKey: 1, active: 1 });

  // clusterKey for review task deduplication
  await db.collection('context_review_tasks').createIndex(
    { clusterKey: 1, status: 1 },
    { sparse: true, name: 'clusterKey_status' },
  );

  // context_orchestrator_run_records
  await db.collection('context_orchestrator_run_records').createIndex({ runId: 1 }, { unique: true });
  await db.collection('context_orchestrator_run_records').createIndex({ status: 1, triggeredAt: -1 });
  await db.collection('context_orchestrator_run_records').createIndex({ triggeredAt: -1 });

  // context_orchestration_sessions
  await db.collection('context_orchestration_sessions').createIndex({ sessionId: 1 }, { unique: true });
  await db.collection('context_orchestration_sessions').createIndex({ rootExecutionId: 1 }, { sparse: true });
  await db.collection('context_orchestration_sessions').createIndex({ status: 1, lifecycleStatus: 1, updatedAt: -1 });

  // context_source_evaluations — durable per-source evaluation ledger.
  // The scheduler anti-joins against { sourceKey, status: 'completed' } to skip
  // already-evaluated sources (GAP 1 + GAP 2 fix).
  await db.collection('context_source_evaluations').createIndex(
    { repoId: 1, sourceType: 1, sourceKey: 1, evaluationVersion: 1 },
    { name: 'idx_srceval_repo_type_key_ver' },
  );
  await db.collection('context_source_evaluations').createIndex(
    { sessionId: 1, sourceType: 1, decision: 1 },
    { name: 'idx_srceval_session_type_decision' },
  );
  await db.collection('context_source_evaluations').createIndex(
    { sessionId: 1, contextVerdict: 1 },
    { name: 'idx_srceval_session_verdict' },
  );
  await db.collection('context_source_evaluations').createIndex(
    { repoId: 1, classification: 1, contextVerdict: 1 },
    { name: 'idx_srceval_repo_class_verdict' },
  );
  await db.collection('context_source_evaluations').createIndex(
    { affectedRefIds: 1 },
    { sparse: true, name: 'idx_srceval_affected_refs' },
  );
  await db.collection('context_source_evaluations').createIndex(
    { judgeRunId: 1 },
    { sparse: true, name: 'idx_srceval_judgeRunId' },
  );
  await db.collection('context_source_evaluations').createIndex(
    { sourceKey: 1, evaluatedAt: -1 },
    { name: 'idx_srceval_key_evaluatedAt' },
  );
  // Fast lookup for anti-join: scheduler checks { sourceKey, status: 'completed' }
  await db.collection('context_source_evaluations').createIndex(
    { sourceKey: 1, status: 1 },
    { name: 'idx_srceval_key_status' },
  );

  // Design Repos — partial indexes for design-specific queries (REQ-016)
  await db.collection('repos').createIndex(
    { isDefaultDesignRepo: 1 },
    { partialFilterExpression: { isDefaultDesignRepo: true } },
  );
  await db.collection('repos').createIndex(
    { roles: 1 },
    { partialFilterExpression: { roles: { $exists: true } } },
  );

  // Design Sessions (REQ-019, REQ-012)
  await db.collection('design_sessions').createIndex({ status: 1, lastMessageAt: -1 });
  await db.collection('design_sessions').createIndex({ designRepoId: 1, lastMessageAt: -1 });
  await db.collection('design_sessions').createIndex({ workspaceId: 1 }, { sparse: true });
  await db.collection('design_sessions').createIndex({ ownerUserId: 1, lastMessageAt: -1 }, { sparse: true });

  // Design Messages (REQ-019)
  await db.collection('design_messages').createIndex({ designSessionId: 1, createdAt: 1 });
  await db.collection('design_messages').createIndex({ executionId: 1 }, { sparse: true });
  await db.collection('design_messages').createIndex({ agentRunId: 1 }, { sparse: true });

  // repo_context_setup_runs
  await db.collection('repo_context_setup_runs').createIndex({ setupRunId: 1 }, { unique: true, name: 'idx_setup_run_id' });
  await db.collection('repo_context_setup_runs').createIndex({ repoId: 1, status: 1, updatedAt: -1 }, { name: 'idx_setup_repo_status' });
  // One active (running|partial) setup run per repo. DocumentDB rejects `$in`
  // inside a partialFilterExpression, so the active-status set is mirrored onto
  // the boolean `isActive` field (kept in sync by RepoContextSetupService) and
  // the partial filter keys off that single equality term instead.
  //
  // A prior server version created this same-named index with a different
  // partialFilterExpression ({ status: { $in: ["running","partial"] } }).
  // MongoDB refuses to recreate a same-named index with a changed spec
  // (IndexKeySpecsConflict, code 86), which crash-loops boot. On that specific
  // conflict, drop the stale index and recreate it with the current spec.
  await db.collection('repo_context_setup_runs')
    .createIndex(
      { repoId: 1 },
      { unique: true, partialFilterExpression: { isActive: true }, name: 'idx_setup_active_per_repo' },
    )
    .catch(async (err: unknown) => {
      if (!isIndexSpecConflict(err)) throw err;
      await db.collection('repo_context_setup_runs')
        .dropIndex('idx_setup_active_per_repo')
        .catch(ignoreMissingIndex);
      await db.collection('repo_context_setup_runs').createIndex(
        { repoId: 1 },
        { unique: true, partialFilterExpression: { isActive: true }, name: 'idx_setup_active_per_repo' },
      );
    });
  await db.collection('repo_context_setup_runs').createIndex({ status: 1, updatedAt: -1 }, { name: 'idx_setup_status_updated' });

  // mandatory_context_proposals
  // Partial unique index: only final assembled proposal docs carry both proposalId AND mappings.
  // Staged rows have no proposalId, so they must NOT participate in this constraint — a broad
  // unique index on { proposalId: 1 } treats all missing/null proposalId values as a single key
  // and causes E11000 when more than one staged row exists.
  // NOTE: if the old broad unique index still exists from a prior server version, drop it manually:
  //   db.mandatory_context_proposals.dropIndex('idx_proposal_id')
  // then restart so this partial index is created in its place.
  await db.collection('mandatory_context_proposals').createIndex(
    { proposalId: 1 },
    {
      unique: true,
      partialFilterExpression: { proposalId: { $exists: true }, mappings: { $exists: true } },
      name: 'idx_proposal_id',
    },
  );
  await db.collection('mandatory_context_proposals').createIndex(
    { setupRunId: 1 },
    { unique: true, partialFilterExpression: { status: 'proposed' }, name: 'idx_proposal_active_per_run' },
  );
  await db.collection('mandatory_context_proposals').createIndex({ setupRunId: 1, status: 1, createdAt: -1 }, { name: 'idx_proposal_run_status' });
  await db.collection('mandatory_context_proposals').createIndex(
    { setupRunId: 1, agentName: 1, title: 1, sourcePath: 1 },
    { unique: true, partialFilterExpression: { status: 'staged' }, name: 'idx_proposal_staged_key' },
  );
  await db.collection('mandatory_context_proposals').createIndex({ createdAt: 1 }, { expireAfterSeconds: 604800, name: 'idx_proposal_ttl' });

  // repo_mandatory_context_mappings — hot lookup for runtime injection and deactivation
  await db.collection('repo_mandatory_context_mappings').createIndex(
    { repoId: 1, agentName: 1, enabled: 1 },
    { sparse: true, name: 'idx_mandatory_repo_agent_enabled' },
  );
  // repo_context_curation_stage_file_statuses — get() filters by runId for failure list
  await db.collection('repo_context_curation_stage_file_statuses').createIndex(
    { runId: 1 },
    { name: 'idx_curation_file_statuses_run_id' },
  );
  // repo_context_curation_stage_entries — indexed for fast runId lookups
  await db.collection('repo_context_curation_stage_entries').createIndex(
    { runId: 1 },
    { name: 'idx_curation_stage_entries_run_id' },
  );
  // repo_mandatory_context_mappings — sparse indexes for setup-run progress queries
  await db.collection('repo_mandatory_context_mappings').createIndex(
    { stagedBySetupRunId: 1 },
    { sparse: true, name: 'idx_mandatory_staged_by_run' },
  );
  await db.collection('repo_mandatory_context_mappings').createIndex(
    { deactivatedByRunId: 1 },
    { sparse: true, name: 'idx_mandatory_deactivated_by_run' },
  );
  // Design Studio (Allen Design) — workspaces → sessions → versions → messages
  await db.collection('dstudio_workspaces').createIndex({ ownerUserId: 1, updatedAt: -1 }, { sparse: true });
  await db.collection('dstudio_workspaces').createIndex({ kind: 1, sourceRepoId: 1 }, { sparse: true });
  await db.collection('dstudio_sessions').createIndex({ workspaceId: 1, lastMessageAt: -1 });
  await db.collection('dstudio_versions').createIndex({ sessionId: 1, seq: 1 });
  await db.collection('dstudio_versions').createIndex({ groupId: 1 }, { sparse: true });
  await db.collection('dstudio_messages').createIndex({ sessionId: 1, createdAt: 1 });

  // ── Execution Watchers ──────────────────────────────────────────────────────
  // Deterministic Execution Watcher — see TDD §1.1 for index rationale.
  await db.collection('execution_watchers').createIndex(
    { watcherId: 1 },
    { unique: true },
  );
  await db.collection('execution_watchers').createIndex(
    { executionId: 1 },
    { unique: true },
  );
  await db.collection('execution_watchers').createIndex(
    { chatSessionId: 1, watcherStatus: 1 },
  );
  await db.collection('execution_watchers').createIndex(
    { watcherStatus: 1, nextPollAt: 1 },
  );
  await db.collection('execution_watchers').createIndex(
    { watcherStatus: 1, lastPolledAt: 1 },
  );
  await db.collection('execution_watchers').createIndex(
    { updatedAt: 1 },
  );

  // ── Chat Export / Import Bundles ──────────────────────────────────────────
  await db.collection('chat_export_bundles').createIndex({ bundleId: 1 }, { unique: true });
  await db.collection('chat_export_bundles').createIndex({ chatSessionId: 1, operation: 1 });
  await db.collection('chat_export_bundles').createIndex({ userId: 1, createdAt: -1 });
  await db.collection('chat_export_bundles').createIndex(
    { importSessionId: 1 },
    { sparse: true },
  );
  await db.collection('chat_export_bundles').createIndex({ createdAt: -1 });

  // Imported chat sessions — partial index so only imported rows participate
  await db.collection('chat_sessions').createIndex(
    { isImported: 1 },
    { partialFilterExpression: { isImported: true } },
  );

  console.log('Database indexes ensured');
}

// True when MongoDB rejects an index because one with the same name already
// exists with a different key/options spec (IndexKeySpecsConflict code 86 or
// IndexOptionsConflict code 85). Used to trigger a drop-and-recreate migration.
function isIndexSpecConflict(err: unknown): boolean {
  const e = typeof err === 'object' && err !== null ? (err as Record<string, unknown>) : undefined;
  const codeName = e?.['codeName'];
  const code = e?.['code'];
  const message = String(e?.['message'] ?? '');
  return (
    codeName === 'IndexKeySpecsConflict' ||
    codeName === 'IndexOptionsConflict' ||
    code === 86 ||
    code === 85 ||
    /same name as the requested index|already exists with different options|different options/i.test(message)
  );
}

function ignoreMissingIndex(err: unknown): void {
  const e = typeof err === 'object' && err !== null ? (err as Record<string, unknown>) : undefined;
  const codeName = e?.['codeName'];
  const code = e?.['code'];
  const message = String(e?.['message'] ?? '');
  if (
    codeName === 'IndexNotFound' ||
    codeName === 'NamespaceNotFound' ||
    code === 26 ||
    code === 27 ||
    /index not found/i.test(message) ||
    /ns not found/i.test(message)
  ) {
    return;
  }
  throw err;
}
