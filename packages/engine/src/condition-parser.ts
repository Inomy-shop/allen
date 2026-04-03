import { compileExpression } from 'filtrex';

const conditionCache = new Map<string, (data: Record<string, unknown>) => unknown>();

/**
 * Normalize uppercase logical operators to lowercase for filtrex compatibility.
 * Handles: AND → and, OR → or, NOT → not
 * Only replaces standalone keywords (word boundaries) to avoid mangling variable names.
 */
function normalizeExpression(expression: string): string {
  return expression
    .replace(/\bAND\b/g, 'and')
    .replace(/\bOR\b/g, 'or')
    .replace(/\bNOT\b/g, 'not')
    // Filtrex uses double quotes for strings, not single quotes.
    // Convert 'value' to "value" so YAML-friendly single quotes work.
    .replace(/'/g, '"');
}

export function evaluateCondition(expression: string, state: Record<string, unknown>): boolean {
  const normalized = normalizeExpression(expression);
  let fn = conditionCache.get(normalized);
  if (!fn) {
    fn = compileExpression(normalized);
    conditionCache.set(normalized, fn);
  }
  return !!fn(state);
}

/**
 * Pre-compile a condition to validate syntax. Throws on invalid expressions.
 */
export function validateCondition(expression: string): void {
  compileExpression(normalizeExpression(expression));
}
