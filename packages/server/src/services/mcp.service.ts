/**
 * MCP Server Service
 * Manages user-configured MCP server configurations stored in MongoDB.
 * Servers are loaded at chat startup and passed to Claude Code SDK.
 */

import type { Db } from 'mongodb';
import { ObjectId } from 'mongodb';
import { SecretService } from './secret.service.js';

/**
 * Sentinel prefix used in `mcp_servers.env` values to mark a reference to a
 * secret in the encrypted `secrets` collection. Example: `@secret:LINEAR_API_KEY`
 * means "look up the secret named LINEAR_API_KEY at spawn time".
 */
export const MCP_SECRET_PREFIX = '@secret:';

/**
 * Returns true if a value in mcp_servers.env is a secret reference rather than
 * a literal value.
 */
export function isMcpSecretRef(value: string): boolean {
  return typeof value === 'string' && value.startsWith(MCP_SECRET_PREFIX);
}

/**
 * Walk an env object and replace `@secret:KEY` references with their decrypted
 * plaintext values from the secrets store. Literal values are passed through.
 * Missing/empty secrets are dropped from the resulting env (with a warning) so
 * the spawned process doesn't get an empty env var that could cause confusing
 * downstream errors.
 */
export async function resolveEnvSecrets(
  env: Record<string, string> | undefined,
  db: Db,
): Promise<Record<string, string>> {
  if (!env) return {};
  const secrets = new SecretService(db);
  const resolved: Record<string, string> = {};
  for (const [envVar, raw] of Object.entries(env)) {
    if (typeof raw !== 'string') continue;
    if (!isMcpSecretRef(raw)) {
      // Legacy literal value — pass through. Migration will move these.
      resolved[envVar] = raw;
      continue;
    }
    const key = raw.slice(MCP_SECRET_PREFIX.length);
    const value = await secrets.get(key);
    if (value == null) {
      console.warn(`[mcp] Secret "${key}" referenced by env var "${envVar}" not found in secrets store`);
      continue;
    }
    resolved[envVar] = value;
  }
  return resolved;
}

/**
 * For each literal value in `env`, store it as a secret named after the env var
 * (e.g. LINEAR_ACCESS_TOKEN → secrets.LINEAR_ACCESS_TOKEN) and replace the
 * literal in the returned env with `@secret:LINEAR_ACCESS_TOKEN`.
 *
 * Already-referenced values (`@secret:...`) are passed through unchanged.
 *
 * Called from POST/PUT MCP routes so the API never persists plaintext credentials.
 */
export async function storeEnvLiteralsAsSecrets(
  env: Record<string, string> | undefined,
  db: Db,
): Promise<Record<string, string>> {
  if (!env) return {};
  const secrets = new SecretService(db);
  const out: Record<string, string> = {};
  for (const [envVar, raw] of Object.entries(env)) {
    if (typeof raw !== 'string' || raw === '') continue;
    if (isMcpSecretRef(raw)) {
      // Already a reference — keep as-is
      out[envVar] = raw;
      continue;
    }
    // Literal value — move into the secrets store under the env var's name
    await secrets.set(envVar, raw);
    out[envVar] = `${MCP_SECRET_PREFIX}${envVar}`;
  }
  return out;
}

/**
 * Resolve `@secret:KEY` references inside an args array. Literal entries are
 * passed through. Missing references resolve to an empty string and log a
 * warning so the spawned process at least starts (and reveals the misconfig).
 */
export async function resolveArgSecrets(
  args: string[] | undefined,
  db: Db,
): Promise<string[]> {
  if (!args || args.length === 0) return [];
  const secrets = new SecretService(db);
  const out: string[] = [];
  for (const raw of args) {
    if (typeof raw !== 'string') continue;
    if (!isMcpSecretRef(raw)) {
      out.push(raw);
      continue;
    }
    const key = raw.slice(MCP_SECRET_PREFIX.length);
    const value = await secrets.get(key);
    if (value == null) {
      console.warn(`[mcp] Secret "${key}" referenced in args not found in secrets store`);
      out.push('');
      continue;
    }
    out.push(value);
  }
  return out;
}

/**
 * Take a literal connection-string-style arg and store it as a secret named
 * after the preset's argKey (e.g. POSTGRES_CONNECTION_STRING). Returns the
 * args array with the literal entries replaced by `@secret:...` references.
 *
 * Uses the preset definition to know which positional args are sensitive: the
 * last `presetArgKeys.length` entries of the args array are assumed to be the
 * user-supplied secret values (matching how AddFromPreset builds them).
 *
 * If the server name doesn't match a preset (custom config), args are passed
 * through unchanged — we can't safely guess which positional args are sensitive.
 */
