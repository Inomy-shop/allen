import { test, expect } from '@playwright/test';
import { API, UI } from './helpers';


test.describe.skip('Workspace Embedded Chat (legacy workspace detail page)', () => {

  test('chat panel opens with linked session', async ({ page }) => {
    await page.setViewportSize({ width: 1400, height: 800 });
    await page.goto(`${UI}/workspaces/69d520cd51ffbb1176abcb73`);
    await page.waitForTimeout(3000);

    await page.locator('button[title="Chat (⌘J)"]').click();
    await page.waitForTimeout(2000);

    // Chat header should show "linked" since workspace has a chatSessionId
    const linked = page.locator('text=linked');
    await expect(linked.first()).toBeVisible();

    // Agent selector should be present
    const assistantBtn = page.locator('button:has-text("Assistant")').last();
    expect(await assistantBtn.count()).toBeGreaterThan(0);

  });

  test('new chat button clears to empty state', async ({ page }) => {
    await page.setViewportSize({ width: 1400, height: 800 });
    await page.goto(`${UI}/workspaces/69d520cd51ffbb1176abcb73`);
    await page.waitForTimeout(3000);

    await page.locator('button[title="Chat (⌘J)"]').click();
    await page.waitForTimeout(2000);

    // Click + New Chat
    const newChatBtn = page.locator('button[title="New Chat"]');
    await expect(newChatBtn).toBeVisible();
    await newChatBtn.click();
    await page.waitForTimeout(1000);

    // Empty state should now show
    const emptyState = page.locator('text=Chat with AI about this workspace');
    await expect(emptyState).toBeVisible({ timeout: 3000 });

  });

  test('chat is resizable', async ({ page }) => {
    await page.setViewportSize({ width: 1400, height: 800 });
    await page.goto(`${UI}/workspaces/69d520cd51ffbb1176abcb73`);
    await page.waitForTimeout(3000);

    await page.locator('button[title="Chat (⌘J)"]').click();
    await page.waitForTimeout(500);

    const resizer = page.locator('.cursor-col-resize').last();
    expect(await resizer.count()).toBeGreaterThan(0);
  });

  test('agent selector and input present', async ({ page }) => {
    await page.setViewportSize({ width: 1400, height: 800 });
    await page.goto(`${UI}/workspaces/69d520cd51ffbb1176abcb73`);
    await page.waitForTimeout(3000);

    await page.locator('button[title="Chat (⌘J)"]').click();
    await page.waitForTimeout(1500);

    // Agent buttons
    expect(await page.locator('button:has-text("Assistant")').count()).toBeGreaterThan(0);

    // Chat input area (textarea from ChatInput)
    const inputs = page.locator('textarea, input[type="text"]');
    expect(await inputs.count()).toBeGreaterThan(0);
  });
});
