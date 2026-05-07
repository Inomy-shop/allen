import { test, expect } from '@playwright/test';
import { execSync } from 'child_process';
import { UI } from './helpers';

// ── Guard: check python3 availability before running any tests ─────────────

let python3Available = true;
try {
  execSync('python3 --version', { stdio: 'pipe' });
} catch {
  python3Available = false;
}

// ── Fixture data ───────────────────────────────────────────────────────────

const FAKE_REPO_ID = '000000000000000000000001';
const FAKE_REPO = {
  _id: FAKE_REPO_ID,
  name: 'test-mcp-repo',
  path: '/home/user/test-mcp-repo',
};

const PYTHON_SERVER_ID = '000000000000000000000002';
const PYTHON_SERVER = {
  _id: PYTHON_SERVER_ID,
  name: 'test-python-mcp',
  description: 'A Python MCP server for testing',
  type: 'stdio',
  enabled: true,
  status: 'connected',
  source: {
    kind: 'repo',
    repoId: FAKE_REPO_ID,
    entryPath: 'src/mcp_server.py',
  },
  command: 'python3',
  toolCount: 0,
};

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Intercept MCP + Repos API calls so tests are self-contained and work
 * without specific database state.
 */
async function mockMcpApis(page: import('@playwright/test').Page) {
  // Discovery must be registered first (more specific path wins)
  await page.route('**/api/mcp/servers/discover/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ candidates: [] }),
    }),
  );

  // Return empty server list for GET /api/mcp/servers (list call)
  await page.route('**/api/mcp/servers', (route) => {
    if (route.request().method() === 'GET') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([]),
      });
    }
    return route.continue();
  });

  // Return one fake repo
  await page.route('**/api/repos', (route) => {
    if (route.request().method() === 'GET') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([FAKE_REPO]),
      });
    }
    return route.continue();
  });
}

/** Navigate to Settings > MCP Servers with API mocks in place. */
async function gotoMcpSettings(page: import('@playwright/test').Page) {
  await mockMcpApis(page);
  await page.setViewportSize({ width: 1400, height: 800 });
  await page.goto(`${UI}/settings/mcp`);
  await page.waitForTimeout(1500);
}

/**
 * Like mockMcpApis but returns a Python server in the server list and also
 * intercepts the test/reinstall endpoints so tests 6 & 7 are self-contained.
 *
 * Uses a single broad catch-all handler for all /api/mcp/ requests that
 * dispatches by URL content and HTTP method. This avoids any LIFO
 * route-ordering ambiguity that arises when multiple page.route() calls
 * compete for the same URL prefix.
 */
async function mockMcpApisWithPythonServer(page: import('@playwright/test').Page) {
  // Single handler for all /api/mcp/** requests
  await page.route('**/api/mcp/**', (route) => {
    const url = route.request().url();
    const method = route.request().method();

    // Discovery scan endpoint
    if (url.includes('/discover/')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ candidates: [] }),
      });
    }

    // Test connection endpoint (POST .../servers/{id}/test)
    if (method === 'POST' && url.endsWith('/test')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ status: 'connected', toolCount: 1 }),
      });
    }

    // Reinstall endpoint (POST .../servers/{id}/reinstall)
    if (method === 'POST' && url.endsWith('/reinstall')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          skipped: true,
          reason: 'python-no-auto-install',
          message:
            'Python MCP deps are user-managed. Ensure the interpreter specified in Command has the required packages installed.',
        }),
      });
    }

    // Server list (GET /api/mcp/servers)
    if (method === 'GET' && url.endsWith('/mcp/servers')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([PYTHON_SERVER]),
      });
    }

    return route.continue();
  });

  // Repos list
  await page.route('**/api/repos', (route) => {
    if (route.request().method() === 'GET') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([FAKE_REPO]),
      });
    }
    return route.continue();
  });
}

/** Navigate to Settings > MCP Servers with a Python server pre-loaded. */
async function gotoMcpSettingsWithPythonServer(page: import('@playwright/test').Page) {
  await mockMcpApisWithPythonServer(page);
  await page.setViewportSize({ width: 1400, height: 800 });
  await page.goto(`${UI}/settings/mcp`);
  await page.waitForTimeout(1500);
}

/** Open Add modal and switch to the "From Repo" tab. */
async function openAddFromRepoModal(page: import('@playwright/test').Page) {
  await page.locator('button:has-text("Add")').click();
  await page.waitForTimeout(500);
  await page.locator('button:has-text("From Repo")').click();
  await page.waitForTimeout(300);
}

/** Select the fake repo and wait for discovery to complete. */
async function pickFakeRepo(page: import('@playwright/test').Page) {
  const repoSelect = page.locator('select').first();
  await expect(repoSelect).toBeVisible({ timeout: 3000 });
  await repoSelect.selectOption(FAKE_REPO_ID);
  // Wait for the (mocked) discovery response to arrive
  await page.waitForTimeout(800);
}

// ── Tests ──────────────────────────────────────────────────────────────────

