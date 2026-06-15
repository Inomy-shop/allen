/**
 * Tests for the WatcherStatusLines component.
 *
 * Renders per-execution watcher lines. Each line is non-clickable, shows
 * "last checked" relative time, renders the correct icon per status, and
 * updates in-place when updateSeq changes.
 *
 * Render strategy: React 18 createRoot + act (same as MentionAutocomplete tests).
 * jsdom stub: Element.prototype.scrollIntoView (if not already defined).
 */

import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WatcherStatusLines, WatcherStatusLine } from '../WatcherStatusLines';
import type { WatcherUIDoc, WatcherExecutionState } from '../../../services/api';

// Stub scrollIntoView if jsdom hasn't defined it
if (typeof Element.prototype.scrollIntoView === 'undefined') {
  Element.prototype.scrollIntoView = () => {};
}

let container: HTMLElement;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  document.body.removeChild(container);
  vi.clearAllMocks();
});

function render(jsx: React.ReactElement) {
  const root = createRoot(container);
  act(() => { root.render(jsx); });
  return root;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeWatcher(
  overrides: Partial<WatcherUIDoc> & { executionId: string },
): WatcherUIDoc {
  return {
    watcherId: `w-${overrides.executionId}`,
    executionType: 'workflow',
    watcherStatus: 'active',
    executionState: 'running',
    triggerSentForState: null,
    latestStatusText: 'Workflow is running',
    lastCheckedAt: new Date().toISOString(),
    updateSeq: 1,
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('WatcherStatusLines', () => {
  it('renders nothing when watchers is empty', () => {
    render(<WatcherStatusLines watchers={[]} />);
    expect(container.textContent).toBeFalsy();
  });

  it('renders one line per watcher', () => {
    const watchers = [
      makeWatcher({ executionId: 'exec-1', latestStatusText: 'First workflow running' }),
      makeWatcher({ executionId: 'exec-2', latestStatusText: 'Second agent running' }),
    ];
    render(<WatcherStatusLines watchers={watchers} />);
    expect(container.textContent).toContain('First workflow running');
    expect(container.textContent).toContain('Second agent running');
    expect(container.textContent).toContain('checked');
  });

  it('lines are non-clickable (no onClick handler, no button role)', () => {
    const watchers = [
      makeWatcher({ executionId: 'exec-1', latestStatusText: 'Workflow running' }),
    ];
    render(<WatcherStatusLines watchers={watchers} />);
    // There should be no <button> element or role="button"
    const buttons = container.querySelectorAll('button');
    expect(buttons.length).toBe(0);
    const buttonRoles = container.querySelectorAll('[role="button"]');
    expect(buttonRoles.length).toBe(0);
  });

  it('shows checked relative time', () => {
    // Use a recent timestamp so timeAgo returns "just now"
    const watchers = [
      makeWatcher({
        executionId: 'exec-1',
        lastCheckedAt: new Date().toISOString(),
      }),
    ];
    render(<WatcherStatusLines watchers={watchers} />);
    expect(container.textContent).toContain('checked');
  });

  it('renders correct icon for running state', () => {
    const watchers = [
      makeWatcher({ executionId: 'exec-1', executionState: 'running' }),
    ];
    render(<WatcherStatusLines watchers={watchers} />);
    // Loader2 spin icon: rendered as SVG
    const svgs = container.querySelectorAll('svg');
    expect(svgs.length).toBeGreaterThanOrEqual(1);
  });

  it('does not render completed watchers in the monitoring list', () => {
    const watchers = [
      makeWatcher({ executionId: 'exec-1', executionState: 'completed' }),
    ];
    render(<WatcherStatusLines watchers={watchers} />);
    expect(container.textContent).toBeFalsy();
  });

  it('does not render failed watchers in the monitoring list', () => {
    const watchers = [
      makeWatcher({ executionId: 'exec-1', executionState: 'failed' }),
    ];
    render(<WatcherStatusLines watchers={watchers} />);
    expect(container.textContent).toBeFalsy();
  });

  it('does not render cancelled watchers in the monitoring list', () => {
    const watchers = [
      makeWatcher({ executionId: 'exec-1', executionState: 'cancelled' }),
    ];
    render(<WatcherStatusLines watchers={watchers} />);
    expect(container.textContent).toBeFalsy();
  });

  it('renders correct icon for waiting_for_input state', () => {
    const watchers = [
      makeWatcher({ executionId: 'exec-1', executionState: 'waiting_for_input' }),
    ];
    render(<WatcherStatusLines watchers={watchers} />);
    const svgs = container.querySelectorAll('svg');
    expect(svgs.length).toBeGreaterThanOrEqual(1);
  });

  it('hides watchers while the assistant is streaming', () => {
    const watchers = [
      makeWatcher({ executionId: 'exec-1', latestStatusText: 'Workflow running' }),
    ];
    render(<WatcherStatusLines watchers={watchers} assistantStreaming />);
    expect(container.textContent).toBeFalsy();
  });

  it('hides waiting_for_input after the watcher trigger has been sent', () => {
    const watchers = [
      makeWatcher({
        executionId: 'exec-1',
        executionState: 'waiting_for_input',
        triggerSentForState: 'waiting_for_input',
      }),
    ];
    render(<WatcherStatusLines watchers={watchers} />);
    expect(container.textContent).toBeFalsy();
  });

  it('updates in place when updateSeq changes (key stability test)', () => {
    // Render two watchers then re-render with different content for the same executionId
    const w1 = makeWatcher({ executionId: 'exec-1', latestStatusText: 'Version 1', updateSeq: 1 });
    const w2 = makeWatcher({ executionId: 'exec-1', latestStatusText: 'Version 2', updateSeq: 2 });
    const wOther = makeWatcher({ executionId: 'exec-2', latestStatusText: 'Other watcher', updateSeq: 1 });

    const root = render(<WatcherStatusLines watchers={[w1, wOther]} />);
    expect(container.textContent).toContain('Version 1');
    expect(container.textContent).toContain('Other watcher');

    // Re-render with updated w2 (same executionId, higher updateSeq)
    act(() => { root.render(<WatcherStatusLines watchers={[w2, wOther]} />); });
    expect(container.textContent).toContain('Version 2');
    // Should still only have two watcher lines
    const lines = container.querySelectorAll('.watcher-status-message');
    expect(lines.length).toBe(2);
    const version1Count = container.textContent!.match(/Version 1/g)?.length ?? 0;
    const version2Count = container.textContent!.match(/Version 2/g)?.length ?? 0;
    expect(version1Count).toBe(0);
    expect(version2Count).toBe(1);
  });
});

describe('WatcherStatusLine', () => {
  it('renders a single status line', () => {
    const watcher = makeWatcher({ executionId: 'exec-1', latestStatusText: 'Single line test' });
    render(<WatcherStatusLine watcher={watcher} />);
    expect(container.textContent).toContain('Single line test');
    expect(container.textContent).toContain('checked');
  });

  it('is non-interactive (no button or clickable role)', () => {
    const watcher = makeWatcher({ executionId: 'exec-1' });
    render(<WatcherStatusLine watcher={watcher} />);
    const buttons = container.querySelectorAll('button');
    expect(buttons.length).toBe(0);
    const clickableRoles = container.querySelectorAll('[role="button"], [role="link"]');
    expect(clickableRoles.length).toBe(0);
  });

  it('shows correct "last checked" text for just-now timestamps', () => {
    const watcher = makeWatcher({
      executionId: 'exec-1',
      lastCheckedAt: new Date().toISOString(),
    });
    render(<WatcherStatusLine watcher={watcher} />);
    expect(container.textContent).toContain('just now');
  });
});
