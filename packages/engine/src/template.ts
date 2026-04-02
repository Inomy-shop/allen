import Handlebars from 'handlebars';

// Register a 'default' helper: {{default value "fallback"}}
Handlebars.registerHelper('default', function (value: unknown, defaultValue: unknown) {
  return value ?? defaultValue;
});

const templateCache = new Map<string, HandlebarsTemplateDelegate>();

export function renderTemplate(template: string, context: Record<string, unknown>): string {
  let compiled = templateCache.get(template);
  if (!compiled) {
    compiled = Handlebars.compile(template, { noEscape: true });
    templateCache.set(template, compiled);
  }
  return compiled(context);
}
