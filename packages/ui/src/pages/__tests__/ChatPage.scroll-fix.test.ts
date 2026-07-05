/**
 * Pure logic unit tests for ChatPage.tsx workspace chat tab scroll/reload fix.
 *
 * ChatPage.tsx has too many heavy dependencies (router, socket hooks, etc.)
 * to render directly in tests.  Following the same approach as
 * WorkspaceChatTabs.test.ts we mirror the three pure-logic pieces inline so
 * that we can cover every branch without touching the real component module.
 *
 * Covered acceptance criteria:
 *   AC-3 – Loading indicator requires activeSessionId to be truthy.
 *   AC-4 – ChatMessageList stays mounted (hidden class) during message load.
 *   AC-5 – Chat content kept alive off-screen when terminal/servers tab active.
 */

import { describe, expect, it } from 'vitest';

// ─────────────────────────────────────────────────────────────────────────────
// Inline mirrors of ChatPage.tsx pure logic
// (source of truth: ChatPage.tsx – keep in sync when source changes)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Mirrors line 1446 of ChatPage.tsx:
 *   {loadingMessages && messages.length === 0 && !streaming && activeSessionId && (…)}
 *
 * The Loading indicator appears ONLY when all four conditions hold:
 *   1. loadingMessages is true
 *   2. No messages have arrived yet
 *   3. We are not streaming
 *   4. There is an activeSessionId (i.e., NOT a blank new-tab)
 */
function showLoadingIndicator(
  loadingMessages: boolean,
  messages: unknown[],
  streaming: boolean,
  activeSessionId: string | null,
): boolean {
  return loadingMessages && messages.length === 0 && !streaming && Boolean(activeSessionId);
}

/**
 * Mirrors line 1491 of ChatPage.tsx:
 *   {(activeSessionId || messages.length > 0 || streaming) && (…ChatMessageList…)}
 *
 * ChatMessageList is rendered (stays in DOM) when any of the three conditions
 * is true.  This prevents the full unmount/remount on tab switches.
 */
function shouldRenderChatMessageList(
  activeSessionId: string | null,
  messages: unknown[],
  streaming: boolean,
): boolean {
  return Boolean(activeSessionId) || messages.length > 0 || streaming;
}

/**
 * Mirrors line 1492 of ChatPage.tsx (post-BLK-1 fix):
 *   <div className={loadingMessages && messages.length === 0 && !streaming
 *     ? 'hidden'
 *     : 'flex-1 min-h-0 flex flex-col'}>
 *
 * When ChatMessageList IS rendered but messages are still loading, the wrapper
 * gets 'hidden' (display:none) instead of being unmounted. This preserves the
 * DOM node (and its scroll position) while avoiding a layout flash.
 *
 * When messages are loaded (not hidden), the wrapper MUST carry flex properties
 * so that its child chat-stream-v2's 'flex: 1' rule is honoured within the
 * parent flex container. An empty className (BLK-1) broke the flex chain and
 * caused chat-stream-v2 to grow to content height, disabling scrolling.
 */
function chatMessageListWrapperClass(
  loadingMessages: boolean,
  messages: unknown[],
  streaming: boolean,
): string {
  return loadingMessages && messages.length === 0 && !streaming
    ? 'hidden'
    : 'flex-1 min-h-0 flex flex-col';
}

/**
 * Mirrors line 1346 of ChatPage.tsx:
 *   const workspaceUtilityTabActive = workspaceTerminalActive || workspaceServersActive;
 */
function workspaceUtilityTabActive(
  workspaceTerminalActive: boolean,
  workspaceServersActive: boolean,
): boolean {
  return workspaceTerminalActive || workspaceServersActive;
}

/**
 * Mirrors lines 1416–1418 of ChatPage.tsx:
 *   <div className={workspaceUtilityTabActive
 *     ? 'fixed -left-[10000px] top-0 h-[720px] w-[1100px] pointer-events-none opacity-0'
 *     : 'flex-1 min-h-0 flex flex-col'
 *   }>
 */
function chatContentClass(utilityTabActive: boolean): string {
  return utilityTabActive
    ? 'fixed -left-[10000px] top-0 h-[720px] w-[1100px] pointer-events-none opacity-0'
    : 'flex-1 min-h-0 flex flex-col';
}

