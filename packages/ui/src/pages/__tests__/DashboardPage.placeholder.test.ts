import { describe, expect, it } from 'vitest';
import {
  dashboardPrStatusLabel,
  dashboardSessionTeamKey,
  dashboardSessionHref,
  dashboardTeamLabel,
  homeComposerPlaceholder,
  selectDashboardRecentRows,
} from '../DashboardPage';

describe('homeComposerPlaceholder', () => {
  it('adapts suggestions to the selected repository or agent context', () => {
    expect(homeComposerPlaceholder({ name: 'inomy-marketing', path: '/repo' })).toContain('campaign');
    expect(homeComposerPlaceholder({ name: 'ui-designs', path: '/repo' })).toContain('audit a screen');
    expect(homeComposerPlaceholder({ name: 'es-data-pipeline', path: '/repo' })).toContain('pipeline');
  });

  it('builds Recent rows from actual conversations in activity order', () => {
    const rows = selectDashboardRecentRows(
      [{
        id: 'running-session',
        title: 'Running conversation',
        sub: 'streaming',
        href: '/chat/running-session',
        timestamp: '2026-07-26T10:00:00Z',
      }],
      [{
        id: 'recent-session',
        title: 'Most recent conversation',
        sub: '4 messages',
        href: '/chat/recent-session',
        timestamp: '2026-07-26T11:00:00Z',
      }],
    );

    expect(rows.map((row) => row.title)).toEqual([
      'Most recent conversation',
      'Running conversation',
    ]);
    expect(rows.map((row) => row.activityState)).toEqual(['recent', 'running']);
    expect(rows.map((row) => row.href)).toEqual([
      '/chat/recent-session',
      '/chat/running-session',
    ]);
  });

  it('routes normal and Studio conversations to their actual session', () => {
    expect(dashboardSessionHref('chat-1')).toBe('/chat/chat-1');
    expect(dashboardSessionHref('design-1', 'workspace/design 1')).toBe(
      '/studio/sessions/design-1?ws=workspace%2Fdesign%201',
    );
  });

  it('uses compact team labels from live agent team metadata', () => {
    expect(dashboardTeamLabel('Engineering team')).toBe('eng');
    expect(dashboardTeamLabel('Product team')).toBe('prod');
    expect(dashboardTeamLabel('Quality team')).toBe('qa');
    expect(dashboardTeamLabel('Customer Success')).toBe('customer-success');
  });

  it('uses the same session classification and Studio fallback as the Sessions page', () => {
    expect(dashboardSessionTeamKey({ teamClassification: 'engineering' })).toBe('engineering');
    expect(dashboardSessionTeamKey({ teamClassification: 'marketing' })).toBe('marketing');
    expect(dashboardSessionTeamKey({ teamClassification: null, studioWorkspaceId: 'studio-1' })).toBe('design');
    expect(dashboardSessionTeamKey({ teamClassification: null })).toBe('unknown');
  });

  it('uses the prototype pull-request wording without extra PR metadata', () => {
    expect(dashboardPrStatusLabel('open')).toBe('PR opened');
    expect(dashboardPrStatusLabel('merged')).toBe('PR merged');
    expect(dashboardPrStatusLabel('closed')).toBe('PR closed');
  });
});
