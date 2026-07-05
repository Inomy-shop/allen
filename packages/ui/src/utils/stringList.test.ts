import { describe, expect, it } from 'vitest';
import { normalizeStringList, stringListIncludes } from './stringList';

describe('normalizeStringList', () => {
  it('keeps string arrays and drops invalid entries', () => {
    expect(normalizeStringList([' frontend ', '', 42, null, 'qa'])).toEqual(['frontend', 'qa']);
  });

  it('supports legacy comma or newline separated strings', () => {
    expect(normalizeStringList('frontend, qa\nreview')).toEqual(['frontend', 'qa', 'review']);
  });

  it('treats objects and missing values as empty lists', () => {
    expect(normalizeStringList({ some: 'object' })).toEqual([]);
    expect(normalizeStringList(undefined)).toEqual([]);
  });
});

describe('stringListIncludes', () => {
  it('searches arrays, strings, and ignores malformed values without throwing', () => {
    expect(stringListIncludes(['Root-Cause'], 'root')).toBe(true);
    expect(stringListIncludes('frontend, qa', 'qa')).toBe(true);
    expect(stringListIncludes({ unexpected: true }, 'qa')).toBe(false);
  });
});
