import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useModelRegistry } from '../useModelRegistry';

// ── Mock the api module ────────────────────────────────────────────────────

// vi.mock is hoisted, so use vi.hoisted to create the mock object first
const { mockModels } = vi.hoisted(() => {
  const list = vi.fn();
  const create = vi.fn();
  const update = vi.fn();
  const del = vi.fn();

  return {
    mockModels: { list, create, update, delete: del },
  };
});

vi.mock('../../services/api', () => ({
  system: {
    models: mockModels,
  },
}));

// ── Test data ──────────────────────────────────────────────────────────────

const activeCodexModel = {
  _id: '1',
  provider: 'codex',
  alias: 'gpt-5.5',
  fullId: 'gpt-5.5',
  displayName: 'GPT 5.5',
  isActive: true,
  sortOrder: 1,
};

const activeClaudeModel = {
  _id: '2',
  provider: 'claude',
  alias: 'sonnet',
  fullId: 'claude-sonnet-4-6',
  displayName: 'Claude Sonnet 4',
  isActive: true,
  sortOrder: 2,
};

const inactiveCodexModel = {
  _id: '3',
  provider: 'codex',
  alias: 'gpt-5.3-codex',
  fullId: 'gpt-5.3-codex',
  displayName: 'GPT 5.3 Codex',
  isActive: false,
  sortOrder: 3,
};

const allModels = [activeCodexModel, activeClaudeModel, inactiveCodexModel];

// ── Tests ──────────────────────────────────────────────────────────────────

describe('useModelRegistry (AC-002, REQ-013, AC-006)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockModels.list.mockResolvedValue({ models: allModels });
  });

  it('fetches models on mount and returns all models (AC-002)', async () => {
    const { result } = renderHook(() => useModelRegistry());

    // Initially loading
    expect(result.current.loading).toBe(true);

    // Wait for fetch to complete
    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.models).toHaveLength(3);
    expect(mockModels.list).toHaveBeenCalledTimes(1);
  });

  it('provides models filtered by provider via getModelsForProvider', async () => {
    const { result } = renderHook(() => useModelRegistry());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    const codexModels = result.current.getModelsForProvider('codex');
    // Should only include active codex models (not inactive)
    expect(codexModels).toHaveLength(1);
    expect(codexModels[0].value).toBe('gpt-5.5');
    expect(codexModels[0].label).toBe('GPT 5.5');
  });

  it('getModelsForProvider falls back to humanLabel when displayName is blank or whitespace', async () => {
    // Override mock for this test to include blank/whitespace displayNames
    mockModels.list.mockResolvedValue({
      models: [
        { _id: 'b1', provider: 'codex', fullId: 'gpt-5-blank', displayName: '', providerDisplayName: 'Codex', isActive: true, tier: 'default', sortOrder: 1 },
        { _id: 'b2', provider: 'codex', fullId: 'gpt-5-whitespace', displayName: '   ', providerDisplayName: 'Codex', isActive: true, tier: 'default', sortOrder: 2 },
      ],
    });

    const { result } = renderHook(() => useModelRegistry());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    const codexModels = result.current.getModelsForProvider('codex');
    expect(codexModels).toHaveLength(2);
    // Blank displayName → humanLabel(fullId)
    expect(codexModels[0].label).toBe('Gpt 5 Blank');
    expect(codexModels[0].value).toBe('gpt-5-blank');
    // Whitespace-only displayName → humanLabel(fullId)
    expect(codexModels[1].label).toBe('Gpt 5 Whitespace');
    expect(codexModels[1].value).toBe('gpt-5-whitespace');
  });

  it('deactivated models are excluded from getModelsForProvider output (AC-006)', async () => {
    const { result } = renderHook(() => useModelRegistry());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    const codexModels = result.current.getModelsForProvider('codex');
    const deactivated = codexModels.find((m) => m.value === 'gpt-5.3-codex');
    expect(deactivated).toBeUndefined();
  });

  it('getModelsForProvider returns empty array for unknown provider', async () => {
    const { result } = renderHook(() => useModelRegistry());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    const models = result.current.getModelsForProvider('unknown-provider');
    expect(models).toEqual([]);
  });

  it('handles fetch error gracefully', async () => {
    mockModels.list.mockRejectedValue(new Error('Network error'));

    const { result } = renderHook(() => useModelRegistry());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.error).toBe('Network error');
    expect(result.current.models).toEqual([]);
  });

  it('createModel calls API and refetches', async () => {
    const newModel = {
      _id: '4',
      provider: 'codex',
      alias: 'gpt-5.4',
      fullId: 'gpt-5.4',
      isActive: true,
    };
    mockModels.create.mockResolvedValue(newModel);
    // After create, the fetch is called again with updated data
    mockModels.list.mockResolvedValue({ models: [...allModels, newModel] });

    const { result } = renderHook(() => useModelRegistry());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    await act(async () => {
      await result.current.createModel({
        provider: 'codex',
        alias: 'gpt-5.4',
        fullId: 'gpt-5.4',
      });
    });

    expect(mockModels.create).toHaveBeenCalledTimes(1);
    // fetch (refetch) is called after create
    expect(mockModels.list).toHaveBeenCalledTimes(2);
  });

  it('updateModel calls API and refetches', async () => {
    const updated = { ...activeCodexModel, displayName: 'Updated' };
    mockModels.update.mockResolvedValue(updated);

    const { result } = renderHook(() => useModelRegistry());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    await act(async () => {
      await result.current.updateModel('1', { displayName: 'Updated' });
    });

    expect(mockModels.update).toHaveBeenCalledWith('1', { displayName: 'Updated' });
    expect(mockModels.list).toHaveBeenCalledTimes(2);
  });

  it('deleteModel calls API and refetches', async () => {
    mockModels.delete.mockResolvedValue({ deleted: true });

    const { result } = renderHook(() => useModelRegistry());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    await act(async () => {
      await result.current.deleteModel('1');
    });

    expect(mockModels.delete).toHaveBeenCalledWith('1');
    expect(mockModels.list).toHaveBeenCalledTimes(2);
  });

  it('refetches when fetch is called with custom filters', async () => {
    const { result } = renderHook(() => useModelRegistry());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    mockModels.list.mockClear();

    await act(async () => {
      await result.current.fetch({ provider: 'codex', includeInactive: true });
    });

    expect(mockModels.list).toHaveBeenCalledWith({
      provider: 'codex',
      includeInactive: true,
    });
  });
});
