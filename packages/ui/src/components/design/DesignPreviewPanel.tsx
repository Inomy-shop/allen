import { useEffect, useState, useCallback } from 'react';
import { Settings, RefreshCw, ExternalLink, Square } from 'lucide-react';
import { designRepos, type DesignPreviewConfig } from '../../services/designService';
import DesignPreviewConfigForm from './DesignPreviewConfigForm';

type PanelState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'no-repo' }
  | { status: 'no-config'; repoId: string }
  | { status: 'configure'; repoId: string; config: DesignPreviewConfig | null }
  | { status: 'needs-validation'; repoId: string; config: DesignPreviewConfig }
  | { status: 'ready'; repoId: string; config: DesignPreviewConfig };

type PreviewServerState =
  | { phase: 'idle' }
  | { phase: 'starting' }
  | { phase: 'running'; previewUrl: string; port: number; cwd?: string }
  | { phase: 'failed'; message: string }
  | { phase: 'stopping' };

const PREVIEW_POLL_TIMEOUT_MS = 60_000;
const PREVIEW_POLL_INTERVAL_MS = 1_500;

function extractPort(url: string): number {
  try {
    const { port, protocol } = new URL(url);
    if (port) return parseInt(port, 10);
    if (protocol === 'https:') return 443;
    return 80;
  } catch {
    return 0;
  }
}

function openPreviewUrl(url: string): void {
  if (typeof window !== 'undefined' && (window as any).allenDesktop?.openExternal) {
    void (window as any).allenDesktop.openExternal(url);
  } else {
    window.open(url, '_blank', 'noopener,noreferrer');
  }
}

