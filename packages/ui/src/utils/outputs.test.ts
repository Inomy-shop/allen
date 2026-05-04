import { describe, it, expect } from 'vitest';
import { outputsAsKeys, mergeOutputsFromKeys } from './outputs.js';

describe('outputsAsKeys', () => {
  it('returns [] for undefined / null / empty', () => {
    expect(outputsAsKeys(undefined)).toEqual([]);
    expect(outputsAsKeys(null)).toEqual([]);
    expect(outputsAsKeys({})).toEqual([]);
    expect(outputsAsKeys([])).toEqual([]);
  });

  it('returns keys of an object form', () => {
    expect(outputsAsKeys({ a: 'desc a', b: 'desc b' })).toEqual(['a', 'b']);
  });

  it('returns the array for legacy array form (backwards-compat)', () => {
    expect(outputsAsKeys(['x', 'y', 'z'])).toEqual(['x', 'y', 'z']);
  });

  it('regression: does not throw for number or string inputs', () => {
    expect(outputsAsKeys(42 as any)).toEqual([]);
    expect(outputsAsKeys('a,b' as any)).toEqual([]);
  });

  it('regression: broken call site that did `(outputs ?? []).join(\", \")` no longer matters', () => {
    // This pattern used to fail with "outputs.join is not a function" when outputs
    // was an object. outputsAsKeys() normalises first, so .join() is now safe.
    const spec = { completeness: 'status', missing_items: 'items' };
    expect(outputsAsKeys(spec).join(', ')).toBe('completeness, missing_items');
  });
});

describe('mergeOutputsFromKeys', () => {
  it('builds a fresh object when current is empty', () => {
    expect(mergeOutputsFromKeys({}, 'a, b, c')).toEqual({ a: '', b: '', c: '' });
  });

  it('preserves descriptions for existing keys', () => {
    const existing = { a: 'desc a', b: 'desc b' };
    expect(mergeOutputsFromKeys(existing, 'a, b, c')).toEqual({
      a: 'desc a',
      b: 'desc b',
      c: '',
    });
  });

  it('drops keys that are no longer in the comma list', () => {
    const existing = { a: 'desc a', b: 'desc b', c: 'desc c' };
    expect(mergeOutputsFromKeys(existing, 'a, b')).toEqual({
      a: 'desc a',
      b: 'desc b',
    });
  });

  it('handles whitespace and empty entries', () => {
    expect(mergeOutputsFromKeys({}, '  a ,  ,b , ')).toEqual({ a: '', b: '' });
  });

  it('migrates a legacy array spec to object form', () => {
    const legacy = ['foo', 'bar'];
    expect(mergeOutputsFromKeys(legacy, 'foo, bar, baz')).toEqual({
      foo: '',
      bar: '',
      baz: '',
    });
  });

  it('returns {} when the comma list is empty', () => {
    expect(mergeOutputsFromKeys({ a: 'x' }, '')).toEqual({});
  });
});
