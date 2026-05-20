import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderAgentFile, REPO_CONTEXT_LOADING_GUIDANCE, writeAgentFile } from '../src/agent-file-writer.js';

describe('agent file materialization audit metadata', () => {
  it('does not include repo context loading guidance by default', () => {
    const { body } = renderAgentFile({
      name: 'no-repo-context',
      system: 'Follow the normal agent instructions.',
    });

    expect(body).not.toContain('<repo_context_loading_protocol');
    expect(body).not.toContain('<repo_context_usage_schema>');
  });

  it('includes repo context loading guidance when explicitly enabled', () => {
    const { body } = renderAgentFile({
      name: 'with-repo-context',
      system: 'Follow the normal agent instructions.',
      includeRepoContextLoadingGuidance: true,
    });

    expect(body).toContain('<repo_context_loading_protocol');
    expect(body).toContain('<repo_context_usage_schema>');
  });

  it('does not duplicate authored repo context loading guidance', () => {
    const { body } = renderAgentFile({
      name: 'authored-repo-context',
      system: `${REPO_CONTEXT_LOADING_GUIDANCE}\n\nFollow the normal agent instructions.`,
      includeRepoContextLoadingGuidance: true,
    });

    expect(body.match(/<repo_context_loading_protocol/g)).toHaveLength(1);
    expect(body.match(/<repo_context_usage_schema/g)).toHaveLength(1);
  });

  it('always allowlists Allen graph persistence for repo knowledge graph indexer agents', () => {
    const { body } = renderAgentFile({
      name: 'repo-knowledge-graph-indexer',
      system: 'Build and persist the repo knowledge graph.',
      tools: [],
    });

    expect(body).toContain('tools: ');
    expect(body).toContain('mcp__allen__save_repo_knowledge_graph');
  });

  it('returns a hash for the exact rendered Claude agent file body', () => {
    const agent = {
      name: 'hash-audit-test',
      system: '<allen_mandatory_repo_context><full_body_context>rules</full_body_context></allen_mandatory_repo_context>',
      materializedNameSuffix: `test-${Date.now()}`,
    };
    const expectedBody = renderAgentFile(agent).body;
    const expectedHash = createHash('sha256').update(Buffer.from(expectedBody, 'utf8')).digest('hex');
    const originalHome = process.env.HOME;
    process.env.HOME = mkdtempSync(join(tmpdir(), 'allen-agent-file-writer-'));
    let materialized: ReturnType<typeof writeAgentFile> | undefined;

    try {
      materialized = writeAgentFile(agent);
      const actualBody = readFileSync(materialized.path, 'utf8');
      expect(actualBody).toBe(expectedBody);
      expect(materialized.sha256).toBe(expectedHash);
      expect(materialized.byteLength).toBe(Buffer.byteLength(expectedBody, 'utf8'));
      expect(materialized.containsMandatoryRepoContext).toBe(true);
      expect(materialized.createdAt).toBeInstanceOf(Date);
    } finally {
      materialized?.cleanup();
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
    }

    expect(materialized).toBeDefined();
    expect(existsSync(materialized!.path)).toBe(false);
  });
});
