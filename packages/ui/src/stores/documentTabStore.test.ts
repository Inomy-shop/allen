import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_RESOURCE_SCOPE, fileTabKey, resourceScopeKey, useDocumentTabStore } from './documentTabStore';
import { useMediaViewerStore } from './mediaViewerStore';

const artifact = (artifactId: string, filename = `${artifactId}.md`) => ({
  artifactId,
  rootType: 'chat' as const,
  rootId: 'chat-1',
  spawnContext: { originType: 'chat' as const },
  filename,
  relativePath: filename,
  contentType: 'markdown' as const,
  sizeBytes: 12,
  createdAt: '2026-01-01T00:00:00.000Z',
});

describe('documentTabStore', () => {
  beforeEach(() => {
    useDocumentTabStore.getState().closeAllDocuments();
    useDocumentTabStore.getState().closeAllFiles();
    useDocumentTabStore.getState().setActiveScope(DEFAULT_RESOURCE_SCOPE);
    useMediaViewerStore.getState().closeMedia();
  });

  it('adds, activates, and reuses document tabs', () => {
    useDocumentTabStore.getState().openDocument(artifact('one'), { sourceLabel: 'Chat' });
    useDocumentTabStore.getState().openDocument(artifact('two'), { sourceLabel: 'Execution' });
    useDocumentTabStore.getState().openDocument(artifact('one', 'renamed.md'), { sourceLabel: 'Chat' });

    expect(useDocumentTabStore.getState().tabs).toHaveLength(2);
    expect(useDocumentTabStore.getState().activeArtifactId).toBe('one');
    expect(useDocumentTabStore.getState().tabs[0].artifact.filename).toBe('renamed.md');
  });

  it('activates the neighboring tab when the active tab closes', () => {
    useDocumentTabStore.getState().openDocument(artifact('one'));
    useDocumentTabStore.getState().openDocument(artifact('two'));
    useDocumentTabStore.getState().closeDocument('two');

    expect(useDocumentTabStore.getState().activeArtifactId).toBe('one');
    expect(useDocumentTabStore.getState().tabs.map(tab => tab.artifact.artifactId)).toEqual(['one']);
  });

  it('opens repository files as reusable tabs and switches between resource kinds', () => {
    useDocumentTabStore.getState().openDocument(artifact('one'));
    useDocumentTabStore.getState().openFile({
      path: 'packages/ui/src/App.tsx',
      content: 'export default App;',
      sourceKind: 'workspace',
      sourceId: 'workspace-1',
      sourceLabel: 'UI workspace',
    });

    expect(useDocumentTabStore.getState().fileTabs).toHaveLength(1);
    expect(useDocumentTabStore.getState().activeArtifactId).toBeNull();
    expect(useDocumentTabStore.getState().activeFileKey).toBe(fileTabKey({
      sourceKind: 'workspace',
      sourceId: 'workspace-1',
      path: 'packages/ui/src/App.tsx',
    }));

    useDocumentTabStore.getState().selectDocument('one');
    expect(useDocumentTabStore.getState().activeArtifactId).toBe('one');
    expect(useDocumentTabStore.getState().activeFileKey).toBeNull();
  });

  it('falls back to an open file when the active document closes', () => {
    useDocumentTabStore.getState().openFile({
      path: 'README.md',
      content: '# Allen',
      sourceKind: 'repo',
      sourceId: 'repo-1',
      sourceLabel: 'allen-internal',
    });
    useDocumentTabStore.getState().openDocument(artifact('one'));
    useDocumentTabStore.getState().closeDocument('one');

    expect(useDocumentTabStore.getState().activeFileKey).toBe(fileTabKey({
      sourceKind: 'repo',
      sourceId: 'repo-1',
      path: 'README.md',
    }));
  });

  it('isolates document tabs and restores selection per chat', () => {
    const chatOne = resourceScopeKey('chat', 'chat-1');
    const chatTwo = resourceScopeKey('chat', 'chat-2');

    useDocumentTabStore.getState().setActiveScope(chatOne);
    useDocumentTabStore.getState().openDocument(artifact('one'));

    useDocumentTabStore.getState().setActiveScope(chatTwo);
    expect(useDocumentTabStore.getState().activeArtifactId).toBeNull();
    expect(useDocumentTabStore.getState().tabs.filter(tab => tab.scopeKey === chatTwo)).toEqual([]);

    useDocumentTabStore.getState().openDocument(artifact('two'));
    expect(useDocumentTabStore.getState().activeArtifactId).toBe('two');

    useDocumentTabStore.getState().setActiveScope(chatOne);
    expect(useDocumentTabStore.getState().activeArtifactId).toBe('one');
    expect(useDocumentTabStore.getState().tabs.filter(tab => tab.scopeKey === chatOne).map(tab => tab.artifact.artifactId)).toEqual(['one']);
  });

  it('allows the same artifact to be opened independently in different chats', () => {
    const chatOne = resourceScopeKey('chat', 'chat-1');
    const chatTwo = resourceScopeKey('chat', 'chat-2');

    useDocumentTabStore.getState().openDocument(artifact('shared'), { scopeKey: chatOne });
    useDocumentTabStore.getState().openDocument(artifact('shared'), { scopeKey: chatTwo });

    expect(useDocumentTabStore.getState().tabs).toHaveLength(2);
    expect(useDocumentTabStore.getState().tabs.map(tab => tab.scopeKey)).toEqual([chatOne, chatTwo]);
  });

  it('does not reactivate a previous chat when its delayed document load completes', () => {
    const chatOne = resourceScopeKey('chat', 'chat-1');
    const chatTwo = resourceScopeKey('chat', 'chat-2');

    useDocumentTabStore.getState().setActiveScope(chatOne);
    useDocumentTabStore.getState().openDocument(artifact('one'));
    useDocumentTabStore.getState().setActiveScope(chatTwo);
    useDocumentTabStore.getState().openDocument(artifact('two'));

    // Simulates an artifact request started in chat one resolving after the
    // user has already switched to chat two.
    useDocumentTabStore.getState().openDocument(artifact('late'), { scopeKey: chatOne });

    expect(useDocumentTabStore.getState().activeScopeKey).toBe(chatTwo);
    expect(useDocumentTabStore.getState().activeArtifactId).toBe('two');
    expect(useDocumentTabStore.getState().selections[chatOne].activeArtifactId).toBe('late');
  });

  it('isolates file tabs by chat scope', () => {
    const chatOne = resourceScopeKey('chat', 'chat-1');
    const chatTwo = resourceScopeKey('chat', 'chat-2');
    const file = {
      path: 'README.md',
      content: '# Allen',
      sourceKind: 'repo' as const,
      sourceId: 'repo-1',
      sourceLabel: 'allen-internal',
    };

    useDocumentTabStore.getState().openFile({ ...file, scopeKey: chatOne });
    useDocumentTabStore.getState().openFile({ ...file, scopeKey: chatTwo });

    expect(useDocumentTabStore.getState().fileTabs).toHaveLength(2);
    expect(useDocumentTabStore.getState().fileTabs.map(tab => tab.key)).toEqual([
      fileTabKey(file, chatOne),
      fileTabKey(file, chatTwo),
    ]);
  });

  it('routes media artifacts to the dedicated viewer', () => {
    useDocumentTabStore.getState().openDocument(artifact('preview', 'preview.png'));

    expect(useDocumentTabStore.getState().tabs).toHaveLength(0);
    expect(useMediaViewerStore.getState().item).toMatchObject({ title: 'preview.png', kind: 'image' });
  });
});
