import { test, expect } from '@playwright/test';

test('markdown preview full width', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto('http://localhost:5173/workspaces/69d520cd51ffbb1176abcb73');
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
    await page.screenshot({
      path: '/Users/shreemantkumar/flowforge/e2e/md-preview-closeup.png',
      clip: { x: 310, y: 38, width: 1090, height: 860 },
    });
  }
});
