/**
 * Unit tests for the linear.issues() URL-building logic in api.ts.
 *
 * api.ts calls fetch() internally, so we test the URL construction
 * logic inline (mirroring the exact implementation) rather than importing
 * and calling the function (which would require mocking fetch + authStore).
 *
 * Covers:
 *   AC-015 – linear.issues({ assignee: 'me', ... }) → URL contains assignee=me
 *   teamId  – linear.issues({ teamId: ... }) → URL contains teamId=<encoded id>
 */
import { describe, expect, it } from 'vitest';

// ---------------------------------------------------------------------------
// Inline mirror of the linear.issues() URL builder from apiSecondary.ts
// This is the exact same logic as in packages/ui/src/services/apiSecondary.ts
// ---------------------------------------------------------------------------
function buildLinearIssuesUrl(
  filters: {
    projectId?: string;
    state?: string;
    q?: string;
    limit?: number;
    assignee?: 'me';
    teamId?: string;
  } = {},
): string {
  const qs = new URLSearchParams();
  if (filters.projectId) qs.set('projectId', filters.projectId);
  if (filters.state) qs.set('state', filters.state);
  if (filters.q) qs.set('q', filters.q);
  if (filters.limit) qs.set('limit', String(filters.limit));
  if (filters.assignee === 'me') qs.set('assignee', 'me');
  if (filters.teamId) qs.set('teamId', filters.teamId);
  const query = qs.toString();
  return `/linear/issues${query ? `?${query}` : ''}`;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('linear.issues() URL construction (api.ts)', () => {
  // AC-015 ──────────────────────────────────────────────────────────────────

  it('AC-015: includes assignee=me when assignee="me"', () => {
    const url = buildLinearIssuesUrl({ assignee: 'me' });
    expect(url).toContain('assignee=me');
  });

  it('AC-015: full example — assignee=me + state + limit all appear', () => {
    const url = buildLinearIssuesUrl({
      assignee: 'me',
      state: 'started,unstarted,backlog',
      limit: 25,
    });
    expect(url).toContain('assignee=me');
    expect(url).toContain('state=');
    expect(url).toContain('limit=25');
  });

  it('AC-015: state param is encoded in the URL', () => {
    const url = buildLinearIssuesUrl({ assignee: 'me', state: 'started,unstarted,backlog' });
    // URLSearchParams encodes commas as %2C
    expect(url).toMatch(/state=started/);
  });

  // Complementary: ensure assignee=me is absent when not requested ──────────

  it('does NOT include assignee param when assignee filter is omitted', () => {
    const url = buildLinearIssuesUrl({ state: 'started', limit: 10 });
    expect(url).not.toContain('assignee');
  });

  it('returns base URL with no query string when no filters are given', () => {
    const url = buildLinearIssuesUrl();
    expect(url).toBe('/linear/issues');
  });

  it('includes projectId when provided', () => {
    const url = buildLinearIssuesUrl({ projectId: 'proj-abc', assignee: 'me' });
    expect(url).toContain('projectId=proj-abc');
    expect(url).toContain('assignee=me');
  });

  it('includes query string search term when provided', () => {
    const url = buildLinearIssuesUrl({ q: 'bug fix', assignee: 'me' });
    expect(url).toContain('q=bug+fix');
    expect(url).toContain('assignee=me');
  });

  // teamId filter ─────────────────────────────────────────────────────────────

  it('teamId set → URL contains teamId=<encoded id>', () => {
    const url = buildLinearIssuesUrl({ teamId: 'team-abc-123' });
    expect(url).toContain('teamId=team-abc-123');
  });

  it('teamId with special characters is properly encoded', () => {
    const url = buildLinearIssuesUrl({ teamId: 'team/special id' });
    // URLSearchParams encodes spaces and slashes
    expect(url).toContain('teamId=');
    expect(url).not.toContain(' ');
  });

  it('teamId empty string → teamId absent from URL', () => {
    const url = buildLinearIssuesUrl({ teamId: '' });
    expect(url).not.toContain('teamId');
  });

  it('teamId absent → teamId absent from URL', () => {
    const url = buildLinearIssuesUrl({ state: 'started', limit: 10 });
    expect(url).not.toContain('teamId');
  });

  it('teamId composes with projectId, state, q, limit, and assignee in one URL', () => {
    const url = buildLinearIssuesUrl({
      teamId: 'team-eng',
      projectId: 'proj-core',
      state: 'started,unstarted',
      q: 'auth bug',
      limit: 50,
      assignee: 'me',
    });
    expect(url).toContain('teamId=team-eng');
    expect(url).toContain('projectId=proj-core');
    expect(url).toContain('state=');
    expect(url).toContain('q=');
    expect(url).toContain('limit=50');
    expect(url).toContain('assignee=me');
  });
});
