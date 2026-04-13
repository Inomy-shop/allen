import { defineConfig } from '@playwright/test';

const UI_PORT = process.env.UI_PORT || '5173';
const API_PORT = process.env.API_PORT || process.env.PORT || '4023';
// Skip auto-starting servers when the user already has `npm run dev` running.
const REUSE_DEV = process.env.E2E_REUSE_DEV_SERVER === '1';

export default defineConfig({
  testDir: './e2e',
  testIgnore: ['**/*.png', '**/helpers.ts'],
  timeout: 60_000,
  expect: { timeout: 5_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL: `http://localhost:${UI_PORT}`,
    headless: true,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
  ],
  // Auto-start the full dev stack (server + UI) when tests run. Tests can
  // opt out by setting E2E_REUSE_DEV_SERVER=1 if they already have `npm run dev`
  // open in another terminal.
  webServer: REUSE_DEV
    ? undefined
    : [
        {
          command: 'npm run dev --workspace=@flowforge/server',
          url: `http://localhost:${API_PORT}/api/health`,
          timeout: 120_000,
          reuseExistingServer: true,
          stdout: 'pipe',
          stderr: 'pipe',
          env: { PORT: API_PORT },
        },
        {
          command: 'npm run dev --workspace=@flowforge/ui',
          url: `http://localhost:${UI_PORT}`,
          timeout: 120_000,
          reuseExistingServer: true,
          stdout: 'pipe',
          stderr: 'pipe',
          env: { VITE_PORT: UI_PORT },
        },
      ],
});