export async function storeArgLiteralsAsSecretsForPreset(
  presetName: string | undefined,
  args: string[] | undefined,
  db: Db,
): Promise<string[]> {
  if (!args || args.length === 0) return args ?? [];
  if (!presetName) return args;

  const preset = MCP_PRESETS.find(p => p.name === presetName);
  const argKeys = preset?.argKeys ?? [];
  if (argKeys.length === 0) return args;
  if (args.length < argKeys.length) return args;

  const secrets = new SecretService(db);
  const out = [...args];
  // The last N args correspond to argKeys[0..N-1] in order.
  const startIdx = out.length - argKeys.length;
  for (let i = 0; i < argKeys.length; i++) {
    const idx = startIdx + i;
    const argKey = argKeys[i];
    const raw = out[idx];
    if (typeof raw !== 'string' || raw === '') continue;
    if (isMcpSecretRef(raw)) continue; // already a reference
    await secrets.set(argKey, raw);
    out[idx] = `${MCP_SECRET_PREFIX}${argKey}`;
  }
  return out;
}

// ── Types ──

export interface McpServerRecord {
  _id?: ObjectId;
  name: string;
  description: string;
  type: 'stdio' | 'sse' | 'http';
  enabled: boolean;

  // stdio
  command?: string;
  args?: string[];
  env?: Record<string, string>;

  // sse / http
  url?: string;
  headers?: Record<string, string>;

  // Bundle — set when uploaded via the zip bundle flow. When present, the
  // spawn logic resolves command=node, cwd=<bundlePath>, args=[<bundlePath>/<entry>]
  // and the rest of args[] is ignored (reserved for future extension).
  bundleId?: string;
  bundlePath?: string;    // absolute path to the extracted bundle dir
  bundleEntry?: string;   // relative entry point inside the bundle

  // Status (updated on connection test)
  status: 'connected' | 'failed' | 'untested' | 'disabled';
  lastTestedAt?: Date;
  lastError?: string;
  serverInfo?: { name: string; version: string };
  toolCount?: number;

  createdAt: Date;
  updatedAt: Date;
}

export type McpServerInput = Omit<McpServerRecord, '_id' | 'status' | 'createdAt' | 'updatedAt' | 'lastTestedAt' | 'lastError' | 'serverInfo' | 'toolCount'>;

// ── Presets for common MCP servers ──

export interface McpPreset {
  name: string;
  description: string;
  type: 'stdio' | 'sse';
  command?: string;
  args?: string[];
  /**
   * Names of secrets the UI should ask the user to provide. These also serve as
   * the env var names the spawned process will receive — UNLESS overridden in
   * `envVarOverrides`. This indirection lets one shared secret (e.g.
   * `GITHUB_PERSONAL_ACCESS_TOKEN`) feed multiple consumers that disagree on
   * what to call the env var (e.g. `gh` CLI reads `GH_TOKEN`).
   */
  envKeys: string[];
  /** Map secret-key → actual env var name passed to the child process. */
  envVarOverrides?: Record<string, string>;
  /** Args the user must provide — appended to args[] at the end. */
  argKeys?: string[];
  docsUrl: string;
}

