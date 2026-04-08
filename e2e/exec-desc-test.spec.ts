import { test } from '@playwright/test';

test('execution logs show descriptions', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto('http://localhost:5173/executions/ff3d8e28-46b7-4c11-a07d-ca917290461e');
  await page.waitForTimeout(3000);
  await page.screenshot({ path: '/Users/shreemantkumar/flowforge/e2e/exec-descriptions.png', fullPage: false });
});
