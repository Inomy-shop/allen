import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { ConfigProvider, SecretsProvider } from '@allen/server/runtime/config';

const execFileAsync = promisify(execFile);
const KEYCHAIN_SERVICE = 'Allen Desktop';
const LEGACY_SECRET_KEYS = ['JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET'];
const KEYCHAIN_TIMEOUT_MS = 8_000;
const DESKTOP_API_PORT_RANGE = { start: 48100, end: 48199 };
const DESKTOP_MONGO_PORT_RANGE = { start: 48300, end: 48399 };

export interface DesktopRuntimeConfig {
  dataDir: string;
  configPath: string;
  allenHome: string;
  workspaceBaseDir: string;
  mongoUri?: string;
  apiPort: number;
  mongoPort?: number;
  terminalWsPort: number;
  configProvider: ConfigProvider;
  secretsProvider: SecretsProvider;
}

export interface SecretStore {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface DesktopRuntimeSetupOptions {
  secretStore?: SecretStore;
  env?: NodeJS.ProcessEnv;
}

export class DesktopConfigProvider implements ConfigProvider {
  constructor(
    private readonly values: Record<string, string | undefined>,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  get(key: string): string | undefined {
    const value = this.values[key] ?? this.env[key];
    return value === '' ? undefined : value;
  }

  require(key: string): string {
    const value = this.get(key);
    if (value === undefined) throw new Error(`${key} is not set`);
    return value;
  }

  set(key: string, value: string): void {
    this.values[key] = value;
  }

  delete(key: string): void {
    delete this.values[key];
  }
}

export class DesktopSecretsProvider implements SecretsProvider {
  constructor(private readonly store: SecretStore) {}

  getSecret(key: string): Promise<string | undefined> {
    return this.store.get(key);
  }

  setSecret(key: string, value: string): Promise<void> {
    return this.store.set(key, value);
  }

  deleteSecret(key: string): Promise<void> {
    return this.store.delete(key);
  }
}

export class MacosKeychainSecretStore implements SecretStore {
  constructor(private readonly service = KEYCHAIN_SERVICE) {}

  async get(key: string): Promise<string | undefined> {
    if (process.platform !== 'darwin') return undefined;
    try {
      const { stdout } = await execFileAsync('security', [
        'find-generic-password',
        '-s',
        this.service,
        '-a',
        key,
        '-w',
      ], { timeout: KEYCHAIN_TIMEOUT_MS });
      const value = stdout.trimEnd();
      return value === '' ? undefined : value;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (String(code) === '44') return undefined;
      throw err;
    }
  }

  async set(key: string, value: string): Promise<void> {
    if (process.platform !== 'darwin') {
      throw new Error('macOS Keychain is only available on darwin');
    }
    await execFileAsync('security', [
      'add-generic-password',
      '-U',
      '-s',
      this.service,
      '-a',
      key,
      '-w',
      value,
    ], { timeout: KEYCHAIN_TIMEOUT_MS });
  }

  async delete(key: string): Promise<void> {
    if (process.platform !== 'darwin') return;
    try {
      await execFileAsync('security', [
        'delete-generic-password',
        '-s',
        this.service,
        '-a',
        key,
      ], { timeout: KEYCHAIN_TIMEOUT_MS });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (String(code) !== '44') throw err;
    }
  }
}

export class FileSecretStore implements SecretStore {
  constructor(private readonly path: string) {}

  async get(key: string): Promise<string | undefined> {
    const secrets = this.read();
    return secrets[key] || undefined;
  }

  async set(key: string, value: string): Promise<void> {
    const secrets = this.read();
    secrets[key] = value;
    this.write(secrets);
  }

  async delete(key: string): Promise<void> {
    const secrets = this.read();
    delete secrets[key];
    this.write(secrets);
  }

  private read(): Record<string, string> {
    if (!existsSync(this.path)) return {};
    try {
      return JSON.parse(readFileSync(this.path, 'utf8')) as Record<string, string>;
    } catch {
      return {};
    }
  }

