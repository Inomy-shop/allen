import { defineConfig } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const UI_PORT = process.env.UI_PORT || '5173';
const API_PORT = process.env.API_PORT || process.env.PORT || '4023';
// Skip auto-starting servers when the user already has `npm run dev` running.
const REUSE_DEV = process.env.E2E_REUSE_DEV_SERVER === '1';

// Auth state produced by scripts/e2e-preauth.ts before `playwright test`
// runs. Both files are present by the time this config is evaluated because
// `npm run test:e2e` chains the preauth step first.
const STORAGE_STATE_PATH = resolve(__dirname, 'e2e/.auth/storageState.json');
const ACCESS_TOKEN_PATH = resolve(__dirname, 'e2e/.auth/accessToken.txt');

// Parse the storageState file into an object rather than passing the path.
// Playwright handles the object form more reliably for localStorage-only
// fixtures (no cookies) — the path form has had issues injecting localStorage
// on first navigation in some versions.
const preAuthStorageState = existsSync(STORAGE_STATE_PATH)
  ? (JSON.parse(readFileSync(STORAGE_STATE_PATH, 'utf8')) as {
      cookies: never[];
      origins: Array<{ origin: string; localStorage: Array<{ name: string; value: string }> }>;
    })
  : undefined;

const preAuthHeaders = existsSync(ACCESS_TOKEN_PATH)
  ? { Authorization: `Bearer ${readFileSync(ACCESS_TOKEN_PATH, 'utf8').trim()}` }
  : undefined;

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
    // Pre-auth (from scripts/e2e-preauth.ts):
    // - storageState populates localStorage so page-based tests skip /login
    // - extraHTTPHeaders injects Authorization on request-fixture tests
    storageState: preAuthStorageState,
    extraHTTPHeaders: preAuthHeaders,
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
          command: 'npm run dev --workspace=@allen/server',
          url: `http://localhost:${API_PORT}/api/health`,
          timeout: 120_000,
          reuseExistingServer: true,
          stdout: 'pipe',
          stderr: 'pipe',
          env: { PORT: API_PORT },
        },
        {
          command: 'npm run dev --workspace=@allen/ui',
          url: `http://localhost:${UI_PORT}`,
          timeout: 120_000,
          reuseExistingServer: true,
          stdout: 'pipe',
          stderr: 'pipe',
          env: { VITE_PORT: UI_PORT },
        },
      ],
});
