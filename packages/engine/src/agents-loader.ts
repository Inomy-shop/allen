import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import type { AgentDef } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Load agents from the default agents.yml and optionally a custom path.
 */
export function loadAgents(customPath?: string): Record<string, AgentDef> {
  let agents: Record<string, AgentDef> = {};

  // Load default agents
  const defaultPath = join(__dirname, '..', 'agents.yml');
  if (existsSync(defaultPath)) {
    const content = readFileSync(defaultPath, 'utf-8');
    const parsed = yaml.load(content) as { agents: Record<string, AgentDef> };
    agents = parsed.agents ?? parsed;
  }

  // Load custom agents (override defaults)
  if (customPath && existsSync(customPath)) {
    const content = readFileSync(customPath, 'utf-8');
    const parsed = yaml.load(content) as { agents: Record<string, AgentDef> };
    const custom = parsed.agents ?? parsed;
    Object.assign(agents, custom);
  }

  return agents;
}
