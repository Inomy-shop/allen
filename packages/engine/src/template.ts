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
