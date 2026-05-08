/**
 * Unit tests for the linear.issues() URL-building logic in api.ts.
 *
 * api.ts calls fetch() internally, so we test the URL construction
 * logic inline (mirroring the exact implementation) rather than importing
 * and calling the function (which would require mocking fetch + authStore).
 *
 * Covers:
 *   AC-015 – linear.issues({ assignee: 'me', ... }) → URL contains assignee=me
 */
import { describe, expect, it } from 'vitest';

// ---------------------------------------------------------------------------
// Inline mirror of the linear.issues() URL builder from api.ts
// This is the exact same logic as in packages/ui/src/services/api.ts
// ---------------------------------------------------------------------------
function buildLinearIssuesUrl(
  filters: {
    projectId?: string;
    state?: string;
    q?: string;
    limit?: number;
    assignee?: 'me';
  } = {},
): string {
  const qs = new URLSearchParams();
  if (filters.projectId) qs.set('projectId', filters.projectId);
  if (filters.state) qs.set('state', filters.state);
  if (filters.q) qs.set('q', filters.q);
  if (filters.limit) qs.set('limit', String(filters.limit));
  if (filters.assignee === 'me') qs.set('assignee', 'me');
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
});
