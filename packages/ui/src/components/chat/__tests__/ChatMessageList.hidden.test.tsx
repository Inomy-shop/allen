/**
 * Tests for ChatMessageList hidden message filtering.
 *
 * Messages with hidden=true must not appear in the visible message stream.
 * The component has many heavy dependencies (React.lazy, portals, API calls),
 * so we mock those and focus on the hidden filter behavior.
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi, beforeAll } from 'vitest';

// jsdom does not implement scrollIntoView; stub it to avoid TypeError
if (typeof Element.prototype.scrollIntoView === 'undefined') {
  Element.prototype.scrollIntoView = () => {};
}

// ChatMessageList calls agentsApi.list() — suppress console noise
beforeAll(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

// Mock ChatExecutionsPanel (React.lazy import)
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
  chatCodeDiffs: { list: vi.fn().mockResolvedValue({ snapshots: [] }), capture: vi.fn() },
  pullRequests: { getDiffFile: vi.fn().mockResolvedValue(null) },
  workspaces: { getDiffFile: vi.fn().mockResolvedValue(null) },
}));

// Mock portal for ArtifactMarkdownLink
vi.mock('react-dom', async () => {
  const actual = await vi.importActual('react-dom');
  return {
    ...actual,
    createPortal: (node: React.ReactNode) => node,
  };
});

import ChatMessageList from '../ChatMessageList';
import type { ChatMessage } from '../../hooks/useChat';

function makeMessage(overrides: Partial<ChatMessage> & { _id: string; role: 'user' | 'assistant' }): ChatMessage {
  return {
    sessionId: 'test-session',
    content: 'Test content',
    status: 'completed',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('ChatMessageList hidden message filter', () => {
  it('renders messages without hidden flag', () => {
    const messages: ChatMessage[] = [
      makeMessage({ _id: 'm1', role: 'user', content: 'Hello' }),
      makeMessage({ _id: 'm2', role: 'assistant', content: 'Hi there' }),
    ];
    render(
      <ChatMessageList
        messages={messages}
        streamText=""
        streaming={false}
      />,
    );
    expect(screen.getByText('Hello')).toBeInTheDocument();
    expect(screen.getByText('Hi there')).toBeInTheDocument();
  });

  it('filters out messages with hidden=true', () => {
    const messages: ChatMessage[] = [
      makeMessage({ _id: 'm1', role: 'user', content: 'Visible user message' }),
      makeMessage({ _id: 'm2', role: 'assistant', content: 'Visible assistant message' }),
      // This hidden message should not appear in the UI
      { ...makeMessage({ _id: 'm3', role: 'assistant', content: 'Hidden trigger message' }), hidden: true },
    ];
    render(
      <ChatMessageList
        messages={messages}
        streamText=""
        streaming={false}
      />,
    );
    // Visible messages should render
    expect(screen.getByText('Visible user message')).toBeInTheDocument();
    expect(screen.getByText('Visible assistant message')).toBeInTheDocument();
    // Hidden message should NOT render
    expect(screen.queryByText('Hidden trigger message')).not.toBeInTheDocument();
  });

  it('filters out all hidden messages even when mixed with visible ones', () => {
    const messages: ChatMessage[] = [
      { ...makeMessage({ _id: 'm1', role: 'user', content: 'User says hi' }), hidden: true },
      makeMessage({ _id: 'm2', role: 'assistant', content: 'Assistant reply' }),
      { ...makeMessage({ _id: 'm3', role: 'assistant', content: 'Hidden watcher trigger' }), hidden: true },
      makeMessage({ _id: 'm4', role: 'user', content: 'Another user message' }),
    ];
    render(
      <ChatMessageList
        messages={messages}
        streamText=""
        streaming={false}
      />,
    );
    expect(screen.getByText('Assistant reply')).toBeInTheDocument();
    expect(screen.getByText('Another user message')).toBeInTheDocument();
    expect(screen.queryByText('User says hi')).not.toBeInTheDocument();
    expect(screen.queryByText('Hidden watcher trigger')).not.toBeInTheDocument();
  });

  it('still shows streaming when all messages are hidden', () => {
    const messages: ChatMessage[] = [
      { ...makeMessage({ _id: 'm1', role: 'assistant', content: 'Hidden content' }), hidden: true },
    ];
    render(
      <ChatMessageList
        messages={messages}
        streamText="Streaming text"
        streaming={true}
      />,
    );
    // Hidden message should not appear
    expect(screen.queryByText('Hidden content')).not.toBeInTheDocument();
    // Streaming text should still appear
    expect(screen.getByText('Streaming text')).toBeInTheDocument();
  });
});
