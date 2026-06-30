import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import type { WorkflowDef } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKFLOW_DIR = join(__dirname, '..', 'workflows');

describe('seed workflow agentOverrides', () => {
  it('sets provider whenever a node overrides model', () => {
    const offenders: string[] = [];
    for (const file of readdirSync(WORKFLOW_DIR).filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))) {
      const parsed = yaml.load(readFileSync(join(WORKFLOW_DIR, file), 'utf-8')) as WorkflowDef;
      for (const [nodeName, nodeDef] of Object.entries(parsed.nodes ?? {})) {
        const overrides = nodeDef?.agentOverrides;
        if (overrides?.model && !overrides.provider) {
          offenders.push(`${file}:${nodeName}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
