import React from 'react';
import { cleanup, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SpawnedAgent } from '../../../hooks/useChat';

vi.mock('../../../services/api', () => ({
  artifacts: {
    list: vi.fn().mockResolvedValue([]),
    get: vi.fn(),
    contentUrl: vi.fn(),
  },
  repos: {
    get: vi.fn(),
    list: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock('../../../services/workspaceService', () => ({
  chatCodeDiffs: { list: vi.fn().mockResolvedValue({ snapshots: [] }), capture: vi.fn() },
  pullRequests: { getDiffFile: vi.fn().mockResolvedValue(null) },
  workspaces: {
    get: vi.fn().mockResolvedValue(null),
    listFiles: vi.fn().mockResolvedValue([]),
    getFile: vi.fn().mockResolvedValue(''),
    getDiffFile: vi.fn().mockResolvedValue(null),
  },
}));

vi.mock('../ChatMessageList', () => ({
  renderMarkdown: vi.fn((value: string) => value),
}));

vi.mock('../ChatContextPanel', () => ({
  default: () => <div data-testid="chat-context-panel" />,
}));

vi.mock('../../artifacts/ArtifactViewer', () => ({
  default: () => <div data-testid="artifact-viewer" />,
}));

vi.mock('../../workspace/XTerminal', () => ({
  XTerminal: () => <div data-testid="x-terminal" />,
}));

import ChatRunSidebar from '../ChatRunSidebar';

function workflowRun(): SpawnedAgent {
  return {
    executionId: 'workflow-execution-1',
    agent: 'feature-plan-and-implement',
    prompt: 'Implement the feature',
    status: 'running',
    kind: 'workflow',
    activity: [],
    runContext: {
      runType: 'workflow',
      title: 'feature-plan-and-implement',
      status: 'running',
      execution: { id: 'workflow-execution-1', workflowName: 'feature-plan-and-implement', status: 'running' },
      progress: { completed: 1, total: 4, percent: 25, label: '1/4', currentStep: 'implement', phase: 'running' },
      humanInput: { required: false },
      workflowSteps: [
        { id: 'workspace', name: 'create-workspace', index: 0, status: 'completed', attempts: 1 },
        { id: 'approval', name: 'approval', index: 1, status: 'skipped', attempts: 0 },
        { id: 'implement', name: 'implement', index: 2, status: 'running', attempts: 1 },
        { id: 'validate', name: 'validate', index: 3, status: 'pending', attempts: 0 },
      ],
      origin: 'chat',
      chat: null,
      io: null,
      linear: null,
      workspace: null,
      pullRequest: null,
      childAgents: [],
      interventions: [],
      artifacts: [],
      recentActivity: [],
    },
  };
}

function completedWorkflowRun(): SpawnedAgent {
  const run = workflowRun();
  return {
    ...run,
    status: 'completed',
    runContext: {
      ...run.runContext!,
      status: 'completed',
      execution: { ...run.runContext!.execution, status: 'completed' },
      progress: { completed: 9, total: 11, percent: 82, label: '9/11', currentStep: 'summary', phase: 'completed' },
      workflowSteps: [
        { id: 'workspace', name: 'create-workspace', index: 0, status: 'completed', attempts: 1 },
        { id: 'investigate', name: 'investigate', index: 1, status: 'completed', attempts: 1 },
        { id: 'classify', name: 'severity-classification-human', index: 2, status: 'pending', attempts: 0 },
        { id: 'approve', name: 'implementation-approval-human', index: 3, status: 'completed', attempts: 1 },
        { id: 'implement', name: 'implement', index: 4, status: 'completed', attempts: 1 },
        { id: 'qa', name: 'qa', index: 5, status: 'pending', attempts: 0 },
        { id: 'validate', name: 'implementation-validator', index: 6, status: 'pending', attempts: 0 },
        { id: 'review', name: 'code-review', index: 7, status: 'pending', attempts: 0 },
        { id: 'open-pr', name: 'open-pr', index: 8, status: 'completed', attempts: 1 },
        { id: 'escalate', name: 'escalation-review', index: 9, status: 'pending', attempts: 0 },
        { id: 'summary', name: 'summary', index: 10, status: 'pending', attempts: 0 },
      ],
    },
  };
}

describe('ChatRunSidebar task sequence', () => {
  afterEach(cleanup);

  it('renders connected timeline state hooks and clearly identifies the current workflow step', () => {
    const { container } = render(
      <MemoryRouter>
        <ChatRunSidebar
          runs={[workflowRun()]}
          rootType="chat"
          rootId="chat-1"
          open
          activeTab="tasks"
          onTabChange={vi.fn()}
          onClose={vi.fn()}
        />
      </MemoryRouter>,
    );

    const rows = Array.from(container.querySelectorAll<HTMLElement>('.chat-compact-task'));
    expect(rows).toHaveLength(4);
    expect(rows[0]).toHaveClass('completed');
    expect(rows[1]).toHaveClass('skipped');
    expect(rows[3]).toHaveClass('pending');

    const current = container.querySelector<HTMLElement>('.chat-compact-task[aria-current="step"]');
    expect(current).not.toBeNull();
    expect(current).toHaveAttribute('data-status', 'running');
    expect(within(current!).getByText('Implement')).toBeInTheDocument();
    expect(within(current!).getByText('running')).toBeInTheDocument();
    expect(screen.getByText('skipped')).toBeInTheDocument();
  });

  it('counts trailing skipped steps when a workflow completed and gives them a distinct icon', () => {
    const { container } = render(
      <MemoryRouter>
        <ChatRunSidebar
          runs={[completedWorkflowRun()]}
          rootType="chat"
          rootId="chat-1"
          open
          activeTab="executions"
          onTabChange={vi.fn()}
          onClose={vi.fn()}
        />
      </MemoryRouter>,
    );

    expect(screen.getByText('Completed · 11/11')).toBeInTheDocument();
    expect(container.querySelector<HTMLElement>('.chat-compact-progress i')).toHaveStyle({ width: '100%' });
    expect(container.querySelectorAll('.chat-compact-execution__step .skip')).toHaveLength(6);
    expect(screen.getAllByLabelText('Skipped')).toHaveLength(6);
  });
});
