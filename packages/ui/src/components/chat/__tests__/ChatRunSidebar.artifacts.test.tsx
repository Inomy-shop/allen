import React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ArtifactDoc } from '../../../services/api';
import type { SpawnedAgent } from '../../../hooks/useChat';

const { artifact, listArtifacts } = vi.hoisted(() => ({
  artifact: {
    artifactId: 'artifact-chat-1',
    rootType: 'chat' as const,
    rootId: 'chat-1',
    spawnContext: { originType: 'system' as const },
    filename: 'assistant-plan.md',
    relativePath: 'assistant-plan.md',
    contentType: 'markdown' as const,
    sizeBytes: 42,
    createdAt: '2026-07-06T00:00:00.000Z',
  },
  listArtifacts: vi.fn(),
}));

vi.mock('../../../services/api', () => ({
  artifacts: {
    list: listArtifacts,
    get: vi.fn().mockResolvedValue(artifact),
    contentUrl: vi.fn((id: string) => `/api/artifacts/${id}/content`),
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
  default: ({ artifact: doc }: { artifact: ArtifactDoc }) => <div data-testid="artifact-viewer">{doc.filename}</div>,
}));

vi.mock('../../workspace/XTerminal', () => ({
  XTerminal: () => <div data-testid="x-terminal" />,
}));

import ChatRunSidebar from '../ChatRunSidebar';

describe('ChatRunSidebar artifacts', () => {
  beforeEach(() => {
    listArtifacts.mockResolvedValue([artifact]);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('shows direct chat artifacts even when no agent or workflow run is linked', async () => {
    render(
      <MemoryRouter>
        <ChatRunSidebar
          runs={[]}
          rootType="chat"
          rootId="chat-1"
          open
          activeTab="documents"
          onTabChange={vi.fn()}
          onClose={vi.fn()}
          artifactRefreshKey="initial"
        />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(listArtifacts).toHaveBeenCalledWith({ rootType: 'chat', rootId: 'chat-1', limit: 50 });
    });
    expect(await screen.findByText('assistant-plan.md')).toBeInTheDocument();
  });

  it('clears artifacts from the previous chat while the next chat is loading', async () => {
    const nextArtifact = {
      ...artifact,
      artifactId: 'artifact-chat-2',
      rootId: 'chat-2',
      filename: 'next-chat-plan.md',
      relativePath: 'next-chat-plan.md',
    };
    let resolveNext: ((items: typeof artifact[]) => void) | undefined;
    listArtifacts.mockImplementation(({ rootId }: { rootId: string }) => (
      rootId === 'chat-1'
        ? Promise.resolve([artifact])
        : new Promise<typeof artifact[]>(resolve => { resolveNext = resolve; })
    ));

    const renderSidebar = (rootId: string) => (
      <MemoryRouter>
        <ChatRunSidebar
          runs={[]}
          rootType="chat"
          rootId={rootId}
          open
          activeTab="documents"
          onTabChange={vi.fn()}
          onClose={vi.fn()}
        />
      </MemoryRouter>
    );

    const view = render(renderSidebar('chat-1'));
    expect(await screen.findByText('assistant-plan.md')).toBeInTheDocument();

    view.rerender(renderSidebar('chat-2'));
    await waitFor(() => expect(screen.queryByText('assistant-plan.md')).not.toBeInTheDocument());

    resolveNext?.([nextArtifact]);
    expect(await screen.findByText('next-chat-plan.md')).toBeInTheDocument();
  });

  it('never queries or renders execution artifacts owned by another chat', async () => {
    const previousRun: SpawnedAgent = {
      executionId: 'old-execution',
      chatSessionId: 'chat-old',
      agent: 'old-agent',
      prompt: 'old task',
      status: 'completed',
      activity: [],
      kind: 'agent',
    };
    listArtifacts.mockImplementation(({ rootType }: { rootType: string }) => (
      rootType === 'chat' ? Promise.resolve([]) : Promise.resolve([artifact])
    ));

    render(
      <MemoryRouter>
        <ChatRunSidebar
          runs={[previousRun]}
          rootType="chat"
          rootId="chat-new"
          open
          activeTab="documents"
          onTabChange={vi.fn()}
          onClose={vi.fn()}
        />
      </MemoryRouter>,
    );

    expect(await screen.findByText('No documents saved yet.')).toBeInTheDocument();
    expect(listArtifacts).toHaveBeenCalledWith({ rootType: 'chat', rootId: 'chat-new', limit: 50 });
    expect(listArtifacts).not.toHaveBeenCalledWith({ rootType: 'agent', rootId: 'old-execution', limit: 50 });
    expect(screen.queryByText('assistant-plan.md')).not.toBeInTheDocument();
  });

  it('keeps a new unsent chat blank even if runs from a sibling chat are still in memory', async () => {
    const previousRun: SpawnedAgent = {
      executionId: 'old-execution',
      chatSessionId: 'chat-old',
      agent: 'old-agent',
      prompt: 'old task',
      status: 'completed',
      activity: [],
      artifacts: [{
        artifactId: 'old-runtime-artifact',
        filename: 'old-chat-plan.md',
        relativePath: 'old-chat-plan.md',
        contentType: 'markdown',
      }],
      kind: 'agent',
    };

    render(
      <MemoryRouter>
        <ChatRunSidebar
          runs={[previousRun]}
          rootType="chat"
          rootId={null}
          open
          activeTab="documents"
          onTabChange={vi.fn()}
          onClose={vi.fn()}
        />
      </MemoryRouter>,
    );

    expect(await screen.findByText('No documents saved yet.')).toBeInTheDocument();
    expect(listArtifacts).not.toHaveBeenCalled();
    expect(screen.queryByText('old-chat-plan.md')).not.toBeInTheDocument();
  });

  it('includes execution artifacts explicitly owned by the active chat', async () => {
    const currentRun: SpawnedAgent = {
      executionId: 'current-execution',
      chatSessionId: 'chat-1',
      agent: 'current-agent',
      prompt: 'current task',
      status: 'completed',
      activity: [],
      kind: 'agent',
    };
    const executionArtifact = {
      ...artifact,
      artifactId: 'artifact-current-execution',
      rootType: 'agent' as const,
      rootId: 'current-execution',
      filename: 'current-agent-plan.md',
      relativePath: 'current-agent-plan.md',
    };
    listArtifacts.mockImplementation(({ rootType }: { rootType: string }) => (
      rootType === 'chat' ? Promise.resolve([]) : Promise.resolve([executionArtifact])
    ));

    render(
      <MemoryRouter>
        <ChatRunSidebar
          runs={[currentRun]}
          rootType="chat"
          rootId="chat-1"
          open
          activeTab="documents"
          onTabChange={vi.fn()}
          onClose={vi.fn()}
        />
      </MemoryRouter>,
    );

    expect(await screen.findByText('current-agent-plan.md')).toBeInTheDocument();
    expect(listArtifacts).toHaveBeenCalledWith({ rootType: 'chat', rootId: 'chat-1', limit: 50 });
    expect(listArtifacts).toHaveBeenCalledWith({ rootType: 'agent', rootId: 'current-execution', limit: 50 });
  });
});
