import { test, expect } from '@playwright/test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { API } from './helpers';

test.skip(process.env.ALLEN_REAL_AGENT_E2E !== '1', 'Set ALLEN_REAL_AGENT_E2E=1 to run real-agent knowledge graph E2E.');

test.describe('real-agent repo knowledge graph indexing', () => {
  test.setTimeout(20 * 60 * 1000);

  test('indexes a fixture repo and injects graph context into a workflow node', async ({ request }) => {
    const repoPath = mkdtempSync(join(tmpdir(), 'allen-kg-e2e-'));
    try {
      writeFileSync(join(repoPath, 'AGENTS.md'), 'Always read docs/production.md before changing payments code.\n');
      mkdirSync(join(repoPath, 'docs'), { recursive: true });
      writeFileSync(join(repoPath, 'docs', 'production.md'), 'Payments reconciliation must remain idempotent across retries.\n');
      mkdirSync(join(repoPath, '.claude/skills/payment-debugging'), { recursive: true });
      writeFileSync(join(repoPath, '.claude/skills/payment-debugging/SKILL.md'), '# Payment Debugging\nUse for refund reconciliation failures.\n');
      mkdirSync(join(repoPath, 'payments'), { recursive: true });
      writeFileSync(join(repoPath, 'payments/README.md'), 'Payments module owns refund reconciliation.\n');
      writeFileSync(join(repoPath, 'package.json'), JSON.stringify({ scripts: { test: 'echo ok', build: 'echo build' } }, null, 2));
      execFileSync('git', ['init'], { cwd: repoPath });
      execFileSync('git', ['add', '.'], { cwd: repoPath });
      execFileSync('git', ['commit', '-m', 'fixture'], {
        cwd: repoPath,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 'E2E',
          GIT_AUTHOR_EMAIL: 'e2e@example.com',
          GIT_COMMITTER_NAME: 'E2E',
          GIT_COMMITTER_EMAIL: 'e2e@example.com',
        },
      });

      const createRepo = await request.post(`${API}/api/repos`, {
        data: { path: repoPath, name: `kg-e2e-${Date.now()}` },
      });
      expect(createRepo.ok()).toBeTruthy();
      const repo = await createRepo.json();
      const repoId = repo._id;

      const schedule = await request.post(`${API}/api/repos/${repoId}/index-knowledge-graph`);
      expect([202, 409]).toContain(schedule.status());

      let graph: any | undefined;
      for (let i = 0; i < 90; i++) {
        const res = await request.get(`${API}/api/repos/${repoId}/knowledge-graph`);
        if (res.ok()) {
          graph = await res.json();
          if ((graph.nodes ?? []).length > 0) break;
        }
        await new Promise((r) => setTimeout(r, 10_000));
      }
      expect(graph?.nodes?.length).toBeGreaterThan(0);
      const graphText = JSON.stringify(graph);
      expect(graphText).toContain('AGENTS.md');
      expect(graphText).toContain('production');
      expect(graphText).toContain('skill');

      const workflowYaml = `
name: kg-e2e-node-context-${Date.now()}
description: E2E workflow for repo knowledge context injection.
input:
  repo_path:
    type: string
    required: true
  user_request:
    type: string
    required: true
nodes:
  inspect:
    type: agent
    agent: repo-knowledge-graph-indexer
    prompt: |
      Inspect this small repo for the request: {{user_request}}
      Repo path: {{repo_path}}
      Return a tiny valid graph JSON. Also include context usage fields if they were provided.
    outputs:
      repoSummary: Summary of the repo.
edges:
  - from: START
    to: inspect
  - from: inspect
    to: END
`;
      const createWorkflow = await request.post(`${API}/api/workflows/import`, { data: { yaml: workflowYaml } });
      expect(createWorkflow.ok()).toBeTruthy();
      const workflow = await createWorkflow.json();

      const run = await request.post(`${API}/api/executions`, {
        data: { workflowId: workflow._id, input: { repo_path: repoPath, user_request: 'Check payment refund reconciliation guidance' } },
      });
      expect(run.ok()).toBeTruthy();
      const execution = await run.json();

      let completed = false;
      for (let i = 0; i < 90; i++) {
        const statusRes = await request.get(`${API}/api/executions/${execution.id}`);
        const status = await statusRes.json();
        if (status.status === 'completed') {
          completed = true;
          break;
        }
        if (status.status === 'failed') throw new Error(status.errorMessage ?? 'workflow failed');
        await new Promise((r) => setTimeout(r, 10_000));
      }
      expect(completed).toBeTruthy();

      const usageRes = await request.get(`${API}/api/executions/${execution.id}/context-usage`);
      expect(usageRes.ok()).toBeTruthy();
      const usage = await usageRes.json();
      expect(usage.packets.length).toBeGreaterThan(0);
      expect(usage.usage.length).toBeGreaterThan(0);
    } finally {
      rmSync(repoPath, { recursive: true, force: true });
    }
  });
});
