import { describe, expect, it } from 'vitest';
import { normalizeGeneratedChatTitle, sanitizeChatTitle } from './chat.service.js';

describe('chat title normalization', () => {
  it('caps titles to one short line', () => {
    expect(
      sanitizeChatTitle('**Investigate Slack title generation failures in Allen conversations with excessive output**\n\nExtra text'),
    ).toBe('Investigate Slack title generation failures in Allen conversations');
  });

  it('rejects assistant-style paragraph replies and falls back to the user request', () => {
    const title = normalizeGeneratedChatTitle(
      "I need more context to help you effectively. Could you clarify what issue you're referring to?",
      'can you check all recent conversations and fix title generation',
    );

    expect(title).toBe('check all recent conversations and fix title generation');
    expect(title.length).toBeLessThanOrEqual(70);
  });

  it('preserves good generated titles', () => {
    expect(
      normalizeGeneratedChatTitle('Fix Slack Conversation Titles', 'random user message'),
    ).toBe('Fix Slack Conversation Titles');
  });
});
