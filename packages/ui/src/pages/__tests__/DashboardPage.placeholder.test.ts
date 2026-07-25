import { describe, expect, it } from 'vitest';
import { HOME_V8_RECENT_ROWS, homeComposerPlaceholder } from '../DashboardPage';

describe('homeComposerPlaceholder', () => {
  it('adapts suggestions to the selected repository or agent context', () => {
    expect(homeComposerPlaceholder({ name: 'inomy-marketing', path: '/repo' })).toContain('campaign');
    expect(homeComposerPlaceholder({ name: 'ui-designs', path: '/repo' })).toContain('audit a screen');
    expect(homeComposerPlaceholder({ name: 'es-data-pipeline', path: '/repo' })).toContain('pipeline');
  });

  it('keeps the v8 prototype Recent rows in order', () => {
    expect(HOME_V8_RECENT_ROWS.map((row) => row.title)).toEqual([
      'Fix flaky workspace-terminal e2e spec',
      'Draft launch-week announcement and social posts',
      'Investigate context-graph refresh stall during cognification',
      'Fix chat auto-titles & open a PR',
      'July 4 deals rail — storefront',
      'ALL-13 · Agent Template Gallery PRD',
    ]);
    expect(HOME_V8_RECENT_ROWS.map((row) => row.team)).toEqual(['eng', 'mkt', 'eng', 'eng', 'eng', 'prod']);
    expect(HOME_V8_RECENT_ROWS.map((row) => row.time)).toEqual(['12m', '4m', '32m', '2h', '5h', '1d']);
  });
});
