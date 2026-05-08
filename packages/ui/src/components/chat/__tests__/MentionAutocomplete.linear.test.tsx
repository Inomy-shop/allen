/**
 * Unit tests for the MentionAutocomplete component in linear mode.
 *
 * @testing-library/react is not in the project's devDependencies; React
 * components are rendered via React 18's createRoot + act from react-dom.
 * Helper functions (priorityDotClass) are tested directly.
 *
 * Covers:
 *   AC-007  – mode='linear' + linearLoading=true → "Loading Linear tickets" text,
 *             no "Linear Tickets" header
 *   AC-008  – mode='linear' + issues provided → each issue's identifier is rendered
 *   AC-010  – mode='linear' + linearError='empty' → "No active tickets assigned to you"
 *             text, no "Linear Tickets" header
 *   AC-011  – mode='linear' + linearError='unconfigured' → "Linear is not configured"
 *   AC-012  – mode='linear' + linearError='error' → "Failed to load tickets"
 *   AC-016  – priorityDotClass(0) → bg-gray-300, priorityDotClass(1) → bg-red-500, etc.
 */

import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import MentionAutocomplete, { priorityDotClass } from '../MentionAutocomplete';
import type { LinearIssueSummary } from '../../../services/api';
import type { MentionOption } from '../MentionAutocomplete';

// ---------------------------------------------------------------------------
// Mock ../../services/api so the component's default-mode useEffect doesn't
// make real HTTP calls. In linear mode the effect returns early, but we mock
// anyway to be safe.
// ---------------------------------------------------------------------------
vi.mock('../../../services/api', () => ({
  workflows: { list: vi.fn().mockResolvedValue([]) },
  repos: { list: vi.fn().mockResolvedValue([]) },
  agents: { list: vi.fn().mockResolvedValue([]) },
}));

// ---------------------------------------------------------------------------
// jsdom stubs — jsdom does not implement scrollIntoView; the component calls
// it inside a useEffect so we must stub it to avoid uncaught TypeErrors.
// ---------------------------------------------------------------------------
if (typeof Element.prototype.scrollIntoView === 'undefined') {
  Element.prototype.scrollIntoView = () => {};
}

// ---------------------------------------------------------------------------
// Rendering helpers (React 18 createRoot + act)
// ---------------------------------------------------------------------------

let container: HTMLElement;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  act(() => {
    // Unmount any root that was created in the test
    const root = (container as any).__root;
    if (root) root.unmount();
  });
  document.body.removeChild(container);
});

function renderIntoContainer(ui: React.ReactElement): HTMLElement {
  act(() => {
    const root = createRoot(container);
    (container as any).__root = root;
    root.render(ui);
  });
  return container;
}

// Convenience noop callbacks
const noop = () => {};
const noopSelect = (_opt: MentionOption) => {};

// ---------------------------------------------------------------------------
// Minimal issue fixtures
// ---------------------------------------------------------------------------

