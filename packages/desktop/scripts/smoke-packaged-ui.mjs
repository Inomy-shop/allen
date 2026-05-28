import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';

const scriptPath = fileURLToPath(import.meta.url);
const desktopDir = resolve(scriptPath, '..', '..');
const executable = process.env.ALLEN_DESKTOP_APP_EXECUTABLE
  ?? resolve(desktopDir, 'release', 'mac-arm64', 'Allen.app', 'Contents', 'MacOS', 'Allen');

const timeoutMs = Number.parseInt(process.env.ALLEN_DESKTOP_UI_SMOKE_TIMEOUT_MS ?? '120000', 10);

if (!existsSync(executable)) {
  console.error(`[desktop-ui-smoke] Missing packaged app executable: ${executable}`);
  process.exit(1);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function visible(page, text) {
  return page.getByText(text).first().isVisible().catch(() => false);
}

function createFixtureRepo(rootDir) {
  const repoDir = join(rootDir, 'repo');
  execFileSync('git', ['init', repoDir], { stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'desktop-smoke@askallen.build'], { cwd: repoDir });
  execFileSync('git', ['config', 'user.name', 'Desktop Smoke'], { cwd: repoDir });
  writeFileSync(join(repoDir, 'README.md'), '# Allen desktop smoke\n');
  execFileSync('git', ['add', 'README.md'], { cwd: repoDir });
  execFileSync('git', ['commit', '-m', 'initial'], { cwd: repoDir, stdio: 'ignore' });
  return repoDir;
}

function createFixtureMcpServer(repoDir) {
  const serverPath = join(repoDir, 'smoke-mcp-server.cjs');
  writeFileSync(serverPath, `const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
function respond(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n');
}
rl.on('line', (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') {
    respond(msg.id, {
      protocolVersion: '2024-11-05',
      capabilities: {},
      serverInfo: { name: 'allen-desktop-smoke-mcp', version: '1.0.0' },
    });
    return;
  }
  if (msg.method === 'tools/list') {
    if (process.env.SMOKE_SECRET !== 'desktop-ui-smoke-mcp-secret') {
      throw new Error('missing SMOKE_SECRET');
    }
    respond(msg.id, {
      tools: [{
        name: 'smoke_echo',
        description: 'Smoke-test tool',
        inputSchema: { type: 'object', properties: {} },
      }],
    });
    return;
  }
  respond(msg.id, {});
});
`, { mode: 0o700 });
  return serverPath;
}

async function run() {
  const fixtureRoot = mkdtempSync(resolve(tmpdir(), 'allen-desktop-ui-smoke-'));
  const userDataDir = join(fixtureRoot, 'profile');
  const repoDir = createFixtureRepo(fixtureRoot);
  createFixtureMcpServer(repoDir);
  const supportBundlePath = join(fixtureRoot, 'support-bundle.json');
  let app;
  try {
    app = await electron.launch({
      executablePath: executable,
      args: ['--disable-gpu'],
      env: {
        ...process.env,
        ALLEN_DISABLE_AUTO_UPDATE: '1',
        ALLEN_DESKTOP_ALLOW_TEST_SUPPORT_BUNDLE: '1',
        ALLEN_DESKTOP_SECRET_STORE: 'file',
        ALLEN_DESKTOP_USER_DATA_DIR: userDataDir,
        ELECTRON_ENABLE_LOGGING: '1',
      },
      timeout: timeoutMs,
    });

    const page = await app.firstWindow({ timeout: timeoutMs });
    page.setDefaultTimeout(60_000);
    page.on('console', (msg) => {
      const text = msg.text();
      if (msg.type() === 'error') console.error(`[desktop-ui-smoke:console] ${text}`);
    });

    await page.waitForLoadState('domcontentloaded');
    await page.waitForURL(/127\.0\.0\.1/, { timeout: timeoutMs });

    const runtimeInfo = await page.evaluate(async () => {
      const bridge = window.allenDesktop;
      if (!bridge) return null;
      return bridge.getRuntimeInfo();
    });
    assert(runtimeInfo, 'Desktop preload bridge is unavailable');
    assert(runtimeInfo.mode === 'desktop', 'Desktop runtime mode was not reported');
    assert(runtimeInfo.serverUrl?.startsWith('http://127.0.0.1:'), 'Desktop server URL was not local');
    assert(runtimeInfo.mongoManaged === true, 'Packaged UI smoke expected managed MongoDB');
    assert(runtimeInfo.logsDir, 'Desktop logs directory was not reported');

    await page.waitForFunction(() => document.body.innerText.includes('Create the first admin account')
      || document.body.innerText.includes('Sign in'), null, { timeout: timeoutMs });

    assert(await visible(page, 'Create the first admin account'), 'Fresh packaged profile did not reach first-run onboarding');

    const inputs = page.locator('input');
    await inputs.nth(0).fill('Desktop Smoke Admin');
    await inputs.nth(1).fill('desktop-smoke@askallen.build');
    await inputs.nth(2).fill('AllenSmoke1!');
    await inputs.nth(3).fill('AllenSmoke1!');
    await page.getByRole('button', { name: /Create admin account/i }).click();

    await page.waitForURL(/\/onboarding\/health/, { timeout: timeoutMs });
    await page.getByRole('heading', { name: /Verify this machine/i }).waitFor({ timeout: timeoutMs });

    const healthResponse = await page.evaluate(async () => {
      const response = await fetch('/api/system/health');
      return { ok: response.ok, status: response.status };
    });
    assert(healthResponse.ok, `Health endpoint failed with status ${healthResponse.status}`);

    const qaResult = await page.evaluate(async ({ repoDir, supportBundlePath }) => {
      const sessionRaw = localStorage.getItem('allen.auth.v1');
      if (!sessionRaw) throw new Error('No stored auth session after bootstrap');
      const { accessToken } = JSON.parse(sessionRaw);
      if (!accessToken) throw new Error('No access token after bootstrap');

      const authFetch = async (path, options = {}) => {
        const headers = {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
          ...(options.headers ?? {}),
        };
        const response = await fetch(`/api${path}`, { ...options, headers });
        const body = response.status === 204 ? null : await response.json().catch(() => null);
        if (!response.ok) {
          throw new Error(`${path} failed: ${response.status} ${body?.error ?? ''}`);
        }
        return body;
      };

      const runtimeInfo = await window.allenDesktop.getRuntimeInfo();

      const secretKey = 'ALLEN_SLACK_SIGNING_SECRET';
      await authFetch('/system/desktop-runtime/secrets', {
        method: 'PUT',
        body: JSON.stringify({ key: secretKey, value: 'desktop-ui-smoke-secret' }),
      });
      const configuredRuntime = await authFetch('/system/desktop-runtime');
      const configuredSecret = configuredRuntime.secrets.find((secret) => secret.key === secretKey);
      if (!configuredSecret?.configured || configuredSecret.source !== 'secret') {
        throw new Error('Settings secret save was not reflected in runtime config');
      }
      await authFetch(`/system/desktop-runtime/secrets/${encodeURIComponent(secretKey)}`, { method: 'DELETE' });
      const deletedRuntime = await authFetch('/system/desktop-runtime');
      const deletedSecret = deletedRuntime.secrets.find((secret) => secret.key === secretKey);
      if (deletedSecret?.configured) {
        throw new Error('Settings secret delete was not reflected in runtime config');
      }

      const chatSession = await authFetch('/chat/sessions', {
        method: 'POST',
        body: JSON.stringify({ provider: 'codex' }),
      });
      const chatSessionId = String(chatSession._id);
      const streamResponse = await fetch(`/api/chat/sessions/${chatSessionId}/stream`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!streamResponse.ok || !streamResponse.body) {
        throw new Error(`Chat stream failed to open: ${streamResponse.status}`);
      }
      const streamReader = streamResponse.body.getReader();
      const streamDecoder = new TextDecoder();
      let streamText = '';
      for (let i = 0; i < 10 && !streamText.includes('stream_inactive'); i++) {
        const { value, done } = await streamReader.read();
        if (done) break;
        streamText += streamDecoder.decode(value, { stream: true });
      }
      await streamReader.cancel().catch(() => {});
      if (!streamText.includes('event: stream_inactive')) {
        throw new Error(`Chat SSE stream did not emit stream_inactive: ${streamText.slice(0, 200)}`);
      }
      const savedChatSession = await authFetch(`/chat/sessions/${chatSessionId}`);
      if (String(savedChatSession._id) !== chatSessionId) {
        throw new Error('Created chat session could not be read back');
      }

      const repo = await authFetch('/repos', {
        method: 'POST',
        body: JSON.stringify({ path: repoDir, name: 'Desktop Smoke Repo' }),
      });
      const repoId = String(repo._id);
      const terminalUrl = new URL(`/ws/repos/${repoId}/terminal/smoke`, runtimeInfo.terminalWsUrl);
      const terminalMarker = '__ALLEN_TERMINAL_SMOKE__';
      await new Promise((resolve, reject) => {
        const ws = new WebSocket(terminalUrl.toString());
        let output = '';
        let sent = false;
        const timer = setTimeout(() => {
          try { ws.close(); } catch {}
          reject(new Error(`Terminal smoke timed out. Output: ${output.slice(-500)}`));
        }, 30_000);
        const sendCommand = () => {
          if (sent || ws.readyState !== WebSocket.OPEN) return;
          sent = true;
          ws.send(`printf "${terminalMarker}\\n"\\r`);
        };
        ws.onopen = () => {
          setTimeout(sendCommand, 500);
        };
        ws.onmessage = (event) => {
          output += String(event.data);
          sendCommand();
          if (output.includes(terminalMarker)) {
            clearTimeout(timer);
            ws.close();
            resolve();
          }
        };
        ws.onerror = () => {
          clearTimeout(timer);
          reject(new Error('Terminal WebSocket errored'));
        };
        ws.onclose = () => {
          if (!output.includes(terminalMarker)) {
            clearTimeout(timer);
            reject(new Error(`Terminal WebSocket closed before marker. Output: ${output.slice(-500)}`));
          }
        };
      });

      const mcpName = `desktop-smoke-${Date.now()}`;
      const mcpServer = await authFetch('/mcp/servers', {
        method: 'POST',
        body: JSON.stringify({
          name: mcpName,
          description: 'Desktop packaged UI smoke MCP',
          type: 'stdio',
          enabled: true,
          source: { kind: 'repo', repoId, entryPath: 'smoke-mcp-server.cjs' },
          command: 'node',
          envKeys: ['SMOKE_SECRET'],
          credentials: { ALLEN_SMOKE_SECRET: 'desktop-ui-smoke-mcp-secret' },
        }),
      });
      const mcpId = String(mcpServer._id);
      const mcpServers = await authFetch('/mcp/servers');
      if (!mcpServers.some((server) => String(server._id) === mcpId)) {
        throw new Error('Created MCP server was not returned by list');
      }
      const mcpTest = await authFetch(`/mcp/servers/${mcpId}/test`, { method: 'POST' });
      if (mcpTest.status !== 'connected' || mcpTest.toolCount !== 1) {
        throw new Error(`MCP smoke test failed: ${JSON.stringify(mcpTest)}`);
      }
      await authFetch(`/mcp/servers/${mcpId}`, { method: 'DELETE' });

      const supportBundle = await window.allenDesktop.exportSupportBundle(supportBundlePath);
      if (!supportBundle.ok || supportBundle.path !== supportBundlePath || !supportBundle.bytes) {
        throw new Error(`Support bundle export failed: ${JSON.stringify(supportBundle)}`);
      }

      return {
        chatSessionId,
        repoId,
        terminalUrl: terminalUrl.toString(),
        mcpStatus: mcpTest.status,
        supportBundlePath: supportBundle.path,
      };
    }, { repoDir, supportBundlePath });

    assert(existsSync(supportBundlePath), 'Support bundle file was not created');
    const supportBundleText = readFileSync(supportBundlePath, 'utf8');
    const supportBundle = JSON.parse(supportBundleText);
    assert(supportBundle.schemaVersion === 1, 'Support bundle schema version was not written');
    assert(supportBundle.runtime?.mode === 'desktop', 'Support bundle did not include desktop runtime mode');
    assert(supportBundle.health?.['/api/health']?.ok === true, 'Support bundle did not capture API health');
    assert(!supportBundleText.includes('desktop-ui-smoke-secret'), 'Support bundle leaked a test secret');
    assert(!supportBundleText.includes('desktop-ui-smoke-mcp-secret'), 'Support bundle leaked a test MCP secret');

    console.log('[desktop-ui-smoke] Packaged UI smoke check passed', {
      serverUrl: runtimeInfo.serverUrl,
      logsDir: runtimeInfo.logsDir,
      mongoDbPath: runtimeInfo.mongoDbPath,
      chatSessionId: qaResult.chatSessionId,
      repoId: qaResult.repoId,
      mcpStatus: qaResult.mcpStatus,
      supportBundlePath: qaResult.supportBundlePath,
    });
  } finally {
    if (app) await app.close().catch(() => {});
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

run().catch((err) => {
  console.error('[desktop-ui-smoke] Failed', err);
  process.exit(1);
});
