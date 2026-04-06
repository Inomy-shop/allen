import { useState, useEffect } from 'react';
import { mcp as api } from '../../services/api';
import {
  Server, Plus, Trash2, RefreshCw, Power, PowerOff,
  CheckCircle, XCircle, HelpCircle, ExternalLink, ChevronDown, ChevronRight, Wrench,
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
  docsUrl: string;
}

const STATUS_STYLES: Record<string, { icon: React.ReactNode; color: string; label: string }> = {
  connected: { icon: <CheckCircle className="w-3.5 h-3.5" />, color: 'text-accent-green', label: 'Connected' },
  failed: { icon: <XCircle className="w-3.5 h-3.5" />, color: 'text-accent-red', label: 'Failed' },
  untested: { icon: <HelpCircle className="w-3.5 h-3.5" />, color: 'text-gray-500', label: 'Untested' },
  disabled: { icon: <PowerOff className="w-3.5 h-3.5" />, color: 'text-gray-600', label: 'Disabled' },
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
        <button onClick={() => setExpanded(!expanded)} className="text-gray-500 hover:text-gray-300">
          {expanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
        </button>
        <Server className={`w-4 h-4 shrink-0 ${server.enabled ? 'text-accent-blue' : 'text-gray-600'}`} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-body text-white">{server.name}</span>
            <span className="text-[10px] font-mono text-gray-600 bg-surface-200/50 px-1.5 py-0.5 rounded">{server.type}</span>
            {server.toolCount != null && server.toolCount > 0 && (
              <span className="text-[10px] font-mono text-gray-600 flex items-center gap-0.5">
                <Wrench className="w-2.5 h-2.5" />{server.toolCount} tools
              </span>
            )}
          </div>
          <div className="text-[11px] text-gray-500 font-body truncate">{server.description}</div>
        </div>
        <StatusBadge status={server.status} />
        <div className="flex items-center gap-1">
          <button
            onClick={onTest}
            disabled={!server.enabled || testing}
            className="p-1.5 rounded-md hover:bg-surface-200/60 text-gray-500 hover:text-accent-blue disabled:opacity-30 transition-colors"
            title="Test connection"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${testing ? 'animate-spin' : ''}`} />
          </button>
          <button
            onClick={onToggle}
            className="p-1.5 rounded-md hover:bg-surface-200/60 text-gray-500 hover:text-accent-yellow transition-colors"
            title={server.enabled ? 'Disable' : 'Enable'}
          >
            {server.enabled ? <Power className="w-3.5 h-3.5" /> : <PowerOff className="w-3.5 h-3.5" />}
          </button>
          <button
            onClick={onDelete}
            className="p-1.5 rounded-md hover:bg-red-500/10 text-gray-500 hover:text-red-400 transition-colors"
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
              <div><span className="text-gray-500">Command:</span> <span className="text-gray-300 font-mono">{server.command} {(server.args ?? []).join(' ')}</span></div>
              {server.env && Object.keys(server.env).length > 0 && (
                <div><span className="text-gray-500">Env vars:</span> <span className="text-gray-300 font-mono">{Object.keys(server.env).join(', ')}</span></div>
              )}
            </>
          )}
          {(server.type === 'sse' || server.type === 'http') && (
            <div><span className="text-gray-500">URL:</span> <span className="text-gray-300 font-mono">{server.url}</span></div>
          )}
          {server.serverInfo && (
            <div><span className="text-gray-500">Server:</span> <span className="text-gray-300">{server.serverInfo.name} v{server.serverInfo.version}</span></div>
          )}
          {server.lastError && (
            <div className="text-red-400 font-mono">{server.lastError}</div>
          )}
          {server.lastTestedAt && (
            <div className="text-gray-600">Last tested: {new Date(server.lastTestedAt).toLocaleString()}</div>
          )}
        </div>
      )}
    </div>
  );
}

function AddFromPreset({ presets, onAdd }: { presets: McpPreset[]; onAdd: (preset: McpPreset, env: Record<string, string>) => void }) {
  const [selected, setSelected] = useState<McpPreset | null>(null);
  const [envValues, setEnvValues] = useState<Record<string, string>>({});

  if (!selected) {
    return (
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
        {presets.map(p => (
          <button
            key={p.name}
            onClick={() => { setSelected(p); setEnvValues({}); }}
            className="flex flex-col gap-1 px-3 py-2.5 rounded-lg bg-surface-200/30 border border-border/30 hover:bg-surface-200/60 hover:border-accent-blue/30 transition-all text-left"
          >
            <span className="text-sm font-body text-white">{p.name}</span>
            <span className="text-[10px] text-gray-500 font-body">{p.description}</span>
          </button>
        ))}
      </div>
    );
  }

  return (
    <div className="border border-border/40 rounded-lg p-4 bg-surface-200/20 space-y-3">
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-body text-white">Configure {selected.name}</h4>
        <button onClick={() => setSelected(null)} className="text-xs text-gray-500 hover:text-gray-300">Cancel</button>
      </div>
      <p className="text-[11px] text-gray-500">{selected.description}</p>
      {selected.envKeys.map(key => (
        <div key={key}>
          <label className="text-[10px] font-label uppercase tracking-wider text-gray-500 mb-1 block">{key}</label>
          <input
            type="password"
            value={envValues[key] ?? ''}
            onChange={e => setEnvValues(prev => ({ ...prev, [key]: e.target.value }))}
            placeholder={`Enter ${key}...`}
            className="w-full bg-surface-200/50 border border-border/30 rounded-sm px-3 py-1.5 text-sm text-white font-mono placeholder-gray-600 focus:outline-none focus:border-accent-blue/50"
          />
        </div>
      ))}
      <div className="flex items-center gap-2">
        <button
          onClick={() => { onAdd(selected, envValues); setSelected(null); }}
          disabled={selected.envKeys.some(k => !envValues[k])}
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
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);

  const loadServers = async () => {
    try {
      const [s, p] = await Promise.all([api.list(), api.presets()]);
      setServers(s);
      setPresets(p);
    } catch (e) {
      console.error('Failed to load MCP servers:', e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadServers(); }, []);

  const handleAddPreset = async (preset: McpPreset, env: Record<string, string>) => {
    try {
      await api.create({
        name: preset.name,
        description: preset.description,
        type: preset.type,
        enabled: true,
        command: preset.command,
        args: preset.args,
        env,
      });
      setShowAdd(false);
      loadServers();
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

  if (loading) return <div className="text-xs text-gray-600 animate-pulse py-4">Loading MCP servers...</div>;

  return (
    <div className="space-y-4">
      {/* Server list */}
      {servers.length === 0 && !showAdd && (
        <div className="text-center py-6 text-xs text-gray-600">
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
            <h3 className="text-xs font-label uppercase tracking-widest text-gray-400">Add MCP Server</h3>
            <button onClick={() => setShowAdd(false)} className="text-xs text-gray-500 hover:text-gray-300">Cancel</button>
          </div>
          {availablePresets.length > 0 ? (
            <AddFromPreset presets={availablePresets} onAdd={handleAddPreset} />
          ) : (
            <div className="text-xs text-gray-600">All preset servers have been added.</div>
          )}
        </div>
      ) : (
        <button
          onClick={() => setShowAdd(true)}
          className="flex items-center gap-2 px-3 py-2 rounded-lg border border-dashed border-border/40 hover:border-accent-blue/30 hover:bg-surface-200/30 transition-all text-gray-500 hover:text-gray-300 w-full"
        >
          <Plus className="w-4 h-4" />
          <span className="text-xs font-body">Add MCP Server</span>
        </button>
      )}
    </div>
  );
}
