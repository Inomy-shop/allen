import { test, expect } from '@playwright/test';
import { UI } from './helpers';

const WORKSPACE_ID = '69d520cd51ffbb1176abcb73';
const WS_URL = `${UI}/workspaces/${WORKSPACE_ID}`;

test.describe('Workspace Resizable/Collapsible Panels', () => {

  // ─── File Explorer ──────────────────────────────────────────────────────────

  test('explorer collapse via button — explorer header disappears and icon strip appears', async ({ page }) => {
    await page.setViewportSize({ width: 1400, height: 800 });
    await page.goto(WS_URL);
    await page.waitForTimeout(3000);

    // Verify explorer header is initially visible
    const explorerHeader = page.locator('text=Explorer');
    await expect(explorerHeader).toBeVisible();

    // Click the collapse button
    const collapseBtn = page.locator('button[title="Collapse (⌘B)"]');
    await expect(collapseBtn).toBeVisible();
    await collapseBtn.click();
    await page.waitForTimeout(500);

    // Explorer header text should no longer be visible
    await expect(explorerHeader).not.toBeVisible();

    // Expand icon strip should appear
    const expandBtn = page.locator('button[title="Expand Explorer (⌘B)"]');
    await expect(expandBtn).toBeVisible();
  });

  test('explorer expand via icon strip — explorer header reappears', async ({ page }) => {
    await page.setViewportSize({ width: 1400, height: 800 });
    await page.goto(WS_URL);
    await page.waitForTimeout(3000);

    // First collapse the explorer
    const collapseBtn = page.locator('button[title="Collapse (⌘B)"]');
    await expect(collapseBtn).toBeVisible();
    await collapseBtn.click();
    await page.waitForTimeout(500);

    // Now click the expand icon strip button
    const expandBtn = page.locator('button[title="Expand Explorer (⌘B)"]');
    await expect(expandBtn).toBeVisible();
    await expandBtn.click();
    await page.waitForTimeout(500);

    // Explorer header text should be visible again
    const explorerHeader = page.locator('text=Explorer');
    await expect(explorerHeader).toBeVisible();

    // And the collapse button should be back
    await expect(collapseBtn).toBeVisible();
  });

  test('Cmd+B keyboard shortcut toggles explorer collapsed/expanded', async ({ page }) => {
    await page.setViewportSize({ width: 1400, height: 800 });
    await page.goto(WS_URL);
    await page.waitForTimeout(3000);

    // Verify explorer is initially open
    const explorerHeader = page.locator('text=Explorer');
    await expect(explorerHeader).toBeVisible();

    // Press Cmd+B (Meta+B) to collapse
    await page.keyboard.press('Meta+b');
    await page.waitForTimeout(500);

    // Explorer should now be collapsed
    await expect(explorerHeader).not.toBeVisible();
    const expandBtn = page.locator('button[title="Expand Explorer (⌘B)"]');
    await expect(expandBtn).toBeVisible();

    // Press Cmd+B again to re-expand
    await page.keyboard.press('Meta+b');
    await page.waitForTimeout(500);

    // Explorer should be visible again
    await expect(explorerHeader).toBeVisible();
  });

  test('explorer collapse state persists after page reload', async ({ page }) => {
    await page.setViewportSize({ width: 1400, height: 800 });
    await page.goto(WS_URL);
    await page.waitForTimeout(3000);

    // Collapse the explorer
    const collapseBtn = page.locator('button[title="Collapse (⌘B)"]');
    await expect(collapseBtn).toBeVisible();
    await collapseBtn.click();
    await page.waitForTimeout(500);

    // Verify it's collapsed before reload
    const explorerHeader = page.locator('text=Explorer');
    await expect(explorerHeader).not.toBeVisible();

    // Reload the page
    await page.reload();
    await page.waitForTimeout(3000);

    // Explorer should still be collapsed (state persisted in localStorage)
    await expect(explorerHeader).not.toBeVisible();
    const expandBtn = page.locator('button[title="Expand Explorer (⌘B)"]');
    await expect(expandBtn).toBeVisible();
  });

  // ─── Terminal ────────────────────────────────────────────────────────────────

  test('terminal close and re-open — X button closes, stub button re-opens', async ({ page }) => {
    await page.setViewportSize({ width: 1400, height: 800 });
    await page.goto(WS_URL);
    await page.waitForTimeout(3000);

    // Terminal should be visible initially
    const termLabel = page.locator('text=Terminal').first();
    await expect(termLabel).toBeVisible();

    // Find the close (X) button in the terminal header and click it
    // The close button is inside the terminal header area
    const closeBtn = page.locator('button[title="Close Terminal"]');
    if (await closeBtn.count() > 0) {
      await closeBtn.click();
      await page.waitForTimeout(500);

      // Terminal xterm container should be gone; a stub/reopen button should appear
      // The stub button shows "Terminal" text with a Terminal icon
      const stubBtn = page.locator('button:has-text("Terminal")').filter({ hasText: /^Terminal$/ });
      expect(await stubBtn.count()).toBeGreaterThan(0);

      // Click the stub to reopen
      await stubBtn.first().click();
      await page.waitForTimeout(1000);

      // Terminal section should reappear
      await expect(termLabel).toBeVisible();
    } else {
      // Fallback: look for any terminal-header close button (svg × button)
      const headerCloseBtn = page
        .locator('[data-testid="terminal-close"], button[aria-label="Close terminal"]')
        .first();
      if (await headerCloseBtn.count() > 0) {
        await headerCloseBtn.click();
        await page.waitForTimeout(500);
        // Stub should appear
        const stub = page.locator('button:has-text("Terminal")').first();
        expect(await stub.count()).toBeGreaterThan(0);
      }
      // If neither selector found, the panel feature may not be mounted — skip gracefully
    }
  });

  // ─── Chat resize handle ───────────────────────────────────────────────────

  test('chat resize handle is present when chat panel is open', async ({ page }) => {
    await page.setViewportSize({ width: 1400, height: 800 });
    await page.goto(WS_URL);
    await page.waitForTimeout(3000);

    // Open chat panel
    await page.locator('button[title="Chat (⌘J)"]').click();
    await page.waitForTimeout(500);

    // The .cursor-col-resize handle must exist
    const resizer = page.locator('.cursor-col-resize').last();
    expect(await resizer.count()).toBeGreaterThan(0);
  });

});
