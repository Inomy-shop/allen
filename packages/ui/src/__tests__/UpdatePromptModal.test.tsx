import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import App from '../App';

// ── Mock stores ──

vi.mock('../stores/settingsStore', () => {
  const state = { colorMode: 'dark', setColorMode: vi.fn() };
  return {
    useSettingsStore: (selector: (s: typeof state) => unknown) =>
      typeof selector === 'function' ? selector(state) : state,
  };
});

vi.mock('../stores/authStore', () => {
  const state = { user: null };
  return {
    useAuthStore: (selector: (s: typeof state) => unknown) =>
      typeof selector === 'function' ? selector(state) : state,
  };
});

// ── Mock API services ──

vi.mock('../services/api', () => ({
  chat: {
    getSession: vi.fn().mockResolvedValue(null),
    providers: vi.fn().mockResolvedValue([]),
    slashCommands: vi.fn().mockResolvedValue([]),
    getQueue: vi.fn().mockResolvedValue([]),
    isStreaming: vi.fn().mockResolvedValue({ streaming: false }),
  },
  executions: { count: vi.fn().mockResolvedValue({ count: 0 }) },
  interventions: { list: vi.fn().mockResolvedValue([]) },
  repos: { list: vi.fn().mockResolvedValue([]), get: vi.fn().mockResolvedValue(null) },
  learnings: { create: vi.fn().mockResolvedValue({}) },
  mcp: { list: vi.fn().mockResolvedValue([]) },
  agents: { list: vi.fn().mockResolvedValue([]) },
}));

vi.mock('../services/workspaceService', () => ({
  workspaces: {
    list: vi.fn().mockResolvedValue([]),
    get: vi.fn().mockResolvedValue(null),
    archive: vi.fn().mockResolvedValue({}),
  },
  chatCodeDiffs: { listAll: vi.fn().mockResolvedValue({ snapshots: [] }) },
  pullRequests: { getDiff: vi.fn().mockResolvedValue({ files: [] }) },
}));

// ── Mock UI dependencies that are heavy or cause side-effects ──

vi.mock('../hooks/usePanelLayout', () => ({
  usePanelLayout: () => ({
    size: 290,
    collapsed: false,
    toggle: vi.fn(),
    collapse: vi.fn(),
    expand: vi.fn(),
    onMouseDown: vi.fn(),
  }),
}));

vi.mock('../components/design/DesignNavPanel', () => ({
  default: () => null,
}));

// ── Helper: replicate the same formatBytes the component uses ──

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, i);
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

// ── Types matching the IPC payloads ──

interface UpdatePromptPayload {
  requestId: string;
  currentVersion: string;
  latestVersion: string;
  releaseNotes: Record<string, unknown> | null;
  releaseNotesError: string | null;
}

interface DownloadProgressPayload {
  requestId: string;
  percent: number | null;
  downloadedBytes: number;
  totalBytes: number | null;
  status: 'downloading';
}

interface DownloadErrorPayload {
  requestId: string;
  error: string;
  retryable: boolean;
}

interface DownloadCompletePayload {
  requestId: string;
  dmgPath: string;
}

// ── IPC handler capture ──

let updatePromptHandler: ((payload: UpdatePromptPayload) => void) | null = null;
let downloadProgressHandler: ((payload: DownloadProgressPayload) => void) | null = null;
let downloadErrorHandler: ((payload: DownloadErrorPayload) => void) | null = null;
let downloadCompleteHandler: ((payload: DownloadCompletePayload) => void) | null = null;

const RESPONSE_ID = 'test-req-1';

