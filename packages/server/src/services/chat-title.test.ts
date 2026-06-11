import { describe, expect, it } from 'vitest';
import { normalizeGeneratedChatTitle, sanitizeChatAssistantResponse, sanitizeChatTitle, deterministicSessionTaskTitle, fallbackTitleFromUserMessage } from './chat.service.js';

describe('chat title normalization', () => {
  it('caps titles to one short line', () => {
    expect(
      sanitizeChatTitle('**Investigate Slack title generation failures in Allen conversations with excessive output**\n\nExtra text'),
    ).toBe('Investigate Slack title generation failures in Allen conversations');
  });

  it('preserves good generated titles', () => {
    expect(
      normalizeGeneratedChatTitle('Fix Slack Conversation Titles', 'random user message'),
    ).toBe('Fix Slack Conversation Titles');
  });

  it('falls back to the user request when the candidate is empty', () => {
    expect(
      normalizeGeneratedChatTitle('', 'fix the auth middleware bug'),
    ).toBe('Fix the auth middleware bug');
  });

  it('caps fallback length to 70 chars / 10 words', () => {
    const long = 'investigate the very long latency in the embeddings pipeline that has been failing for a week';
    const title = normalizeGeneratedChatTitle('', long);
    expect(title.length).toBeLessThanOrEqual(70);
    expect(title.split(/\s+/).length).toBeLessThanOrEqual(10);
  });
});

describe('chat assistant response sanitization', () => {
  it.each([
    'Done.\n\nrepocontextusage: no repo context used.',
    'Done.\n\nRepoContextUsage: no repo context used.',
    'Done.\n\nrepo_context_usage: no repo context used.',
  ])('removes trailing plain-text repo context usage marker', (raw) => {
    expect(sanitizeChatAssistantResponse(raw)).toBe('Done.');
  });

  it('removes a trailing fenced repo_context_usage JSON audit block', () => {
    expect(sanitizeChatAssistantResponse(`Done.\n\n\`\`\`json\n{"repo_context_usage":{"context_preselected":[]}}\n\`\`\``)).toBe('Done.');
  });

  it('removes a trailing raw repo_context_usage JSON audit object', () => {
    expect(sanitizeChatAssistantResponse('Done.\n\n{"repo_context_usage":{"context_loaded":[]}}')).toBe('Done.');
  });

  it('removes a trailing markdown repo_context_usage section', () => {
    expect(sanitizeChatAssistantResponse('Done.\n\n## repo_context_usage\nno repo context used.')).toBe('Done.');
  });

  it('removes a trailing labeled repo_context_usage section', () => {
    expect(sanitizeChatAssistantResponse('Done.\n\nrepo_context_usage:\n- context_loaded: []')).toBe('Done.');
  });

  it('removes a partial streaming repo_context_usage suffix', () => {
    expect(sanitizeChatAssistantResponse('Done.\n\nrepo_context_usage')).toBe('Done.');
  });

  it('preserves normal prose that mentions repo context usage', () => {
    expect(sanitizeChatAssistantResponse('The repo context usage tab has the details.')).toBe('The repo context usage tab has the details.');
  });
});

