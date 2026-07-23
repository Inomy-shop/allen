import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ChatDetailHeader from '../ChatDetailHeader';
import { resourceScopeKey, useDocumentTabStore } from '../../../stores/documentTabStore';

const artifact = (artifactId: string, filename: string) => ({
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

describe('ChatDetailHeader V8', () => {
  beforeEach(() => {
    useDocumentTabStore.getState().closeAllDocuments();
    useDocumentTabStore.getState().closeAllFiles();
    Object.defineProperty(window, 'allenDesktop', { configurable: true, value: undefined });
  });

  it('renders the prototype conversation view and a readable export action', () => {
    const onExport = vi.fn();
    render(<ChatDetailHeader title="Investigate payment retry double-charge" onExport={onExport} />);

    expect(screen.getByRole('tab', { name: 'Chat' })).toHaveAttribute('aria-selected', 'true');
    const exportButton = screen.getByRole('button', { name: 'Export chat' });
    expect(exportButton).toHaveTextContent('Export');
    fireEvent.click(exportButton);
    expect(onExport).toHaveBeenCalledOnce();
    expect(screen.queryByRole('button', { name: 'Add tab' })).not.toBeInTheDocument();
  });

  it('uses the canonical header markup for externally scoped workspace resources', () => {
    const onResourceSelect = vi.fn();
    const onResourceClose = vi.fn();
    render(
      <ChatDetailHeader
        activeChatId="chat-1"
        chatTabs={[{ id: 'chat-1', title: 'Workspace chat' }]}
        utilityTabs={[{ id: 'servers', title: 'Servers', kind: 'servers' }]}
        resourceTabs={[{ key: 'document:plan', kind: 'document', title: 'plan.md', tooltip: 'plan.md · Workspace chat' }]}
        activeResourceKey="document:plan"
        onResourceSelect={onResourceSelect}
        onResourceClose={onResourceClose}
      />,
    );

    expect(screen.getByRole('tab', { name: 'Workspace chat' })).toHaveAttribute('aria-selected', 'false');
    expect(screen.getByRole('tab', { name: 'plan.md' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Servers' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'plan.md' }));
    expect(onResourceSelect).toHaveBeenCalledWith('document:plan');
    fireEvent.click(screen.getByRole('button', { name: 'Close plan.md' }));
    expect(onResourceClose).toHaveBeenCalledWith('document:plan');
  });

  it('restores the add-tab action and creates a new chat from its menu', () => {
    const onNewChat = vi.fn();
    const onNewTerminal = vi.fn();
    const onOpenCodeDiff = vi.fn();
    const onOpenFileExplorer = vi.fn();
    render(
      <ChatDetailHeader
        activeChatId="chat-1"
        chatTabs={[{ id: 'chat-1', title: 'First chat' }]}
        onNewChat={onNewChat}
        onNewTerminal={onNewTerminal}
        onOpenCodeDiff={onOpenCodeDiff}
        onOpenFileExplorer={onOpenFileExplorer}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Add tab' }));
    expect(screen.getByRole('menuitem', { name: 'Terminal' })).toBeVisible();
    expect(screen.getByRole('menuitem', { name: 'Code diff' })).toBeVisible();
    expect(screen.getByRole('menuitem', { name: 'File explorer' })).toBeVisible();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Terminal' }));
    expect(onNewTerminal).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole('button', { name: 'Add tab' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Code diff' }));
    expect(onOpenCodeDiff).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole('button', { name: 'Add tab' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'New chat' }));

    expect(onNewChat).toHaveBeenCalledOnce();
    expect(screen.queryByRole('menu', { name: 'Add tab' })).not.toBeInTheDocument();
  });

  it('renders and activates a terminal tab independently from the chat tab', () => {
    const onTerminalSelect = vi.fn();
    const onTerminalClose = vi.fn();
    render(
      <ChatDetailHeader
        activeChatId="chat-1"
        chatTabs={[{ id: 'chat-1', title: 'First chat' }]}
        terminalTabs={[{ id: 'terminal-1', title: 'Terminal 1', sourceLabel: '~/.allen' }]}
        activeTerminalId="terminal-1"
        onTerminalSelect={onTerminalSelect}
        onTerminalClose={onTerminalClose}
      />,
    );

    expect(screen.getByRole('tab', { name: 'First chat' })).toHaveAttribute('aria-selected', 'false');
    const terminalTab = screen.getByRole('tab', { name: 'Terminal 1' });
    expect(terminalTab).toHaveAttribute('aria-selected', 'true');
    expect(terminalTab).toHaveAttribute('title', 'Terminal 1 · ~/.allen');
    fireEvent.click(terminalTab);
    expect(onTerminalSelect).toHaveBeenCalledWith('terminal-1');
    fireEvent.click(screen.getByRole('button', { name: 'Close Terminal 1' }));
    expect(onTerminalClose).toHaveBeenCalledWith('terminal-1');
  });

  it('renders code diff and file explorer as sibling tabs', () => {
    const onUtilitySelect = vi.fn();
    const onUtilityClose = vi.fn();
    render(
      <ChatDetailHeader
        activeChatId="chat-1"
        chatTabs={[{ id: 'chat-1', title: 'First chat' }]}
        utilityTabs={[
          { id: 'code-diff', title: 'Code diff', kind: 'code-diff' },
          { id: 'file-explorer', title: 'File explorer', kind: 'file-explorer' },
        ]}
        activeUtilityId="file-explorer"
        onUtilitySelect={onUtilitySelect}
        onUtilityClose={onUtilityClose}
      />,
    );

    expect(screen.getByRole('tab', { name: 'First chat' })).toHaveAttribute('aria-selected', 'false');
    expect(screen.getByRole('tab', { name: 'Code diff' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'File explorer' })).toHaveAttribute('aria-selected', 'true');
    fireEvent.click(screen.getByRole('tab', { name: 'Code diff' }));
    expect(onUtilitySelect).toHaveBeenCalledWith('code-diff');
    fireEvent.click(screen.getByRole('button', { name: 'Close File explorer' }));
    expect(onUtilityClose).toHaveBeenCalledWith('file-explorer');
  });

  it('renders newly created view tabs directly after the active tab order position', () => {
    render(
      <ChatDetailHeader
        activeChatId="chat-1"
        chatTabs={[
          { id: 'chat-1', title: 'First chat' },
          { id: 'chat-2', title: 'Second chat' },
        ]}
        terminalTabs={[{ id: 'terminal-1', title: 'Terminal 1', sourceLabel: '~/.allen' }]}
        utilityTabs={[{ id: 'file-explorer', title: 'File explorer', kind: 'file-explorer' }]}
        tabOrder={[
          'chat:chat-1',
          'utility:file-explorer',
          'terminal:terminal-1',
          'chat:chat-2',
        ]}
      />,
    );

    expect(screen.getAllByRole('tab').map(tab => tab.textContent)).toEqual([
      'First chat',
      'File explorer',
      'Terminal 1',
      'Second chat',
    ]);
  });

  it('copies a persisted chat ID from the tab action immediately before close', async () => {
    const writeClipboardText = vi.fn().mockResolvedValue(true);
    const onChatSelect = vi.fn();
    Object.defineProperty(window, 'allenDesktop', {
      configurable: true,
      value: { writeClipboardText },
    });

    render(
      <ChatDetailHeader
        activeChatId="chat-1"
        chatTabs={[
          { id: 'chat-1', title: 'First chat', isTemp: false },
          { id: 'temp-1', title: 'New chat', isTemp: true },
        ]}
        onChatSelect={onChatSelect}
        onChatClose={vi.fn()}
      />,
    );

    const firstTab = screen.getByRole('tab', { name: 'First chat' }).parentElement;
    expect(firstTab).not.toBeNull();
    const copyButton = within(firstTab!).getByRole('button', { name: 'Copy chat ID for First chat' });
    const closeButton = within(firstTab!).getByRole('button', { name: 'Close First chat' });
    expect(copyButton.nextElementSibling).toBe(closeButton);
    expect(screen.queryByRole('button', { name: 'Copy chat ID for New chat' })).not.toBeInTheDocument();

    fireEvent.click(copyButton);

    await waitFor(() => expect(writeClipboardText).toHaveBeenCalledWith('chat-1'));
    expect(onChatSelect).not.toHaveBeenCalled();
    expect(within(firstTab!).getByRole('button', { name: 'Chat ID copied for First chat' })).toBeInTheDocument();
  });

  it('shows only resource tabs owned by the active chat', () => {
    useDocumentTabStore.getState().openDocument(artifact('one', 'chat-one.md'), {
      scopeKey: resourceScopeKey('chat', 'chat-1'),
    });
    useDocumentTabStore.getState().openDocument(artifact('two', 'chat-two.md'), {
      scopeKey: resourceScopeKey('chat', 'chat-2'),
    });

    render(<ChatDetailHeader activeChatId="chat-1" chatTabs={[{ id: 'chat-1', title: 'First chat' }]} />);

    expect(screen.getByRole('tab', { name: 'chat-one.md' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'First chat' })).toHaveAttribute('aria-selected', 'false');
    expect(screen.queryByRole('tab', { name: 'chat-two.md' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: 'First chat' }));

    expect(screen.getByRole('tab', { name: 'First chat' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'chat-one.md' })).toHaveAttribute('aria-selected', 'false');
    expect(useDocumentTabStore.getState().tabs.map(tab => tab.artifact.artifactId)).toEqual(['one', 'two']);
  });
});
