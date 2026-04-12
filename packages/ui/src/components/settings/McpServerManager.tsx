import { useState, useEffect, useRef } from 'react';
import { mcp as api, secrets as secretsApi } from '../../services/api';
import {
  Server, Plus, Trash2, RefreshCw, Power, PowerOff,
  CheckCircle, XCircle, HelpCircle, ExternalLink, ChevronDown, ChevronRight, Wrench,
  Lock, Upload, Loader2, Package, AlertCircle, X as XIcon,
} from 'lucide-react';

interface McpServer {
  _id: string;
  name: string;
  description: string;
  type: 'stdio' | 'sse' | 'http';
  enabled: boolean;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  status: 'connected' | 'failed' | 'untested' | 'disabled';
  lastTestedAt?: string;
  lastError?: string;
  serverInfo?: { name: string; version: string };
  toolCount?: number;
}

interface McpPreset {
  name: string;
  description: string;
  type: 'stdio' | 'sse';
  command?: string;
  args?: string[];
  envKeys: string[];
  /**
   * Map secret-key → actual env var name passed to the spawned child process.
   * Used when a single shared secret needs to appear under a different env var
   * name for one consumer (e.g. GITHUB_PERSONAL_ACCESS_TOKEN → GH_TOKEN for `gh`).
   */
  envVarOverrides?: Record<string, string>;
  argKeys?: string[];
  docsUrl: string;
}

const STATUS_STYLES: Record<string, { icon: React.ReactNode; color: string; label: string }> = {
  connected: { icon: <CheckCircle className="w-3.5 h-3.5" />, color: 'text-accent-green', label: 'Connected' },
  failed: { icon: <XCircle className="w-3.5 h-3.5" />, color: 'text-accent-red', label: 'Failed' },
  untested: { icon: <HelpCircle className="w-3.5 h-3.5" />, color: 'text-theme-muted', label: 'Untested' },
  disabled: { icon: <PowerOff className="w-3.5 h-3.5" />, color: 'text-theme-subtle', label: 'Disabled' },
};

function StatusBadge({ status }: { status: string }) {
  const s = STATUS_STYLES[status] ?? STATUS_STYLES.untested;
  return (
    <span className={`flex items-center gap-1 text-[10px] font-mono ${s.color}`}>
      {s.icon} {s.label}
    </span>
  );
}

