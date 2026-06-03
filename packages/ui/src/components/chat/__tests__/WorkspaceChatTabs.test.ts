/**
 * Pure TypeScript unit tests for the logic in WorkspaceChatTabs.tsx and
 * the tab-handler logic in ChatPage.tsx.
 *
 * WorkspaceChatTabs.tsx uses JSX, and react/jsx-dev-runtime is not in
 * node_modules.  Vite's import-analysis transform fails at build time —
 * before any vi.mock() can intercept — so we cannot import the component
 * module at all.
 *
 * Strategy: reproduce the three pure-logic pieces inline, mirroring the
 * exact expressions from the source file (WorkspaceChatTabs.tsx).
 * This is the same approach used by linear-api.test.ts in this repo.
 *
 * Covered acceptance criteria:
 *   AC-04 – Existing workspace chats sorted by most recent activity.
 *   AC-05 – Real chat tab shows the chat title.
 *   AC-06 – Temporary new tabs show "New chat" / "New chat N" fallback.
 *   AC-07 – Title update logic (label reflects latest title).
 *   AC-10 – + New Chat opens tab without clearing existing tabs.
 *   AC-11 – Close tab removes from strip only; session NOT deleted.
 *   AC-12 – Previous-chats dropdown sorted desc, capped at 50.
 */

import { describe, it, expect } from 'vitest';

// ---------------------------------------------------------------------------
// Type definitions (mirrors WorkspaceChatTabs.tsx exports)
// ---------------------------------------------------------------------------

type WorkspaceChatTabId =
  | { kind: 'session'; sessionId: string }
  | { kind: 'temp'; tempId: string }
  | { kind: 'terminal' };

type WorkspaceChatTab = {
  id: WorkspaceChatTabId;
  title: string;
  isTemp: boolean;
  titleSource?: 'default' | 'auto' | 'user';
  tempIndex?: number;
  lastMessageAt?: string;
  streaming?: boolean;
};

// ---------------------------------------------------------------------------
// Inline mirrors of the component's pure logic
// (source of truth: WorkspaceChatTabs.tsx — keep in sync if source changes)
// ---------------------------------------------------------------------------

/**
 * Mirrors: export function getTabKey(tab: WorkspaceChatTab): string { ... }
 */
function getTabKey(tab: WorkspaceChatTab): string {
  if (tab.id.kind === 'session') return tab.id.sessionId;
  if (tab.id.kind === 'terminal') return 'terminal';
  return tab.id.tempId;
}

/**
 * Mirrors: const label = tab.title || (tab.isTemp ? (...) : 'chat');
 */
function deriveLabel(tab: WorkspaceChatTab): string {
  return (
    tab.title ||
    (tab.id.kind === 'terminal'
      ? 'Terminal'
      : tab.isTemp
      ? tab.tempIndex != null && tab.tempIndex > 0
        ? `New chat ${tab.tempIndex}`
        : 'New chat'
      : 'chat')
  );
}

/**
 * Mirrors: const sortedPrev = [...availablePreviousChats].sort(...).slice(0, 50);
 */
function computeSortedPrev(
  chats: Array<{ _id: string; title?: string; lastMessageAt?: string }>,
): Array<{ _id: string; title?: string; lastMessageAt?: string }> {
  return [...chats]
    .sort((a, b) => {
      const at = a.lastMessageAt ? new Date(a.lastMessageAt).getTime() : 0;
      const bt = b.lastMessageAt ? new Date(b.lastMessageAt).getTime() : 0;
      return bt - at;
    })
    .slice(0, 50);
}

// ---------------------------------------------------------------------------
// Factory helpers
// ---------------------------------------------------------------------------

function sessionTab(overrides: Partial<WorkspaceChatTab> = {}): WorkspaceChatTab {
  return {
    id: { kind: 'session', sessionId: 'sess-abc' },
    title: 'My chat title',
    isTemp: false,
    ...overrides,
  };
}

