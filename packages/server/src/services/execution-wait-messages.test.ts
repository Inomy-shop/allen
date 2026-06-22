import { describe, expect, it } from 'vitest';
import {
  activityToWaitMessage,
  compactWaitMessages,
  errorToWaitMessage,
  finalResponseToWaitMessage,
  inputRequestToWaitMessage,
  logToWaitMessage,
} from './execution-wait-messages.js';

describe('execution wait messages', () => {
  it('normalizes activity, logs, final responses, errors, and input requests', () => {
    const messages = compactWaitMessages([
      activityToWaitMessage({ at: '2026-06-19T00:00:01.000Z', type: 'text', agent: 'worker', content: 'hello' }),
      activityToWaitMessage({ at: '2026-06-19T00:00:02.000Z', type: 'tool_call', agent: 'worker', tool: 'Read', content: 'file.ts' }),
      logToWaitMessage({ timestamp: '2026-06-19T00:00:03.000Z', node: 'build', message: 'started' }),
      finalResponseToWaitMessage('done', '2026-06-19T00:00:04.000Z', 'workflow'),
      errorToWaitMessage('failed', '2026-06-19T00:00:05.000Z'),
      inputRequestToWaitMessage({
        status: 'waiting_for_input',
        updatedAt: '2026-06-19T00:00:06.000Z',
        currentNodes: ['approval'],
        state: { __reason: 'Approve?', __clarify_fields: [{ name: 'decision', label: 'Decision' }] },
      }),
    ]);

    expect(messages.map((message) => message.type)).toEqual([
      'text',
      'tool_call',
      'log',
      'final_response',
      'error',
      'input_request',
    ]);
    expect(messages[0].text).toContain('worker: hello');
    expect(messages[5].text).toContain('Approve?');
  });

  it('returns only the last ten messages in chronological order', () => {
    const messages = compactWaitMessages(Array.from({ length: 12 }, (_, index) => ({
      at: `2026-06-19T00:00:${String(index).padStart(2, '0')}.000Z`,
      type: 'text' as const,
      text: `message ${index}`,
    })));

    expect(messages).toHaveLength(10);
    expect(messages[0].text).toBe('message 2');
    expect(messages[9].text).toBe('message 11');
  });

  it('trims very long message text', () => {
    const message = finalResponseToWaitMessage('x'.repeat(700));

    expect(message?.text.length).toBeLessThan(520);
    expect(message?.text.endsWith('...')).toBe(true);
  });
});
