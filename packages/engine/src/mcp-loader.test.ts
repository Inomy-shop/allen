import { describe, it, expect } from 'vitest';
import { inferCommand } from './mcp-loader';

describe('inferCommand', () => {
  it('returns python3 for .py files (REQ-005, AC-006)', () => {
    expect(inferCommand('/path/to/server.py')).toEqual({ command: 'python3', leadingArgs: [] });
  });

  it('returns python3 for .PY files (case-insensitive)', () => {
    expect(inferCommand('/path/to/Server.PY')).toEqual({ command: 'python3', leadingArgs: [] });
  });

  it('returns npx tsx for .ts files (AC-022 regression)', () => {
    expect(inferCommand('/path/to/server.ts')).toEqual({ command: 'npx', leadingArgs: ['tsx'] });
  });

  it('returns npx tsx for .tsx files (AC-022 regression)', () => {
    expect(inferCommand('/path/to/server.tsx')).toEqual({ command: 'npx', leadingArgs: ['tsx'] });
  });

  it('returns node for .js files (AC-022 regression)', () => {
    expect(inferCommand('/path/to/server.js')).toEqual({ command: 'node', leadingArgs: [] });
  });

  it('returns node for .mjs files (AC-022 regression)', () => {
    expect(inferCommand('/path/to/server.mjs')).toEqual({ command: 'node', leadingArgs: [] });
  });

  it('returns node for .cjs files (AC-022 regression)', () => {
    expect(inferCommand('/path/to/server.cjs')).toEqual({ command: 'node', leadingArgs: [] });
  });
});