function makeMockAllenDesktop() {
  updatePromptHandler = null;
  downloadProgressHandler = null;
  downloadErrorHandler = null;
  downloadCompleteHandler = null;

  return {
    getRuntimeInfo: () =>
      Promise.resolve({
        mode: 'desktop',
        appVersion: '0.1.9',
        dataDir: '/tmp',
        serverUrl: 'http://127.0.0.1:48100',
        terminalWsUrl: null,
        mongoManaged: true,
        mongoDbPath: '/tmp/mongo',
        logsDir: '/tmp/logs',
      }),
    onUpdatePrompt: (handler: (payload: UpdatePromptPayload) => void) => {
      updatePromptHandler = handler;
      return () => {
        updatePromptHandler = null;
      };
    },
    onUpdateDownloadProgress: (handler: (payload: DownloadProgressPayload) => void) => {
      downloadProgressHandler = handler;
      return () => {
        downloadProgressHandler = null;
      };
    },
    onUpdateDownloadError: (handler: (payload: DownloadErrorPayload) => void) => {
      downloadErrorHandler = handler;
      return () => {
        downloadErrorHandler = null;
      };
    },
    onUpdateDownloadComplete: (handler: (payload: DownloadCompletePayload) => void) => {
      downloadCompleteHandler = handler;
      return () => {
        downloadCompleteHandler = null;
      };
    },
    respondToUpdatePrompt: vi.fn(),
    retryUpdateDownload: vi.fn(),
    cancelUpdateDownload: vi.fn(),
  };
}

// ── Fixtures ──

const mockReleaseNotes = {
  version: '0.2.0',
  title: 'Allen 0.2.0',
  summary: 'This release includes several improvements and bug fixes.',
  sections: [
    {
      title: 'New Features',
      items: ['Support for custom MCP servers', 'Enhanced workspace management'],
    },
    {
      title: 'Bug Fixes',
      items: ['Fixed auto-update triggering', 'Fixed memory leak in chat'],
    },
  ],
};

const promptPayload: UpdatePromptPayload = {
  requestId: RESPONSE_ID,
  currentVersion: '0.1.8',
  latestVersion: '0.2.0',
  releaseNotes: mockReleaseNotes as unknown as Record<string, unknown>,
  releaseNotesError: null,
};

// ── Helper: render App with router ──

