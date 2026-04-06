/**
 * MCP Server Service
 * Manages user-configured MCP server configurations stored in MongoDB.
 * Servers are loaded at chat startup and passed to Claude Code SDK.
 */

import type { Db } from 'mongodb';
import { ObjectId } from 'mongodb';

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

export const MCP_PRESETS: Array<{
  name: string;
  description: string;
  type: 'stdio' | 'sse';
  command?: string;
  args?: string[];
  envKeys: string[];
  /** Args that user must provide — appended to args[] at the end */
  argKeys?: string[];
  docsUrl: string;
}> = [
  {
    name: 'linear',
    description: 'Linear project management — issues, projects, teams',
    type: 'stdio',
    command: 'npx',
    args: ['-y', 'mcp-server-linear'],
    envKeys: ['LINEAR_ACCESS_TOKEN'],
    docsUrl: 'https://github.com/dvcrn/mcp-server-linear',
  },
  {
    name: 'github',
    description: 'GitHub — repos, issues, PRs, actions',
    type: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
    envKeys: ['GITHUB_PERSONAL_ACCESS_TOKEN'],
    docsUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/github',
  },
  {
    name: 'postgres',
    description: 'PostgreSQL database — read-only SQL queries',
    type: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-postgres'],
    envKeys: [],
    argKeys: ['POSTGRES_CONNECTION_STRING'],
    docsUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/postgres',
  },
  {
    name: 'mongodb',
    description: 'MongoDB / DocumentDB — query collections, read documents',
    type: 'stdio',
    command: 'npx',
    args: ['-y', 'mcp-mongo-server'],
    envKeys: [],
    argKeys: ['MONGODB_CONNECTION_STRING'],
    docsUrl: 'https://github.com/kiliczsh/mcp-mongo-server',
  },
  {
    name: 'slack',
    description: 'Slack — channels, messages, users',
    type: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-slack'],
    envKeys: ['SLACK_BOT_TOKEN', 'SLACK_TEAM_ID'],
    docsUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/slack',
  },
  {
    name: 'filesystem',
    description: 'Local filesystem — read/write files in allowed directories',
    type: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
    envKeys: [],
    docsUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem',
  },
  {
    name: 'memory',
    description: 'Knowledge graph memory — persistent entity storage',
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
   */
  async getEnabledAsConfig(): Promise<Record<string, unknown>> {
    const servers = await this.collection.find({ enabled: true }).toArray() as McpServerRecord[];
    const config: Record<string, unknown> = {};

    for (const s of servers) {
      if (s.type === 'stdio') {
        config[s.name] = {
          type: 'stdio',
          command: s.command,
          args: s.args ?? [],
          env: s.env ?? {},
        };
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
}
