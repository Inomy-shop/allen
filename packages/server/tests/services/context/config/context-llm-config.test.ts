import { afterEach, describe, expect, it } from 'vitest';
import { resolveContextLlmConfig } from '../../../../src/services/context/config/context-llm-config.js';

describe('resolveContextLlmConfig', () => {
  const originalEnv = {
    ALLEN_CONTEXT_LLM_PROVIDER: process.env.ALLEN_CONTEXT_LLM_PROVIDER,
    ALLEN_CONTEXT_LLM_MODEL: process.env.ALLEN_CONTEXT_LLM_MODEL,
    ALLEN_CONTEXT_LLM_CWD: process.env.ALLEN_CONTEXT_LLM_CWD,
    ALLEN_COGNEE_LLM_PROVIDER: process.env.ALLEN_COGNEE_LLM_PROVIDER,
    ALLEN_COGNEE_LLM_MODEL: process.env.ALLEN_COGNEE_LLM_MODEL,
    ALLEN_CONTEXT_SEMANTIC_JUDGE_MODEL: process.env.ALLEN_CONTEXT_SEMANTIC_JUDGE_MODEL,
  };

  afterEach(() => {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('uses common context LLM env before legacy purpose-specific env', () => {
    process.env.ALLEN_CONTEXT_LLM_PROVIDER = 'claude-cli';
    process.env.ALLEN_CONTEXT_LLM_MODEL = 'opus';
    process.env.ALLEN_CONTEXT_LLM_CWD = '/tmp/context-common';
    process.env.ALLEN_COGNEE_LLM_PROVIDER = 'codex';
    process.env.ALLEN_COGNEE_LLM_MODEL = 'gpt-legacy';

    expect(resolveContextLlmConfig({ purpose: 'cognee' })).toEqual(expect.objectContaining({
      provider: 'claude-cli',
      model: 'opus',
      cwd: '/tmp/context-common',
    }));
  });

  it('keeps legacy Cognee env as a compatibility fallback', () => {
    delete process.env.ALLEN_CONTEXT_LLM_PROVIDER;
    delete process.env.ALLEN_CONTEXT_LLM_MODEL;
    process.env.ALLEN_COGNEE_LLM_PROVIDER = 'claude-cli';
    process.env.ALLEN_COGNEE_LLM_MODEL = 'sonnet';

    expect(resolveContextLlmConfig({ purpose: 'cognee' })).toEqual(expect.objectContaining({
      provider: 'claude-cli',
      model: 'sonnet',
    }));
  });

  it('uses request overrides before env vars', () => {
    process.env.ALLEN_CONTEXT_LLM_PROVIDER = 'claude-cli';
    process.env.ALLEN_CONTEXT_LLM_MODEL = 'opus';

    expect(resolveContextLlmConfig({
      purpose: 'semantic_judge',
      providerOverride: 'codex',
      modelOverride: 'gpt-override',
    })).toEqual(expect.objectContaining({
      provider: 'codex',
      model: 'gpt-override',
    }));
  });
});
