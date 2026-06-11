export {};

declare global {
  const __ALLEN_APP_VERSION__: string;

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
      onUpdatePrompt(handler: (payload: {
        requestId: string;
        currentVersion: string;
        latestVersion: string;
      }) => void): () => void;
      respondToUpdatePrompt(requestId: string, action: 'update-now' | 'update-later'): void;
    };
  }
}
