import { PROVIDERS, type ChatProvider } from '../../chat-providers.js';

export type ContextLlmPurpose = 'cognee' | 'semantic_judge' | 'knowledge_graph_indexer';

export type ContextLlmConfig = {
  provider: ChatProvider;
  model: string;
  cwd: string;
  secret?: string;
};

type ResolveContextLlmOptions = {
  purpose: ContextLlmPurpose;
  providerOverride?: unknown;
  modelOverride?: unknown;
  cwdOverride?: unknown;
};

const DEFAULT_CONTEXT_LLM_PROVIDER: ChatProvider = 'codex';
const DEFAULT_CONTEXT_LLM_MODEL = 'gpt-5.5';

export function resolveContextLlmConfig(options: ResolveContextLlmOptions): ContextLlmConfig {
  return {
    provider: resolveContextLlmProvider(options.purpose, options.providerOverride),
    model: firstString(options.modelOverride)
      ?? process.env.ALLEN_CONTEXT_LLM_MODEL
      ?? legacyModelEnv(options.purpose)
      ?? DEFAULT_CONTEXT_LLM_MODEL,
    cwd: firstString(options.cwdOverride)
      ?? process.env.ALLEN_CONTEXT_LLM_CWD
      ?? legacyCwdEnv(options.purpose)
      ?? defaultCwd(options.purpose),
    secret: process.env.ALLEN_CONTEXT_LLM_SECRET
      ?? legacySecretEnv(options.purpose)
      ?? process.env.ALLEN_CONTEXT_EVAL_JUDGE_SECRET
      ?? process.env.JWT_ACCESS_SECRET,
  };
}

function resolveContextLlmProvider(purpose: ContextLlmPurpose, override?: unknown): ChatProvider {
  const raw = firstString(override)
    ?? process.env.ALLEN_CONTEXT_LLM_PROVIDER
    ?? legacyProviderEnv(purpose)
    ?? DEFAULT_CONTEXT_LLM_PROVIDER;
  const normalized = raw === 'allen_codex' ? 'codex' : raw;
  return PROVIDERS.some((provider) => provider.provider === normalized)
    ? normalized as ChatProvider
    : DEFAULT_CONTEXT_LLM_PROVIDER;
}

function legacyProviderEnv(purpose: ContextLlmPurpose): string | undefined {
  if (purpose === 'cognee') return process.env.ALLEN_COGNEE_LLM_PROVIDER;
  return undefined;
}

function legacyModelEnv(purpose: ContextLlmPurpose): string | undefined {
  if (purpose === 'cognee') return process.env.ALLEN_COGNEE_LLM_MODEL;
  if (purpose === 'semantic_judge') return process.env.ALLEN_CONTEXT_SEMANTIC_JUDGE_MODEL;
  return undefined;
}

function legacyCwdEnv(purpose: ContextLlmPurpose): string | undefined {
  if (purpose === 'cognee') return process.env.ALLEN_COGNEE_LLM_CWD;
  if (purpose === 'semantic_judge') return process.env.ALLEN_CONTEXT_SEMANTIC_JUDGE_CWD;
  return undefined;
}

function legacySecretEnv(purpose: ContextLlmPurpose): string | undefined {
  if (purpose === 'cognee') return process.env.ALLEN_COGNEE_LLM_SECRET;
  return undefined;
}

function defaultCwd(purpose: ContextLlmPurpose): string {
  if (purpose === 'cognee') return '/tmp/allen/cognee-llm';
  if (purpose === 'knowledge_graph_indexer') return '/tmp/allen/context-indexer';
  return '/tmp/allen/context-evaluator';
}

/**
 * Resolves the provider/model to use when seeding Context Judge / Context Quality agents.
 *
 * Resolution order (same env vars as the broader context engine LLM config):
 *   1. ALLEN_CONTEXT_LLM_PROVIDER / ALLEN_CONTEXT_LLM_MODEL — operator-configured values
 *   2. 'codex' / 'gpt-5.5' — hard-coded defaults
 *
 * Env vars:
 *   ALLEN_CONTEXT_LLM_PROVIDER — provider slug (e.g. 'codex', 'claude-cli')
 *   ALLEN_CONTEXT_LLM_MODEL    — model string (e.g. 'gpt-5.5', 'sonnet')
 *
 * This is intentionally lightweight (no cwd/secret resolution) since it is
 * used only for agent seed definitions, not for spawning LLM workers directly.
 */
export function resolveContextJudgeAgentRuntimeConfig(): { provider: ChatProvider; model: string } {
  const rawProvider = process.env.ALLEN_CONTEXT_LLM_PROVIDER?.trim();
  const rawModel = process.env.ALLEN_CONTEXT_LLM_MODEL?.trim();

  const provider: ChatProvider =
    rawProvider && PROVIDERS.some((p) => p.provider === rawProvider)
      ? (rawProvider as ChatProvider)
      : DEFAULT_CONTEXT_LLM_PROVIDER;

  const model: string = rawModel || DEFAULT_CONTEXT_LLM_MODEL;

  return { provider, model };
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}
