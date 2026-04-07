import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import type { Db } from 'mongodb';
import { loadAgents, validateWorkflow, getBuiltIns } from '@flowforge/engine';
import type { WorkflowDef, AgentDef } from '@flowforge/engine';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Seed the database with default agents from agents.yml.
 */
export async function seedDefaultAgents(db: Db): Promise<void> {
  const col = db.collection('agents');
  const agents = loadAgents();

  for (const [name, agent] of Object.entries(agents)) {
    await col.updateOne(
      { name },
      {
        $set: {
          system: agent.system,
          model: agent.model,
          provider: agent.provider,
          tools: agent.tools,
          icon: agent.icon,
          color: agent.color,
          type: agent.type ?? 'technical',
          displayName: agent.displayName ?? name,
          personality: agent.personality,
          capabilities: agent.capabilities ?? [],
          canDelegateTo: agent.canDelegateTo ?? [],
          canTrigger: agent.canTrigger ?? [],
          isBuiltIn: true,
          updatedAt: new Date(),
        },
        $setOnInsert: { createdAt: new Date() },
      },
      { upsert: true },
    );
  }

  // Ensure indexes for agent_conversations collection
  const convCol = db.collection('agent_conversations');
  await convCol.createIndex({ chatSessionId: 1 }).catch(() => {});
  await convCol.createIndex({ fromAgent: 1, toAgent: 1 }).catch(() => {});

  console.log(`Seeded ${Object.keys(agents).length} default agents`);
}

/**
 * Seed the database with default workflows from the engine's workflows/ directory.
 */
export async function seedDefaultWorkflows(db: Db): Promise<void> {
  const col = db.collection('workflows');
  const agents = loadAgents();
  const builtInNames = Object.keys(getBuiltIns());

  // Locate the engine's workflows directory
  const possiblePaths = [
    join(__dirname, '..', '..', 'engine', 'workflows'),
    join(__dirname, '..', '..', '..', 'engine', 'workflows'),
  ];

  let workflowDir: string | null = null;
  for (const p of possiblePaths) {
    if (existsSync(p)) {
      workflowDir = p;
      break;
    }
  }

  if (!workflowDir) {
    console.log('No default workflows directory found — skipping seed');
    return;
  }

  let seeded = 0;
  const files = readdirSync(workflowDir).filter(f => f.endsWith('.yml') || f.endsWith('.yaml'));

  for (const file of files) {
    const content = readFileSync(join(workflowDir, file), 'utf-8');
    const parsed = yaml.load(content) as WorkflowDef;

    const existing = await col.findOne({ name: parsed.name });
    if (existing) continue;

    const validation = validateWorkflow(parsed, agents, builtInNames);

    await col.insertOne({
      name: parsed.name,
      description: parsed.description ?? '',
      version: 1,
      yaml: content,
      parsed,
      reactFlowData: null,
      validation,
      tags: ['default'],
      createdBy: 'system',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    seeded++;
  }

  console.log(`Seeded ${seeded} default workflows (${files.length} checked)`);
}
