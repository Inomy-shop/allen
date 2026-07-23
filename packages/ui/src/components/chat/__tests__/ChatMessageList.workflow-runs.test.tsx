import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

if (typeof Element.prototype.scrollIntoView === 'undefined') {
  Element.prototype.scrollIntoView = () => {};
}

beforeAll(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

beforeEach(() => {
  Object.defineProperty(window, 'allenDesktop', { configurable: true, value: undefined });
});

vi.mock('../ChatRunSidebar', () => ({
  ExecutionsPanel: vi.fn(() => <div data-testid="executions-panel">Generic execution card</div>),
}));

vi.mock('../../../services/api', () => ({
  agents: { list: vi.fn().mockResolvedValue([]) },
  artifacts: { get: vi.fn(), contentUrl: vi.fn() },
}));

vi.mock('../../../services/workspaceService', () => ({
  chatCodeDiffs: { list: vi.fn().mockResolvedValue({ snapshots: [] }), capture: vi.fn() },
  pullRequests: { getDiffFile: vi.fn().mockResolvedValue(null) },
  workspaces: { getDiffFile: vi.fn().mockResolvedValue(null) },
}));

vi.mock('react-dom', async () => {
  const actual = await vi.importActual('react-dom');
  return { ...actual, createPortal: (node: React.ReactNode) => node };
});

import ChatMessageList from '../ChatMessageList';
import type { ChatMessage, SpawnedAgent } from '../../../hooks/useChat';

function CurrentPath() {
  return <output data-testid="current-path">{useLocation().pathname}</output>;
}

function workflowRun(): SpawnedAgent {
  return {
    executionId: 'workflow-execution-1',
    agent: 'bug-fix-by-severity',
    prompt: 'Fix the bug',
    status: 'waiting_for_input',
    kind: 'workflow',
    activity: [],
    runContext: {
      runType: 'workflow',
      title: 'bug-fix-by-severity',
      status: 'waiting_for_input',
      execution: { workflowName: 'bug-fix-by-severity' },
      progress: { completed: 2, total: 6, percent: 33, label: '2/6', currentStep: 'approve-fix-scope', phase: 'waiting_for_human' },
      humanInput: { required: true, stage: 'approve-fix-scope' },
      workflowSteps: [
        { id: 'classify', name: 'classify-severity', index: 0, status: 'completed', attempts: 1, durationMs: 48_000 },
        { id: 'investigate', name: 'investigate-root-cause', index: 1, status: 'completed', attempts: 1, durationMs: 360_000 },
        { id: 'approve', name: 'approve-fix-scope', index: 2, status: 'waiting_for_input', attempts: 0 },
        { id: 'implement', name: 'implement-fix', index: 3, status: 'pending', attempts: 0 },
        { id: 'validate', name: 'validate', index: 4, status: 'pending', attempts: 0 },
        { id: 'open-pr', name: 'open-pr', index: 5, status: 'pending', attempts: 0 },
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
    sourceMessageId: 'completed-message',
    status: 'completed',
    runContext: {
      ...run.runContext!,
      status: 'completed',
      execution: { ...run.runContext!.execution, status: 'completed' },
      progress: { completed: 2, total: 4, percent: 50, label: '2/4', currentStep: 'summary', phase: 'completed' },
      humanInput: { required: false },
      workflowSteps: [
        { id: 'investigate', name: 'investigate', index: 0, status: 'completed', attempts: 1 },
        { id: 'implement', name: 'implement', index: 1, status: 'completed', attempts: 1 },
        { id: 'review', name: 'review', index: 2, status: 'pending', attempts: 0 },
        { id: 'summary', name: 'summary', index: 3, status: 'pending', attempts: 0 },
      ],
    },
  };
}

describe('ChatMessageList workflow run presentation', () => {
  it('uses the compact flow renderer and opens executions in a new browser tab on web', () => {
    const { container } = render(
      <MemoryRouter>
        <ChatMessageList
          messages={[]}
          streamText=""
          streaming={false}
          spawnedAgents={[workflowRun()]}
        />
      </MemoryRouter>,
    );

    expect(screen.getByText('bug-fix-by-severity')).toBeInTheDocument();
    expect(screen.getByText('3/6 · waiting for you')).toBeInTheDocument();
    expect(screen.getByText('classify-severity')).toBeInTheDocument();
    expect(screen.getByText('approve-fix-scope')).toBeInTheDocument();
    expect(screen.getByText('open-pr')).toBeInTheDocument();
    const executionLink = screen.getByRole('link', { name: 'Open execution →' });
    expect(executionLink).toHaveAttribute('href', '/executions/workflow-execution-1');
    expect(executionLink).toHaveAttribute('target', '_blank');
    expect(executionLink).toHaveAttribute('rel', 'noopener noreferrer');
    expect(container.querySelector('.chat-workflow-run')).toHaveAttribute('open');
    expect(screen.queryByTestId('executions-panel')).not.toBeInTheDocument();
  });

  it('opens executions inside the current Allen window on desktop', () => {
    Object.defineProperty(window, 'allenDesktop', { configurable: true, value: {} });

    render(
      <MemoryRouter>
        <ChatMessageList
          messages={[]}
          streamText=""
          streaming={false}
          spawnedAgents={[workflowRun()]}
        />
        <CurrentPath />
      </MemoryRouter>,
    );

    const executionLink = screen.getByRole('link', { name: 'Open execution →' });
    expect(executionLink).toHaveAttribute('href', '/executions/workflow-execution-1');
    expect(executionLink).not.toHaveAttribute('target');
    fireEvent.click(executionLink);
    expect(screen.getByTestId('current-path')).toHaveTextContent('/executions/workflow-execution-1');
  });

  it('keeps non-workflow runs on the generic execution renderer', async () => {
    const agentRun: SpawnedAgent = {
      executionId: 'agent-execution-1',
      agent: 'frontend-engineer',
      prompt: 'Implement the UI',
      status: 'running',
      kind: 'agent',
      activity: [],
    };

    render(
      <MemoryRouter>
        <ChatMessageList
          messages={[]}
          streamText=""
          streaming={false}
          spawnedAgents={[agentRun]}
        />
      </MemoryRouter>,
    );

    expect(await screen.findByTestId('executions-panel')).toHaveTextContent('Generic execution card');
    expect(screen.queryByText('Open execution →')).not.toBeInTheDocument();
  });

  it('shows terminal pending steps as distinctly skipped and reports full progress', () => {
    const messages: ChatMessage[] = [{
      _id: 'completed-message',
      sessionId: 'chat-1',
      role: 'assistant',
      content: 'Workflow finished.',
      status: 'completed',
      createdAt: new Date().toISOString(),
    }];
    const { container } = render(
      <MemoryRouter>
        <ChatMessageList
          messages={messages}
          streamText=""
          streaming={false}
          spawnedAgents={[completedWorkflowRun()]}
        />
      </MemoryRouter>,
    );

    expect(screen.getByText('4/4 · completed')).toBeInTheDocument();
    expect(container.querySelectorAll('.chat-workflow-step-glyph.skipped')).toHaveLength(2);
    expect(screen.getAllByText('skipped')).toHaveLength(2);
  });
});
