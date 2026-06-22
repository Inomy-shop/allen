import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import ModelRecoveryPrompt from './ModelRecoveryPrompt';

// ── Mocks ──────────────────────────────────────────────────────────────

const mockRecoverModel = vi.fn();
const mockCancel = vi.fn();

vi.mock('../../services/api', () => ({
  executions: {
    recoverModel: (...args: unknown[]) => mockRecoverModel(...args),
    cancel: (...args: unknown[]) => mockCancel(...args),
  },
}));

vi.mock('../../hooks/useModelRegistry', () => ({
  useModelRegistry: () => ({
    models: [
      { provider: 'claude', fullId: 'claude-sonnet-4-6', isActive: true, displayName: 'Sonnet 4.6', providerDisplayName: 'Claude' },
      { provider: 'claude', fullId: 'claude-opus-4-7', isActive: true, displayName: 'Opus 4.7', providerDisplayName: 'Claude' },
      { provider: 'claude', fullId: 'claude-haiku-4-5', isActive: true, displayName: 'Haiku 4.5', providerDisplayName: 'Claude' },
      { provider: 'codex', fullId: 'gpt-5.5', isActive: true, displayName: 'GPT 5.5', providerDisplayName: 'Codex' },
      { provider: 'codex', fullId: 'gpt-5.4', isActive: true, displayName: 'GPT 5.4', providerDisplayName: 'Codex' },
    ],
    loading: false,
    error: null,
    fetch: vi.fn(),
    getModelsForProvider: (provider: string) => {
      const map: Record<string, Array<{ label: string; value: string }>> = {
        claude: [
          { label: 'Sonnet 4.6', value: 'claude-sonnet-4-6' },
          { label: 'Opus 4.7', value: 'claude-opus-4-7' },
          { label: 'Haiku 4.5', value: 'claude-haiku-4-5' },
        ],
        codex: [
          { label: 'GPT 5.5', value: 'gpt-5.5' },
          { label: 'GPT 5.4', value: 'gpt-5.4' },
        ],
      };
      return map[provider] ?? [];
    },
    getDefaultModelForProvider: (provider: string) => provider === 'claude' ? 'claude-sonnet-4-6' : 'gpt-5.5',
    createModel: vi.fn(),
    updateModel: vi.fn(),
    deleteModel: vi.fn(),
  }),
  getModelDisplay: (provider: string, model?: string) => ({
    providerLabel: provider === 'claude' ? 'Claude' : provider === 'codex' ? 'Codex' : provider,
    modelLabel: model ?? '',
  }),
}));

vi.mock('../../lib/model-catalog', () => ({
  PROVIDER_COLORS: {
    claude: { color: 'text-accent', dotBg: 'bg-accent' },
    codex: { color: 'text-accent-green', dotBg: 'bg-accent-green' },
  },
}));

// ── Test data ──────────────────────────────────────────────────────────

const BASE_PROPS = {
  executionId: 'exec-123',
  node: 'my-node',
  failedProvider: 'claude',
  failedModel: 'claude-sonnet-4-6',
  failureCategory: 'rate_limit_exhausted',
  sanitizedError: 'Rate limit exceeded. Please try again later.',
  isParallelBranch: false,
  attempt: 2,
  maxAttempts: 3,
  onSubmitted: vi.fn(),
  onCancelled: vi.fn(),
};

// ── Tests ──────────────────────────────────────────────────────────────

