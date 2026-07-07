import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ArtifactDoc } from '../../../services/api';

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
          activeTab="tasks"
          onTabChange={vi.fn()}
          onClose={vi.fn()}
          artifactRefreshKey="initial"
        />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(listArtifacts).toHaveBeenCalledWith({ rootType: 'chat', rootId: 'chat-1', limit: 50 });
      expect(screen.getByRole('button', { name: /artifacts/i })).toBeInTheDocument();
    });

    expect(screen.getByText('No task sequence is linked to this chat yet.')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /artifacts/i }));

    expect(await screen.findByText('assistant-plan.md')).toBeInTheDocument();
  });
});
