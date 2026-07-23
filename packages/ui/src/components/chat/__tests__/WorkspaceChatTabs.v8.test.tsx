import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import WorkspaceChatTabs from '../WorkspaceChatTabs';

beforeAll(() => {
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    disconnect() {}
  });
});

beforeEach(() => {
  Object.defineProperty(window, 'allenDesktop', { configurable: true, value: undefined });
});

describe('WorkspaceChatTabs V8', () => {
  it('keeps repository context, utility tabs, and readable actions in the workspace strip', () => {
    const onNewTab = vi.fn();
    const onNewTerminal = vi.fn();
    const onOpenCodeDiff = vi.fn();
    const onOpenFileExplorer = vi.fn();
    render(
      <WorkspaceChatTabs
        workspaceContext={{ repoName: 'allen-internal', branch: 'feature/document-management' }}
        tabs={[
          { id: { kind: 'session', sessionId: 'chat-1' }, title: 'Implement document management workflow', isTemp: false },
          { id: { kind: 'terminal', terminalId: 'term-1' }, title: 'Terminal 1', isTemp: false },
          { id: { kind: 'code-diff' }, title: 'Code diff', isTemp: false },
          { id: { kind: 'file-explorer' }, title: 'File explorer', isTemp: false },
          { id: { kind: 'servers' }, title: 'Servers', isTemp: false },
        ]}
        activeTabKey="chat-1"
        onSelect={vi.fn()}
        onClose={vi.fn()}
        onReorder={vi.fn()}
        onNewTab={onNewTab}
        onNewTerminal={onNewTerminal}
        onOpenCodeDiff={onOpenCodeDiff}
        onOpenFileExplorer={onOpenFileExplorer}
        availablePreviousChats={[{ _id: 'previous-1', title: 'Previous chat', lastMessageAt: '2026-07-01' }]}
        onRestore={vi.fn()}
      />,
    );

    expect(screen.getByText('allen-internal')).toBeInTheDocument();
    expect(screen.getByText('feature/document-management')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Implement document management workflow/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: /Terminal 1/ })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Code diff/ })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /File explorer/ })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Servers/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Add tab' }));
    expect(screen.getByRole('menuitem', { name: 'New chat' })).toBeVisible();
    expect(screen.getByRole('menuitem', { name: 'Terminal' })).toBeVisible();
    expect(screen.getByRole('menuitem', { name: 'Code diff' })).toBeVisible();
    expect(screen.getByRole('menuitem', { name: 'File explorer' })).toBeVisible();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Terminal' }));
    expect(onNewTerminal).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole('button', { name: 'Add tab' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Code diff' }));
    expect(onOpenCodeDiff).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole('button', { name: 'Add tab' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'File explorer' }));
    expect(onOpenFileExplorer).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole('button', { name: 'Add tab' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'New chat' }));
    expect(onNewTab).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: /Previous chats/ })).toBeVisible();
  });

  it('keeps document and file tabs in the workspace strip until explicitly closed', async () => {
    const onResourceSelect = vi.fn();
    const onResourceClose = vi.fn();
    const writeClipboardText = vi.fn().mockResolvedValue(true);
    Object.defineProperty(window, 'allenDesktop', {
      configurable: true,
      value: { writeClipboardText },
    });

    render(
      <WorkspaceChatTabs
        tabs={[
          { id: { kind: 'session', sessionId: 'chat-1' }, title: 'Workspace chat', isTemp: false },
          { id: { kind: 'terminal', terminalId: 'term-1' }, title: 'Terminal 1', isTemp: false },
        ]}
        resourceTabs={[
          { key: 'document:artifact-1', kind: 'document', title: 'plan.md', tooltip: 'plan.md · Chat', scopeKey: 'chat:chat-1', resourceId: 'artifact-1' },
          { key: 'file:file-1', kind: 'file', title: 'workflows.md', tooltip: 'docs/concepts/workflows.md · workspace', scopeKey: 'chat:chat-1', resourceId: 'file-1' },
        ]}
        activeTabKey="chat-1"
        activeResourceKey="file:file-1"
        onSelect={vi.fn()}
        onClose={vi.fn()}
        onResourceSelect={onResourceSelect}
        onResourceClose={onResourceClose}
        onReorder={vi.fn()}
        onNewTab={vi.fn()}
        availablePreviousChats={[]}
        onRestore={vi.fn()}
      />,
    );

    expect(screen.getByRole('tab', { name: /Workspace chat/ })).toHaveAttribute('aria-selected', 'false');
    expect(screen.getByRole('tab', { name: /workflows.md/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: /plan.md/ })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Terminal 1/ })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: /plan.md/ }));
    expect(onResourceSelect).toHaveBeenCalledWith('document:artifact-1');

    fireEvent.click(screen.getByRole('button', { name: 'Close workflows.md' }));
    expect(onResourceClose).toHaveBeenCalledWith('file:file-1');

    const chatTab = screen.getByRole('tab', { name: /Workspace chat/ });
    const copyButton = within(chatTab).getByRole('button', { name: 'Copy chat ID for Workspace chat' });
    const closeButton = within(chatTab).getByRole('button', { name: 'Close tab' });
    expect(copyButton.nextElementSibling).toBe(closeButton);
    fireEvent.click(copyButton);
    await waitFor(() => expect(writeClipboardText).toHaveBeenCalledWith('chat-1'));
  });
});
