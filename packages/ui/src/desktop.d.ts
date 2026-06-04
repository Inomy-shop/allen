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
      openLogsDirectory(): Promise<boolean>;
      writeClipboardText(text: string): Promise<boolean>;
      exportSupportBundle(targetPath?: string): Promise<{
        ok: boolean;
        canceled?: boolean;
        path?: string;
        bytes?: number;
        error?: string;
      }>;
    };
  }
}
