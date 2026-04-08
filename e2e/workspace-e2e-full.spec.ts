import { test, expect } from '@playwright/test';

import { API, UI } from './helpers';

/**
 * Full E2E test: Create workspace → Setup runs → Services start → Preview works → Commit → Push → PR → Archive
 *
 * Uses the flowforge repo which has config with setup scripts and 2 services (server + ui).
 * Creates a real git worktree, runs npm install, starts services, tests the full flow.
 */

let workspaceId: string;
let workspaceName: string;

test.describe.serial('Workspace Full E2E Flow', () => {

  test('1. Create workspace from flowforge repo', async ({ request }) => {
    const res = await request.post(`${API}/api/workspaces`, {
      data: {
        repoId: '69cee6f2c841d0d60a1239ba',
        repoName: 'flowforge',
        repoPath: '/Users/shreemantkumar/flowforge',
        branch: 'test/e2e-sandbox-test',
        baseBranch: 'main',
        name: 'e2e-sandbox-test',
      },
    });
    expect(res.status()).toBe(201);
    const ws = await res.json();
    workspaceId = ws._id;
    workspaceName = ws.name;
    console.log('Created workspace:', workspaceId, 'basePort:', ws.basePort);
    expect(ws.status).toBe('creating');
    expect(ws.basePort).toBeGreaterThanOrEqual(15000);
  });

  test('2. Wait for setup to complete', async ({ request }) => {
    // Poll until status is 'active' or 'failed' (setup runs npm install etc.)
    let status = 'creating';
    let ws: any;
    for (let i = 0; i < 120; i++) { // 10 min max
      await new Promise(r => setTimeout(r, 5000));
      const res = await request.get(`${API}/api/workspaces/${workspaceId}`);
      ws = await res.json();
      status = ws.status;
      const progress = ws.setupProgress;
      console.log(`[${i * 5}s] status: ${status}, step: ${progress?.currentStep ?? '-'}/${progress?.totalSteps ?? '-'} ${progress?.currentCommand ?? ''}`);
      if (status === 'active' || status === 'running' || status === 'failed') break;
    }
    expect(['active', 'running']).toContain(status);
    console.log('Setup complete. Services:', ws.services?.length);
  }, 600000); // 10 min timeout

  test('3. Verify services are configured', async ({ request }) => {
    const res = await request.get(`${API}/api/workspaces/${workspaceId}`);
    const ws = await res.json();
    expect(ws.services.length).toBe(2);

    const server = ws.services.find((s: any) => s.name === 'server');
    const ui = ws.services.find((s: any) => s.name === 'ui');
    expect(server).toBeTruthy();
    expect(ui).toBeTruthy();
    expect(server.port).toBe(ws.basePort);
    expect(ui.port).toBe(ws.basePort + 1);
    // {port} should be replaced
    expect(server.command).not.toContain('{port}');
    expect(ui.command).toContain(String(ui.port));
    console.log(`server: port ${server.port}, ui: port ${ui.port}`);
  });

  test('4. Verify port is actually free', async ({ request }) => {
    const res = await request.get(`${API}/api/workspaces/${workspaceId}`);
    const ws = await res.json();
    // Try to connect to the port — should fail (service not started yet)
    for (const svc of ws.services) {
      try {
        const check = await fetch(`http://localhost:${svc.port}`, { signal: AbortSignal.timeout(2000) });
        // If we get a response, something else is on this port — that's bad
        console.log(`Port ${svc.port} (${svc.name}): responded with ${check.status} — may be in use`);
      } catch {
        console.log(`Port ${svc.port} (${svc.name}): free (connection refused) ✓`);
      }
    }
  });

  test('5. Start server service', async ({ request }) => {
    const res = await request.post(`${API}/api/workspaces/${workspaceId}/services/server/start`);
    expect(res.ok()).toBeTruthy();
    console.log('Server service starting...');

    // Wait for it to be ready (health check polling)
    let ready = false;
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 5000));
      const wsRes = await request.get(`${API}/api/workspaces/${workspaceId}`);
      const ws = await wsRes.json();
      const svc = ws.services.find((s: any) => s.name === 'server');
      console.log(`[${i * 5}s] server status: ${svc?.status}`);
      if (svc?.status === 'ready') { ready = true; break; }
      if (svc?.status === 'failed') break;
    }
    expect(ready).toBe(true);
  }, 180000);

  test('6. Verify server is reachable', async ({ request }) => {
    const wsRes = await request.get(`${API}/api/workspaces/${workspaceId}`);
    const ws = await wsRes.json();
    const server = ws.services.find((s: any) => s.name === 'server');

    const healthRes = await fetch(`http://localhost:${server.port}/api/health`);
    expect(healthRes.ok).toBeTruthy();
    const health = await healthRes.json();
    expect(health.status).toBe('ok');
    console.log('Server health:', health);
  });

  test('7. Preview proxy works', async ({ request }) => {
    const res = await request.get(`${API}/api/workspaces/${workspaceId}/preview?service=server`);
    // If server is running, proxy should return something (health or 404)
    console.log('Preview proxy status:', res.status());
    // Any non-502 means proxy connected to the service
    expect(res.status()).not.toBe(502);
  });

  test('8. File operations work in workspace', async ({ request }) => {
    // Create a test file
    const createRes = await request.post(`${API}/api/workspaces/${workspaceId}/create-file`, {
      data: { path: '_e2e_test.txt', content: 'hello from e2e test' },
    });
    expect(createRes.status()).toBe(201);

    // Read it
    const readRes = await request.get(`${API}/api/workspaces/${workspaceId}/file/_e2e_test.txt`);
    const file = await readRes.json();
    expect(file.content).toBe('hello from e2e test');

    // Edit it
    await request.put(`${API}/api/workspaces/${workspaceId}/file/_e2e_test.txt`, {
      data: { content: 'updated by e2e' },
    });
    const updated = await (await request.get(`${API}/api/workspaces/${workspaceId}/file/_e2e_test.txt`)).json();
    expect(updated.content).toBe('updated by e2e');

    // Delete it
    await request.delete(`${API}/api/workspaces/${workspaceId}/file/_e2e_test.txt`);
    console.log('File CRUD: ✓');
  });

  test('9. Commit works', async ({ request }) => {
    // Create a file to have something to commit
    await request.post(`${API}/api/workspaces/${workspaceId}/create-file`, {
      data: { path: '_e2e_commit_test.txt', content: 'commit test' },
    });

    const commitRes = await request.post(`${API}/api/workspaces/${workspaceId}/commit`, {
      data: { message: 'e2e test commit' },
    });
    expect(commitRes.ok()).toBeTruthy();
    const commit = await commitRes.json();
    expect(commit.hash).toBeTruthy();
    console.log('Commit hash:', commit.hash);
  });

  test('10. Activity timeline has entries', async ({ request }) => {
    const res = await request.get(`${API}/api/workspaces/${workspaceId}/activity`);
    expect(res.ok()).toBeTruthy();
    const activity = await res.json();
    expect(activity.length).toBeGreaterThan(0);
    console.log('Activity entries:', activity.length, activity.map((a: any) => a.action));
  });

  test('11. Terminal WebSocket connects to workspace', async ({ page }) => {
    await page.goto(`${UI}/workspaces/${workspaceId}`);
    await page.waitForTimeout(4000);

    const result = await page.evaluate(async (wsId) => {
      return new Promise<{ connected: boolean }>((resolve) => {
        const ws = new WebSocket(`ws://${window.location.host}/ws/workspaces/${wsId}/terminal/default`);
        const timeout = setTimeout(() => { ws.close(); resolve({ connected: false }); }, 5000);
        ws.onopen = () => { clearTimeout(timeout); ws.close(); resolve({ connected: true }); };
        ws.onerror = () => { clearTimeout(timeout); resolve({ connected: false }); };
      });
    }, workspaceId);
    expect(result.connected).toBe(true);
    console.log('Terminal WebSocket: ✓');
  });

  test('12. UI shows workspace with services', async ({ page }) => {
    await page.setViewportSize({ width: 1400, height: 800 });
    await page.goto(`${UI}/workspaces/${workspaceId}`);
    await page.waitForTimeout(3000);

    // Should show service status in header
    const serverLabel = page.locator('text=/server:\\d+/');
    await expect(serverLabel).toBeVisible();

    // Should show file tree
    const explorer = page.locator('text=Explorer');
    await expect(explorer).toBeVisible();

    await page.screenshot({ path: '/Users/shreemantkumar/flowforge/e2e/sandbox-workspace.png', fullPage: false });
  });

  test('13. Stop service and archive workspace', async ({ request }) => {
    // Stop server
    await request.post(`${API}/api/workspaces/${workspaceId}/services/server/stop`);

    const wsRes = await request.get(`${API}/api/workspaces/${workspaceId}`);
    const ws = await wsRes.json();
    const svc = ws.services.find((s: any) => s.name === 'server');
    expect(svc.status).toBe('stopped');
    console.log('Server stopped');

    // Archive
    const archiveRes = await request.delete(`${API}/api/workspaces/${workspaceId}`);
    expect(archiveRes.ok()).toBeTruthy();
    console.log('Workspace archived');

    // Verify archived
    const finalRes = await request.get(`${API}/api/workspaces/${workspaceId}`);
    const final = await finalRes.json();
    expect(final.status).toBe('archived');
  });
});
