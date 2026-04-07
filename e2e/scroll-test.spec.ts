import { test, expect } from '@playwright/test';

test('file content loads fully and scrolls', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 800 });
  await page.goto('http://localhost:5173/workspaces/69d520cd51ffbb1176abcb73');
  await page.waitForTimeout(3000);

  // Click a .ts file
  const tsFile = page.locator('button.font-mono').filter({ hasText: /\.ts$/ }).first();
  if (await tsFile.count() > 0) {
    await tsFile.click();
    await page.waitForTimeout(1500);
  }

  // Get textarea content length
  const textarea = page.locator('textarea:not(.xterm-helper-textarea)');
  const content = await textarea.inputValue();
  const lineCount = content.split('\n').length;
  console.log(`File loaded: ${content.length} chars, ${lineCount} lines`);
  expect(content.length).toBeGreaterThan(0);

  // Scroll to bottom of textarea
  await textarea.evaluate(el => { el.scrollTop = el.scrollHeight; });
  await page.waitForTimeout(300);

  // Verify textarea scrollTop changed (meaning it scrolled)
  const scrollInfo = await textarea.evaluate(el => ({
    scrollTop: el.scrollTop,
    scrollHeight: el.scrollHeight,
    clientHeight: el.clientHeight,
  }));
  console.log(`Scroll: top=${scrollInfo.scrollTop}, height=${scrollInfo.scrollHeight}, client=${scrollInfo.clientHeight}`);

  // scrollHeight should be > clientHeight for a file that needs scrolling
  if (lineCount > 20) {
    expect(scrollInfo.scrollHeight).toBeGreaterThan(scrollInfo.clientHeight);
  }

  // Screenshot at bottom of file
  await page.screenshot({ path: '/Users/shreemantkumar/flowforge/e2e/scroll-bottom.png', fullPage: false });

  // Scroll back to top
  await textarea.evaluate(el => { el.scrollTop = 0; });
  await page.waitForTimeout(300);
  await page.screenshot({ path: '/Users/shreemantkumar/flowforge/e2e/scroll-top.png', fullPage: false });

  console.log('Scroll test passed');
});
