import { describe, expect, it } from 'vitest';
import { classifyChatContextRetrievalPrompt } from './chat-context-packet.service.js';

describe('classifyChatContextRetrievalPrompt', () => {
  it.each([
    'Implement',
    'Continue',
    'Run the agent',
    'go ahead',
    'do it',
    'retry',
    'Implement the plan.',
  ])('skips low-signal action prompt: %s', (prompt) => {
    expect(classifyChatContextRetrievalPrompt(prompt)).toMatchObject({
      shouldSkip: true,
      reason: 'low_signal_action_turn',
    });
  });

  it.each([
    'Implement ASIN variant grouping',
    'continue product grouping analysis',
    'run backend-developer',
    'fix src/foo.ts',
    'LIN-123',
    '@repo continue',
    'retry checkoutFailureHandler',
  ])('keeps retrieval enabled for concrete prompt: %s', (prompt) => {
    expect(classifyChatContextRetrievalPrompt(prompt).shouldSkip).toBe(false);
  });
});
