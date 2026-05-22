import { readFileSync, existsSync } from 'node:fs';
import yaml from 'js-yaml';
import type { AgentDef } from './types.js';

/**
 * Load agents from an optional custom YAML path.
 *
 * The legacy default `agents.yml` fallback has been intentionally removed.
 * Runtime agents are seeded from OrgSeedService into the database and loaded
 * from there at execution/validation time. Loading the legacy file as a
 * fallback caused unseeded agents to leak into validation results and the
 * execution agent registry, silently overriding or shadowing DB-seeded agents.
 *
 * Callers that previously relied on the default file (seedDefaultAgents,
 * seedDefaultWorkflows, loadAllAgents) all merge with DB agents anyway — so
 * the YAML-only fallback was redundant. Removing it makes the DB the single
 * source of truth.
 *
 * The `customPath` parameter is preserved for tests and tooling that need to
 * load a specific YAML file.
 */
export function loadAgents(customPath?: string): Record<string, AgentDef> {
  const agents: Record<string, AgentDef> = {};

  // Load custom agents when explicitly requested (tests, one-off tooling).
  if (customPath && existsSync(customPath)) {
    const content = readFileSync(customPath, 'utf-8');
    const parsed = yaml.load(content) as { agents: Record<string, AgentDef> };
    const custom = parsed.agents ?? parsed;
    Object.assign(agents, custom);
  }

  return agents;
}
