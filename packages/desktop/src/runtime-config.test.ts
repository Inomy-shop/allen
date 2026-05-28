import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultUiDistDir, FileSecretStore, setupDesktopRuntime, type SecretStore } from './runtime-config.js';

const envKeys = [
  'ALLEN_DESKTOP',
  'ALLEN_DESKTOP_CONFIG_PATH',
  'ALLEN_API_URL',
  'ALLEN_INTERNAL_API_URL',
  'ALLEN_HOME',
  'WORKSPACE_BASE_DIR',
  'UPLOADS_DIR',
  'SEED_OVERRIDE',
  'MONGODB_URI',
  'DESKTOP_API_PORT',
  'DESKTOP_MONGO_PORT',
  'TERMINAL_WS_PORT',
  'JWT_ACCESS_SECRET',
  'JWT_REFRESH_SECRET',
  'ALLEN_DESKTOP_SECRET_STORE',
  'HOME',
];

class MemorySecretStore implements SecretStore {
  readonly values = new Map<string, string>();

  async get(key: string): Promise<string | undefined> {
    return this.values.get(key);
  }

  async set(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }
}

describe('desktop runtime config', () => {
  let tmp: string | null = null;
  let originalEnv: Record<string, string | undefined>;
  let secrets: MemorySecretStore;
  let heldServers: Server[] = [];

  beforeEach(async () => {
    originalEnv = {};
    for (const key of envKeys) {
      originalEnv[key] = process.env[key];
      delete process.env[key];
    }
    secrets = new MemorySecretStore();
    tmp = await mkdtemp(join(tmpdir(), 'allen-desktop-runtime-'));
    process.env.HOME = tmp;
  });

  afterEach(async () => {
    for (const key of envKeys) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
    if (tmp) {
      await rm(tmp, { recursive: true, force: true });
      tmp = null;
    }
    await Promise.all(heldServers.map(server => new Promise<void>((resolveClose) => server.close(() => resolveClose()))));
    heldServers = [];
  });

  async function holdPort(port: number): Promise<void> {
    const server = createServer();
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once('error', rejectListen);
      server.listen(port, '127.0.0.1', () => resolveListen());
    });
    heldServers.push(server);
  }

  it('creates stable local runtime secrets and isolated defaults', async () => {
    const runtime = await setupDesktopRuntime(tmp!, { secretStore: secrets });
    const config = JSON.parse(await readFile(runtime.configPath, 'utf8')) as Record<string, string>;

    expect(process.env.ALLEN_DESKTOP).toBe('1');
    expect(runtime.allenHome).toBe(resolve(tmp!, '.allen'));
    expect(runtime.workspaceBaseDir).toBe(resolve(tmp!, '.allen/workspaces'));
    expect(runtime.mongoUri).toBeUndefined();
    expect(runtime.apiPort).toBeGreaterThanOrEqual(48100);
    expect(runtime.apiPort).toBeLessThanOrEqual(48199);
    expect(runtime.mongoPort).toBeGreaterThanOrEqual(48300);
    expect(runtime.mongoPort).toBeLessThanOrEqual(48399);
    expect(process.env.MONGODB_URI).toBeUndefined();
    expect(process.env.DESKTOP_API_PORT).toBe(String(runtime.apiPort));
    expect(process.env.DESKTOP_MONGO_PORT).toBe(String(runtime.mongoPort));
    expect(process.env.SEED_OVERRIDE).toBe('true');
    expect(runtime.configProvider.get('SEED_OVERRIDE')).toBe('true');
    expect(runtime.terminalWsPort).toBe(0);
    expect(config.JWT_ACCESS_SECRET).toBeUndefined();
    expect(config.JWT_REFRESH_SECRET).toBeUndefined();
    expect(await secrets.get('JWT_ACCESS_SECRET')).toHaveLength(64);
    expect(await secrets.get('JWT_REFRESH_SECRET')).toHaveLength(64);
    expect(process.env.JWT_ACCESS_SECRET).toBe(await secrets.get('JWT_ACCESS_SECRET'));
    expect(runtime.configProvider.require('JWT_ACCESS_SECRET')).toBe(await secrets.get('JWT_ACCESS_SECRET'));

    const firstAccessSecret = await secrets.get('JWT_ACCESS_SECRET');
    const firstRefreshSecret = await secrets.get('JWT_REFRESH_SECRET');
    const second = await setupDesktopRuntime(tmp!, { secretStore: secrets });
    const secondConfig = JSON.parse(await readFile(second.configPath, 'utf8')) as Record<string, string>;
    expect(second.apiPort).toBe(runtime.apiPort);
    expect(second.mongoPort).toBe(runtime.mongoPort);
    expect(secondConfig.JWT_ACCESS_SECRET).toBeUndefined();
    expect(secondConfig.JWT_REFRESH_SECRET).toBeUndefined();
    expect(await secrets.get('JWT_ACCESS_SECRET')).toBe(firstAccessSecret);
    expect(await secrets.get('JWT_REFRESH_SECRET')).toBe(firstRefreshSecret);
  });

  it('respects explicit operator overrides except MongoDB, which is desktop-managed', async () => {
    process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/custom_allen';
    process.env.DESKTOP_API_PORT = '48123';
    process.env.TERMINAL_WS_PORT = '51234';
    process.env.SEED_OVERRIDE = 'false';

    const runtime = await setupDesktopRuntime(tmp!, { secretStore: secrets });

    expect(runtime.mongoUri).toBeUndefined();
    expect(runtime.apiPort).toBe(48123);
    expect(runtime.mongoPort).toBeGreaterThanOrEqual(48300);
    expect(process.env.DESKTOP_MONGO_PORT).toBe(String(runtime.mongoPort));
    expect(process.env.MONGODB_URI).toBeUndefined();
    expect(runtime.terminalWsPort).toBe(51234);
    expect(process.env.SEED_OVERRIDE).toBe('false');
    expect(runtime.configProvider.get('SEED_OVERRIDE')).toBe('false');
  });

  it('treats empty persisted values as unset so managed Mongo can start', async () => {
    const configDir = resolve(tmp!, 'config');
    await mkdir(configDir, { recursive: true });
    await writeFile(resolve(configDir, 'desktop-runtime.json'), JSON.stringify({
      ALLEN_HOME: '',
      WORKSPACE_BASE_DIR: '',
      UPLOADS_DIR: '',
      MCP_BUNDLES_DIR: '',
      MONGODB_URI: '',
      TERMINAL_WS_PORT: '',
    }));

    const runtime = await setupDesktopRuntime(tmp!, { secretStore: secrets });

    expect(runtime.allenHome).toBe(resolve(tmp!, '.allen'));
    expect(runtime.workspaceBaseDir).toBe(resolve(tmp!, '.allen/workspaces'));
    expect(runtime.mongoUri).toBeUndefined();
    expect(runtime.mongoPort).toBeGreaterThanOrEqual(48300);
    expect(process.env.MONGODB_URI).toBeUndefined();
    expect(runtime.terminalWsPort).toBe(0);
  });

  it('reassigns sticky desktop ports when the saved port is busy', async () => {
    const configDir = resolve(tmp!, 'config');
    await mkdir(configDir, { recursive: true });
    await writeFile(resolve(configDir, 'desktop-runtime.json'), JSON.stringify({
      DESKTOP_API_PORT: '48100',
      DESKTOP_MONGO_PORT: '48300',
    }));
    await holdPort(48100);
    await holdPort(48300);

    const runtime = await setupDesktopRuntime(tmp!, { secretStore: secrets });
    const config = JSON.parse(await readFile(runtime.configPath, 'utf8')) as Record<string, string>;

    expect(runtime.apiPort).not.toBe(48100);
    expect(runtime.mongoPort).not.toBe(48300);
    expect(runtime.apiPort).toBeGreaterThanOrEqual(48100);
    expect(runtime.mongoPort).toBeGreaterThanOrEqual(48300);
    expect(config.DESKTOP_API_PORT).toBe(String(runtime.apiPort));
    expect(config.DESKTOP_MONGO_PORT).toBe(String(runtime.mongoPort));
  });

  it('can use an app-data file secret store for packaged QA isolation', async () => {
    const storePath = resolve(tmp!, 'config', 'desktop-secrets.json');
    const store = new FileSecretStore(storePath);

    await store.set('SMOKE_SECRET', 'value');
    expect(await store.get('SMOKE_SECRET')).toBe('value');

    await store.delete('SMOKE_SECRET');
    expect(await store.get('SMOKE_SECRET')).toBeUndefined();
  });

  it('migrates legacy runtime JSON secrets into the secret store', async () => {
    const configDir = resolve(tmp!, 'config');
    await mkdir(configDir, { recursive: true });
    await writeFile(resolve(configDir, 'desktop-runtime.json'), JSON.stringify({
      JWT_ACCESS_SECRET: 'legacy-access',
      JWT_REFRESH_SECRET: 'legacy-refresh',
      ACCESS_TOKEN_TTL: '2h',
    }));

    const runtime = await setupDesktopRuntime(tmp!, { secretStore: secrets });
    const config = JSON.parse(await readFile(runtime.configPath, 'utf8')) as Record<string, string>;

    expect(await secrets.get('JWT_ACCESS_SECRET')).toBe('legacy-access');
    expect(await secrets.get('JWT_REFRESH_SECRET')).toBe('legacy-refresh');
    expect(config.JWT_ACCESS_SECRET).toBeUndefined();
    expect(config.JWT_REFRESH_SECRET).toBeUndefined();
    expect(config.ACCESS_TOKEN_TTL).toBe('2h');
    expect(runtime.configProvider.get('ACCESS_TOKEN_TTL')).toBe('2h');
  });

  it('clears inherited API URLs so desktop points at its own dynamic server', async () => {
    process.env.ALLEN_API_URL = 'http://127.0.0.1:4023';
    process.env.ALLEN_INTERNAL_API_URL = 'http://127.0.0.1:4023';

    await setupDesktopRuntime(tmp!, { secretStore: secrets });

    expect(process.env.ALLEN_API_URL).toBeUndefined();
    expect(process.env.ALLEN_INTERNAL_API_URL).toBeUndefined();
  });

  it('resolves the packaged UI dist directory from compiled main dir', () => {
    expect(defaultUiDistDir('/repo/packages/desktop/dist')).toBe('/repo/packages/ui/dist');
  });
});
