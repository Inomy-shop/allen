/**
 * Linear integration service.
 *
 * Reads the user's Linear API key from `.env` (ALLEN_LINEAR_ACCESS_TOKEN) and
 * wraps the @linear/sdk client for read-only access to projects and issues.
 * Agent assignments are stored locally by TicketAssignmentService; this file
 * deliberately never writes to Linear.
 */

import { LinearClient } from '@linear/sdk';
import type { Db } from 'mongodb';
import { ObjectId } from 'mongodb';
import { TicketAssignmentService, type TicketAssignment } from './ticket-assignment.service.js';
import { WorkspaceManager } from './workspace.service.js';
import { executeChatTool } from './chat-tools.js';
import { ExecutionService } from './execution.service.js';
import { getRuntimeSecretsProvider } from '../runtime/config.js';

// TTL caches — Linear's rate limit is 4500 req/hr. Without caching a naive
// page refresh can easily hit hundreds of requests because every `issue.state`,
// `issue.team`, etc. access via @linear/sdk is a separate round-trip. We hand-
// roll GraphQL queries that fetch everything in one request AND cache the
// result for a short window.
const PROJECTS_TTL_MS = 60_000;
const ISSUES_TTL_MS = 30_000;
const STATUS_TTL_MS = 300_000;

export const LINEAR_TOKEN_ENV_KEY = 'ALLEN_LINEAR_ACCESS_TOKEN';

export type LinearStateType = 'backlog' | 'unstarted' | 'started' | 'completed' | 'canceled' | 'triage';

export interface LinearProjectSummary {
  id: string;
  name: string;
  description: string;
  color: string | null;
  state: string;
  icon: string | null;
  progress: number;
  issueCount: number;
  url: string;
}

export interface LinearIssueSummary {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  priority: number;
  priorityLabel: string;
  state: { id: string; name: string; type: LinearStateType; color: string };
  team: { id: string; name: string; key: string };
  project: { id: string; name: string } | null;
  linearAssignee: { id: string; name: string; email?: string | null } | null;
  agentAssignee: TicketAssignment | null;
  labels: { id: string; name: string; color: string }[];
  createdAt: string;
  updatedAt: string;
  url: string;
}

export interface LinearIssueDetail extends LinearIssueSummary {
  fullDescription: string;
}

export interface LinearStatus {
  configured: boolean;
  workspaceName?: string;
  workspaceUrlKey?: string;
  error?: string;
}

export interface ListIssuesFilters {
  projectId?: string;
  stateTypes?: LinearStateType[];
  q?: string;
  limit?: number;
  assigneeEmail?: string;
}

export interface LinearCreateIssueInput {
  title: string;
  description: string;
  teamKey?: string;
  teamId?: string;
  projectName?: string;
  projectId?: string;
  assigneeEmail?: string;
  assigneeId?: string;
  priority?: number;
}

const PRIORITY_LABELS: Record<number, string> = {
  0: 'No priority',
  1: 'Urgent',
  2: 'High',
  3: 'Medium',
  4: 'Low',
};

function buildAgentDispatchPromptTemplate(issue: LinearIssueDetail, extraInstructions?: string): string {
  const header = `You've been assigned Linear ticket ${issue.identifier}: ${issue.title}.`;
  const body = issue.description ? `\n\n---\n${issue.description}` : '';
  const extra = extraInstructions?.trim() ? `\n\n---\nAdditional instructions:\n${extraInstructions.trim()}` : '';
  return `${header}${body}${extra}\n\nWORKSPACE CONTEXT:\n- Worktree path: {{worktreePath}}\n- Repository path: {{repoPath}}\n\nWork inside this workspace. Start by skimming the repo structure, then plan your approach before editing code. Ask clarifying questions if anything is ambiguous.`;
}

function resolveAgentDispatchPrompt(
  template: string,
  replacements: { worktreePath: string; repoPath: string },
): string {
  return template
    .replaceAll('{{worktreePath}}', replacements.worktreePath)
    .replaceAll('{{repoPath}}', replacements.repoPath);
}

export class LinearService {
  private db: Db;
  private assignmentSvc: TicketAssignmentService;
  private cachedClient: { token: string; client: LinearClient } | null = null;

  // Module-level caches, shared across service instances.
  private static statusCache: { at: number; data: LinearStatus; token: string } | null = null;
  private static projectsCache: { at: number; data: LinearProjectSummary[]; token: string } | null = null;
  private static issuesCache = new Map<string, { at: number; data: LinearIssueSummary[] }>();

