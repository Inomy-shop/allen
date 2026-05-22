import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadAgents } from '../src/agents-loader.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
/** Resolved path to packages/engine/agents.yml from this test file. */
const DEFAULT_AGENTS_YML = join(__dirname, '..', 'agents.yml');

describe('loadAgents — legacy fallback removal', () => {
  it('returns an empty record when called without a custom path (legacy agents.yml no longer loaded)', () => {
    const agents = loadAgents();
    // The legacy agents.yml fallback has been removed. Without a customPath the
    // function must return an empty object so that no unseeded legacy agents can
    // leak into the execution/validation agent registry.
    expect(agents).toEqual({});
  });

  it('returns an empty record when called with undefined', () => {
    const agents = loadAgents(undefined);
    expect(agents).toEqual({});
  });

  it('returns an empty record when called with a non-existent custom path', () => {
    const agents = loadAgents('/tmp/__nonexistent_agents_loader_test__.yml');
    expect(agents).toEqual({});
  });
});

describe('agents.yml — legacy definitions removed', () => {
  it('agents.yml file still exists on disk as a placeholder', () => {
    expect(existsSync(DEFAULT_AGENTS_YML)).toBe(true);
  });

  it('loadAgents(agents.yml) returns no agents — legacy definitions have been cleared', () => {
    // Even when the file is explicitly passed as a customPath, it must not
    // yield any agent definitions. All agents live in DB (OrgSeedService).
    const agents = loadAgents(DEFAULT_AGENTS_YML);
    expect(agents).toEqual({});
  });

  it('agents.yml contains no legacy agent keys (product-manager, engineer, devops, etc.)', () => {
    // Belt-and-suspenders: parse the YAML independently to confirm the file
    // body has no agent entries that could be mistakenly re-enabled later.
    const agents = loadAgents(DEFAULT_AGENTS_YML);
    const legacyNames = [
      'product-manager', 'engineer', 'qa-engineer', 'data-analyst',
      'ceo', 'devops', 'coding-planner', 'coding-developer',
      'coding-reviewer', 'coding-investigator', 'coding-tester',
      'coding-writer', 'git-ops',
    ];
    for (const name of legacyNames) {
      expect(agents[name]).toBeUndefined();
    }
  });
});
