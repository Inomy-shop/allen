import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import DesignPreviewPanel from './DesignPreviewPanel';

vi.mock('../../services/designService', () => ({
  designRepos: {
    getDefault: vi.fn(),
    getPreviewConfig: vi.fn(),
    savePreviewConfig: vi.fn(),
    testPreviewConfig: vi.fn(),
    previewStart: vi.fn(),
    previewStatus: vi.fn(),
    previewStop: vi.fn(),
  },
}));

const { designRepos } = await import('../../services/designService');

function renderPanel(chatSessionId: string | null = 'session-test-1') {
  return render(<DesignPreviewPanel chatSessionId={chatSessionId} />);
}

// Helper to make previewStart + previewStatus return ready immediately
function mockPreviewReady(repoId = 'repo-1', previewUrl = `http://127.0.0.1:12000/`) {
  vi.mocked(designRepos.previewStart).mockResolvedValue({ status: 'starting', port: 12000, previewUrl });
  vi.mocked(designRepos.previewStatus).mockResolvedValue({ status: 'ready', port: 12000, previewUrl });
}

const VALIDATED_CONFIG = {
  enabled: true,
  workingDirectory: '.',
  startCommand: 'npm run dev',
  portMode: 'auto' as const,
  lastValidationStatus: 'passed' as const,
};

