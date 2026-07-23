import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import ThreadsPage from '../ThreadsPage';

vi.mock('../../services/api', () => ({
  chat: {
    listSessions: vi.fn(),
  },
  users: {
    list: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock('../../stores/authStore', () => ({
  useAuthStore: (selector: any) => selector({ user: { id: 'u1', name: 'Test', email: 'test@x.com' } }),
}));

const { chat } = await import('../../services/api');

describe('ThreadsPage — Studio session routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('includes Studio sessions and routes them back to Studio', async () => {
    vi.mocked(chat.listSessions).mockResolvedValue([
      { _id: 's1', title: 'Normal chat', activeAgent: null, messageCount: 3, lastMessageAt: new Date().toISOString(), status: 'active', provider: 'codex' },
      { _id: 's2', title: 'Design session', activeAgent: 'design-assistant', studioWorkspaceId: 'ws/design 1', teamClassification: 'design', messageCount: 2, lastMessageAt: new Date().toISOString(), status: 'active', provider: 'codex' },
    ] as any);

    render(
      <MemoryRouter>
        <ThreadsPage />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText('Normal chat')).toBeInTheDocument();
      expect(screen.getByText('Design session')).toBeInTheDocument();
    });
    expect(chat.listSessions).toHaveBeenCalledWith({ includeStudio: true });
    expect(screen.getByRole('link', { name: /Design session/i })).toHaveAttribute(
      'href',
      '/studio/sessions/s2?ws=ws%2Fdesign%201',
    );
    expect(screen.getByRole('link', { name: /Normal chat/i })).toHaveAttribute('href', '/chat/s1');
  });

  it('keeps a normal chat on the chat route even when classified Design', async () => {
    vi.mocked(chat.listSessions).mockResolvedValue([
      { _id: 's3', title: 'Design-labelled normal chat', teamClassification: 'design', activeAgent: null, messageCount: 1, lastMessageAt: new Date().toISOString(), status: 'active', provider: 'codex' },
    ] as any);

    render(
      <MemoryRouter>
        <ThreadsPage />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText('Design-labelled normal chat')).toBeInTheDocument();
    });
    expect(screen.getByRole('link', { name: /Design-labelled normal chat/i })).toHaveAttribute('href', '/chat/s3');
  });
});
