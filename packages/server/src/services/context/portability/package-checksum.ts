import { createHash } from 'node:crypto';

/** Deep-sort all object keys; arrays stay ordered; undefined values dropped. */
export function canonicalizeForChecksum(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeForChecksum);
  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) sorted[key] = canonicalizeForChecksum(v);
    }
    return sorted;
  }
  return value;
}

export function computePackageChecksum(pkg: Record<string, unknown>): string {
  // Clone and set placeholder
  const clone = JSON.parse(JSON.stringify(pkg)) as Record<string, unknown>;
  const manifest = (clone.manifest ?? {}) as Record<string, unknown>;
  manifest.contentSha256 = '';
  clone.manifest = manifest;
  const canonical = JSON.stringify(canonicalizeForChecksum(clone));
  const digest = createHash('sha256').update(canonical, 'utf8').digest('hex');
  // Write back
  const originalManifest = (pkg.manifest ?? {}) as Record<string, unknown>;
  originalManifest.contentSha256 = digest;
  pkg.manifest = originalManifest;
  return digest;
}

export function verifyPackageChecksum(pkg: Record<string, unknown>): boolean {
  const expected = (pkg.manifest as Record<string, unknown> | undefined)?.contentSha256;
  if (typeof expected !== 'string') return false;
  const clone = JSON.parse(JSON.stringify(pkg)) as Record<string, unknown>;
  const manifest = (clone.manifest ?? {}) as Record<string, unknown>;
  manifest.contentSha256 = '';
  clone.manifest = manifest;
  const canonical = JSON.stringify(canonicalizeForChecksum(clone));
  const actual = createHash('sha256').update(canonical, 'utf8').digest('hex');
  return actual === expected;
}
