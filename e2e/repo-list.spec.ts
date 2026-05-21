import { test, expect } from '@playwright/test';
import { API, UI } from './helpers';

test('repo list with workspace button', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 800 });
  await page.goto(`${UI}/repos`);
  await page.waitForTimeout(2000);

  // Hover over first repo to reveal actions
  const repoCard = page.locator('.group').first();
  await repoCard.hover();
  await page.waitForTimeout(300);

  // New Workspace button should be visible
  const wsBtn = page.locator('button[title="New Workspace"]').first();
  await expect(wsBtn).toBeVisible();

  // Click it
  await wsBtn.click();
  await page.waitForTimeout(500);

  // Dialog should open
  await expect(page.locator('text=New Workspace')).toBeVisible();
  await expect(page.locator('input[placeholder="feature/my-feature"]')).toBeVisible();

});
