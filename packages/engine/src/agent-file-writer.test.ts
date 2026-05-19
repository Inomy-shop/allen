import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { renderAgentFile, REPO_CONTEXT_LOADING_GUIDANCE, writeAgentFile } from './agent-file-writer.js';

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

  it('returns a hash for the exact rendered Claude agent file body', () => {
    const agent = {
      name: 'hash-audit-test',
      system: '<allen_mandatory_repo_context><full_body_context>rules</full_body_context></allen_mandatory_repo_context>',
      materializedNameSuffix: `test-${Date.now()}`,
    };
    const expectedBody = renderAgentFile(agent).body;
    const expectedHash = createHash('sha256').update(Buffer.from(expectedBody, 'utf8')).digest('hex');
    const materialized = writeAgentFile(agent);

    try {
      const actualBody = readFileSync(materialized.path, 'utf8');
      expect(actualBody).toBe(expectedBody);
      expect(materialized.sha256).toBe(expectedHash);
      expect(materialized.byteLength).toBe(Buffer.byteLength(expectedBody, 'utf8'));
      expect(materialized.containsMandatoryRepoContext).toBe(true);
      expect(materialized.createdAt).toBeInstanceOf(Date);
    } finally {
      materialized.cleanup();
    }

    expect(existsSync(materialized.path)).toBe(false);
  });
});
