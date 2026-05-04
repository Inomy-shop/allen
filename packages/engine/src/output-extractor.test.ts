import { describe, it, expect } from 'vitest';
import {
  outputKeys,
  outputDescriptions,
  buildOutputInstruction,
  extractOutputsSync,
} from './output-extractor.js';
import type { NodeDef } from './types.js';

describe('outputKeys', () => {
  it('returns [] for undefined', () => {
    expect(outputKeys(undefined)).toEqual([]);
  });

  it('returns the keys of an OutputsSpec object', () => {
    expect(outputKeys({ a: 'desc a', b: 'desc b' })).toEqual(['a', 'b']);
  });

  it('returns [] for empty spec', () => {
    expect(outputKeys({})).toEqual([]);
  });
});

describe('outputDescriptions', () => {
  it('returns {} for undefined', () => {
    expect(outputDescriptions(undefined)).toEqual({});
  });

  it('returns a copy of the spec', () => {
    const spec = { a: 'desc a', b: 'desc b' };
    const result = outputDescriptions(spec);
    expect(result).toEqual(spec);
    expect(result).not.toBe(spec); // must be a copy
  });
});

describe('buildOutputInstruction', () => {
  it('returns empty string for no outputs', () => {
    expect(buildOutputInstruction(undefined, undefined)).toBe('');
    expect(buildOutputInstruction({}, undefined)).toBe('');
  });

  it('returns empty string when output_format is freeform', () => {
    expect(buildOutputInstruction({ a: 'desc' }, 'freeform')).toBe('');
  });

  it('includes every key in the JSON schema block', () => {
    const result = buildOutputInstruction(
      { completeness: 'pass/fail status', missing_items: 'list of items' },
      undefined,
    );
    expect(result).toContain('"completeness"');
    expect(result).toContain('"missing_items"');
    expect(result).toContain('RESPONSE FORMAT');
  });

  it('inlines each description as a JSON comment above the key', () => {
    const result = buildOutputInstruction(
      { completeness: 'pass/fail status' },
      undefined,
    );
    expect(result).toContain('// pass/fail status');
  });

  it('renders the "Each key must contain:" guide', () => {
    const result = buildOutputInstruction(
      { a: 'alpha', b: 'beta' },
      undefined,
    );
    expect(result).toContain('Each key must contain:');
    expect(result).toContain('- a: alpha');
    expect(result).toContain('- b: beta');
  });
});

describe('extractOutputsSync', () => {
  const node: NodeDef = {
    outputs: { task_type: 'one of feature|bug|...', requirements: 'list of req' },
  };

  it('extracts from a raw JSON response', () => {
    const resp = '{"task_type":"feature","requirements":["r1","r2"]}';
    const result = extractOutputsSync(resp, node);
    expect(result.task_type).toBe('feature');
    expect(result.requirements).toEqual(['r1', 'r2']);
  });

  it('extracts from a ```json code block', () => {
    const resp = 'Here is my analysis:\n\n```json\n{"task_type":"bugfix","requirements":["fix x"]}\n```\n\nDone.';
    const result = extractOutputsSync(resp, node);
    expect(result.task_type).toBe('bugfix');
    expect(result.requirements).toEqual(['fix x']);
  });

  it('ignores extra keys not in outputs spec', () => {
    const resp = '{"task_type":"feature","requirements":["r1"],"extra_key":"ignored"}';
    const result = extractOutputsSync(resp, node);
    expect(result.task_type).toBe('feature');
    expect(result.extra_key).toBeUndefined();
  });

  it('returns {} when outputs spec is empty', () => {
    expect(extractOutputsSync('{"a":1}', { outputs: {} })).toEqual({});
  });

  it('preserves gate fields (__action, __reason) even when not in outputs spec', () => {
    const resp = '{"__action":"clarify","__reason":"need more info"}';
    const result = extractOutputsSync(resp, node);
    expect(result.__action).toBe('clarify');
    expect(result.__reason).toBe('need more info');
  });

  it('falls back to key-value parsing when no JSON present', () => {
    const resp = 'task_type: feature\nrequirements: something';
    const result = extractOutputsSync(resp, node);
    expect(result.task_type).toBe('feature');
  });
});
