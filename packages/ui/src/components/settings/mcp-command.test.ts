import { describe, it, expect } from 'vitest';
import { commandForExtension, commandForCandidate } from './mcp-command';

describe('commandForExtension', () => {
  it('returns python3 for .py', () => expect(commandForExtension('server.py')).toBe('python3'));
  it('returns python3 for .PY (case-insensitive)', () => expect(commandForExtension('server.PY')).toBe('python3'));
  it('returns npx tsx for .ts', () => expect(commandForExtension('server.ts')).toBe('npx tsx'));
  it('returns npx tsx for .tsx', () => expect(commandForExtension('server.tsx')).toBe('npx tsx'));
  it('returns node for .js', () => expect(commandForExtension('server.js')).toBe('node'));
  it('returns node for .mjs', () => expect(commandForExtension('server.mjs')).toBe('node'));
  it('returns node for .cjs', () => expect(commandForExtension('server.cjs')).toBe('node'));
  it('returns node for empty path (default fallback)', () => expect(commandForExtension('')).toBe('node'));
  it('handles full path with .py', () => expect(commandForExtension('/a/b/c/server.py')).toBe('python3'));
});

describe('commandForCandidate', () => {
  it('returns python3 for python candidate without repoRelative', () => {
    expect(commandForCandidate({ detectedLanguage: 'python' })).toBe('python3');
  });
  it('returns python3 for python candidate with repoRelative', () => {
    expect(commandForCandidate({ detectedLanguage: 'python', repoRelative: 'server.py' })).toBe('python3');
  });
  it('returns npx tsx for node candidate with .ts repoRelative', () => {
    expect(commandForCandidate({ detectedLanguage: 'node', repoRelative: 'server.ts' })).toBe('npx tsx');
  });
  it('returns npx tsx for node candidate with .tsx repoRelative', () => {
    expect(commandForCandidate({ detectedLanguage: 'node', repoRelative: 'server.tsx' })).toBe('npx tsx');
  });
  it('returns node for node candidate with .mjs repoRelative', () => {
    expect(commandForCandidate({ detectedLanguage: 'node', repoRelative: 'server.mjs' })).toBe('node');
  });
  it('returns node for node candidate without repoRelative', () => {
    expect(commandForCandidate({ detectedLanguage: 'node' })).toBe('node');
  });
});
