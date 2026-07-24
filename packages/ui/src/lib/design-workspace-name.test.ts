import { describe, expect, it } from 'vitest';
import { designWorkspaceDisplayName, isImportedDesignWorkspace } from './design-workspace-name';

describe('design workspace names', () => {
  it('keeps import state out of the title', () => {
    expect(designWorkspaceDisplayName('Intents Protocol (imported)')).toBe('Intents Protocol');
    expect(isImportedDesignWorkspace({ name: 'Intents Protocol (imported)' })).toBe(true);
  });

  it('recognizes imported workspaces from provenance', () => {
    expect(isImportedDesignWorkspace({
      name: 'Intents Protocol',
      greenfieldBrief: {
        product: '',
        audience: '',
        feel: '',
        references: 'workspace:source-id',
        screens: '',
      },
    })).toBe(true);
  });

  it('turns generated workspace slugs into human titles while retaining the raw value separately', () => {
    expect(designWorkspaceDisplayName('fix/ui-audit-ti2uz4')).toBe('UI audit');
    expect(designWorkspaceDisplayName('feature/payment-retry')).toBe('Payment retry');
  });

  it('uses the explicit imported field without requiring a name suffix', () => {
    expect(isImportedDesignWorkspace({ name: 'Intents Protocol', imported: true })).toBe(true);
  });
});
