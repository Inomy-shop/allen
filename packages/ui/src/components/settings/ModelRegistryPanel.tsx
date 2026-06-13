import { useMemo, useState } from 'react';
import {
  AlertCircle,
  Edit2,
  Loader2,
  Plus,
  Trash2,
  X,
} from 'lucide-react';
import Select from '../common/Select';
import { useEnabledProviders } from '../../hooks/useEnabledProviders';
import {
  useModelRegistry,
  type CreateModelInput,
  type ModelRegistryEntry,
  type UpdateModelInput,
  type UseModelRegistryReturn,
} from '../../hooks/useModelRegistry';
import { useAuthStore } from '../../stores/authStore';
import { useToast } from '../common/Toast';

const TIER_OPTIONS = [
  { value: '', label: 'None' },
  { value: 'default', label: 'Default' },
  { value: 'opus', label: 'Opus' },
  { value: 'flash', label: 'Flash' },
];

type ModelDraft = {
  fullId: string;
  displayName: string;
  providerDisplayName: string;
  costInputPerMTok: string;
  costOutputPerMTok: string;
  costCacheReadPerMTok: string;
  tier: string;
  sortOrder: string;
};

function draftFromEntry(entry: ModelRegistryEntry | null, providerLabel: string): ModelDraft {
  return {
    fullId: entry?.fullId ?? '',
    displayName: entry?.displayName ?? '',
    providerDisplayName: entry?.providerDisplayName ?? providerLabel,
    costInputPerMTok: entry?.costInputPerMTok != null ? String(entry.costInputPerMTok) : '',
    costOutputPerMTok: entry?.costOutputPerMTok != null ? String(entry.costOutputPerMTok) : '',
    costCacheReadPerMTok: entry?.costCacheReadPerMTok != null ? String(entry.costCacheReadPerMTok) : '',
    tier: entry?.tier ?? '',
    sortOrder: entry?.sortOrder != null ? String(entry.sortOrder) : '',
  };
}

function numberOrNull(value: string): number | null {
  const trimmed = value.trim();
  return trimmed ? Number(trimmed) : null;
}

function formatCost(value: number | null | undefined): string {
  if (value == null) return '-';
  return String(value);
}

