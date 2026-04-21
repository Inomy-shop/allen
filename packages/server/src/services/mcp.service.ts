/**
 * MCP Server Service
 * Manages user-configured MCP server configurations stored in MongoDB.
 * Servers are loaded at chat startup and passed to Claude Code SDK.
 */

import type { Db } from 'mongodb';
import { ObjectId } from 'mongodb';

// Secrets model has been removed. MCP env/args come from Allen's root .env
// via the ALLEN_ prefix convention — see mcp-loader.ts for the resolution
// rules. The `@secret:KEY` reference format, encrypted secrets collection,
// and per-MCP secret CRUD are all gone.

// ── Types ──

/**
 * Discriminated union describing where an MCP server's code and base config
 * come from. `preset` points at one of the hardcoded MCP_PRESETS. `repo`
 * points at an entry file inside an already-registered repo clone.
 */
export type McpServerSource =
  | { kind: 'preset'; presetName: string }
  | { kind: 'repo'; repoId: string; entryPath: string; installPath?: string };

export interface McpServerRecord {
  _id?: ObjectId;
  /**
   * Owning user. `null`/absent means "implicit admin" — shows up only in
   * admin's MCP list. New records are always stamped. Admin has no visibility
   * override for this collection (strictest scoping).
   */
  ownerId?: ObjectId | null;
  name: string;
  description: string;
  type: 'stdio' | 'sse' | 'http';
  enabled: boolean;

  /**
   * Source of truth for the MCP server. When set, the loader builds command/
   * args/cwd from here (vs reading bundlePath). Absence means legacy bundle-
   * based record — spawn path falls through to the bundleId branch.
   */
  source?: McpServerSource;

  /**
   * Env var names the MCP subprocess expects (the BARE names, e.g.
   * `POSTGRES_HOST`). At spawn, each name `X` resolves to `process.env.ALLEN_X`
   * from Allen's root .env and is passed as `X` to the subprocess. Only these
   * keys are forwarded — the child never sees Allen's other env.
   */
  envKeys?: string[];

  // stdio
  command?: string;
  args?: string[];
  /** @deprecated legacy literal env (may contain `@secret:KEY` refs). Prefer envKeys. */
  env?: Record<string, string>;

  // sse / http
  url?: string;
  headers?: Record<string, string>;

  /** @deprecated bundle-upload flow — kept so existing records keep spawning. */
  bundleId?: string;
  /** @deprecated absolute path to the extracted bundle dir */
  bundlePath?: string;
  /** @deprecated relative entry point inside the bundle */
  bundleEntry?: string;

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
   * BARE env var names that the spawned subprocess reads (e.g.
   * `LINEAR_ACCESS_TOKEN`). The user adds `ALLEN_<NAME>` to Allen's root
   * `.env` and the spawn loader strips the prefix before passing to the child.
   * Null/empty means "no env required".
   */
  envKeys: string[];
  /**
   * Bare arg-key names that get appended to `args[]` at spawn time from
   * `process.env.ALLEN_<key>`. Used by MCP servers that take config as a
   * positional CLI argument (e.g. postgres connection string) rather than env.
   */
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
    // User adds ALLEN_LINEAR_ACCESS_TOKEN to .env; subprocess sees LINEAR_ACCESS_TOKEN.
    envKeys: ['LINEAR_ACCESS_TOKEN'],
    docsUrl: 'https://github.com/dvcrn/mcp-server-linear',
  },
  {
    name: 'github',
    description: 'GitHub — repos, issues, PRs, code search',
    type: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
    envKeys: ['GITHUB_PERSONAL_ACCESS_TOKEN'],
    docsUrl: 'https://github.com/modelcontextprotocol/servers-archived/tree/main/src/github',
  },
  {
    name: 'postgres',
    description: 'PostgreSQL — schema management, queries, performance analysis',
    type: 'stdio',
    command: 'npx',
    // The connection string is the LAST arg (appended at spawn from
    // process.env.ALLEN_POSTGRES_CONNECTION_STRING). `--connection-string` is a
    // fixed literal flag that precedes the argKeys expansion.
    args: ['-y', '@henkey/postgres-mcp-server', '--connection-string'],
    envKeys: [],
    argKeys: ['POSTGRES_CONNECTION_STRING'],
    docsUrl: 'https://github.com/HenkDz/postgresql-mcp-server',
  },
  {
    name: 'mongodb',
    description: 'MongoDB — query collections, schema inference, aggregations',
    type: 'stdio',
    command: 'npx',
    args: ['-y', 'mcp-mongo-server'],
    envKeys: [],
    argKeys: ['MONGODB_CONNECTION_STRING'],
    docsUrl: 'https://github.com/kiliczsh/mcp-mongo-server',
  },
  {
    name: 'slack',
    description: 'Slack — channels, messages, users (legacy package, still functional)',
    type: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-slack'],
    envKeys: ['SLACK_BOT_TOKEN', 'SLACK_TEAM_ID'],
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
   * Get all enabled MCP servers as Claude Code SDK config. Delegates to the
   * shared engine resolver so source-based (preset/repo) and legacy
   * bundle-based records are handled the same way agent execution handles them.
   */
  async getEnabledAsConfig(): Promise<Record<string, unknown>> {
    const { buildSingleServerConfig } = await import('@allen/engine');
    const servers = await this.collection.find({ enabled: true }).toArray() as McpServerRecord[];
    const config: Record<string, unknown> = {};
    for (const s of servers) {
      if (s.type === 'stdio') {
        const cfg = await buildSingleServerConfig(s as unknown as Record<string, unknown>, this.db);
        if (cfg) config[s.name] = cfg;
      } else if (s.type === 'sse') {
        config[s.name] = { type: 'sse', url: s.url, headers: s.headers ?? {} };
      } else if (s.type === 'http') {
        config[s.name] = { type: 'http', url: s.url, headers: s.headers ?? {} };
      }
    }
    return config;
  }

  getPresets() {
    return MCP_PRESETS;
  }
}
