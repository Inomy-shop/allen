import { test } from '@playwright/test';
import { API, UI } from './helpers';

test('execution logs show descriptions', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto(`${UI}/executions/ff3d8e28-46b7-4c11-a07d-ca917290461e`);
  await page.waitForTimeout(3000);
});
