import { describe, expect, it } from 'vitest';
import { buildDisplayHealthChecks } from './OnboardingHealthPage';

describe('buildDisplayHealthChecks', () => {
  it('collapses CLI and authentication checks into the six prototype rows', () => {
    const checks = [
      { id: 'node', label: 'Node.js', required: true, status: 'pass' as const, detail: 'Ready' },
      { id: 'npm', label: 'npm', required: true, status: 'pass' as const, detail: 'Ready' },
      { id: 'mongodb', label: 'MongoDB', required: true, status: 'pass' as const, detail: 'Ready' },
      { id: 'git', label: 'Git', required: true, status: 'pass' as const, detail: 'Ready' },
      { id: 'claude_cli', label: 'Claude Code CLI', required: false, status: 'pass' as const, detail: 'Installed' },
      { id: 'claude_auth', label: 'Claude Code', required: false, status: 'pass' as const, detail: 'Signed in' },
      { id: 'codex_cli', label: 'Codex CLI', required: false, status: 'pass' as const, detail: 'Installed' },
      {
        id: 'codex_auth',
        label: 'Codex',
        required: false,
        status: 'warn' as const,
        detail: 'Not signed in',
        fix: { summary: 'Authenticate', commands: ['codex login'] },
      },
    ];

    const display = buildDisplayHealthChecks(checks);

    expect(display).toHaveLength(6);
    expect(display.map(check => check.id)).toEqual([
      'node',
      'npm',
      'mongodb',
      'git',
      'claude_provider',
      'codex_provider',
    ]);
    expect(display[4]).toMatchObject({ status: 'pass', version: 'signed in' });
    expect(display[5]).toMatchObject({
      status: 'warn',
      version: 'installed · not signed in',
      fix: { commands: ['codex login'] },
    });
  });
});