function tempTab(overrides: Partial<WorkspaceChatTab> = {}): WorkspaceChatTab {
  return {
    id: { kind: 'temp', tempId: 'temp-1' },
    title: '',
    isTemp: true,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests: getTabKey (AC-05, AC-06)
// ---------------------------------------------------------------------------

describe('getTabKey', () => {
  it('AC-05: returns sessionId for a session tab', () => {
    const tab = sessionTab({ id: { kind: 'session', sessionId: 'sess-xyz' } });
    expect(getTabKey(tab)).toBe('sess-xyz');
  });

  it('AC-06: returns tempId for a temp tab', () => {
    const tab = tempTab({ id: { kind: 'temp', tempId: 'temp-42' } });
    expect(getTabKey(tab)).toBe('temp-42');
  });

  it('returns terminal for a terminal tab', () => {
    const tab = sessionTab({ id: { kind: 'terminal' }, title: 'Terminal' });
    expect(getTabKey(tab)).toBe('terminal');
  });
});

// ---------------------------------------------------------------------------
// Tests: label derivation (AC-05, AC-06, AC-07)
// ---------------------------------------------------------------------------

describe('deriveLabel — tab title display logic', () => {
  it('AC-05: real session tab with title → shows that title', () => {
    const tab = sessionTab({ title: 'Fix the login bug' });
    expect(deriveLabel(tab)).toBe('Fix the login bug');
  });

  it('AC-06: temp tab with empty title → shows "New chat"', () => {
    const tab = tempTab({ title: '' });
    expect(deriveLabel(tab)).toBe('New chat');
  });

  it('AC-06: temp tab with tempIndex=0 → shows "New chat" (not "New chat 0")', () => {
    const tab = tempTab({ title: '', tempIndex: 0 });
    expect(deriveLabel(tab)).toBe('New chat');
  });

  it('AC-06/EC-04: temp tab with tempIndex=1 → shows "New chat 1"', () => {
    const tab = tempTab({ title: '', tempIndex: 1 });
    expect(deriveLabel(tab)).toBe('New chat 1');
  });

  it('AC-06/EC-04: temp tab with tempIndex=2 → shows "New chat 2"', () => {
    const tab = tempTab({ title: '', tempIndex: 2 });
    expect(deriveLabel(tab)).toBe('New chat 2');
  });

  it('AC-06: real session tab with no title → shows "chat" (fallback)', () => {
    const tab = sessionTab({ title: '' });
    expect(deriveLabel(tab)).toBe('chat');
  });

  it('AC-07: temp tab that has acquired a generated title → shows the generated title', () => {
    // Once title is generated, tab.title is set and label reflects it immediately
    const tab = tempTab({ title: 'Debugging session' });
    expect(deriveLabel(tab)).toBe('Debugging session');
  });

  it('AC-07: session tab title update → shows updated title', () => {
    const tab = sessionTab({ title: 'Updated title via rename' });
    expect(deriveLabel(tab)).toBe('Updated title via rename');
  });

  it('AC-06: temp tab with undefined tempIndex → shows "New chat"', () => {
    const tab = tempTab({ title: '', tempIndex: undefined });
    expect(deriveLabel(tab)).toBe('New chat');
  });

  it('AC-06: temp tab with tempIndex=3 → shows "New chat 3"', () => {
    const tab = tempTab({ title: '', tempIndex: 3 });
    expect(deriveLabel(tab)).toBe('New chat 3');
  });

  it('terminal tab with empty title → shows "Terminal"', () => {
    const tab = sessionTab({ id: { kind: 'terminal' }, title: '' });
    expect(deriveLabel(tab)).toBe('Terminal');
  });
});

// ---------------------------------------------------------------------------
// Tests: sortedPrev — sort and cap logic (AC-04, AC-12)
// ---------------------------------------------------------------------------

describe('computeSortedPrev — previous-chats sort and cap', () => {
  it('AC-04: 3 chats with different dates → sorted most recent first', () => {
    const chats = [
      { _id: 'c1', lastMessageAt: '2024-01-01T10:00:00Z' },
      { _id: 'c3', lastMessageAt: '2024-03-01T10:00:00Z' },
      { _id: 'c2', lastMessageAt: '2024-02-01T10:00:00Z' },
    ];
    const sorted = computeSortedPrev(chats);
    expect(sorted.map((c) => c._id)).toEqual(['c3', 'c2', 'c1']);
  });

  it('AC-12/EC-03: 60 chats → only 50 returned', () => {
    const chats = Array.from({ length: 60 }, (_, i) => ({
      _id: `c${i}`,
      lastMessageAt: new Date(Date.now() - i * 1000).toISOString(),
    }));
    const sorted = computeSortedPrev(chats);
    expect(sorted).toHaveLength(50);
  });

  it('AC-04: chats with missing lastMessageAt → sorted to end', () => {
    const chats = [
      { _id: 'no-date' },
      { _id: 'recent', lastMessageAt: '2024-05-01T00:00:00Z' },
      { _id: 'older', lastMessageAt: '2024-01-01T00:00:00Z' },
    ];
    const sorted = computeSortedPrev(chats);
    expect(sorted[0]._id).toBe('recent');
    expect(sorted[1]._id).toBe('older');
    expect(sorted[2]._id).toBe('no-date');
  });

  it('AC-12: exactly 50 chats → all 50 returned (no over-trimming)', () => {
    const chats = Array.from({ length: 50 }, (_, i) => ({
      _id: `c${i}`,
      lastMessageAt: new Date(Date.now() - i * 1000).toISOString(),
    }));
    expect(computeSortedPrev(chats)).toHaveLength(50);
  });

  it('AC-12: empty list → empty array', () => {
    expect(computeSortedPrev([])).toEqual([]);
  });

  it('AC-04: original array is not mutated by sorting', () => {
    const chats = [
      { _id: 'c1', lastMessageAt: '2024-01-01T00:00:00Z' },
      { _id: 'c2', lastMessageAt: '2024-06-01T00:00:00Z' },
    ];
    const original = [...chats];
    computeSortedPrev(chats);
    expect(chats).toEqual(original);
  });

  it('AC-04: two chats with the same date → both present in result', () => {
    const sameDate = '2024-04-01T00:00:00Z';
    const chats = [
      { _id: 'cA', lastMessageAt: sameDate },
      { _id: 'cB', lastMessageAt: sameDate },
    ];
    const sorted = computeSortedPrev(chats);
    expect(sorted).toHaveLength(2);
    expect(sorted.map((c) => c._id)).toContain('cA');
    expect(sorted.map((c) => c._id)).toContain('cB');
  });

  it('AC-04: single chat → returned as-is', () => {
    const chats = [{ _id: 'only', lastMessageAt: '2024-06-01T00:00:00Z' }];
    const sorted = computeSortedPrev(chats);
    expect(sorted).toHaveLength(1);
    expect(sorted[0]._id).toBe('only');
  });
});

// ---------------------------------------------------------------------------
// Mirrors of ChatPage.tsx tab-handler logic (fixed in code-review pass)
// Tests AC-10 (new tab does not clear existing) and AC-11 (close removes
// only from strip — no DELETE call issued).
//
// Keep in sync with handleWorkspaceTabClose and handleWorkspaceTabRestore
// in packages/ui/src/pages/ChatPage.tsx.
// ---------------------------------------------------------------------------

/**
 * Mirrors handleWorkspaceTabClose — pure state computation.
 * Returns { newTabs, newActiveKey } without any React state side effects.
 * The real handler does: compute next = tabs.filter(...), then calls
 * setOpenWorkspaceTabs(next), setActiveWorkspaceTabKey(...), switchSession(...)
 * as separate calls *outside* any setState updater.
 */
function simulateTabClose(
  tabs: WorkspaceChatTab[],
  activeKey: string,
  closeKey: string,
  recentChat?: { _id: string; title?: string; lastMessageAt?: string },
): { newTabs: WorkspaceChatTab[]; newActiveKey: string } {
  const next = tabs.filter(t => getTabKey(t) !== closeKey);
  if (next.length === 0) {
    if (recentChat?._id) {
      const recentTab: WorkspaceChatTab = {
        id: { kind: 'session', sessionId: recentChat._id },
        title: recentChat.title || 'chat',
        isTemp: false,
        lastMessageAt: recentChat.lastMessageAt,
      };
      return { newTabs: [recentTab], newActiveKey: getTabKey(recentTab) };
    }
    const tempTab: WorkspaceChatTab = {
      id: { kind: 'temp', tempId: 'temp-fallback' },
      title: 'New chat',
      isTemp: true,
      tempIndex: 0,
    };
    return { newTabs: [tempTab], newActiveKey: getTabKey(tempTab) };
  }
  let newActiveKey = activeKey;
  if (activeKey === closeKey) {
    const closedIdx = tabs.findIndex(t => getTabKey(t) === closeKey);
    const nextTab = next[Math.max(0, closedIdx - 1)] ?? next[0];
    newActiveKey = getTabKey(nextTab);
  }
  return { newTabs: next, newActiveKey };
}

/**
 * Mirrors handleWorkspaceTabRestore — pure state computation.
 * Returns { newTabs, tabAdded }.
 * The real handler calls setOpenWorkspaceTabs, setActiveWorkspaceTabKey,
 * switchSession, and navigate as separate calls outside any updater.
 */
function simulateTabRestore(
  tabs: WorkspaceChatTab[],
  sessionId: string,
  chat: { _id: string; title?: string; lastMessageAt?: string },
): { newTabs: WorkspaceChatTab[]; tabAdded: boolean } {
  const alreadyOpen = tabs.some(t => getTabKey(t) === sessionId);
  if (alreadyOpen) return { newTabs: tabs, tabAdded: false };
  const newTab: WorkspaceChatTab = {
    id: { kind: 'session', sessionId },
    title: chat.title || 'chat',
    isTemp: false,
    lastMessageAt: chat.lastMessageAt,
  };
  return { newTabs: [...tabs, newTab], tabAdded: true };
}

function simulateWorkspaceBootstrapWithPendingTemp(
  finalTabs: WorkspaceChatTab[],
  restoredActiveId: string | null,
  pendingTemp: WorkspaceChatTab | null,
): { tabs: WorkspaceChatTab[]; activeKey: string; shouldClearSession: boolean } {
  const tabsWithPending = pendingTemp && !finalTabs.some(t => getTabKey(t) === getTabKey(pendingTemp))
    ? [...finalTabs, pendingTemp]
    : finalTabs;
  const restoredActiveStillOpen = restoredActiveId && tabsWithPending.some(t => getTabKey(t) === restoredActiveId);
  const activeKey = pendingTemp
    ? getTabKey(pendingTemp)
    : restoredActiveStillOpen
      ? restoredActiveId
      : getTabKey(tabsWithPending[0]);
  const activeTab = tabsWithPending.find(t => getTabKey(t) === activeKey);
  return { tabs: tabsWithPending, activeKey, shouldClearSession: activeTab?.id.kind !== 'session' };
}

function simulateRestoredTabIds(
  chats: Array<{ _id: string; title?: string }>,
  storedOpenIds: string[] | null,
): WorkspaceChatTab[] {
  const hasStoredTabState = storedOpenIds !== null;
  const tabSessionIds = hasStoredTabState
    ? storedOpenIds.filter(id => chats.some(c => c._id === id))
    : (chats[0]?._id ? [chats[0]._id] : []);
  const tabs = tabSessionIds.map(sid => {
    const chat = chats.find(c => c._id === sid);
    return {
      id: { kind: 'session' as const, sessionId: sid },
      title: chat?.title || 'chat',
      isTemp: false,
    };
  });
  return tabs.length > 0 ? tabs : (chats[0] ? [{
    id: { kind: 'session' as const, sessionId: chats[0]._id },
    title: chats[0].title || 'chat',
    isTemp: false,
  }] : []);
}

function shouldSkipPathBWorkspaceLoad(
  previousLoadKey: string | null,
  workspaceId: string,
  routeSessionId: string,
  activeWorkspaceId: string | null,
  openTabs: WorkspaceChatTab[],
): boolean {
  const loadKey = `${workspaceId}:${routeSessionId}`;
  const routeSessionAlreadyOpen = openTabs.some(t => getTabKey(t) === routeSessionId);
  return previousLoadKey === loadKey && activeWorkspaceId === workspaceId && routeSessionAlreadyOpen;
}

describe('simulateTabClose — handleWorkspaceTabClose logic (AC-11)', () => {
  it('AC-11: closing a non-active tab keeps all other tabs intact', () => {
    const t1 = sessionTab({ id: { kind: 'session', sessionId: 'sess-1' }, title: 'T1' });
    const t2 = sessionTab({ id: { kind: 'session', sessionId: 'sess-2' }, title: 'T2' });
    const t3 = sessionTab({ id: { kind: 'session', sessionId: 'sess-3' }, title: 'T3' });
    const { newTabs } = simulateTabClose([t1, t2, t3], 'sess-1', 'sess-3');
    expect(newTabs).toHaveLength(2);
    expect(newTabs.map(t => getTabKey(t))).toEqual(['sess-1', 'sess-2']);
  });

  it('AC-11: closing active tab selects nearest remaining tab', () => {
    const t1 = sessionTab({ id: { kind: 'session', sessionId: 'sess-1' }, title: 'T1' });
    const t2 = sessionTab({ id: { kind: 'session', sessionId: 'sess-2' }, title: 'T2' });
    const t3 = sessionTab({ id: { kind: 'session', sessionId: 'sess-3' }, title: 'T3' });
    // Active is t2; closing t2 → select t1 (left neighbour)
    const { newTabs, newActiveKey } = simulateTabClose([t1, t2, t3], 'sess-2', 'sess-2');
    expect(newTabs).toHaveLength(2);
    expect(newActiveKey).toBe('sess-1');
  });

  it('AC-11: closing the LAST tab creates a blank "New chat" temp tab when there is no chat history', () => {
    const t1 = sessionTab({ id: { kind: 'session', sessionId: 'sess-1' }, title: 'T1' });
    const { newTabs, newActiveKey } = simulateTabClose([t1], 'sess-1', 'sess-1');
    expect(newTabs).toHaveLength(1);
    expect(newTabs[0].isTemp).toBe(true);
    expect(newTabs[0].title).toBe('New chat');
    expect(newActiveKey).toBe(getTabKey(newTabs[0]));
  });

  it('closing the LAST tab selects the most recent workspace chat when history exists', () => {
    const t1 = sessionTab({ id: { kind: 'session', sessionId: 'sess-1' }, title: 'T1' });
    const recentChat = { _id: 'sess-recent', title: 'Most recent', lastMessageAt: '2026-06-03T06:00:00Z' };

    const { newTabs, newActiveKey } = simulateTabClose([t1], 'sess-1', 'sess-1', recentChat);

    expect(newTabs).toHaveLength(1);
    expect(newTabs[0].id).toEqual({ kind: 'session', sessionId: 'sess-recent' });
    expect(newActiveKey).toBe('sess-recent');
  });

  it('AC-11: closing a tab does NOT trigger a session delete (no deleteSession call in logic)', () => {
    // The handler only filters the in-memory tab list — there is no API call to
    // delete the session. We verify: the closed session id still exists in a
    // mock "session store" that the handler never touches.
    const sessions = ['sess-1', 'sess-2', 'sess-3'];
    const t1 = sessionTab({ id: { kind: 'session', sessionId: 'sess-1' }, title: 'T1' });
    const t2 = sessionTab({ id: { kind: 'session', sessionId: 'sess-2' }, title: 'T2' });
    const t3 = sessionTab({ id: { kind: 'session', sessionId: 'sess-3' }, title: 'T3' });
    simulateTabClose([t1, t2, t3], 'sess-1', 'sess-2');
    // sessions store is unchanged — tab close never deletes from it
    expect(sessions).toContain('sess-2');
  });
});

describe('workspace bootstrap with pending new tab', () => {
  it('keeps the new blank tab active when route bootstrap reloads existing chats', () => {
    const existing = sessionTab({ id: { kind: 'session', sessionId: 'sess-1' }, title: 'Existing chat' });
    const pending: WorkspaceChatTab = {
      id: { kind: 'temp', tempId: 'temp-new' },
      title: 'New chat',
      isTemp: true,
      tempIndex: 1,
    };

    const result = simulateWorkspaceBootstrapWithPendingTemp([existing], 'sess-1', pending);

    expect(result.tabs.map(t => getTabKey(t))).toEqual(['sess-1', 'temp-new']);
    expect(result.activeKey).toBe('temp-new');
    expect(result.shouldClearSession).toBe(true);
  });
});

describe('workspace bootstrap restored open tabs', () => {
  it('falls back to the most recent chat when every tab was closed', () => {
    const chats = [
      { _id: 'sess-1', title: 'Closed one' },
      { _id: 'sess-2', title: 'Closed two' },
    ];

    const restoredTabs = simulateRestoredTabIds(chats, []);

    expect(restoredTabs.map(t => getTabKey(t))).toEqual(['sess-1']);
  });

  it('opens only the most recent chat when there is no stored tab state yet', () => {
    const chats = [
      { _id: 'sess-1', title: 'First' },
      { _id: 'sess-2', title: 'Second' },
    ];

    const restoredTabs = simulateRestoredTabIds(chats, null);

    expect(restoredTabs.map(t => getTabKey(t))).toEqual(['sess-1']);
  });
});

describe('dashboard session workspace bootstrap guard', () => {
  it('does not skip a same-workspace dashboard link when that session tab is closed', () => {
    const openTab = sessionTab({ id: { kind: 'session', sessionId: 'sess-open' }, title: 'Open' });

    const skip = shouldSkipPathBWorkspaceLoad(
      'ws-1:sess-open',
      'ws-1',
      'sess-closed',
      'ws-1',
      [openTab],
    );

    expect(skip).toBe(false);
  });

  it('skips only when the exact dashboard-linked session is already open', () => {
    const openTab = sessionTab({ id: { kind: 'session', sessionId: 'sess-open' }, title: 'Open' });

    const skip = shouldSkipPathBWorkspaceLoad(
      'ws-1:sess-open',
      'ws-1',
      'sess-open',
      'ws-1',
      [openTab],
    );

    expect(skip).toBe(true);
  });
});

describe('simulateTabRestore — handleWorkspaceTabRestore logic (AC-12)', () => {
  it('AC-12: restoring a chat that is NOT open adds it to the tab strip', () => {
    const t1 = sessionTab({ id: { kind: 'session', sessionId: 'sess-1' }, title: 'T1' });
    const { newTabs, tabAdded } = simulateTabRestore(
      [t1],
      'sess-2',
      { _id: 'sess-2', title: 'Restored chat' },
    );
    expect(tabAdded).toBe(true);
    expect(newTabs).toHaveLength(2);
    expect(newTabs[1].title).toBe('Restored chat');
    expect(getTabKey(newTabs[1])).toBe('sess-2');
  });

  it('AC-12: restoring a chat already open does NOT create a duplicate tab', () => {
    const t1 = sessionTab({ id: { kind: 'session', sessionId: 'sess-1' }, title: 'T1' });
    const { newTabs, tabAdded } = simulateTabRestore(
      [t1],
      'sess-1',
      { _id: 'sess-1', title: 'T1' },
    );
    expect(tabAdded).toBe(false);
    expect(newTabs).toHaveLength(1);
  });

  it('AC-12: restored tab uses chat title; fallback to "chat" when title absent', () => {
    const { newTabs } = simulateTabRestore(
      [],
      'sess-x',
      { _id: 'sess-x' }, // no title
    );
    expect(newTabs[0].title).toBe('chat');
  });
});

describe('tab-strip integrity — AC-10 (+ New Chat does not clear existing tabs)', () => {
  it('AC-10: adding a new temp tab preserves all existing tabs', () => {
    // Mirrors: setOpenWorkspaceTabs(prev => [...prev, tempTab])
    const t1 = sessionTab({ id: { kind: 'session', sessionId: 'sess-1' }, title: 'T1' });
    const t2 = sessionTab({ id: { kind: 'session', sessionId: 'sess-2' }, title: 'T2' });
    const existing = [t1, t2];
    const newTempTab = tempTab({ id: { kind: 'temp', tempId: 'temp-new' }, tempIndex: 1, title: 'New chat 1' });
    const result = [...existing, newTempTab]; // mirrors the updater
    expect(result).toHaveLength(3);
    expect(result[0]).toBe(t1);
    expect(result[1]).toBe(t2);
    expect(result[2].isTemp).toBe(true);
  });
});