export const MCP_PRESETS: McpPreset[] = [
  {
    name: 'linear',
    description: 'Linear — issues, projects, teams, comments',
    type: 'stdio',
    command: 'npx',
    args: ['-y', 'mcp-server-linear'],
    envKeys: ['ALLEN_LINEAR_ACCESS_TOKEN'],
    envVarOverrides: { ALLEN_LINEAR_ACCESS_TOKEN: 'LINEAR_ACCESS_TOKEN' },
    docsUrl: 'https://github.com/dvcrn/mcp-server-linear',
  },
  {
    // Community GitHub MCP server, launched via npx so no separate install is
    // needed. We previously shipped `gh mcp` here, but that subcommand is only
    // present in a narrow band of gh CLI builds and silently exits when absent
    // — which the health checker reports as a spawn failure. Using the npm
    // package matches how the slack preset is wired and removes the gh version
    // dependency entirely. The package reads GITHUB_PERSONAL_ACCESS_TOKEN from
    // the env, which we map from the Allen-prefixed secret.
    name: 'github',
    description: 'GitHub — repos, issues, PRs, code search',
    type: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
    envKeys: ['ALLEN_GITHUB_PERSONAL_ACCESS_TOKEN'],
    envVarOverrides: { ALLEN_GITHUB_PERSONAL_ACCESS_TOKEN: 'GITHUB_PERSONAL_ACCESS_TOKEN' },
    docsUrl: 'https://github.com/modelcontextprotocol/servers-archived/tree/main/src/github',
  },
  {
    name: 'postgres',
    description: 'PostgreSQL — schema management, queries, performance analysis',
    type: 'stdio',
    command: 'npx',
    // The connection string is the LAST arg (matches storeArgLiteralsAsSecretsForPreset
    // assumption that argKeys map to the trailing args). The `--connection-string`
    // flag is fixed and stays as a literal.
    args: ['-y', '@henkey/postgres-mcp-server', '--connection-string'],
    envKeys: [],
    argKeys: ['ALLEN_POSTGRES_CONNECTION_STRING'],
    docsUrl: 'https://github.com/HenkDz/postgresql-mcp-server',
  },
  {
    name: 'mongodb',
    description: 'MongoDB — query collections, schema inference, aggregations',
    type: 'stdio',
    command: 'npx',
    args: ['-y', 'mcp-mongo-server'],
    envKeys: [],
    argKeys: ['ALLEN_MONGODB_CONNECTION_STRING'],
    docsUrl: 'https://github.com/kiliczsh/mcp-mongo-server',
  },
  {
    // NOTE: this npm package is deprecated upstream but still functional.
    // The actively-maintained alternatives use different env var names
    // (SLACK_MCP_XOXP_TOKEN / user OAuth tokens) which would break the
    // shared SLACK_BOT_TOKEN secret pattern. Keep until we add a v2 preset.
    name: 'slack',
    description: 'Slack — channels, messages, users (legacy package, still functional)',
    type: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-slack'],
    envKeys: ['ALLEN_SLACK_BOT_TOKEN', 'ALLEN_SLACK_TEAM_ID'],
    envVarOverrides: { ALLEN_SLACK_BOT_TOKEN: 'SLACK_BOT_TOKEN', ALLEN_SLACK_TEAM_ID: 'SLACK_TEAM_ID' },
    docsUrl: 'https://github.com/modelcontextprotocol/servers-archived/tree/main/src/slack',
  },
  {
    // Default allowed directory is /tmp. Edit args after creation to allow more.
    name: 'filesystem',
    description: 'Local filesystem — read/write inside /tmp by default (edit args to allow more)',
    type: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
    envKeys: [],
    docsUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem',
  },
  {
    name: 'memory',
    description: 'Knowledge graph — persistent entity & relationship memory',
    type: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-memory'],
    envKeys: [],
    docsUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/memory',
  },
];

// ── Service ──

export class McpService {
  private db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  private get collection() {
    return this.db.collection('mcp_servers');
  }

  async list(): Promise<McpServerRecord[]> {
    return this.collection.find({}).sort({ name: 1 }).toArray() as Promise<McpServerRecord[]>;
  }

  async getById(id: string): Promise<McpServerRecord | null> {
    return this.collection.findOne({ _id: new ObjectId(id) }) as Promise<McpServerRecord | null>;
  }

  async getByName(name: string): Promise<McpServerRecord | null> {
    return this.collection.findOne({ name }) as Promise<McpServerRecord | null>;
  }

  async create(input: McpServerInput): Promise<McpServerRecord> {
    const now = new Date();
    const doc: McpServerRecord = {
      ...input,
      status: input.enabled ? 'untested' : 'disabled',
      createdAt: now,
      updatedAt: now,
    };
    const result = await this.collection.insertOne(doc);
    return { ...doc, _id: result.insertedId };
  }

  async update(id: string, input: Partial<McpServerInput>): Promise<McpServerRecord | null> {
    const updates: Record<string, unknown> = { ...input, updatedAt: new Date() };
    if (input.enabled === false) updates.status = 'disabled';
    else if (input.enabled === true) updates.status = 'untested';

    await this.collection.updateOne({ _id: new ObjectId(id) }, { $set: updates });
    return this.getById(id);
  }

  async delete(id: string): Promise<void> {
    await this.collection.deleteOne({ _id: new ObjectId(id) });
  }

  async toggle(id: string): Promise<McpServerRecord | null> {
    const server = await this.getById(id);
    if (!server) return null;
    const enabled = !server.enabled;
    return this.update(id, { enabled });
  }

