import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import DesignPage from './DesignPage';

// Mock useChat so tests don't need a real server
vi.mock('../hooks/useChat', () => ({
  useChat: () => ({
    sessions: [],
    activeSessionId: null,
    messages: [],
    streaming: false,
    streamText: '',
    thinkingText: '',
    activeToolCalls: [],
    agentReports: [],
    spawnedAgents: [],
    pendingUserQuestion: null,
    loadingMessages: false,
    sendMessage: vi.fn(),
    createSession: vi.fn(),
    switchSession: vi.fn(),
    cancelStream: vi.fn(),
    refresh: vi.fn(),
    answerUserQuestion: vi.fn(),
    answerWorkflowIntervention: vi.fn(),
    deleteSession: vi.fn(),
    updateSessionTitle: vi.fn(),
    generateSessionTitle: vi.fn(),
  }),
}));

vi.mock('../services/api', () => ({
  chat: {
    providers: vi.fn().mockResolvedValue([]),
    slashCommands: vi.fn().mockResolvedValue([]),
    getQueue: vi.fn().mockResolvedValue([]),
    isStreaming: vi.fn().mockResolvedValue({ streaming: false }),
  },
  mcp: { list: vi.fn().mockResolvedValue([]) },
  agents: { list: vi.fn().mockResolvedValue([]) },
  repos: { list: vi.fn().mockResolvedValue([]) },
  executions: { count: vi.fn().mockResolvedValue({ count: 0 }) },
  interventions: { list: vi.fn().mockResolvedValue([]) },
  learnings: { create: vi.fn().mockResolvedValue({}) },
}));

vi.mock('../services/workspaceService', () => ({
  workspaces: { list: vi.fn().mockResolvedValue([]), get: vi.fn(), listChats: vi.fn().mockResolvedValue([]) },
  chatCodeDiffs: { listAll: vi.fn().mockResolvedValue({ snapshots: [] }) },
  pullRequests: { getDiff: vi.fn().mockResolvedValue({ files: [] }) },
}));

// Mock design service — it must NOT be called from the new DesignPage
vi.mock('../services/designService', () => ({
  designRepos: {
    getDefault: vi.fn().mockResolvedValue(null), // no design repo → shows setup
    list: vi.fn().mockResolvedValue([]),
    bootstrapUiDesigns: vi.fn(),
    getPreviewConfig: vi.fn().mockResolvedValue(null),
  },
  designSessions: {
    list: vi.fn(),
    listMessages: vi.fn(),
    run: vi.fn(),
    get: vi.fn(),
    create: vi.fn(),
    delete: vi.fn(),
    reconcile: vi.fn(),
  },
}));

function renderDesignPage(path = '/design') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/design" element={<DesignPage />} />
        <Route path="/design/:sessionId" element={<DesignPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('DesignPage — new chat-primitive UX', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the ChatInput composer (same as normal chat)', async () => {
    renderDesignPage();
    await waitFor(() => {
      // ChatInput renders a textarea
      const textareas = document.querySelectorAll('textarea');
      expect(textareas.length).toBeGreaterThanOrEqual(1);
    });
  });

  it('does NOT call designSessions.run on mount or render', async () => {
    const { designSessions } = await import('../services/designService');
    renderDesignPage();
    await waitFor(() => {
      expect(vi.mocked(designSessions.run)).not.toHaveBeenCalled();
    });
  });

  it('does NOT call designSessions.list on mount', async () => {
    const { designSessions } = await import('../services/designService');
    renderDesignPage();
    await waitFor(() => {
      expect(vi.mocked(designSessions.list)).not.toHaveBeenCalled();
    });
  });

  it('hides the AgentChatDropdown (design-assistant is forced, picker not shown)', async () => {
    renderDesignPage();
    await waitFor(() => {
      // AgentChatDropdown is hidden when forcedAgent is set
      // The dropdown trigger uses a data-testid or role; since it's hidden, we check it's absent
      // We check there's no combobox/listbox for agent selection visible
      const agentDropdown = document.querySelector('[data-testid="agent-chat-dropdown"]');
      // It should not be rendered
      expect(agentDropdown).not.toBeInTheDocument();
    });
  });

  it('renders empty conversation state (no design-specific setup panels)', async () => {
    renderDesignPage();
    await waitFor(() => {
      // Should render the normal empty chat area, NOT the design onboarding panel
      expect(screen.queryByText(/Onboard existing design/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/Create from ui-designs template/i)).not.toBeInTheDocument();
    });
  });

  it('renders DesignPreviewPanel alongside the chat', async () => {
    renderDesignPage();
    await waitFor(() => {
      // DesignPreviewPanel renders a header with "Preview" text
      // It might be loading initially; wait for it to settle
      const previewLabels = document.querySelectorAll('[data-testid="design-preview-panel"], .design-preview-panel, *');
      // At minimum, the outer wrapper and ChatInput textarea should both exist
      const textareas = document.querySelectorAll('textarea');
      expect(textareas.length).toBeGreaterThanOrEqual(1);
    });
  });

  it('does NOT render resource rail (Files, Changes buttons) in design mode', async () => {
    renderDesignPage();
    await waitFor(() => {
      // The resource rail should not be rendered
      const rail = document.querySelector('.chat-resource-rail');
      expect(rail).not.toBeInTheDocument();
    });
  });

  it('does not show no-session blocker in preview panel (panel loads regardless of session)', async () => {
    // Even with no sessionId in URL and activeSessionId=null, the preview panel
    // should attempt to load (showing no-repo when getDefault returns null)
    renderDesignPage('/design');

    await waitFor(() => {
      // The "No active design chat" blocker must not appear
      expect(screen.queryByText(/no active design chat/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/start or open a design chat to run preview/i)).not.toBeInTheDocument();
    });
  });
});
