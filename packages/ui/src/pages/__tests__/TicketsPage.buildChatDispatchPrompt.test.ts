import { describe, it, expect } from 'vitest';
import {
  buildChatDispatchPrompt,
  compactWorkflowInputForPrompt,
  type LinearIssue,
} from '../TicketsPage';
import type { DispatchTarget } from '../../components/linear/DispatchModal';

// ── Fixtures ─────────────────────────────────────────────────────────────────

function makeIssue(overrides: Partial<LinearIssue> = {}): LinearIssue {
  return {
    id: 'abc-internal-id-123',
    identifier: 'ENG-42',
    title: 'Fix the flaky login test',
    description: 'The test fails ~20% of the time due to race condition.',
    priority: 2,
    priorityLabel: 'High',
    state: { id: 'state-1', name: 'In Progress', type: 'started', color: '#f59e0b' },
    team: { id: 'team-1', name: 'Engineering', key: 'ENG' },
    project: { id: 'proj-1', name: 'Core Platform' },
    linearAssignee: { id: 'user-1', name: 'Alice', email: 'alice@example.com' },
    agentAssignee: null,
    labels: [
      { id: 'label-1', name: 'bug', color: '#ef4444' },
      { id: 'label-2', name: 'auth', color: '#8b5cf6' },
    ],
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-02T00:00:00Z',
    url: 'https://linear.app/org/issue/ENG-42',
    ...overrides,
  };
}

const BASE_ARGS = {
  target: null as DispatchTarget | null,
  repoId: '',
  repoName: undefined as string | undefined,
  repoPath: undefined as string | undefined,
  extraInstructions: '',
  promptTemplate: undefined as string | undefined,
  workflowInput: undefined as Record<string, unknown> | undefined,
};

// ── buildChatDispatchPrompt ───────────────────────────────────────────────────

