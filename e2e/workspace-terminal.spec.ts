import { test, expect } from '@playwright/test';

import { API, UI } from './helpers';

test.describe('Workspace Terminal & File Tree', () => {

  test('WS server on 4024 is alive', async ({ request }) => {
    const res = await request.get('http://localhost:4024/', { failOnStatusCode: false });
    expect(res.status()).toBe(404);
  });

  test.skip('workspace detail page loads file tree (legacy workspace detail page)', async ({ page }) => {
    await page.goto(`${UI}/workspaces/69d520cd51ffbb1176abcb73`);
    await page.waitForTimeout(3000);
    const explorer = page.locator('text=Explorer');
    await expect(explorer).toBeVisible();
    const folders = page.locator('button:has(svg)').filter({ hasText: /.+/ });
    expect(await folders.count()).toBeGreaterThan(0);
  });

  test.skip('clicking a file opens Monaco editor (legacy workspace detail page)', async ({ page }) => {
    await page.goto(`${UI}/workspaces/69d520cd51ffbb1176abcb73`);
    await page.waitForTimeout(3000);
    const fileBtn = page.locator('button.font-mono').filter({ hasText: /\.(ts|json|md)$/ }).first();
    if (await fileBtn.count() > 0) {
      await fileBtn.click();
      await page.waitForTimeout(3000);
      // Monaco or markdown preview should appear
      const monaco = page.locator('.monaco-editor');
      const markdownBody = page.locator('.markdown-body');
      expect((await monaco.count()) + (await markdownBody.count())).toBeGreaterThan(0);
    }
  });

  test.skip('terminal section visible (legacy workspace detail page)', async ({ page }) => {
    await page.goto(`${UI}/workspaces/69d520cd51ffbb1176abcb73`);
    await page.waitForTimeout(2000);
    const termLabel = page.locator('text=Terminal').first();
    await expect(termLabel).toBeVisible();
  });

  test.skip('terminal connects (legacy workspace detail page)', async ({ page }) => {
    await page.goto(`${UI}/workspaces/69d520cd51ffbb1176abcb73`);
    await page.waitForTimeout(4000);
    const badge = page.locator('text=disconnected');
    if (await badge.count() > 0) expect(await badge.first().isVisible()).toBe(false);
  });

  test.skip('header has Commit, Push, PR buttons (legacy workspace detail page)', async ({ page }) => {
    await page.goto(`${UI}/workspaces/69d520cd51ffbb1176abcb73`);
    await page.waitForTimeout(2000);
    await expect(page.locator('button:has-text("Commit")').first()).toBeVisible();
    await expect(page.locator('button:has-text("Push")').first()).toBeVisible();
    await expect(page.locator('button:has-text("PR")').first()).toBeVisible();
  });

  test.skip('WebSocket connects through Vite proxy from detail page (legacy workspace detail page)', async ({ page }) => {
    await page.goto(`${UI}/workspaces/69d520cd51ffbb1176abcb73`);
    const result = await page.evaluate(async () => {
      return new Promise<{ connected: boolean }>((resolve) => {
        const ws = new WebSocket(`ws://${window.location.host}/ws/workspaces/69d520cd51ffbb1176abcb73/terminal/test`);
        const timeout = setTimeout(() => { ws.close(); resolve({ connected: false }); }, 5000);
        ws.onopen = () => { clearTimeout(timeout); setTimeout(() => { ws.close(); resolve({ connected: true }); }, 500); };
        ws.onerror = () => { clearTimeout(timeout); resolve({ connected: false }); };
      });
    });
    expect(result.connected).toBe(true);
  });

  test.skip('multi-terminal add and split (legacy workspace detail page)', async ({ page }) => {
    await page.goto(`${UI}/workspaces/69d520cd51ffbb1176abcb73`);
    await page.waitForTimeout(2000);
    const addBtn = page.locator('button[title="New Terminal"]');
    await addBtn.click();
    await page.waitForTimeout(500);
    await expect(page.locator('text=Terminal 2')).toBeVisible();
  });

  test('PR page accessible from sidebar', async ({ page }) => {
    await page.goto(`${UI}/`);
    const prLink = page.locator('a[href="/pull-requests"]');
    await expect(prLink).toBeVisible();
    await prLink.click();
    await expect(page).toHaveURL(/pull-requests/);
  });

  test('PR API returns list', async ({ request }) => {
    const res = await request.get(`${API}/api/pull-requests`);
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(Array.isArray(body)).toBeTruthy();
  });
});