  private write(secrets: Record<string, string>): void {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(secrets, null, 2) + '\n', { mode: 0o600 });
    chmodSync(this.path, 0o600);
  }
}

function readConfig(configPath: string): Record<string, string> {
  if (!existsSync(configPath)) return {};

  try {
    return JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, string>;
  } catch {
    return {};
  }
}

function writeConfig(configPath: string, config: Record<string, string>): void {
  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  chmodSync(configPath, 0o600);
}

function parsePort(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function isValidPortInRange(port: number, range: { start: number; end: number }): boolean {
  return Number.isInteger(port) && port >= range.start && port <= range.end;
}

async function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolvePort) => {
    const server = createServer();
    server.once('error', () => resolvePort(false));
    server.once('listening', () => {
      server.close(() => resolvePort(true));
    });
    server.listen(port, '127.0.0.1');
  });
}

async function stickyDesktopPort(
  savedPort: string | undefined,
  envPort: string | undefined,
  range: { start: number; end: number },
): Promise<number> {
  const requested = parsePort(envPort, 0);
  if (isValidPortInRange(requested, range) && await isPortAvailable(requested)) {
    return requested;
  }

  const saved = parsePort(savedPort, 0);
  if (isValidPortInRange(saved, range) && await isPortAvailable(saved)) {
    return saved;
  }

  const ports = Array.from({ length: range.end - range.start + 1 }, (_, i) => range.start + i);
  const offset = randomBytes(1)[0] % ports.length;
  for (let i = 0; i < ports.length; i++) {
    const port = ports[(offset + i) % ports.length];
    if (await isPortAvailable(port)) return port;
  }

  return 0;
}

export function defaultUiDistDir(compiledMainDir: string): string {
  return resolve(compiledMainDir, '../../ui/dist');
}

async function ensureSecret(
  secrets: SecretsProvider,
  key: string,
  legacyValue: string | undefined,
): Promise<string> {
  const existing = await secrets.getSecret(key);
  if (existing) return existing;

  const value = legacyValue || randomBytes(32).toString('hex');
  if (!secrets.setSecret) {
    throw new Error(`Desktop secret store cannot persist ${key}`);
  }
  await secrets.setSecret(key, value);
  return value;
}

