import { test } from '@playwright/test';
import { API, UI } from './helpers';

test('material icon close-up', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto(`${UI}/workspaces/69d520cd51ffbb1176abcb73`);
  await page.waitForTimeout(4000);

  // Expand folders to see variety
  for (const folder of ['src', 'docs', '.claude', 'ui']) {
    const btn = page.locator(`button:has-text("${folder}")`).first();
    if (await btn.count() > 0) { await btn.click(); await page.waitForTimeout(200); }
  }

  // Expand deeper
  for (const folder of ['packages', 'server', 'services', 'routes', 'components', 'pages', 'hooks']) {
    const btn = page.locator(`button:has-text("${folder}")`).first();
    if (await btn.count() > 0) { await btn.click(); await page.waitForTimeout(150); }
  }

  await page.waitForTimeout(500);

  // Full page

  // Clip just the sidebar area

  console.log('Screenshots saved');
});