test.describe('Python MCP server support', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeAll(() => {
    if (!python3Available) test.skip();
  });

  // ── 1. Page load ──────────────────────────────────────────────────────────

  test('Settings > MCP Servers page loads', async ({ page }) => {
    await gotoMcpSettings(page);
    await expect(page.locator('text=Configured Servers')).toBeVisible();
  });

  // ── 2. Modal discovery ─────────────────────────────────────────────────────

  test('Add modal opens and "From Repo" tab is available', async ({ page }) => {
    await gotoMcpSettings(page);
    await openAddFromRepoModal(page);

    // Modal header
    await expect(page.locator('text=Add MCP Server')).toBeVisible();
    // Both tabs are rendered
    await expect(page.locator('button:has-text("From Preset")')).toBeVisible();
    await expect(page.locator('button:has-text("From Repo")')).toBeVisible();
    // Repo dropdown is visible after switching tabs
    await expect(page.locator('select').first()).toBeVisible();
  });

  // ── 3. Command auto-fill for .py ──────────────────────────────────────────

  test('.py entry path auto-fills Command input with "python3"', async ({ page }) => {
    await gotoMcpSettings(page);
    await openAddFromRepoModal(page);
    await pickFakeRepo(page);

    // The entry file text input appears after repo selection
    const entryInput = page.locator('input[placeholder*="or type path"]');
    await expect(entryInput).toBeVisible({ timeout: 3000 });

    // Type a Python entry file path
    await entryInput.fill('src/mcp_server.py');
    await page.waitForTimeout(300);

    // Command field must appear with value "python3"
    const commandInput = page.locator('input[placeholder*="python3"]');
    await expect(commandInput).toBeVisible({ timeout: 3000 });
    await expect(commandInput).toHaveValue('python3');
  });

  // ── 4. Python deps hint for .py ───────────────────────────────────────────

  test('.py entry path shows "Python deps are not auto-installed" hint', async ({ page }) => {
    await gotoMcpSettings(page);
    await openAddFromRepoModal(page);
    await pickFakeRepo(page);

    const entryInput = page.locator('input[placeholder*="or type path"]');
    await expect(entryInput).toBeVisible({ timeout: 3000 });
    await entryInput.fill('src/mcp_server.py');
    await page.waitForTimeout(300);

    // Helper hint should appear below the Command field
    await expect(
      page.locator('text=Python deps are not auto-installed'),
    ).toBeVisible({ timeout: 3000 });
  });

  // ── 5. No hint for .ts ────────────────────────────────────────────────────

  test('.ts entry path does NOT show the Python deps hint', async ({ page }) => {
    await gotoMcpSettings(page);
    await openAddFromRepoModal(page);
    await pickFakeRepo(page);

    const entryInput = page.locator('input[placeholder*="or type path"]');
    await expect(entryInput).toBeVisible({ timeout: 3000 });
    await entryInput.fill('src/mcp_server.ts');
    await page.waitForTimeout(300);

    // Python hint must be absent for TypeScript entry files
    await expect(
      page.locator('text=Python deps are not auto-installed'),
    ).not.toBeVisible();

    // Command should be npx tsx (not python3)
    const commandInput = page.locator('input[placeholder*="python3"]');
    await expect(commandInput).toHaveValue('npx tsx');
  });

  // ── 6. Test button — connected status ─────────────────────────────────────

  test('Test button shows connected status for Python MCP', async ({ page }) => {
    // Set up mocks (Python server list + test endpoint) before navigating
    await gotoMcpSettingsWithPythonServer(page);

    // Server card must be visible
    await expect(page.locator(`text=${PYTHON_SERVER.name}`)).toBeVisible({ timeout: 5000 });

    // Status badge already shows Connected (server.status === 'connected')
    await expect(page.locator('text=Connected')).toBeVisible({ timeout: 3000 });

    // Click the "Test connection" button (icon-only button, identified by title)
    const testBtn = page.locator('button[title="Test connection"]');
    await expect(testBtn).toBeVisible({ timeout: 3000 });
    await testBtn.click();

    // Flash message should appear: "✓ 1 tool"
    // (toolCount=1 → singular "tool" per the component's template string)
    await expect(page.locator('text=1 tool')).toBeVisible({ timeout: 5000 });

    // Connected badge still visible after the refresh triggered by onChange()
    await expect(page.locator('text=Connected')).toBeVisible({ timeout: 3000 });
  });

  // ── 7. Reinstall button — Python skip flash ────────────────────────────────

  test('Reinstall button shows Python skip flash for Python MCP', async ({ page }) => {
    // Set up mocks (Python server list + reinstall endpoint) before navigating
    await gotoMcpSettingsWithPythonServer(page);

    // Server card must be visible
    await expect(page.locator(`text=${PYTHON_SERVER.name}`)).toBeVisible({ timeout: 5000 });

    // Reinstall button is only rendered for repo-sourced servers
    const reinstallBtn = page.locator('button[title="Reinstall dependencies"]');
    await expect(reinstallBtn).toBeVisible({ timeout: 3000 });
    await reinstallBtn.click();

    // Flash message should contain the Python user-managed skip text
    await expect(
      page.locator('text=Python MCP deps are user-managed'),
    ).toBeVisible({ timeout: 5000 });
  });
});
