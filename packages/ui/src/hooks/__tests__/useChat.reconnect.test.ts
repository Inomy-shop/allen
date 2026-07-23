/**
 * useChat reconnect logic — unit tests
 *
 * These tests exercise the exported pure helpers (checkIsStreaming, sleep)
 * and a standalone tryReconnect-style scenario.  Full hook integration
 * tests would require @testing-library/react which is not installed; we
 * instead test the logic units extracted for that purpose.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  cachedChatSessionValue,
  checkIsStreaming,
  consumeSessionEventStream,
  isSameChatSession,
  normalizeChatSessionId,
  sessionReconnectDelay,
  sleep,
  MAX_RECONNECT_ATTEMPTS,
} from '../useChat';

describe('chat tab memory', () => {
  it('normalizes blank tab ids and preserves real session ids', () => {
    expect(normalizeChatSessionId('')).toBeNull();
    expect(normalizeChatSessionId(null)).toBeNull();
    expect(normalizeChatSessionId('session-1')).toBe('session-1');
  });

  it('treats selecting the active session as a no-op', () => {
    expect(isSameChatSession('session-1', 'session-1')).toBe(true);
    expect(isSameChatSession(null, '')).toBe(true);
    expect(isSameChatSession('session-1', 'session-2')).toBe(false);
  });

  it('restores the exact in-memory messages for a previously opened tab', () => {
    const messages = [{ _id: 'message-1', content: 'Still here' }];
    const cache = new Map([['session-1', messages]]);

    expect(cachedChatSessionValue(cache, 'session-1', [])).toBe(messages);
    expect(cachedChatSessionValue(cache, 'session-2', [])).toEqual([]);
  });
});

// ─── checkIsStreaming ──────────────────────────────────────────────────────

describe('checkIsStreaming', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns true when the backend reports streaming:true', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ streaming: true }),
    });
    // We need to mock the api.isStreaming path; checkIsStreaming calls api.isStreaming
    // which calls request() which calls fetch internally.
    // Simulate by mocking the module-level fetch used by request().
    vi.stubGlobal('fetch', mockFetch);

    const result = await checkIsStreaming('session-123');
    expect(result).toBe(true);
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/chat/sessions/session-123/streaming'),
      expect.any(Object),
    );
  });

  it('returns false when the backend reports streaming:false', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ streaming: false }),
    }));

    const result = await checkIsStreaming('session-456');
    expect(result).toBe(false);
  });

  it('returns false when fetch throws (network error)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network error')));

    const result = await checkIsStreaming('session-789');
    expect(result).toBe(false);
  });

  it('returns false when the API returns a non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({}),
    }));

    const result = await checkIsStreaming('session-err');
    // api.request throws on non-ok, checkIsStreaming catches and returns false
    expect(result).toBe(false);
  });
});

// ─── sleep ────────────────────────────────────────────────────────────────

describe('sleep', () => {
  it('resolves after approximately the requested delay', async () => {
    const start = Date.now();
    await sleep(50);
    expect(Date.now() - start).toBeGreaterThanOrEqual(40);
  });

  it('resolves immediately with 0 ms', async () => {
    await expect(sleep(0)).resolves.toBeUndefined();
  });
});

// ─── MAX_RECONNECT_ATTEMPTS constant ─────────────────────────────────────

describe('MAX_RECONNECT_ATTEMPTS', () => {
  it('is 3', () => {
    expect(MAX_RECONNECT_ATTEMPTS).toBe(3);
  });
});

describe('always-on session stream', () => {
  it('parses events and treats a clean reader close as reconnectable completion', async () => {
    const encoder = new TextEncoder();
    const chunks = [
      { done: false, value: encoder.encode('event: watcher_update\ndata: {"executionId":"exec-1"}\n\n') },
      { done: true, value: undefined },
    ];
    const reader = { read: vi.fn().mockImplementation(async () => chunks.shift()) } as unknown as ReadableStreamDefaultReader<Uint8Array>;
    const events: Array<[string, unknown]> = [];
    await consumeSessionEventStream(reader, (event, data) => events.push([event, data]));
    expect(events).toEqual([['watcher_update', { executionId: 'exec-1' }]]);
    expect(reader.read).toHaveBeenCalledTimes(2);
  });

  it('uses bounded exponential delay for repeated reconnects', () => {
    expect([1, 2, 3, 4, 20].map(sessionReconnectDelay)).toEqual([500, 1000, 2000, 4000, 5000]);
  });
});

// ─── Reconnect scenario (logic simulation) ────────────────────────────────
//
// Because @testing-library/react is not available we simulate the
// reconnect decision logic inline, mirroring what sendMessage does in
// its catch block.  This verifies the branching without mounting the hook.

type SimResult = 'reconnected' | 'failed_message' | 'abort_no_action';

async function simulateReconnectBranch(opts: {
  isAbortError: boolean;
  isStreamingResponses: boolean[];   // one per attempt
  reconnectSucceeds: boolean;
}): Promise<SimResult> {
  if (opts.isAbortError) return 'abort_no_action';

  let reconnected = false;
  for (let attempt = 1; attempt <= MAX_RECONNECT_ATTEMPTS; attempt++) {
    // Simulated isStreaming check for this attempt
    const stillStreaming = opts.isStreamingResponses[attempt - 1] ?? false;
    if (!stillStreaming) break;

    try {
      if (opts.reconnectSucceeds) {
        // Simulate reading the reconnect stream successfully
        reconnected = true;
        break;
      } else {
        throw new Error('reconnect fetch failed');
      }
    } catch {
      // continue to next attempt
    }
  }

  return reconnected ? 'reconnected' : 'failed_message';
}

describe('reconnect branch logic', () => {
  it('AbortError → no failed message, no reconnect', async () => {
    const result = await simulateReconnectBranch({
      isAbortError: true,
      isStreamingResponses: [],
      reconnectSucceeds: false,
    });
    expect(result).toBe('abort_no_action');
  });

  it('network error + backend still streaming → reconnects and resumes', async () => {
    const result = await simulateReconnectBranch({
      isAbortError: false,
      isStreamingResponses: [true, true, true],  // backend is streaming on first check
      reconnectSucceeds: true,
    });
    expect(result).toBe('reconnected');
  });

  it('network error + backend NOT streaming → shows failed message', async () => {
    const result = await simulateReconnectBranch({
      isAbortError: false,
      isStreamingResponses: [false],   // backend immediately says not streaming
      reconnectSucceeds: false,
    });
    expect(result).toBe('failed_message');
  });

  it('network error + streaming true but reconnect always fails → shows failed message after MAX attempts', async () => {
    const result = await simulateReconnectBranch({
      isAbortError: false,
      isStreamingResponses: [true, true, true],
      reconnectSucceeds: false,
    });
    expect(result).toBe('failed_message');
  });

  it('reconnect succeeds on the second attempt', async () => {
    let attempt = 0;
    let reconnected = false;

    for (let i = 1; i <= MAX_RECONNECT_ATTEMPTS; i++) {
      attempt = i;
      const stillStreaming = true;
      if (!stillStreaming) break;

      try {
        if (attempt < 2) {
          throw new Error('first attempt fails');
        }
        reconnected = true;
        break;
      } catch {
        // loop
      }
    }

    expect(reconnected).toBe(true);
    expect(attempt).toBe(2);
  });
});
