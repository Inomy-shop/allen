import { test, expect } from '@playwright/test';

import { API, UI } from './helpers';
const FLOWFORGE_REPO_ID = '69cee6f2c841d0d60a1239ba';

test.describe('Workspace Sandbox & Config', () => {

  test('workspace config API — read saved config', async ({ request }) => {
    const res = await request.get(`${API}/api/workspaces/config/${FLOWFORGE_REPO_ID}`);
    expect(res.ok()).toBeTruthy();
    const config = await res.json();
    expect(config.setupScript.length).toBeGreaterThan(0);
    expect(config.services.length).toBe(2);
    expect(config.services[0].name).toBe('server');
    expect(config.services[1].name).toBe('ui');
    expect(config.cleanupScript.length).toBeGreaterThan(0);
    console.log('Config:', JSON.stringify({ setup: config.setupScript, services: config.services.map((s: any) => s.name), autoStart: config.autoStart }));
  });

  test('workspace config API — update and verify', async ({ request }) => {
    // Update autoStart
    const res = await request.put(`${API}/api/workspaces/config/${FLOWFORGE_REPO_ID}`, {
      data: { autoStart: true },
    });
    expect(res.ok()).toBeTruthy();

    const config = await (await request.get(`${API}/api/workspaces/config/${FLOWFORGE_REPO_ID}`)).json();
    expect(config.autoStart).toBe(true);

    // Reset
    await request.put(`${API}/api/workspaces/config/${FLOWFORGE_REPO_ID}`, { data: { autoStart: false } });
  });

  test('port assignment returns free ports', async ({ request }) => {
    // Check existing workspace ports
    const wsRes = await request.get(`${API}/api/workspaces`);
    const workspaces = await wsRes.json();
    const usedPorts = workspaces.map((w: any) => w.basePort);
    console.log('Used base ports:', usedPorts);

    // All ports should be >= 15000
    for (const p of usedPorts) {
      expect(p).toBeGreaterThanOrEqual(15000);
    }
  });

  test('workspace has services from config', async ({ request }) => {
    const wsRes = await request.get(`${API}/api/workspaces`);
    const workspaces = await wsRes.json();
    const ws = workspaces.find((w: any) => w.repoId === FLOWFORGE_REPO_ID);
    if (ws) {
      console.log('Workspace:', ws.name, 'services:', ws.services?.length);
      if (ws.services?.length > 0) {
        for (const svc of ws.services) {
          console.log(`  ${svc.name}: port ${svc.port}, status ${svc.status}`);
          expect(svc.port).toBeGreaterThanOrEqual(15000);
          // {port} should be replaced with actual number
          expect(svc.command).not.toContain('{port}');
        }
      }
    }
  });

  test('workspace config editor opens from list page', async ({ page }) => {
    await page.setViewportSize({ width: 1400, height: 800 });
    await page.goto(`${UI}/workspaces`);
    await page.waitForTimeout(2000);

    // Click "New Workspace" to show form
    await page.locator('button:has-text("New Workspace")').click();
    await page.waitForTimeout(300);

    // Select flowforge repo
    const repoSelect = page.locator('select').first();
    await repoSelect.selectOption({ label: 'flowforge' });
    await page.waitForTimeout(300);

    // "Configure Workspace" button should appear
    const configBtn = page.locator('button:has-text("Configure Workspace")');
    await expect(configBtn).toBeVisible();
    await configBtn.click();
    await page.waitForTimeout(500);

    // Config modal should open
    await expect(page.locator('text=Workspace Configuration')).toBeVisible();

    // Should show existing setup script
    const npmInstall = page.locator('input[value="npm install"]');
    expect(await npmInstall.count()).toBeGreaterThan(0);

    // Should show services
    const serverInput = page.locator('input[value="server"]');
    expect(await serverInput.count()).toBeGreaterThan(0);

    await page.screenshot({ path: '/Users/shreemantkumar/flowforge/e2e/config-editor.png', fullPage: false });
  });

  test('workspace info panel opens from detail page', async ({ page }) => {
    await page.setViewportSize({ width: 1400, height: 800 });
    await page.goto(`${UI}/workspaces/69d520cd51ffbb1176abcb73`);
    await page.waitForTimeout(3000);

    const infoBtn = page.locator('button[title="Workspace Info"]');
    await expect(infoBtn).toBeVisible();
    await infoBtn.click();
    await page.waitForTimeout(500);

    await expect(page.locator('text=Workspace Info')).toBeVisible();
    await expect(page.locator('text=Assigned Ports')).toBeVisible();
    await expect(page.locator('text=Worktree Path')).toBeVisible();
  });
});