  constructor(db: Db) {
    this.db = db;
    this.assignmentSvc = new TicketAssignmentService(db);
  }

  private async hydrateAssignmentStatuses(assignments: TicketAssignment[]): Promise<Map<string, TicketAssignment>> {
    if (assignments.length === 0) return new Map();
    const executionIds = assignments
      .map(a => a.executionId)
      .filter((id): id is string => typeof id === 'string' && id.length > 0);

    if (executionIds.length === 0) {
      return new Map(assignments.map(a => [a.linearIssueId, a]));
    }

    const executions = await this.db.collection('executions')
      .find(
        { id: { $in: executionIds } },
        { projection: { id: 1, status: 1, errorMessage: 1 } },
      )
      .toArray();
    const byExecutionId = new Map<string, { status?: string; errorMessage?: string | null }>(
      executions.map(doc => [
        String(doc.id),
        {
          status: typeof doc.status === 'string' ? doc.status : undefined,
          errorMessage: typeof doc.errorMessage === 'string' ? doc.errorMessage : null,
        },
      ]),
    );

    const out = new Map<string, TicketAssignment>();
    const writes: Promise<unknown>[] = [];
    for (const assignment of assignments) {
      const exec = assignment.executionId ? byExecutionId.get(assignment.executionId) : undefined;
      if (!exec?.status) {
        out.set(assignment.linearIssueId, assignment);
        continue;
      }

      const nextStatus =
        exec.status === 'queued' ? 'pending'
        : exec.status === 'running' || exec.status === 'waiting_for_input' ? 'running'
        : exec.status === 'completed' ? 'completed'
        : exec.status === 'failed' || exec.status === 'cancelled' ? 'failed'
        : assignment.status;
      const nextError =
        exec.status === 'failed' ? (exec.errorMessage ?? assignment.error ?? 'Execution failed')
        : exec.status === 'cancelled' ? 'Execution cancelled'
        : null;
      const nextAssignment: TicketAssignment = {
        ...assignment,
        status: nextStatus,
        executionStatus: exec.status,
        error: nextError,
      };
      out.set(assignment.linearIssueId, nextAssignment);

      if (
        nextAssignment.status !== assignment.status
        || nextAssignment.executionStatus !== assignment.executionStatus
        || nextAssignment.error !== assignment.error
      ) {
        writes.push(
          this.assignmentSvc.patch(assignment.linearIssueId, {
            status: nextAssignment.status,
            executionStatus: nextAssignment.executionStatus,
            error: nextAssignment.error,
          }).catch(() => null),
        );
      }
    }

    if (writes.length > 0) await Promise.all(writes);
    return out;
  }

  /** Evict all Linear data caches. Call after assignment changes or manual refresh. */
  static invalidateCaches() {
    LinearService.statusCache = null;
    LinearService.projectsCache = null;
    LinearService.issuesCache.clear();
  }

  private async getToken(): Promise<string | null> {
    return await getRuntimeSecretsProvider().getSecret(LINEAR_TOKEN_ENV_KEY) ?? null;
  }

  private async getClient(): Promise<LinearClient | null> {
    const token = await this.getToken();
    if (!token) {
      this.cachedClient = null;
      return null;
    }
    if (this.cachedClient && this.cachedClient.token === token) {
      return this.cachedClient.client;
    }
    const client = new LinearClient({ apiKey: token });
    this.cachedClient = { token, client };
    return client;
  }

