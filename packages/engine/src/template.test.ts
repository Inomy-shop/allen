import { describe, it, expect } from 'vitest';
import { renderTemplate } from './template.js';

describe('renderTemplate', () => {
  it('interpolates a simple variable', () => {
    expect(renderTemplate('Hello {{name}}', { name: 'World' })).toBe('Hello World');
  });

  it('renders an object value as pretty JSON (default Handlebars would print [object Object])', () => {
    const out = renderTemplate('{{data}}', { data: { a: 1, b: 'two' } });
    expect(out).toContain('"a": 1');
    expect(out).toContain('"b": "two"');
  });

  it('supports nested object paths while preserving direct JSON rendering', () => {
    const context = { human_input: { feedback: { value: 'Use the design token.' } } };
    expect(renderTemplate('{{human_input.feedback.value}}', context)).toBe('Use the design token.');
    expect(renderTemplate('{{human_input}}', context)).toContain('"feedback"');
  });

  it('renders an array as pretty JSON', () => {
    const out = renderTemplate('{{items}}', { items: ['a', 'b', 'c'] });
    expect(out).toContain('"a"');
    expect(out).toContain('"b"');
    expect(out).toContain('"c"');
  });

  it('supports the {{#if}} conditional block', () => {
    const tmpl = '{{#if answers}}Answers: {{answers}}{{/if}}';
    expect(renderTemplate(tmpl, { answers: 'yes' })).toContain('Answers: yes');
    expect(renderTemplate(tmpl, {})).toBe('');
  });

  it('supports the {{default}} helper', () => {
    const tmpl = '{{default value "fallback"}}';
    expect(renderTemplate(tmpl, { value: 'real' })).toBe('real');
    expect(renderTemplate(tmpl, {})).toBe('fallback');
  });

  it('does not HTML-escape characters (noEscape: true)', () => {
    const out = renderTemplate('{{code}}', { code: '<div>x & y</div>' });
    expect(out).toBe('<div>x & y</div>');
  });

  it('caches compiled templates so re-rendering is fast', () => {
    // Not a behavioral guarantee, but rendering the same template twice
    // should produce the same output and not error.
    const tmpl = '{{x}}';
    expect(renderTemplate(tmpl, { x: 1 })).toBe('1');
    expect(renderTemplate(tmpl, { x: 2 })).toBe('2');
  });
});
