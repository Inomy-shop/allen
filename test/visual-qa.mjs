// Visual QA — log in, capture screenshots of all major pages in light + dark.
// Run: node test/visual-qa.mjs
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const BASE = 'http://localhost:5173';
const EMAIL = 'shreemant@inomy.shop';
const PASSWORD = 'Shreemant@123';
const OUT = '/Users/shreemantkumar/flowforge/test/screenshots';

const PAGES = [
  { id: '01-dashboard',     path: '/' },
  { id: '02-chat',          path: '/chat' },
  { id: '03-workflows',     path: '/workflows' },
  { id: '04-agents',        path: '/agents' },
  { id: '05-repos',         path: '/repos' },
  { id: '06-tickets',       path: '/tickets' },
  { id: '07-workspaces',    path: '/workspaces' },
  { id: '08-pull-requests', path: '/pull-requests' },
  { id: '09-executions',    path: '/executions' },
  { id: '10-interventions', path: '/interventions' },
  { id: '11-analytics',     path: '/analytics' },
  { id: '12-learnings',     path: '/learnings' },
  { id: '13-crons',         path: '/crons' },
  { id: '14-settings',      path: '/settings/theme' },
];

mkdirSync(OUT, { recursive: true });

async function setColorMode(page, mode) {
  // Use the settings store directly to switch color mode
  await page.evaluate((m) => {
    const stored = localStorage.getItem('allen-settings');
    const next = stored ? JSON.parse(stored) : {};
    next.colorMode = m;
    next.themeName = 'linear';
    localStorage.setItem('allen-settings', JSON.stringify(next));
  }, mode);
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(400);
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();

  // Surface console errors
  page.on('pageerror', (e) => console.error('PAGE ERROR:', e.message));
  page.on('console', (msg) => {
    if (msg.type() === 'error') console.error('CONSOLE ERROR:', msg.text());
  });

  console.log('→ Login');
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  // Try to find login fields (email/password)
  await page.fill('input[type="email"], input[name="email"], input[placeholder*="mail" i]', EMAIL);
  await page.fill('input[type="password"], input[name="password"]', PASSWORD);
  await Promise.all([
    page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 15000 }).catch(() => {}),
    page.click('button[type="submit"], button:has-text("Sign in"), button:has-text("Log in")'),
  ]);
  await page.waitForTimeout(800);
  console.log('  logged in →', page.url());

  for (const mode of ['light', 'dark']) {
    console.log(`\n=== Mode: ${mode} ===`);
    await setColorMode(page, mode);

    for (const p of PAGES) {
      try {
        await page.goto(`${BASE}${p.path}`, { waitUntil: 'networkidle', timeout: 20000 });
      } catch (e) {
        console.error(`  ${p.id}: nav timeout (${e.message.split('\n')[0]})`);
      }
      await page.waitForTimeout(700);
      const file = join(OUT, `${p.id}-${mode}.png`);
      await page.screenshot({ path: file, fullPage: false });
      console.log(`  ${p.id} → ${file}`);
    }
  }

  await browser.close();
  console.log('\n✓ Done');
})().catch((err) => {
  console.error('FATAL', err);
  process.exit(1);
});
