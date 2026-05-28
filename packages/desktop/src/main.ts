import {
  app,
  BrowserWindow,
  Menu,
  clipboard,
  dialog,
  ipcMain,
  session,
  shell,
  type MenuItemConstructorOptions,
  type MessageBoxOptions,
  type OpenDialogOptions,
} from 'electron';
import electronUpdater from 'electron-updater';
import { execFileSync } from 'node:child_process';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { arch, platform, release } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AllenServerHandle } from '@allen/server/server';
import { defaultUiDistDir, setupDesktopRuntime } from './runtime-config.js';
import { startManagedMongo, type ManagedMongoRuntime } from './managed-mongo.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const { autoUpdater } = electronUpdater;

let mainWindow: BrowserWindow | null = null;
let serverHandle: AllenServerHandle | null = null;
let mongoHandle: ManagedMongoRuntime | null = null;
let isQuitting = false;
let logsDir: string | null = null;

interface SupportBundleResult {
  ok: boolean;
  canceled?: boolean;
  path?: string;
  bytes?: number;
  error?: string;
}

function isSmokeMode(): boolean {
  return process.env.ALLEN_DESKTOP_SMOKE === '1' || process.argv.includes('--smoke');
}

const userDataDirOverride = process.env.ALLEN_DESKTOP_USER_DATA_DIR;
if (userDataDirOverride) {
  app.setPath('userData', userDataDirOverride);
}

const singleInstanceLock = app.requestSingleInstanceLock();
if (!singleInstanceLock) {
  app.quit();
}

function desktopDataDir(): string {
  const dir = app.getPath('userData');
  mkdirSync(dir, { recursive: true });
  return dir;
}

function desktopAuthSessionPath(): string {
  const dir = resolve(desktopDataDir(), 'renderer-state');
  mkdirSync(dir, { recursive: true });
  return resolve(dir, 'auth-session.json');
}