describe('buildChatDispatchPrompt', () => {
  it('T1: contains ticket identifier and title', () => {
    const p = buildChatDispatchPrompt(makeIssue(), BASE_ARGS);
    expect(p).toContain('ENG-42');
    expect(p).toContain('Fix the flaky login test');
    // Combined on one line
    expect(p).toContain('ENG-42 · Fix the flaky login test');
  });

  it('T2: contains ticket URL', () => {
    const p = buildChatDispatchPrompt(makeIssue(), BASE_ARGS);
    expect(p).toContain('URL: https://linear.app/org/issue/ENG-42');
  });

  it('T3: contains status name', () => {
    const p = buildChatDispatchPrompt(makeIssue(), BASE_ARGS);
    expect(p).toContain('Status: In Progress');
  });

  it('T4: contains priority label when priority > 0', () => {
    const p = buildChatDispatchPrompt(makeIssue({ priority: 1, priorityLabel: 'Urgent' }), BASE_ARGS);
    expect(p).toContain('Priority: Urgent');
  });

  it('T5: omits Priority line when priorityLabel is empty', () => {
    const p = buildChatDispatchPrompt(makeIssue({ priority: 0, priorityLabel: '' }), BASE_ARGS);
    expect(p).not.toContain('Priority:');
  });

  it('T6: contains description', () => {
    const p = buildChatDispatchPrompt(makeIssue(), BASE_ARGS);
    expect(p).toContain('Description:');
    expect(p).toContain('The test fails ~20% of the time due to race condition.');
  });

  it('T7: shows (no description) when description is null', () => {
    const p = buildChatDispatchPrompt(makeIssue({ description: null }), BASE_ARGS);
    expect(p).toContain('(no description)');
  });

  it('T8: shows (no description) when description is empty string', () => {
    const p = buildChatDispatchPrompt(makeIssue({ description: '' }), BASE_ARGS);
    expect(p).toContain('(no description)');
  });

  it('T9: shows dispatch preference "auto" when no target selected', () => {
    const p = buildChatDispatchPrompt(makeIssue(), { ...BASE_ARGS, target: null });
    expect(p).toContain('Dispatch preference: auto');
  });

  it('T10: shows dispatch preference with agent name when agent target selected', () => {
    const target: DispatchTarget = { kind: 'agent', name: 'engineering-lead' };
    const p = buildChatDispatchPrompt(makeIssue(), { ...BASE_ARGS, target });
    expect(p).toContain('Dispatch preference: agent: engineering-lead');
  });

  it('T11: shows dispatch preference with workflow name when workflow target selected', () => {
    const target: DispatchTarget = { kind: 'workflow', workflowId: 'wf-1', workflowName: 'Feature Dev' };
    const p = buildChatDispatchPrompt(makeIssue(), { ...BASE_ARGS, target });
    expect(p).toContain('Dispatch preference: workflow: Feature Dev');
  });

  it('T12: shows dispatch preference for team-lead target', () => {
    const target: DispatchTarget = { kind: 'team-lead', teamName: 'engineering', agentName: 'eng-lead' };
    const p = buildChatDispatchPrompt(makeIssue(), { ...BASE_ARGS, target });
    expect(p).toContain('Dispatch preference: team lead: eng-lead (engineering)');
  });

  it('T13: includes Repo name when provided', () => {
    const p = buildChatDispatchPrompt(makeIssue(), { ...BASE_ARGS, repoName: 'allen-internal' });
    expect(p).toContain('Repo: allen-internal');
  });

  it('T14: omits Repo line when repoName is not provided', () => {
    const p = buildChatDispatchPrompt(makeIssue(), { ...BASE_ARGS, repoName: undefined });
    expect(p).not.toMatch(/^Repo:/m);
  });

  it('T15: includes extra instructions when provided', () => {
    const p = buildChatDispatchPrompt(makeIssue(), { ...BASE_ARGS, extraInstructions: 'Focus on the auth flow only.' });
    expect(p).toContain('Extra instructions: Focus on the auth flow only.');
  });

  it('T16: omits extra instructions line when empty', () => {
    const p = buildChatDispatchPrompt(makeIssue(), { ...BASE_ARGS, extraInstructions: '' });
    expect(p).not.toMatch(/Extra instructions/);
  });

  it('T17: includes target-specific prompt override block when promptTemplate provided', () => {
    const p = buildChatDispatchPrompt(makeIssue(), { ...BASE_ARGS, promptTemplate: 'Custom agent instructions here.' });
    expect(p).toContain('Target-specific prompt override:');
    expect(p).toContain('Custom agent instructions here.');
  });

  it('T18: omits target-specific prompt override block when no promptTemplate', () => {
    const p = buildChatDispatchPrompt(makeIssue(), { ...BASE_ARGS, promptTemplate: undefined });
    expect(p).not.toContain('Target-specific prompt override:');
  });

  it('T19: includes workflow input overrides when non-empty and non-duplicate', () => {
    const p = buildChatDispatchPrompt(makeIssue(), {
      ...BASE_ARGS,
      workflowInput: { branch: 'fix/login-race', dry_run: 'false' },
    });
    expect(p).toContain('Workflow input overrides:');
    expect(p).toContain('"branch"');
    expect(p).toContain('"fix/login-race"');
  });

  it('T20: omits workflow input overrides when input is undefined', () => {
    const p = buildChatDispatchPrompt(makeIssue(), { ...BASE_ARGS, workflowInput: undefined });
    expect(p).not.toContain('Workflow input overrides:');
  });

  it('T21: ends with the concise directive', () => {
    const p = buildChatDispatchPrompt(makeIssue(), BASE_ARGS);
    expect(p).toContain(
      'Please move the issue to In Progress if needed, route to the best workflow/lead/specialist, create or reuse a workspace for code changes, and keep progress visible here with links.',
    );
  });

  // ── Fields that must NOT appear ────────────────────────────────────────────

  it('T22: does NOT contain the raw Linear issue id', () => {
    const p = buildChatDispatchPrompt(makeIssue(), BASE_ARGS);
    // The raw internal id should never appear in the visible prompt
    expect(p).not.toContain('abc-internal-id-123');
  });

  it('T23: does NOT contain "Target kind"', () => {
    const target: DispatchTarget = { kind: 'agent', name: 'eng-lead' };
    const p = buildChatDispatchPrompt(makeIssue(), { ...BASE_ARGS, target });
    expect(p).not.toMatch(/Target kind/i);
  });

  it('T24: does NOT contain raw repo id', () => {
    const p = buildChatDispatchPrompt(makeIssue(), { ...BASE_ARGS, repoId: 'repo-id-xyz' });
    expect(p).not.toContain('repo-id-xyz');
  });

  it('T25: does NOT contain repo path', () => {
    const p = buildChatDispatchPrompt(makeIssue(), {
      ...BASE_ARGS,
      repoName: 'my-repo',
      repoPath: '/home/user/projects/my-repo',
    });
    expect(p).not.toContain('/home/user/projects/my-repo');
  });

  it('T26: does NOT contain numbered instruction steps', () => {
    const p = buildChatDispatchPrompt(makeIssue(), BASE_ARGS);
    // None of the 7 original numbered steps should be present
    expect(p).not.toMatch(/^\d+\.\s+(First update|Decide the best route|Use a matching workflow|If assigning|Otherwise use|Keep progress|If human)/m);
  });

  it('T27: prompt is significantly shorter than original (under 600 chars for typical input)', () => {
    const p = buildChatDispatchPrompt(makeIssue(), BASE_ARGS);
    // Original was ~800–1000 chars for typical input; new version should be much leaner
    expect(p.length).toBeLessThan(600);
  });
});

// ── compactWorkflowInputForPrompt ────────────────────────────────────────────

describe('compactWorkflowInputForPrompt', () => {
  const issue = makeIssue();

  it('returns undefined for undefined input', () => {
    expect(compactWorkflowInputForPrompt(issue, undefined)).toBeUndefined();
  });

  it('returns undefined for empty object', () => {
    expect(compactWorkflowInputForPrompt(issue, {})).toBeUndefined();
  });

  it('filters out values that duplicate the ticket title', () => {
    const result = compactWorkflowInputForPrompt(issue, { title: issue.title });
    expect(result).toBeUndefined();
  });

  it('filters out values that duplicate the ticket URL', () => {
    const result = compactWorkflowInputForPrompt(issue, { ticket_url: issue.url });
    expect(result).toBeUndefined();
  });

  it('keeps values that are genuinely different from ticket fields', () => {
    const result = compactWorkflowInputForPrompt(issue, {
      branch: 'fix/custom-branch',
      environment: 'staging',
    });
    expect(result).toEqual({ branch: 'fix/custom-branch', environment: 'staging' });
  });

  it('filters null/empty values', () => {
    const result = compactWorkflowInputForPrompt(issue, { key1: null, key2: '' });
    expect(result).toBeUndefined();
  });
});
