/**
 * openrouter-warning.ts — shared helpers for the Non-Claude OpenRouter warning UI.
 *
 * F1/F2: REQ-7 / AC6 — when an operator picks a non-Claude model for an
 * OpenRouter provider targeting the Claude Code execution path, the UI must
 * display a clear, persistent warning that the model may not work correctly.
 *
 * Heuristic: provider === 'openrouter' && model does NOT start with 'anthropic/'.
 */

/** Warning text shown adjacent to the model selector when the condition holds. */
export const OPENROUTER_NON_CLAUDE_WARNING =
  'This model is experimental for the Claude Code execution path. Non-Claude models may not work correctly with this runtime.';

/**
 * Returns true when the provider is OpenRouter and the model id does NOT start
 * with `anthropic/`, indicating a model that the Claude Code CLI may not handle
 * correctly. Returns false for null/undefined inputs and for any provider that
 * is not `'openrouter'`.
 */
export function isNonClaudeOpenRouterModel(
  provider: string | undefined | null,
  model: string | undefined | null,
): boolean {
  if (!provider || !model) return false;
  return provider === 'openrouter' && !model.startsWith('anthropic/');
}
