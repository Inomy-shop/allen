/**
 * MCP Server Service
 * Manages user-configured MCP server configurations stored in MongoDB.
 * Servers are loaded at chat startup and passed to Claude Code SDK.
 */

import type { Db } from 'mongodb';
import { ObjectId } from 'mongodb';
import { buildMcpSourceEnvForServer } from '../runtime/mcp-credentials.js';
import type { BuildMcpConfigOptions } from '@allen/engine';

// MCP env/args come from Allen's root .env via the ALLEN_ prefix convention.
// See mcp-loader.ts for the resolution rules.

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
   * Owner attribution. Reads are shared across all authenticated users —
   * all mcp_servers documents are visible regardless of ownerId. This field
   * identifies who created the MCP server and is used for display grouping
   * in the UI. `null`/absent means "implicit admin-created". New records are
   * always stamped with the creating user's id.
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

  /**
   * Python-specific config. Set when source is a repo entry ending in .py
   * AND the user has not supplied a manual `command` override. Allen creates
   * a per-MCP venv at <ALLEN_HOME>/venvs/<_id>/ on first spawn, runs
   * `pip install -r <requirementsPath>` once, and spawns subsequent runs with
   * that venv's python. To pick up dep changes, delete the MCP and re-add it.
   */
  python?: {
    /** Bootstrap interpreter (e.g. 'python3' or absolute path). Default 'python3'. */
    interpreter?: string;
    /** Repo-relative path to requirements.txt. Auto-detected from sibling file when blank. */
    requirementsPath?: string;
  };

  // stdio
  command?: string;
  args?: string[];
  /** @deprecated legacy literal env passthrough on existing records. Prefer envKeys for new servers. */
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
  type: 'stdio' | 'sse' | 'http';
  command?: string;
  args?: string[];
  url?: string;
  headers?: Record<string, string>;
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
    name: 'google-workspace',
    description: 'Google Workspace — Gmail, Drive, Docs, Sheets, Calendar, Chat, and more',
    type: 'stdio',
    command: 'uvx',
    args: ['workspace-mcp'],
    envKeys: ['GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET', 'OAUTHLIB_INSECURE_TRANSPORT'],
    docsUrl: 'https://workspacemcp.com/',
  },
  {
    name: 'google-docs',
    description: 'Google Docs — read, create, and update docs through Workspace MCP',
    type: 'stdio',
    command: 'uvx',
    args: ['workspace-mcp', '--tools', 'docs', 'drive'],
    envKeys: ['GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET', 'OAUTHLIB_INSECURE_TRANSPORT'],
    docsUrl: 'https://pypi.org/project/workspace-mcp/',
  },
  {
    name: 'google-sheets',
    description: 'Google Sheets — inspect and update spreadsheets through Workspace MCP',
    type: 'stdio',
    command: 'uvx',
    args: ['workspace-mcp', '--tools', 'sheets', 'drive'],
    envKeys: ['GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET', 'OAUTHLIB_INSECURE_TRANSPORT'],
    docsUrl: 'https://pypi.org/project/workspace-mcp/',
  },
  {
    name: 'google-meet',
    description: 'Google Meet — schedule and update Meet links through Google Calendar',
    type: 'stdio',
    command: 'uvx',
    args: ['workspace-mcp', '--tools', 'calendar'],
    envKeys: ['GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET', 'OAUTHLIB_INSECURE_TRANSPORT'],
    docsUrl: 'https://pypi.org/project/workspace-mcp/',
  },
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
    name: 'jira',
    description: 'Jira — search, read, and update Jira issues through Atlassian MCP',
    type: 'stdio',
    command: 'uvx',
    args: ['mcp-atlassian'],
    envKeys: ['JIRA_URL', 'JIRA_USERNAME', 'JIRA_API_TOKEN'],
    docsUrl: 'https://mcp-atlassian.soomiles.com/docs/configuration',
  },
  {
    name: 'figma',
    description: 'Figma Desktop — design context from the local Figma Dev Mode MCP server',
    type: 'http',
    url: 'http://127.0.0.1:3845/mcp',
    envKeys: [],
    docsUrl: 'https://developers.figma.com/docs/figma-mcp-server/local-server-installation/',
  },
  {
    name: 'postgres',
    description: 'PostgreSQL — read-only SQL queries (official MCP)',
    type: 'stdio',
    command: 'npx',
    // Connection string is appended as the last positional arg at spawn time
    // from process.env.ALLEN_POSTGRES_CONNECTION_STRING (via argKeys).
    args: ['-y', '@modelcontextprotocol/server-postgres'],
    envKeys: [],
    argKeys: ['POSTGRES_CONNECTION_STRING'],
    docsUrl: 'https://github.com/modelcontextprotocol/servers-archived/tree/main/src/postgres',
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
    name: 'mysql',
    description: 'MySQL — read-only queries, schema inspection, and table metadata',
    type: 'stdio',
    command: 'npx',
    args: ['-y', '@matpb/mysql-mcp-server'],
    envKeys: ['MYSQL_HOST', 'MYSQL_PORT', 'MYSQL_USER', 'MYSQL_PASSWORD', 'MYSQL_DATABASE'],
    docsUrl: 'https://github.com/matpb/mysql-mcp-server',
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
  // {
  //   name: 'memory',
  //   description: 'Knowledge graph — persistent entity & relationship memory',
  //   type: 'stdio',
  //   command: 'npx',
  //   args: ['-y', '@modelcontextprotocol/server-memory'],
  //   envKeys: [],
  //   docsUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/memory',
  // },
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
  async getEnabledAsConfig(externalServerNames?: string[]): Promise<Record<string, unknown>> {
    const { buildSingleServerConfig } = await import('@allen/engine');
    const servers = await this.collection.find({ enabled: true }).toArray() as McpServerRecord[];
    const allowedExternal = externalServerNames
      ? new Set(externalServerNames.filter((name) => typeof name === 'string' && name.length > 0))
      : null;
    const config: Record<string, unknown> = {};
    for (const s of servers) {
      if (allowedExternal && !allowedExternal.has(s.name)) continue;
      if (s.type === 'stdio') {
        const options = { sourceEnv: await buildMcpSourceEnvForServer(s) } satisfies BuildMcpConfigOptions;
        const cfg = await buildSingleServerConfig(s as unknown as Record<string, unknown>, this.db, options);
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
