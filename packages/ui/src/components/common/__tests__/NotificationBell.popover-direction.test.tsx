/**
 * Regression test — NotificationBell popover opens DOWNWARD (not upward).
 *
 * Bug: The portaled dropdown used `bottom: window.innerHeight - rect.bottom`
 * which anchored its BOTTOM edge to the bell's bottom, making the popover
 * grow upward and off-screen when the bell is in the top header.
 *
 * Fix: Changed to `top: rect.bottom + 8` (opens downward, 8px gap below bell)
 * and `right: window.innerWidth - rect.right` (right-aligned to bell).
 *
 * This test would FAIL if the old style were reintroduced:
 *   style={{ left: rect.right + 8, bottom: window.innerHeight - rect.bottom }}
 */

import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import NotificationBell from '../NotificationBell';

// ---------------------------------------------------------------------------
// Mock the alerts API so the component's useEffect doesn't make real HTTP
// calls. The component imports `alerts as api` from `../../services/api`
// (relative to the component); from this test file that resolves to
// `../../../services/api`.
// ---------------------------------------------------------------------------
vi.mock('../../../services/api', () => ({
  alerts: {
    list: vi.fn().mockResolvedValue([]),
    count: vi.fn().mockResolvedValue({ count: 0 }),
    markAllRead: vi.fn().mockResolvedValue(undefined),
    dismiss: vi.fn().mockResolvedValue(undefined),
  },
}));

// ---------------------------------------------------------------------------
// Known geometry used throughout the test.
// Bell sits near the top-right: bottom=50, right=830.
// With the FIX:  top = 50 + 8 = 58px,  right = 1024 - 830 = 194px
// With the BUG:  bottom = 768 - 50 = 718px,  left = 830 + 8 = 838px
// ---------------------------------------------------------------------------
const MOCK_RECT = {
  top: 10,
  left: 800,
  right: 830,
  bottom: 50,
  width: 30,
  height: 40,
  x: 800,
  y: 10,
  toJSON: () => ({}),
} as DOMRect;

const MOCK_INNER_WIDTH = 1024;
const MOCK_INNER_HEIGHT = 768;

// ---------------------------------------------------------------------------
// jsdom stubs
// ---------------------------------------------------------------------------
if (typeof Element.prototype.scrollIntoView === 'undefined') {
  Element.prototype.scrollIntoView = () => {};
}

// ---------------------------------------------------------------------------
// Test setup / teardown
// ---------------------------------------------------------------------------
let container: HTMLElement;
let originalGetBoundingClientRect: () => DOMRect;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);

  // Stub getBoundingClientRect on the button prototype so every button in the
  // rendered tree reports our known geometry.
  originalGetBoundingClientRect = HTMLButtonElement.prototype.getBoundingClientRect;
  HTMLButtonElement.prototype.getBoundingClientRect = () => MOCK_RECT;

  // Stub window dimensions.
  Object.defineProperty(window, 'innerWidth', {
    value: MOCK_INNER_WIDTH,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(window, 'innerHeight', {
    value: MOCK_INNER_HEIGHT,
    configurable: true,
    writable: true,
  });
});

afterEach(() => {
  act(() => {
    const root = (container as any).__root;
    if (root) root.unmount();
  });
  document.body.removeChild(container);

  // Restore the original getBoundingClientRect.
  HTMLButtonElement.prototype.getBoundingClientRect = originalGetBoundingClientRect;

  // Restore window dimensions to sensible defaults.
  Object.defineProperty(window, 'innerWidth', {
    value: 1024,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(window, 'innerHeight', {
    value: 768,
    configurable: true,
    writable: true,
  });
});

function renderNotificationBell(): HTMLElement {
  act(() => {
    const root = createRoot(container);
    (container as any).__root = root;
    root.render(<NotificationBell />);
  });
  return container;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Open the popover by clicking the bell button and return the portaled
 * dropdown element (rendered into document.body, NOT into the test container).
 */
function openPopoverAndGetDropdown(): HTMLElement {
  const button = container.querySelector('button');
  if (!button) throw new Error('Bell button not found in rendered output');

  act(() => {
    button.click();
  });

  // The dropdown is portaled to document.body via createPortal.
  const dropdown = document.body.querySelector('.fixed.z-50.w-80') as HTMLElement | null;
  if (!dropdown) throw new Error('Portaled dropdown not found in document.body');
  return dropdown;
}

// ---------------------------------------------------------------------------
// Regression tests
// ---------------------------------------------------------------------------

describe('NotificationBell — popover positioning (regression: opens downward)', () => {
  it('renders the bell button', () => {
    renderNotificationBell();
    const button = container.querySelector('button');
    expect(button).not.toBeNull();
  });

  it('opens a portaled dropdown when the bell is clicked', () => {
    renderNotificationBell();
    const dropdown = openPopoverAndGetDropdown();
    expect(dropdown).not.toBeNull();
  });

  it('positions the dropdown TOP at rect.bottom + 8 (opens downward)', () => {
    // Expected: 50 + 8 = 58px
    renderNotificationBell();
    const dropdown = openPopoverAndGetDropdown();
    expect(dropdown.style.top).toBe('58px');
  });

  it('does NOT use a bottom anchor — style.bottom must be empty (regression guard)', () => {
    // OLD bug: bottom = window.innerHeight - rect.bottom = 768 - 50 = 718px
    // If this test sees a non-empty bottom, the old bug has been reintroduced.
    renderNotificationBell();
    const dropdown = openPopoverAndGetDropdown();
    expect(dropdown.style.bottom).toBeFalsy();
  });

  it('right-aligns the dropdown to the bell: style.right = window.innerWidth - rect.right', () => {
    // Expected: 1024 - 830 = 194px
    renderNotificationBell();
    const dropdown = openPopoverAndGetDropdown();
    expect(dropdown.style.right).toBe('194px');
  });

  it('does NOT use a left anchor — style.left must be empty (regression guard)', () => {
    // OLD bug: left = rect.right + 8 = 830 + 8 = 838px
    // If this test sees a non-empty left, the old bug has been reintroduced.
    renderNotificationBell();
    const dropdown = openPopoverAndGetDropdown();
    expect(dropdown.style.left).toBeFalsy();
  });

  it('dropdown closes when the backdrop is clicked', () => {
    renderNotificationBell();
    openPopoverAndGetDropdown(); // open it

    // The backdrop is the fixed inset-0 div behind the dropdown.
    const backdrop = document.body.querySelector('.fixed.inset-0.z-40') as HTMLElement | null;
    expect(backdrop).not.toBeNull();

    act(() => {
      backdrop!.click();
    });

    const dropdownAfterClose = document.body.querySelector('.fixed.z-50.w-80');
    expect(dropdownAfterClose).toBeNull();
  });
});
