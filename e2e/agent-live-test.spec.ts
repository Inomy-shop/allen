import { test, expect } from '@playwright/test';

const API = 'http://localhost:4023';
const UI = 'http://localhost:5173';

test.describe.serial('Live Agent Spawn & Execution Detail', () => {

  let chatSessionId: string;
  let executionId: string;

  test('1. Send message via UI to trigger agent spawn', async ({ page }) => {
    await page.setViewportSize({ width: 1400, height: 900 });
    await page.goto(`${UI}/chat`);
    await page.waitForTimeout(2000);

    // Select engineer agent
    const engineerBtn = page.locator('button:has-text("Engineer")').first();
    if (await engineerBtn.count() > 0) {
      await engineerBtn.click();
      await page.waitForTimeout(300);
    }

    // Type message and send
    const input = page.locator('textarea').first();
    await input.fill('List the top 3 largest files in this project. Use spawn_agent with coding-investigator.');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(2000);

    // Get session ID from URL
    const url = page.url();
    const match = url.match(/\/chat\/([a-f0-9]+)/);
    chatSessionId = match?.[1] ?? '';
    console.log('Chat session:', chatSessionId);
    console.log('Message sent, waiting for agent spawn...');
  });

  test('2. Poll for new spawn_agent execution', async ({ request }) => {
    const startTime = Date.now();
    for (let i = 0; i < 40; i++) {
      await new Promise(r => setTimeout(r, 3000));

      const res = await request.get(`${API}/api/executions`);
      const execs = await res.json();
      const all = execs.data ?? execs;

      // Find ANY execution started in the last 2 minutes
      const recent = all.find((e: any) => {
        const age = Date.now() - new Date(e.startedAt).getTime();
        return age < 180000 && e.workflowName?.startsWith('chat:spawn_agent/');
      });

      if (recent) {
        executionId = recent.id;
        console.log(`[${Math.round((Date.now() - startTime) / 1000)}s] Found execution: ${executionId.slice(0, 12)}`);
        console.log('  workflow:', recent.workflowName);
        console.log('  status:', recent.status);
        console.log('  meta:', JSON.stringify(recent.meta ?? {}));
        console.log('  input.repo_path:', recent.input?.repo_path ?? 'NONE');
        break;
      }
      console.log(`[${Math.round((Date.now() - startTime) / 1000)}s] Waiting...`);
    }

    expect(executionId).toBeTruthy();
  }, 180000);

  test('3. Verify new execution has metadata', async ({ request }) => {
    if (!executionId) { console.log('SKIP'); return; }

    const res = await request.get(`${API}/api/executions/${executionId}`);
    const exec = await res.json();

    console.log('=== New Execution ===');
    console.log('status:', exec.status);
    console.log('meta:', JSON.stringify(exec.meta ?? {}, null, 2));
    console.log('input.repo_path:', exec.input?.repo_path);

    // NEW executions MUST have meta
    expect(exec.meta).toBeTruthy();
    expect(exec.meta.provider).toBeTruthy();
    expect(exec.meta.spawnedBy).toBeTruthy();
    console.log('✓ meta.cwd:', exec.meta.cwd);
    console.log('✓ meta.provider:', exec.meta.provider);
    console.log('✓ meta.spawnedBy:', exec.meta.spawnedBy);
    console.log('✓ meta.chatSessionId:', exec.meta.chatSessionId);
  });

  test('4. Check live logs persisted', async ({ request }) => {
    if (!executionId) { console.log('SKIP'); return; }

    // Wait for some logs
    await new Promise(r => setTimeout(r, 5000));

    const res = await request.get(`${API}/api/executions/${executionId}/logs?limit=50`);
    const logs = await res.json();
    console.log('Logs count:', logs.length);
    for (const l of logs.slice(0, 15)) {
      console.log(`  [${l.type}] ${l.tool ?? l.content ?? ''}`);
    }

    expect(logs.length).toBeGreaterThan(0);
    expect(logs[0].executionId).toBe(executionId);
    console.log('✓ Logs persisted');
  });

  test('5. UI execution detail shows everything', async ({ page }) => {
    if (!executionId) { console.log('SKIP'); return; }

    await page.setViewportSize({ width: 1400, height: 900 });
    await page.goto(`${UI}/executions/${executionId}`);
    await page.waitForTimeout(4000);

    // Verify metadata cards
    await expect(page.locator('.card:has-text("Working Directory")').first()).toBeVisible();
    await expect(page.locator('.card:has-text("Provider")').first()).toBeVisible();
    await expect(page.locator('.card:has-text("Spawned By")').first()).toBeVisible();

    // Live logs section
    await expect(page.locator('text=Live Logs')).toBeVisible();

    // Check CWD is NOT /tmp (should be workspace path)
    const cwdCard = page.locator('.card:has-text("Working Directory")').first();
    const cwdText = await cwdCard.textContent();
    console.log('CWD card text:', cwdText);

    const providerCard = page.locator('.card:has-text("Provider")').first();
    console.log('Provider:', await providerCard.textContent());

    const spawnedByCard = page.locator('.card:has-text("Spawned By")').first();
    console.log('Spawned By:', await spawnedByCard.textContent());

    await page.screenshot({ path: '/Users/shreemantkumar/flowforge/e2e/agent-live-new.png', fullPage: false });
    console.log('✓ Screenshot saved');
  });
});
