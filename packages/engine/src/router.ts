import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import type { RouterConfig } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function loadRouter(customPath?: string): RouterConfig {
  const defaultPath = join(__dirname, '..', 'router.yml');
  const path = customPath ?? defaultPath;

  if (!existsSync(path)) {
    return { rules: [], fallback: 'ask-user' };
  }

  const content = readFileSync(path, 'utf-8');
  return yaml.load(content) as RouterConfig;
}

/**
 * Auto-select a workflow based on task description and available inputs.
 */
export function autoRoute(
  task: string,
  inputKeys: string[],
  router: RouterConfig,
): string {
  const taskLower = task.toLowerCase();

  for (const rule of router.rules) {
    // Check keyword match
    const matchScore = rule.match.filter(kw => taskLower.includes(kw)).length;
    if (matchScore === 0) continue;

    // Check required inputs
    if (rule.has_input) {
      const hasAll = rule.has_input.every(k => inputKeys.includes(k));
      if (!hasAll) continue;
    }

    return rule.workflow;
  }

  return router.fallback;
}
