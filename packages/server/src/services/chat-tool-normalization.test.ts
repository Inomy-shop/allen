import { describe, expect, it } from 'vitest';
import { codexFileChanges, mergeToolArguments, parseClaudeToolResult } from './chat-tool-normalization.js';

describe('chat tool provider normalization', () => {
  it('upgrades Claude streaming tool starts with the completed source arguments', () => {
    const merged = mergeToolArguments({}, {
      file_path: 'src/runtime.ts',
      old_string: 'const state = false;\n',
      new_string: 'const state = true;\n',
    });

    expect(merged.changed).toBe(true);
    expect(merged.args).toMatchObject({
      file_path: 'src/runtime.ts',
      old_string: 'const state = false;\n',
      new_string: 'const state = true;\n',
    });
  });

  it('preserves Claude array text results instead of coercing them to object strings', () => {
    expect(parseClaudeToolResult([{ type: 'text', text: '1\tconst ready = true;\n' }])).toEqual({
      raw: '1\tconst ready = true;\n',
    });
    expect(parseClaudeToolResult([{ type: 'text', text: '{"status":"ok"}' }])).toEqual({ status: 'ok' });
    expect(parseClaudeToolResult({ type: 'text', text: 'command output' })).toEqual({ raw: 'command output' });
  });

  it('normalizes Codex fileChange items with their exact per-file diffs', () => {
    expect(codexFileChanges({
      changes: [
        { path: 'src/a.ts', kind: { type: 'update' }, diff: '--- a/src/a.ts\n+++ b/src/a.ts\n@@\n-old\n+new' },
        { path: 'src/b.ts', kind: { type: 'move', move_path: 'src/c.ts' }, diff: 'similarity index 100%' },
      ],
    })).toEqual([
      { path: 'src/a.ts', status: 'update', diff: '--- a/src/a.ts\n+++ b/src/a.ts\n@@\n-old\n+new' },
      { path: 'src/b.ts', status: 'move', movePath: 'src/c.ts', diff: 'similarity index 100%' },
    ]);
  });
});
