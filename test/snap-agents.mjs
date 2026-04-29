// Snap each tab on /agents.
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

  await page.goto(`${BASE}/agents`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);

  for (const tab of ['Directory', 'Teams', 'Delegation graph', 'Models']) {
    const btn = page.locator(`button:has-text("${tab}")`).first();
    if (await btn.count()) await btn.click();
    await page.waitForTimeout(700);
    const slug = tab.toLowerCase().replace(/\s+/g, '-');
    await page.screenshot({ path: join(OUT, `agents-tab-${slug}.png`) });
    console.log('saved', slug);
  }
  await browser.close();
})();
