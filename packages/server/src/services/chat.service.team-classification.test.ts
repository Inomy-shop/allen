import { describe, expect, it } from 'vitest';
import { inferLegacyTeamClassification } from './chat.service.js';

describe('inferLegacyTeamClassification', () => {
  it('inherits an agent team when legacy sessions have no explicit classification', () => {
    expect(inferLegacyTeamClassification({
      title: 'Prepare launch material',
      activeAgent: 'growth-writer',
    } as any, 'Marketing team')).toBe('marketing');
  });

  it('classifies repository-backed implementation sessions as engineering', () => {
    expect(inferLegacyTeamClassification({
      title: 'Investigate the issue',
      repoId: 'repo-1',
    } as any)).toBe('engineering');
  });

  it('leaves genuinely context-free sessions unassigned', () => {
    expect(inferLegacyTeamClassification({ title: 'Hello' } as any)).toBeNull();
  });
});