  async status(): Promise<LinearStatus> {
    const token = await this.getToken();
    if (!token) return { configured: false };
    const cached = LinearService.statusCache;
    if (cached && cached.token === token && Date.now() - cached.at < STATUS_TTL_MS) {
      return cached.data;
    }
    try {
      const resp = await this.rawRequest<{ organization: { name: string; urlKey: string } }>(`
        query LinearStatus { organization { name urlKey } }
      `);
      const data: LinearStatus = {
        configured: true,
        workspaceName: resp.organization.name,
        workspaceUrlKey: resp.organization.urlKey,
      };
      LinearService.statusCache = { at: Date.now(), data, token };
      return data;
    } catch (err: unknown) {
      return {
        configured: true,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async listProjects(): Promise<LinearProjectSummary[]> {
    const token = await this.getToken();
    if (!token) return [];
    const cached = LinearService.projectsCache;
    if (cached && cached.token === token && Date.now() - cached.at < PROJECTS_TTL_MS) {
      return cached.data;
    }
    const resp = await this.rawRequest<{ projects: { nodes: ProjectNode[] } }>(`
      query LinearProjects {
        projects(first: 100) {
          nodes {
            id name description color state icon progress url
          }
        }
      }
    `);
    const data: LinearProjectSummary[] = (resp.projects?.nodes ?? []).map(p => ({
      id: p.id,
      name: p.name,
      description: p.description ?? '',
      color: p.color ?? null,
      state: p.state ?? 'unknown',
      icon: p.icon ?? null,
      progress: typeof p.progress === 'number' ? p.progress : 0,
      issueCount: 0,
      url: p.url ?? '',
    }));
    LinearService.projectsCache = { at: Date.now(), data, token };
    return data;
  }

  async listIssues(filters: ListIssuesFilters = {}): Promise<LinearIssueSummary[]> {
    const token = await this.getToken();
    if (!token) return [];

    const limit = Math.min(filters.limit ?? 100, 250);
    const linearFilter: Record<string, unknown> = {};
    if (filters.projectId) {
      linearFilter.project = { id: { eq: filters.projectId } };
    }
    if (filters.stateTypes && filters.stateTypes.length > 0) {
      linearFilter.state = { type: { in: filters.stateTypes } };
    }
    if (filters.q && filters.q.trim()) {
      const q = filters.q.trim();
      linearFilter.or = [
        { title: { containsIgnoreCase: q } },
        { description: { containsIgnoreCase: q } },
      ];
    }
    if (filters.assigneeEmail) {
      linearFilter.assignee = { email: { eq: filters.assigneeEmail } };
    }

    const cacheKey = `${token}::${limit}::${JSON.stringify(linearFilter)}`;
    const cached = LinearService.issuesCache.get(cacheKey);
    const assignmentsMap = await this.hydrateAssignmentStatuses(
      Array.from((await this.assignmentSvc.getAllAsMap()).values()),
    );

    if (cached && Date.now() - cached.at < ISSUES_TTL_MS) {
      // Re-hydrate assignments from Mongo (cheap) so assignment changes are visible
      // without waiting for the Linear cache to expire.
      return cached.data.map(issue => ({
        ...issue,
        agentAssignee: assignmentsMap.get(issue.id) ?? null,
      }));
    }

    const resp = await this.rawRequest<{ issues: { nodes: IssueNode[] } }>(ISSUES_QUERY, {
      first: limit,
      filter: linearFilter,
    });

    const summaries: LinearIssueSummary[] = (resp.issues?.nodes ?? []).map(issue => ({
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      description: issue.description ?? null,
      priority: issue.priority,
      priorityLabel: PRIORITY_LABELS[issue.priority] ?? 'No priority',
      state: issue.state
        ? { id: issue.state.id, name: issue.state.name, type: issue.state.type as LinearStateType, color: issue.state.color }
        : { id: '', name: 'Unknown', type: 'backlog', color: '#999' },
      team: issue.team
        ? { id: issue.team.id, name: issue.team.name, key: issue.team.key }
        : { id: '', name: 'Unknown', key: '' },
      project: issue.project ? { id: issue.project.id, name: issue.project.name } : null,
      linearAssignee: issue.assignee
        ? { id: issue.assignee.id, name: issue.assignee.name, email: issue.assignee.email ?? null }
        : null,
      agentAssignee: assignmentsMap.get(issue.id) ?? null,
      labels: (issue.labels?.nodes ?? []).map(l => ({ id: l.id, name: l.name, color: l.color })),
      createdAt: issue.createdAt,
      updatedAt: issue.updatedAt,
      url: issue.url,
    }));

    LinearService.issuesCache.set(cacheKey, { at: Date.now(), data: summaries });
    return summaries;
  }

  async getIssue(id: string): Promise<LinearIssueDetail | null> {
    const token = await this.getToken();
    if (!token) return null;

    const resp = await this.rawRequest<{ issue: IssueNode | null }>(`
      query LinearIssue($id: String!) {
        issue(id: $id) {
          id identifier title description priority createdAt updatedAt url
          state { id name type color }
          team { id name key }
          project { id name }
          assignee { id name email }
          labels(first: 20) { nodes { id name color } }
        }
      }
    `, { id });

    const issue = resp.issue;
    if (!issue) return null;
    const rawAssignment = await this.assignmentSvc.get(issue.id);
    const agentAssignee = rawAssignment
      ? (await this.hydrateAssignmentStatuses([rawAssignment])).get(issue.id) ?? rawAssignment
      : null;
    return {
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      description: issue.description ?? null,
      fullDescription: issue.description ?? '',
      priority: issue.priority,
      priorityLabel: PRIORITY_LABELS[issue.priority] ?? 'No priority',
      state: issue.state
        ? { id: issue.state.id, name: issue.state.name, type: issue.state.type as LinearStateType, color: issue.state.color }
        : { id: '', name: 'Unknown', type: 'backlog', color: '#999' },
      team: issue.team
        ? { id: issue.team.id, name: issue.team.name, key: issue.team.key }
        : { id: '', name: 'Unknown', key: '' },
      project: issue.project ? { id: issue.project.id, name: issue.project.name } : null,
      linearAssignee: issue.assignee
        ? { id: issue.assignee.id, name: issue.assignee.name, email: issue.assignee.email ?? null }
        : null,
      agentAssignee,
      labels: (issue.labels?.nodes ?? []).map(l => ({ id: l.id, name: l.name, color: l.color })),
      createdAt: issue.createdAt,
      updatedAt: issue.updatedAt,
      url: issue.url,
    };
  }

  private async rawRequest<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
    const client = await this.getClient();
    if (!client) throw new Error('Linear is not configured');
    const gql = (client.client as any);
    const result = await gql.rawRequest(query, variables ?? {});
    return result.data as T;
  }

  async findUserByEmail(email: string): Promise<{ id: string; name: string; email: string | null } | null> {
    const resp = await this.rawRequest<{ users: { nodes: Array<{ id: string; name: string; email: string | null }> } }>(`
      query LinearUserByEmail($email: String!) {
        users(first: 1, filter: { email: { eq: $email } }) {
          nodes { id name email }
        }
      }
    `, { email });
    return resp.users.nodes[0] ?? null;
  }

  async findTeamByKey(key: string): Promise<{ id: string; name: string; key: string } | null> {
    const resp = await this.rawRequest<{ teams: { nodes: Array<{ id: string; name: string; key: string }> } }>(`
      query LinearTeamByKey($key: String!) {
        teams(first: 1, filter: { key: { eq: $key } }) {
          nodes { id name key }
        }
      }
    `, { key });
    return resp.teams.nodes[0] ?? null;
  }

  async findProjectByName(name: string): Promise<{ id: string; name: string } | null> {
    const resp = await this.rawRequest<{ projects: { nodes: Array<{ id: string; name: string }> } }>(`
      query LinearProjectByName($name: String!) {
        projects(first: 1, filter: { name: { eq: $name } }) {
          nodes { id name }
        }
      }
    `, { name });
    return resp.projects.nodes[0] ?? null;
  }

  async createIssue(input: LinearCreateIssueInput): Promise<LinearIssueSummary> {
    const teamId = input.teamId ?? (input.teamKey ? (await this.findTeamByKey(input.teamKey))?.id : undefined);
    if (!teamId) throw new Error(`Linear team not found: ${input.teamKey ?? 'missing teamId'}`);

    const projectId = input.projectId ?? (input.projectName ? (await this.findProjectByName(input.projectName))?.id : undefined);
    const assigneeId = input.assigneeId ?? (input.assigneeEmail ? (await this.findUserByEmail(input.assigneeEmail))?.id : undefined);

    const issueInput: Record<string, unknown> = {
      teamId,
      title: input.title,
      description: input.description,
      priority: input.priority ?? 3,
    };
    if (projectId) issueInput.projectId = projectId;
    if (assigneeId) issueInput.assigneeId = assigneeId;

    const resp = await this.rawRequest<{ issueCreate: { success: boolean; issue: IssueNode | null } }>(`
      mutation LinearIssueCreate($input: IssueCreateInput!) {
        issueCreate(input: $input) {
          success
          issue {
            id identifier title description priority createdAt updatedAt url
            state { id name type color }
            team { id name key }
            project { id name }
            assignee { id name email }
            labels(first: 10) { nodes { id name color } }
          }
        }
      }
    `, { input: issueInput });

    const issue = resp.issueCreate.issue;
    if (!resp.issueCreate.success || !issue) throw new Error('Linear issueCreate did not return an issue');
    LinearService.invalidateCaches();
    return this.toIssueSummary(issue, null);
  }

  async createComment(issueId: string, body: string): Promise<void> {
    const resp = await this.rawRequest<{ commentCreate: { success: boolean } }>(`
      mutation LinearCommentCreate($input: CommentCreateInput!) {
        commentCreate(input: $input) {
          success
          comment { id }
        }
      }
    `, { input: { issueId, body } });
    if (!resp.commentCreate.success) throw new Error('Linear commentCreate failed');
    LinearService.invalidateCaches();
  }

  async assignAgent(linearIssueId: string, agentName: string | null, assignedBy: string): Promise<TicketAssignment | null> {
    if (!agentName) {
      await this.assignmentSvc.clear(linearIssueId);
      return null;
    }
    return this.assignmentSvc.set(linearIssueId, agentName, assignedBy);
  }

  private toIssueSummary(issue: IssueNode, agentAssignee: TicketAssignment | null): LinearIssueSummary {
    return {
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      description: issue.description ?? null,
      priority: issue.priority,
      priorityLabel: PRIORITY_LABELS[issue.priority] ?? 'No priority',
      state: issue.state
        ? { id: issue.state.id, name: issue.state.name, type: issue.state.type as LinearStateType, color: issue.state.color }
        : { id: '', name: 'Unknown', type: 'backlog', color: '#999' },
      team: issue.team
        ? { id: issue.team.id, name: issue.team.name, key: issue.team.key }
        : { id: '', name: 'Unknown', key: '' },
      project: issue.project ? { id: issue.project.id, name: issue.project.name } : null,
      linearAssignee: issue.assignee
        ? { id: issue.assignee.id, name: issue.assignee.name, email: issue.assignee.email ?? null }
        : null,
      agentAssignee,
      labels: (issue.labels?.nodes ?? []).map(l => ({ id: l.id, name: l.name, color: l.color })),
      createdAt: issue.createdAt,
      updatedAt: issue.updatedAt,
      url: issue.url,
    };
  }

  async dispatchWorkflow(params: {
    linearIssueId: string;
    workflowId: string;
    input: Record<string, unknown>;
    dispatchedBy: string;
  }): Promise<TicketAssignment> {
    const { linearIssueId, workflowId, input, dispatchedBy } = params;
    const issue = await this.getIssue(linearIssueId);
    if (!issue) throw new Error('Linear ticket not found');

    let workflowOid: ObjectId;
    try {
      workflowOid = new ObjectId(workflowId);
    } catch {
      throw new Error('Workflow not found');
    }

    const workflowDoc = await this.db.collection('workflows').findOne(
      { _id: workflowOid },
      { projection: { name: 1, parsed: 1 } },
    );
    if (!workflowDoc) throw new Error('Workflow not found');

    const executionSvc = new ExecutionService(this.db);
    const executionInput = {
      ...input,
      linear_issue_id: input.linear_issue_id ?? issue.id,
      linear_identifier: input.linear_identifier ?? issue.identifier,
      linear_title: input.linear_title ?? issue.title,
      linear_url: input.linear_url ?? issue.url,
      ticket_id: input.ticket_id ?? issue.identifier,
      ticket_url: input.ticket_url ?? issue.url,
    };
    const started = await executionSvc.start(workflowId, executionInput);
    const executionId = typeof started.id === 'string' ? started.id : null;
    const executionStatus = typeof started.status === 'string' ? started.status : null;
    const workflowName =
      typeof started.workflowName === 'string' ? started.workflowName
      : typeof workflowDoc.name === 'string' ? workflowDoc.name
      : typeof (workflowDoc.parsed as Record<string, unknown> | undefined)?.name === 'string'
        ? String((workflowDoc.parsed as Record<string, unknown>).name)
        : 'Workflow';

    const assignment: TicketAssignment = {
      linearIssueId,
      targetKind: 'workflow',
      targetName: workflowName,
      workflowId,
      workflowName,
      assignedAt: new Date(),
      assignedBy: dispatchedBy,
      status: executionStatus === 'queued' ? 'pending' : 'running',
      executionId: executionId ?? undefined,
      executionStatus,
      error: null,
    };
    await this.assignmentSvc.upsertDispatch(assignment);
    if (executionId) {
      await this.db.collection('executions').updateOne(
        { id: executionId },
        {
          $set: {
            'meta.origin': 'linear',
            'meta.linearIssueId': issue.id,
            'meta.linearIdentifier': issue.identifier,
            'meta.linearTitle': issue.title,
            'meta.linearUrl': issue.url,
            'meta.requestText': input.task ?? input.request ?? issue.title,
          },
        },
      ).catch(() => {});
    }
    LinearService.issuesCache.clear();
    return assignment;
  }

  /**
   * Dispatch a ticket to an agent:
   * 1. Fetch the ticket from Linear.
   * 2. Create a workspace against the chosen repo (isolated git worktree).
   * 3. Poll the workspace until it becomes active (or fail on timeout).
   * 4. Spawn the agent inside that worktree with the ticket body as prompt.
   * 5. Record the full assignment (workspace + execution) locally.
   *
   * Runs to completion in the background; the HTTP handler should return
   * immediately with the initial "pending" assignment so the UI can poll.
   */
  async dispatch(params: {
    linearIssueId: string;
    agentName: string;
    repoId: string;
    extraInstructions?: string;
    promptTemplate?: string;
    dispatchedBy: string;
  }): Promise<TicketAssignment> {
    const {
      linearIssueId,
      agentName,
      repoId,
      extraInstructions,
      promptTemplate,
      dispatchedBy,
    } = params;

    const issue = await this.getIssue(linearIssueId);
    if (!issue) throw new Error('Linear ticket not found');

    const repo = await this.db.collection('repos').findOne({ _id: new ObjectId(repoId) });
    if (!repo) throw new Error('Repo not found');

    const wsManager = new WorkspaceManager(this.db);
    const repoObjectId = String(repo._id);

    // Re-dispatch should continue in the ticket's existing workspace when
    // possible. Creating another worktree with the deterministic
    // linear/<ticket> branch fails while the first workspace has that branch
    // checked out.
    const previous = await this.assignmentSvc.get(linearIssueId);
    let workspace = null as Awaited<ReturnType<WorkspaceManager['get']>> | null;
    if (previous?.workspaceId) {
      try {
        const existing = await wsManager.get(previous.workspaceId);
        if (
          existing &&
          existing.repoId === repoObjectId &&
          existing.status !== 'archived' &&
          existing.status !== 'failed'
        ) {
          workspace = existing;
        }
      } catch {
        workspace = null;
      }
    }

    if (!workspace) {
      const slug = issue.identifier.toLowerCase().replace(/[^a-z0-9-]/g, '-');
      const baseBranch = (repo.detected as any)?.defaultBranch ?? 'main';
      workspace = await wsManager.create({
        repoId: repoObjectId,
        repoName: repo.name as string,
        repoPath: repo.path as string,
        branch: `linear/${slug}`,
        baseBranch,
        name: `${issue.identifier} · ${issue.title}`.slice(0, 80),
        source: 'new',
      });
    }

    // Record initial dispatch state
    const initial: TicketAssignment = {
      linearIssueId,
      agentName,
      targetKind: 'agent',
      targetName: agentName,
      assignedAt: new Date(),
      assignedBy: dispatchedBy,
      status: 'pending',
      workspaceId: String(workspace._id),
      workspacePath: workspace.worktreePath,
      repoId: repoObjectId,
      branch: workspace.branch,
    };
    await this.assignmentSvc.upsertDispatch(initial);
    LinearService.issuesCache.clear();

    // Background: wait for workspace readiness + spawn agent
    void this.finishDispatch(initial, wsManager, issue, {
      extraInstructions,
      promptTemplate,
      repoPath: String(repo.path ?? ''),
    });

    return initial;
  }

  private async finishDispatch(
    initial: TicketAssignment,
    wsManager: WorkspaceManager,
    issue: LinearIssueDetail,
    options: {
      extraInstructions?: string;
      promptTemplate?: string;
      repoPath: string;
    },
  ): Promise<void> {
    try {
      const ready = await this.waitForWorkspaceReady(wsManager, initial.workspaceId!, 120_000);
      if (!ready) {
        await this.assignmentSvc.patch(initial.linearIssueId, {
          status: 'failed',
          error: 'Workspace did not become active within 2 minutes',
        });
        await this.db.collection('monitoring_events').insertOne({
          sourceType: 'linear_dispatch',
          sourceId: initial.linearIssueId,
          title: 'Linear dispatch workspace did not become active',
          error: 'Workspace did not become active within 2 minutes',
          rootCauseArea: 'allen_repo',
          severity: 'medium',
          confidence: 0.76,
          failureMode: 'linear_dispatch_workspace_timeout',
          relatedIds: {
            linearIssueId: initial.linearIssueId,
            workspaceId: initial.workspaceId,
            agentName: initial.agentName,
          },
          createdAt: new Date(),
        }).catch(() => {});
        LinearService.issuesCache.clear();
        return;
      }

      const promptTemplate = options.promptTemplate?.trim()
        ? options.promptTemplate
        : buildAgentDispatchPromptTemplate(issue, options.extraInstructions);
      const prompt = resolveAgentDispatchPrompt(promptTemplate, {
        worktreePath: ready.worktreePath,
        repoPath: options.repoPath,
      });

      const result = await executeChatTool(
        'spawn_agent',
        { agent_name: initial.agentName, prompt, repo_path: ready.worktreePath },
        this.db,
      );
      const executionId = (result.execution_id as string | undefined) ?? undefined;
      const spawnError = result.error as string | undefined;

      if (executionId) {
        await this.db.collection('executions').updateOne(
          { id: executionId },
          {
            $set: {
              'meta.origin': 'linear',
              'meta.linearIssueId': issue.id,
              'meta.linearIdentifier': issue.identifier,
              'meta.linearTitle': issue.title,
              'meta.linearUrl': issue.url,
              'meta.workspaceId': initial.workspaceId,
              'meta.workspacePath': ready.worktreePath,
              'meta.repoId': initial.repoId,
              'meta.branch': initial.branch,
              'meta.requestText': `${issue.identifier}: ${issue.title}`,
              'meta.requiresCodeChanges': true,
            },
          },
        ).catch(() => {});
      }

      await this.assignmentSvc.patch(initial.linearIssueId, {
        status: spawnError ? 'failed' : 'running',
        executionId,
        executionStatus: spawnError ? 'failed' : 'running',
        error: spawnError,
      });
      LinearService.issuesCache.clear();
    } catch (err: unknown) {
      const error = err instanceof Error ? err.message : String(err);
      await this.assignmentSvc.patch(initial.linearIssueId, {
        status: 'failed',
        error,
      });
      await this.db.collection('monitoring_events').insertOne({
        sourceType: 'linear_dispatch',
        sourceId: initial.linearIssueId,
        title: 'Linear dispatch failed',
        error,
        rootCauseArea: 'allen_repo',
        severity: 'medium',
        confidence: 0.76,
        failureMode: 'linear_dispatch_failed',
        relatedIds: {
          linearIssueId: initial.linearIssueId,
          workspaceId: initial.workspaceId,
          agentName: initial.agentName,
          executionId: initial.executionId,
        },
        createdAt: new Date(),
      }).catch(() => {});
      LinearService.issuesCache.clear();
    }
  }

  private async waitForWorkspaceReady(
    wsManager: WorkspaceManager,
    workspaceId: string,
    timeoutMs: number,
  ): Promise<{ worktreePath: string } | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const ws = await wsManager.get(workspaceId);
      if (!ws) return null;
      if (ws.status === 'active' || ws.status === 'running') return { worktreePath: ws.worktreePath };
      if (ws.status === 'failed') return null;
      await new Promise(r => setTimeout(r, 1500));
    }
    return null;
  }
}

// ── Internal GraphQL types ────────────────────────────────────────────────

interface IssueNode {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  priority: number;
  createdAt: string;
  updatedAt: string;
  url: string;
  state: { id: string; name: string; type: string; color: string } | null;
  team: { id: string; name: string; key: string } | null;
  project: { id: string; name: string } | null;
  assignee: { id: string; name: string; email: string | null } | null;
  labels: { nodes: { id: string; name: string; color: string }[] } | null;
}

interface ProjectNode {
  id: string;
  name: string;
  description: string | null;
  color: string | null;
  state: string | null;
  icon: string | null;
  progress: number | null;
  url: string | null;
}

// Single GraphQL query that pulls everything we need for the issue list in one
// request. Replaces the per-issue field-access pattern that was blowing the
// 4500/hr rate limit on every page load.
const ISSUES_QUERY = `
  query LinearIssues($first: Int!, $filter: IssueFilter) {
    issues(first: $first, filter: $filter, orderBy: updatedAt) {
      nodes {
        id identifier title description priority createdAt updatedAt url
        state { id name type color }
        team { id name key }
        project { id name }
        assignee { id name email }
        labels(first: 10) { nodes { id name color } }
      }
    }
  }
`;
