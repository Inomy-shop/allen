import { describe, expect, it } from 'vitest';
import { homeComposerPlaceholder } from '../DashboardPage';

describe('homeComposerPlaceholder', () => {
  it('adapts suggestions to the selected repository or agent context', () => {
    expect(homeComposerPlaceholder({ name: 'inomy-marketing', path: '/repo' })).toContain('campaign');
    expect(homeComposerPlaceholder({ name: 'ui-designs', path: '/repo' })).toContain('audit a screen');
    expect(homeComposerPlaceholder({ name: 'es-data-pipeline', path: '/repo' })).toContain('pipeline');
  });
});
