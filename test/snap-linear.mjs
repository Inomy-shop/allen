// Snap Linear board view + dispatch modal.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const BASE = 'http://localhost:5173';
const OUT = '/Users/shreemantkumar/flowforge/test/screenshots';
mkdirSync(OUT, { recursive: true });

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.error('PAGE ERROR:', e.message));

  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await page.fill('input[type="email"]', 'shreemant@inomy.shop');
  await page.fill('input[type="password"]', 'Shreemant@123');
  await Promise.all([
    page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 15000 }).catch(() => {}),
    page.click('button[type="submit"]'),
  ]);
  await page.waitForTimeout(800);
  await page.evaluate(() => {
    const stored = localStorage.getItem('allen-settings');
    const next = stored ? JSON.parse(stored) : {};
    next.colorMode = 'light'; next.themeName = 'linear';
    localStorage.setItem('allen-settings', JSON.stringify(next));
  });
  await page.reload({ waitUntil: 'networkidle' });

  await page.goto(`${BASE}/tickets`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: join(OUT, 'linear-list-light.png') });
  console.log('list', join(OUT, 'linear-list-light.png'));

  // Click "Board" toggle
  await page.click('button[title="Board view"]');
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(OUT, 'linear-board-light.png') });
  console.log('board', join(OUT, 'linear-board-light.png'));

  // Click first dispatch pill to open modal
  const dispatchBtn = page.locator('button:has-text("Dispatch")').first();
  if (await dispatchBtn.count()) {
    await dispatchBtn.click();
    await page.waitForTimeout(500);
    await page.screenshot({ path: join(OUT, 'linear-dispatch-modal-light.png') });
    console.log('dispatch', join(OUT, 'linear-dispatch-modal-light.png'));
  } else {
    console.log('no Dispatch button visible');
  }
  await browser.close();
})();