describe('fallbackTitleFromUserMessage — prefix stripping', () => {
  it('strips "For Allen," prefix from a long opener', () => {
    const result = fallbackTitleFromUserMessage(
      'For Allen, I want to identify all the partnerships we should focus on this quarter',
    );
    expect(result).not.toMatch(/^For Allen/i);
    expect(result).not.toBe('For Allen I want to identify all the partnerships we');
  });

  it('strips "For Allen" prefix with typo normalization', () => {
    const result = fallbackTitleFromUserMessage(
      'For Allen i wan to identify all the partnerships we should focus on',
    );
    expect(result).not.toMatch(/^For Allen/i);
    expect(result).not.toContain('wan to');
  });

  it('produces a clean non-empty fallback for "Give me your recommendations again"', () => {
    const result = fallbackTitleFromUserMessage('Give me your recommendations again');
    expect(result).toBeTruthy();
    expect(result).not.toBe('your recommendations again');
  });

  it('strips "For Allen when..." opener', () => {
    const result = fallbackTitleFromUserMessage(
      'For Allen when we are using it locally, it creates a new file each time',
    );
    expect(result).not.toMatch(/^For Allen/i);
    expect(result.length).toBeGreaterThan(0);
  });

  it('strips "Hey Allen," prefix', () => {
    const result = fallbackTitleFromUserMessage(
      'Hey Allen, can you help me set up the new authentication flow',
    );
    expect(result).not.toMatch(/^Hey Allen/i);
  });

  it('capitalizes the first letter of the result', () => {
    const result = fallbackTitleFromUserMessage('hey there, fix the broken widget');
    expect(result.charAt(0)).toBe(result.charAt(0).toUpperCase());
  });

  it('prepends "About " when result is a noun phrase with no action verb', () => {
    const result = fallbackTitleFromUserMessage(
      'For Allen, partnerships we should focus on this quarter',
    );
    expect(result).toMatch(/^About /i);
  });

  it('does not prepend "About " when result starts with an action verb', () => {
    const result = fallbackTitleFromUserMessage('Fix the broken auth middleware in the dashboard');
    expect(result).not.toMatch(/^About /);
    expect(result).toMatch(/^Fix/i);
  });
});

describe('deterministicSessionTaskTitle — generic verb shortcut removed', () => {
  it('returns null for a casual "fix" sentence', () => {
    expect(
      deterministicSessionTaskTitle('can you fix the way the dashboard loads on safari'),
    ).toBeNull();
  });

  it('returns null for a casual "debug" sentence', () => {
    expect(
      deterministicSessionTaskTitle('debug why the login form is not submitting'),
    ).toBeNull();
  });

  it('returns null for a casual "investigate" sentence', () => {
    expect(
      deterministicSessionTaskTitle('investigate the slow response times in production'),
    ).toBeNull();
  });

  it('returns null for a casual "implement" sentence', () => {
    expect(
      deterministicSessionTaskTitle('implement a new caching layer for the API'),
    ).toBeNull();
  });

  it('still matches a Linear title: prefix — regression guard', () => {
    const result = deterministicSessionTaskTitle('Linear title: Fix auth bug in dashboard');
    expect(result).toBe('Fix auth bug in dashboard');
  });

  it('still matches a Ticket title: prefix — regression guard', () => {
    const result = deterministicSessionTaskTitle(
      'Ticket title: Improve search indexing performance',
    );
    expect(result).toBe('Improve search indexing performance');
  });

  it('still matches a Dispatch Linear ticket prefix — regression guard', () => {
    const result = deterministicSessionTaskTitle(
      'Dispatch Linear ticket ENG-123 through Allen Fix the login page',
    );
    expect(result).toBeTruthy();
  });

  it('returns null for a plain conversational message with no Linear prefix', () => {
    expect(
      deterministicSessionTaskTitle(
        'For Allen, I want to identify all the partnerships we should focus on this quarter',
      ),
    ).toBeNull();
  });
});

describe('normalizeGeneratedChatTitle — LLM failure produces clean fallback', () => {
  it('fallback for long "For Allen" opener is NOT the raw 10-word verbatim slice', () => {
    const longOpener =
      'For Allen, I want to identify all the partnerships we should focus on this quarter';
    const result = normalizeGeneratedChatTitle('', longOpener);
    expect(result).not.toBe('For Allen I want to identify all the partnerships we');
    expect(result).not.toMatch(/^For Allen/i);
  });

  it('fallback for "For Allen when..." opener strips the prefix', () => {
    const result = normalizeGeneratedChatTitle(
      '',
      'For Allen when we are using it locally, it creates a new file each time',
    );
    expect(result).not.toMatch(/^For Allen/i);
  });

  it('preserves a good LLM-generated title over the user message fallback', () => {
    const result = normalizeGeneratedChatTitle(
      'Identify strategic partnerships for Q3',
      'For Allen, I want to identify all the partnerships we should focus on this quarter',
    );
    expect(result).toBe('Identify strategic partnerships for Q3');
  });
});
