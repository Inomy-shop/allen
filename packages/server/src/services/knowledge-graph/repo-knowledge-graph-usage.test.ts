import { describe, expect, it } from 'vitest';
import { addSystemInjectedContextUsage, extractUsage } from './repo-knowledge-graph-usage.js';

describe('repo knowledge graph usage parsing', () => {
  it('treats applied system-injected context as verified usage', () => {
    const usage = extractUsage({
      repo_context_usage: {
        context_applied: [{ refId: 'ref-guideline', summary: 'Followed frontend guidance' }],
      },
    });

    addSystemInjectedContextUsage(usage, {
      contextInjection: {
        injectedRefs: [{
          refId: 'ref-guideline',
          path: '.claude/rules/coding-guidelines-frontend.md',
          kind: 'instruction_file',
        }],
      },
    });

    expect(usage.loaded).toEqual(expect.arrayContaining([
      expect.objectContaining({ refId: 'ref-guideline', source: 'allen_system_injection' }),
    ]));
    expect(usage.applied).toEqual(expect.arrayContaining([
      expect.objectContaining({ refId: 'ref-guideline' }),
    ]));
  });
});