function ModelDialog({
  mode,
  providerLabel,
  entry,
  onClose,
  onSubmit,
}: {
  mode: 'add' | 'edit';
  providerLabel: string;
  entry: ModelRegistryEntry | null;
  onClose: () => void;
  onSubmit: (draft: ModelDraft) => Promise<void>;
}) {
  const [draft, setDraft] = useState(() => draftFromEntry(entry, providerLabel));
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');

  function update(key: keyof ModelDraft, value: string) {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setFormError('');
    if (!draft.fullId.trim()) { setFormError('Full ID is required.'); return; }
    if (!draft.displayName.trim()) { setFormError('Display name is required.'); return; }
    if (!draft.providerDisplayName.trim()) { setFormError('Provider display name is required.'); return; }

    setSaving(true);
    try {
      await onSubmit(draft);
    } catch (err: unknown) {
      setFormError(err instanceof Error ? err.message : 'Failed to save model.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/55 p-4 backdrop-blur-sm" role="dialog" aria-modal="true">
      <form onSubmit={(event) => void handleSubmit(event)} className="model-registry-dialog">
        <div className="model-registry-dialog-head">
          <div>
            <h3>{mode === 'add' ? `Add ${providerLabel} Model` : 'Edit Model'}</h3>
            <p>{mode === 'add' ? 'Register a model for this provider.' : entry?.fullId}</p>
          </div>
          <button type="button" onClick={onClose} className="settings-icon-button" title="Close">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        {formError && (
          <div className="model-registry-alert">
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>{formError}</span>
          </div>
        )}

        <div className="model-registry-form-grid">
          <label>
            <span>Display name</span>
            <input
              type="text"
              value={draft.displayName}
              onChange={(event) => update('displayName', event.target.value)}
              placeholder="Claude Sonnet 4"
              className="settings-edit-input"
            />
          </label>
          <label>
            <span>Full ID</span>
            <input
              type="text"
              value={draft.fullId}
              onChange={(event) => update('fullId', event.target.value)}
              placeholder="claude-sonnet-4-20250514"
              className="settings-edit-input"
            />
          </label>
          <label>
            <span>Provider display name</span>
            <input
              type="text"
              value={draft.providerDisplayName}
              onChange={(event) => update('providerDisplayName', event.target.value)}
              placeholder={providerLabel}
              className="settings-edit-input"
            />
          </label>
          <label>
            <span>Tier</span>
            <Select value={draft.tier} onChange={(value) => update('tier', value)} options={TIER_OPTIONS} searchable={false} />
          </label>
          <label>
            <span>Input $/MTok</span>
            <input
              type="number"
              step="0.01"
              value={draft.costInputPerMTok}
              onChange={(event) => update('costInputPerMTok', event.target.value)}
              placeholder="3.00"
              className="settings-edit-input"
            />
          </label>
          <label>
            <span>Output $/MTok</span>
            <input
              type="number"
              step="0.01"
              value={draft.costOutputPerMTok}
              onChange={(event) => update('costOutputPerMTok', event.target.value)}
              placeholder="15.00"
              className="settings-edit-input"
            />
          </label>
          <label>
            <span>Cache read $/MTok</span>
            <input
              type="number"
              step="0.01"
              value={draft.costCacheReadPerMTok}
              onChange={(event) => update('costCacheReadPerMTok', event.target.value)}
              placeholder="0.30"
              className="settings-edit-input"
            />
          </label>
          <label>
            <span>Sort order</span>
            <input
              type="number"
              value={draft.sortOrder}
              onChange={(event) => update('sortOrder', event.target.value)}
              placeholder="0"
              className="settings-edit-input"
            />
          </label>
        </div>

        <div className="model-registry-dialog-actions">
          <button type="button" onClick={onClose} className="settings-secondary-button" disabled={saving}>
            Cancel
          </button>
          <button type="submit" className="settings-secondary-button settings-primary-save-button" disabled={saving}>
            {saving ? 'Saving...' : mode === 'add' ? 'Add model' : 'Save changes'}
          </button>
        </div>
      </form>
    </div>
  );
}

function DeleteModelDialog({
  entry,
  onCancel,
  onDelete,
}: {
  entry: ModelRegistryEntry;
  onCancel: () => void;
  onDelete: () => Promise<void>;
}) {
  const [deleting, setDeleting] = useState(false);

  async function handleDelete() {
    setDeleting(true);
    try {
      await onDelete();
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/55 p-4 backdrop-blur-sm" role="dialog" aria-modal="true">
      <div className="model-registry-confirm">
        <div className="model-registry-confirm-icon">
          <Trash2 className="h-4 w-4" />
        </div>
        <h3>Delete model?</h3>
        <p>
          This removes <strong>{entry.displayName || entry.fullId}</strong> from provider model selection. Existing references keep their stored model ID.
        </p>
        <div className="model-registry-dialog-actions">
          <button type="button" onClick={onCancel} className="settings-secondary-button" disabled={deleting}>
            Cancel
          </button>
          <button type="button" onClick={() => void handleDelete()} className="settings-danger-button" disabled={deleting}>
            {deleting ? 'Deleting...' : 'Delete model'}
          </button>
        </div>
      </div>
    </div>
  );
}

function ProviderModelsEmpty({ loading }: { loading: boolean }) {
  return (
    <div className="model-registry-empty">
      {loading ? (
        <>
          <Loader2 className="h-4 w-4 animate-spin" />
          <span>Loading models...</span>
        </>
      ) : (
        <span>No models registered for this provider.</span>
      )}
    </div>
  );
}

export function ProviderModelRegistrySection({
  modelRegistry,
  provider,
  providerLabel,
}: {
  modelRegistry: UseModelRegistryReturn;
  provider: string;
  providerLabel: string;
}) {
  const toast = useToast();
  const user = useAuthStore((state) => state.user);
  const isAdmin = user?.role === 'admin';
  const [showInactive, setShowInactive] = useState(false);
  const [dialog, setDialog] = useState<{ mode: 'add'; entry: null } | { mode: 'edit'; entry: ModelRegistryEntry } | null>(null);
  const [deleteEntry, setDeleteEntry] = useState<ModelRegistryEntry | null>(null);

  const providerModels = useMemo(() => {
    return modelRegistry.models
      .filter((model) => model.provider === provider && (showInactive || model.isActive))
      .sort((a, b) => {
        const bySort = (a.sortOrder ?? 0) - (b.sortOrder ?? 0);
        if (bySort !== 0) return bySort;
        return (a.displayName || a.fullId).localeCompare(b.displayName || b.fullId);
      });
  }, [modelRegistry.models, provider, showInactive]);

  async function handleCreate(draft: ModelDraft) {
    const payload: CreateModelInput = {
      provider,
      fullId: draft.fullId.trim(),
      displayName: draft.displayName.trim(),
      providerDisplayName: draft.providerDisplayName.trim(),
      costInputPerMTok: numberOrNull(draft.costInputPerMTok),
      costOutputPerMTok: numberOrNull(draft.costOutputPerMTok),
      costCacheReadPerMTok: numberOrNull(draft.costCacheReadPerMTok),
      tier: (draft.tier as CreateModelInput['tier']) || null,
      sortOrder: draft.sortOrder.trim() ? Number(draft.sortOrder) : undefined,
    };
    await modelRegistry.createModel(payload);
    toast.success(`Model "${payload.displayName}" created.`);
    setDialog(null);
  }

  async function handleUpdate(entry: ModelRegistryEntry, draft: ModelDraft) {
    const payload: Partial<UpdateModelInput> = {
      fullId: draft.fullId.trim(),
      displayName: draft.displayName.trim(),
      providerDisplayName: draft.providerDisplayName.trim(),
      costInputPerMTok: numberOrNull(draft.costInputPerMTok),
      costOutputPerMTok: numberOrNull(draft.costOutputPerMTok),
      costCacheReadPerMTok: numberOrNull(draft.costCacheReadPerMTok),
      tier: (draft.tier as UpdateModelInput['tier']) || null,
      sortOrder: draft.sortOrder.trim() ? Number(draft.sortOrder) : undefined,
    };
    await modelRegistry.updateModel(entry._id, payload);
    toast.success('Model updated.');
    setDialog(null);
  }

  async function handleDelete(entry: ModelRegistryEntry) {
    await modelRegistry.deleteModel(entry._id);
    if (showInactive) await modelRegistry.fetch({ includeInactive: true });
    toast.success('Model deleted.');
    setDeleteEntry(null);
  }

  if (!isAdmin) {
    return (
      <div className="model-registry-provider-section">
        <div className="model-registry-empty">Admin access required to manage provider models.</div>
      </div>
    );
  }

  return (
    <div className="model-registry-provider-section">
      <div className="model-registry-provider-head">
        <div>
          <h4>Provider Models</h4>
          <p>{providerModels.length} {providerModels.length === 1 ? 'model' : 'models'} shown</p>
        </div>
        <div className="model-registry-provider-actions">
          <label className="model-registry-inactive-toggle">
            <input
              type="checkbox"
              checked={showInactive}
              onChange={(event) => {
                const checked = event.target.checked;
                setShowInactive(checked);
                void modelRegistry.fetch({ includeInactive: checked });
              }}
            />
            <span>Inactive</span>
          </label>
          <button
            type="button"
            className="settings-secondary-button settings-primary-save-button"
            onClick={() => setDialog({ mode: 'add', entry: null })}
          >
            <Plus className="h-3.5 w-3.5" />
            Add model
          </button>
        </div>
      </div>

      {modelRegistry.error && (
        <div className="model-registry-alert">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{modelRegistry.error}</span>
        </div>
      )}

      {providerModels.length === 0 ? (
        <ProviderModelsEmpty loading={modelRegistry.loading} />
      ) : (
        <div className="model-registry-list">
          {providerModels.map((entry) => (
            <div key={entry._id} className={`model-registry-row ${entry.isActive ? '' : 'inactive'}`}>
              <div className="model-registry-row-main">
                <span className="model-registry-row-title">
                  {entry.displayName || entry.fullId}
                  {entry.tier && <span className="model-registry-tier">{entry.tier}</span>}
                  {!entry.isActive && <span className="model-registry-status">inactive</span>}
                </span>
                <span className="model-registry-row-id">{entry.fullId}</span>
              </div>
              <div className="model-registry-row-costs">
                <span>In {formatCost(entry.costInputPerMTok)}</span>
                <span>Out {formatCost(entry.costOutputPerMTok)}</span>
                <span>Cache {formatCost(entry.costCacheReadPerMTok)}</span>
              </div>
              <div className="model-registry-row-actions">
                <button
                  type="button"
                  className="settings-icon-button"
                  title="Edit model"
                  onClick={() => setDialog({ mode: 'edit', entry })}
                >
                  <Edit2 className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  className="settings-icon-button danger"
                  title="Delete model"
                  onClick={() => setDeleteEntry(entry)}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {dialog && (
        <ModelDialog
          mode={dialog.mode}
          providerLabel={providerLabel}
          entry={dialog.entry}
          onClose={() => setDialog(null)}
          onSubmit={(draft) => dialog.mode === 'add' ? handleCreate(draft) : handleUpdate(dialog.entry, draft)}
        />
      )}
      {deleteEntry && (
        <DeleteModelDialog
          entry={deleteEntry}
          onCancel={() => setDeleteEntry(null)}
          onDelete={() => handleDelete(deleteEntry)}
        />
      )}
    </div>
  );
}

export default function ModelRegistryPanel() {
  const user = useAuthStore((state) => state.user);
  const isAdmin = user?.role === 'admin';
  const enabledProviders = useEnabledProviders();
  const modelRegistry = useModelRegistry();

  const providerOptions = useMemo(() => {
    const byProvider = new Map<string, string>();
    for (const provider of enabledProviders) byProvider.set(provider.provider, provider.label);
    for (const model of modelRegistry.models) {
      if (!byProvider.has(model.provider)) byProvider.set(model.provider, model.providerDisplayName || model.provider);
    }
    return Array.from(byProvider.entries()).map(([value, label]) => ({ value, label }));
  }, [enabledProviders, modelRegistry.models]);

  if (!isAdmin) {
    return (
      <div className="rounded-md border border-app bg-app-card px-4 py-8 text-center text-[13px] text-theme-muted">
        Admin access required to manage the model registry.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {providerOptions.map((provider) => (
        <div key={provider.value} className="rounded-md border border-app bg-app-card">
          <ProviderModelRegistrySection
            modelRegistry={modelRegistry}
            provider={provider.value}
            providerLabel={provider.label}
          />
        </div>
      ))}
    </div>
  );
}
