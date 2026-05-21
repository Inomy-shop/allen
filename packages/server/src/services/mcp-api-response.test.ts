import { describe, expect, it } from 'vitest';
import { parseAllenApiResponse } from './mcp-api-response.js';

describe('parseAllenApiResponse', () => {
  it('preserves structured JSON error responses from Allen API', async () => {
    const res = new Response(JSON.stringify({
      ok: false,
      code: 'KNOWLEDGE_GRAPH_VALIDATION_FAILED',
      message: 'Repo knowledge graph validation failed.',
      issues: [{ code: 'node_path_missing', path: 'AGENTS.md' }],
    }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });

    await expect(parseAllenApiResponse(res)).resolves.toEqual({
      ok: false,
      httpStatus: 400,
      code: 'KNOWLEDGE_GRAPH_VALIDATION_FAILED',
      message: 'Repo knowledge graph validation failed.',
      issues: [{ code: 'node_path_missing', path: 'AGENTS.md' }],
    });
  });

  it('falls back to an API status string for non-JSON error responses', async () => {
    const res = new Response('bad gateway', { status: 502 });

    await expect(parseAllenApiResponse(res)).resolves.toEqual({
      ok: false,
      error: 'API 502: bad gateway',
    });
  });
});
