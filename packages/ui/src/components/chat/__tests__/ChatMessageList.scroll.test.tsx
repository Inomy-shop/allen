/**
 * Tests for ChatMessageList scroll behaviour after the tab-switch scroll fix.
 *
 * AC-1: Initial historical messages start at the top without scrolling.
 * AC-2: When a non-streaming view is pinned to the bottom, subsequent messages
 *       use behavior:'instant' so updates produce no visible animation.
 * AC-3: When streaming=true, scrollIntoView is called with behavior:'smooth'
 *       so live streaming still gets smooth scroll-to-bottom.
 *
 * The mock pattern here exactly mirrors ChatMessageList.hidden.test.tsx.
 */

import React from 'react';
import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach, beforeAll } from 'vitest';

// ─── jsdom stubs ────────────────────────────────────────────────────────────
// jsdom does not implement scrollIntoView; replace with a spy so we can assert.
Element.prototype.scrollIntoView = vi.fn();

// ─── Suppress console noise from lazy-loaded internals ──────────────────────
beforeAll(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

// ─── Module mocks (must be before the import of the component) ───────────────

// Mock ChatExecutionsPanel (React.lazy import inside ChatMessageList)
vi.mock('../ChatRunSidebar', () => ({
  ExecutionsPanel: vi.fn(() => <div data-testid="executions-panel" />),
}));

// Mock API services used by ChatMessageList
vi.mock('../../../services/api', () => ({
  agents: {
    list: vi.fn().mockResolvedValue([]),
  },
  artifacts: {
    get: vi.fn(),
    contentUrl: vi.fn(),
  },
}));

vi.mock('../../../services/workspaceService', () => ({
  chatCodeDiffs: {
    list: vi.fn().mockResolvedValue({ snapshots: [] }),
    capture: vi.fn(),
  },
  pullRequests: { getDiffFile: vi.fn().mockResolvedValue(null) },
  workspaces: { getDiffFile: vi.fn().mockResolvedValue(null) },
}));

// Mock createPortal so ArtifactMarkdownLink renders inline without a real DOM node
vi.mock('react-dom', async () => {
  const actual = await vi.importActual('react-dom');
  return {
    ...actual,
    createPortal: (node: React.ReactNode) => node,
  };
});

// ─── Component under test ────────────────────────────────────────────────────
import ChatMessageList from '../ChatMessageList';
import type { ChatMessage } from '../../hooks/useChat';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeMessage(
  overrides: Partial<ChatMessage> & { _id: string; role: 'user' | 'assistant' },
): ChatMessage {
  return {
    sessionId: 'test-session',
    content: 'Test content',
    status: 'completed',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

/** Return every recorded `behavior` value from all scrollIntoView calls. */
function capturedBehaviors(): string[] {
  const spy = Element.prototype.scrollIntoView as ReturnType<typeof vi.fn>;
  return spy.mock.calls.map((call) => (call[0] as ScrollIntoViewOptions)?.behavior ?? '');
}

// ─── Test suite ──────────────────────────────────────────────────────────────

describe('ChatMessageList scroll behaviour', () => {
  beforeEach(() => {
    // Reset spy counts before each test so assertions are isolated
    (Element.prototype.scrollIntoView as ReturnType<typeof vi.fn>).mockClear();
  });

  it(
    // AC-1: loaded history starts at the beginning of the conversation
    'AC-1: keeps initial non-streaming history at the top without scrolling',
    () => {
      const messages: ChatMessage[] = [
        makeMessage({ _id: 'm1', role: 'user', content: 'Hello' }),
      ];

      const { container } = render(
        <ChatMessageList
          messages={messages}
          streamText=""
          streaming={false}
        />,
      );

      const messageList = container.querySelector<HTMLElement>('.chat-stream-v2');
      expect(messageList?.scrollTop).toBe(0);
      expect(capturedBehaviors()).toEqual([]);
    },
  );

  it(
    // AC-2: historical updates remain instant once the view is pinned
    'AC-2: uses behavior "instant" for a non-streaming update when pinned',
    () => {
      const firstMessage = makeMessage({ _id: 'm1', role: 'user', content: 'Hello' });
      const { container, rerender } = render(
        <ChatMessageList
          messages={[firstMessage]}
          streamText=""
          streaming={false}
        />,
      );

      const messageList = container.querySelector<HTMLElement>('.chat-stream-v2');
      expect(messageList).not.toBeNull();
      fireEvent.scroll(messageList!);

      rerender(
        <ChatMessageList
          messages={[
            firstMessage,
            makeMessage({ _id: 'm2', role: 'assistant', content: 'Hi there' }),
          ]}
          streamText=""
          streaming={false}
        />,
      );

      const behaviors = capturedBehaviors();
      expect(behaviors.length).toBeGreaterThan(0);
      behaviors.forEach((behavior) => {
        expect(behavior, `expected 'instant' but got '${behavior}'`).toBe('instant');
      });
    },
  );

  it(
    // AC-3: scroll is smooth during streaming
    'AC-3: calls scrollIntoView with behavior "smooth" when streaming=true',
    () => {
      const messages: ChatMessage[] = [
        makeMessage({ _id: 'm1', role: 'assistant', content: 'Streaming response' }),
      ];

      render(
        <ChatMessageList
          messages={messages}
          streamText="Streaming…"
          streaming={true}
        />,
      );

      const behaviors = capturedBehaviors();
      // At least one scrollIntoView call must have occurred
      expect(behaviors.length).toBeGreaterThan(0);
      // Every call must use 'smooth' during streaming
      behaviors.forEach((b) => {
        expect(b, `expected 'smooth' but got '${b}'`).toBe('smooth');
      });
    },
  );
});
