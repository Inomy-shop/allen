import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import type { Db } from 'mongodb';
import { loadAgents, validateWorkflow, getBuiltIns } from '@allen/engine';
import type { WorkflowDef } from '@allen/engine';

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
  const yamlAgents = loadAgents();
  const builtInNames = Object.keys(getBuiltIns());

  // Merge DB agents (source of truth) with YAML agents for validation
  const dbAgents = await db.collection('agents').find({}, { projection: { name: 1, system: 1 } }).toArray();
  const agents: Record<string, any> = { ...yamlAgents };
  for (const a of dbAgents) {
    agents[a.name as string] = { system: (a.system as string) ?? '' };
  }

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
  let updated = 0;
  const files = readdirSync(workflowDir).filter(f => f.endsWith('.yml') || f.endsWith('.yaml'));

  for (const file of files) {
    const content = readFileSync(join(workflowDir, file), 'utf-8');
    const parsed = yaml.load(content) as WorkflowDef;

    const existing = await col.findOne({ name: parsed.name });
    const validation = validateWorkflow(parsed, agents, builtInNames);

    if (!existing) {
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
      continue;
    }

    // Auto-update system-seeded workflows when the YAML on disk changes.
    // User-edited workflows (createdBy !== 'system') are never touched.
    const isSystemSeed = existing.createdBy === 'system';
    const yamlChanged = existing.yaml !== content;
    if (isSystemSeed && yamlChanged) {
      await col.updateOne(
        { _id: existing._id },
        {
          $set: {
            description: parsed.description ?? '',
            yaml: content,
            parsed,
            validation,
            updatedAt: new Date(),
          },
        },
      );
      updated++;
      console.log(`[seed] Updated built-in workflow: ${parsed.name}`);
    }
  }

  console.log(`Seeded ${seeded} new, updated ${updated} default workflows (${files.length} checked)`);
}
