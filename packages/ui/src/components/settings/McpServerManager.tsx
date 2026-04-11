import { useState, useEffect } from 'react';
import { mcp as api, secrets as secretsApi } from '../../services/api';
import {
  Server, Plus, Trash2, RefreshCw, Power, PowerOff,
  CheckCircle, XCircle, HelpCircle, ExternalLink, ChevronDown, ChevronRight, Wrench,
  Lock, Pencil,
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
              <div><span className="text-theme-muted">Command:</span> <span className="text-theme-secondary font-mono">{server.command} {(server.args ?? []).join(' ')}</span></div>
              {server.env && Object.keys(server.env).length > 0 && (
                <div><span className="text-theme-muted">Env vars:</span> <span className="text-theme-secondary font-mono">{Object.keys(server.env).join(', ')}</span></div>
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

/**
 * One field in the preset form. Can either be linked to an existing secret
 * (auto-detected by name) or hold a literal value the user is typing.
 */
type FieldMode = 'use-existing' | 'enter-new';
type FieldState = { mode: FieldMode; value: string };

function PresetField({
  fieldKey, state, hasExistingSecret, placeholder, secret, onChange,
}: {
  fieldKey: string;
  state: FieldState;
  hasExistingSecret: boolean;
  placeholder?: string;
  secret: boolean; // password input vs text
  onChange: (next: FieldState) => void;
}) {
  // Auto-link mode: there's already a secret with this exact name in the store
  if (state.mode === 'use-existing') {
    return (
      <div>
        <label className="text-[10px] font-label uppercase tracking-wider text-theme-muted mb-1 block">{fieldKey}</label>
        <div className="flex items-center gap-2 bg-accent-green/5 border border-accent-green/30 rounded-sm px-3 py-1.5">
          <Lock className="w-3 h-3 text-accent-green shrink-0" />
          <span className="text-xs font-mono text-accent-green flex-1">Using saved secret <span className="text-theme-primary">{fieldKey}</span></span>
          <button
            onClick={() => onChange({ mode: 'enter-new', value: '' })}
            className="text-[10px] text-theme-muted hover:text-theme-secondary flex items-center gap-0.5"
            title="Replace with a new value"
            type="button"
          >
            <Pencil className="w-2.5 h-2.5" /> Replace
          </button>
        </div>
      </div>
    );
  }

  // Manual entry mode (no existing secret, OR user clicked Replace)
  return (
    <div>
      <label className="text-[10px] font-label uppercase tracking-wider text-theme-muted mb-1 block">
        {fieldKey}
        {hasExistingSecret && (
          <button
            onClick={() => onChange({ mode: 'use-existing', value: '' })}
            className="ml-2 text-[10px] normal-case tracking-normal text-accent-blue hover:text-accent-blue/80"
            type="button"
          >
            ← use saved secret
          </button>
        )}
      </label>
      <input
        type={secret ? 'password' : 'text'}
        value={state.value}
        onChange={e => onChange({ mode: 'enter-new', value: e.target.value })}
        placeholder={placeholder ?? `Enter ${fieldKey}...`}
        autoComplete="new-password"
        className="w-full bg-surface-200/50 border border-border/30 rounded-sm px-3 py-1.5 text-sm text-theme-primary font-mono placeholder-gray-600 focus:outline-none focus:border-accent-blue/50"
      />
    </div>
  );
}

function AddFromPreset({
  presets, existingSecretKeys, onAdd,
}: {
  presets: McpPreset[];
  existingSecretKeys: Set<string>;
  onAdd: (preset: McpPreset, envFields: Record<string, FieldState>, argFields: Record<string, FieldState>) => void;
}) {
  const [selected, setSelected] = useState<McpPreset | null>(null);
  const [envFields, setEnvFields] = useState<Record<string, FieldState>>({});
  const [argFields, setArgFields] = useState<Record<string, FieldState>>({});

  // Initialize fields when a preset is picked. If a secret with the same name
  // already exists in the store, default to "use existing"; otherwise prompt
  // the user to enter a new value.
  const choosePreset = (p: McpPreset) => {
    const initEnv: Record<string, FieldState> = {};
    for (const k of p.envKeys) {
      initEnv[k] = existingSecretKeys.has(k)
        ? { mode: 'use-existing', value: '' }
        : { mode: 'enter-new', value: '' };
    }
    const initArgs: Record<string, FieldState> = {};
    for (const k of (p.argKeys ?? [])) {
      initArgs[k] = existingSecretKeys.has(k)
        ? { mode: 'use-existing', value: '' }
        : { mode: 'enter-new', value: '' };
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

  // A field is "filled" if it's linked to an existing secret OR has a non-empty value
  const isFilled = (s?: FieldState) => !!s && (s.mode === 'use-existing' || s.value.length > 0);
  const allEnvFilled = selected.envKeys.every(k => isFilled(envFields[k]));
  const allArgsFilled = (selected.argKeys ?? []).every(k => isFilled(argFields[k]));

  const ARG_PLACEHOLDERS: Record<string, string> = {
    POSTGRES_CONNECTION_STRING: 'postgresql://user:pass@host:5432/db?sslmode=require',
    MONGODB_CONNECTION_STRING: 'mongodb://user:pass@host:27017/db',
  };

  return (
    <div className="border border-border/40 rounded-lg p-4 bg-surface-200/20 space-y-3">
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-body text-theme-primary">Configure {selected.name}</h4>
        <button onClick={() => setSelected(null)} className="text-xs text-theme-muted hover:text-theme-secondary">Cancel</button>
      </div>
      <p className="text-[11px] text-theme-muted">{selected.description}</p>

      {/* Connection strings (positional args) */}
      {(selected.argKeys ?? []).map(key => (
        <PresetField
          key={key}
          fieldKey={key}
          state={argFields[key] ?? { mode: 'enter-new', value: '' }}
          hasExistingSecret={existingSecretKeys.has(key)}
          placeholder={ARG_PLACEHOLDERS[key]}
          secret={false}
          onChange={next => setArgFields(prev => ({ ...prev, [key]: next }))}
        />
      ))}

      {/* Env vars (API keys, tokens) */}
      {selected.envKeys.map(key => (
        <PresetField
          key={key}
          fieldKey={key}
          state={envFields[key] ?? { mode: 'enter-new', value: '' }}
          hasExistingSecret={existingSecretKeys.has(key)}
          secret={true}
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

export default function McpServerManager() {
  const [servers, setServers] = useState<McpServer[]>([]);
  const [presets, setPresets] = useState<McpPreset[]>([]);
  const [secretKeys, setSecretKeys] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
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
      setSecretKeys(new Set(secretsList ?? []));
    } catch (e) {
      console.error('Failed to load MCP servers:', e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadServers(); }, []);

  const handleAddPreset = async (
    preset: McpPreset,
    envFields: Record<string, FieldState>,
    argFields: Record<string, FieldState>,
  ) => {
    try {
      // For any field where the user typed a NEW value, first store it as a
      // secret under the secret KEY name (which may differ from the env var
      // name — see envVarOverrides). This way the secret is named after what
      // it IS (e.g. GITHUB_PERSONAL_ACCESS_TOKEN), not where it's used
      // (e.g. GH_TOKEN). After this step, every field is a `@secret:` reference.
      const newlyCreatedKeys: string[] = [];
      for (const secretKey of preset.envKeys) {
        const f = envFields[secretKey];
        if (!f || f.mode !== 'enter-new' || !f.value) continue;
        await secretsApi.create(secretKey, f.value);
        newlyCreatedKeys.push(secretKey);
      }
      for (const secretKey of (preset.argKeys ?? [])) {
        const f = argFields[secretKey];
        if (!f || f.mode !== 'enter-new' || !f.value) continue;
        await secretsApi.create(secretKey, f.value);
        newlyCreatedKeys.push(secretKey);
      }

      // Build env. Each entry is `<envVarName>: '@secret:<secretKey>'`. The
      // env var name is the override target if specified, else the secret key.
      const env: Record<string, string> = {};
      for (const secretKey of preset.envKeys) {
        const f = envFields[secretKey];
        if (!f) continue;
        const envVarName = preset.envVarOverrides?.[secretKey] ?? secretKey;
        env[envVarName] = `${SECRET_REF_PREFIX}${secretKey}`;
      }

      // Build args. Positional args are appended in the order presets define.
      const args = [...(preset.args ?? [])];
      for (const secretKey of (preset.argKeys ?? [])) {
        const f = argFields[secretKey];
        if (!f) continue;
        args.push(`${SECRET_REF_PREFIX}${secretKey}`);
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
      // Refresh both server list AND secrets list (we may have just created some)
      void loadServers();
      if (newlyCreatedKeys.length > 0) {
        setSecretKeys(prev => {
          const next = new Set(prev);
          for (const k of newlyCreatedKeys) next.add(k);
          return next;
        });
      }
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
          {availablePresets.length > 0 ? (
            <AddFromPreset presets={availablePresets} existingSecretKeys={secretKeys} onAdd={handleAddPreset} />
          ) : (
            <div className="text-xs text-theme-subtle">All preset servers have been added.</div>
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
