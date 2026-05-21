import { describe, it, expect } from 'vitest';
import { getAllenMcpConfig, inferCommand } from './mcp-loader';
import { ALLEN_MCP_CLAUDE_TOOL_NAMES, ALLEN_MCP_TOOL_NAMES } from './allen-mcp-tools';

describe('inferCommand', () => {
  it('returns python3 for .py files (REQ-005, AC-006)', () => {
    expect(inferCommand('/path/to/server.py')).toEqual({ command: 'python3', leadingArgs: [] });
  });

  it('returns python3 for .PY files (case-insensitive)', () => {
    expect(inferCommand('/path/to/Server.PY')).toEqual({ command: 'python3', leadingArgs: [] });
  });

  it('returns npx tsx for .ts files (AC-022 regression)', () => {
    expect(inferCommand('/path/to/server.ts')).toEqual({ command: 'npx', leadingArgs: ['tsx'] });
  });

  it('returns npx tsx for .tsx files (AC-022 regression)', () => {
    expect(inferCommand('/path/to/server.tsx')).toEqual({ command: 'npx', leadingArgs: ['tsx'] });
  });

  it('returns node for .js files (AC-022 regression)', () => {
    expect(inferCommand('/path/to/server.js')).toEqual({ command: 'node', leadingArgs: [] });
  });

  it('returns node for .mjs files (AC-022 regression)', () => {
    expect(inferCommand('/path/to/server.mjs')).toEqual({ command: 'node', leadingArgs: [] });
  });

  it('returns node for .cjs files (AC-022 regression)', () => {
    expect(inferCommand('/path/to/server.cjs')).toEqual({ command: 'node', leadingArgs: [] });
  });
});

describe('Allen MCP tool allowlist', () => {
  it('includes repo knowledge graph persistence for graph indexer agents', () => {
    expect(ALLEN_MCP_TOOL_NAMES).toContain('save_repo_knowledge_graph');
    expect(ALLEN_MCP_CLAUDE_TOOL_NAMES).toContain('mcp__allen__save_repo_knowledge_graph');
  });

  it('resolves the built-in Allen MCP server from the monorepo root', () => {
    const originalCwd = process.cwd();
    process.chdir('../..');
    try {
      const config = getAllenMcpConfig();
      const args = config?.args as string[] | undefined;
      expect(config).toBeTruthy();
      expect(args?.[0]).toBe('tsx');
      expect(args?.some((arg) => arg.includes('packages/server/src/services/allen-mcp-server.ts'))).toBe(true);
    } finally {
      process.chdir(originalCwd);
    }
  });
});
