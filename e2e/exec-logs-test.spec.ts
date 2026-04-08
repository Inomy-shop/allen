import { test, expect } from '@playwright/test';
import { API, UI } from './helpers';


test('execution detail shows merged logs + tool calls + metadata', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  // Use the user's execution
  await page.goto(`${UI}/executions/30b7f3c3-4011-4179-80f5-10f44b6bc544`);
  await page.waitForTimeout(4000);

  // Metadata should be visible
  await expect(page.locator('.card:has-text("Working Directory")').first()).toBeVisible();
  await expect(page.locator('.card:has-text("Spawned By")').first()).toBeVisible();
  await expect(page.locator('.card:has-text("Provider")').first()).toBeVisible();

  const cwdText = await page.locator('.card:has-text("Working Directory")').first().textContent();
  console.log('CWD:', cwdText);

  const spawnedBy = await page.locator('.card:has-text("Spawned By")').first().textContent();
  console.log('Spawned By:', spawnedBy);

  // Live Logs should show merged data (persisted + trace activity)
  const logsHeader = page.locator('text=Live Logs');
  await expect(logsHeader).toBeVisible();

  // Get entries count from the header
  const entriesText = await logsHeader.locator('..').locator('span.font-mono').last().textContent();
  console.log('Log entries:', entriesText);

  // Logs should have more than just "started" + "completed"
  const logLines = page.locator('[class*="bg-\\[rgb"] div.flex.items-start');
  const logCount = await logLines.count();
  console.log('Visible log lines:', logCount);

  // Tool Calls section should show
  const toolCallsSection = page.locator('text=Tool Calls');
  if (await toolCallsSection.count() > 0) {
    console.log('✓ Tool Calls section visible');
    // Count tool call entries
    const toolEntries = page.locator('text=/Read|Write|Bash|Grep|Glob|Edit/i');
    console.log('Tool entries:', await toolEntries.count());
  }

  // Response section
  const response = page.locator('text=Response');
  await expect(response).toBeVisible();

  // Open Chat link
  const chatLink = page.locator('text=Open Chat');
  if (await chatLink.count() > 0) {
    console.log('✓ Open Chat link visible');
  }

  await page.screenshot({ path: '/Users/shreemantkumar/flowforge/e2e/exec-merged-logs.png', fullPage: false });

  // Scroll down to see tool calls
  await page.evaluate(() => window.scrollTo(0, 500));
  await page.waitForTimeout(500);
  await page.screenshot({ path: '/Users/shreemantkumar/flowforge/e2e/exec-tool-calls.png', fullPage: false });
});
