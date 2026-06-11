import { test, expect } from '@playwright/test';
import { API, UI } from './helpers';

test.skip('markdown preview full width (legacy workspace detail page)', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto(`${UI}/workspaces/69d520cd51ffbb1176abcb73`);
  await page.waitForTimeout(3000);

  const mdFile = page.locator('button.font-mono').filter({ hasText: /\.md$/ }).first();
  if (await mdFile.count() > 0) {
    await mdFile.click();
    await page.waitForTimeout(2000);

    // Scroll down a bit to see tables/paragraphs (wider content)
    const previewContainer = page.locator('.overflow-auto').last();
    await previewContainer.evaluate(el => el.scrollTop = 300);
    await page.waitForTimeout(500);

    // Crop just the editor area
  }
});