function readDesktopAuthSession(): unknown | null {
  const path = desktopAuthSessionPath();
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function writeDesktopAuthSession(sessionData: unknown): boolean {
  const path = desktopAuthSessionPath();
  writeFileSync(path, `${JSON.stringify(sessionData)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return true;
}

function clearDesktopAuthSession(): boolean {
  const path = desktopAuthSessionPath();
  if (existsSync(path)) rmSync(path, { force: true });
  return true;
}

function setupLogging(): void {
  const dir = resolve(desktopDataDir(), 'logs');
  mkdirSync(dir, { recursive: true });
  logsDir = dir;
  app.setAppLogsPath(dir);

  const logPath = resolve(dir, 'desktop.log');
  const original = {
    log: console.log.bind(console),
    info: console.info.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
  };
  const write = (level: string, args: unknown[]) => {
    const line = `[${new Date().toISOString()}] ${level} ${args.map((arg) => {
      if (arg instanceof Error) return arg.stack ?? arg.message;
      if (typeof arg === 'string') return arg;
      try { return JSON.stringify(arg); } catch { return String(arg); }
    }).join(' ')}\n`;
    try { appendFileSync(logPath, line); } catch { /* ignore logging failures */ }
  };

  console.log = (...args: unknown[]) => { write('INFO', args); original.log(...args); };
  console.info = (...args: unknown[]) => { write('INFO', args); original.info(...args); };
  console.warn = (...args: unknown[]) => { write('WARN', args); original.warn(...args); };
  console.error = (...args: unknown[]) => { write('ERROR', args); original.error(...args); };

  process.on('uncaughtException', (err) => {
    write('FATAL', [err]);
    original.error(err);
  });
  process.on('unhandledRejection', (reason) => {
    write('REJECTION', [reason]);
    original.error(reason);
  });
}

function uiDistDir(): string {
  return defaultUiDistDir(__dirname);
}

function preloadPath(): string {
  return resolve(__dirname, '../preload.cjs');
}

function mergePathEntries(...paths: Array<string | undefined>): string {
  const entries = new Set<string>();
  for (const pathValue of paths) {
    for (const entry of pathValue?.split(':') ?? []) {
      const trimmed = entry.trim();
      if (trimmed) entries.add(trimmed);
    }
  }
  return Array.from(entries).join(':');
}

function readLoginShellPath(): string | undefined {
  if (process.platform !== 'darwin') return undefined;
  const shellPath = process.env.SHELL || '/bin/zsh';
  try {
    const output = execFileSync(shellPath, [
      '-lic',
      'printf "__ALLEN_PATH_START__%s__ALLEN_PATH_END__" "$PATH"',
    ], {
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return output.match(/__ALLEN_PATH_START__(.*?)__ALLEN_PATH_END__/s)?.[1];
  } catch (err) {
    console.warn('[desktop] could not read login shell PATH', err instanceof Error ? err.message : String(err));
    return undefined;
  }
}

function hydrateDesktopPath(): void {
  const loginShellPath = readLoginShellPath();
  const fallbackPath = [
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
    '/usr/local/sbin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
  ].join(':');
  process.env.PATH = mergePathEntries(loginShellPath, process.env.PATH, fallbackPath);
  console.info('[desktop] PATH hydrated', { hasLoginShellPath: Boolean(loginShellPath) });
}

function appUrl(path: string): string | null {
  if (!serverHandle) return null;
  return new URL(path, serverHandle.baseUrl).toString();
}

function parseUrl(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

function appOrigin(): string | null {
  if (!serverHandle) return null;
  return parseUrl(serverHandle.baseUrl)?.origin ?? null;
}

function isTrustedAppUrl(raw: string): boolean {
  const url = parseUrl(raw);
  const origin = appOrigin();
  return Boolean(url && origin && url.origin === origin && /^https?:$/.test(url.protocol));
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === 'localhost'
    || hostname === '127.0.0.1'
    || hostname === '::1'
    || hostname.endsWith('.localhost');
}

function isAllowedExternalUrl(raw: string): boolean {
  const url = parseUrl(raw);
  return Boolean(url && url.protocol === 'https:' && !isLoopbackHostname(url.hostname));
}

async function openExternalUrl(raw: string): Promise<boolean> {
  const url = parseUrl(raw);
  if (!url || !isAllowedExternalUrl(url.toString())) {
    console.warn('[desktop-security] blocked external URL', raw);
    return false;
  }
  await shell.openExternal(url.toString());
  return true;
}

function navigateTo(path: string): void {
  const url = appUrl(path);
  if (!url) return;
  if (!mainWindow || mainWindow.isDestroyed()) {
    mainWindow = createWindow(url);
    return;
  }
  void mainWindow.loadURL(url);
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
}

async function openDirectory(path: string | null | undefined): Promise<void> {
  if (!path) return;
  const result = await shell.openPath(path);
  if (result) {
    await dialog.showMessageBox({
      type: 'error',
      title: 'Allen could not open the folder',
      message: result,
    });
  }
}

function runtimeDiagnosticsText(): string {
  return [
    `Allen ${app.getVersion()}`,
    `Packaged: ${app.isPackaged ? 'yes' : 'no'}`,
    `Data directory: ${app.getPath('userData')}`,
    `Logs directory: ${logsDir ?? 'not ready'}`,
    `Server URL: ${serverHandle?.baseUrl ?? 'not ready'}`,
    `Terminal WebSocket: ${serverHandle?.terminalWsUrl ?? 'not ready'}`,
    `Managed Mongo: ${mongoHandle ? 'yes' : 'no'}`,
    `Mongo data: ${mongoHandle?.dbPath ?? 'not ready'}`,
    `Mongo binary: ${mongoHandle?.systemBinary ?? 'managed cache or external MongoDB'}`,
  ].join('\n');
}

function safeTimestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function redactConfigValue(key: string, value: unknown): unknown {
  if (/secret|token|password|api[_-]?key|private[_-]?key|credential|uri/i.test(key)) {
    return value == null || value === '' ? value : '[redacted]';
  }
  if (Array.isArray(value)) return value.map((item) => redactConfigValue(key, item));
  if (value && typeof value === 'object') return redactConfig(value as Record<string, unknown>);
  return value;
}

function redactConfig(config: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(config).map(([key, value]) => [key, redactConfigValue(key, value)]),
  );
}

function readJsonFile(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function readTextTail(path: string, maxBytes = 256 * 1024): string {
  try {
    const content = readFileSync(path);
    return content.subarray(Math.max(0, content.length - maxBytes)).toString('utf8');
  } catch (err) {
    return `Unable to read log: ${err instanceof Error ? err.message : String(err)}`;
  }
}

function collectLogTails(): Array<{ file: string; sizeBytes: number; modifiedAt: string; tail: string }> {
  if (!logsDir || !existsSync(logsDir)) return [];
  const logs: Array<{ file: string; sizeBytes: number; modifiedAt: string; tail: string }> = [];
  for (const entry of readdirSync(logsDir)) {
    const path = resolve(logsDir, entry);
    let st;
    try { st = statSync(path); } catch { continue; }
    if (!st.isFile() || !entry.endsWith('.log')) continue;
    logs.push({
      file: entry,
      sizeBytes: st.size,
      modifiedAt: st.mtime.toISOString(),
      tail: readTextTail(path),
    });
  }
  return logs.sort((a, b) => a.file.localeCompare(b.file));
}

async function collectHealthSnapshot(): Promise<Record<string, unknown>> {
  if (!serverHandle) return { status: 'not-ready' };
  const endpoints = ['/api/health', '/api/system/onboarding-status'];
  const results: Record<string, unknown> = {};
  for (const endpoint of endpoints) {
    try {
      const response = await fetch(new URL(endpoint, serverHandle.baseUrl));
      const text = await response.text();
      results[endpoint] = {
        ok: response.ok,
        status: response.status,
        body: text.slice(0, 4_000),
      };
    } catch (err) {
      results[endpoint] = {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
  return results;
}

async function buildSupportBundle(): Promise<Record<string, unknown>> {
  const dataDir = desktopDataDir();
  const configPath = resolve(dataDir, 'config', 'desktop-runtime.json');
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    app: {
      name: app.name,
      version: app.getVersion(),
      packaged: app.isPackaged,
    },
    platform: {
      platform: platform(),
      arch: arch(),
      release: release(),
      node: process.versions.node,
      electron: (process.versions as Record<string, string | undefined>).electron ?? null,
      chrome: (process.versions as Record<string, string | undefined>).chrome ?? null,
    },
    runtime: {
      mode: 'desktop',
      serverUrl: serverHandle?.baseUrl ?? null,
      terminalWsUrl: serverHandle?.terminalWsUrl ?? null,
      managedMongo: mongoHandle != null,
      mongoDbPath: mongoHandle?.dbPath ?? null,
      mongoBinary: mongoHandle?.systemBinary ?? null,
    },
    paths: {
      dataDir,
      logsDir,
      crashDumpsDir: app.getPath('crashDumps'),
      configPath,
    },
    security: {
      rendererPermissions: 'deny-by-default',
      navigation: 'embedded-origin-only',
      externalUrls: 'public-https-only',
      contentSecurityPolicy: 'enabled',
      singleInstanceLock: singleInstanceLock ? 'enabled' : 'unavailable',
      rendererFailureRecovery: 'enabled',
    },
    diagnostics: runtimeDiagnosticsText(),
    health: await collectHealthSnapshot(),
    config: redactConfig(readJsonFile(configPath) ?? {}),
    logs: collectLogTails(),
  };
}

async function exportSupportBundle(targetPath?: string): Promise<SupportBundleResult> {
  try {
    let outputPath = targetPath;
    if (outputPath && process.env.ALLEN_DESKTOP_ALLOW_TEST_SUPPORT_BUNDLE !== '1') {
      return { ok: false, error: 'Renderer-provided support bundle paths are disabled' };
    }
    if (!outputPath) {
      const options = {
        title: 'Export Allen Support Bundle',
        defaultPath: `allen-support-bundle-${safeTimestamp()}.json`,
        filters: [{ name: 'JSON', extensions: ['json'] }],
      };
      const result = mainWindow
        ? await dialog.showSaveDialog(mainWindow, options)
        : await dialog.showSaveDialog(options);
      if (result.canceled || !result.filePath) return { ok: true, canceled: true };
      outputPath = result.filePath;
    }

    const payload = JSON.stringify(await buildSupportBundle(), null, 2) + '\n';
    writeFileSync(outputPath, payload, { mode: 0o600 });
    chmodSync(outputPath, 0o600);
    return { ok: true, path: outputPath, bytes: Buffer.byteLength(payload) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function showDiagnostics(): Promise<void> {
  const detail = runtimeDiagnosticsText();
  const options: MessageBoxOptions = {
    type: 'info',
    title: 'Allen Diagnostics',
    message: 'Allen desktop runtime diagnostics',
    detail,
    buttons: ['OK', 'Copy'],
    defaultId: 0,
    cancelId: 0,
  };
  const { response } = mainWindow
    ? await dialog.showMessageBox(mainWindow, options)
    : await dialog.showMessageBox(options);
  if (response === 1) clipboard.writeText(detail);
}

function setupApplicationMenu(): void {
  const template: MenuItemConstructorOptions[] = [
    ...(process.platform === 'darwin'
      ? [{
          label: app.name,
          submenu: [
            { role: 'about' },
            { type: 'separator' },
            { role: 'services' },
            { type: 'separator' },
            { role: 'hide' },
            { role: 'hideOthers' },
            { role: 'unhide' },
            { type: 'separator' },
            { role: 'quit' },
          ],
        } satisfies MenuItemConstructorOptions]
      : []),
    {
      label: 'File',
      submenu: [
        { label: 'Open Chat', accelerator: 'CommandOrControl+1', click: () => navigateTo('/chat') },
        { label: 'Open Workspaces', accelerator: 'CommandOrControl+2', click: () => navigateTo('/workspaces') },
        { label: 'Open Settings', accelerator: 'CommandOrControl+,', click: () => navigateTo('/settings/integrations') },
        { type: 'separator' },
        { label: 'Open Data Folder', click: () => { void openDirectory(app.getPath('userData')); } },
        { label: 'Open Logs Folder', click: () => { void openDirectory(logsDir); } },
        { label: 'Show Diagnostics', click: () => { void showDiagnostics(); } },
        { label: 'Export Support Bundle', click: () => { void exportSupportBundle(); } },
        { type: 'separator' },
        process.platform === 'darwin' ? { role: 'close' } : { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'pasteAndMatchStyle' },
        { role: 'delete' },
        { type: 'separator' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        ...(process.platform === 'darwin'
          ? [
              { type: 'separator' },
              { role: 'front' },
            ] satisfies MenuItemConstructorOptions[]
          : [
              { role: 'close' },
            ] satisfies MenuItemConstructorOptions[]),
      ],
    },
    {
      label: 'Help',
      submenu: [
        { label: 'Allen Website', click: () => { void openExternalUrl('https://askallen.build/'); } },
        { label: 'GitHub', click: () => { void openExternalUrl('https://github.com/Kalpai-poc/allen'); } },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function setupSecurityPolicy(): void {
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    if (
      (permission === 'clipboard-sanitized-write' || permission === 'clipboard-read')
      && isTrustedAppUrl(webContents.getURL())
    ) {
      callback(true);
      return;
    }
    console.warn('[desktop-security] blocked permission request', permission);
    callback(false);
  });

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const origin = appOrigin();
    if (!origin || !details.url.startsWith(origin)) {
      callback({ responseHeaders: details.responseHeaders });
      return;
    }

    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          [
            "default-src 'self'",
            "base-uri 'self'",
            "object-src 'none'",
            "frame-ancestors 'none'",
            "form-action 'self'",
            "script-src 'self'",
            "style-src 'self' 'unsafe-inline'",
            "img-src 'self' data: blob: https:",
            "font-src 'self' data:",
            "media-src 'self' blob:",
            "connect-src 'self' http://127.0.0.1:* ws://127.0.0.1:*",
            "worker-src 'self' blob:",
            "child-src 'self' blob:",
          ].join('; '),
        ],
      },
    });
  });
}

async function startRuntime(): Promise<AllenServerHandle> {
  console.info('[desktop] starting runtime');
  hydrateDesktopPath();
  const runtime = await setupDesktopRuntime(desktopDataDir());
  const { startAllenServer } = await import('@allen/server/server');
  const managedMongo = runtime.mongoUri ? null : await startManagedMongo(runtime.dataDir, { port: runtime.mongoPort });
  mongoHandle = managedMongo;
  const mongoUri = runtime.mongoUri ?? managedMongo!.uri;
  console.info('[desktop] runtime config ready', {
    managedMongo: managedMongo != null,
    mongoDbPath: managedMongo?.dbPath ?? null,
    bundledMongo: managedMongo?.systemBinary ?? null,
  });

  return startAllenServer({
    mode: 'desktop',
    host: '127.0.0.1',
    port: runtime.apiPort,
    terminalHost: '127.0.0.1',
    terminalWsPort: runtime.terminalWsPort,
    mongoUri,
    configProvider: runtime.configProvider,
    secretsProvider: runtime.secretsProvider,
    staticUiDir: existsSync(uiDistDir()) ? uiDistDir() : undefined,
  });
}

function createWindow(url: string): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 1100,
    minHeight: 720,
    title: 'Allen',
    autoHideMenuBar: true,
    backgroundColor: '#0b1020',
    ...(process.platform === 'darwin'
      ? {
        titleBarStyle: 'hiddenInset' as const,
        fullSizeContentView: true,
        trafficLightPosition: { x: 16, y: 20 },
      }
      : {}),
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  });

  win.webContents.setWindowOpenHandler(({ url: targetUrl }) => {
    if (isTrustedAppUrl(targetUrl)) {
      void win.loadURL(targetUrl);
    } else {
      void openExternalUrl(targetUrl);
    }
    return { action: 'deny' };
  });

  win.webContents.on('will-navigate', (event, targetUrl) => {
    if (isTrustedAppUrl(targetUrl)) return;
    event.preventDefault();
    void openExternalUrl(targetUrl);
  });

  win.webContents.on('render-process-gone', (_event, details) => {
    if (isQuitting || win.isDestroyed()) return;
    console.error('[desktop] renderer process gone', details);
    void dialog.showMessageBox(win, {
      type: 'error',
      title: 'Allen window stopped responding',
      message: 'The Allen desktop window stopped unexpectedly.',
      detail: `Reason: ${details.reason}; exit code: ${details.exitCode}`,
      buttons: ['Reload Window', 'Quit'],
      defaultId: 0,
      cancelId: 1,
    }).then(({ response }) => {
      if (response === 0 && !win.isDestroyed()) {
        void win.loadURL(serverHandle?.baseUrl ?? url);
      } else {
        app.quit();
      }
    });
  });

  win.webContents.on('unresponsive', () => {
    console.warn('[desktop] renderer window became unresponsive');
  });

  win.webContents.on('responsive', () => {
    console.info('[desktop] renderer window became responsive');
  });

  win.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    if (!message.includes('[chat-files]')) return;
    console.info('[desktop-renderer]', { level, message, line, sourceId });
  });

  win.on('closed', () => {
    mainWindow = null;
  });

  void win.loadURL(url);
  return win;
}

ipcMain.handle('allen:runtime-info', () => ({
  mode: 'desktop',
  appVersion: app.getVersion(),
  dataDir: app.getPath('userData'),
  serverUrl: serverHandle?.baseUrl ?? null,
  terminalWsUrl: serverHandle?.terminalWsUrl ?? null,
  mongoManaged: mongoHandle != null,
  mongoDbPath: mongoHandle?.dbPath ?? null,
  logsDir,
}));

ipcMain.handle('allen:auth-get', () => readDesktopAuthSession());

ipcMain.handle('allen:auth-set', (_event, sessionData: unknown) => writeDesktopAuthSession(sessionData));

ipcMain.handle('allen:auth-clear', () => clearDesktopAuthSession());

ipcMain.handle('allen:select-directory', async () => {
  const options: OpenDialogOptions = { properties: ['openDirectory', 'createDirectory'] };
  const result = mainWindow
    ? await dialog.showOpenDialog(mainWindow, options)
    : await dialog.showOpenDialog(options);
  return result.canceled ? null : result.filePaths[0] ?? null;
});

ipcMain.handle('allen:show-item-in-folder', (_event, path: string) => {
  if (typeof path !== 'string' || path.trim() === '') return false;
  shell.showItemInFolder(path);
  return true;
});

ipcMain.handle('allen:open-external', async (_event, url: string) => {
  if (typeof url !== 'string') return false;
  return openExternalUrl(url);
});

ipcMain.handle('allen:open-logs-directory', async () => {
  if (!logsDir) return false;
  await shell.openPath(logsDir);
  return true;
});

ipcMain.handle('allen:clipboard-write-text', (_event, text: string) => {
  if (typeof text !== 'string') return false;
  clipboard.writeText(text);
  return true;
});

ipcMain.handle('allen:export-support-bundle', async (_event, targetPath?: string) => (
  exportSupportBundle(typeof targetPath === 'string' ? targetPath : undefined)
));

function setupAutoUpdates(): void {
  if (!app.isPackaged || process.env.ALLEN_DISABLE_AUTO_UPDATE === '1') return;
  autoUpdater.autoDownload = false;
  autoUpdater.on('error', (err) => console.warn('[updates] check failed', err.message));
  autoUpdater.on('update-available', (info) => console.info('[updates] update available', info.version));
  autoUpdater.on('update-not-available', () => console.info('[updates] no update available'));
  setTimeout(() => {
    void autoUpdater.checkForUpdates().catch((err) => {
      console.warn('[updates] check crashed', err instanceof Error ? err.message : String(err));
    });
  }, 10_000).unref();
}

async function stopRuntime(): Promise<void> {
  if (!serverHandle && !mongoHandle) return;
  const handle = serverHandle;
  serverHandle = null;
  const mongo = mongoHandle;
  mongoHandle = null;
  await handle?.stop();
  await mongo?.stop();
}

async function boot(): Promise<void> {
  try {
    serverHandle = await startRuntime();
    if (isSmokeMode()) {
      const res = await fetch(`${serverHandle.baseUrl}/api/health`);
      if (!res.ok) throw new Error(`Smoke health check failed: ${res.status}`);
      console.info('[smoke] Allen Desktop runtime started', {
        baseUrl: serverHandle.baseUrl,
        terminalWsUrl: serverHandle.terminalWsUrl,
      });
      await stopRuntime();
      app.exit(0);
      return;
    }
    mainWindow = createWindow(serverHandle.baseUrl);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[desktop] failed to start', err);
    if (isSmokeMode()) {
      await stopRuntime().catch((stopErr) => {
        console.error('[desktop] failed to stop after smoke error', stopErr);
      });
      app.exit(1);
      return;
    }
    await dialog.showMessageBox({
      type: 'error',
      title: 'Allen failed to start',
      message: 'Allen Desktop could not start the local runtime.',
      detail: message,
    });
    app.quit();
  }
}

app.whenReady().then(() => {
  setupLogging();
  setupApplicationMenu();
  setupSecurityPolicy();
  setupAutoUpdates();
  void boot();
});

app.on('second-instance', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
    return;
  }
  if (serverHandle) {
    mainWindow = createWindow(serverHandle.baseUrl);
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0 && serverHandle) {
    mainWindow = createWindow(serverHandle.baseUrl);
  }
});

app.on('before-quit', (event) => {
  if (isQuitting) return;
  isQuitting = true;
  event.preventDefault();
  void stopRuntime().finally(() => app.quit());
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
