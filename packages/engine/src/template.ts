import Handlebars from 'handlebars';

// Register a 'default' helper: {{default value "fallback"}}
Handlebars.registerHelper('default', function (value: unknown, defaultValue: unknown) {
  return value ?? defaultValue;
});

const templateCache = new Map<string, HandlebarsTemplateDelegate>();

/**
 * Pre-process context values: stringify objects/arrays so Handlebars
 * doesn't render them as [object Object].
 */
function prepareContext(context: Record<string, unknown>): Record<string, unknown> {
  const prepared: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(context)) {
    if (value !== null && typeof value === 'object') {
      prepared[key] = JSON.stringify(value, null, 2);
    } else {
      prepared[key] = value;
    }
  }
  return prepared;
}

export function renderTemplate(template: string, context: Record<string, unknown>): string {
  let compiled = templateCache.get(template);
  if (!compiled) {
    compiled = Handlebars.compile(template, { noEscape: true });
    templateCache.set(template, compiled);
  }
  return compiled(prepareContext(context));
}

/**
 * One placeholder binding captured during template rendering.
 * - `placeholder`: the original path text, e.g. "state.brandList" or "input.x.y"
 * - `resolved`: the concrete value the path resolved to (may be `undefined`)
 * - `status`: 'missing' if path couldn't be resolved, 'redacted' if the path
 *    matches a secret-like name (token/password/secret/key), else undefined
 */
export interface TemplateBinding {
  placeholder: string;
  resolved: unknown;
  status?: 'missing' | 'redacted';
}

const SECRET_PATH_RX = /secret|token|password|apikey|api_key|credential/i;

/**
 * Render a Handlebars template AND return every placeholder's resolved
 * value. Used by the engine trace writer so the UI can show a "bindings"
 * table for each node's prompt — makes "why is my rendered prompt empty"
 * debuggable without a re-run.
 *
 * Implementation: parse the template into an AST, walk every PathExpression
 * node (the `{{foo.bar}}` references), resolve each against `context`, then
 * render via the existing compiled-template path for perfect output parity.
 */
export function renderTemplateWithBindings(
  template: string,
  context: Record<string, unknown>,
): { rendered: string; bindings: TemplateBinding[] } {
  const rendered = renderTemplate(template, context);

  const bindings: TemplateBinding[] = [];
  const seen = new Set<string>();
  try {
    const ast = Handlebars.parse(template);
    walkPaths(ast as unknown as { body?: unknown[]; program?: unknown }, (path) => {
      if (seen.has(path)) return;
      seen.add(path);
      if (SECRET_PATH_RX.test(path)) {
        bindings.push({ placeholder: path, resolved: undefined, status: 'redacted' });
        return;
      }
      const resolved = resolvePath(path, context);
      bindings.push({
        placeholder: path,
        resolved,
        status: resolved === undefined ? 'missing' : undefined,
      });
    });
  } catch {
    // Parse failed — template is malformed, or Handlebars AST shape changed
    // in a newer version. Bindings stay empty; rendered output is already
    // produced by the standard path above.
  }

  return { rendered, bindings };
}

function walkPaths(node: unknown, visit: (path: string) => void): void {
  if (!node || typeof node !== 'object') return;
  const n = node as Record<string, unknown>;
  if (n.type === 'PathExpression' && typeof n.original === 'string') {
    visit(n.original);
  }
  // Handlebars AST has `body[]`, `program.body[]`, `params[]`, `hash.pairs[]`,
  // `inverse.body[]`. Recurse into whatever arrays or nested objects we find.
  for (const key of Object.keys(n)) {
    const v = n[key];
    if (Array.isArray(v)) v.forEach((item) => walkPaths(item, visit));
    else if (v && typeof v === 'object') walkPaths(v, visit);
  }
}

function resolvePath(path: string, context: Record<string, unknown>): unknown {
  // Leading '@' (Handlebars data) and 'this.' prefixes → skip for now
  if (path.startsWith('@') || path === 'this') return undefined;
  const parts = path.split('.').filter(Boolean);
  let cur: unknown = context;
  for (const part of parts) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
    if (cur === undefined) return undefined;
  }
  return cur;
}