export default function DesignPreviewPanel({ chatSessionId, workspaceId }: { chatSessionId?: string | null; workspaceId?: string | null }) {
  const [panelState, setPanelState] = useState<PanelState>({ status: 'loading' });
  // The config form is always visible when there is no existing config (no extra click
  // needed — users see build/run/port fields immediately). For states that already have a
  // saved config the form is revealed only when the user clicks Configure / Settings.
  const [showConfigFormOverride, setShowConfigFormOverride] = useState(false);
  const [previewServer, setPreviewServer] = useState<PreviewServerState>({ phase: 'idle' });

  // The form is visible if the panel is in a "no config yet" state OR the override is on.
  const showConfigForm =
    showConfigFormOverride ||
    panelState.status === 'no-config' ||
    panelState.status === 'configure';

  const load = useCallback(async () => {
    setPanelState({ status: 'loading' });
    try {
      const repo = await designRepos.getDefault();
      if (!repo) {
        setPanelState({ status: 'no-repo' });
        return;
      }
      let config: DesignPreviewConfig | null = null;
      try {
        config = await designRepos.getPreviewConfig(repo._id);
      } catch (configErr) {
        // A 404 with code DESIGN_PREVIEW_NOT_CONFIGURED means the repo exists but has
        // no preview config yet — show the setup form instead of an error message.
        const code = (configErr as Record<string, unknown>).code as string | undefined;
        const httpStatus = (configErr as Record<string, unknown>).httpStatus as number | undefined;
        if (code === 'DESIGN_PREVIEW_NOT_CONFIGURED' || httpStatus === 404) {
          setPanelState({ status: 'no-config', repoId: repo._id });
          return;
        }
        throw configErr;
      }
      if (!config || !config.enabled) {
        setPanelState({ status: 'no-config', repoId: repo._id });
        return;
      }
      if (config.lastValidationStatus === 'passed') {
        setPanelState({ status: 'ready', repoId: repo._id, config });
      } else {
        setPanelState({ status: 'needs-validation', repoId: repo._id, config });
      }
    } catch {
      setPanelState({ status: 'error', message: 'Could not load design repo' });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleSave(config: DesignPreviewConfig) {
    if (
      panelState.status !== 'no-config' &&
      panelState.status !== 'configure' &&
      panelState.status !== 'needs-validation' &&
      panelState.status !== 'ready'
    ) return;
    const repoId = (panelState as { repoId: string }).repoId;
    await designRepos.savePreviewConfig(repoId, config);
    setShowConfigFormOverride(false);
    await load();
  }

  async function handleTest() {
    if (
      panelState.status !== 'no-config' &&
      panelState.status !== 'configure' &&
      panelState.status !== 'needs-validation' &&
      panelState.status !== 'ready'
    ) return;
    const repoId = (panelState as { repoId: string }).repoId;
    await designRepos.testPreviewConfig(repoId);
    await load();
  }

  /**
   * Force-restart the preview server and open it in a new tab once ready.
   * Always triggers a fresh start — the server stops any existing process first.
   */
  async function handleOpenPreview() {
    if (panelState.status !== 'ready') return;
    if (!chatSessionId && !workspaceId) {
      setPreviewServer({ phase: 'failed', message: 'No active session or workspace — start or open a design chat to enable preview.' });
      return;
    }
    const repoId = panelState.repoId;

    setPreviewServer({ phase: 'starting' });
    try {
      await designRepos.previewStart(repoId, chatSessionId, workspaceId);
    } catch {
      setPreviewServer({ phase: 'failed', message: 'Could not start preview server.' });
      return;
    }

    // Poll until ready
    const deadline = Date.now() + PREVIEW_POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, PREVIEW_POLL_INTERVAL_MS));
      try {
        const status = await designRepos.previewStatus(repoId, chatSessionId);
        if (status.status === 'ready' && status.previewUrl) {
          const port = status.port ?? extractPort(status.previewUrl);
          setPreviewServer({ phase: 'running', previewUrl: status.previewUrl, port, cwd: status.cwd });
          openPreviewUrl(status.previewUrl);
          return;
        }
        if (status.status === 'failed') {
          setPreviewServer({ phase: 'failed', message: 'Preview server failed to start.' });
          return;
        }
      } catch {
        // keep polling
      }
    }
    setPreviewServer({ phase: 'failed', message: 'Preview server timed out. Try again.' });
  }

  /**
   * Open the already-running preview in a new tab without restarting the server.
   */
  function handleOpenAgain() {
    if (previewServer.phase !== 'running') return;
    openPreviewUrl(previewServer.previewUrl);
  }

  async function handleStopServer() {
    if (!repoId) return;
    setPreviewServer({ phase: 'stopping' });
    try {
      await designRepos.previewStop(repoId, chatSessionId);
    } catch {
      // best effort
    }
    setPreviewServer({ phase: 'idle' });
  }

  const repoId = (panelState as { repoId?: string }).repoId;
  const config = (panelState as { config?: DesignPreviewConfig | null }).config ?? null;

  return (
    <div className="flex flex-col border-l border-app shrink-0 w-[380px] min-w-[380px]">
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-app px-3 py-2 shrink-0">
        <span className="text-[13px] font-medium text-theme-primary flex-1">Preview</span>
        {panelState.status === 'loading' && (
          <RefreshCw className="h-3.5 w-3.5 text-theme-muted animate-spin" />
        )}
      </div>

      {/* Body */}
      <div className="flex-1 min-h-0 overflow-y-auto p-4 flex flex-col gap-4">
        {panelState.status === 'loading' && (
          <div className="flex items-center justify-center py-10">
            <span className="text-[12px] text-theme-subtle animate-pulse">Loading preview…</span>
          </div>
        )}

        {panelState.status === 'error' && (
          <div className="rounded-md border border-app bg-app-card px-4 py-3 text-[13px] text-theme-muted">
            {panelState.message}
            <button
              type="button"
              onClick={() => void load()}
              className="mt-2 block text-[12px] text-accent hover:underline"
            >
              Try again
            </button>
          </div>
        )}

        {panelState.status === 'no-repo' && (
          <div className="rounded-md border border-dashed border-app bg-app-card px-4 py-6 text-center">
            <p className="text-[13px] text-theme-muted mb-3">No design repo configured.</p>
            <p className="text-[12px] text-theme-subtle">
              Go to the Design section and set up a design repository to enable preview.
            </p>
          </div>
        )}

        {/* Setup section — always visible when no config exists.
            Shows build command, run command, port, and URL (healthCheckPath) fields
            directly so the user doesn't need an extra click. */}
        {(panelState.status === 'no-config' || panelState.status === 'configure') && (
          <div>
            <p className="mb-3 text-[12px] text-theme-muted">
              Enter your build and run commands, port, and preview URL to enable live preview.
            </p>
            {repoId && (
              <DesignPreviewConfigForm
                repoId={repoId}
                config={config}
                onSave={handleSave}
                onTest={handleTest}
              />
            )}
          </div>
        )}

        {/* Config form toggled for states that already have saved config */}
        {showConfigForm &&
          panelState.status !== 'no-config' &&
          panelState.status !== 'configure' &&
          repoId && (
            <DesignPreviewConfigForm
              repoId={repoId}
              config={config}
              onSave={handleSave}
              onTest={handleTest}
            />
          )}

        {panelState.status === 'needs-validation' && !showConfigFormOverride && (
          <div className="rounded-md border border-app bg-app-card px-4 py-5">
            <p className="text-[13px] font-medium text-theme-primary mb-1">Preview config needs validation</p>
            <p className="text-[12px] text-theme-muted mb-3">
              Run validation to check that the preview server starts correctly.
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setShowConfigFormOverride(true)}
                className="inline-flex items-center gap-1.5 rounded-md border border-app bg-app px-3 py-1.5 text-[12px] text-theme-secondary hover:bg-app-muted transition-colors"
              >
                <Settings className="h-3.5 w-3.5" />
                Configure
              </button>
              <button
                type="button"
                onClick={() => void handleTest()}
                className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-[12px] font-medium text-white hover:bg-accent/90 transition-colors"
              >
                <RefreshCw className="h-3.5 w-3.5" />
                Retry validation
              </button>
            </div>
          </div>
        )}

        {panelState.status === 'ready' && !showConfigFormOverride && (
          <div className="rounded-md border border-app bg-app-card px-4 py-5">
            <div className="flex items-center gap-2 mb-2">
              <span className="h-2 w-2 rounded-full bg-green-500 shrink-0" />
              <p className="text-[13px] font-medium text-theme-primary">Preview ready</p>
            </div>
            <p className="text-[12px] text-theme-muted mb-3">
              Clicking <strong>Open Preview</strong> will start the dev server and open it in a new
              browser tab once ready.
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => void handleOpenPreview()}
                className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-[12px] font-medium text-white hover:bg-accent/90 transition-colors"
                aria-label="Open preview"
              >
                <ExternalLink className="h-3.5 w-3.5" />
                Open Preview
              </button>
              <button
                type="button"
                onClick={() => setShowConfigFormOverride(true)}
                className="inline-flex items-center gap-1.5 rounded-md border border-app bg-app px-3 py-1.5 text-[12px] text-theme-secondary hover:bg-app-muted transition-colors"
              >
                <Settings className="h-3.5 w-3.5" />
                Settings
              </button>
            </div>
          </div>
        )}

        {previewServer.phase === 'starting' && (
          <div className="rounded-md border border-app bg-app-card px-4 py-3 flex items-start gap-2 text-[12px] text-theme-muted">
            <RefreshCw className="h-3.5 w-3.5 animate-spin shrink-0 mt-0.5" />
            <div className="flex flex-col gap-2 flex-1">
              <span>Starting preview server…</span>
              <button
                type="button"
                onClick={() => void handleStopServer()}
                className="inline-flex items-center gap-1.5 w-fit rounded-md border border-app bg-app px-3 py-1.5 text-[12px] text-theme-secondary hover:bg-app-muted transition-colors"
                aria-label="Stop server"
              >
                <Square className="h-3.5 w-3.5" />
                Stop server
              </button>
            </div>
          </div>
        )}

        {previewServer.phase === 'running' && (
          <div className="rounded-md border border-green-300 bg-green-50 dark:bg-green-950/20 px-4 py-4 text-[12px]">
            <div className="flex items-center gap-2 mb-3">
              <span className="h-2 w-2 rounded-full bg-green-500 shrink-0" />
              <span className="font-medium text-green-700 dark:text-green-300">Server: Running</span>
            </div>
            <div className="space-y-1 text-theme-muted mb-3">
              <div>
                <span className="text-theme-subtle">URL:&nbsp;</span>
                <span
                  className="font-mono text-[11px]"
                  data-testid="preview-url"
                >
                  {previewServer.previewUrl}
                </span>
              </div>
              <div>
                <span className="text-theme-subtle">Port:&nbsp;</span>
                <span
                  className="font-mono text-[11px]"
                  data-testid="preview-port"
                >
                  {previewServer.port}
                </span>
              </div>
              {previewServer.cwd && (
                <div>
                  <span className="text-theme-subtle">Running from:&nbsp;</span>
                  <span
                    className="font-mono text-[11px] break-all"
                    data-testid="preview-cwd"
                    title={previewServer.cwd}
                  >
                    {previewServer.cwd.split('/').slice(-3).join('/')}
                  </span>
                </div>
              )}
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={handleOpenAgain}
                className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-[12px] font-medium text-white hover:bg-accent/90 transition-colors"
                aria-label="Open again"
              >
                <ExternalLink className="h-3.5 w-3.5" />
                Open again
              </button>
              <button
                type="button"
                onClick={() => void handleStopServer()}
                className="inline-flex items-center gap-1.5 rounded-md border border-app bg-app px-3 py-1.5 text-[12px] text-theme-secondary hover:bg-app-muted transition-colors"
                aria-label="Stop server"
              >
                <Square className="h-3.5 w-3.5" />
                Stop server
              </button>
            </div>
          </div>
        )}

        {previewServer.phase === 'failed' && (
          <div className="rounded-md border border-red-300 bg-red-50 dark:bg-red-950/20 px-4 py-3 text-[12px]">
            <p className="text-red-700 dark:text-red-300 mb-2">{previewServer.message}</p>
            <button
              type="button"
              onClick={() => void handleOpenPreview()}
              className="text-[11px] text-accent hover:underline"
            >
              Retry
            </button>
            <button
              type="button"
              onClick={() => void handleStopServer()}
              className="ml-3 text-[11px] text-theme-subtle hover:underline"
              aria-label="Stop server"
            >
              Stop server
            </button>
          </div>
        )}

        {previewServer.phase === 'stopping' && (
          <div className="rounded-md border border-app bg-app-card px-4 py-3 flex items-center gap-2 text-[12px] text-theme-muted">
            <RefreshCw className="h-3.5 w-3.5 animate-spin shrink-0" />
            <span>Stopping server…</span>
          </div>
        )}
      </div>
    </div>
  );
}
