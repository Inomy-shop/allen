/**
 * Brand identity — single source of truth for the project's public name.
 *
 * To rename the project, change the constants in this file and in
 * packages/ui/src/lib/brand.ts. The following things are NOT covered by
 * these constants and require separate, explicit renames:
 *
 *   - npm package names (@allen/*)  — 4 package.json files
 *   - environment variable names (ALLEN_*)  — .env.production + systemd
 *     EnvironmentFile on the deployed host
 *   - on-disk path identifiers (~/.allen, /tmp/allen, /var/lib/allen) —
 *     defined in packages/engine/src/paths.ts
 *   - CSS class names (.prose-allen) — in packages/ui/src/index.css
 *   - domain, terraform resource names, DNS records, ACM cert —
 *     in infra/
 *   - systemd unit filename (allen.service) — in infra/templates/
 *   - file names containing "allen" (allen-mcp-server.ts, etc.)
 *   - MongoDB database name default — shared: see DB_NAME_DEFAULT below
 *   - GitHub Actions workflow filename (deploy-allen.yml)
 *
 * See RENAME.md at the repo root for the full rename runbook.
 */

/** Display name used in UI copy, system prompts, log prefixes. PascalCase. */
export const BRAND_NAME = 'Allen';

/** Slug / identifier form used in MCP server registration, branch prefix, log tags. Lowercase. */
export const BRAND_SLUG = 'allen';

/** Default MongoDB database name. Override via MONGODB_URI env var. */
export const DB_NAME_DEFAULT = BRAND_SLUG;

/** MCP server identity registered with Claude / Codex. Must match on both sides. */
export const MCP_SERVER_NAME = BRAND_SLUG;

/** Git branch prefix for auto-generated worktree branches. */
export const GIT_BRANCH_PREFIX = BRAND_SLUG;

/** Git commit author identity used by automated commits. */
export const GIT_COMMIT_AUTHOR_NAME = `${BRAND_NAME} Agent`;
export const GIT_COMMIT_AUTHOR_EMAIL = `${BRAND_SLUG}@local`;

/** Prefix for console.log / console.warn lines that originate in this codebase. */
export const LOG_TAG = BRAND_SLUG;
