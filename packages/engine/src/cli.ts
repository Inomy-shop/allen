#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import yaml from 'js-yaml';
import { MongoClient } from 'mongodb';
import { FlowForgeEngine } from './engine.js';
import { loadRoles } from './roles-loader.js';
import { loadRouter, autoRoute } from './router.js';
import { getBuiltIns } from './built-ins/index.js';
import { validateWorkflow } from './validator.js';
import { generateMermaid } from './visualizer.js';
import type { WorkflowDef, SSEEvent, EngineEventEmitter } from './types.js';

const args = process.argv.slice(2);
const command = args[0];

function usage(): void {
  console.log(`
FlowForge CLI

Usage:
  flowforge run <workflow.yml> --input '{"key":"value"}'
  flowforge run --task "description" [--repo /path]
  flowforge validate <workflow.yml>
  flowforge visualize <workflow.yml>
  flowforge list

Options:
  --input     JSON input for the workflow
  --task      Task description (for auto-routing)
  --repo      Repository path
  --db        MongoDB URI (default: mongodb://localhost:27017/flowforge)
  `);
}

class ConsoleEmitter implements EngineEventEmitter {
  emit(event: SSEEvent): void {
    const ts = new Date().toISOString().slice(11, 19);
    switch (event.event) {
      case 'execution_started':
        console.log(`\n[${ts}] ▶ Execution started: ${event.data.workflowName}`);
        break;
      case 'node_started':
        console.log(`[${ts}] ● Node started: ${event.data.node} (${event.data.role ?? 'code'})`);
        break;
      case 'node_completed':
        console.log(`[${ts}] ✓ Node completed: ${event.data.node} (${event.data.durationMs}ms)`);
        break;
      case 'node_failed':
        console.log(`[${ts}] ✗ Node failed: ${event.data.node} — ${event.data.error}`);
        break;
      case 'node_retrying':
        console.log(`[${ts}] ↻ Retrying: ${event.data.node} (attempt ${event.data.attempt})`);
        break;
      case 'execution_completed':
        console.log(`[${ts}] ✓ Execution completed (${event.data.durationMs}ms)\n`);
        break;
      case 'execution_failed':
        console.log(`[${ts}] ✗ Execution failed: ${event.data.error}\n`);
        break;
      case 'agent_text':
        process.stdout.write(event.data.text as string);
        break;
      case 'parallel_started':
        console.log(`[${ts}] ⫘ Parallel: ${(event.data.nodes as string[]).join(', ')} (${event.data.joinPolicy})`);
        break;
      case 'parallel_joined':
        console.log(`[${ts}] ⫘ Parallel joined`);
        break;
      default:
        break;
    }
  }
}

function loadWorkflow(path: string): WorkflowDef {
  const content = readFileSync(resolve(path), 'utf-8');
  return yaml.load(content) as WorkflowDef;
}

function getArg(name: string): string | undefined {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 ? args[idx + 1] : undefined;
}

async function main(): Promise<void> {
  if (!command || command === '--help' || command === '-h') {
    usage();
    process.exit(0);
  }

  if (command === 'validate') {
    const file = args[1];
    if (!file) { console.error('Usage: flowforge validate <workflow.yml>'); process.exit(1); }
    const workflow = loadWorkflow(file);
    const roles = loadRoles();
    const builtIns = getBuiltIns();
    const result = validateWorkflow(workflow, roles, Object.keys(builtIns));
    if (result.errors.length > 0) {
      console.error('Errors:');
      result.errors.forEach(e => console.error(`  ✗ ${e}`));
    }
    if (result.warnings.length > 0) {
      console.warn('Warnings:');
      result.warnings.forEach(w => console.warn(`  ⚠ ${w}`));
    }
    if (result.valid) {
      console.log('✓ Workflow is valid');
    }
    process.exit(result.valid ? 0 : 1);
  }

  if (command === 'visualize') {
    const file = args[1];
    if (!file) { console.error('Usage: flowforge visualize <workflow.yml>'); process.exit(1); }
    const workflow = loadWorkflow(file);
    console.log(generateMermaid(workflow));
    process.exit(0);
  }

  if (command === 'run') {
    const dbUri = getArg('db') ?? 'mongodb://localhost:27017/flowforge';
    const client = new MongoClient(dbUri);
    await client.connect();
    const db = client.db();

    const roles = loadRoles();
    const builtIns = getBuiltIns();
    const emitter = new ConsoleEmitter();

    // Load all workflows from default directory
    const { readdirSync } = await import('node:fs');
    const { join, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const workflowDir = join(__dirname, '..', 'workflows');
    const workflows: Record<string, WorkflowDef> = {};

    try {
      for (const file of readdirSync(workflowDir)) {
        if (file.endsWith('.yml') || file.endsWith('.yaml')) {
          const wf = yaml.load(readFileSync(join(workflowDir, file), 'utf-8')) as WorkflowDef;
          workflows[wf.name] = wf;
        }
      }
    } catch {
      // No default workflows directory — that's fine
    }

    // Also load the specified workflow file if provided
    const file = args[1];
    let workflow: WorkflowDef | undefined;

    if (file && !file.startsWith('--')) {
      workflow = loadWorkflow(file);
      workflows[workflow.name] = workflow;
    }

    // Auto-route if --task is provided
    const task = getArg('task');
    const repoPath = getArg('repo');

    if (task && !workflow) {
      const router = loadRouter();
      const inputKeys = repoPath ? ['repo_path'] : [];
      const workflowName = autoRoute(task, inputKeys, router);
      workflow = workflows[workflowName];
      if (!workflow) {
        console.error(`Auto-routed to workflow '${workflowName}' but it was not found.`);
        process.exit(1);
      }
      console.log(`Auto-routed to workflow: ${workflowName}`);
    }

    if (!workflow) {
      console.error('No workflow specified. Use a file path or --task for auto-routing.');
      process.exit(1);
    }

    // Build input
    let input: Record<string, unknown> = {};
    const inputJson = getArg('input');
    if (inputJson) {
      input = JSON.parse(inputJson);
    }
    if (task) input.task = task;
    if (repoPath) input.repo_path = repoPath;

    const engine = new FlowForgeEngine({
      db,
      roles,
      builtIns,
      workflows,
      emitter,
    });

    try {
      const result = await engine.run(workflow, input);
      console.log('\nResult:');
      console.log(JSON.stringify(result, null, 2));
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`\nExecution failed: ${message}`);
      process.exit(1);
    } finally {
      await client.close();
    }
    return;
  }

  console.error(`Unknown command: ${command}`);
  usage();
  process.exit(1);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
