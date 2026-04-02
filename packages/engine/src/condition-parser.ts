import { compileExpression } from 'filtrex';

const conditionCache = new Map<string, (data: Record<string, unknown>) => unknown>();

export function evaluateCondition(expression: string, state: Record<string, unknown>): boolean {
  let fn = conditionCache.get(expression);
  if (!fn) {
    fn = compileExpression(expression);
    conditionCache.set(expression, fn);
  }
  return !!fn(state);
}

/**
 * Pre-compile a condition to validate syntax. Throws on invalid expressions.
 */
export function validateCondition(expression: string): void {
  compileExpression(expression);
}