function renderApp() {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route path="/" element={<App />}>
          <Route index element={<div data-testid="app-content" />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

// ── Helper: trigger the update prompt to open the modal ──

async function openUpdatePrompt(
  overrides: Partial<UpdatePromptPayload> = {},
): Promise<void> {
  // Ensure handler is registered (should be from the useEffect after render)
  await waitFor(() => {
    expect(updatePromptHandler).not.toBeNull();
  });

  act(() => {
    updatePromptHandler!({ ...promptPayload, ...overrides });
  });

  // Wait for the modal to render
  await waitFor(() => {
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
}

// ── Test suite ──

describe('UpdatePromptModal — driven via App IPC listeners', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.allenDesktop = makeMockAllenDesktop() as unknown as Window['allenDesktop'];
  });

  afterEach(() => {
    window.allenDesktop = undefined as unknown as Window['allenDesktop'];
  });

  // ── AC-001: Release notes display / graceful fallback ──

  describe('AC-001: Release notes display', () => {
    it('renders release notes sections with titles and items', async () => {
      renderApp();
      await openUpdatePrompt();

      // Release notes section titles
      expect(screen.getByText('New Features')).toBeInTheDocument();
      expect(screen.getByText('Bug Fixes')).toBeInTheDocument();

      // Release notes bullet items
      expect(
        screen.getByText('Support for custom MCP servers'),
      ).toBeInTheDocument();
      expect(
        screen.getByText('Enhanced workspace management'),
      ).toBeInTheDocument();
      expect(
        screen.getByText('Fixed auto-update triggering'),
      ).toBeInTheDocument();
      expect(
        screen.getByText('Fixed memory leak in chat'),
      ).toBeInTheDocument();

      // Summary text
      expect(
        screen.getByText(
          'This release includes several improvements and bug fixes.',
        ),
      ).toBeInTheDocument();
    });

    it('shows graceful fallback when release notes are unavailable', async () => {
      renderApp();
      await openUpdatePrompt({
        releaseNotes: null,
        releaseNotesError: 'failed',
      });

      // Fallback message
      expect(
        screen.getByText(/Release notes could not be loaded/i),
      ).toBeInTheDocument();

      // Buttons still work — "Update now" and "Update later" should be present
      expect(
        screen.getByRole('button', { name: /Update now/i }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: /Update later/i }),
      ).toBeInTheDocument();
    });
  });

  // ── AC-002: "Update now" → downloading state ──

  describe('AC-002: Update now transitions to downloading phase', () => {
    it('clicking "Update now" changes to downloading phase and modal stays open', async () => {
      renderApp();
      await openUpdatePrompt();

      // Click "Update now"
      const updateNowBtn = screen.getByRole('button', { name: /Update now/i });
      await act(async () => {
        updateNowBtn.click();
      });

      // Modal should still be in the DOM
      expect(screen.getByRole('dialog')).toBeInTheDocument();

      // Should show "Downloading update…" text
      expect(screen.getByText(/Downloading update…/i)).toBeInTheDocument();
    });

    it('calls respondToUpdatePrompt with "update-now" when button is clicked', async () => {
      renderApp();
      await openUpdatePrompt();

      const updateNowBtn = screen.getByRole('button', { name: /Update now/i });
      await act(async () => {
        updateNowBtn.click();
      });

      expect(
        window.allenDesktop?.respondToUpdatePrompt,
      ).toHaveBeenCalledWith(RESPONSE_ID, 'update-now');
    });

    it('shows a top-right cancel button while downloading and cancels the download', async () => {
      renderApp();
      await openUpdatePrompt();

      await act(async () => {
        screen.getByRole('button', { name: /Update now/i }).click();
      });

      const cancelButton = screen.getByRole('button', { name: /Cancel download/i });
      await act(async () => {
        cancelButton.click();
      });

      expect(window.allenDesktop?.cancelUpdateDownload).toHaveBeenCalledWith(RESPONSE_ID);
      expect(screen.queryByRole('dialog')).toBeNull();
    });
  });

  // ── AC-003: Download progress updates via IPC ──

  describe('AC-003: Download progress via IPC', () => {
    it('updates progress percentage when progress payloads arrive', async () => {
      renderApp();
      await openUpdatePrompt();

      // Click "Update now" to start the download phase
      await act(async () => {
        screen.getByRole('button', { name: /Update now/i }).click();
      });

      // Send first progress update
      await act(async () => {
        downloadProgressHandler!({
          requestId: RESPONSE_ID,
          percent: 33,
          downloadedBytes: 3_456_789,
          totalBytes: 10_000_000,
          status: 'downloading',
        });
      });

      await waitFor(() => {
        expect(screen.getByText(/33%/)).toBeInTheDocument();
      });

      // Send second progress update
      await act(async () => {
        downloadProgressHandler!({
          requestId: RESPONSE_ID,
          percent: 66,
          downloadedBytes: 6_666_666,
          totalBytes: 10_000_000,
          status: 'downloading',
        });
      });

      await waitFor(() => {
        expect(screen.getByText(/66%/)).toBeInTheDocument();
      });
    });

    it('shows downloaded / total bytes line when totalBytes is known', async () => {
      renderApp();
      await openUpdatePrompt();

      await act(async () => {
        screen.getByRole('button', { name: /Update now/i }).click();
      });

      await act(async () => {
        downloadProgressHandler!({
          requestId: RESPONSE_ID,
          percent: 50,
          downloadedBytes: 5_000_000,
          totalBytes: 10_000_000,
          status: 'downloading',
        });
      });

      const escaped = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const expectedPattern = new RegExp(
        `${escaped(formatBytes(5_000_000))} / ${escaped(formatBytes(10_000_000))}.*\\(50%\\)`,
      );
      await waitFor(() => {
        expect(screen.getByText(expectedPattern)).toBeInTheDocument();
      });
    });

    it('shows indeterminate progress bar (animate-pulse) when totalBytes is null', async () => {
      renderApp();
      await openUpdatePrompt();

      await act(async () => {
        screen.getByRole('button', { name: /Update now/i }).click();
      });

      await act(async () => {
        downloadProgressHandler!({
          requestId: RESPONSE_ID,
          percent: null,
          downloadedBytes: 500_000,
          totalBytes: null,
          status: 'downloading',
        });
      });

      // Should show "downloaded" text (not "/  total")
      await waitFor(() => {
        expect(
          screen.getByText(
            new RegExp(`${formatBytes(500_000)} downloaded`),
          ),
        ).toBeInTheDocument();
      });

      // The progress bar should have animate-pulse when percent is null
      const dialog = screen.getByRole('dialog');
      const pulsingBar = dialog.querySelector('.animate-pulse');
      expect(pulsingBar).toBeInTheDocument();
    });
  });

  // ── AC-004: Download/open failures ──

  describe('AC-004: Error handling', () => {
    it('shows error text with Retry button when retryable is true', async () => {
      renderApp();
      await openUpdatePrompt();

      // Start download phase
      await act(async () => {
        screen.getByRole('button', { name: /Update now/i }).click();
      });

      // Trigger download error
      await act(async () => {
        downloadErrorHandler!({
          requestId: RESPONSE_ID,
          error: 'Network timeout while downloading',
          retryable: true,
        });
      });

      await waitFor(() => {
        // Error text should be visible
        expect(
          screen.getByText('Network timeout while downloading'),
        ).toBeInTheDocument();
        // Retry button should be present
        expect(
          screen.getByRole('button', { name: /Retry/i }),
        ).toBeInTheDocument();
        // Close button should be present
        expect(
          screen.getByRole('button', { name: /Close/i }),
        ).toBeInTheDocument();
      });
    });

    it('shows only Close button (no Retry) when retryable is false', async () => {
      renderApp();
      await openUpdatePrompt();

      await act(async () => {
        screen.getByRole('button', { name: /Update now/i }).click();
      });

      await act(async () => {
        downloadErrorHandler!({
          requestId: RESPONSE_ID,
          error: 'Security policy blocked the download',
          retryable: false,
        });
      });

      await waitFor(() => {
        // Error text should be visible
        expect(
          screen.getByText('Security policy blocked the download'),
        ).toBeInTheDocument();
        // Close button should be present
        expect(
          screen.getByRole('button', { name: /Close/i }),
        ).toBeInTheDocument();
      });

      // Retry button should NOT be present
      expect(screen.queryByRole('button', { name: /Retry/i })).toBeNull();
    });
  });

  // ── AC-007: Border radius consistency ──

  describe('AC-007: Rounded radius classes', () => {
    it('uses rounded-md on the outer modal card', async () => {
      renderApp();
      await openUpdatePrompt();

      const dialog = screen.getByRole('dialog');
      const innerCard = dialog.firstChild as HTMLElement;
      expect(innerCard.classList.contains('rounded-md')).toBe(true);
    });

    it('uses a wider bounded modal card with internal overflow', async () => {
      renderApp();
      await openUpdatePrompt();

      const dialog = screen.getByRole('dialog');
      const innerCard = dialog.firstChild as HTMLElement;
      expect(innerCard.classList.contains('max-w-3xl')).toBe(true);
      expect(innerCard.classList.contains('max-h-[min(720px,calc(100vh-3rem))]')).toBe(true);
      expect(innerCard.classList.contains('flex-col')).toBe(true);
    });

    it('does NOT use rounded-2xl anywhere in the modal subtree', async () => {
      renderApp();
      await openUpdatePrompt();

      const dialog = screen.getByRole('dialog');
      expect(dialog.querySelector('.rounded-2xl')).toBeNull();
    });

    it('uses rounded-full on progress bar wrapper', async () => {
      renderApp();
      await openUpdatePrompt();

      // Start download so the progress bar renders
      await act(async () => {
        screen.getByRole('button', { name: /Update now/i }).click();
      });

      const dialog = screen.getByRole('dialog');
      // The progress bar container has rounded-full
      expect(dialog.querySelector('.rounded-full')).toBeInTheDocument();
    });
  });

  // ── AC-005 / AC-006: manual-check and complete/open/quit are covered by
  //     the desktop-side tests and manual smoke tests; AC-005 is partially
  //     verified here since the modal is the same component used for both
  //     auto-check and manual-check paths.
  // ── AC-008 is covered by existing passing tests (runtime-config, preload
  //     shape, URL policy).
});
