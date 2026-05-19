import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { renderAgentFile, writeAgentFile } from './agent-file-writer.js';

describe('agent file materialization audit metadata', () => {
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
