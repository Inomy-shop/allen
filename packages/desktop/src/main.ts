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
import { execFile, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  appendFileSync,
  chmodSync,
  createWriteStream,
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
import { ObjectId } from 'mongodb';
import { Readable, Transform } from 'node:stream';
import { finished } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import type { AllenServerHandle } from '@allen/server/server';
import { defaultUiDistDir, setupDesktopRuntime } from './runtime-config.js';
import { startManagedMongo, type ManagedMongoRuntime } from './managed-mongo.js';
import { isAllowedExternalUrl } from './url-policy.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
let mainWindow: BrowserWindow | null = null;
const trustedPopupWindows = new Set<BrowserWindow>();
let serverHandle: AllenServerHandle | null = null;
let mongoHandle: ManagedMongoRuntime | null = null;
let isQuitting = false;
let logsDir: string | null = null;


interface UpdateMetadata {
  version: string;
  url: string;
  releaseNotesUrl?: string;
  releasesUrl?: string;
}

interface ReleaseNotesSection {
  title: string;
  items: string[];
}

interface ReleaseNotesEntry {
  version: string;
  title: string;
  publishedAt?: string;
  channel?: string;
  clients?: string[];
  summary?: string;
  notesUrl?: string;
  sections?: ReleaseNotesSection[];
}

interface ReleaseNotesIndex {
  schemaVersion: number;
  generatedAt?: string;
  latestVersion?: string;
  releases: ReleaseNotesEntry[];
  source: 'remote' | 'cache';
  cachedAt?: string;
}

interface ReleaseNotesCache {
  cachedAt: string;
  index: Omit<ReleaseNotesIndex, 'source' | 'cachedAt'>;
  details: Record<string, ReleaseNotesEntry>;
}

interface AutoUpdatePreferences {
  autoUpdateEnabled: boolean;
}

type UpdateCheckResult =
  | { status: 'disabled'; currentVersion: string }
  | { status: 'not-available'; currentVersion: string; latestVersion: string }
  | { status: 'update-available'; currentVersion: string; latestVersion: string; url: string; opened: boolean };

type UpdatePromptAction = 'update-now' | 'update-later';

interface UpdateDownloadProgressPayload {
  requestId: string;
  percent: number | null;
  downloadedBytes: number;
  totalBytes: number | null;
  status: 'downloading';
}

interface UpdateDownloadErrorPayload {
  requestId: string;
  error: string;
  retryable: boolean;
}

interface UpdateDownloadCompletePayload {
  requestId: string;
  dmgPath: string;
}

interface UpdateDownloadRetryPayload {
  requestId: string;
}

const pendingUpdates = new Map<string, UpdateMetadata>();
const activeUpdateDownloads = new Map<string, AbortController>();

const DEFAULT_UPDATE_FEED_URL = 'https://askallen.build/download/latest.json';
const DEFAULT_RELEASES_FEED_URL = 'https://askallen.build/download/releases.json';

interface SupportBundleResult {
  ok: boolean;
  canceled?: boolean;
  path?: string;
  bytes?: number;
  error?: string;
}

type ExternalIdeId = 'vscode' | 'cursor';

interface OpenWorkspaceIdeResult {
  ok: boolean;
  ide: ExternalIdeId;
  error?: string;
}

const EXTERNAL_IDE_CONFIG: Record<ExternalIdeId, { label: string; cli: string; macAppName: string }> = {
  vscode: { label: 'Visual Studio Code', cli: 'code', macAppName: 'Visual Studio Code' },
  cursor: { label: 'Cursor', cli: 'cursor', macAppName: 'Cursor' },
};

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

async function openExternalUrl(raw: string): Promise<boolean> {
  const url = parseUrl(raw);
  if (!url || !isAllowedExternalUrl(url.toString())) {
    console.warn('[desktop-security] blocked external URL', raw);
    return false;
  }
  await shell.openExternal(url.toString());
  return true;
}

function installTrustedNavigationGuards(win: BrowserWindow, openTrustedUrl: (targetUrl: string) => void): void {
  win.webContents.setWindowOpenHandler(({ url: targetUrl }) => {
    if (isTrustedAppUrl(targetUrl)) {
      openTrustedUrl(targetUrl);
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
}

function createTrustedPopupWindow(parent: BrowserWindow, targetUrl: string): void {
  const popup = new BrowserWindow({
    width: 1120,
    height: 820,
    minWidth: 720,
    minHeight: 520,
    title: 'Allen',
    parent,
    modal: false,
    autoHideMenuBar: true,
    backgroundColor: '#0b1020',
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  });

  trustedPopupWindows.add(popup);
  popup.on('closed', () => {
    trustedPopupWindows.delete(popup);
  });

  installTrustedNavigationGuards(popup, (trustedTargetUrl) => {
    createTrustedPopupWindow(popup, trustedTargetUrl);
  });
  void popup.loadURL(targetUrl);
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

function isExternalIdeId(value: unknown): value is ExternalIdeId {
  return value === 'vscode' || value === 'cursor';
}

function execFileQuiet(command: string, args: string[]): Promise<void> {
  return new Promise((resolveExec, rejectExec) => {
    execFile(command, args, { timeout: 8_000 }, (error) => {
      if (error) rejectExec(error);
      else resolveExec();
    });
  });
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

async function launchIde(ide: ExternalIdeId, workspacePath: string): Promise<void> {
  const config = EXTERNAL_IDE_CONFIG[ide];
  try {
    await execFileQuiet(config.cli, [workspacePath]);
    return;
  } catch (cliErr) {
    if (process.platform !== 'darwin') throw cliErr;
  }

  await execFileQuiet('open', ['-a', config.macAppName, workspacePath]);
}

async function openWorkspaceInIde(workspaceId: unknown, ide: unknown): Promise<OpenWorkspaceIdeResult> {
  const selectedIde: ExternalIdeId = isExternalIdeId(ide) ? ide : 'vscode';
  const config = EXTERNAL_IDE_CONFIG[selectedIde];

  try {
    if (typeof workspaceId !== 'string' || !ObjectId.isValid(workspaceId)) {
      return { ok: false, ide: selectedIde, error: 'Invalid workspace id' };
    }
    if (!serverHandle) {
      return { ok: false, ide: selectedIde, error: 'Allen desktop server is not ready yet' };
    }

    const workspace = await serverHandle.db.collection('workspaces').findOne(
      { _id: new ObjectId(workspaceId) },
      { projection: { worktreePath: 1, status: 1, name: 1 } },
    );
    if (!workspace || workspace.status === 'archived') {
      return { ok: false, ide: selectedIde, error: 'Workspace is not available' };
    }

    const worktreePath = typeof workspace.worktreePath === 'string' ? workspace.worktreePath.trim() : '';
    if (!worktreePath || !existsSync(worktreePath) || !isDirectory(worktreePath)) {
      return { ok: false, ide: selectedIde, error: 'Workspace folder is missing' };
    }

    await launchIde(selectedIde, worktreePath);
    return { ok: true, ide: selectedIde };
  } catch (err) {
    console.warn('[desktop] failed to open workspace IDE', {
      ide: selectedIde,
      workspaceId: typeof workspaceId === 'string' ? workspaceId : null,
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      ok: false,
      ide: selectedIde,
      error: `Could not open ${config.label}. Make sure it is installed.`,
    };
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
        { label: 'GitHub', click: () => { void openExternalUrl('https://github.com/Inomy-shop/allen'); } },
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

  installTrustedNavigationGuards(win, (targetUrl) => {
    createTrustedPopupWindow(win, targetUrl);
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

ipcMain.handle('allen:open-workspace-ide', async (_event, payload: { workspaceId?: unknown; ide?: unknown }) => (
  openWorkspaceInIde(payload?.workspaceId, payload?.ide)
));

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

ipcMain.handle('allen:update-settings-get', () => ({
  ...readAutoUpdatePreferences(),
  currentVersion: app.getVersion(),
}));

ipcMain.handle('allen:update-settings-set-auto-enabled', (_event, enabled: boolean) => ({
  ...writeAutoUpdatePreferences({ autoUpdateEnabled: enabled === true }),
  currentVersion: app.getVersion(),
}));

ipcMain.handle('allen:update-check-now', async () => checkForProductionUpdate({ manual: true }));

ipcMain.handle('allen:release-notes-list', async () => getReleaseNotesIndex());
ipcMain.handle('allen:release-notes-get', async (_event, payload: { version?: unknown; notesUrl?: unknown }) => (
  getReleaseNote(
    typeof payload?.version === 'string' ? payload.version : '',
    typeof payload?.notesUrl === 'string' ? payload.notesUrl : undefined,
  )
));

function autoUpdatePreferencesPath(): string {
  const dir = resolve(desktopDataDir(), 'allen-preferences');
  mkdirSync(dir, { recursive: true });
  return resolve(dir, 'auto-update.json');
}

function readAutoUpdatePreferences(): AutoUpdatePreferences {
  const path = autoUpdatePreferencesPath();
  if (!existsSync(path)) return { autoUpdateEnabled: true };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return {
      autoUpdateEnabled: parsed?.autoUpdateEnabled !== false,
    };
  } catch {
    return { autoUpdateEnabled: true };
  }
}

function writeAutoUpdatePreferences(preferences: AutoUpdatePreferences): AutoUpdatePreferences {
  const normalized = { autoUpdateEnabled: preferences.autoUpdateEnabled !== false };
  const path = autoUpdatePreferencesPath();
  writeFileSync(path, `${JSON.stringify(normalized, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return normalized;
}


function releaseNotesCachePath(): string {
  const updatesDir = resolve(desktopDataDir(), 'updates');
  mkdirSync(updatesDir, { recursive: true });
  return resolve(updatesDir, 'release-notes-cache.json');
}

function readReleaseNotesCache(): ReleaseNotesCache | null {
  const path = releaseNotesCachePath();
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const cache = parsed as Partial<ReleaseNotesCache>;
    if (typeof cache.cachedAt !== 'string' || !cache.index || typeof cache.index !== 'object') return null;
    if (!Array.isArray((cache.index as ReleaseNotesIndex).releases)) return null;
    return {
      cachedAt: cache.cachedAt,
      index: cache.index as ReleaseNotesCache['index'],
      details: cache.details && typeof cache.details === 'object' && !Array.isArray(cache.details) ? cache.details as Record<string, ReleaseNotesEntry> : {},
    };
  } catch {
    return null;
  }
}

function writeReleaseNotesCache(cache: ReleaseNotesCache): void {
  const path = releaseNotesCachePath();
  writeFileSync(path, `${JSON.stringify(cache, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function normalizeReleaseVersion(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const version = value.trim().replace(/^v/i, '');
  return /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(version) ? version : null;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function parseReleaseNotesUrl(value: unknown, feedUrl: string): string | undefined {
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  try {
    const url = new URL(value, feedUrl);
    const origin = new URL(feedUrl).origin;
    if (url.protocol !== 'https:' || url.origin !== origin) return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

function parseReleaseNotesSections(raw: unknown): ReleaseNotesSection[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const sections = raw
    .map((section) => {
      if (!section || typeof section !== 'object' || Array.isArray(section)) return null;
      const data = section as Record<string, unknown>;
      const title = optionalString(data.title);
      if (!title) return null;
      const items = Array.isArray(data.items)
        ? data.items.filter((item): item is string => typeof item === 'string' && item.trim() !== '').map((item) => item.trim())
        : [];
      return { title, items };
    })
    .filter((section): section is ReleaseNotesSection => section != null);
  return sections.length > 0 ? sections : undefined;
}

function parseReleaseNotesEntry(raw: unknown, feedUrl: string): ReleaseNotesEntry | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const data = raw as Record<string, unknown>;
  const version = normalizeReleaseVersion(data.version);
  if (!version) return null;

  const clients = Array.isArray(data.clients)
    ? data.clients.filter((client): client is string => typeof client === 'string' && client.trim() !== '').map((client) => client.trim())
    : undefined;
  if (clients && clients.length > 0 && !clients.includes('desktop')) return null;

  return {
    version,
    title: optionalString(data.title) ?? `Allen ${version}`,
    publishedAt: optionalString(data.publishedAt),
    channel: optionalString(data.channel),
    clients,
    summary: optionalString(data.summary),
    notesUrl: parseReleaseNotesUrl(data.notesUrl ?? data.releaseNotesUrl, feedUrl),
    sections: parseReleaseNotesSections(data.sections),
  };
}

function parseReleaseNotesIndex(raw: unknown, feedUrl: string): Omit<ReleaseNotesIndex, 'source' | 'cachedAt'> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const data = raw as Record<string, unknown>;
  if (!Array.isArray(data.releases)) return null;

  const releases = data.releases
    .map((entry) => parseReleaseNotesEntry(entry, feedUrl))
    .filter((entry): entry is ReleaseNotesEntry => entry != null)
    .sort((left, right) => compareReleaseVersions(right.version, left.version));
  if (releases.length === 0) return null;

  return {
    schemaVersion: typeof data.schemaVersion === 'number' ? data.schemaVersion : 1,
    generatedAt: optionalString(data.generatedAt),
    latestVersion: normalizeReleaseVersion(data.latestVersion) ?? releases[0]?.version,
    releases,
  };
}

function releasesFeedUrl(): string {
  return process.env.ALLEN_RELEASE_NOTES_FEED_URL || DEFAULT_RELEASES_FEED_URL;
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url, { headers: { 'Cache-Control': 'no-cache' } });
  if (!response.ok) throw new Error(`Release notes feed returned HTTP ${response.status}`);
  return response.json();
}

async function getReleaseNotesIndex(feedUrl = releasesFeedUrl()): Promise<ReleaseNotesIndex> {
  const cached = readReleaseNotesCache();
  try {
    console.info('[updates] checking release notes feed', { feedUrl });
    const parsed = parseReleaseNotesIndex(await fetchJson(feedUrl), feedUrl);
    if (!parsed) throw new Error('Release notes feed did not include a valid releases list');
    const nextCache: ReleaseNotesCache = {
      cachedAt: new Date().toISOString(),
      index: parsed,
      details: cached?.details ?? {},
    };
    writeReleaseNotesCache(nextCache);
    return { ...parsed, source: 'remote', cachedAt: nextCache.cachedAt };
  } catch (err) {
    if (cached) return { ...cached.index, source: 'cache', cachedAt: cached.cachedAt };
    throw err;
  }
}

function defaultReleaseNoteUrl(version: string): string | undefined {
  try {
    return new URL(`releases/${version}.json`, releasesFeedUrl()).toString();
  } catch {
    return undefined;
  }
}

async function getReleaseNote(versionInput: string, notesUrlInput?: string): Promise<ReleaseNotesEntry> {
  const version = normalizeReleaseVersion(versionInput);
  if (!version) throw new Error('A valid release version is required');

  const feedUrl = releasesFeedUrl();
  const notesUrl = parseReleaseNotesUrl(notesUrlInput, feedUrl) ?? defaultReleaseNoteUrl(version);
  const cached = readReleaseNotesCache();
  if (!notesUrl) {
    const cachedDetail = cached?.details?.[version];
    if (cachedDetail) return cachedDetail;
    throw new Error('Release notes URL is invalid');
  }

  try {
    const parsed = parseReleaseNotesEntry(await fetchJson(notesUrl), feedUrl);
    if (!parsed || parsed.version !== version) throw new Error('Release notes file did not match the requested version');
    const nextCache: ReleaseNotesCache = cached ?? {
      cachedAt: new Date().toISOString(),
      index: { schemaVersion: 1, latestVersion: version, releases: [parsed] },
      details: {},
    };
    nextCache.cachedAt = new Date().toISOString();
    nextCache.details = { ...nextCache.details, [version]: parsed };
    writeReleaseNotesCache(nextCache);
    return parsed;
  } catch (err) {
    const cachedDetail = cached?.details?.[version];
    if (cachedDetail) return cachedDetail;
    throw err;
  }
}

function parseUpdateMetadata(raw: unknown, feedUrl: string): UpdateMetadata | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const data = raw as Record<string, unknown>;
  const rawUrl = data.url ?? data.downloadUrl ?? data.download_url ?? data.link;
  if (typeof rawUrl !== 'string' || rawUrl.trim() === '') return null;

  let url: URL;
  try {
    url = new URL(rawUrl, feedUrl);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  if (url.origin !== new URL(feedUrl).origin) return null;

  const releaseNotesUrl = parseReleaseNotesUrl(data.releaseNotesUrl, feedUrl);
  const releasesUrl = parseReleaseNotesUrl(data.releasesUrl, feedUrl);

  const rawVersion = data.version;
  const versionFromMetadata = typeof rawVersion === 'string' ? rawVersion.trim().replace(/^v/i, '') : '';
  const versionFromUrl = url.pathname.match(/Allen-([0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?)-/)?.[1] ?? '';
  const version = versionFromMetadata || versionFromUrl;
  if (!/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(version)) return null;

  return { version, url: url.toString(), releaseNotesUrl, releasesUrl };
}

function compareReleaseVersions(left: string, right: string): number {
  const parse = (value: string) => value
    .replace(/^v/i, '')
    .split(/[+-]/, 1)[0]
    .split('.')
    .map((part) => Number.parseInt(part, 10));
  const leftParts = parse(left);
  const rightParts = parse(right);
  for (let i = 0; i < 3; i += 1) {
    const diff = (leftParts[i] || 0) - (rightParts[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function updateInstallerPath(update: UpdateMetadata): string {
  const updatesDir = resolve(desktopDataDir(), 'updates');
  mkdirSync(updatesDir, { recursive: true });
  const url = new URL(update.url);
  const filename = (url.pathname.split('/').pop() || `Allen-${update.version}.dmg`)
    .replace(/[^A-Za-z0-9._-]/g, '_');
  return resolve(updatesDir, filename);
}

async function downloadUpdateInstaller(
  update: UpdateMetadata,
  onProgress: (data: { percent: number | null; downloadedBytes: number; totalBytes: number | null }) => void,
  signal?: AbortSignal,
): Promise<string> {
  const outputPath = updateInstallerPath(update);
  rmSync(outputPath, { force: true });

  try {
    const response = await fetch(update.url, { headers: { 'Cache-Control': 'no-cache' }, signal });
    if (!response.ok) throw new Error(`Update download returned HTTP ${response.status}`);
    if (!response.body) throw new Error('Update download did not return a readable body');

    const contentLength = response.headers.get('content-length');
    const totalBytes = contentLength ? Number(contentLength) : null;
    let downloadedBytes = 0;

    const progressTransform = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        downloadedBytes += chunk.length;
        onProgress({
          percent: totalBytes ? Math.min(99, Math.round((downloadedBytes / totalBytes) * 100)) : null,
          downloadedBytes,
          totalBytes,
        });
        callback(null, chunk);
      },
    });

    await finished(
      Readable.fromWeb(response.body as never)
        .pipe(progressTransform)
        .pipe(createWriteStream(outputPath, { mode: 0o600 })),
    );

    onProgress({ percent: 100, downloadedBytes, totalBytes: totalBytes ?? downloadedBytes });
    chmodSync(outputPath, 0o600);
    return outputPath;
  } catch (err) {
    rmSync(outputPath, { force: true });
    if (signal?.aborted) {
      const canceled = new Error('Update download canceled');
      canceled.name = 'AbortError';
      throw canceled;
    }
    throw err;
  }
}

async function showUpdateAvailablePrompt(
  update: UpdateMetadata,
  currentVersion: string,
): Promise<{ action: UpdatePromptAction; requestId: string }> {
  if (!mainWindow || mainWindow.isDestroyed()) {
    console.info('[updates] renderer window unavailable; postponing update prompt', { latestVersion: update.version });
    return { action: 'update-later', requestId: '' };
  }

  // Load release notes (non-blocking — if it fails, we still show the prompt)
  let releaseNotes: ReleaseNotesEntry | null = null;
  let releaseNotesError: string | null = null;

  try {
    const index = await getReleaseNotesIndex(update.releasesUrl);
    const entry = index.releases.find(r => r.version === update.version);
    if (entry?.sections && entry.sections.length > 0) {
      releaseNotes = entry;
      console.info('[updates] release-notes-loaded', { version: update.version, source: index.source });
    } else if (entry) {
      releaseNotes = await getReleaseNote(entry.version, entry.notesUrl);
      console.info('[updates] release-notes-loaded', { version: update.version, source: index.source });
    }
  } catch (err) {
    releaseNotesError = 'Release notes could not be loaded.';
    console.warn('[updates] release-notes-failed', { version: update.version, error: err instanceof Error ? err.message : String(err) });
  }

  return new Promise((resolvePrompt) => {
    const requestId = randomUUID();
    const timeout = setTimeout(() => {
      ipcMain.off('allen:update-prompt-response', onResponse);
      resolvePrompt({ action: 'update-later', requestId });
    }, 5 * 60_000);
    timeout.unref();

    const onResponse = (_event: Electron.IpcMainEvent, response: unknown) => {
      const payload = response as { requestId?: unknown; action?: unknown };
      if (payload?.requestId !== requestId) return;
      clearTimeout(timeout);
      ipcMain.off('allen:update-prompt-response', onResponse);
      const action: UpdatePromptAction = payload.action === 'update-now' ? 'update-now' : 'update-later';
      if (action === 'update-now') {
        pendingUpdates.set(requestId, update);
      }
      resolvePrompt({ action, requestId });
    };

    ipcMain.on('allen:update-prompt-response', onResponse);
    mainWindow!.webContents.send('allen:update-prompt', {
      requestId,
      currentVersion,
      latestVersion: update.version,
      releaseNotes,
      releaseNotesError,
    });
  });
}

async function checkForProductionUpdate(options: { manual?: boolean } = {}): Promise<UpdateCheckResult> {
  const currentVersion = app.getVersion();
  if (process.env.ALLEN_DISABLE_AUTO_UPDATE === '1') {
    return { status: 'disabled', currentVersion };
  }
  if (!options.manual && (!app.isPackaged || !readAutoUpdatePreferences().autoUpdateEnabled)) {
    return { status: 'disabled', currentVersion };
  }

  const feedUrl = process.env.ALLEN_UPDATE_FEED_URL || DEFAULT_UPDATE_FEED_URL;
  console.info('[updates] checking feed', { feedUrl, manual: options.manual === true });
  if (options.manual) {
    console.info('[updates] manual-check', { triggeredBy: 'settings' });
  }

  const response = await fetch(feedUrl, { headers: { 'Cache-Control': 'no-cache' } });
  if (!response.ok) throw new Error(`Update feed returned HTTP ${response.status}`);

  const metadata = parseUpdateMetadata(await response.json(), feedUrl);
  if (!metadata) throw new Error('Update feed did not include a valid version and HTTPS download URL');

  void getReleaseNotesIndex(metadata.releasesUrl).catch((err) => {
    console.warn('[updates] release notes refresh failed', err instanceof Error ? err.message : String(err));
  });

  if (compareReleaseVersions(metadata.version, currentVersion) <= 0) {
    console.info('[updates] no update available', { currentVersion, latestVersion: metadata.version });
    return { status: 'not-available', currentVersion, latestVersion: metadata.version };
  }

  console.info('[updates] update available', { currentVersion, latestVersion: metadata.version, url: metadata.url });
  const { action, requestId } = await showUpdateAvailablePrompt(metadata, currentVersion);

  if (action !== 'update-now') {
    console.info('[updates] user postponed update', { latestVersion: metadata.version });
    return { status: 'update-available', currentVersion, latestVersion: metadata.version, url: metadata.url, opened: false };
  }

  // Download with progress
  await doDownloadAndOpen(metadata, requestId);
  return { status: 'update-available', currentVersion, latestVersion: metadata.version, url: metadata.url, opened: true };
}

async function doDownloadAndOpen(metadata: UpdateMetadata, requestId: string): Promise<void> {
  const version = metadata.version;
  let finalBytes = 0;
  activeUpdateDownloads.get(requestId)?.abort();
  const controller = new AbortController();
  activeUpdateDownloads.set(requestId, controller);
  try {
    const dmgPath = await downloadUpdateInstaller(metadata, (progress) => {
      finalBytes = progress.downloadedBytes;
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('allen:update-download-progress', {
          requestId,
          ...progress,
          status: 'downloading',
        });
      }
    }, controller.signal);

    console.info('[updates] download-complete', { version, path: dmgPath, bytes: finalBytes });
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('allen:update-download-complete', { requestId, dmgPath });
    }

    const openError = await shell.openPath(dmgPath);
    if (openError) {
      console.error('[updates] dmg-open-failed', { version, path: dmgPath, error: openError });
    } else {
      console.info('[updates] dmg-opened', { version, path: dmgPath });
    }

    await new Promise(r => setTimeout(r, 1500));
    console.info('[updates] quitting-after-update', { version });
    app.quit();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof Error && err.name === 'AbortError') {
      console.info('[updates] download-canceled', { version, requestId });
      return;
    }
    const retryable = !/security policy|Failed to write/i.test(message);
    console.error('[updates] download-failed', { version, error: message, retryable });
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('allen:update-download-error', { requestId, error: message, retryable });
    }
  } finally {
    if (activeUpdateDownloads.get(requestId) === controller) {
      activeUpdateDownloads.delete(requestId);
    }
  }
}

ipcMain.on('allen:update-download-retry', (_event, payload: UpdateDownloadRetryPayload) => {
  const metadata = pendingUpdates.get(payload.requestId);
  if (!metadata) {
    console.warn('[updates] download-retry: no pending update found for requestId', { requestId: payload.requestId });
    return;
  }
  console.info('[updates] download-retry', { version: metadata.version, requestId: payload.requestId });
  void doDownloadAndOpen(metadata, payload.requestId);
});

ipcMain.on('allen:update-download-cancel', (_event, payload: UpdateDownloadRetryPayload) => {
  const requestId = payload.requestId;
  const controller = activeUpdateDownloads.get(requestId);
  if (!controller) {
    console.warn('[updates] download-cancel: no active download found for requestId', { requestId });
    pendingUpdates.delete(requestId);
    return;
  }
  console.info('[updates] download-cancel', { requestId });
  controller.abort();
  pendingUpdates.delete(requestId);
});

function setupAutoUpdates(): void {
  if (!app.isPackaged || process.env.ALLEN_DISABLE_AUTO_UPDATE === '1') return;
  if (!readAutoUpdatePreferences().autoUpdateEnabled) {
    console.info('[updates] automatic update checks disabled by user preference');
    return;
  }
  setTimeout(() => {
    void checkForProductionUpdate().catch((err) => {
      console.warn('[updates] check failed', err instanceof Error ? err.message : String(err));
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
