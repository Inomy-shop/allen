import { compileExpression } from 'filtrex';

const conditionCache = new Map<string, (data: Record<string, unknown>) => unknown>();

/**
 * Collect every identifier referenced in a filtrex expression so we can
 * pre-populate missing ones with `undefined`. Filtrex otherwise returns
 * an UnknownPropertyError object (not throws!) which gets coerced to `true`
 * by `!!`, making both `x` and `NOT x` evaluate to `true` when x is missing.
 */
function extractIdentifiers(expression: string): string[] {
  const keywords = new Set(['and', 'or', 'not', 'in', 'true', 'false', 'null', 'undefined']);
  const ids = new Set<string>();
  // Strip string literals first
  const stripped = expression.replace(/"[^"]*"/g, '""').replace(/'[^']*'/g, "''");
  const matches = stripped.matchAll(/\b([a-zA-Z_][a-zA-Z0-9_]*)\b/g);
  for (const m of matches) {
    const token = m[1];
    if (!keywords.has(token.toLowerCase()) && isNaN(Number(token))) {
      ids.add(token);
    }
  }
  return [...ids];
}

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

  // Build a safe state view where any identifier referenced in the expression
  // but missing from `state` is set to `false`. Without this, filtrex returns
  // an UnknownPropertyError object (not throws), and `!!errorObject === true`
  // makes BOTH `x` and `NOT x` evaluate to `true` when x is undefined.
  const ids = extractIdentifiers(expression);
  const safeState: Record<string, unknown> = { ...state };

  // CRITICAL: filtrex does NOT have built-in `true`, `false`, `null`, or
  // `undefined` literals. It treats them as variable names that resolve to
  // UnknownPropertyError at runtime. We pre-populate them in safeState so
  // expressions like `foo == true` or `x != null` work correctly.
  //
  // Filtrex 3.x requires actual booleans for logical operators (not/and/or)
  // — passing numbers (0/1) throws UnexpectedTypeError. So we use real
  // boolean values throughout, NOT numeric coercion.
  //
  // For `null`/`undefined`: mapped to `false` so that `x != null` works
  // when missing/null state values are also coerced to `false`:
  //   x is null/missing (→ false)  → false != false → false  ✓
  //   x is a string "/path"        → "/path" != false → true  ✓
  safeState.true = true;
  safeState.false = false;
  safeState.null = false;
  safeState.undefined = false;

  for (const id of ids) {
    if (!(id in safeState)) safeState[id] = false;
    // Also coerce undefined/null to false so NOT x works sanely
    else if (safeState[id] === undefined || safeState[id] === null) safeState[id] = false;
  }

  const result = fn(safeState);
  // Defensive: if filtrex still returned an error object, coerce to false
  if (result instanceof Error) return false;
  return !!result;
}

/**
 * Pre-compile a condition to validate syntax. Throws on invalid expressions.
 */
export function validateCondition(expression: string): void {
  compileExpression(normalizeExpression(expression));
}