function ServerCard({
  server, onToggle, onTest, onDelete, testing,
}: {
  server: McpServer; onToggle: () => void; onTest: () => void; onDelete: () => void; testing: boolean;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className={`border rounded-lg overflow-hidden transition-colors ${server.enabled ? 'border-border/40 bg-surface-100/60' : 'border-border/20 bg-surface-100/30 opacity-60'}`}>
      <div className="flex items-center gap-3 px-4 py-3">
        <button onClick={() => setExpanded(!expanded)} className="text-theme-muted hover:text-theme-secondary" title={expanded ? 'Collapse details' : 'Expand details'}>
          {expanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
        </button>
        <Server className={`w-4 h-4 shrink-0 ${server.enabled ? 'text-accent-blue' : 'text-theme-subtle'}`} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-body text-theme-primary">{server.name}</span>
            <span className="text-[10px] font-mono text-theme-subtle bg-surface-200/50 px-1.5 py-0.5 rounded">{server.type}</span>
            {server.toolCount != null && server.toolCount > 0 && (
              <span className="text-[10px] font-mono text-theme-subtle flex items-center gap-0.5">
                <Wrench className="w-2.5 h-2.5" />{server.toolCount} tools
              </span>
            )}
          </div>
          <div className="text-[11px] text-theme-muted font-body truncate">{server.description}</div>
        </div>
        <StatusBadge status={server.status} />
        <div className="flex items-center gap-1">
          <button
            onClick={onTest}
            disabled={!server.enabled || testing}
            className="p-1.5 rounded-md hover:bg-surface-200/60 text-theme-muted hover:text-accent-blue disabled:opacity-30 transition-colors"
            title="Test connection"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${testing ? 'animate-spin' : ''}`} />
          </button>
          <button
            onClick={onToggle}
            className="p-1.5 rounded-md hover:bg-surface-200/60 text-theme-muted hover:text-accent-yellow transition-colors"
            title={server.enabled ? 'Disable' : 'Enable'}
          >
            {server.enabled ? <Power className="w-3.5 h-3.5" /> : <PowerOff className="w-3.5 h-3.5" />}
          </button>
          <button
            onClick={onDelete}
            className="p-1.5 rounded-md hover:bg-red-500/10 text-theme-muted hover:text-red-400 transition-colors"
            title="Delete"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {expanded && (
        <div className="px-4 py-3 border-t border-border/20 bg-surface-200/20 space-y-2 text-xs">
          {server.type === 'stdio' && (
            <>
              {/* Command with secret refs masked */}
              <div>
                <span className="text-theme-muted">Command:</span>{' '}
                <span className="text-theme-secondary font-mono">
                  {server.command}{' '}
                  {(server.args ?? []).map((a, i) => {
                    if (typeof a === 'string' && a.startsWith('@secret:')) {
                      const key = a.slice('@secret:'.length);
                      return (
                        <span key={i} className="inline-flex items-center gap-1 bg-accent-green/10 text-accent-green px-1.5 py-0.5 rounded mr-1" title={`Linked to secret: ${key}`}>
                          <Lock className="w-2.5 h-2.5" /> {key}
                        </span>
                      );
                    }
                    return <span key={i} className="mr-1">{a}</span>;
                  })}
                </span>
              </div>
              {/* Env vars with secret linkage */}
              {server.env && Object.keys(server.env).length > 0 && (
                <div>
                  <span className="text-theme-muted">Env vars:</span>
                  <div className="mt-1 space-y-0.5 pl-2">
                    {Object.entries(server.env).map(([envName, val]) => {
                      const isSecret = typeof val === 'string' && val.startsWith('@secret:');
                      const secretKey = isSecret ? val.slice('@secret:'.length) : null;
                      return (
                        <div key={envName} className="flex items-center gap-2 font-mono text-[11px]">
                          <span className="text-theme-secondary">{envName}</span>
                          <span className="text-theme-subtle">→</span>
                          {isSecret ? (
                            <span className="inline-flex items-center gap-1 bg-accent-green/10 text-accent-green px-1.5 py-0.5 rounded">
                              <Lock className="w-2.5 h-2.5" /> {secretKey}
                            </span>
                          ) : (
                            <span className="text-amber-400">{val as string} (literal)</span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </>
          )}
          {(server.type === 'sse' || server.type === 'http') && (
            <div><span className="text-theme-muted">URL:</span> <span className="text-theme-secondary font-mono">{server.url}</span></div>
          )}
          {server.serverInfo && (
            <div><span className="text-theme-muted">Server:</span> <span className="text-theme-secondary">{server.serverInfo.name} v{server.serverInfo.version}</span></div>
          )}
          {server.lastError && (
            <div className="text-red-400 font-mono">{server.lastError}</div>
          )}
          {server.lastTestedAt && (
            <div className="text-theme-subtle">Last tested: {new Date(server.lastTestedAt).toLocaleString()}</div>
          )}
        </div>
      )}
    </div>
  );
}

/** Sentinel used in env/arg values to indicate "look up this secret at spawn time" */
const SECRET_REF_PREFIX = '@secret:';
const FLOWFORGE_PREFIX = 'FLOWFORGE_';

/**
 * One field in the preset form. Always references a secret (by key).
 * The key MUST already exist in the secret store — enforced by the UI,
 * which only lets users pick existing secrets or create new ones via dialog.
 */
type FieldState = { selectedKey: string };

/**
 * Inline dialog to create a new FLOWFORGE_-prefixed secret without leaving
 * the MCP add-server flow.
 */
function NewSecretDialog({
  defaultKey, onClose, onCreated,
}: {
  defaultKey: string;
  onClose: () => void;
  onCreated: (key: string) => void;
}) {
  const [key, setKey] = useState(defaultKey);
  const [value, setValue] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const handleSave = async () => {
    if (!key.trim() || !value.trim()) return;
    const finalKey = key.startsWith(FLOWFORGE_PREFIX) ? key : FLOWFORGE_PREFIX + key;
    setSaving(true); setError('');
    try {
      await secretsApi.create(finalKey, value);
      onCreated(finalKey);
    } catch (e: any) {
      setError(e.message ?? 'Failed to create secret');
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-surface-100 border border-border/40 rounded-lg p-4 w-[440px]" onClick={e => e.stopPropagation()}>
        <h3 className="text-sm font-body text-theme-primary mb-3 flex items-center gap-2">
          <Lock className="w-4 h-4 text-accent-green" /> New Secret
        </h3>
        <div className="space-y-2">
          <div>
            <label className="text-[10px] font-label uppercase tracking-wider text-theme-muted mb-1 block">Key</label>
            <input
              value={key}
              onChange={e => setKey(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, ''))}
              placeholder="FLOWFORGE_MY_TOKEN"
              autoFocus
              className="w-full bg-surface-200/50 border border-border/30 rounded-sm px-3 py-1.5 text-sm text-theme-primary font-mono"
            />
            <p className="text-[9px] text-theme-subtle mt-0.5">Auto-prefixed with FLOWFORGE_ if missing.</p>
          </div>
          <div>
            <label className="text-[10px] font-label uppercase tracking-wider text-theme-muted mb-1 block">Value</label>
            <input
              type="password"
              value={value}
              onChange={e => setValue(e.target.value)}
              placeholder="secret value..."
              autoComplete="new-password"
              className="w-full bg-surface-200/50 border border-border/30 rounded-sm px-3 py-1.5 text-sm text-theme-primary font-mono"
            />
          </div>
          {error && <p className="text-[11px] text-red-400">{error}</p>}
        </div>
        <div className="flex items-center gap-2 justify-end mt-3">
          <button onClick={onClose} className="btn-ghost text-xs py-1.5 px-3">Cancel</button>
          <button onClick={handleSave} disabled={!key.trim() || !value.trim() || saving} className="btn-primary text-xs py-1.5 px-4 disabled:opacity-50">
            {saving ? 'Saving...' : 'Create Secret'}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Dropdown to pick an existing FLOWFORGE_-prefixed secret, with an inline
 * "+ New secret" option that opens NewSecretDialog.
 */
function SecretPicker({
  fieldKey, state, flowforgeSecrets, onChange, onSecretCreated,
}: {
  fieldKey: string;
  state: FieldState;
  flowforgeSecrets: string[];
  onChange: (next: FieldState) => void;
  onSecretCreated: (key: string) => void;
}) {
  const [showNew, setShowNew] = useState(false);
  // Default key suggestion: if fieldKey already starts with FLOWFORGE_, use it;
  // otherwise prefix it.
  const defaultNewKey = fieldKey.startsWith(FLOWFORGE_PREFIX) ? fieldKey : FLOWFORGE_PREFIX + fieldKey;

  return (
    <div>
      <label className="text-[10px] font-label uppercase tracking-wider text-theme-muted mb-1 block">{fieldKey}</label>
      <div className="flex items-center gap-2">
        <select
          value={state.selectedKey}
          onChange={e => {
            if (e.target.value === '__new__') setShowNew(true);
            else onChange({ selectedKey: e.target.value });
          }}
          className="flex-1 bg-surface-200/50 border border-border/30 rounded-sm px-3 py-1.5 text-sm text-theme-primary font-mono focus:outline-none focus:border-accent-blue/50"
        >
          <option value="">— select secret —</option>
          {flowforgeSecrets.map(k => (
            <option key={k} value={k}>{k}</option>
          ))}
          <option value="__new__">+ New secret…</option>
        </select>
        {state.selectedKey && (
          <span className="flex items-center gap-1 text-[10px] text-accent-green">
            <Lock className="w-3 h-3" /> linked
          </span>
        )}
      </div>
      {showNew && (
        <NewSecretDialog
          defaultKey={defaultNewKey}
          onClose={() => setShowNew(false)}
          onCreated={(key) => {
            onSecretCreated(key);
            onChange({ selectedKey: key });
            setShowNew(false);
          }}
        />
      )}
    </div>
  );
}

function AddFromPreset({
  presets, flowforgeSecrets, onSecretCreated, onAdd,
}: {
  presets: McpPreset[];
  flowforgeSecrets: string[];
  onSecretCreated: (key: string) => void;
  onAdd: (preset: McpPreset, envFields: Record<string, FieldState>, argFields: Record<string, FieldState>) => void;
}) {
  const [selected, setSelected] = useState<McpPreset | null>(null);
  const [envFields, setEnvFields] = useState<Record<string, FieldState>>({});
  const [argFields, setArgFields] = useState<Record<string, FieldState>>({});

  // Initialize fields when a preset is picked. Auto-select a matching
  // FLOWFORGE_-prefixed secret if one exists, otherwise leave empty (user
  // must pick one from the dropdown or create a new secret).
  const choosePreset = (p: McpPreset) => {
    const initEnv: Record<string, FieldState> = {};
    for (const k of p.envKeys) {
      initEnv[k] = { selectedKey: flowforgeSecrets.includes(k) ? k : '' };
    }
    const initArgs: Record<string, FieldState> = {};
    for (const k of (p.argKeys ?? [])) {
      initArgs[k] = { selectedKey: flowforgeSecrets.includes(k) ? k : '' };
    }
    setSelected(p);
    setEnvFields(initEnv);
    setArgFields(initArgs);
  };

  if (!selected) {
    return (
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
        {presets.map(p => (
          <button
            key={p.name}
            onClick={() => choosePreset(p)}
            className="flex flex-col gap-1 px-3 py-2.5 rounded-lg bg-surface-200/30 border border-border/30 hover:bg-surface-200/60 hover:border-accent-blue/30 transition-all text-left"
          >
            <span className="text-sm font-body text-theme-primary">{p.name}</span>
            <span className="text-[10px] text-theme-muted font-body">{p.description}</span>
          </button>
        ))}
      </div>
    );
  }

  // A field is "filled" if the user has picked a secret
  const isFilled = (s?: FieldState) => !!s && !!s.selectedKey;
  const allEnvFilled = selected.envKeys.every(k => isFilled(envFields[k]));
  const allArgsFilled = (selected.argKeys ?? []).every(k => isFilled(argFields[k]));

  return (
    <div className="border border-border/40 rounded-lg p-4 bg-surface-200/20 space-y-3">
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-body text-theme-primary">Configure {selected.name}</h4>
        <button onClick={() => setSelected(null)} className="text-xs text-theme-muted hover:text-theme-secondary">Cancel</button>
      </div>
      <p className="text-[11px] text-theme-muted">{selected.description}</p>

      {/* Connection strings (positional args) */}
      {(selected.argKeys ?? []).map(key => (
        <SecretPicker
          key={key}
          fieldKey={key}
          state={argFields[key] ?? { selectedKey: '' }}
          flowforgeSecrets={flowforgeSecrets}
          onSecretCreated={onSecretCreated}
          onChange={next => setArgFields(prev => ({ ...prev, [key]: next }))}
        />
      ))}

      {/* Env vars (API keys, tokens) */}
      {selected.envKeys.map(key => (
        <SecretPicker
          key={key}
          fieldKey={key}
          state={envFields[key] ?? { selectedKey: '' }}
          flowforgeSecrets={flowforgeSecrets}
          onSecretCreated={onSecretCreated}
          onChange={next => setEnvFields(prev => ({ ...prev, [key]: next }))}
        />
      ))}

      <div className="flex items-center gap-2">
        <button
          onClick={() => { onAdd(selected, envFields, argFields); setSelected(null); }}
          disabled={!allEnvFilled || !allArgsFilled}
          className="btn-primary text-xs px-3 py-1.5 disabled:opacity-30"
        >
          Add Server
        </button>
        <a href={selected.docsUrl} target="_blank" rel="noopener noreferrer" className="text-[10px] text-accent-blue hover:text-accent-blue/80 flex items-center gap-1">
          <ExternalLink className="w-3 h-3" /> Docs
        </a>
      </div>
    </div>
  );
}

// ─── Upload Bundle Form ──────────────────────────────────────────────────

interface BundleMeta {
  bundleId: string;
  originalName: string;
  uploadedAt: string;
  entry: string;
  candidateEntries: string[];
  status: 'extracting' | 'installing' | 'ready' | 'failed';
  error?: string;
  installLog?: string;
}

type EnvRow = { id: number; name: string; selectedKey: string };

function UploadBundleForm({
  flowforgeSecrets, onSecretCreated, onAdded,
}: {
  flowforgeSecrets: string[];
  onSecretCreated: (key: string) => void;
  onAdded: () => void;
}) {
  const [bundle, setBundle] = useState<BundleMeta | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const [dragOver, setDragOver] = useState(false);

  // Form fields (stage 4)
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [envRows, setEnvRows] = useState<EnvRow[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Poll for install status
  useEffect(() => {
    if (!bundle || (bundle.status !== 'extracting' && bundle.status !== 'installing')) return;
    const interval = setInterval(async () => {
      try {
        const updated = await api.getBundle(bundle.bundleId);
        setBundle(updated);
        if (updated.status === 'ready' || updated.status === 'failed') {
          clearInterval(interval);
        }
      } catch {}
    }, 2000);
    return () => clearInterval(interval);
  }, [bundle]);

  const handleUpload = async (file: File) => {
    setUploading(true);
    setUploadError('');
    try {
      const meta = await api.uploadBundle(file);
      setBundle(meta);
      // Auto-derive name from filename (strip .zip)
      const baseName = file.name.replace(/\.zip$/i, '').replace(/[^a-z0-9-_]/gi, '-').toLowerCase();
      setName(baseName);
    } catch (e: any) {
      setUploadError(e.message ?? 'Upload failed');
    }
    setUploading(false);
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) handleUpload(f);
    e.target.value = '';
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const f = e.dataTransfer.files[0];
    if (f) handleUpload(f);
  };

  const handleDiscard = async () => {
    if (!bundle) return;
    try { await api.deleteBundle(bundle.bundleId); } catch {}
    setBundle(null);
    setName('');
    setDescription('');
    setEnvRows([]);
    setUploadError('');
    setSubmitError('');
  };

  const handleEntryChange = async (entry: string) => {
    if (!bundle) return;
    try {
      const updated = await api.setBundleEntry(bundle.bundleId, entry);
      setBundle(updated);
    } catch (e: any) {
      setUploadError(e.message ?? 'Failed to update entry');
    }
  };

  const addEnvRow = () => {
    setEnvRows(prev => [...prev, { id: Date.now() + Math.random(), name: '', selectedKey: '' }]);
  };
  const updateEnvRow = (id: number, patch: Partial<EnvRow>) => {
    setEnvRows(prev => prev.map(r => r.id === id ? { ...r, ...patch } : r));
  };
  const removeEnvRow = (id: number) => {
    setEnvRows(prev => prev.filter(r => r.id !== id));
  };

  const handleSubmit = async () => {
    if (!bundle) return;
    if (!name.trim()) { setSubmitError('Name is required'); return; }
    setSubmitting(true);
    setSubmitError('');
    try {
      const env: Record<string, string> = {};
      for (const row of envRows) {
        if (row.name.trim() && row.selectedKey) {
          env[row.name.trim()] = `@secret:${row.selectedKey}`;
        }
      }
      await api.create({
        name: name.trim(),
        description: description.trim(),
        type: 'stdio',
        enabled: true,
        env,
        bundleId: bundle.bundleId,
      });
      onAdded();
    } catch (e: any) {
      setSubmitError(e.message ?? 'Failed to create server');
    }
    setSubmitting(false);
  };

  // ── Render stages ──

  // Stage 1: no bundle yet — drop zone
  if (!bundle) {
    return (
      <div>
        <input ref={fileInputRef} type="file" accept=".zip" className="hidden" onChange={handleFileChange} />
        <div
          onDragOver={e => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={handleDrop}
          onClick={() => fileInputRef.current?.click()}
          className={`border-2 border-dashed rounded-lg p-8 text-center cursor-pointer transition-colors ${dragOver ? 'border-accent-blue bg-accent-blue/5' : 'border-border/40 hover:border-accent-blue/30 hover:bg-surface-200/30'}`}
        >
          {uploading ? (
            <div className="flex items-center justify-center gap-2 text-theme-secondary">
              <Loader2 className="w-5 h-5 animate-spin" />
              <span className="text-sm">Uploading & extracting...</span>
            </div>
          ) : (
            <>
              <Upload className="w-8 h-8 mx-auto mb-2 text-theme-muted" />
              <p className="text-sm text-theme-secondary font-body">Drop .zip file here or click to browse</p>
              <p className="text-[11px] text-theme-subtle mt-1">Max 100MB. Do not include node_modules/ — we install it for you.</p>
            </>
          )}
        </div>
        {uploadError && (
          <div className="mt-2 flex items-start gap-2 text-[11px] text-red-400">
            <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
            <span>{uploadError}</span>
          </div>
        )}
      </div>
    );
  }

  // Stage 2/3: extracting or installing
  if (bundle.status === 'extracting' || bundle.status === 'installing') {
    return (
      <div className="border border-border/30 rounded-lg p-4 space-y-2">
        <div className="flex items-center gap-2">
          <Package className="w-4 h-4 text-theme-muted" />
          <span className="text-sm text-theme-secondary">{bundle.originalName}</span>
          <span className="flex-1" />
          <button onClick={handleDiscard} className="text-[10px] text-theme-muted hover:text-red-400">Discard</button>
        </div>
        <div className="flex items-center gap-2 text-xs text-theme-muted">
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
          {bundle.status === 'extracting' ? 'Extracting bundle...' : 'Running npm install...'}
        </div>
      </div>
    );
  }

  // Stage 5: failed
  if (bundle.status === 'failed') {
    return (
      <div className="border border-red-500/30 bg-red-500/5 rounded-lg p-4 space-y-2">
        <div className="flex items-center gap-2">
          <AlertCircle className="w-4 h-4 text-red-400" />
          <span className="text-sm text-red-400">{bundle.originalName} — Failed</span>
          <span className="flex-1" />
          <button onClick={handleDiscard} className="text-[10px] text-theme-muted hover:text-red-400">Discard</button>
        </div>
        <div className="text-xs text-red-400 font-mono">{bundle.error}</div>
        {bundle.installLog && (
          <pre className="text-[10px] text-theme-muted bg-black/30 p-2 rounded max-h-40 overflow-auto font-mono whitespace-pre-wrap">{bundle.installLog}</pre>
        )}
      </div>
    );
  }

  // Stage 4: ready — show config form
  return (
    <div className="border border-border/40 rounded-lg p-4 bg-surface-200/20 space-y-3">
      <div className="flex items-center gap-2">
        <Package className="w-4 h-4 text-accent-green" />
        <span className="text-sm text-theme-primary font-body">{bundle.originalName}</span>
        <span className="text-[10px] text-theme-subtle">({bundle.candidateEntries.length} entry point{bundle.candidateEntries.length !== 1 ? 's' : ''})</span>
        <span className="flex-1" />
        <button onClick={handleDiscard} className="text-[10px] text-theme-muted hover:text-red-400">Discard</button>
      </div>

      {/* Entry point dropdown */}
      <div>
        <label className="text-[10px] font-label uppercase tracking-wider text-theme-muted mb-1 block">Entry Point</label>
        <select
          value={bundle.entry}
          onChange={e => handleEntryChange(e.target.value)}
          className="w-full bg-surface-200/50 border border-border/30 rounded-sm px-3 py-1.5 text-sm text-theme-primary font-mono"
        >
          {bundle.candidateEntries.map(e => <option key={e} value={e}>{e}</option>)}
        </select>
      </div>

      {/* Name */}
      <div>
        <label className="text-[10px] font-label uppercase tracking-wider text-theme-muted mb-1 block">Name</label>
        <input
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder="my-custom-server"
          className="w-full bg-surface-200/50 border border-border/30 rounded-sm px-3 py-1.5 text-sm text-theme-primary font-mono"
        />
      </div>

      {/* Description */}
      <div>
        <label className="text-[10px] font-label uppercase tracking-wider text-theme-muted mb-1 block">Description</label>
        <input
          value={description}
          onChange={e => setDescription(e.target.value)}
          placeholder="What does this server do?"
          className="w-full bg-surface-200/50 border border-border/30 rounded-sm px-3 py-1.5 text-sm text-theme-primary"
        />
      </div>

      {/* Env vars */}
      <div>
        <label className="text-[10px] font-label uppercase tracking-wider text-theme-muted mb-1 block">Environment Variables</label>
        {envRows.length === 0 && (
          <p className="text-[10px] text-theme-subtle mb-2">No env vars. Click "+ Add env var" if your server needs any.</p>
        )}
        <div className="space-y-2">
          {envRows.map(row => (
            <div key={row.id} className="flex items-start gap-2">
              <input
                value={row.name}
                onChange={e => updateEnvRow(row.id, { name: e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '') })}
                placeholder="API_BASE_URL"
                className="w-40 bg-surface-200/50 border border-border/30 rounded-sm px-2 py-1.5 text-xs text-theme-primary font-mono"
              />
              <span className="text-theme-subtle text-sm leading-8">→</span>
              <div className="flex-1">
                <SecretPicker
                  fieldKey={row.name || 'SECRET'}
                  state={{ selectedKey: row.selectedKey }}
                  flowforgeSecrets={flowforgeSecrets}
                  onSecretCreated={onSecretCreated}
                  onChange={next => updateEnvRow(row.id, { selectedKey: next.selectedKey })}
                />
              </div>
              <button onClick={() => removeEnvRow(row.id)} className="p-1.5 text-theme-muted hover:text-red-400">
                <XIcon className="w-3 h-3" />
              </button>
            </div>
          ))}
        </div>
        <button onClick={addEnvRow} className="mt-2 text-[11px] text-accent-blue hover:text-accent-blue/80 flex items-center gap-1">
          <Plus className="w-3 h-3" /> Add env var
        </button>
      </div>

      {/* Command preview */}
      <div className="text-[10px] text-theme-subtle font-mono bg-surface-200/30 p-2 rounded">
        node <span className="text-theme-muted">&lt;bundle&gt;/</span>{bundle.entry}
      </div>

      {submitError && (
        <div className="text-[11px] text-red-400 flex items-center gap-1">
          <AlertCircle className="w-3 h-3" /> {submitError}
        </div>
      )}

      <div className="flex items-center gap-2">
        <button
          onClick={handleSubmit}
          disabled={!name.trim() || submitting}
          className="btn-primary text-xs px-3 py-1.5 disabled:opacity-30"
        >
          {submitting ? 'Adding...' : 'Add Server'}
        </button>
      </div>
    </div>
  );
}

export default function McpServerManager() {
  const [servers, setServers] = useState<McpServer[]>([]);
  const [presets, setPresets] = useState<McpPreset[]>([]);
  const [flowforgeSecrets, setFlowforgeSecrets] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [addMode, setAddMode] = useState<'preset' | 'bundle'>('preset');
  const [testingId, setTestingId] = useState<string | null>(null);

  const loadServers = async () => {
    try {
      const [s, p, secretsList] = await Promise.all([
        api.list(),
        api.presets(),
        secretsApi.list().catch(() => [] as string[]),
      ]);
      setServers(s);
      setPresets(p);
      // Only expose FLOWFORGE_-prefixed secrets to the MCP picker
      setFlowforgeSecrets((secretsList ?? []).filter(k => k.startsWith(FLOWFORGE_PREFIX)).sort());
    } catch (e) {
      console.error('Failed to load MCP servers:', e);
    } finally {
      setLoading(false);
    }
  };

  const handleSecretCreated = (key: string) => {
    setFlowforgeSecrets(prev => prev.includes(key) ? prev : [...prev, key].sort());
  };

  useEffect(() => { loadServers(); }, []);

  const handleAddPreset = async (
    preset: McpPreset,
    envFields: Record<string, FieldState>,
    argFields: Record<string, FieldState>,
  ) => {
    try {
      // Each field references an existing secret (guaranteed by the UI).
      // Build env: <envVarName>: '@secret:<selectedSecretKey>'. The env var
      // name is the override target if specified, else the preset's declared key.
      const env: Record<string, string> = {};
      for (const presetKey of preset.envKeys) {
        const f = envFields[presetKey];
        if (!f?.selectedKey) continue;
        const envVarName = preset.envVarOverrides?.[presetKey] ?? presetKey;
        env[envVarName] = `${SECRET_REF_PREFIX}${f.selectedKey}`;
      }

      // Build args. Positional args appended in preset order.
      const args = [...(preset.args ?? [])];
      for (const presetKey of (preset.argKeys ?? [])) {
        const f = argFields[presetKey];
        if (!f?.selectedKey) continue;
        args.push(`${SECRET_REF_PREFIX}${f.selectedKey}`);
      }

      await api.create({
        name: preset.name,
        description: preset.description,
        type: preset.type,
        enabled: true,
        command: preset.command,
        args,
        env,
      });
      setShowAdd(false);
      void loadServers();
    } catch (e) {
      console.error('Failed to add MCP server:', e);
    }
  };

  const handleToggle = async (id: string) => {
    await api.toggle(id);
    loadServers();
  };

  const handleTest = async (id: string) => {
    setTestingId(id);
    try {
      await api.test(id);
    } catch {}
    setTestingId(null);
    loadServers();
  };

  const handleDelete = async (id: string) => {
    await api.delete(id);
    loadServers();
  };

  // Filter presets that aren't already added
  const availablePresets = presets.filter(p => !servers.some(s => s.name === p.name));

  if (loading) return <div className="text-xs text-theme-subtle animate-pulse py-4">Loading MCP servers...</div>;

  return (
    <div className="space-y-4">
      {/* Server list */}
      {servers.length === 0 && !showAdd && (
        <div className="text-center py-6 text-xs text-theme-subtle">
          No MCP servers configured. Add one to give the chat agent access to external tools.
        </div>
      )}

      <div className="space-y-2">
        {servers.map(s => (
          <ServerCard
            key={s._id}
            server={s}
            onToggle={() => handleToggle(s._id)}
            onTest={() => handleTest(s._id)}
            onDelete={() => handleDelete(s._id)}
            testing={testingId === s._id}
          />
        ))}
      </div>

      {/* Add server */}
      {showAdd ? (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-label uppercase tracking-widest text-theme-secondary">Add MCP Server</h3>
            <button onClick={() => setShowAdd(false)} className="text-xs text-theme-muted hover:text-theme-secondary">Cancel</button>
          </div>
          {/* Tab selector */}
          <div className="flex items-center gap-1 border-b border-border/20">
            <button
              onClick={() => setAddMode('preset')}
              className={`px-3 py-1.5 text-xs font-body border-b-2 transition-colors ${addMode === 'preset' ? 'border-accent-blue text-accent-blue' : 'border-transparent text-theme-muted hover:text-theme-secondary'}`}
            >
              From Preset
            </button>
            <button
              onClick={() => setAddMode('bundle')}
              className={`px-3 py-1.5 text-xs font-body border-b-2 transition-colors ${addMode === 'bundle' ? 'border-accent-blue text-accent-blue' : 'border-transparent text-theme-muted hover:text-theme-secondary'}`}
            >
              Upload Bundle
            </button>
          </div>
          {addMode === 'preset' && (
            availablePresets.length > 0 ? (
              <AddFromPreset presets={availablePresets} flowforgeSecrets={flowforgeSecrets} onSecretCreated={handleSecretCreated} onAdd={handleAddPreset} />
            ) : (
              <div className="text-xs text-theme-subtle">All preset servers have been added.</div>
            )
          )}
          {addMode === 'bundle' && (
            <UploadBundleForm
              flowforgeSecrets={flowforgeSecrets}
              onSecretCreated={handleSecretCreated}
              onAdded={() => { setShowAdd(false); void loadServers(); }}
            />
          )}
        </div>
      ) : (
        <button
          onClick={() => setShowAdd(true)}
          title="Add MCP server"
          className="flex items-center gap-2 px-3 py-2 rounded-lg border border-dashed border-border/40 hover:border-accent-blue/30 hover:bg-surface-200/30 transition-all text-theme-muted hover:text-theme-secondary w-full"
        >
          <Plus className="w-4 h-4" />
          <span className="text-xs font-body">Add MCP Server</span>
        </button>
      )}
    </div>
  );
}