describe('ModelRecoveryPrompt', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders header with node name and recovery badge', () => {
    render(<ModelRecoveryPrompt {...BASE_PROPS} />);
    expect(screen.getByText(/Model Recovery/)).toBeTruthy();
    expect(screen.getByText(/my-node/)).toBeTruthy();
    expect(screen.getByText('Recovery needed')).toBeTruthy();
  });

  it('renders failure category human label', () => {
    render(<ModelRecoveryPrompt {...BASE_PROPS} />);
    expect(screen.getByText('Rate limit exhausted')).toBeTruthy();
  });

  it('renders sanitized error in monospace box', () => {
    render(<ModelRecoveryPrompt {...BASE_PROPS} />);
    expect(screen.getByText('Rate limit exceeded. Please try again later.')).toBeTruthy();
  });

  it('renders failed provider and model chips', () => {
    render(<ModelRecoveryPrompt {...BASE_PROPS} />);
    expect(screen.getByText('Claude')).toBeTruthy();
  });

  it('renders sequential topology context by default', () => {
    render(<ModelRecoveryPrompt {...BASE_PROPS} />);
    expect(screen.getByText('Sequential node')).toBeTruthy();
  });

  it('renders parallel branch topology context when isParallelBranch is true', () => {
    render(
      <ModelRecoveryPrompt
        {...BASE_PROPS}
        isParallelBranch
        siblingBranches={['branch-a', 'branch-b']}
        joinPolicy="wait-all"
      />,
    );
    expect(screen.getByText(/Branch in parallel/)).toBeTruthy();
    expect(screen.getByText(/2 other branches preserved/)).toBeTruthy();
  });

  it('renders attempt counter', () => {
    render(<ModelRecoveryPrompt {...BASE_PROPS} />);
    expect(screen.getByText(/Attempt 2 of 3/)).toBeTruthy();
  });

  it('disables submit button until provider and model are selected', () => {
    render(<ModelRecoveryPrompt {...BASE_PROPS} />);
    // Provider defaults to failedProvider, model is empty → disabled
    const submitBtn = screen.getByRole('button', { name: /retry with selected model/i });
    expect(submitBtn).toBeDisabled();

    // Select a model should enable it
    const modelSelect = screen.getByLabelText(/select model/i);
    fireEvent.change(modelSelect, { target: { value: 'claude-opus-4-7' } });
    expect(submitBtn).not.toBeDisabled();
  });

  it('POSTs to recover-model endpoint on submit', async () => {
    mockRecoverModel.mockResolvedValueOnce({ status: 'ok' });
    const onSubmitted = vi.fn();

    render(
      <ModelRecoveryPrompt
        {...BASE_PROPS}
        onSubmitted={onSubmitted}
      />,
    );

    // Select a model first
    const modelSelect = screen.getByLabelText(/select model/i);
    fireEvent.change(modelSelect, { target: { value: 'claude-opus-4-7' } });

    // Click submit
    const submitBtn = screen.getByRole('button', { name: /retry with selected model/i });
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(mockRecoverModel).toHaveBeenCalledWith('exec-123', {
        node: 'my-node',
        provider: 'claude',
        model: 'claude-opus-4-7',
      });
    });
    expect(onSubmitted).toHaveBeenCalled();
  });

  it('POSTs cancel endpoint when cancel workflow is confirmed', async () => {
    mockCancel.mockResolvedValueOnce({ status: 'ok' });
    const onCancelled = vi.fn();

    render(
      <ModelRecoveryPrompt
        {...BASE_PROPS}
        onCancelled={onCancelled}
      />,
    );

    // Click cancel button → shows confirmation
    const cancelBtn = screen.getByRole('button', { name: /cancel workflow/i });
    fireEvent.click(cancelBtn);

    // Click confirm
    const confirmBtn = screen.getByRole('button', { name: /yes, cancel/i });
    fireEvent.click(confirmBtn);

    await waitFor(() => {
      expect(mockCancel).toHaveBeenCalledWith('exec-123');
    });
    expect(onCancelled).toHaveBeenCalled();
  });

  it('shows error message on submit failure', async () => {
    mockRecoverModel.mockRejectedValueOnce(new Error('Server error: model not available'));
    const onSubmitted = vi.fn();

    render(
      <ModelRecoveryPrompt
        {...BASE_PROPS}
        onSubmitted={onSubmitted}
      />,
    );

    // Select a model
    const modelSelect = screen.getByLabelText(/select model/i);
    fireEvent.change(modelSelect, { target: { value: 'claude-opus-4-7' } });

    // Click submit
    const submitBtn = screen.getByRole('button', { name: /retry with selected model/i });
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(screen.getByText(/server error/i)).toBeTruthy();
    });
    expect(onSubmitted).not.toHaveBeenCalled();
  });

  it('renders reasoning effort select', () => {
    render(<ModelRecoveryPrompt {...BASE_PROPS} />);
    expect(screen.getByLabelText(/reasoning effort/i)).toBeTruthy();
  });

  it('includes reasoningEffort in request body when selected', async () => {
    mockRecoverModel.mockResolvedValueOnce({ status: 'ok' });

    render(<ModelRecoveryPrompt {...BASE_PROPS} />);

    // Select a model
    const modelSelect = screen.getByLabelText(/select model/i);
    fireEvent.change(modelSelect, { target: { value: 'claude-opus-4-7' } });

    // Select reasoning effort
    const effortSelect = screen.getByLabelText(/reasoning effort/i);
    fireEvent.change(effortSelect, { target: { value: 'high' } });

    // Click submit
    const submitBtn = screen.getByRole('button', { name: /retry with selected model/i });
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(mockRecoverModel).toHaveBeenCalledWith('exec-123', {
        node: 'my-node',
        provider: 'claude',
        model: 'claude-opus-4-7',
        reasoningEffort: 'high',
      });
    });
  });
});