  /**
   * Update status after a connection test.
   */
  async updateStatus(
    id: string,
    status: 'connected' | 'failed',
    info?: { serverInfo?: { name: string; version: string }; toolCount?: number; error?: string },
  ): Promise<void> {
    await this.collection.updateOne(
      { _id: new ObjectId(id) },
      {
        $set: {
          status,
          lastTestedAt: new Date(),
          serverInfo: info?.serverInfo ?? null,
          toolCount: info?.toolCount ?? 0,
          lastError: info?.error ?? null,
          updatedAt: new Date(),
        },
      },
    );
  }

  /**
   * Get all enabled MCP servers as Claude Code SDK config format.
   * Env values that are `@secret:` references are resolved from the secrets
   * store before being returned, so the spawned MCP process receives plaintext.
   */
  async getEnabledAsConfig(): Promise<Record<string, unknown>> {
    const servers = await this.collection.find({ enabled: true }).toArray() as McpServerRecord[];
    const config: Record<string, unknown> = {};

    for (const s of servers) {
      if (s.type === 'stdio') {
        const resolvedEnv = await resolveEnvSecrets(s.env, this.db);
        // Silence dotenv's startup banner — it writes to stdout and corrupts
        // strict MCP clients (e.g. Codex CLI's rmcp) that expect pure JSON-RPC.
        (resolvedEnv as Record<string, string>).DOTENV_CONFIG_QUIET = 'true';
        const stdioConfig: Record<string, unknown> = {
          type: 'stdio',
          command: s.command,
          args: await resolveArgSecrets(s.args, this.db),
          env: resolvedEnv,
        };
        // Bundle servers must spawn with cwd = bundle dir so that Node can
        // resolve node_modules, relative imports, and dotenv() from the
        // bundle root. Without this, agents can't discover the server's tools.
        if (s.bundlePath) stdioConfig.cwd = s.bundlePath;
        config[s.name] = stdioConfig;
      } else if (s.type === 'sse') {
        config[s.name] = {
          type: 'sse',
          url: s.url,
          headers: s.headers ?? {},
        };
      } else if (s.type === 'http') {
        config[s.name] = {
          type: 'http',
          url: s.url,
          headers: s.headers ?? {},
        };
      }
    }

    return config;
  }

  getPresets() {
    return MCP_PRESETS;
  }

  /**
   * One-shot migration: walk every MCP server config and move any literal
   * credentials (env vars and preset-defined positional args) into the
   * encrypted secrets collection, replacing them with `@secret:<key>` refs.
   *
   * Idempotent — safe to call on every startup. Fully migrated configs are no-ops.
   */
  async migrateLegacyEnvLiterals(): Promise<{ servers: number; secrets: number }> {
    const docs = await this.collection.find({}).toArray() as McpServerRecord[];
    let serversTouched = 0;
    let secretsCreated = 0;

    for (const doc of docs) {
      const update: Record<string, unknown> = {};

      // ── env literals → secret refs ──
      if (doc.env && Object.keys(doc.env).length > 0) {
        const literals: Record<string, string> = {};
        for (const [k, v] of Object.entries(doc.env)) {
          if (typeof v === 'string' && v !== '' && !isMcpSecretRef(v)) literals[k] = v;
        }
        if (Object.keys(literals).length > 0) {
          const migratedSubset = await storeEnvLiteralsAsSecrets(literals, this.db);
          secretsCreated += Object.keys(literals).length;
          update.env = { ...doc.env, ...migratedSubset };
        }
      }

      // ── arg literals → secret refs (preset-aware) ──
      if (doc.args && doc.args.length > 0) {
        const preset = MCP_PRESETS.find(p => p.name === doc.name);
        const argKeys = preset?.argKeys ?? [];
        if (argKeys.length > 0 && doc.args.length >= argKeys.length) {
          // Count how many would actually migrate (to avoid bumping counters needlessly)
          const startIdx = doc.args.length - argKeys.length;
          let willMigrate = 0;
          for (let i = 0; i < argKeys.length; i++) {
            const raw = doc.args[startIdx + i];
            if (typeof raw === 'string' && raw !== '' && !isMcpSecretRef(raw)) willMigrate++;
          }
          if (willMigrate > 0) {
            update.args = await storeArgLiteralsAsSecretsForPreset(doc.name, doc.args, this.db);
            secretsCreated += willMigrate;
          }
        }
      }

      if (Object.keys(update).length > 0) {
        update.updatedAt = new Date();
        await this.collection.updateOne({ _id: doc._id }, { $set: update });
        serversTouched++;
      }
    }

    if (serversTouched > 0) {
      console.log(
        `[mcp] Migrated ${secretsCreated} plaintext credential(s) across ${serversTouched} server(s) into the encrypted secrets store`,
      );
    }
    return { servers: serversTouched, secrets: secretsCreated };
  }

