import { describe, it, expect, vi, beforeAll } from 'vitest';
import { render, screen } from '@testing-library/react';
import DesignRunPanel from './DesignRunPanel';
import type { DesignMessage, DesignPreviewConfig } from '../../services/designService';

// ChatMessageList calls agentsApi.list() — suppress the console error
beforeAll(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

// Mock ChatMessageList: it imports many services and uses React.lazy/portals.
// Use a simple test double so unit tests stay focused on DesignRunPanel logic.
vi.mock('../chat/ChatMessageList', () => ({
  default: vi.fn(({ messages, streaming, streamText }: { messages: Array<{ _id?: string; role: string; content: string; error?: string }>; streaming: boolean; streamText: string }) => (
    <div data-testid="chat-message-list" data-streaming={streaming}>
      {messages.map((m) => (
        <div key={m._id} data-role={m.role}>{m.content}{m.error}</div>
      ))}
      {streaming && streamText === '' && <div data-testid="typing-dots" />}
    </div>
  )),
}));

const mockMessages: DesignMessage[] = [
  {
    _id: 'm1', designSessionId: 's1', role: 'user', content: 'Design a nav',
    status: 'completed', createdAt: '',
  },
  {
    _id: 'm2', designSessionId: 's1', role: 'assistant', content: 'Here is a design...',
    status: 'completed', createdAt: '',
  },
];

const passedConfig: DesignPreviewConfig = {
  enabled: true,
  workingDirectory: 'app',
  startCommand: 'npm run dev',
  portMode: 'auto',
  lastValidationStatus: 'passed',
};

const failedConfig: DesignPreviewConfig = {
  enabled: true,
  workingDirectory: 'app',
  startCommand: 'npm run dev',
  portMode: 'auto',
  lastValidationStatus: 'failed',
};

describe('DesignRunPanel', () => {
  it('renders messages via ChatMessageList', () => {
    render(<DesignRunPanel messages={mockMessages} />);
    expect(screen.getByText('Design a nav')).toBeInTheDocument();
    expect(screen.getByText('Here is a design...')).toBeInTheDocument();
  });

  it('shows design-specific empty state text when no messages', () => {
    render(<DesignRunPanel messages={[]} />);
    expect(screen.getByText(/Start a conversation to generate designs/i)).toBeInTheDocument();
  });

  it('does NOT show design-specific empty state when streaming (ChatMessageList handles it)', () => {
    const streamingMsg: DesignMessage = {
      _id: 'm-stream',
      designSessionId: 's1',
      role: 'assistant',
      content: '',
      status: 'streaming',
      createdAt: '',
    };
    render(<DesignRunPanel messages={[streamingMsg]} />);
    // Empty state should not appear — ChatMessageList renders streaming indicator
    expect(screen.queryByText(/Start a conversation to generate designs/i)).not.toBeInTheDocument();
  });

  it('does NOT use custom Loader2 spinner for streaming (uses ChatMessageList TypingDots instead)', () => {
    const streamingMsg: DesignMessage = {
      _id: 'm-stream',
      designSessionId: 's1',
      role: 'assistant',
      content: '',
      status: 'streaming',
      createdAt: '',
    };
    const { container } = render(<DesignRunPanel messages={[streamingMsg]} />);
    // No Loader2 (animate-spin) custom spinner — ChatMessageList handles loading UX
    const spinners = container.querySelectorAll('.animate-spin');
    expect(spinners.length).toBe(0);
    // Also verify "Working on this…" text is gone (old custom bubble text)
    expect(screen.queryByText(/Working on this/i)).not.toBeInTheDocument();
    // Verify ChatMessageList is rendered with streaming=true
    const list = screen.getByTestId('chat-message-list');
    expect(list.getAttribute('data-streaming')).toBe('true');
    // Typing dots indicator is shown for empty streamText
    expect(screen.getByTestId('typing-dots')).toBeInTheDocument();
  });

  it('preview button disabled with message when no config (AC-006)', () => {
    render(<DesignRunPanel messages={[]} />);
    expect(screen.getByText(/Preview command is not configured/i)).toBeInTheDocument();
    const previewBtn = screen.queryByRole('button', { name: /open preview/i });
    if (previewBtn) {
      expect(previewBtn).toBeDisabled();
    }
  });

  it('preview button enabled when validation passed (AC-008)', () => {
    const onPreviewClick = vi.fn();
    render(
      <DesignRunPanel
        messages={mockMessages}
        designRepoConfig={{ designPreviewConfig: passedConfig }}
        onPreviewClick={onPreviewClick}
      />,
    );
    const btn = screen.getByRole('button', { name: /open preview/i });
    expect(btn).not.toBeDisabled();
  });

  it('shows configure/retry action when validation failed (AC-007)', () => {
    render(
      <DesignRunPanel
        messages={[]}
        designRepoConfig={{ designPreviewConfig: failedConfig }}
      />,
    );
    expect(screen.getByText(/Configure \/ Retry/i)).toBeInTheDocument();
  });

  it('renders failed assistant message error text', () => {
    const failedMsg: DesignMessage = {
      _id: 'm-fail',
      designSessionId: 's1',
      role: 'assistant',
      content: '',
      status: 'failed',
      error: 'Dispatch failed: source_repo_path is required',
      createdAt: '',
    };
    render(<DesignRunPanel messages={[failedMsg]} />);
    expect(screen.getByText(/Dispatch failed/i)).toBeInTheDocument();
  });

  it('includes artifact filename as link in message when artifacts present', () => {
    const msgWithArtifacts: DesignMessage = {
      _id: 'm-art',
      designSessionId: 's1',
      role: 'assistant',
      content: 'Here are your designs.',
      status: 'completed',
      artifacts: [{ artifactId: 'a1', url: 'http://example.com/a1', filename: 'design.md' }],
      createdAt: '',
    };
    render(<DesignRunPanel messages={[msgWithArtifacts]} />);
    // Artifact link should appear (serialized as markdown link in content)
    expect(screen.getByText(/design\.md/i)).toBeInTheDocument();
  });
});
