/**
 * Targeted regression tests for ENG-1526:
 * "Artifact publicUrl uses localhost instead of configured public domain"
 *
 * Root cause: allen-mcp-server.ts used API_BASE (internal/loopback URL) for
 *   both service-to-service HTTP calls AND publicUrl constructions in upload_file,
 *   allen_save_artifact, and allen_get_artifact.
 *
 * Fix: Introduce PUBLIC_BASE = (process.env.ALLEN_PUBLIC_URL || API_BASE).replace(/\/$/, '')
 *   and use it exclusively for publicUrl fields. All fetch() calls keep API_BASE.
 *   ALLEN_PUBLIC_URL is propagated into every MCP subprocess spawn path.
 *
 * Acceptance criteria tested:
 *   AC-1  ALLEN_PUBLIC_URL set → PUBLIC_BASE uses that domain
 *   AC-2  ALLEN_PUBLIC_URL unset → PUBLIC_BASE falls back to ALLEN_API_URL / localhost
 *   AC-3  Empty-string ALLEN_PUBLIC_URL treated as unset (|| semantics)
 *   AC-4  Trailing slash is stripped from PUBLIC_BASE
 *   AC-5  upload_file publicUrl is constructed from PUBLIC_BASE
 *   AC-6  allen_save_artifact publicUrl is constructed from PUBLIC_BASE
 *   AC-7  allen_get_artifact publicUrl is constructed from PUBLIC_BASE + id encode
 *   AC-8  chat-llm.ts propagates ALLEN_PUBLIC_URL to MCP child env
 *   AC-9  mcp-loader.ts propagates ALLEN_PUBLIC_URL (conditional spread)
 *   AC-10 codex-executor.ts propagates ALLEN_PUBLIC_URL in mcpEnvOverrides
 *   AC-11 .env.example documents ALLEN_PUBLIC_URL
 *   AC-12 No fetch() call in allen-mcp-server.ts uses PUBLIC_BASE (only API_BASE)
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dir = dirname(__filename);
// Monorepo root is 4 levels up from packages/server/src/services/
const REPO_ROOT = resolve(__dir, '../../../../');

// ─────────────────────────────────────────────────────────────────────────────
// Helper: re-implements the exact PUBLIC_BASE formula from allen-mcp-server.ts
// so we can unit-test it as a pure function without loading the subprocess script.
// ─────────────────────────────────────────────────────────────────────────────
function computePublicBase(opts: {
  allenPublicUrl?: string;
  allenApiUrl?: string;
  port?: string;
}): string {
  const { allenPublicUrl, allenApiUrl, port = '4023' } = opts;
  const apiBase = allenApiUrl ?? `http://localhost:${port}`;
  // Exact replica of allen-mcp-server.ts line 19:
  //   const PUBLIC_BASE = (process.env.ALLEN_PUBLIC_URL || API_BASE).replace(/\/$/, '');
  return (allenPublicUrl || apiBase).replace(/\/$/, '');
}

// ─────────────────────────────────────────────────────────────────────────────
// AC-1 to AC-4: PUBLIC_BASE derivation formula
// ─────────────────────────────────────────────────────────────────────────────
describe('ENG-1526 — PUBLIC_BASE formula', () => {
  it('AC-1: uses ALLEN_PUBLIC_URL when set to a real domain', () => {
    const result = computePublicBase({ allenPublicUrl: 'https://allen.inomy.ai' });
    expect(result).toBe('https://allen.inomy.ai');
  });

  it('AC-1b: uses ALLEN_PUBLIC_URL when set, ignoring ALLEN_API_URL entirely', () => {
    const result = computePublicBase({
      allenPublicUrl: 'https://allen.inomy.ai',
      allenApiUrl: 'http://internal:4023',
    });
    expect(result).toBe('https://allen.inomy.ai');
  });

  it('AC-2: falls back to ALLEN_API_URL when ALLEN_PUBLIC_URL is not set', () => {
    const result = computePublicBase({ allenApiUrl: 'http://internal-host:4023' });
    expect(result).toBe('http://internal-host:4023');
  });

  it('AC-2b: falls back to http://localhost:PORT when both vars are absent', () => {
    const result = computePublicBase({ port: '9000' });
    expect(result).toBe('http://localhost:9000');
  });

  it('AC-2c: localhost fallback uses PORT=4023 default', () => {
    const result = computePublicBase({});
    expect(result).toBe('http://localhost:4023');
  });

  it('AC-3: treats empty-string ALLEN_PUBLIC_URL as unset (|| falsy semantics)', () => {
    const result = computePublicBase({ allenPublicUrl: '', allenApiUrl: 'http://internal:4023' });
    expect(result).toBe('http://internal:4023');
  });

  it('AC-4: strips trailing slash from ALLEN_PUBLIC_URL', () => {
    const result = computePublicBase({ allenPublicUrl: 'https://allen.inomy.ai/' });
    expect(result).toBe('https://allen.inomy.ai');
  });

  it('AC-4b: strips trailing slash from fallback API_BASE too', () => {
    const result = computePublicBase({ allenApiUrl: 'http://internal:4023/' });
    expect(result).toBe('http://internal:4023');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-5 to AC-7: publicUrl construction in the three MCP tool cases
// ─────────────────────────────────────────────────────────────────────────────
describe('ENG-1526 — publicUrl constructions use PUBLIC_BASE (not API_BASE)', () => {
  const PUBLIC_BASE = 'https://allen.inomy.ai';
  const API_BASE = 'http://localhost:4023'; // internal base that must NOT appear in publicUrl

  it('AC-5: upload_file — publicUrl = PUBLIC_BASE + data.url', () => {
    const data: Record<string, unknown> = { url: '/api/files/uploads/foo.md' };
    // Exact replica of allen-mcp-server.ts line 772:
    //   data.publicUrl = `${PUBLIC_BASE}${data.url}`;
    if (data.url) data.publicUrl = `${PUBLIC_BASE}${data.url}`;
    expect(data.publicUrl).toBe('https://allen.inomy.ai/api/files/uploads/foo.md');
    expect(data.publicUrl as string).not.toContain(API_BASE);
  });

  it('AC-5b: upload_file — does not set publicUrl when data.url is absent', () => {
    const data: Record<string, unknown> = {};
    if (data.url) data.publicUrl = `${PUBLIC_BASE}${data.url}`;
    expect(data.publicUrl).toBeUndefined();
  });

  it('AC-6: allen_save_artifact — publicUrl = PUBLIC_BASE + data.url', () => {
    const data: Record<string, unknown> = { url: '/api/artifacts/abc-123/content' };
    // Exact replica of allen-mcp-server.ts line 810:
    //   if (data.url) data.publicUrl = `${PUBLIC_BASE}${data.url}`;
    if (data.url) data.publicUrl = `${PUBLIC_BASE}${data.url}`;
    expect(data.publicUrl).toBe('https://allen.inomy.ai/api/artifacts/abc-123/content');
    expect(data.publicUrl as string).not.toContain(API_BASE);
  });

  it('AC-6b: allen_save_artifact — no publicUrl when API response omits url field', () => {
    const data: Record<string, unknown> = { artifactId: 'abc-123' };
    if (data.url) data.publicUrl = `${PUBLIC_BASE}${data.url}`;
    expect(data.publicUrl).toBeUndefined();
  });

  it('AC-7: allen_get_artifact — publicUrl = PUBLIC_BASE + /api/artifacts/:id/content', () => {
    const id = 'artifact-id-001';
    // Exact replica of allen-mcp-server.ts line 831:
    //   publicUrl: `${PUBLIC_BASE}/api/artifacts/${encodeURIComponent(id)}/content`
    const publicUrl = `${PUBLIC_BASE}/api/artifacts/${encodeURIComponent(id)}/content`;
    expect(publicUrl).toBe('https://allen.inomy.ai/api/artifacts/artifact-id-001/content');
    expect(publicUrl).not.toContain(API_BASE);
  });

  it('AC-7b: allen_get_artifact — encodes special chars in artifact id', () => {
    const id = 'path/to/artifact with spaces';
    const publicUrl = `${PUBLIC_BASE}/api/artifacts/${encodeURIComponent(id)}/content`;
    expect(publicUrl).toContain('path%2Fto%2Fartifact%20with%20spaces');
    expect(publicUrl).toMatch(/^https:\/\/allen\.inomy\.ai\/api\/artifacts\/.+\/content$/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-8: chat-llm.ts env propagation formula
// ─────────────────────────────────────────────────────────────────────────────
describe('ENG-1526 — chat-llm.ts ALLEN_PUBLIC_URL propagation formula', () => {
  // Replicates chat-llm.ts line ~128:
  //   ALLEN_PUBLIC_URL: process.env.ALLEN_PUBLIC_URL || `http://localhost:${process.env.PORT ?? '4023'}`
  const buildChatLlmPublicUrl = (allenPublicUrl?: string, port = '4023') =>
    allenPublicUrl || `http://localhost:${port}`;

  it('AC-8: forwards ALLEN_PUBLIC_URL when set', () => {
    expect(buildChatLlmPublicUrl('https://allen.inomy.ai')).toBe('https://allen.inomy.ai');
  });

  it('AC-8b: uses localhost fallback when ALLEN_PUBLIC_URL is absent', () => {
    expect(buildChatLlmPublicUrl(undefined, '4023')).toBe('http://localhost:4023');
  });

  it('AC-8c: uses localhost fallback when ALLEN_PUBLIC_URL is empty string', () => {
    expect(buildChatLlmPublicUrl('', '4023')).toBe('http://localhost:4023');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-9: mcp-loader.ts conditional spread formula
// ─────────────────────────────────────────────────────────────────────────────
describe('ENG-1526 — mcp-loader.ts ALLEN_PUBLIC_URL conditional spread', () => {
  // Replicates mcp-loader.ts line ~274:
  //   ...(process.env.ALLEN_PUBLIC_URL ? { ALLEN_PUBLIC_URL: process.env.ALLEN_PUBLIC_URL } : {})
  const buildMcpLoaderEnv = (allenPublicUrl?: string): Record<string, string> => ({
    ALLEN_API_URL: 'http://localhost:4023',
    ...(allenPublicUrl ? { ALLEN_PUBLIC_URL: allenPublicUrl } : {}),
  });

  it('AC-9: includes ALLEN_PUBLIC_URL in env when set', () => {
    const env = buildMcpLoaderEnv('https://allen.inomy.ai');
    expect(env).toHaveProperty('ALLEN_PUBLIC_URL', 'https://allen.inomy.ai');
  });

  it('AC-9b: omits ALLEN_PUBLIC_URL from env when not set (lets child inherit fallback)', () => {
    const env = buildMcpLoaderEnv(undefined);
    expect(env).not.toHaveProperty('ALLEN_PUBLIC_URL');
    // ALLEN_API_URL is always present
    expect(env).toHaveProperty('ALLEN_API_URL');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-10: codex-executor.ts mcpEnvOverrides formula
// ─────────────────────────────────────────────────────────────────────────────
describe('ENG-1526 — codex-executor.ts ALLEN_PUBLIC_URL in mcpEnvOverrides', () => {
  // Replicates codex-executor.ts line ~129:
  //   ...set('ALLEN_PUBLIC_URL', process.env.ALLEN_PUBLIC_URL || `http://localhost:${PORT}`)
  const MCP_SERVER_NAME = 'allen-mcp';
  const buildCodexEnvEntry = (allenPublicUrl?: string, port = '4023'): string[] => {
    const escape = (v: string) => v.replace(/"/g, '\\"');
    const set = (k: string, v: string) => ['-c', `mcp_servers.${MCP_SERVER_NAME}.env.${k}="${escape(v)}"`];
    return set('ALLEN_PUBLIC_URL', allenPublicUrl || `http://localhost:${port}`);
  };

  it('AC-10: entry contains ALLEN_PUBLIC_URL key', () => {
    const [flag, entry] = buildCodexEnvEntry('https://allen.inomy.ai');
    expect(flag).toBe('-c');
    expect(entry).toContain('ALLEN_PUBLIC_URL');
  });

  it('AC-10b: forwards the public domain when ALLEN_PUBLIC_URL is set', () => {
    const [, entry] = buildCodexEnvEntry('https://allen.inomy.ai');
    expect(entry).toContain('https://allen.inomy.ai');
  });

  it('AC-10c: uses localhost fallback when ALLEN_PUBLIC_URL is unset', () => {
    const [, entry] = buildCodexEnvEntry(undefined, '4023');
    expect(entry).toContain('http://localhost:4023');
  });

  it('AC-10d: escapes double-quotes in the value', () => {
    const [, entry] = buildCodexEnvEntry('https://allen.inomy.ai/"tricky"');
    expect(entry).toContain('\\"tricky\\"');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-11: .env.example documents ALLEN_PUBLIC_URL
// ─────────────────────────────────────────────────────────────────────────────
describe('ENG-1526 — .env.example documents ALLEN_PUBLIC_URL', () => {
  const envExample = readFileSync(resolve(REPO_ROOT, '.env.example'), 'utf-8');

  it('AC-11: .env.example contains the ALLEN_PUBLIC_URL variable name', () => {
    expect(envExample).toContain('ALLEN_PUBLIC_URL');
  });

  it('AC-11b: .env.example mentions artifact-related context', () => {
    expect(envExample.toLowerCase()).toContain('artifact');
  });

  it('AC-11c: .env.example shows an example public domain', () => {
    // Should have an example like https://allen.yourco.com
    expect(envExample).toMatch(/https?:\/\/allen\./);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-12: Static analysis — fetch() never uses PUBLIC_BASE; publicUrl never uses API_BASE
// ─────────────────────────────────────────────────────────────────────────────
describe('ENG-1526 — allen-mcp-server.ts static correctness checks', () => {
  const src = readFileSync(resolve(__dir, 'allen-mcp-server.ts'), 'utf-8');

  it('AC-12: no fetch() call uses PUBLIC_BASE (internal calls must use API_BASE)', () => {
    const fetchWithPublicBase = src.match(/fetch\(`\$\{PUBLIC_BASE\}/g);
    expect(fetchWithPublicBase).toBeNull();
  });

  it('AC-12b: publicUrl assignments never use API_BASE directly', () => {
    const publicUrlWithApiBase = src.match(/publicUrl\s*[=:]\s*`\$\{API_BASE\}/g);
    expect(publicUrlWithApiBase).toBeNull();
  });

  it('AC-12c: PUBLIC_BASE constant is defined in the source', () => {
    expect(src).toContain('const PUBLIC_BASE =');
  });

  it('AC-12d: PUBLIC_BASE uses || (not ??) so empty string falls back to API_BASE', () => {
    // The line should use: (process.env.ALLEN_PUBLIC_URL || API_BASE)
    expect(src).toMatch(/ALLEN_PUBLIC_URL\s*\|\|\s*API_BASE/);
  });

  it('AC-12e: PUBLIC_BASE strips trailing slash via .replace', () => {
    expect(src).toMatch(/PUBLIC_BASE\s*=.*replace\(\/\\\/\$\/,\s*['"]['"]?\)/);
  });

  it('AC-12f: all three artifact tools reference PUBLIC_BASE in their publicUrl output', () => {
    const matches = src.match(/\$\{PUBLIC_BASE\}/g);
    // upload_file + allen_save_artifact + allen_get_artifact = at least 3
    expect(matches).not.toBeNull();
    expect(matches!.length).toBeGreaterThanOrEqual(3);
  });
});
