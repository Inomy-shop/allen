// Quick single-page snapshot. Usage: node test/snap-page.mjs <path> <out-name> [mode]
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const BASE = 'http://localhost:5173';
const EMAIL = 'shreemant@inomy.shop';
const PASSWORD = 'Shreemant@123';
const OUT = '/Users/shreemantkumar/flowforge/test/screenshots';
mkdirSync(OUT, { recursive: true });

const path = process.argv[2] || '/';
const name = process.argv[3] || 'page';
const mode = process.argv[4] || 'light';

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.error('PAGE ERROR:', e.message));
  page.on('console', (msg) => { if (msg.type() === 'error') console.error('CONSOLE ERROR:', msg.text()); });

  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await page.fill('input[type="email"]', EMAIL);
  await page.fill('input[type="password"]', PASSWORD);
  await Promise.all([
    page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 15000 }).catch(() => {}),
    page.click('button[type="submit"]'),
  ]);
  await page.waitForTimeout(800);
  await page.evaluate((m) => {
    const stored = localStorage.getItem('allen-settings');
    const next = stored ? JSON.parse(stored) : {};
    next.colorMode = m;
    next.themeName = 'linear';
    localStorage.setItem('allen-settings', JSON.stringify(next));
  }, mode);
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(500);
  await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);
  const file = join(OUT, `${name}-${mode}.png`);
  await page.screenshot({ path: file, fullPage: false });
  console.log(file);
  await browser.close();
})();
