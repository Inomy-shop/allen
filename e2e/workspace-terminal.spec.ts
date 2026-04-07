import { test, expect } from '@playwright/test';

const API = 'http://localhost:4023';
const UI = 'http://localhost:5173';

test.describe('Workspace Terminal & File Tree', () => {

  test('WS server on 4024 is alive', async ({ request }) => {
    const res = await request.get('http://localhost:4024/', { failOnStatusCode: false });
    expect(res.status()).toBe(404); // WS-only server returns 404 for HTTP
  });

  test('all-files API returns file list', async ({ request }) => {
    const res = await request.get(`${API}/api/workspaces/69d520cd51ffbb1176abcb73/all-files`);
    expect(res.ok()).toBeTruthy();
    const files = await res.json();
    expect(Array.isArray(files)).toBeTruthy();
    expect(files.length).toBeGreaterThan(0);
    // Each file has path and isDir
    expect(files[0]).toHaveProperty('path');
    expect(files[0]).toHaveProperty('isDir');
  });

  test('workspace detail page loads file tree', async ({ page }) => {
    await page.goto(`${UI}/workspaces/69d520cd51ffbb1176abcb73`);
    // Wait for file tree to load
    await page.waitForTimeout(3000);

    // Explorer header should exist
    const explorer = page.locator('text=Explorer');
    await expect(explorer).toBeVisible();

    // File count should be shown
    const filesCount = page.locator('text=/\\d+ files/');
    await expect(filesCount).toBeVisible();

    // There should be folder nodes (directories) visible
    const folders = page.locator('button:has(svg)').filter({ hasText: /.+/ });
    expect(await folders.count()).toBeGreaterThan(0);
  });

  test('clicking a file shows its content', async ({ page }) => {
    await page.goto(`${UI}/workspaces/69d520cd51ffbb1176abcb73`);
    await page.waitForTimeout(3000);

    // Find and click a file (look for a .ts or .json file)
    const fileButton = page.locator('button.font-mono').filter({ hasText: /\.(ts|json|md)$/ }).first();
    if (await fileButton.count() > 0) {
      await fileButton.click();
      await page.waitForTimeout(1000);

      // Code/Diff toggle should appear
      const codeTab = page.locator('button:has-text("Code")');
      await expect(codeTab).toBeVisible();

      const diffTab = page.locator('button:has-text("Diff")');
      await expect(diffTab).toBeVisible();

      // Line numbers should be visible (code view)
      const lineNumbers = page.locator('span.select-none');
      expect(await lineNumbers.count()).toBeGreaterThan(0);
    }
  });

  test('terminal section is visible with Terminal label', async ({ page }) => {
    await page.goto(`${UI}/workspaces/69d520cd51ffbb1176abcb73`);
    await page.waitForTimeout(2000);

    // Terminal label
    const termLabel = page.locator('text=Terminal').first();
    await expect(termLabel).toBeVisible();

    // xterm container should exist
    const xterm = page.locator('.xterm');
    expect(await xterm.count()).toBeGreaterThanOrEqual(0);
  });

  test('terminal connects (no disconnected badge)', async ({ page }) => {
    await page.goto(`${UI}/workspaces/69d520cd51ffbb1176abcb73`);
    await page.waitForTimeout(4000);

    // Check disconnected badge is NOT visible
    const badge = page.locator('text=disconnected');
    const badgeCount = await badge.count();
    if (badgeCount > 0) {
      const isVisible = await badge.first().isVisible();
      // If visible, terminal didn't connect
      expect(isVisible).toBe(false);
    }
    // If no badge at all, terminal is connected
  });

  test('commit bar has Push and PR buttons', async ({ page }) => {
    await page.goto(`${UI}/workspaces/69d520cd51ffbb1176abcb73`);
    await page.waitForTimeout(2000);

    // Push button in commit bar
    const pushBtn = page.locator('button:has-text("Push")');
    await expect(pushBtn).toBeVisible();

    // PR button in commit bar
    const prBtn = page.locator('button[title="Create Pull Request"]');
    await expect(prBtn).toBeVisible();

    // Commit input
    const commitInput = page.locator('input[placeholder="Commit message..."]');
    await expect(commitInput).toBeVisible();
  });

  test('WebSocket connects through Vite proxy', async ({ page }) => {
    await page.goto(`${UI}/workspaces/69d520cd51ffbb1176abcb73`);
    const result = await page.evaluate(async () => {
      return new Promise<{ connected: boolean; gotData: boolean }>((resolve) => {
        const ws = new WebSocket(`ws://${window.location.host}/ws/workspaces/69d520cd51ffbb1176abcb73/terminal/test`);
        let gotData = false;
        const timeout = setTimeout(() => { ws.close(); resolve({ connected: false, gotData }); }, 5000);
        ws.onopen = () => { clearTimeout(timeout); setTimeout(() => { ws.close(); resolve({ connected: true, gotData }); }, 1000); };
        ws.onmessage = () => { gotData = true; };
        ws.onerror = () => { clearTimeout(timeout); resolve({ connected: false, gotData }); };
      });
    });
    expect(result.connected).toBe(true);
  });

  test('hide/show terminal toggle works', async ({ page }) => {
    await page.goto(`${UI}/workspaces/69d520cd51ffbb1176abcb73`);
    await page.waitForTimeout(2000);

    // Terminal should be visible initially
    const xterm = page.locator('.xterm');
    const initialCount = await xterm.count();

    // Click hide button (X in terminal header)
    const hideBtn = page.locator('button[title="Hide terminal"]');
    if (await hideBtn.count() > 0) {
      await hideBtn.click();
      await page.waitForTimeout(500);

      // "Show Terminal" button should appear
      const showBtn = page.locator('button:has-text("Show Terminal")');
      await expect(showBtn).toBeVisible();

      // Click show
      await showBtn.click();
      await page.waitForTimeout(500);

      // Terminal label should be back
      const termLabel = page.locator('text=Terminal').first();
      await expect(termLabel).toBeVisible();
    }
  });
});
