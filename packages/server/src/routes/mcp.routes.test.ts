/**
 * Unit tests for discoverMcpEntries.
 * Uses real tmp directories with actual files — no mocking needed
 * since the function is purely synchronous filesystem I/O.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { discoverMcpEntries, mcpRoutes } from './mcp.routes.js';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { existsSync } from 'node:fs';
import { join } from 'path';
import { tmpdir } from 'os';
import express from 'express';
import request from 'supertest';
import { McpService } from '../services/mcp.service.js';
import { ensureInstalled } from '@allen/engine';

// ── Module-level mocks (hoisted before imports by vitest) ────────────────────

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, existsSync: vi.fn().mockReturnValue(true) };
});

vi.mock('../services/mcp.service.js', () => ({
  McpService: vi.fn(),
  MCP_PRESETS: [],
}));

vi.mock('../services/mcp-bundle.service.js', () => ({
  McpBundleService: vi.fn().mockImplementation(() => ({
    getMeta: vi.fn().mockReturnValue(null),
    extractZip: vi.fn(),
    setEntry: vi.fn(),
    delete: vi.fn(),
  })),
}));

vi.mock('@allen/engine', () => ({
  forgetInstall: vi.fn(),
  ensureInstalled: vi.fn(),
  buildSingleServerConfig: vi.fn().mockResolvedValue(null),
}));

describe('discoverMcpEntries', () => {
  let tmpDir = '';

  afterEach(() => {
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = '';
    }
  });

  // ── AC-001 / AC-002: Python by convention (.claude/mcp path) ────────────────

  it('AC-001/AC-002: includes .py file under .claude/mcp by convention (no fingerprint needed)', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mcp-test-'));
    mkdirSync(join(tmpDir, '.claude', 'mcp', 'langsmith'), { recursive: true });
    writeFileSync(join(tmpDir, '.claude', 'mcp', 'langsmith', 'server.py'), 'print("no fingerprints")');

    const candidates = discoverMcpEntries(tmpDir);
    const py = candidates.find((c) => c.repoRelative.endsWith('server.py'));
    expect(py).toBeDefined();
    expect(py?.detectedLanguage).toBe('python');
  });

  // ── AC-003: Python by content fingerprint (outside .claude/mcp) ─────────────

  it('AC-003: includes .py file outside .claude/mcp when fingerprint present', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mcp-test-'));
    writeFileSync(join(tmpDir, 'server.py'), 'from mcp.server import FastMCP\nmcp = FastMCP()');

    const candidates = discoverMcpEntries(tmpDir);
    const py = candidates.find((c) => c.repoRelative.endsWith('server.py'));
    expect(py).toBeDefined();
    expect(py?.detectedLanguage).toBe('python');
  });

  // ── AC-004: no fingerprint, no convention → excluded ────────────────────────

  it('AC-004: does NOT include .py file outside .claude/mcp without fingerprint', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mcp-test-'));
    writeFileSync(join(tmpDir, 'server.py'), 'print("hello world")');

    const candidates = discoverMcpEntries(tmpDir);
    const py = candidates.find((c) => c.repoRelative.endsWith('server.py'));
    expect(py).toBeUndefined();
  });

  // ── AC-005: TS MCP files get detectedLanguage=node ──────────────────────────

  it('AC-005: .ts MCP candidate gets detectedLanguage=node', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mcp-test-'));
    mkdirSync(join(tmpDir, '.claude', 'mcp', 'mytool'), { recursive: true });
    writeFileSync(
      join(tmpDir, '.claude', 'mcp', 'mytool', 'server.mcp.ts'),
      "import { Server } from '@modelcontextprotocol/sdk/server/index.js';",
    );

    const candidates = discoverMcpEntries(tmpDir);
    const ts = candidates.find((c) => c.repoRelative.endsWith('.ts'));
    expect(ts).toBeDefined();
    expect(ts?.detectedLanguage).toBe('node');
  });

  // ── AC-022: existing .ts MCP files still picked up (regression guard) ───────

  it('AC-022: still picks up existing .ts MCP files (regression)', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mcp-test-'));
    mkdirSync(join(tmpDir, '.claude', 'mcp', 'tool'), { recursive: true });
    writeFileSync(
      join(tmpDir, '.claude', 'mcp', 'tool', 'index.ts'),
      "import '@modelcontextprotocol/sdk';",
    );

    const candidates = discoverMcpEntries(tmpDir);
    expect(candidates.length).toBeGreaterThan(0);
  });

  // ── node_modules skip ────────────────────────────────────────────────────────

  it('skips node_modules directory', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mcp-test-'));
    mkdirSync(join(tmpDir, 'node_modules', '.claude', 'mcp', 'x'), { recursive: true });
    writeFileSync(
      join(tmpDir, 'node_modules', '.claude', 'mcp', 'x', 'server.py'),
      'from mcp.server import FastMCP',
    );

    const candidates = discoverMcpEntries(tmpDir);
    const py = candidates.find((c) => c.repoRelative.includes('node_modules'));
    expect(py).toBeUndefined();
  });

  // ── .venv skip ───────────────────────────────────────────────────────────────

  it('skips .venv directory', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mcp-test-'));
    mkdirSync(join(tmpDir, '.venv', 'lib', 'python3.12', 'site-packages', 'mcp'), { recursive: true });
    writeFileSync(
      join(tmpDir, '.venv', 'lib', 'python3.12', 'site-packages', 'mcp', 'server.py'),
      'from mcp.server import FastMCP',
    );

    const candidates = discoverMcpEntries(tmpDir);
    const py = candidates.find((c) => c.repoRelative.includes('.venv'));
    expect(py).toBeUndefined();
  });

  // ── __pycache__ skip ──────────────────────────────────────────────────────────

  it('skips __pycache__ directory', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mcp-test-'));
    mkdirSync(join(tmpDir, '__pycache__'), { recursive: true });
    // .pyc files won't pass the extension filter, but ensure the dir itself is skipped
    mkdirSync(join(tmpDir, '__pycache__', '.claude', 'mcp', 'x'), { recursive: true });
    writeFileSync(
      join(tmpDir, '__pycache__', '.claude', 'mcp', 'x', 'server.py'),
      'from mcp.server import FastMCP',
    );

    const candidates = discoverMcpEntries(tmpDir);
    const py = candidates.find((c) => c.repoRelative.includes('__pycache__'));
    expect(py).toBeUndefined();
  });

  // ── Multiple Python MCPs in same repo ────────────────────────────────────────

  it('discovers multiple Python MCPs in same repo', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mcp-test-'));
    mkdirSync(join(tmpDir, '.claude', 'mcp', 'langsmith'), { recursive: true });
    mkdirSync(join(tmpDir, '.claude', 'mcp', 'flow-tester'), { recursive: true });
    writeFileSync(join(tmpDir, '.claude', 'mcp', 'langsmith', 'server.py'), 'print("langsmith")');
    writeFileSync(join(tmpDir, '.claude', 'mcp', 'flow-tester', 'server.py'), 'print("flow-tester")');

    const candidates = discoverMcpEntries(tmpDir);
    const pyFiles = candidates.filter((c) => c.detectedLanguage === 'python');
    expect(pyFiles.length).toBeGreaterThanOrEqual(2);
  });

  // ── .py at root of .claude/mcp/ (no subdir) ─────────────────────────────────

  it('includes .py at root of .claude/mcp/ (no subdir)', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mcp-test-'));
    mkdirSync(join(tmpDir, '.claude', 'mcp'), { recursive: true });
    writeFileSync(join(tmpDir, '.claude', 'mcp', 'server.py'), 'print("root level")');

    const candidates = discoverMcpEntries(tmpDir);
    const py = candidates.find((c) => c.repoRelative.endsWith('server.py'));
    expect(py).toBeDefined();
    expect(py?.detectedLanguage).toBe('python');
  });

  // ── All Python MCP fingerprints ──────────────────────────────────────────────

  it('detects all Python MCP fingerprints', () => {
    const fingerprints = [
      'mcp.server.fastmcp',
      'FastMCP',
      'from mcp.server',
      'mcp.run(',
      '@mcp.tool',
    ];

    for (const fp of fingerprints) {
      const dir = mkdtempSync(join(tmpdir(), 'mcp-fp-test-'));
      try {
        writeFileSync(join(dir, 'server.py'), fp);
        const candidates = discoverMcpEntries(dir);
        const py = candidates.find((c) => c.repoRelative.endsWith('server.py'));
        expect(py, `fingerprint "${fp}" should match`).toBeDefined();
        expect(py?.detectedLanguage, `fingerprint "${fp}" should be python`).toBe('python');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  // ── Mixed repo: both Python and Node MCPs ────────────────────────────────────

  it('handles a repo with both Python and Node MCPs', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mcp-test-'));
    mkdirSync(join(tmpDir, '.claude', 'mcp', 'py-tool'), { recursive: true });
    mkdirSync(join(tmpDir, '.claude', 'mcp', 'node-tool'), { recursive: true });
    writeFileSync(join(tmpDir, '.claude', 'mcp', 'py-tool', 'server.py'), 'print("py")');
    writeFileSync(
      join(tmpDir, '.claude', 'mcp', 'node-tool', 'index.ts'),
      "import { Server } from '@modelcontextprotocol/sdk';",
    );

    const candidates = discoverMcpEntries(tmpDir);
    const pyFiles = candidates.filter((c) => c.detectedLanguage === 'python');
    const nodeFiles = candidates.filter((c) => c.detectedLanguage === 'node');
    expect(pyFiles.length).toBeGreaterThanOrEqual(1);
    expect(nodeFiles.length).toBeGreaterThanOrEqual(1);
  });

  // ── maxDepth parameter is respected ─────────────────────────────────────────

  it('respects maxDepth parameter', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mcp-test-'));
    // Create a file at depth 6 (deeper than default maxDepth=4)
    mkdirSync(join(tmpDir, 'a', 'b', 'c', 'd', 'e', 'f'), { recursive: true });
    writeFileSync(join(tmpDir, 'a', 'b', 'c', 'd', 'e', 'f', 'server.py'), 'FastMCP');

    const candidates = discoverMcpEntries(tmpDir, 4);
    const deep = candidates.find((c) => c.repoRelative.includes('f'));
    expect(deep).toBeUndefined();
  });

  // ── Result includes both absolute and relative paths ─────────────────────────

  it('returns entries with both absolute entry path and relative repoRelative', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mcp-test-'));
    mkdirSync(join(tmpDir, '.claude', 'mcp', 'tool'), { recursive: true });
    writeFileSync(join(tmpDir, '.claude', 'mcp', 'tool', 'server.py'), 'print("test")');

    const candidates = discoverMcpEntries(tmpDir);
    const py = candidates.find((c) => c.repoRelative.endsWith('server.py'));
    expect(py).toBeDefined();
    expect(py!.entry).toContain(tmpDir);
    expect(py!.repoRelative).not.toContain(tmpDir);
  });
});

// ── POST /api/mcp/servers/:id/reinstall ──────────────────────────────────────

describe('POST /api/mcp/servers/:id/reinstall', () => {
  // A valid 24-hex-char ObjectId string that satisfies ownerIdOf() without throwing
  const FAKE_OWNER_OID = '000000000000000000000001';
  const FAKE_REPO_OID = '000000000000000000000002';

  /** Build a minimal Express app that mounts mcpRoutes with given stubs. */
  function buildApp(mockServer: unknown, mockRepo: unknown) {
    const mockGetById = vi.fn().mockResolvedValue(mockServer);
    const mockFindOne = vi.fn().mockResolvedValue(mockRepo);

    // Wire the McpService mock so new McpService(db) returns our stub
    vi.mocked(McpService).mockImplementation(() => ({
      getById: mockGetById,
      list: vi.fn().mockResolvedValue([]),
      updateStatus: vi.fn(),
    } as unknown as McpService));

    const mockDb = {
      collection: vi.fn().mockReturnValue({
        findOne: mockFindOne,
        find: vi.fn().mockReturnValue({
          sort: vi.fn().mockReturnValue({ toArray: vi.fn().mockResolvedValue([]) }),
        }),
        insertOne: vi.fn(),
        findOneAndUpdate: vi.fn(),
        updateOne: vi.fn(),
        deleteOne: vi.fn(),
      }),
    };

    const app = express();
    app.use(express.json());
    // Inject fake auth — routes rely on req.user.sub/role; skip real JWT middleware
    app.use((req: express.Request & { user?: unknown }, _res, next) => {
      req.user = {
        sub: FAKE_OWNER_OID,
        email: 'test@example.com',
        role: 'admin',
        mustResetPassword: false,
      };
      next();
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    app.use('/api/mcp', mcpRoutes(mockDb as any));
    return app;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    // Restore existsSync default (clearAllMocks resets call history but not impl)
    vi.mocked(existsSync).mockReturnValue(true);
  });

  it('returns 200 skip payload for Python entry with no package.json', async () => {
    // existsSync(join(installDir, 'package.json')) → false
    vi.mocked(existsSync).mockReturnValue(false);

    const server = {
      ownerId: null,
      source: {
        kind: 'repo',
        repoId: FAKE_REPO_OID,
        entryPath: 'server.py',
      },
    };
    const repo = { path: '/tmp/pyrepo' };

    const app = buildApp(server, repo);
    const res = await request(app).post('/api/mcp/servers/py-srv-1/reinstall');

    expect(res.status).toBe(200);
    expect(res.body.skipped).toBe(true);
    expect(res.body.reason).toBe('python-no-auto-install');
    expect(res.body.message).toContain('Python MCP deps are user-managed');
  });

  it('returns 500 for Node entry with no package.json (ensureInstalled throws)', async () => {
    // existsSync → false (no package.json), entryPath is .ts → not Python
    vi.mocked(existsSync).mockReturnValue(false);
    vi.mocked(ensureInstalled).mockRejectedValue(
      new Error('MCP installDir has no package.json'),
    );

    const server = {
      ownerId: null,
      source: {
        kind: 'repo',
        repoId: FAKE_REPO_OID,
        entryPath: 'index.ts',
      },
    };
    const repo = { path: '/tmp/noderepo' };

    const app = buildApp(server, repo);
    const res = await request(app).post('/api/mcp/servers/node-srv-1/reinstall');

    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('returns 400 for non-repo server', async () => {
    const server = {
      ownerId: null,
      source: { kind: 'manual' },
    };

    const app = buildApp(server, null);
    const res = await request(app).post('/api/mcp/servers/manual-srv/reinstall');

    expect(res.status).toBe(400);
  });
});
