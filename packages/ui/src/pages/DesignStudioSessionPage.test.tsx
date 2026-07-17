import { forwardRef } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import DesignStudioSessionPage from './DesignStudioSessionPage';

const mocks = vi.hoisted(() => ({
  providers: vi.fn(),
  switchSession: vi.fn(),
  chatState: {
    sessions: [] as any[],
    activeSessionId: null as string | null,
  },
  composerSelections: [] as Array<{ provider?: string; model?: string }>,
}));

vi.mock('../hooks/useChat', () => ({
  useChat: () => ({
    sessions: mocks.chatState.sessions,
    activeSessionId: mocks.chatState.activeSessionId,
    messages: [],
    streaming: false,
    streamText: '',
    thinkingText: '',
    activeToolCalls: [],
    agentReports: [],
    spawnedAgents: [],
    pendingUserQuestion: null,
    answerUserQuestion: vi.fn(),
    answerWorkflowIntervention: vi.fn(),
    loadingMessages: false,
    sendMessage: vi.fn(),
    createSession: vi.fn(),
    switchSession: mocks.switchSession,
    cancelStream: vi.fn(),
    restoredDraft: null,
    clearRestoredDraft: vi.fn(),
    watchers: [],
    refresh: vi.fn(),
    refreshActiveSession: vi.fn(),
  }),
}));

vi.mock('../services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/api')>();
  return {
    ...actual,
    chat: {
      ...actual.chat,
      providers: mocks.providers,
      slashCommands: vi.fn().mockResolvedValue([]),
      getQueue: vi.fn().mockResolvedValue([]),
    },
    mcp: { ...actual.mcp, list: vi.fn().mockResolvedValue([]) },
    agents: { ...actual.agents, list: vi.fn().mockResolvedValue([]) },
    repos: { ...actual.repos, list: vi.fn().mockResolvedValue([]) },
    skills: { ...actual.skills, list: vi.fn().mockResolvedValue([]) },
  };
});

vi.mock('../components/chat/ChatInput', () => ({
  default: forwardRef(function MockChatInput(props: any, _ref) {
    mocks.composerSelections.push({
      provider: props.selectedProvider,
      model: props.selectedModel,
    });
    return (
      <div
        data-testid="composer-selection"
        data-provider={props.selectedProvider ?? ''}
        data-model={props.selectedModel ?? ''}
      />
    );
  }),
}));

vi.mock('../components/chat/ChatMessageList', () => ({
  default: () => null,
}));

vi.mock('../components/design-studio/WorkspaceFilesPanel', () => ({
  default: () => null,
}));

vi.mock('../components/workspace/XTerminal', () => ({
  XTerminal: () => null,
}));

const codexDefault = {
  provider: 'codex',
  label: 'Codex',
  models: ['gpt-5.6-sol'],
  defaultModel: 'gpt-5.6-sol',
  authStatus: 'logged_in',
};

const claudeDefault = {
  provider: 'claude',
  label: 'Claude',
  models: ['claude-sonnet-5', 'claude-opus-4-8'],
  defaultModel: 'claude-sonnet-5',
  authStatus: 'logged_in',
};

function renderPage(entry = '/studio/sessions?ws=w1') {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/studio/sessions" element={<DesignStudioSessionPage />} />
        <Route path="/studio/sessions/:sessionId" element={<DesignStudioSessionPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

async function expectComposerSelection(provider: string, model: string) {
  await waitFor(() => {
    const composer = screen.getByTestId('composer-selection');
    expect(composer).toHaveAttribute('data-provider', provider);
    expect(composer).toHaveAttribute('data-model', model);
  });
}

describe('DesignStudioSessionPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.chatState.sessions = [];
    mocks.chatState.activeSessionId = null;
    mocks.composerSelections.length = 0;
  });

  it.each([
    ['Codex', [codexDefault, claudeDefault], 'codex', 'gpt-5.6-sol'],
    ['Claude', [claudeDefault, codexDefault], 'claude', 'claude-sonnet-5'],
  ])('uses the configured %s default for a blank composer', async (_label, providers, provider, model) => {
    mocks.providers.mockResolvedValue(providers);

    renderPage();

    await expectComposerSelection(provider, model);
    expect(mocks.composerSelections).not.toContainEqual({
      provider: 'claude',
      model: 'claude-opus-4-8',
    });
  });

  it('shows persisted session values without presenting a known-wrong Opus value during hydration', async () => {
    mocks.providers.mockResolvedValue([codexDefault, claudeDefault]);
    const view = renderPage('/studio/sessions/session-1?ws=w1');

    await expectComposerSelection('codex', 'gpt-5.6-sol');

    mocks.chatState.sessions = [{
      _id: 'session-1',
      title: 'Existing design',
      status: 'active',
      messageCount: 1,
      lastMessageAt: '2026-07-17T00:00:00.000Z',
      totalCostUsd: 0,
      provider: 'codex',
      model: 'gpt-5.3-codex',
    }];
    mocks.chatState.activeSessionId = 'session-1';
    view.rerender(
      <MemoryRouter initialEntries={['/studio/sessions/session-1?ws=w1']}>
        <Routes>
          <Route path="/studio/sessions/:sessionId" element={<DesignStudioSessionPage />} />
        </Routes>
      </MemoryRouter>,
    );

    await expectComposerSelection('codex', 'gpt-5.3-codex');
    expect(mocks.composerSelections).not.toContainEqual({
      provider: 'claude',
      model: 'claude-opus-4-8',
    });
  });
});
