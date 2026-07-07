/**
 * Tests for the /skill load slice in ChatMessageList.
 *
 * User messages carrying a skillLoad marker render as a compact skill slice
 * (overline + displayName + slug) instead of the raw "/skill <name>" bubble.
 * Mirrors the mock setup of ChatMessageList.hidden.test.tsx.
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
import type { ChatMessage } from '../../../hooks/useChat';

function makeMessage(overrides: Partial<ChatMessage> & { _id: string; role: 'user' | 'assistant' }): ChatMessage {
  return {
    sessionId: 'test-session',
    content: 'Test content',
    status: 'completed',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('ChatMessageList skill load slice', () => {
  it('renders a skill slice instead of the raw /skill text bubble', () => {
    const messages: ChatMessage[] = [
      makeMessage({
        _id: 'm1',
        role: 'user',
        content: '/skill prd-authoring',
        skillLoad: { name: 'prd-authoring', displayName: 'PRD Authoring' },
      }),
      makeMessage({ _id: 'm2', role: 'assistant', content: 'Loaded the PRD Authoring playbook.' }),
    ];
    render(
      <ChatMessageList
        messages={messages}
        streamText=""
        streaming={false}
      />,
    );

    expect(screen.getByTestId('skill-load-slice')).toBeInTheDocument();
    expect(screen.getByText('Skill load')).toBeInTheDocument();
    expect(screen.getByText('PRD Authoring')).toBeInTheDocument();
    expect(screen.getByText('prd-authoring')).toBeInTheDocument();
    // Raw command text must not appear as a message bubble
    expect(screen.queryByText('/skill prd-authoring')).not.toBeInTheDocument();
    // The assistant acknowledgment renders normally
    expect(screen.getByText('Loaded the PRD Authoring playbook.')).toBeInTheDocument();
  });

  it('renders plain user messages as normal bubbles', () => {
    const messages: ChatMessage[] = [
      makeMessage({ _id: 'm1', role: 'user', content: 'Just a regular message' }),
    ];
    render(
      <ChatMessageList
        messages={messages}
        streamText=""
        streaming={false}
      />,
    );

    expect(screen.queryByTestId('skill-load-slice')).not.toBeInTheDocument();
    expect(screen.getByText('Just a regular message')).toBeInTheDocument();
  });
});
