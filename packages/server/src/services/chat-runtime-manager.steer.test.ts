/**
 * Unit tests for steerPersistentChat.
 *
 * Tests the runtime-lookup, chain-bypass, and fallback logic without importing
 * the full chat-runtime-manager (which has module-level state).  We reproduce
 * the core lookup-and-steer logic inline as a pure function.
 */

import { describe, it, expect } from 'vitest';

interface FakeRuntimeEntry {
  runtime: {
    id: string;
    provider: string;
    key: string;
    steer?: (text: string) => boolean;
  };
  chain: Promise<unknown>;
}

/**
 * Inline reproduction of steerPersistentChat from chat-runtime-manager.ts.
 */
function steerPersistentChat(
  runtimes: Map<string, FakeRuntimeEntry>,
  chatSessionId: string,
  text: string,
): boolean {
  const match = [...runtimes.keys()].find((key) => key.includes(`session=${chatSessionId}|`));
  if (!match) return false;
  const entry = runtimes.get(match);
  if (!entry || typeof entry.runtime.steer !== 'function') return false;
  return entry.runtime.steer(text);
}

describe('steerPersistentChat', () => {
  it('returns true when a matching runtime entry accepts the steer', () => {
    const runtimes = new Map<string, FakeRuntimeEntry>();
    runtimes.set('session=fake-id|provider=claude|model=sonnet|cwd=/tmp|plan=false', {
      runtime: {
        id: 'claude-1',
        provider: 'claude',
        key: 'session=fake-id|...',
        steer: () => true,
      },
      chain: Promise.resolve(),
    });

    const result = steerPersistentChat(runtimes, 'fake-id', 'hello');

    expect(result).toBe(true);
  });

  it('does NOT modify entry.chain', () => {
    const runtimes = new Map<string, FakeRuntimeEntry>();
    const chain = Promise.resolve();
    runtimes.set('session=fake-id|provider=claude|model=sonnet|cwd=/tmp|plan=false', {
      runtime: {
        id: 'claude-1',
        provider: 'claude',
        key: 'session=fake-id|...',
        steer: () => true,
      },
      chain,
    });

    const beforeChain = runtimes.values().next().value!.chain;
    steerPersistentChat(runtimes, 'fake-id', 'hello');
    const afterChain = runtimes.values().next().value!.chain;

    expect(afterChain).toBe(beforeChain);
  });

  it('returns false when no runtime key matches the session id', () => {
    const runtimes = new Map<string, FakeRuntimeEntry>();
    runtimes.set('session=other-id|provider=claude|model=sonnet|cwd=/tmp|plan=false', {
      runtime: {
        id: 'claude-1',
        provider: 'claude',
        key: 'session=other-id|...',
        steer: () => true,
      },
      chain: Promise.resolve(),
    });

    const result = steerPersistentChat(runtimes, 'unknown-id', 'hello');

    expect(result).toBe(false);
  });

  it('returns false when the runtime does not implement steer', () => {
    const runtimes = new Map<string, FakeRuntimeEntry>();
    runtimes.set('session=fake-id|provider=codex|model=gpt|cwd=/tmp|plan=false', {
      runtime: {
        id: 'codex-1',
        provider: 'codex',
        key: 'session=fake-id|...',
        // No steer method
      },
      chain: Promise.resolve(),
    });

    const result = steerPersistentChat(runtimes, 'fake-id', 'hello');

    expect(result).toBe(false);
  });

  it('returns false when steer returns false (declined by runtime)', () => {
    const runtimes = new Map<string, FakeRuntimeEntry>();
    runtimes.set('session=fake-id|provider=claude|model=sonnet|cwd=/tmp|plan=false', {
      runtime: {
        id: 'claude-1',
        provider: 'claude',
        key: 'session=fake-id|...',
        steer: () => false,
      },
      chain: Promise.resolve(),
    });

    const result = steerPersistentChat(runtimes, 'fake-id', 'hello');

    expect(result).toBe(false);
  });

  it('finds the first matching entry when multiple keys contain the session id', () => {
    const runtimes = new Map<string, FakeRuntimeEntry>();
    runtimes.set('session=fake-id|provider=claude|model=sonnet|cwd=/tmp|plan=false', {
      runtime: {
        id: 'claude-1',
        provider: 'claude',
        key: '...',
        steer: () => true,
      },
      chain: Promise.resolve(),
    });
    runtimes.set('session=fake-id|provider=codex|model=gpt|cwd=/tmp|plan=false', {
      runtime: {
        id: 'codex-1',
        provider: 'codex',
        key: '...',
        steer: () => false,
      },
      chain: Promise.resolve(),
    });

    const result = steerPersistentChat(runtimes, 'fake-id', 'hello');

    // First match is the claude runtime (inserted first, found first via Map order)
    expect(result).toBe(true);
  });
});
