import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import type { Db } from 'mongodb';
import { loadRoles, validateWorkflow, getBuiltIns } from '@flowforge/engine';
import type { WorkflowDef, RoleDef } from '@flowforge/engine';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Seed the database with default roles from roles.yml.
 */
export async function seedDefaultRoles(db: Db): Promise<void> {
  const col = db.collection('roles');
  const roles = loadRoles();

  for (const [name, role] of Object.entries(roles)) {
    const existing = await col.findOne({ name });
    if (!existing) {
      await col.insertOne({
        name,
        system: role.system,
        model: role.model,
        tools: role.tools,
        icon: role.icon,
        color: role.color,
        isBuiltIn: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    }
  }

  console.log(`Seeded ${Object.keys(roles).length} default roles`);
}

/**
 * Seed the database with default workflows from the engine's workflows/ directory.
 */
export async function seedDefaultWorkflows(db: Db): Promise<void> {
  const col = db.collection('workflows');
  const roles = loadRoles();
  const builtInNames = Object.keys(getBuiltIns());

  // Locate the engine's workflows directory
  // In the monorepo, engine is a sibling package
  const possiblePaths = [
    join(__dirname, '..', '..', 'engine', 'workflows'),       // from dist/
    join(__dirname, '..', '..', '..', 'engine', 'workflows'),  // from src/ during dev
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

    const validation = validateWorkflow(parsed, roles, builtInNames);

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