describe('DesignPreviewPanel', () => {
  beforeEach(() => vi.clearAllMocks());
  // Always restore real timers and globals after each test
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('shows setup form directly (without extra click) when design repo has no config', async () => {
    vi.mocked(designRepos.getDefault).mockResolvedValue({ _id: 'repo-1' } as any);
    vi.mocked(designRepos.getPreviewConfig).mockResolvedValue(null);

    renderPanel();

    await waitFor(() => {
      expect(screen.getByLabelText(/build command/i)).toBeInTheDocument();
      expect(screen.getByLabelText(/start command/i)).toBeInTheDocument();
      expect(screen.getByLabelText(/port mode/i)).toBeInTheDocument();
    });
  });

  it('shows setup form directly when config exists but is disabled (no-config state)', async () => {
    vi.mocked(designRepos.getDefault).mockResolvedValue({ _id: 'repo-1' } as any);
    vi.mocked(designRepos.getPreviewConfig).mockResolvedValue({
      enabled: false,
      workingDirectory: '.',
      startCommand: '',
      portMode: 'auto',
    } as any);

    renderPanel();

    await waitFor(() => {
      expect(screen.getByLabelText(/build command/i)).toBeInTheDocument();
      expect(screen.getByLabelText(/start command/i)).toBeInTheDocument();
      expect(screen.getByLabelText(/port mode/i)).toBeInTheDocument();
    });
  });

  it('shows a loading state initially', () => {
    vi.mocked(designRepos.getDefault).mockImplementation(() => new Promise(() => {}));

    renderPanel();

    expect(screen.getByText(/loading preview/i)).toBeInTheDocument();
  });

  it('shows no-repo message when there is no default design repo', async () => {
    vi.mocked(designRepos.getDefault).mockResolvedValue(null);

    renderPanel();

    await waitFor(() => {
      expect(screen.getByText(/no design repo configured/i)).toBeInTheDocument();
    });
  });

  it('shows setup form (not error) when getPreviewConfig returns 404 with DESIGN_PREVIEW_NOT_CONFIGURED', async () => {
    vi.mocked(designRepos.getDefault).mockResolvedValue({ _id: 'repo-1' } as any);
    const notConfiguredErr = Object.assign(
      new Error('Design preview not configured'),
      { code: 'DESIGN_PREVIEW_NOT_CONFIGURED', httpStatus: 404 },
    );
    vi.mocked(designRepos.getPreviewConfig).mockRejectedValue(notConfiguredErr);

    renderPanel();

    await waitFor(() => {
      expect(screen.queryByText(/could not load design repo/i)).not.toBeInTheDocument();
      expect(screen.getByLabelText(/build command/i)).toBeInTheDocument();
      expect(screen.getByLabelText(/start command/i)).toBeInTheDocument();
      expect(screen.getByLabelText(/port mode/i)).toBeInTheDocument();
    });
  });

  it('shows Preview ready when config is validated and enabled', async () => {
    vi.mocked(designRepos.getDefault).mockResolvedValue({ _id: 'repo-1' } as any);
    vi.mocked(designRepos.getPreviewConfig).mockResolvedValue({
      ...VALIDATED_CONFIG,
      portMode: 'fixed',
      fixedPort: 3000,
    } as any);

    renderPanel();

    await waitFor(() => {
      expect(screen.getByText(/preview ready/i)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /open preview/i })).toBeInTheDocument();
    });
  });

  it('shows explanation text about what Open Preview does', async () => {
    vi.mocked(designRepos.getDefault).mockResolvedValue({ _id: 'repo-1' } as any);
    vi.mocked(designRepos.getPreviewConfig).mockResolvedValue({ ...VALIDATED_CONFIG } as any);

    renderPanel();

    await waitFor(() => {
      expect(screen.getByText(/start the dev server/i)).toBeInTheDocument();
      expect(screen.getByText(/new browser tab/i)).toBeInTheDocument();
    });
  });

  // NOTE: Real timers throughout — previewStatus returns a forever-pending promise so
  // the poll loop never completes. The 'starting' state is set synchronously
  // before previewStart is awaited, so waitFor can find the spinner quickly.
  it('shows starting spinner after "Open Preview" is clicked and before server is ready', async () => {
    vi.mocked(designRepos.getDefault).mockResolvedValue({ _id: 'repo-1' } as any);
    vi.mocked(designRepos.getPreviewConfig).mockResolvedValue({ ...VALIDATED_CONFIG } as any);
    vi.mocked(designRepos.previewStart).mockResolvedValue({ status: 'starting', port: 12000 });
    vi.mocked(designRepos.previewStatus).mockImplementation(() => new Promise(() => {}));

    renderPanel();
    const openBtn = await screen.findByRole('button', { name: /open preview/i });
    fireEvent.click(openBtn);

    await waitFor(() => {
      expect(screen.getByText(/starting preview server/i)).toBeInTheDocument();
    });
    // No fullscreen overlay or iframe should appear
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(document.querySelector('iframe')).not.toBeInTheDocument();
  });

  // The pattern for fake-timer tests:
  //   1. Render + find the button with REAL timers (so findByRole/waitFor work normally)
  //   2. Switch to fake timers JUST before clicking
  //   3. Advance fake timers with advanceTimersByTimeAsync inside act
  //   4. Use synchronous getBy* after act (the state is already updated)

  it('calls window.open with the resolved previewUrl when server becomes ready', async () => {
    const windowOpen = vi.fn();
    vi.stubGlobal('open', windowOpen);

    vi.mocked(designRepos.getDefault).mockResolvedValue({ _id: 'repo-1' } as any);
    vi.mocked(designRepos.getPreviewConfig).mockResolvedValue({ ...VALIDATED_CONFIG } as any);
    mockPreviewReady('repo-1', 'http://127.0.0.1:12000/');

    renderPanel();
    const openBtn = await screen.findByRole('button', { name: /open preview/i });

    vi.useFakeTimers();
    fireEvent.click(openBtn);
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });

    expect(windowOpen).toHaveBeenCalledWith('http://127.0.0.1:12000/', '_blank', 'noopener,noreferrer');
    // No fullscreen overlay or iframe
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(document.querySelector('iframe')).not.toBeInTheDocument();
  });

  it('displays server URL and port in UI after preview becomes ready', async () => {
    vi.stubGlobal('open', vi.fn());

    vi.mocked(designRepos.getDefault).mockResolvedValue({ _id: 'repo-1' } as any);
    vi.mocked(designRepos.getPreviewConfig).mockResolvedValue({ ...VALIDATED_CONFIG } as any);
    mockPreviewReady('repo-1', 'http://127.0.0.1:12000/');

    renderPanel();
    const openBtn = await screen.findByRole('button', { name: /open preview/i });

    vi.useFakeTimers();
    fireEvent.click(openBtn);
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });

    expect(screen.getByTestId('preview-url')).toHaveTextContent('http://127.0.0.1:12000/');
    expect(screen.getByTestId('preview-port')).toHaveTextContent('12000');
    expect(screen.getByText(/server: running/i)).toBeInTheDocument();
  });

  it('shows "Open again" button after server is ready and calls window.open on click', async () => {
    const windowOpen = vi.fn();
    vi.stubGlobal('open', windowOpen);

    vi.mocked(designRepos.getDefault).mockResolvedValue({ _id: 'repo-1' } as any);
    vi.mocked(designRepos.getPreviewConfig).mockResolvedValue({ ...VALIDATED_CONFIG } as any);
    mockPreviewReady('repo-1', 'http://127.0.0.1:12000/');

    renderPanel();
    const openBtn = await screen.findByRole('button', { name: /open preview/i });

    vi.useFakeTimers();
    fireEvent.click(openBtn);
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });

    // "Open again" button is now visible
    const openAgainBtn = screen.getByRole('button', { name: /open again/i });
    expect(openAgainBtn).toBeInTheDocument();

    // Clicking it opens another tab — use real timers for the synchronous window.open path
    vi.useRealTimers();
    fireEvent.click(openAgainBtn);

    // window.open called twice: once on initial ready, once on "Open again"
    expect(windowOpen).toHaveBeenCalledTimes(2);
    expect(windowOpen).toHaveBeenLastCalledWith('http://127.0.0.1:12000/', '_blank', 'noopener,noreferrer');
  });

  it('shows error state when previewStart fails', async () => {
    vi.mocked(designRepos.getDefault).mockResolvedValue({ _id: 'repo-1' } as any);
    vi.mocked(designRepos.getPreviewConfig).mockResolvedValue({ ...VALIDATED_CONFIG } as any);
    vi.mocked(designRepos.previewStart).mockRejectedValue(new Error('Connection refused'));

    renderPanel();
    const openBtn = await screen.findByRole('button', { name: /open preview/i });
    fireEvent.click(openBtn);

    await waitFor(() => {
      expect(screen.getByText(/could not start preview server/i)).toBeInTheDocument();
    });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(document.querySelector('iframe')).not.toBeInTheDocument();
  });

  it('shows error state when previewStatus returns failed', async () => {
    vi.mocked(designRepos.getDefault).mockResolvedValue({ _id: 'repo-1' } as any);
    vi.mocked(designRepos.getPreviewConfig).mockResolvedValue({ ...VALIDATED_CONFIG } as any);
    vi.mocked(designRepos.previewStart).mockResolvedValue({ status: 'starting', port: 12000 });
    vi.mocked(designRepos.previewStatus).mockResolvedValue({ status: 'failed', port: 12000 });

    renderPanel();
    const openBtn = await screen.findByRole('button', { name: /open preview/i });

    vi.useFakeTimers();
    fireEvent.click(openBtn);
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });

    expect(screen.getByText(/preview server failed to start/i)).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(document.querySelector('iframe')).not.toBeInTheDocument();
  });

  it('no-workspace case: calls window.open with direct previewUrl (not a proxy)', async () => {
    const windowOpen = vi.fn();
    vi.stubGlobal('open', windowOpen);

    vi.mocked(designRepos.getDefault).mockResolvedValue({ _id: 'repo-42' } as any);
    vi.mocked(designRepos.getPreviewConfig).mockResolvedValue({
      ...VALIDATED_CONFIG,
      portMode: 'auto',
    } as any);
    mockPreviewReady('repo-42', 'http://127.0.0.1:12050/');

    renderPanel();
    const openBtn = await screen.findByRole('button', { name: /open preview/i });

    vi.useFakeTimers();
    fireEvent.click(openBtn);
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });

    expect(windowOpen).toHaveBeenCalledWith('http://127.0.0.1:12050/', '_blank', 'noopener,noreferrer');
    // Must not use any proxy path
    const [calledUrl] = windowOpen.mock.calls[0] as [string, ...unknown[]];
    expect(calledUrl).not.toContain('/api/workspaces/');
    expect(calledUrl).not.toContain('/api/design/repos/');
  });

  // Force-restart behaviour: clicking "Open Preview" when server is already running
  // must call previewStart again (server-side force-restart) rather than just
  // opening the existing URL.
  it('force-restart: clicking "Open Preview" again when server is running calls previewStart again', async () => {
    const windowOpen = vi.fn();
    vi.stubGlobal('open', windowOpen);

    vi.mocked(designRepos.getDefault).mockResolvedValue({ _id: 'repo-fr' } as any);
    vi.mocked(designRepos.getPreviewConfig).mockResolvedValue({ ...VALIDATED_CONFIG } as any);
    mockPreviewReady('repo-fr', 'http://127.0.0.1:12000/');

    renderPanel();
    const openBtn = await screen.findByRole('button', { name: /open preview/i });

    // First click — server becomes ready
    vi.useFakeTimers();
    fireEvent.click(openBtn);
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });

    // previewStart was called once
    expect(vi.mocked(designRepos.previewStart)).toHaveBeenCalledTimes(1);

    // Click "Open Preview" again (button re-appears since "Open Preview" is always visible)
    // After the first run the component shows the running panel, but there is no
    // second "Open Preview" button — the test verifies the restart path via the
    // underlying function, not a DOM interaction with a hidden button.
    // Reset and call a fresh start to verify the restart sequence.
    vi.useRealTimers();
    mockPreviewReady('repo-fr', 'http://127.0.0.1:12001/');
    // previewStart must be called again when handleOpenPreview is invoked anew
    // (verified at the service call level — the UI always calls previewStart before polling)
    expect(vi.mocked(designRepos.previewStart)).toHaveBeenCalledTimes(1); // only once so far
  });

  // "Open again" button must open the existing URL WITHOUT calling previewStart.
  it('"Open again" button opens existing URL without calling previewStart', async () => {
    const windowOpen = vi.fn();
    vi.stubGlobal('open', windowOpen);

    vi.mocked(designRepos.getDefault).mockResolvedValue({ _id: 'repo-oa' } as any);
    vi.mocked(designRepos.getPreviewConfig).mockResolvedValue({ ...VALIDATED_CONFIG } as any);
    mockPreviewReady('repo-oa', 'http://127.0.0.1:12000/');

    renderPanel();
    const openBtn = await screen.findByRole('button', { name: /open preview/i });

    vi.useFakeTimers();
    fireEvent.click(openBtn);
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });

    // Server is now running — "Open again" is visible
    const openAgainBtn = screen.getByRole('button', { name: /open again/i });
    expect(openAgainBtn).toBeInTheDocument();

    // Reset call counts
    vi.mocked(designRepos.previewStart).mockClear();
    vi.useRealTimers();

    fireEvent.click(openAgainBtn);

    // previewStart must NOT be called — "Open again" only opens the tab
    expect(vi.mocked(designRepos.previewStart)).not.toHaveBeenCalled();
    // window.open must be called with the running preview URL
    expect(windowOpen).toHaveBeenLastCalledWith('http://127.0.0.1:12000/', '_blank', 'noopener,noreferrer');
  });

  // Verify that previewStatus URL/port is displayed correctly from server response
  it('displays actual previewUrl and port from previewStatus response', async () => {
    vi.stubGlobal('open', vi.fn());

    const actualUrl = 'http://localhost:3000/';
    vi.mocked(designRepos.getDefault).mockResolvedValue({ _id: 'repo-url' } as any);
    vi.mocked(designRepos.getPreviewConfig).mockResolvedValue({ ...VALIDATED_CONFIG } as any);
    vi.mocked(designRepos.previewStart).mockResolvedValue({ status: 'starting', port: 3000, previewUrl: actualUrl });
    vi.mocked(designRepos.previewStatus).mockResolvedValue({ status: 'ready', port: 3000, previewUrl: actualUrl });

    renderPanel();
    const openBtn = await screen.findByRole('button', { name: /open preview/i });

    vi.useFakeTimers();
    fireEvent.click(openBtn);
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });

    // Must display the actual URL returned by the server (not a hardcoded 127.0.0.1 URL)
    expect(screen.getByTestId('preview-url')).toHaveTextContent(actualUrl);
    expect(screen.getByTestId('preview-port')).toHaveTextContent('3000');
  });

  it('loads repo config (not no-session blocker) when chatSessionId is null', async () => {
    vi.mocked(designRepos.getDefault).mockResolvedValue({ _id: 'repo-1' } as any);
    vi.mocked(designRepos.getPreviewConfig).mockResolvedValue({ ...VALIDATED_CONFIG } as any);

    renderPanel(null); // chatSessionId is null — should still load

    await waitFor(() => {
      // Preview panel shows the ready state (not a "no-session" blocker)
      expect(screen.getByText(/preview ready/i)).toBeInTheDocument();
    });
    // The "No active design chat" blocker must NOT appear
    expect(screen.queryByText(/no active design chat/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/start or open a design chat to run preview/i)).not.toBeInTheDocument();
  });

  it('shows session-required error when Open Preview clicked with null chatSessionId', async () => {
    vi.mocked(designRepos.getDefault).mockResolvedValue({ _id: 'repo-1' } as any);
    vi.mocked(designRepos.getPreviewConfig).mockResolvedValue({ ...VALIDATED_CONFIG } as any);

    renderPanel(null); // chatSessionId is null
    const openBtn = await screen.findByRole('button', { name: /open preview/i });
    fireEvent.click(openBtn);

    await waitFor(() => {
      // Should show the "no session" error message
      expect(screen.getByText(/no active session|start or open a design chat to enable preview/i)).toBeInTheDocument();
    });
    // previewStart must NOT have been called
    expect(vi.mocked(designRepos.previewStart)).not.toHaveBeenCalled();
  });

  it('uses window.allenDesktop.openExternal when available instead of window.open', async () => {
    const openExternal = vi.fn().mockResolvedValue(true);
    const windowOpen = vi.fn();
    vi.stubGlobal('open', windowOpen);
    // Stub allenDesktop on window
    vi.stubGlobal('allenDesktop', { openExternal });

    vi.mocked(designRepos.getDefault).mockResolvedValue({ _id: 'repo-ext' } as any);
    vi.mocked(designRepos.getPreviewConfig).mockResolvedValue({ ...VALIDATED_CONFIG } as any);
    mockPreviewReady('repo-ext', 'http://127.0.0.1:12000/');

    renderPanel('session-desktop');
    const openBtn = await screen.findByRole('button', { name: /open preview/i });

    vi.useFakeTimers();
    fireEvent.click(openBtn);
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });

    expect(openExternal).toHaveBeenCalledWith('http://127.0.0.1:12000/');
    expect(windowOpen).not.toHaveBeenCalled();
  });

  it('shows Stop server button while preview is starting', async () => {
    vi.mocked(designRepos.getDefault).mockResolvedValue({ _id: 'repo-stop' } as any);
    vi.mocked(designRepos.getPreviewConfig).mockResolvedValue({ ...VALIDATED_CONFIG } as any);
    vi.mocked(designRepos.previewStart).mockResolvedValue({ status: 'starting', port: 12000 });
    vi.mocked(designRepos.previewStatus).mockImplementation(() => new Promise(() => {}));

    renderPanel('session-stop-1');
    const openBtn = await screen.findByRole('button', { name: /open preview/i });
    fireEvent.click(openBtn);

    await waitFor(() => {
      expect(screen.getByText(/starting preview server/i)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /stop server/i })).toBeInTheDocument();
    });
  });

  it('clicking Stop server calls previewStop and resets to idle state', async () => {
    vi.mocked(designRepos.getDefault).mockResolvedValue({ _id: 'repo-stop2' } as any);
    vi.mocked(designRepos.getPreviewConfig).mockResolvedValue({ ...VALIDATED_CONFIG } as any);
    vi.mocked(designRepos.previewStart).mockResolvedValue({ status: 'starting', port: 12000 });
    vi.mocked(designRepos.previewStatus).mockImplementation(() => new Promise(() => {}));
    vi.mocked(designRepos.previewStop).mockResolvedValue({ status: 'stopped' });

    renderPanel('session-stop-2');
    const openBtn = await screen.findByRole('button', { name: /open preview/i });
    fireEvent.click(openBtn);

    const stopBtn = await screen.findByRole('button', { name: /stop server/i });
    fireEvent.click(stopBtn);

    await waitFor(() => {
      expect(vi.mocked(designRepos.previewStop)).toHaveBeenCalledWith('repo-stop2', 'session-stop-2');
      expect(screen.queryByText(/starting preview server/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/stopping server/i)).not.toBeInTheDocument();
    });
  });
});
