import { defineConfig } from '@playwright/test';

const UI_PORT = process.env.UI_PORT || '5173';

export default defineConfig({
  testDir: './e2e',
  timeout: 30000,
  expect: { timeout: 5000 },
  use: {
    baseURL: `http://localhost:${UI_PORT}`,
    headless: true,
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
  ],
});
