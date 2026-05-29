import { describe, expect, it } from 'vitest';
import { normalizeGeneratedChatTitle, sanitizeChatAssistantResponse, sanitizeChatTitle } from './chat.service.js';

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
    ).toBe('fix the auth middleware bug');
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
