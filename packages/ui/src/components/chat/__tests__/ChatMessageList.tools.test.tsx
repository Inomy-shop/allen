import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

if (typeof Element.prototype.scrollIntoView === 'undefined') {
  Element.prototype.scrollIntoView = () => {};
}

beforeAll(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

vi.mock('../ChatRunSidebar', () => ({
  ExecutionsPanel: vi.fn(() => <div data-testid="executions-panel" />),
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
import type { ChatMessage, ToolCallRecord } from '../../../hooks/useChat';
import { artifacts as artifactsApi, type ArtifactDoc } from '../../../services/api';
import { DEFAULT_RESOURCE_SCOPE, useDocumentTabStore } from '../../../stores/documentTabStore';

function toolMessage(toolCalls: ToolCallRecord[]): ChatMessage {
  return {
    _id: 'tool-message',
    sessionId: 'tool-session',
    role: 'assistant',
    content: 'Done.',
    status: 'completed',
    createdAt: '2026-07-21T00:00:00.000Z',
    toolCalls,
  };
}

function call(tool: string, args: Record<string, unknown>, result: Record<string, unknown>, description?: string): ToolCallRecord {
  return {
    tool,
    description,
    args,
    result,
    durationMs: 120,
    timestamp: '2026-07-21T00:00:00.000Z',
  };
}

describe('ChatMessageList tool activity presentation', () => {
  beforeEach(() => {
    useDocumentTabStore.setState({
      tabs: [],
      activeArtifactId: null,
      fileTabs: [],
      activeFileKey: null,
      activeScopeKey: DEFAULT_RESOURCE_SCOPE,
      selections: {},
    });
    vi.mocked(artifactsApi.get).mockReset();
    vi.mocked(artifactsApi.contentUrl).mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders file edits as an expanded inline diff', () => {
    render(
      <ChatMessageList
        messages={[toolMessage([
          call('edit_file', {
            file_path: 'services/payments/retry.ts',
            old_string: 'retry();',
            new_string: 'retry(idempotencyKey);',
          }, { status: 'updated' }),
        ])]}
        streamText=""
        streaming={false}
      />,
    );

    expect(screen.getByText('Edit File')).toBeInTheDocument();
    expect(screen.getByText('1 file · 1 tool')).toBeInTheDocument();
    expect(screen.getByText('Diff')).toBeInTheDocument();
    expect(screen.getByText('-retry();')).toBeInTheDocument();
    expect(screen.getByText('+retry(idempotencyKey);')).toBeInTheDocument();
  });

  it('renders captured Claude Write source as code instead of a success receipt', () => {
    const { container } = render(
      <ChatMessageList
        messages={[toolMessage([
          call('Write', {
            file_path: 'src/generated.ts',
            content: 'export function ready() {\n  return true;\n}\n',
          }, { raw: 'The file /workspace/src/generated.ts has been updated successfully.' }),
        ])]}
        streamText=""
        streaming={false}
      />,
    );

    expect(screen.getByText('Write File')).toBeInTheDocument();
    expect(screen.getAllByText('src/generated.ts')).toHaveLength(2);
    const diffLines = Array.from(
      container.querySelectorAll('.chat-diff-line code'),
      (node) => node.textContent,
    );
    expect(diffLines).toContain('+export function ready() {');
    expect(diffLines).toContain('+  return true;');
  });

  it('renders captured Codex fileChange records as a multi-file diff', () => {
    render(
      <ChatMessageList
        messages={[toolMessage([
          call('Edit', { files: [{ path: 'src/a.ts', status: 'update' }, { path: 'src/b.ts', status: 'add' }] }, {
            files: [
              { path: 'src/a.ts', diff: '--- a/src/a.ts\n+++ b/src/a.ts\n@@\n-old\n+new' },
              { path: 'src/b.ts', diff: '--- /dev/null\n+++ b/src/b.ts\n@@\n+export {};' },
            ],
            status: 'completed',
          }),
        ])]}
        streamText=""
        streaming={false}
      />,
    );

    expect(screen.getByText('Edit File')).toBeInTheDocument();
    expect(screen.getByText('2 files · 1 tool')).toBeInTheDocument();
    expect(screen.getByText('src/a.ts + 1 more')).toBeInTheDocument();
    expect(screen.getByText('src/a.ts', { selector: 'code' })).toBeInTheDocument();
    expect(screen.getByText('src/b.ts', { selector: 'code' })).toBeInTheDocument();
    expect(screen.getByText('-old')).toBeInTheDocument();
    expect(screen.getByText('+new')).toBeInTheDocument();
    expect(screen.getByText('+export {};')).toBeInTheDocument();
  });

  it('renders shell commands and their output as a terminal result', () => {
    const { container } = render(
      <ChatMessageList
        messages={[toolMessage([
          call('exec_command', { cmd: 'npm test' }, { stdout: '48 tests passed' }),
        ])]}
        streamText=""
        streaming={false}
      />,
    );

    expect(screen.getByText('Run Command')).toBeInTheDocument();
    fireEvent.click(screen.getByTitle('Expand tool result'));
    expect(container.querySelector('.chat-tool-command')).toHaveTextContent('$ npm test');
    expect(screen.getByText('48 tests passed')).toBeInTheDocument();
  });

  it('surfaces exact pull request and Linear URLs as icon links', () => {
    const prUrl = 'https://github.com/acme/payments/pull/418';
    const linearUrl = 'https://linear.app/acme/issue/INO-291/payment-retry-double-charge';
    render(
      <ChatMessageList
        messages={[toolMessage([
          call('create_pull_request', {}, { html_url: prUrl, title: 'Fix retry idempotency' }),
          call('linear_get_issue', {}, { url: linearUrl, identifier: 'INO-291', title: 'Payment retry double-charge' }),
        ])]}
        streamText=""
        streaming={false}
      />,
    );

    expect(screen.getByRole('link', { name: /PR #418/ })).toHaveAttribute('href', prUrl);
    expect(screen.getByRole('link', { name: /INO-291/ })).toHaveAttribute('href', linearUrl);
  });

  it('opens Allen artifacts in the shared in-app document viewer', async () => {
    const artifact: ArtifactDoc = {
      artifactId: 'artifact-1',
      rootType: 'chat',
      rootId: 'tool-session',
      spawnContext: { originType: 'chat' },
      filename: 'investigation.md',
      relativePath: 'investigation.md',
      contentType: 'markdown',
      sizeBytes: 42,
      createdAt: '2026-07-21T00:00:00.000Z',
    };
    vi.mocked(artifactsApi.get).mockResolvedValue(artifact);
    useDocumentTabStore.getState().setActiveScope('chat:tool-session');

    render(
      <ChatMessageList
        messages={[toolMessage([
          call('allen_get_artifact', {}, {
            artifactId: artifact.artifactId,
            filename: artifact.filename,
            publicUrl: `http://127.0.0.1:48120/api/artifacts/${artifact.artifactId}/content`,
          }),
        ])]}
        streamText=""
        streaming={false}
        resourceScopeKey="chat:tool-session"
      />,
    );

    fireEvent.click(screen.getByTitle('Open investigation.md in Allen'));

    await waitFor(() => {
      expect(useDocumentTabStore.getState().activeArtifactId).toBe(artifact.artifactId);
    });
    expect(screen.queryByRole('link', { name: /investigation\.md/i })).not.toBeInTheDocument();
  });

  it('suppresses Allen-owned navigation URLs from tool resource cards', () => {
    const onOpenInternalReference = vi.fn();

    render(
      <ChatMessageList
        messages={[toolMessage([
          call('allen_search_executions', {}, {
            title: 'bug-fix-by-severity',
            url: 'http://127.0.0.1:48120/executions/execution-1',
          }),
        ])]}
        streamText=""
        streaming={false}
        onOpenInternalReference={onOpenInternalReference}
      />,
    );

    expect(screen.queryByRole('button', { name: /bug-fix-by-severity/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /bug-fix-by-severity/i })).not.toBeInTheDocument();
    expect(onOpenInternalReference).not.toHaveBeenCalled();
  });

  it('removes markdown decoration and routes desktop workflow resources inside Allen', async () => {
    Object.defineProperty(window, 'allenDesktop', { configurable: true, value: {} });
    const onOpenInternalReference = vi.fn();
    vi.mocked(artifactsApi.get).mockImplementation(async (artifactId: string) => ({
      artifactId,
      rootType: 'workflow',
      rootId: 'execution-1',
      spawnContext: { originType: 'workflow' },
      filename: artifactId === 'investigation-1' ? 'Root Cause Investigation.md' : 'Implementation Plan.md',
      relativePath: artifactId === 'investigation-1' ? 'Root Cause Investigation.md' : 'Implementation Plan.md',
      contentType: 'markdown',
      sizeBytes: 42,
      createdAt: '2026-07-21T00:00:00.000Z',
    }));

    render(
      <ChatMessageList
        messages={[toolMessage([
          call('allen_monitoring_search_records', {}, {
            records: [{
              api_base_url: 'http://127.0.0.1:48120/**',
              investigation_artifact_url: 'http://127.0.0.1:48120/api/artifacts/investigation-1/content**',
              implementation_plan_artifact_url: 'http://127.0.0.1:48120/api/artifacts/plan-1/content**',
              workflow: {
                name: 'bug-fix-by-severity',
                url: 'http://127.0.0.1:48120/api/workflows/workflow-1**',
              },
            }],
          }),
        ])]}
        streamText=""
        streaming={false}
        onOpenInternalReference={onOpenInternalReference}
      />,
    );

    expect(await screen.findByRole('button', { name: /Root Cause Investigation\.md/i })).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /Implementation Plan\.md/i })).toBeInTheDocument();
    expect(screen.queryByText('Artifact')).not.toBeInTheDocument();
    expect(screen.queryByText('127.0.0.1')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /bug-fix-by-severity/i }));
    expect(onOpenInternalReference).toHaveBeenCalledWith('/workflows/workflow-1');
    expect(screen.queryByRole('link', { name: /bug-fix-by-severity/i })).not.toBeInTheDocument();
  });

  it('opens uploaded text files as in-app file tabs', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-type': 'text/markdown' }),
      text: vi.fn().mockResolvedValue('# Investigation'),
    }));

    render(
      <ChatMessageList
        messages={[toolMessage([
          call('upload_file', {}, {
            originalName: 'report.md',
            publicUrl: 'http://127.0.0.1:48120/api/files/701e22f9-report.md',
          }),
        ])]}
        streamText=""
        streaming={false}
        resourceScopeKey="chat:tool-session"
      />,
    );

    fireEvent.click(screen.getByTitle('Open report.md in Allen'));

    await waitFor(() => {
      expect(useDocumentTabStore.getState().fileTabs).toEqual([
        expect.objectContaining({
          path: 'report.md',
          content: '# Investigation',
          sourceKind: 'upload',
          sourceId: '701e22f9-report.md',
          scopeKey: 'chat:tool-session',
        }),
      ]);
    });
  });

  it('unwraps captured Claude raw results into command and line-numbered read views', () => {
    const { container } = render(
      <ChatMessageList
        messages={[toolMessage([
          call('Bash', {}, { raw: 'packages/ui/src/App.tsx\npackages/ui/src/main.tsx' }),
          call('Read', {}, { raw: '1\timport React from \'react\';\n2\texport default App;' }),
        ])]}
        streamText=""
        streaming={false}
      />,
    );

    expect(screen.getByText('Run Command')).toBeInTheDocument();
    expect(screen.getByText('Read File')).toBeInTheDocument();
    const expandButtons = screen.getAllByTitle('Expand tool result');
    fireEvent.click(expandButtons[0]!);
    fireEvent.click(expandButtons[1]!);
    expect(container.querySelector('.chat-tool-command-output')).toHaveTextContent('packages/ui/src/App.tsx');
    expect(container.querySelector('.chat-tool-command-output')).toHaveTextContent('packages/ui/src/main.tsx');
    expect(screen.getByText("import React from 'react';")).toBeInTheDocument();
    expect(container.textContent).not.toContain('"raw"');
  });

  it('renders legacy write receipts without exposing JSON and infers the file path', () => {
    const receipt = 'File created successfully at: /workspace/src/example.ts (128 bytes written)';
    const { container } = render(
      <ChatMessageList
        messages={[toolMessage([call('Write', {}, { raw: receipt })])]}
        streamText=""
        streaming={false}
      />,
    );

    expect(screen.getByText('Write File')).toBeInTheDocument();
    expect(screen.getByText('/workspace/src/example.ts')).toBeInTheDocument();
    fireEvent.click(screen.getByTitle('Expand tool result'));
    expect(screen.getByText(receipt)).toBeInTheDocument();
    expect(container.textContent).not.toContain('"raw"');
  });

  it('infers paths from Claude updated-file receipts', () => {
    const receipt = 'The file /workspace/src/updated.ts has been updated successfully. (file state is current in your context)';
    render(
      <ChatMessageList
        messages={[toolMessage([call('Edit', {}, { raw: receipt })])]}
        streamText=""
        streaming={false}
      />,
    );

    expect(screen.getByText('/workspace/src/updated.ts')).toBeInTheDocument();
  });

  it('uses stored provider descriptions when historical records have no arguments', () => {
    render(
      <ChatMessageList
        messages={[toolMessage([
          call('Read', {}, { raw: '1\tconst ready = true;' }, 'Read src/runtime.ts'),
        ])]}
        streamText=""
        streaming={false}
      />,
    );

    expect(screen.getByText('src/runtime.ts')).toBeInTheDocument();
  });
});
