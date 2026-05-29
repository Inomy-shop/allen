import { describe, expect, it } from 'vitest';
import { __internalsForTest } from './chat-tools.js';

describe('spawn agent context query prompt sanitization', () => {
  it('strips unsupported inline context query blocks from agent prompts', () => {
    const result = __internalsForTest.stripUnsupportedInlineContextQuery([
      '<allen_context_query>{"user_request":"hidden"}</allen_context_query>',
      '',
      'Run the read-only analysis.',
    ].join('\n'));

    expect(result.stripped).toBe(true);
    expect(result.prompt).toBe('Run the read-only analysis.');
  });

  it('leaves ordinary prompts unchanged', () => {
    const result = __internalsForTest.stripUnsupportedInlineContextQuery('Run the read-only analysis.');

    expect(result.stripped).toBe(false);
    expect(result.prompt).toBe('Run the read-only analysis.');
  });

  it('derives retrieval-only context query from noisy chat-spawned prompts', () => {
    const prompt = [
      'You are running a READ-ONLY backend-developer analysis for repo `/Users/ashish-inomy/.allen/repositories/es-data-pipeline`.',
      '',
      'Task: independently analyze the product grouping module and report what you understand about:',
      '1. What product grouping is and what business/technical identity it provides.',
      '2. What data it generates/updates, including key fields/tables and any semantic post-processing fields.',
      '3. Upstream ingestion flow into product grouping.',
      '4. Downstream ingestion/consumption flow after product grouping.',
      '5. The most important caveats/risks/operational gotchas of this module.',
      '',
      'Strict constraints:',
      '- READ ONLY. Do not edit files, create commits, push, open PRs, run migrations, or write to any DB/service.',
      '- Save your final report as a markdown artifact using `allen_save_artifact`.',
      '- Final response should include a short summary and the artifact link if available.',
    ].join('\n');

    const resolved = __internalsForTest.resolveSpawnContextQuery(undefined, prompt, '/Users/ashish-inomy/.allen/repositories/es-data-pipeline');

    expect(resolved.source).toBe('derived_prompt');
    expect(resolved.contextQuery?.user_request).toContain('product grouping module');
    expect(resolved.contextQuery?.user_request).toContain('Upstream ingestion');
    expect(resolved.contextQuery?.user_request).not.toContain('READ-ONLY');
    expect(resolved.contextQuery?.user_request).not.toContain('Strict constraints');
    expect(resolved.contextQuery?.user_request).not.toContain('allen_save_artifact');
    expect(resolved.contextQuery?.topics).toContain('product grouping');
    expect(resolved.contextQuery?.topics).toContain('upstream ingestion');
    expect(resolved.contextQuery?.topics).toContain('downstream consumption');
  });

  it('keeps explicit context_query ahead of derived prompt fallback', () => {
    const explicit = { user_request: 'Use this retrieval intent' };
    const resolved = __internalsForTest.resolveSpawnContextQuery(
      explicit,
      'Task: analyze product grouping\n\nStrict constraints:\n- READ ONLY',
      '/repo',
    );

    expect(resolved.source).toBe('tool_arg');
    expect(resolved.contextQuery).toBe(explicit);
  });

  it('falls back to prompt when no repo path is available', () => {
    const resolved = __internalsForTest.resolveSpawnContextQuery(undefined, 'Task: analyze product grouping', undefined);

    expect(resolved.source).toBe('prompt_fallback');
    expect(resolved.contextQuery).toBeUndefined();
  });
});