function makeIssue(
  overrides: Partial<LinearIssueSummary> = {},
): LinearIssueSummary {
  return {
    id: 'issue-1',
    identifier: 'ENG-1',
    title: 'Fix the bug',
    url: 'https://linear.app/team/issue/ENG-1',
    priority: 0,
    priorityLabel: 'No priority',
    state: { id: 'state-1', name: 'In Progress', type: 'started', color: '#aabb00' },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// AC-016: priorityDotClass() helper
// ---------------------------------------------------------------------------

describe('AC-016: priorityDotClass(priority)', () => {
  it('priority 0 (No priority) → bg-gray-300', () => {
    expect(priorityDotClass(0)).toContain('bg-gray-300');
  });

  it('priority 1 (Urgent) → bg-red-500', () => {
    expect(priorityDotClass(1)).toBe('bg-red-500');
  });

  it('priority 2 (High) → bg-orange-500', () => {
    expect(priorityDotClass(2)).toBe('bg-orange-500');
  });

  it('priority 3 (Medium) → bg-yellow-500', () => {
    expect(priorityDotClass(3)).toBe('bg-yellow-500');
  });

  it('priority 4 (Low) → bg-blue-400', () => {
    expect(priorityDotClass(4)).toBe('bg-blue-400');
  });

  it('unknown priority (e.g. 99) → default bg-gray-300 class', () => {
    expect(priorityDotClass(99)).toContain('bg-gray-300');
  });
});

// ---------------------------------------------------------------------------
// Rendering tests — linear mode
// ---------------------------------------------------------------------------

describe('MentionAutocomplete in linear mode (rendering)', () => {
  // ── AC-007 ────────────────────────────────────────────────────────────────

  describe('AC-007: linearLoading=true', () => {
    it('shows "Loading Linear tickets" text', () => {
      renderIntoContainer(
        <MentionAutocomplete
          query=""
          visible={true}
          onSelect={noopSelect}
          onDismiss={noop}
          mode="linear"
          linearLoading={true}
          linearError={null}
          linearIssues={[]}
        />,
      );
      expect(container.textContent).toContain('Loading Linear tickets');
    });

    it('does NOT show the "Linear Tickets" section header while loading', () => {
      renderIntoContainer(
        <MentionAutocomplete
          query=""
          visible={true}
          onSelect={noopSelect}
          onDismiss={noop}
          mode="linear"
          linearLoading={true}
          linearError={null}
          linearIssues={[]}
        />,
      );
      expect(container.textContent).not.toContain('Linear Tickets');
    });
  });

  // ── AC-010 ────────────────────────────────────────────────────────────────

  describe('AC-010: linearError="empty"', () => {
    it('shows "No active tickets assigned to you"', () => {
      renderIntoContainer(
        <MentionAutocomplete
          query=""
          visible={true}
          onSelect={noopSelect}
          onDismiss={noop}
          mode="linear"
          linearLoading={false}
          linearError="empty"
          linearIssues={[]}
        />,
      );
      expect(container.textContent).toContain('No active tickets assigned to you');
    });

    it('does NOT show the "Linear Tickets" section header for empty state', () => {
      renderIntoContainer(
        <MentionAutocomplete
          query=""
          visible={true}
          onSelect={noopSelect}
          onDismiss={noop}
          mode="linear"
          linearLoading={false}
          linearError="empty"
          linearIssues={[]}
        />,
      );
      expect(container.textContent).not.toContain('Linear Tickets');
    });
  });

  // ── AC-011 ────────────────────────────────────────────────────────────────

  describe('AC-011: linearError="unconfigured"', () => {
    it('shows "Linear is not configured"', () => {
      renderIntoContainer(
        <MentionAutocomplete
          query=""
          visible={true}
          onSelect={noopSelect}
          onDismiss={noop}
          mode="linear"
          linearLoading={false}
          linearError="unconfigured"
          linearIssues={[]}
        />,
      );
      expect(container.textContent).toContain('Linear is not configured');
    });
  });

  // ── AC-012 ────────────────────────────────────────────────────────────────

  describe('AC-012: linearError="error"', () => {
    it('shows "Failed to load tickets"', () => {
      renderIntoContainer(
        <MentionAutocomplete
          query=""
          visible={true}
          onSelect={noopSelect}
          onDismiss={noop}
          mode="linear"
          linearLoading={false}
          linearError="error"
          linearIssues={[]}
        />,
      );
      expect(container.textContent).toContain('Failed to load tickets');
    });
  });

  // ── AC-008 ────────────────────────────────────────────────────────────────

  describe('AC-008: issues provided → renders each identifier', () => {
    it('renders the identifier of a single issue', () => {
      const issue = makeIssue({ identifier: 'ENG-42' });
      renderIntoContainer(
        <MentionAutocomplete
          query=""
          visible={true}
          onSelect={noopSelect}
          onDismiss={noop}
          mode="linear"
          linearLoading={false}
          linearError={null}
          linearIssues={[issue]}
        />,
      );
      expect(container.textContent).toContain('ENG-42');
    });

    it('renders identifiers for multiple issues', () => {
      const issues = [
        makeIssue({ id: 'i1', identifier: 'ENG-10', title: 'First' }),
        makeIssue({ id: 'i2', identifier: 'ENG-20', title: 'Second' }),
        makeIssue({ id: 'i3', identifier: 'ENG-30', title: 'Third' }),
      ];
      renderIntoContainer(
        <MentionAutocomplete
          query=""
          visible={true}
          onSelect={noopSelect}
          onDismiss={noop}
          mode="linear"
          linearLoading={false}
          linearError={null}
          linearIssues={issues}
        />,
      );
      expect(container.textContent).toContain('ENG-10');
      expect(container.textContent).toContain('ENG-20');
      expect(container.textContent).toContain('ENG-30');
    });

    it('renders the issue title (as description field) alongside the identifier', () => {
      const issue = makeIssue({ identifier: 'ENG-77', title: 'Fix login regression' });
      renderIntoContainer(
        <MentionAutocomplete
          query=""
          visible={true}
          onSelect={noopSelect}
          onDismiss={noop}
          mode="linear"
          linearLoading={false}
          linearError={null}
          linearIssues={[issue]}
        />,
      );
      expect(container.textContent).toContain('Fix login regression');
    });

    it('shows "Linear Tickets" header when issues are loaded without errors', () => {
      const issue = makeIssue();
      renderIntoContainer(
        <MentionAutocomplete
          query=""
          visible={true}
          onSelect={noopSelect}
          onDismiss={noop}
          mode="linear"
          linearLoading={false}
          linearError={null}
          linearIssues={[issue]}
        />,
      );
      expect(container.textContent).toContain('Linear Tickets');
    });
  });

  // ── visible=false → nothing rendered ─────────────────────────────────────

  describe('visible=false', () => {
    it('renders nothing when visible=false', () => {
      renderIntoContainer(
        <MentionAutocomplete
          query=""
          visible={false}
          onSelect={noopSelect}
          onDismiss={noop}
          mode="linear"
          linearLoading={false}
          linearError="empty"
          linearIssues={[]}
        />,
      );
      expect(container.firstChild).toBeNull();
    });
  });
});