export async function setupDesktopRuntime(
  dataDir: string,
  options: DesktopRuntimeSetupOptions = {},
): Promise<DesktopRuntimeConfig> {
  const env = options.env ?? process.env;
  mkdirSync(dataDir, { recursive: true });

  const configDir = resolve(dataDir, 'config');
  mkdirSync(configDir, { recursive: true });
  const configPath = resolve(configDir, 'desktop-runtime.json');
  const config = readConfig(configPath);
  const secretStore = options.secretStore
    ?? (env.ALLEN_DESKTOP_SECRET_STORE === 'file'
      ? new FileSecretStore(resolve(configDir, 'desktop-secrets.json'))
      : new MacosKeychainSecretStore());
  const secretsProvider = new DesktopSecretsProvider(secretStore);

  const legacySecrets: Record<string, string | undefined> = {};
  for (const key of LEGACY_SECRET_KEYS) {
    legacySecrets[key] = config[key];
    delete config[key];
  }
  const jwtAccessSecret = await ensureSecret(secretsProvider, 'JWT_ACCESS_SECRET', legacySecrets.JWT_ACCESS_SECRET);
  const jwtRefreshSecret = await ensureSecret(secretsProvider, 'JWT_REFRESH_SECRET', legacySecrets.JWT_REFRESH_SECRET);
  writeConfig(configPath, config);

  const allenRoot = resolve(nonEmpty(env.HOME) ?? homedir(), '.allen');
  const allenHome = nonEmpty(config.ALLEN_HOME) ?? nonEmpty(env.ALLEN_HOME) ?? allenRoot;
  const workspaceBaseDir = nonEmpty(config.WORKSPACE_BASE_DIR) ?? nonEmpty(env.WORKSPACE_BASE_DIR) ?? resolve(allenRoot, 'workspaces');
  const uploadsDir = nonEmpty(config.UPLOADS_DIR) ?? nonEmpty(env.UPLOADS_DIR) ?? resolve(allenRoot, 'uploads');
  const mcpBundlesDir = nonEmpty(config.MCP_BUNDLES_DIR) ?? nonEmpty(env.MCP_BUNDLES_DIR) ?? resolve(allenRoot, 'mcp-servers');
  const seedOverride = nonEmpty(config.SEED_OVERRIDE) ?? nonEmpty(env.SEED_OVERRIDE) ?? 'false';
  delete config.MONGODB_URI;
  const mongoUri = undefined;
  const apiPort = await stickyDesktopPort(config.DESKTOP_API_PORT, env.DESKTOP_API_PORT, DESKTOP_API_PORT_RANGE);
  const mongoPort = mongoUri
    ? undefined
    : await stickyDesktopPort(config.DESKTOP_MONGO_PORT, env.DESKTOP_MONGO_PORT, DESKTOP_MONGO_PORT_RANGE);
  const terminalWsPort = parsePort(nonEmpty(config.TERMINAL_WS_PORT) ?? nonEmpty(env.TERMINAL_WS_PORT), 0);
  config.DESKTOP_API_PORT = String(apiPort);
  if (mongoPort !== undefined) config.DESKTOP_MONGO_PORT = String(mongoPort);
  else delete config.DESKTOP_MONGO_PORT;
  writeConfig(configPath, config);

  const runtimeValues: Record<string, string | undefined> = {
    ...config,
    ALLEN_DESKTOP: '1',
    ALLEN_DESKTOP_CONFIG_PATH: configPath,
    ALLEN_HOME: allenHome,
    WORKSPACE_BASE_DIR: workspaceBaseDir,
    UPLOADS_DIR: uploadsDir,
    MCP_BUNDLES_DIR: mcpBundlesDir,
    SEED_OVERRIDE: seedOverride,
    MONGODB_URI: mongoUri,
    TERMINAL_WS_PORT: String(terminalWsPort),
    JWT_ACCESS_SECRET: jwtAccessSecret,
    JWT_REFRESH_SECRET: jwtRefreshSecret,
  };
  const configProvider = new DesktopConfigProvider(runtimeValues, env);

  for (const [key, value] of Object.entries(config)) {
    if (value === undefined || value === '') delete env[key];
    else env[key] = value;
  }
  env.ALLEN_DESKTOP = '1';
  env.ALLEN_DESKTOP_CONFIG_PATH = configPath;
  env.ALLEN_HOME = allenHome;
  env.WORKSPACE_BASE_DIR = workspaceBaseDir;
  env.UPLOADS_DIR = uploadsDir;
  env.MCP_BUNDLES_DIR = mcpBundlesDir;
  env.SEED_OVERRIDE = seedOverride;
  env.DESKTOP_API_PORT = String(apiPort);
  if (mongoPort !== undefined) env.DESKTOP_MONGO_PORT = String(mongoPort);
  else delete env.DESKTOP_MONGO_PORT;
  if (mongoUri) env.MONGODB_URI = mongoUri;
  else delete env.MONGODB_URI;
  env.TERMINAL_WS_PORT = String(terminalWsPort);
  env.JWT_ACCESS_SECRET = jwtAccessSecret;
  env.JWT_REFRESH_SECRET = jwtRefreshSecret;
  delete env.ALLEN_API_URL;
  delete env.ALLEN_INTERNAL_API_URL;

  mkdirSync(allenHome, { recursive: true });
  mkdirSync(workspaceBaseDir, { recursive: true });
  mkdirSync(uploadsDir, { recursive: true });
  mkdirSync(mcpBundlesDir, { recursive: true });

  return {
    dataDir,
    configPath,
    allenHome,
    workspaceBaseDir,
    mongoUri,
    apiPort,
    mongoPort,
    terminalWsPort,
    configProvider,
    secretsProvider,
  };
}
