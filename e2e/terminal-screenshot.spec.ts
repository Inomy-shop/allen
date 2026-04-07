import { test, expect } from '@playwright/test';

const API = 'http://localhost:4023';
const UI = 'http://localhost:5173';

test.describe('Workspace Full Feature Test', () => {

  test('file editing — save file via API', async ({ request }) => {
    // Create a test file
    const createRes = await request.post(`${API}/api/workspaces/69d520cd51ffbb1176abcb73/create-file`, {
      data: { path: '_test_e2e_file.txt', content: 'hello from playwright' },
    });
    // Could be 201 (created) or 409 (already exists)
    expect([201, 409].includes(createRes.status())).toBeTruthy();

    // Save/overwrite it
    const saveRes = await request.put(`${API}/api/workspaces/69d520cd51ffbb1176abcb73/file/_test_e2e_file.txt`, {
      data: { content: 'updated by playwright' },
    });
    expect(saveRes.ok()).toBeTruthy();

    // Read it back
    const readRes = await request.get(`${API}/api/workspaces/69d520cd51ffbb1176abcb73/file/_test_e2e_file.txt`);
    expect(readRes.ok()).toBeTruthy();
    const body = await readRes.json();
    expect(body.content).toBe('updated by playwright');

    // Delete it
    const delRes = await request.delete(`${API}/api/workspaces/69d520cd51ffbb1176abcb73/file/_test_e2e_file.txt`);
    expect(delRes.ok()).toBeTruthy();
  });

  test('resizable sidebar and terminal', async ({ page }) => {
    await page.goto(`${UI}/workspaces/69d520cd51ffbb1176abcb73`);
    await page.waitForTimeout(3000);

    // Resize handles should exist
    const colResizer = page.locator('.cursor-col-resize');
    expect(await colResizer.count()).toBeGreaterThan(0);

    const rowResizer = page.locator('.cursor-row-resize');
    expect(await rowResizer.count()).toBeGreaterThan(0);
  });

  test('multi-terminal — add and split', async ({ page }) => {
    await page.goto(`${UI}/workspaces/69d520cd51ffbb1176abcb73`);
    await page.waitForTimeout(3000);

    // Should start with 1 terminal tab
    const termTabs = page.locator('text=Terminal 1');
    await expect(termTabs).toBeVisible();

    // Click "+" to add a terminal
    const addBtn = page.locator('button[title="New Terminal"]');
    await addBtn.click();
    await page.waitForTimeout(500);

    // Should now have 2 terminal tabs
    const tab2 = page.locator('text=Terminal 2');
    await expect(tab2).toBeVisible();

    // Both xterm containers should exist (split view)
    const xtermDivs = page.locator('.xterm');
    expect(await xtermDivs.count()).toBeGreaterThanOrEqual(2);
  });

  test('commit modal opens', async ({ page }) => {
    await page.goto(`${UI}/workspaces/69d520cd51ffbb1176abcb73`);
    await page.waitForTimeout(2000);

    // Click commit button
    const commitBtn = page.locator('button:has-text("Commit")').first();
    await commitBtn.click();
    await page.waitForTimeout(500);

    // Modal should appear with textarea
    const modal = page.locator('text=Commit Changes');
    await expect(modal).toBeVisible();

    const textarea = page.locator('textarea[placeholder="Commit message..."]');
    await expect(textarea).toBeVisible();

    // Close modal
    const cancelBtn = page.locator('button:has-text("Cancel")');
    await cancelBtn.click();
  });

  test('new file creation UI', async ({ page }) => {
    await page.goto(`${UI}/workspaces/69d520cd51ffbb1176abcb73`);
    await page.waitForTimeout(2000);

    // Click new file button
    const newFileBtn = page.locator('button[title="New File"]');
    await newFileBtn.click();
    await page.waitForTimeout(300);

    // Input should appear
    const input = page.locator('input[placeholder="path/to/file.ts"]');
    await expect(input).toBeVisible();

    // Press Escape to cancel
    await page.keyboard.press('Escape');
  });

  test('page is fixed (no body scroll)', async ({ page }) => {
    await page.goto(`${UI}/workspaces/69d520cd51ffbb1176abcb73`);
    await page.waitForTimeout(2000);

    // The root container should have overflow-hidden
    const scrollHeight = await page.evaluate(() => document.documentElement.scrollHeight);
    const clientHeight = await page.evaluate(() => document.documentElement.clientHeight);
    // scrollHeight should not significantly exceed clientHeight (no scrollbar)
    expect(scrollHeight).toBeLessThanOrEqual(clientHeight + 5);
  });

  test('full screenshot with all features', async ({ page }) => {
    await page.goto(`${UI}/workspaces/69d520cd51ffbb1176abcb73`);
    await page.waitForTimeout(4000);

    // Click a file to open editor
    const fileBtn = page.locator('button.font-mono').filter({ hasText: /\.(ts|json|md)$/ }).first();
    if (await fileBtn.count() > 0) {
      await fileBtn.click();
      await page.waitForTimeout(1000);
    }

    // Add a second terminal
    const addBtn = page.locator('button[title="New Terminal"]');
    if (await addBtn.count() > 0) {
      await addBtn.click();
      await page.waitForTimeout(1000);
    }

    await page.screenshot({ path: '/Users/shreemantkumar/flowforge/e2e/workspace-final.png', fullPage: false });
    console.log('Final screenshot saved');
  });
});
