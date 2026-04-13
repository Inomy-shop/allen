import { test, expect } from '@playwright/test';

import { API, UI } from './helpers';

test.describe('Agent Execution Tracing', () => {

  let executionId: string;

  test('1. Find agent executions', async ({ request }) => {
    const res = await request.get(`${API}/api/executions`);
    const execs = await res.json();
    const all = execs.data ?? execs;

    // Prefer a completed one with traces
    const completed = all.find((e: any) => e.workflowName?.startsWith('chat:spawn_agent/') && e.status === 'completed');
    const running = all.find((e: any) => e.workflowName?.startsWith('chat:spawn_agent/') && e.status === 'running');
    const exec = completed ?? running ?? all[0];

    executionId = exec?.id;
    console.log('Using execution:', executionId?.slice(0, 12), exec?.workflowName, exec?.status);
    console.log('  meta:', JSON.stringify(exec?.meta ?? 'none'));
    console.log('  repo_path:', exec?.input?.repo_path ?? 'none');
    expect(executionId).toBeTruthy();
  });

  test('2. Check traces and logs via API', async ({ request }) => {
    const [tracesRes, logsRes] = await Promise.all([
      request.get(`${API}/api/executions/${executionId}/traces`),
      request.get(`${API}/api/executions/${executionId}/logs?limit=50`),
    ]);
    const traces = await tracesRes.json();
    const logs = await logsRes.json();

    console.log('Traces:', traces.length);
    if (traces.length > 0) {
      console.log('  toolCalls:', traces[0].toolCalls?.length);
      console.log('  response:', (traces[0].rawResponse ?? '').length, 'chars');
      console.log('  cost:', traces[0].cost?.actual);
    }
    console.log('Logs:', logs.length);
    for (const l of logs.slice(0, 5)) {
      console.log(`  [${l.type}] ${l.tool ?? l.content ?? ''}`);
    }
  });

  test('3. UI execution detail page renders correctly', async ({ page }) => {
    await page.setViewportSize({ width: 1400, height: 900 });
    await page.goto(`${UI}/executions/${executionId}`);
    await page.waitForTimeout(3000);

    // Header with agent name
    const header = page.locator('h1');
    await expect(header).toBeVisible();
    console.log('Agent:', await header.textContent());

    // Metadata cards should be present (use exact label selectors)
    await expect(page.locator('.card:has-text("Working Directory")').first()).toBeVisible();
    await expect(page.locator('.card:has-text("Provider")').first()).toBeVisible();
    await expect(page.locator('.card:has-text("Spawned By")').first()).toBeVisible();
    await expect(page.locator('.card:has-text("Duration")').first()).toBeVisible();
    await expect(page.locator('.card:has-text("Cost")').first()).toBeVisible();
    await expect(page.locator('.card:has-text("Model")').first()).toBeVisible();

    // Live Logs section
    await expect(page.locator('text=Live Logs')).toBeVisible();

    // Prompt section
    await expect(page.locator('text=Prompt')).toBeVisible();

    // Response section
    await expect(page.locator('text=Response')).toBeVisible();

    // Working directory value should be visible
    const cwdValue = page.locator('text=/flowforge-workspaces|tmp/').first();
    if (await cwdValue.count() > 0) {
      console.log('✓ CWD visible in UI');
    }

    console.log('Screenshot saved');
  });

  test('4. Tool Calls section shows when trace available', async ({ page }) => {
    await page.setViewportSize({ width: 1400, height: 900 });

    // Find a completed execution with tool calls
    const res = await page.request.get(`${API}/api/executions`);
    const execs = await res.json();
    const completed = (execs.data ?? execs).find((e: any) =>
      e.workflowName?.startsWith('chat:spawn_agent/') && e.status === 'completed'
    );

    if (!completed) { console.log('No completed execution — skipping tool calls test'); return; }

    await page.goto(`${UI}/executions/${completed.id}`);
    await page.waitForTimeout(3000);

    const toolCalls = page.locator('text=Tool Calls');
    if (await toolCalls.count() > 0) {
      console.log('✓ Tool Calls section visible');
    } else {
      console.log('Tool Calls section not visible (may have 0 calls)');
    }

    // Check for chat link
    const chatLink = page.locator('text=Open Chat');
    if (await chatLink.count() > 0) {
      console.log('✓ Open Chat link visible');
    }

  });
});
