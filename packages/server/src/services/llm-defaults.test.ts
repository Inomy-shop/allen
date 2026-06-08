import { describe, it, expect, afterEach } from 'vitest';
import {
  getDefaultAgentModel,
  resolveAgentProviderModel,
} from './llm-defaults.js';

// All functions in llm-defaults.ts read process.env at call time (not at
// import time), so we can safely manipulate env vars between tests without
// needing dynamic re-imports or module cache resets.

afterEach(() => {
  delete process.env.ALLEN_DEFAULT_AGENT_PROVIDER;
  delete process.env.ALLEN_DEFAULT_AGENT_MODEL;
});

describe('readEnvModel — open provider (DeepSeek)', () => {
  it('accepts any non-empty model string for deepseek', () => {
    process.env.ALLEN_DEFAULT_AGENT_PROVIDER = 'deepseek';
    process.env.ALLEN_DEFAULT_AGENT_MODEL = 'deepseek-v4-pro[1m]';
    expect(getDefaultAgentModel()).toBe('deepseek-v4-pro[1m]');
  });

  it('accepts a non-standard model string for deepseek', () => {
    process.env.ALLEN_DEFAULT_AGENT_PROVIDER = 'deepseek';
    process.env.ALLEN_DEFAULT_AGENT_MODEL = 'deepseek-r2-custom';
    expect(getDefaultAgentModel()).toBe('deepseek-r2-custom');
  });

  it('falls back to provider default when model env is not set', () => {
    process.env.ALLEN_DEFAULT_AGENT_PROVIDER = 'deepseek';
    delete process.env.ALLEN_DEFAULT_AGENT_MODEL;
    // deepseek defaultModel is 'deepseek-v4-pro[1m]'
    expect(getDefaultAgentModel()).toBe('deepseek-v4-pro[1m]');
  });

  it('does not accept empty string for deepseek — returns provider default', () => {
    process.env.ALLEN_DEFAULT_AGENT_PROVIDER = 'deepseek';
    process.env.ALLEN_DEFAULT_AGENT_MODEL = '   '; // whitespace trims to empty
    expect(getDefaultAgentModel()).toBe('deepseek-v4-pro[1m]');
  });
});

describe('readEnvModel — open provider (Xiaomi MiMo)', () => {
  it('accepts any non-empty model string for xiaomi-mimo', () => {
    process.env.ALLEN_DEFAULT_AGENT_PROVIDER = 'xiaomi-mimo';
    process.env.ALLEN_DEFAULT_AGENT_MODEL = 'mimo-v2.5-pro';
    expect(getDefaultAgentModel()).toBe('mimo-v2.5-pro');
  });

  it('falls back to provider default when MiMo model env is not set', () => {
    process.env.ALLEN_DEFAULT_AGENT_PROVIDER = 'xiaomi-mimo';
    delete process.env.ALLEN_DEFAULT_AGENT_MODEL;
    expect(getDefaultAgentModel()).toBe('mimo-v2.5-pro');
  });
});

describe('readEnvModel — open provider (Kimi)', () => {
  it('accepts any non-empty model string for kimi', () => {
    process.env.ALLEN_DEFAULT_AGENT_PROVIDER = 'kimi';
    process.env.ALLEN_DEFAULT_AGENT_MODEL = 'kimi-k2.5';
    expect(getDefaultAgentModel()).toBe('kimi-k2.5');
  });

  it('falls back to provider default when Kimi model env is not set', () => {
    process.env.ALLEN_DEFAULT_AGENT_PROVIDER = 'kimi';
    delete process.env.ALLEN_DEFAULT_AGENT_MODEL;
    expect(getDefaultAgentModel()).toBe('kimi-k2.5');
  });
});

describe('resolveAgentProviderModel — deepseek (Mode 1: preserve, env unset)', () => {
  it('preserves deepseek seed model when env is unset', () => {
    delete process.env.ALLEN_DEFAULT_AGENT_PROVIDER;
    const result = resolveAgentProviderModel('deepseek', 'deepseek-v4-flash');
    expect(result.provider).toBe('deepseek');
    expect(result.model).toBe('deepseek-v4-flash');
  });

  it('preserves an arbitrary deepseek model string in preserve mode', () => {
    delete process.env.ALLEN_DEFAULT_AGENT_PROVIDER;
    const result = resolveAgentProviderModel('deepseek', 'deepseek-r2-turbo');
    expect(result.provider).toBe('deepseek');
    expect(result.model).toBe('deepseek-r2-turbo');
  });

  it('falls back to deepseek defaultModel when seedModel is empty in preserve mode', () => {
    delete process.env.ALLEN_DEFAULT_AGENT_PROVIDER;
    const result = resolveAgentProviderModel('deepseek', '');
    expect(result.provider).toBe('deepseek');
    // cfg?.open && seedModel is falsy → falls back to defaultModel
    expect(result.model).toBe('deepseek-v4-pro[1m]');
  });
});

describe('resolveAgentProviderModel — deepseek (Mode 2: same-provider, env set)', () => {
  it('preserves deepseek seed model when env provider is also deepseek', () => {
    process.env.ALLEN_DEFAULT_AGENT_PROVIDER = 'deepseek';
    process.env.ALLEN_DEFAULT_AGENT_MODEL = 'deepseek-v4-pro[1m]';
    const result = resolveAgentProviderModel('deepseek', 'deepseek-v4-flash');
    expect(result.provider).toBe('deepseek');
    // Mode 2 same-provider: open providers preserve any non-empty seed model
    expect(result.model).toBe('deepseek-v4-flash');
  });

  it('uses env model for deepseek when seed model is empty (Mode 2 fallback)', () => {
    process.env.ALLEN_DEFAULT_AGENT_PROVIDER = 'deepseek';
    process.env.ALLEN_DEFAULT_AGENT_MODEL = 'deepseek-v4-pro[1m]';
    const result = resolveAgentProviderModel('deepseek', '');
    expect(result.provider).toBe('deepseek');
    // Empty seedModel → Boolean('') is false → falls through to Mode 3 env model
    expect(result.model).toBe('deepseek-v4-pro[1m]');
  });
});

describe('resolveAgentProviderModel — deepseek (Mode 3: cross-provider)', () => {
  it('switches claude-cli seed to deepseek env provider+model', () => {
    process.env.ALLEN_DEFAULT_AGENT_PROVIDER = 'deepseek';
    process.env.ALLEN_DEFAULT_AGENT_MODEL = 'deepseek-v4-pro[1m]';
    const result = resolveAgentProviderModel('claude-cli', 'sonnet');
    expect(result.provider).toBe('deepseek');
    expect(result.model).toBe('deepseek-v4-pro[1m]');
  });
});
