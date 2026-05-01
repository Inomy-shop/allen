/**
 * Tests for MCP health service — verifying child-process cleanup.
 *
 * Key assertion: after a health check completes (success or failure),
 * the spawned process group must be killed, not just the direct child.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { ObjectId } from 'mongodb';

// Mock @allen/engine before importing the health service
vi.mock('@allen/engine', () => ({
  buildSingleServerConfig: vi.fn(),
}));

import { buildSingleServerConfig } from '@allen/engine';
import type { McpServerRecord } from './mcp.service.js';
import { healthCheckMcpServer, stopMcpHealthMonitor } from './mcp-health.service.js';

const mockDb = {} as any;

function makeServer(
  cmd: string,
  args: string[] = [],
  overrides: Partial<McpServerRecord> = {},
): McpServerRecord {
  return {
    _id: new ObjectId(),
    name: 'test-server',
    description: 'test',
    type: 'stdio',
    enabled: true,
    command: cmd,
    args,
    status: 'untested',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('healthCheckMcpServer', () => {
  afterEach(() => {
    stopMcpHealthMonitor();
    vi.restoreAllMocks();
  });

  // ── Disabled server ────────────────────────────────────────────────────────

  it('returns disabled error immediately for disabled server', async () => {
    const server = makeServer('cat', [], { enabled: false });
    const result = await healthCheckMcpServer(server, mockDb);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/disabled/i);
    expect(result.durationMs).toBe(0);
    // buildSingleServerConfig should never be called for disabled servers
    expect(vi.mocked(buildSingleServerConfig)).not.toHaveBeenCalled();
  });

  // ── Config-resolution failures ─────────────────────────────────────────────

  it('returns error when buildSingleServerConfig returns null', async () => {
    vi.mocked(buildSingleServerConfig).mockResolvedValueOnce(null);
    const server = makeServer('cat');
    const result = await healthCheckMcpServer(server, mockDb);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/could not be resolved/i);
  });

  it('returns error when buildSingleServerConfig throws', async () => {
    vi.mocked(buildSingleServerConfig).mockRejectedValueOnce(new Error('config error'));
    const server = makeServer('cat');
    const result = await healthCheckMcpServer(server, mockDb);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/failed to resolve spawn config/i);
  });

  // ── Process group kill after process exits immediately (fast path) ─────────

  it('kills process group (negative PID) after process exits without MCP handshake', async () => {
    // 'true' exits immediately with code 0 → triggers "process exited prematurely"
    // path without waiting for the 30s SPAWN_TIMEOUT_MS
    const exitImmediatelyCmd = process.platform === 'win32' ? 'cmd' : 'true';
    vi.mocked(buildSingleServerConfig).mockResolvedValueOnce({
      command: exitImmediatelyCmd,
      args: process.platform === 'win32' ? ['/c', 'exit', '0'] : [],
      env: {},
    });

    const killSpy = vi.spyOn(process, 'kill').mockImplementation((_pid, _sig) => true);

    const server = makeServer(exitImmediatelyCmd);
    const result = await healthCheckMcpServer(server, mockDb);

    // 'true' doesn't speak MCP JSON-RPC so it should fail
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/process exited prematurely/i);

    // Verify process.kill was called with a negative PID at least once
    const groupKills = killSpy.mock.calls.filter(
      ([pid]) => typeof pid === 'number' && (pid as number) < 0,
    );
    expect(groupKills.length).toBeGreaterThan(0);

    // The first group signal should be SIGTERM (graceful), not immediate SIGKILL
    expect(groupKills[0][1]).toBe('SIGTERM');
  }, 10_000);

  // ── Process group kill when spawn fails (no PID) ──────────────────────────

  it('returns error and does not crash when spawn uses non-existent command', async () => {
    // This command doesn't exist — spawn will emit an 'error' event (ENOENT)
    vi.mocked(buildSingleServerConfig).mockResolvedValueOnce({
      command: 'this-command-does-not-exist-xyz-abc-123',
      args: [],
      env: {},
    });

    // Don't mock process.kill here — let it attempt to kill naturally;
    // since there's no PID, it falls back to proc.kill('SIGKILL').
    const server = makeServer('this-command-does-not-exist-xyz-abc-123');
    const result = await healthCheckMcpServer(server, mockDb);

    expect(result.ok).toBe(false);
    // spawn error fires → finish() called with process error message
    expect(result.error).toBeDefined();
  }, 10_000);

  // ── stopMcpHealthMonitor is idempotent ─────────────────────────────────────

  it('stopMcpHealthMonitor can be called multiple times without error', () => {
    expect(() => {
      stopMcpHealthMonitor();
      stopMcpHealthMonitor();
      stopMcpHealthMonitor();
    }).not.toThrow();
  });

  // ── Process group kill after successful MCP handshake ─────────────────────

  it('kills process group (negative PID) after successful MCP handshake', async () => {
    // Inline node script that speaks the bare minimum MCP JSON-RPC protocol:
    // reads newline-delimited JSON from stdin, responds to initialize + tools/list.
    const mcpScript = `
      const readline = require('readline');
      const rl = readline.createInterface({ input: process.stdin });
      rl.on('line', (line) => {
        try {
          const msg = JSON.parse(line);
          if (msg.method === 'initialize') {
            process.stdout.write(JSON.stringify({
              jsonrpc: '2.0', id: msg.id,
              result: { serverInfo: { name: 'test-mcp', version: '1.0.0' }, capabilities: {} }
            }) + '\\n');
          } else if (msg.method === 'tools/list') {
            process.stdout.write(JSON.stringify({
              jsonrpc: '2.0', id: msg.id,
              result: { tools: [{ name: 'test-tool', description: 'A test tool', inputSchema: { type: 'object' } }] }
            }) + '\\n');
          }
        } catch { /* ignore parse errors */ }
      });
    `;

    vi.mocked(buildSingleServerConfig).mockResolvedValueOnce({
      command: 'node',
      args: ['-e', mcpScript],
      env: {},
    });

    const killSpy = vi.spyOn(process, 'kill').mockImplementation((_pid, _sig) => true);

    const server = makeServer('node', ['-e', mcpScript]);
    const result = await healthCheckMcpServer(server, mockDb);

    expect(result.ok).toBe(true);
    expect(result.toolCount).toBe(1);
    expect(result.serverInfo?.name).toBe('test-mcp');

    // Verify process group was killed (negative PID) even on success
    const groupKills = killSpy.mock.calls.filter(
      ([pid]) => typeof pid === 'number' && (pid as number) < 0,
    );
    expect(groupKills.length).toBeGreaterThan(0);
    expect(groupKills[0][1]).toBe('SIGTERM');
  }, 15_000);
});
