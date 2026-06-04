import { afterEach, describe, expect, it } from 'vitest';
import { MongoClient } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startAllenServer, type AllenServerHandle } from './server.js';
import { resetRuntimeProvidersForTests } from './runtime/config.js';

describe('startAllenServer', () => {
  let handle: AllenServerHandle | null = null;
  let client: MongoClient | null = null;
  let mongo: MongoMemoryServer | null = null;
  let staticUiDir: string | null = null;
  const originalPort = process.env.PORT;
  const originalAllenApiUrl = process.env.ALLEN_API_URL;
  const originalAllenInternalApiUrl = process.env.ALLEN_INTERNAL_API_URL;

  afterEach(async () => {
    if (handle) {
      await handle.stop();
      handle = null;
    }
    if (client) {
      await client.close();
      client = null;
    }
    if (mongo) {
      await mongo.stop();
      mongo = null;
    }
    if (staticUiDir) {
      await rm(staticUiDir, { recursive: true, force: true });
      staticUiDir = null;
    }
    if (originalPort === undefined) delete process.env.PORT;
    else process.env.PORT = originalPort;
    if (originalAllenApiUrl === undefined) delete process.env.ALLEN_API_URL;
    else process.env.ALLEN_API_URL = originalAllenApiUrl;
    if (originalAllenInternalApiUrl === undefined) delete process.env.ALLEN_INTERNAL_API_URL;
    else process.env.ALLEN_INTERNAL_API_URL = originalAllenInternalApiUrl;
    resetRuntimeProvidersForTests();
  });

  it('starts on a dynamic port and exposes a stop handle', async () => {
    mongo = await MongoMemoryServer.create();
    client = new MongoClient(mongo.getUri());
    await client.connect();
    const db = client.db('allen-server-test');

    handle = await startAllenServer({
      mode: 'desktop',
      host: '127.0.0.1',
      port: 0,
      db,
      runBootTasks: false,
      startBackgroundServices: false,
      startTerminalServer: false,
    });

    expect(handle.port).toBeGreaterThan(0);
    expect(handle.baseUrl).toBe(`http://127.0.0.1:${handle.port}`);
    expect(process.env.PORT).toBe(String(handle.port));

    const res = await fetch(`${handle.baseUrl}/api/health`);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ status: 'ok' });

    await handle.stop();
    handle = null;
  });

  it('serves a packaged static UI and rewrites app routes', async () => {
    mongo = await MongoMemoryServer.create();
    client = new MongoClient(mongo.getUri());
    await client.connect();
    const db = client.db('allen-server-static-test');
    staticUiDir = await mkdtemp(join(tmpdir(), 'allen-static-ui-'));
    await writeFile(join(staticUiDir, 'index.html'), '<!doctype html><div id="root">Allen UI</div>\n');

    handle = await startAllenServer({
      mode: 'desktop',
      host: '127.0.0.1',
      port: 0,
      db,
      runBootTasks: false,
      startBackgroundServices: false,
      startTerminalServer: false,
      staticUiDir,
    });

    const root = await fetch(`${handle.baseUrl}/`);
    expect(root.status).toBe(200);
    await expect(root.text()).resolves.toContain('Allen UI');

    const appRoute = await fetch(`${handle.baseUrl}/chat`);
    expect(appRoute.status).toBe(200);
    await expect(appRoute.text()).resolves.toContain('Allen UI');

    const health = await fetch(`${handle.baseUrl}/api/health`);
    expect(health.status).toBe(200);

    await handle.stop();
    handle = null;
  });

  it('overrides inherited API URLs in desktop mode', async () => {
    process.env.ALLEN_API_URL = 'http://127.0.0.1:4023';
    process.env.ALLEN_INTERNAL_API_URL = 'http://127.0.0.1:4023';
    mongo = await MongoMemoryServer.create();
    client = new MongoClient(mongo.getUri());
    await client.connect();

    handle = await startAllenServer({
      mode: 'desktop',
      host: '127.0.0.1',
      port: 0,
      db: client.db('allen-server-desktop-url-test'),
      runBootTasks: false,
      startBackgroundServices: false,
      startTerminalServer: false,
    });

    expect(process.env.ALLEN_API_URL).toBe(handle.baseUrl);
    expect(process.env.ALLEN_INTERNAL_API_URL).toBe(handle.baseUrl);

    await handle.stop();
    handle = null;
  });
});
