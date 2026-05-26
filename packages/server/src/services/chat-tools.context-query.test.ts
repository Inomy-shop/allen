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
});