  /**
   * Sync the `description` field on existing MCP server records to match the
   * current preset definition (looked up by `name`). Lets us ship updated
   * descriptions in code without users having to manually re-add their servers.
   *
   * Only touches `description` — never `command`, `args`, `env`, or `enabled`,
   * since users may have customized those (e.g. extra filesystem paths).
   *
   * Idempotent: no-op if the description already matches.
   */
  async syncPresetDescriptions(): Promise<number> {
    const docs = await this.collection.find({}).toArray() as McpServerRecord[];
    let updated = 0;
    for (const doc of docs) {
      const preset = MCP_PRESETS.find(p => p.name === doc.name);
      if (!preset) continue; // custom server, leave alone
      if (doc.description === preset.description) continue; // already synced
      await this.collection.updateOne(
        { _id: doc._id },
        { $set: { description: preset.description, updatedAt: new Date() } },
      );
      console.log(`[mcp] Synced description for "${doc.name}": "${doc.description ?? ''}" → "${preset.description}"`);
      updated++;
    }
    return updated;
  }

  /**
   * One-shot migration: rewrite any existing `github` MCP server rows that
   * still launch `gh mcp` to use the npm-based server instead. Older installs
   * shipped the gh-bundled preset, which depends on a subcommand only some
   * gh builds include; the server crashes on spawn when it's absent.
   *
   * Targets rows where the stored command is `gh` AND the first arg is `mcp`.
   * Preserves any other fields (name, description, icon, custom env keys).
   * Idempotent — no-op once rewritten.
   */
  async migrateGhMcpServerToNpx(): Promise<number> {
    const docs = await this.collection
      .find({ type: 'stdio', command: 'gh' })
      .toArray() as McpServerRecord[];
    let touched = 0;
    for (const doc of docs) {
      const args = doc.args ?? [];
      if (args[0] !== 'mcp') continue; // only rewrite `gh mcp …`, leave other gh wrappers alone
      const env = { ...(doc.env ?? {}) };
      // Remap GH_TOKEN → GITHUB_PERSONAL_ACCESS_TOKEN (what the npm package reads).
      // Preserve the @secret:… reference if one was already set.
      if (env.GH_TOKEN && !env.GITHUB_PERSONAL_ACCESS_TOKEN) {
        env.GITHUB_PERSONAL_ACCESS_TOKEN = env.GH_TOKEN;
      }
      delete env.GH_TOKEN;
      if (!env.GITHUB_PERSONAL_ACCESS_TOKEN) {
        env.GITHUB_PERSONAL_ACCESS_TOKEN = `${MCP_SECRET_PREFIX}ALLEN_GITHUB_PERSONAL_ACCESS_TOKEN`;
      }
      await this.collection.updateOne(
        { _id: doc._id },
        {
          $set: {
            command: 'npx',
            args: ['-y', '@modelcontextprotocol/server-github'],
            env,
            updatedAt: new Date(),
          },
        },
      );
      touched++;
    }
    if (touched > 0) {
      console.log(`[mcp] Rewrote ${touched} legacy \`gh mcp\` server(s) to use @modelcontextprotocol/server-github`);
    }
    return touched;
  }

  /**
   * One-shot migration: ensure any MCP server that wraps the `gh` CLI has
   * `GH_TOKEN: '@secret:GITHUB_PERSONAL_ACCESS_TOKEN'` in its env so the
   * spawned process uses the stored token instead of `gh`'s on-disk auth.
   *
   * Targets servers where command === 'gh' (e.g. `gh mcp serve`). Idempotent —
   * skips servers that already have GH_TOKEN configured.
   */
  async migrateGhCliServersToSecret(): Promise<number> {
    const docs = await this.collection.find({ type: 'stdio', command: 'gh' }).toArray() as McpServerRecord[];
    let touched = 0;
    for (const doc of docs) {
      const env = doc.env ?? {};
      if (env.GH_TOKEN) continue; // already configured
      const newEnv = {
        ...env,
        GH_TOKEN: `${MCP_SECRET_PREFIX}ALLEN_GITHUB_PERSONAL_ACCESS_TOKEN`,
      };
      await this.collection.updateOne(
        { _id: doc._id },
        { $set: { env: newEnv, updatedAt: new Date() } },
      );
      touched++;
    }
    if (touched > 0) {
      console.log(
        `[mcp] Wired ${touched} \`gh\` CLI MCP server(s) to use the GITHUB_PERSONAL_ACCESS_TOKEN secret via GH_TOKEN`,
      );
    }
    return touched;
  }
}
