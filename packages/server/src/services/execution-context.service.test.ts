import { describe, expect, it } from 'vitest';
import { ObjectId, type Db } from 'mongodb';
import { ExecutionService } from './execution.service.js';

type Doc = Record<string, any>;

function byPath(doc: Doc, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, part) => {
    if (Array.isArray(acc)) return acc.flatMap(item => {
      const value = item && typeof item === 'object' ? (item as Doc)[part] : undefined;
      return Array.isArray(value) ? value : [value];
    }).filter(value => value !== undefined);
    return acc && typeof acc === 'object' ? (acc as Doc)[part] : undefined;
  }, doc);
}

function sameValue(a: unknown, b: unknown): boolean {
  if (Array.isArray(a)) return a.some(value => sameValue(value, b));
  if (Array.isArray(b)) return b.some(value => sameValue(a, value));
  if (a instanceof ObjectId || b instanceof ObjectId) return String(a) === String(b);
  return a === b;
}

function matches(doc: Doc, query: Doc): boolean {
  if (!query || Object.keys(query).length === 0) return true;
  if (Array.isArray(query.$or)) return query.$or.some((q: Doc) => matches(doc, q));
  if (Array.isArray(query.$and)) return query.$and.every((q: Doc) => matches(doc, q));
  for (const [key, expected] of Object.entries(query)) {
    if (key.startsWith('$')) continue;
    const actual = byPath(doc, key);
    if (expected && typeof expected === 'object' && !(expected instanceof ObjectId) && !Array.isArray(expected)) {
      if ('$ne' in expected && sameValue(actual, expected.$ne)) return false;
      if ('$nin' in expected && Array.isArray(expected.$nin) && expected.$nin.some((v: unknown) => sameValue(actual, v))) return false;
      if ('$in' in expected && Array.isArray(expected.$in) && !expected.$in.some((v: unknown) => sameValue(actual, v))) return false;
      if ('$exists' in expected) {
        const exists = Array.isArray(actual) ? actual.length > 0 : actual !== undefined;
        if (Boolean(expected.$exists) !== exists) return false;
      }
      if ('$type' in expected && expected.$type === 'string') {
        const isString = Array.isArray(actual) ? actual.some(value => typeof value === 'string') : typeof actual === 'string';
        if (!isString) return false;
      }
      if ('$regex' in expected) {
        const re = new RegExp(String(expected.$regex), String(expected.$options ?? ''));
        if (!re.test(String(actual ?? ''))) return false;
      }
      continue;
    }
    if (!sameValue(actual, expected)) return false;
  }
  return true;
}

function makeCursor(rows: Doc[]) {
  let result = [...rows];
  return {
    sort(sortSpec: Doc) {
      const [field, dir] = Object.entries(sortSpec)[0] ?? [];
      if (field) {
        result.sort((a, b) => {
          const av = new Date(byPath(a, field) as any).getTime() || Number(byPath(a, field) ?? 0);
          const bv = new Date(byPath(b, field) as any).getTime() || Number(byPath(b, field) ?? 0);
          return (dir as number) >= 0 ? av - bv : bv - av;
        });
      }
      return this;
    },
    limit(n: number) {
      result = result.slice(0, n);
      return this;
    },
    skip(n: number) {
      result = result.slice(n);
      return this;
    },
    project() {
      return this;
    },
    async toArray() {
      return result;
    },
  };
}

function makeDb(seed: Record<string, Doc[]>): Db {
  return {
    collection(name: string) {
      const rows = seed[name] ?? [];
      return {
        find(query: Doc = {}) {
          return makeCursor(rows.filter((row) => matches(row, query)));
        },
        async findOne(query: Doc = {}) {
          return rows.find((row) => matches(row, query)) ?? null;
        },
        async bulkWrite() {
          return {};
        },
      };
    },
  } as unknown as Db;
}

