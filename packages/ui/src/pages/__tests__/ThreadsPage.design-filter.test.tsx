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

describe('ThreadsPage — design session filtering', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('excludes design-assistant sessions from history', async () => {
    vi.mocked(chat.listSessions).mockResolvedValue([
      { _id: 's1', title: 'Normal chat', activeAgent: null, messageCount: 3, lastMessageAt: new Date().toISOString(), status: 'active', provider: 'codex' },
      { _id: 's2', title: 'Design session', activeAgent: 'design-assistant', messageCount: 2, lastMessageAt: new Date().toISOString(), status: 'active', provider: 'codex' },
    ] as any);

    render(
      <MemoryRouter>
        <ThreadsPage />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText('Normal chat')).toBeInTheDocument();
      expect(screen.queryByText('Design session')).not.toBeInTheDocument();
    });
  });

  it('includes sessions with no activeAgent in history', async () => {
    vi.mocked(chat.listSessions).mockResolvedValue([
      { _id: 's3', title: 'Engineering chat', activeAgent: null, messageCount: 1, lastMessageAt: new Date().toISOString(), status: 'active', provider: 'codex' },
    ] as any);

    render(
      <MemoryRouter>
        <ThreadsPage />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText('Engineering chat')).toBeInTheDocument();
    });
  });
});
