import { describe, expect, it } from 'vitest';
import { computePackageChecksum, verifyPackageChecksum, canonicalizeForChecksum } from './package-checksum.js';

describe('canonicalizeForChecksum', () => {
  it('sorts object keys lexicographically', () => {
    const result = canonicalizeForChecksum({ z: 1, a: 2, m: 3 }) as Record<string, unknown>;
    expect(Object.keys(result)).toEqual(['a', 'm', 'z']);
  });

  it('drops undefined values', () => {
    const result = canonicalizeForChecksum({ a: undefined, b: 1 }) as Record<string, unknown>;
    expect('a' in result).toBe(false);
    expect(result.b).toBe(1);
  });

  it('keeps arrays in order', () => {
    const result = canonicalizeForChecksum([3, 1, 2]);
    expect(result).toEqual([3, 1, 2]);
  });
});

describe('computePackageChecksum', () => {
  it('produces a deterministic hex string', () => {
    const pkg = { kind: 'allen.repo-context-package', schemaVersion: 1, manifest: { contentSha256: '' }, curatedEntries: [], mandatoryMappings: [] };
    const digest = computePackageChecksum(pkg as Record<string, unknown>);
    expect(typeof digest).toBe('string');
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is stable across key ordering', () => {
    const pkg1 = { z: 'z', a: 'a', manifest: { contentSha256: '' } } as Record<string, unknown>;
    const pkg2 = { a: 'a', z: 'z', manifest: { contentSha256: '' } } as Record<string, unknown>;
    expect(computePackageChecksum(pkg1)).toBe(computePackageChecksum(pkg2));
  });

  it('excludes manifest.contentSha256 from the hash', () => {
    const pkg = { kind: 'test', manifest: { contentSha256: 'old-value' } } as Record<string, unknown>;
    const digest = computePackageChecksum(pkg);
    // Reset to empty and recompute — should be same
    (pkg.manifest as Record<string, unknown>).contentSha256 = 'another-old-value';
    const digest2 = computePackageChecksum(pkg);
    expect(digest).toBe(digest2);
  });

  it('writes the digest into pkg.manifest.contentSha256', () => {
    const pkg = { kind: 'test', manifest: { contentSha256: '' } } as Record<string, unknown>;
    const digest = computePackageChecksum(pkg);
    expect((pkg.manifest as Record<string, unknown>).contentSha256).toBe(digest);
  });
});

describe('verifyPackageChecksum', () => {
  it('returns true for a correctly checksummed package', () => {
    const pkg = { kind: 'test', manifest: { contentSha256: '' } } as Record<string, unknown>;
    computePackageChecksum(pkg);
    expect(verifyPackageChecksum(pkg)).toBe(true);
  });

  it('returns false for a tampered package', () => {
    const pkg = { kind: 'test', manifest: { contentSha256: '' } } as Record<string, unknown>;
    computePackageChecksum(pkg);
    (pkg as Record<string, unknown>).kind = 'tampered';
    expect(verifyPackageChecksum(pkg)).toBe(false);
  });
});
