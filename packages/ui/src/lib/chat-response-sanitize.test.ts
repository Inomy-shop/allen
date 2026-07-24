import { describe, expect, it } from 'vitest';
import { normalizeThinkingText, sanitizeChatAssistantResponse } from './chat-response-sanitize';

describe('sanitizeChatAssistantResponse', () => {
  it('removes provider-internal tags without dropping their readable content', () => {
    expect(sanitizeChatAssistantResponse('Answer<sub>internal</sub>')).toBe('Answerinternal');
    expect(sanitizeChatAssistantResponse('<analysis>Checking evidence.</analysis>Done.')).toBe('Checking evidence.Done.');
  });

  it('keeps adjacent reasoning summaries readable', () => {
    expect(normalizeThinkingText('Checked the API.Now inspecting the UI.')).toBe(
      'Checked the API.\n\nNow inspecting the UI.',
    );
    expect(normalizeThinkingText('Checked routingPlanning the implementation')).toBe(
      'Checked routing\n\nPlanning the implementation',
    );
  });
});
