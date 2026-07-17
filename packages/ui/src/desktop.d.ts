export {};

declare global {
  const __ALLEN_APP_VERSION__: string;

  interface AllenReleaseNotesSection {
    title: string;
    items: string[];
  }

  interface AllenReleaseNotesEntry {
    version: string;
    title: string;
    publishedAt?: string;
    channel?: string;
    clients?: string[];
    summary?: string;
    notesUrl?: string;
    sections?: AllenReleaseNotesSection[];
  }

  interface AllenReleaseNotesIndex {
    schemaVersion: number;
    generatedAt?: string;
    latestVersion?: string;
    releases: AllenReleaseNotesEntry[];
    source: 'remote' | 'cache';
    cachedAt?: string;
  }

  interface Window {
    allenDesktop?: {
      getRuntimeInfo(): Promise<{
        mode: 'desktop';
        appVersion: string;
        dataDir: string;
        serverUrl: string | null;
        terminalWsUrl: string | null;
        mongoManaged: boolean;
        mongoDbPath: string | null;
        logsDir: string | null;
      }>;
      getAuthSession(): Promise<unknown | null>;
      setAuthSession(session: unknown): Promise<boolean>;
      clearAuthSession(): Promise<boolean>;
      setRealtimeAuth(token: string | null): Promise<boolean>;
      subscribeExecutionState(executionIds: string[]): Promise<Array<Record<string, unknown>>>;
      onRealtimeEvent(handler: (payload: unknown) => void): () => void;
      onRealtimeStatus(handler: (payload: { status: 'connecting' | 'connected' | 'disconnected' }) => void): () => void;
      selectDirectory(): Promise<string | null>;
      showItemInFolder(path: string): Promise<boolean>;
      openExternal(url: string): Promise<boolean>;
      openWorkspaceIde(workspaceId: string, ide: 'vscode' | 'cursor'): Promise<{
        ok: boolean;
        ide: 'vscode' | 'cursor';
        error?: string;
      }>;
      openLogsDirectory(): Promise<boolean>;
      writeClipboardText(text: string): Promise<boolean>;
      exportSupportBundle(targetPath?: string): Promise<{
        ok: boolean;
        canceled?: boolean;
        path?: string;
        bytes?: number;
        error?: string;
      }>;
      getUpdateSettings(): Promise<{
        autoUpdateEnabled: boolean;
        currentVersion: string;
      }>;
      setAutoUpdateEnabled(enabled: boolean): Promise<{
        autoUpdateEnabled: boolean;
        currentVersion: string;
      }>;
      checkForUpdates(): Promise<
        | { status: 'disabled'; currentVersion: string }
        | { status: 'not-available'; currentVersion: string; latestVersion: string }
        | { status: 'update-available'; currentVersion: string; latestVersion: string; url: string; opened: boolean }
      >;
      getReleaseNotes(): Promise<AllenReleaseNotesIndex>;
      getReleaseNote(version: string, notesUrl?: string): Promise<AllenReleaseNotesEntry>;
      onUpdatePrompt(handler: (payload: {
        requestId: string;
        currentVersion: string;
        latestVersion: string;
        releaseNotes: AllenReleaseNotesEntry | null;
        releaseNotesError: string | null;
      }) => void): () => void;
      respondToUpdatePrompt(requestId: string, action: 'update-now' | 'update-later'): void;
      onUpdateDownloadProgress(handler: (payload: {
        requestId: string;
        percent: number | null;
        downloadedBytes: number;
        totalBytes: number | null;
        status: 'downloading';
      }) => void): () => void;
      onUpdateDownloadError(handler: (payload: {
        requestId: string;
        error: string;
        retryable: boolean;
      }) => void): () => void;
      onUpdateDownloadComplete(handler: (payload: {
        requestId: string;
        dmgPath: string;
      }) => void): () => void;
      retryUpdateDownload(requestId: string): void;
      cancelUpdateDownload(requestId: string): void;
    };
  }
}
