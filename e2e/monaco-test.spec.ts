import { test, expect } from '@playwright/test';
import { API, UI } from './helpers';

test('Monaco editor loads with syntax highlighting', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 800 });
  await page.goto(`${UI}/workspaces/69d520cd51ffbb1176abcb73`);
  await page.waitForTimeout(4000);

  // Click a .ts file
  const tsFile = page.locator('button.font-mono').filter({ hasText: /\.ts$/ }).first();
  if (await tsFile.count() > 0) {
    await tsFile.click();
    await page.waitForTimeout(3000); // Monaco takes a moment to load
  }

  // Monaco should be present
  const monacoContainer = page.locator('.monaco-editor');
  await expect(monacoContainer).toBeVisible({ timeout: 10000 });

  // Should have line numbers
  const lineNumbers = page.locator('.line-numbers');
  expect(await lineNumbers.count()).toBeGreaterThan(0);

  // Should have syntax highlighting (colored tokens)
  const tokens = page.locator('.mtk1, .mtk3, .mtk5, .mtk6, .mtk10');
  expect(await tokens.count()).toBeGreaterThan(0);

  // Minimap should be visible
  const minimap = page.locator('.minimap');
  expect(await minimap.count()).toBeGreaterThan(0);

  console.log('Monaco screenshot saved');
});
