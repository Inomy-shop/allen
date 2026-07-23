import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

if (typeof Element.prototype.scrollIntoView === 'undefined') {
  Element.prototype.scrollIntoView = () => {};
}

vi.mock('../ChatRunSidebar', () => ({
  ExecutionsPanel: vi.fn(() => <div data-testid="executions-panel" />),
}));

vi.mock('../../../services/api', () => ({
  agents: { list: vi.fn(() => new Promise(() => {})) },
  artifacts: { get: vi.fn(), contentUrl: vi.fn((id: string) => `/api/artifacts/${id}/content`) },
}));

vi.mock('../../../services/workspaceService', () => ({
  chatCodeDiffs: { list: vi.fn().mockResolvedValue({ snapshots: [] }), capture: vi.fn() },
  pullRequests: { getDiffFile: vi.fn().mockResolvedValue(null) },
  workspaces: { getDiffFile: vi.fn().mockResolvedValue(null) },
}));

import ChatMessageList from '../ChatMessageList';
import type { ChatMessage } from '../../../hooks/useChat';
import { artifacts as artifactsApi } from '../../../services/api';
import { DEFAULT_RESOURCE_SCOPE, useDocumentTabStore } from '../../../stores/documentTabStore';
import { useMediaViewerStore } from '../../../stores/mediaViewerStore';

function assistantMessage(content: string): ChatMessage {
  return {
    _id: 'message-1',
    sessionId: 'session-1',
    role: 'assistant',
    content,
    status: 'completed',
    createdAt: new Date().toISOString(),
  };
}

describe('ChatMessageList resource links', () => {
  const openExternal = vi.fn().mockResolvedValue(true);

  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(window, 'allenDesktop', {
      configurable: true,
      value: { openExternal },
    });
    window.history.replaceState({}, '', '/chat/session-1');
    useMediaViewerStore.getState().closeMedia();
    useDocumentTabStore.setState({
      tabs: [],
      activeArtifactId: null,
      fileTabs: [],
      activeFileKey: null,
      activeScopeKey: DEFAULT_RESOURCE_SCOPE,
      selections: {},
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('opens general links through the external browser bridge', () => {
    render(<ChatMessageList messages={[assistantMessage('[Open docs](https://example.com/docs)')]} streamText="" streaming={false} />);
    fireEvent.click(screen.getByRole('link', { name: 'Open docs' }));
    expect(openExternal).toHaveBeenCalledWith('https://example.com/docs');
  });

  it('opens Allen chat references as chat tabs', () => {
    const onOpenChatReference = vi.fn();
    render(
      <ChatMessageList
        messages={[assistantMessage('[Related chat](/chat/session-2)')]}
        streamText=""
        streaming={false}
        onOpenChatReference={onOpenChatReference}
      />,
    );
    fireEvent.click(screen.getByRole('link', { name: 'Related chat' }));
    expect(onOpenChatReference).toHaveBeenCalledWith('session-2');
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('makes inline file references clickable', () => {
    const onOpenFileReference = vi.fn();
    render(
      <ChatMessageList
        messages={[assistantMessage('See `packages/ui/src/App.tsx:42`.')]}
        streamText=""
        streaming={false}
        onOpenFileReference={onOpenFileReference}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'packages/ui/src/App.tsx:42' }));
    expect(onOpenFileReference).toHaveBeenCalledWith('packages/ui/src/App.tsx');
  });

  it('opens uploaded chat files in an in-app file tab', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-type': 'text/markdown' }),
      text: vi.fn().mockResolvedValue('# Review'),
    }));
    useDocumentTabStore.getState().setActiveScope('chat:session-1');

    render(
      <ChatMessageList
        messages={[assistantMessage('[review.md](http://127.0.0.1:48120/api/files/file-1.md)')]}
        streamText=""
        streaming={false}
        resourceScopeKey="chat:session-1"
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'review.md' }));

    await waitFor(() => expect(useDocumentTabStore.getState().activeFileKey).not.toBeNull());
    expect(useDocumentTabStore.getState().fileTabs[0]).toEqual(expect.objectContaining({
      path: 'review.md',
      content: '# Review',
      sourceKind: 'upload',
    }));
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('routes Allen application links without leaving the app', () => {
    const onOpenInternalReference = vi.fn();
    render(
      <ChatMessageList
        messages={[assistantMessage('[Execution](http://127.0.0.1:48120/executions/execution-1)')]}
        streamText=""
        streaming={false}
        onOpenInternalReference={onOpenInternalReference}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Execution' }));
    expect(onOpenInternalReference).toHaveBeenCalledWith('/executions/execution-1');
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('routes image artifacts to the media viewer instead of a document tab', async () => {
    vi.mocked(artifactsApi.get).mockResolvedValue({
      artifactId: 'image-1',
      rootType: 'chat',
      rootId: 'session-1',
      spawnContext: { originType: 'chat' },
      filename: 'preview.png',
      relativePath: 'preview.png',
      contentType: 'binary',
      sizeBytes: 120,
      createdAt: new Date().toISOString(),
    });
    render(
      <ChatMessageList
        messages={[assistantMessage('[Preview](/api/artifacts/image-1/content)')]}
        streamText=""
        streaming={false}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    await waitFor(() => expect(useMediaViewerStore.getState().item?.title).toBe('preview.png'));
    expect(useMediaViewerStore.getState().item?.kind).toBe('image');
  });
});
