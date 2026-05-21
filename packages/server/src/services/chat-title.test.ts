import { describe, expect, it } from 'vitest';
import { normalizeGeneratedChatTitle, sanitizeChatTitle } from './chat.service.js';

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
