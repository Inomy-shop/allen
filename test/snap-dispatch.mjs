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

  // Open dispatch
  const dispatch = page.locator('button:has-text("Dispatch")').first();
  if (await dispatch.count() === 0) { console.log('no Dispatch button'); await browser.close(); return; }
  await dispatch.click();
  await page.waitForTimeout(500);

  // Open the picker
  const trigger = page.locator('button:has-text("Pick an agent, team lead, or workflow")');
  await trigger.click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(OUT, 'dispatch-picker-open.png') });
  console.log('open');

  // Type a query
  await page.keyboard.type('lead', { delay: 30 });
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(OUT, 'dispatch-picker-search-lead.png') });
  console.log('search lead');

  // Clear, then search workflow
  await page.keyboard.down('Meta');
  await page.keyboard.press('a');
  await page.keyboard.up('Meta');
  await page.keyboard.press('Backspace');
  await page.keyboard.type('reso', { delay: 30 });
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(OUT, 'dispatch-picker-search-workflow.png') });
  console.log('search workflow');

  await browser.close();
})();
