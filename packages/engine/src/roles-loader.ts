import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import type { RoleDef } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Load roles from the default roles.yml and optionally a custom path.
 */
export function loadRoles(customPath?: string): Record<string, RoleDef> {
  let roles: Record<string, RoleDef> = {};

  // Load default roles
  const defaultPath = join(__dirname, '..', 'roles.yml');
  if (existsSync(defaultPath)) {
    const content = readFileSync(defaultPath, 'utf-8');
    const parsed = yaml.load(content) as { roles: Record<string, RoleDef> };
    roles = parsed.roles ?? parsed;
  }

  // Load custom roles (override defaults)
  if (customPath && existsSync(customPath)) {
    const content = readFileSync(customPath, 'utf-8');
    const parsed = yaml.load(content) as { roles: Record<string, RoleDef> };
    const custom = parsed.roles ?? parsed;
    Object.assign(roles, custom);
  }

  return roles;
}