// ─────────────────────────────────────────────────────────────────────────────
// AC-3: Loading indicator requires activeSessionId
// ─────────────────────────────────────────────────────────────────────────────

describe('showLoadingIndicator (AC-3)', () => {
  it(
    // AC-3: loading shown for an existing session
    'returns true when all conditions met (existing session, no messages, not streaming)',
    () => {
      expect(
        showLoadingIndicator(true, [], false, 'sess-1'),
        'Loading indicator should appear for existing session with no messages',
      ).toBe(true);
    },
  );

  it(
    // AC-3: blank new tab must NOT show loading spinner
    'returns false when activeSessionId is null — blank new tab shows no spinner',
    () => {
      expect(
        showLoadingIndicator(true, [], false, null),
        'Blank new tab (activeSessionId=null) must not show loading spinner',
      ).toBe(false);
    },
  );

  it(
    // AC-3: empty-string session id treated as no session
    'returns false when activeSessionId is empty string — treated as no session',
    () => {
      expect(
        showLoadingIndicator(true, [], false, ''),
        'Empty-string activeSessionId must not show loading spinner',
      ).toBe(false);
    },
  );

  it('returns false when loadingMessages is false', () => {
    expect(
      showLoadingIndicator(false, [], false, 'sess-1'),
      'No loading indicator when loadingMessages=false',
    ).toBe(false);
  });

  it('returns false when messages array is non-empty', () => {
    expect(
      showLoadingIndicator(true, [{ _id: 'm1' }], false, 'sess-1'),
      'No loading spinner once messages have arrived',
    ).toBe(false);
  });

  it('returns false when streaming is true', () => {
    expect(
      showLoadingIndicator(true, [], true, 'sess-1'),
      'No loading spinner while streaming is active',
    ).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-4: ChatMessageList stays mounted in DOM (hidden class not unmount)
// ─────────────────────────────────────────────────────────────────────────────

describe('shouldRenderChatMessageList (AC-4)', () => {
  it(
    // AC-4: session active → component stays mounted even with no messages yet
    'returns true when activeSessionId is set (keeps component mounted during initial load)',
    () => {
      expect(
        shouldRenderChatMessageList('sess-1', [], false),
        'ChatMessageList must remain mounted when activeSessionId is set',
      ).toBe(true);
    },
  );

  it(
    // AC-4: blank new tab without messages → no need to mount
    'returns false for blank new tab (no session, no messages, not streaming)',
    () => {
      expect(
        shouldRenderChatMessageList(null, [], false),
        'Should not mount ChatMessageList for blank tab with no content',
      ).toBe(false);
    },
  );

  it('returns true when messages exist even without activeSessionId', () => {
    expect(
      shouldRenderChatMessageList(null, [{ _id: 'm1' }], false),
      'ChatMessageList must stay mounted when it already has messages',
    ).toBe(true);
  });

  it('returns true when streaming is active even without activeSessionId', () => {
    expect(
      shouldRenderChatMessageList(null, [], true),
      'ChatMessageList must stay mounted while streaming is active',
    ).toBe(true);
  });
});

describe('chatMessageListWrapperClass (AC-4)', () => {
  it(
    // AC-4: during initial load the wrapper is hidden (display:none), not unmounted
    'returns "hidden" during initial load (no messages, loading, not streaming)',
    () => {
      expect(
        chatMessageListWrapperClass(true, [], false),
        'Wrapper must use hidden class (not unmount) while loading messages',
      ).toBe('hidden');
    },
  );

  it(
    // BLK-1 regression: wrapper must carry flex properties so chat-stream-v2 flex:1 works
    'returns flex layout class when not loading — ensures chat-stream-v2 can scroll (BLK-1 fix)',
    () => {
      expect(
        chatMessageListWrapperClass(false, [], false),
        'Wrapper must have flex classes so chat-stream-v2 flex:1 is honoured',
      ).toBe('flex-1 min-h-0 flex flex-col');
    },
  );

  it(
    // BLK-1 regression: wrapper must NOT be empty after messages load
    'returns flex layout class when messages have loaded — not empty string (BLK-1 fix)',
    () => {
      expect(
        chatMessageListWrapperClass(true, [{ _id: 'm1' }], false),
        'Wrapper must have flex classes once messages have arrived — empty className broke flex chain',
      ).toBe('flex-1 min-h-0 flex flex-col');
    },
  );

  it(
    // BLK-1 regression: wrapper must have flex classes while streaming
    'returns flex layout class while streaming (show streaming content in scrollable area)',
    () => {
      expect(
        chatMessageListWrapperClass(true, [], true),
        'Wrapper must have flex classes while streaming so message area scrolls correctly',
      ).toBe('flex-1 min-h-0 flex flex-col');
    },
  );

  it('non-hidden class contains flex-1 to participate in parent flex layout', () => {
    const cls = chatMessageListWrapperClass(false, [], false);
    expect(cls, 'Wrapper must contain flex-1 to fill available height').toContain('flex-1');
  });

  it('non-hidden class contains min-h-0 to allow scrolling within flex container', () => {
    const cls = chatMessageListWrapperClass(false, [], false);
    expect(cls, 'Wrapper must contain min-h-0 to prevent unconstrained height').toContain('min-h-0');
  });

  it('non-hidden class contains flex to make wrapper a flex container for chat-stream-v2', () => {
    const cls = chatMessageListWrapperClass(false, [], false);
    expect(cls, 'Wrapper must be a flex container so chat-stream-v2 flex:1 works').toContain('flex');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-5: Chat kept alive off-screen when terminal/servers tab is active
// ─────────────────────────────────────────────────────────────────────────────

const OFFSCREEN_CLASS =
  'fixed -left-[10000px] top-0 h-[720px] w-[1100px] pointer-events-none opacity-0';
const VISIBLE_CLASS = 'flex-1 min-h-0 flex flex-col';

describe('workspaceUtilityTabActive (AC-5)', () => {
  it('returns true when terminal tab is active', () => {
    expect(
      workspaceUtilityTabActive(true, false),
      'Terminal tab must make workspaceUtilityTabActive true',
    ).toBe(true);
  });

  it('returns true when servers tab is active', () => {
    expect(
      workspaceUtilityTabActive(false, true),
      'Servers tab must make workspaceUtilityTabActive true',
    ).toBe(true);
  });

  it('returns false when neither terminal nor servers tab is active', () => {
    expect(
      workspaceUtilityTabActive(false, false),
      'No utility tab active — workspaceUtilityTabActive must be false',
    ).toBe(false);
  });
});

describe('chatContentClass (AC-5)', () => {
  it(
    // AC-5: switching to terminal sends chat off-screen with fixed positioning
    'returns off-screen class when workspaceTerminalActive=true',
    () => {
      const utilityActive = workspaceUtilityTabActive(true, false);
      expect(
        chatContentClass(utilityActive),
        'Chat must use keep-alive off-screen class when terminal tab is active',
      ).toBe(OFFSCREEN_CLASS);
    },
  );

  it(
    // AC-5: switching to servers sends chat off-screen with fixed positioning
    'returns off-screen class when workspaceServersActive=true',
    () => {
      const utilityActive = workspaceUtilityTabActive(false, true);
      expect(
        chatContentClass(utilityActive),
        'Chat must use keep-alive off-screen class when servers tab is active',
      ).toBe(OFFSCREEN_CLASS);
    },
  );

  it(
    // AC-5: chat is visible (normal layout) when neither utility tab is active
    'returns normal flex layout class when no utility tab is active',
    () => {
      const utilityActive = workspaceUtilityTabActive(false, false);
      expect(
        chatContentClass(utilityActive),
        'Chat must use normal flex layout when no utility tab is active',
      ).toBe(VISIBLE_CLASS);
    },
  );

  it(
    // AC-5: off-screen class uses fixed positioning (not display:none / conditional render)
    'off-screen class contains "fixed" (component stays mounted, not removed)',
    () => {
      const cls = chatContentClass(true);
      expect(cls, 'Off-screen keep-alive class must use CSS "fixed" positioning').toContain('fixed');
    },
  );

  it(
    // AC-5: off-screen class must block invisible interactions
    'off-screen class contains "pointer-events-none" to prevent invisible clicks',
    () => {
      const cls = chatContentClass(true);
      expect(
        cls,
        'Off-screen class must include pointer-events-none to prevent invisible interactions',
      ).toContain('pointer-events-none');
    },
  );

  it(
    // AC-5: normal layout must NOT use fixed positioning
    'normal layout class does not contain "fixed"',
    () => {
      const cls = chatContentClass(false);
      expect(cls, 'Visible chat layout must not use fixed positioning').not.toContain('fixed');
    },
  );
});