describe('ExecutionService.getContext', () => {
  it('hydrates running chat executions from persisted tool calls before the assistant turn completes', async () => {
    const db = makeDb({
      chat_messages: [
        {
          _id: new ObjectId('000000000000000000000111'),
          sessionId: 'chat-1',
          role: 'assistant',
          status: 'streaming',
          createdAt: new Date('2026-05-01T00:00:00Z'),
          toolCalls: [
            {
              tool: 'spawn_agent',
              result: {
                execution_id: 'agent-live-1',
                status: 'running',
                agent_name: 'backend-developer',
              },
            },
          ],
        },
      ],
      executions: [
        {
          id: 'agent-live-1',
          workflowName: 'chat:spawn_agent/backend-developer',
          source: 'chat',
          status: 'running',
          input: { agent_name: 'backend-developer', prompt: 'Investigate refresh visibility' },
          state: {},
          currentNodes: ['backend-developer'],
          completedNodes: [],
          cost: { actual: null, estimated: 0 },
          startedAt: new Date('2026-05-01T00:00:05Z'),
          meta: {},
        },
      ],
      execution_traces: [],
      execution_logs: [],
      agent_activity: [],
      workflow_interventions: [],
      workspaces: [],
      ticket_assignments: [],
      pull_requests: [],
      artifacts: [],
    });

    const rows = await new ExecutionService(db).listForChatSession('chat-1');

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      executionId: 'agent-live-1',
      sourceMessageId: '000000000000000000000111',
      status: 'running',
      kind: 'agent',
    });
    expect((rows[0].runContext as any)?.chat).toMatchObject({
      sessionId: 'chat-1',
      parentMessageId: '000000000000000000000111',
    });
  });

  it('normalizes workflow progress, child agents, interventions, workspace, and artifacts', async () => {
    const workflowId = new ObjectId();
    const workspaceId = new ObjectId();
    const db = makeDb({
      executions: [
        {
          id: 'wf-1',
          workflowId: String(workflowId),
          workflowName: 'feature-plan-and-implement',
          status: 'running',
          input: { task: 'Build status UI', workspace_id: String(workspaceId) },
          state: {},
          currentNodes: ['develop'],
          completedNodes: ['intake'],
          cost: { actual: null, estimated: 0 },
          startedAt: new Date('2026-05-01T00:00:00Z'),
          meta: { origin: 'chat', requestText: 'Build status UI' },
        },
        {
          id: 'agent-1',
          workflowName: 'develop:spawn_agent/frontend-developer',
          status: 'running',
          input: { agent_name: 'frontend-developer', prompt: 'Implement cards' },
          currentNodes: ['frontend-developer'],
          completedNodes: [],
          parentExecutionId: 'wf-1',
          startedAt: new Date('2026-05-01T00:01:00Z'),
        },
      ],
      workflows: [
        { _id: workflowId, parsed: { nodes: { intake: {}, develop: {}, validate: {} } } },
      ],
      execution_traces: [],
      execution_logs: [
        { executionId: 'wf-1', type: 'tool_start', tool: 'Edit', content: 'Edit src/App.tsx', timestamp: new Date('2026-05-01T00:02:00Z') },
      ],
      workspaces: [
        { _id: workspaceId, name: 'status-ui', status: 'active', repoName: 'allen', branch: 'task/status-ui', baseBranch: 'main', worktreePath: '/tmp/allen/status-ui' },
      ],
      workflow_interventions: [
        { workflow_run_id: 'wf-1', intervention_id: 'INT-1', status: 'pending', title: 'Approve UI plan', stage: 'review', severity: 'medium', created_at: new Date('2026-05-01T00:03:00Z') },
      ],
      artifacts: [
        { artifactId: 'art-1', rootType: 'workflow', rootId: 'wf-1', filename: 'plan.md', relativePath: 'plan.md', contentType: 'markdown', sizeBytes: 12, createdAt: new Date('2026-05-01T00:04:00Z') },
      ],
      ticket_assignments: [],
      pull_requests: [],
      agent_activity: [],
    });

    const context = await new ExecutionService(db).getContext('wf-1');

    expect(context.runType).toBe('workflow');
    expect(context.origin).toBe('chat');
    expect(context.progress).toMatchObject({ completed: 1, total: 3, percent: 33, currentStep: 'develop', phase: 'editing' });
    expect(context.humanInput).toMatchObject({ required: true, interventionId: 'INT-1' });
    expect(context.workspace).toMatchObject({ id: String(workspaceId), repoName: 'allen', worktreePath: '/tmp/allen/status-ui' });
    expect(context.childAgents[0]).toMatchObject({ executionId: 'agent-1', agentName: 'frontend-developer', status: 'running' });
    expect(context.artifacts[0]).toMatchObject({ artifactId: 'art-1', url: '/api/artifacts/art-1/content' });
  });

  it('counts skipped workflow nodes as progressed in context', async () => {
    const workflowId = new ObjectId();
    const db = makeDb({
      executions: [
        {
          id: 'wf-skipped-1',
          workflowId: String(workflowId),
          workflowName: 'repo-change',
          status: 'running',
          input: { task: 'Implement requested change' },
          state: {},
          currentNodes: ['execute_repo_plan'],
          completedNodes: ['understand_request', 'plan_repo_changes'],
          cost: { actual: null, estimated: 0 },
          startedAt: new Date('2026-05-01T00:00:00Z'),
          meta: { origin: 'chat', requestText: 'Implement requested change' },
        },
      ],
      workflows: [
        {
          _id: workflowId,
          parsed: {
            nodes: {
              understand_request: { type: 'agent', agent: 'requirements-analyst' },
              clarify_request: { type: 'human' },
              plan_repo_changes: { type: 'agent', agent: 'engineering-lead' },
              review_repo_plan: { type: 'human' },
              execute_repo_plan: { type: 'agent', agent: 'engineering-lead' },
              final_summary: { type: 'agent', agent: 'documentation-writer' },
            },
          },
        },
      ],
      execution_traces: [],
      execution_logs: [],
      workflow_interventions: [],
      workspaces: [],
      ticket_assignments: [],
      pull_requests: [],
      artifacts: [],
      agent_activity: [],
    });

    const context = await new ExecutionService(db).getContext('wf-skipped-1');

    expect(context.progress).toMatchObject({ completed: 4, total: 6, percent: 67, currentStep: 'execute_repo_plan' });
    expect(context.workflowSteps.map(step => [step.name, step.status])).toEqual([
      ['understand_request', 'completed'],
      ['clarify_request', 'skipped'],
      ['plan_repo_changes', 'completed'],
      ['review_repo_plan', 'skipped'],
      ['execute_repo_plan', 'running'],
      ['final_summary', 'pending'],
    ]);
  });

  it('surfaces answered human interventions as workflow steps when no trace row exists', async () => {
    const workflowId = new ObjectId();
    const db = makeDb({
      executions: [
        {
          id: 'wf-human-1',
          workflowId: String(workflowId),
          workflowName: 'bug-fix-by-severity',
          status: 'failed',
          input: { task: 'Fix approval rejection' },
          state: {},
          currentNodes: [],
          completedNodes: ['create_workspace', 'investigate'],
          cost: { actual: 0.47, estimated: 0.47 },
          startedAt: new Date('2026-05-01T00:00:00Z'),
          meta: { origin: 'chat', requestText: 'Fix approval rejection' },
        },
      ],
      workflows: [
        {
          _id: workflowId,
          parsed: {
            nodes: {
              create_workspace: { type: 'code' },
              investigate: { type: 'agent', agent: 'bug-investigator' },
              implementation_approval_human: { type: 'human' },
              implement: { type: 'agent', agent: 'engineering-lead' },
            },
          },
        },
      ],
      execution_traces: [
        {
          executionId: 'wf-human-1',
          node: 'create_workspace',
          status: 'completed',
          attempt: 1,
          type: 'code',
          startedAt: new Date('2026-05-01T00:00:00Z'),
          completedAt: new Date('2026-05-01T00:00:04Z'),
          durationMs: 4000,
          output: {},
        },
        {
          executionId: 'wf-human-1',
          node: 'investigate',
          status: 'completed',
          attempt: 1,
          type: 'agent',
          agent: 'bug-investigator',
          startedAt: new Date('2026-05-01T00:00:05Z'),
          completedAt: new Date('2026-05-01T00:01:40Z'),
          durationMs: 95_000,
          output: {},
        },
      ],
      workflow_interventions: [
        {
          intervention_id: 'INT-reject1',
          workflow_run_id: 'wf-human-1',
          workflow_name: 'bug-fix-by-severity',
          stage: 'implementation_approval_human',
          kind: 'review',
          widget: 'approval_gate',
          severity: 'approval',
          title: 'Approve bug fix scope',
          context_summary: 'Review diagnosis',
          question: 'Approve or reject?',
          fields: [{ name: 'decision', type: 'select', options: ['approve', 'request_changes', 'reject'] }],
          options: [],
          docs: [],
          status: 'answered',
          response: { decision: 'reject' },
          created_at: new Date('2026-05-01T00:01:41Z'),
          answered_at: new Date('2026-05-01T00:01:45Z'),
        },
      ],
      execution_logs: [],
      workspaces: [],
      workflow_interventions_unused: [],
      ticket_assignments: [],
      pull_requests: [],
      artifacts: [],
      agent_activity: [],
    });

    const context = await new ExecutionService(db).getContext('wf-human-1');
    const traces = await new ExecutionService(db).getTraces('wf-human-1');

    expect(context.workflowSteps.map(step => [step.name, step.status])).toEqual([
      ['create_workspace', 'completed'],
      ['investigate', 'completed'],
      ['implementation_approval_human', 'completed'],
      ['implement', 'pending'],
    ]);
    expect(traces.map(trace => trace.node)).toContain('implementation_approval_human');
    expect(traces.find(trace => trace.node === 'implementation_approval_human')).toMatchObject({
      status: 'completed',
      type: 'human',
      synthetic: true,
      output: { decision: 'reject' },
    });
  });

  it('normalizes direct agent executions with persisted activity', async () => {
    const db = makeDb({
      executions: [
        {
          id: 'agent-2',
          workflowName: 'chat:spawn_agent/backend-developer',
          source: 'chat',
          status: 'running',
          input: { agent_name: 'backend-developer', prompt: 'Investigate API bug' },
          state: {},
          currentNodes: ['backend-developer'],
          completedNodes: [],
          cost: { actual: null, estimated: 0 },
          startedAt: new Date('2026-05-01T00:00:00Z'),
          meta: { origin: 'chat', requestText: 'Investigate API bug' },
        },
      ],
      execution_traces: [],
      execution_logs: [],
      agent_activity: [
        { refId: 'agent-2', scope: 'execution', agent: 'backend-developer', type: 'tool_call', tool: 'Read', content: 'Read server routes', timestamp: new Date('2026-05-01T00:01:00Z') },
      ],
      workflow_interventions: [],
      workspaces: [],
      ticket_assignments: [],
      pull_requests: [],
      artifacts: [],
    });

    const context = await new ExecutionService(db).getContext('agent-2');

    expect(context.runType).toBe('agent');
    expect(context.progress).toMatchObject({ completed: 0, total: 1, percent: 0, phase: 'inspecting' });
    expect(context.recentActivity[0]).toMatchObject({ source: 'agent_activity', agent: 'backend-developer', tool: 'Read' });
  });

  it('extracts PR context from an agent trace response when no PR row exists', async () => {
    const db = makeDb({
      executions: [
        {
          id: 'agent-pr-1',
          workflowName: 'chat:spawn_agent/backend-developer',
          source: 'chat',
          status: 'completed',
          input: { agent_name: 'backend-developer', prompt: 'Fix and raise a PR' },
          state: {},
          currentNodes: [],
          completedNodes: ['backend-developer'],
          cost: { actual: 1.25, estimated: 1.25 },
          startedAt: new Date('2026-05-01T00:00:00Z'),
          completedAt: new Date('2026-05-01T00:10:00Z'),
          meta: { origin: 'chat', requestText: 'Fix and raise a PR' },
        },
      ],
      execution_traces: [
        {
          executionId: 'agent-pr-1',
          node: 'backend-developer',
          status: 'completed',
          rawResponse: 'Done. Opened PR: https://github.com/acme/allen/pull/77',
          completedAt: new Date('2026-05-01T00:09:00Z'),
        },
      ],
      execution_logs: [],
      agent_activity: [],
      workflow_interventions: [],
      workspaces: [],
      ticket_assignments: [],
      pull_requests: [],
      artifacts: [],
    });

    const context = await new ExecutionService(db).getContext('agent-pr-1');

    expect(context.pullRequest).toMatchObject({
      number: 77,
      url: 'https://github.com/acme/allen/pull/77',
      status: 'open',
    });
  });

  it('normalizes Linear, workspace, and PR context for dispatched runs', async () => {
    const workspaceId = new ObjectId();
    const db = makeDb({
      executions: [
        {
          id: 'linear-1',
          workflowName: 'bug-fix-by-severity',
          status: 'completed',
          input: { linear_issue_id: 'issue-1', linear_identifier: 'ENG-1453', linear_url: 'https://linear.app/acme/issue/ENG-1453/fix-login' },
          state: {},
          currentNodes: [],
          completedNodes: ['investigate', 'fix'],
          cost: { actual: 1, estimated: 1 },
          startedAt: new Date('2026-05-01T00:00:00Z'),
          completedAt: new Date('2026-05-01T00:10:00Z'),
          meta: { linearTitle: 'Fix login', workspaceId: String(workspaceId) },
        },
      ],
      execution_traces: [],
      execution_logs: [],
      workflow_interventions: [],
      workspaces: [
        { _id: workspaceId, name: 'eng-1453', status: 'active', repoName: 'allen', branch: 'linear/eng-1453', baseBranch: 'main', worktreePath: '/tmp/allen/eng-1453' },
      ],
      ticket_assignments: [
        { executionId: 'linear-1', linearIssueId: 'issue-1', status: 'completed', targetKind: 'workflow', targetName: 'bug-fix-by-severity' },
      ],
      pull_requests: [
        { originatingExecutionId: 'linear-1', number: 598, title: 'Fix login', url: 'https://github.com/acme/allen/pull/598', status: 'open', branch: 'linear/eng-1453', baseBranch: 'main', updatedAt: new Date('2026-05-01T00:09:00Z') },
      ],
      artifacts: [],
      agent_activity: [],
    });

    const context = await new ExecutionService(db).getContext('linear-1');

    expect(context.origin).toBe('linear');
    expect(context.title).toBe('Fix login');
    expect(context.linear).toMatchObject({ issueId: 'issue-1', identifier: 'ENG-1453', url: 'https://linear.app/acme/issue/ENG-1453/fix-login' });
    expect(context.workspace).toMatchObject({ id: String(workspaceId), branch: 'linear/eng-1453' });
    expect(context.pullRequest).toMatchObject({ number: 598, url: 'https://github.com/acme/allen/pull/598' });
    expect(context.progress.phase).toBe('completed');
  });
});
