import type { Db } from 'mongodb';

export async function ensureIndexes(db: Db): Promise<void> {
  // Workflows
  await db.collection('workflows').createIndex({ name: 1 }, { unique: true });
  await db.collection('workflows').createIndex({ tags: 1 });

  // Agents
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

  // Executions
  await db.collection('executions').createIndex({ id: 1 }, { unique: true });
  await db.collection('executions').createIndex({ workflowId: 1 });
  await db.collection('executions').createIndex({ workflowName: 1 });
  await db.collection('executions').createIndex({ status: 1 });
  await db.collection('executions').createIndex({ startedAt: -1 });
  // Compound index for concurrency limit checks
  await db.collection('executions').createIndex({ workflowName: 1, status: 1 });

  // Traces
  await db.collection('execution_traces').createIndex({ executionId: 1, node: 1, attempt: 1 });
  await db.collection('execution_traces').createIndex({ executionId: 1, startedAt: 1 });

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

  // Repo Contexts (deep agent-generated markdown context)
  // Lookup by repoId is hot — every agent spawn into a registered repo hits this.
  await db.collection('repo_contexts').createIndex({ repoId: 1 }, { unique: true });

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

  // Learnings
  await db.collection('learnings').createIndex({ 'scope.level': 1, status: 1, confidence: -1 });
  await db.collection('learnings').createIndex({ 'scope.contextTags': 1 });
  await db.collection('learnings').createIndex({ 'scope.workflowName': 1 });
  await db.collection('learnings').createIndex({ 'scope.agentName': 1 });
  await db.collection('learnings').createIndex({ tags: 1 });
  await db.collection('learnings').createIndex({ status: 1, lastUsedAt: 1 });
  await db.collection('learnings').createIndex({ 'source.executionId': 1 });

  // Chat Sessions
  await db.collection('chat_sessions').createIndex({ status: 1, lastMessageAt: -1 });
  await db.collection('chat_sessions').createIndex({ llmSessionId: 1 });

  // Chat Messages
  await db.collection('chat_messages').createIndex({ sessionId: 1, createdAt: 1 });

  // Agent Conversations (delegation threads)
  await db.collection('agent_conversations').createIndex({ chatSessionId: 1, startedAt: -1 });
  await db.collection('agent_conversations').createIndex({ fromAgent: 1, toAgent: 1 });
  await db.collection('agent_conversations').createIndex({ status: 1 });

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

  // Slack Thread Mappings (Slack thread → FlowForge chat session)
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

  console.log('Database indexes ensured');
}
