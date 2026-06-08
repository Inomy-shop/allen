import { describe, expect, it } from 'vitest';
import { workspaceCreateBaseBranch } from './workspace-create';

describe('workspaceCreateBaseBranch', () => {
  it('uses the saved detected default branch from cloned repos', () => {
    expect(workspaceCreateBaseBranch({ detected: { defaultBranch: 'development' } })).toBe('development');
  });

  it('falls back through repo defaults before main', () => {
    expect(workspaceCreateBaseBranch({ defaultBranch: 'release' })).toBe('release');
    expect(workspaceCreateBaseBranch({ branch: 'dev' })).toBe('dev');
    expect(workspaceCreateBaseBranch({})).toBe('main');
  });

  it('ignores blank branch metadata', () => {
    expect(workspaceCreateBaseBranch({
      detected: { defaultBranch: '  ' },
      defaultBranch: '',
      branch: 'stable',
    })).toBe('stable');
  });
});
