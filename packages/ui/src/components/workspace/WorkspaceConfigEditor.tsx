import { useState, useEffect } from 'react';
import { workspaces } from '../../services/workspaceService';
import { Plus, Trash2, Save, Settings, Terminal, Play, FileText, Info, Copy, Check } from 'lucide-react';
import Editor from '@monaco-editor/react';

interface EnvFile { path: string; content: string; }
interface ServiceConfig { name: string; command: string; portOffset: number; healthCheck?: string; }

interface WorkspaceConfig {
  envFiles: EnvFile[];
  setupScript: string[];
  cleanupScript: string[];
  prePrScript: string[];
  services: ServiceConfig[];
  autoStart: boolean;
}

export function WorkspaceConfigEditor({ repoId, onClose }: { repoId: string; onClose: () => void }) {
  const [config, setConfig] = useState<WorkspaceConfig>({
    envFiles: [], setupScript: [], cleanupScript: [], prePrScript: [],
    services: [], autoStart: false,
  });
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [activeEnvIdx, setActiveEnvIdx] = useState<number>(0);

  useEffect(() => {
    workspaces.getConfig(repoId).then(c => {
      if (c) setConfig({
        envFiles: c.envFiles ?? [],
        setupScript: c.setupScript ?? [],
        cleanupScript: c.cleanupScript ?? [],
        prePrScript: c.prePrScript ?? [],
        services: c.services ?? [],
        autoStart: c.autoStart ?? false,
      });
    }).catch(() => {}).finally(() => setLoading(false));
  }, [repoId]);

  async function handleSave() {
    setSaving(true);
    try { await workspaces.saveConfig(repoId, config); onClose(); } catch (err: any) { alert(err.message); }
    setSaving(false);
  }

  // ── Env Files ──
  function addEnvFile() {
    setConfig(c => ({ ...c, envFiles: [...c.envFiles, { path: '.env', content: '# Add your env vars here\n# Use {port:0} for base port, {port:1} for base+1, etc.\n' }] }));
    setActiveEnvIdx(config.envFiles.length);
  }
  function updateEnvFile(idx: number, field: 'path' | 'content', val: string) {
    setConfig(c => ({ ...c, envFiles: c.envFiles.map((f, i) => i === idx ? { ...f, [field]: val } : f) }));
  }
  function removeEnvFile(idx: number) {
    setConfig(c => ({ ...c, envFiles: c.envFiles.filter((_, i) => i !== idx) }));
    if (activeEnvIdx >= config.envFiles.length - 1) setActiveEnvIdx(Math.max(0, config.envFiles.length - 2));
  }

  // ── Scripts ──
  function updateScript(field: 'setupScript' | 'cleanupScript' | 'prePrScript', idx: number, val: string) {
    setConfig(c => ({ ...c, [field]: c[field].map((s, i) => i === idx ? val : s) }));
  }
  function addScript(field: 'setupScript' | 'cleanupScript' | 'prePrScript') {
    setConfig(c => ({ ...c, [field]: [...c[field], ''] }));
  }
  function removeScript(field: 'setupScript' | 'cleanupScript' | 'prePrScript', idx: number) {
    setConfig(c => ({ ...c, [field]: c[field].filter((_, i) => i !== idx) }));
  }

  // ── Services ──
  function updateService(idx: number, key: keyof ServiceConfig, val: any) {
    setConfig(c => ({ ...c, services: c.services.map((s, i) => i === idx ? { ...s, [key]: val } : s) }));
  }
  function addService() {
    setConfig(c => ({ ...c, services: [...c.services, { name: '', command: '', portOffset: c.services.length, healthCheck: '' }] }));
  }
  function removeService(idx: number) {
    setConfig(c => ({ ...c, services: c.services.filter((_, i) => i !== idx) }));
  }

  if (loading) return <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"><div className="text-theme-secondary text-sm">Loading config...</div></div>;

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-surface-100 border border-app rounded-lg w-[900px] max-h-[92vh] flex flex-col" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center gap-2 px-4 py-3 border-b border-app shrink-0">
          <Settings className="w-4 h-4 text-theme-secondary" />
          <span className="text-sm font-semibold text-theme-primary">Workspace Configuration</span>
          <span className="flex-1" />
          <button onClick={onClose} className="text-theme-muted hover:text-theme-secondary text-xs">Cancel</button>
          <button onClick={handleSave} disabled={saving} className="btn-primary text-xs py-1 px-3 flex items-center gap-1 disabled:opacity-50">
            <Save className="w-3 h-3" />{saving ? 'Saving...' : 'Save'}
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-5">
          {/* Env Files */}
          <div>
            <div className="flex items-center gap-2 mb-2">
              <FileText className="w-3.5 h-3.5 text-accent-yellow" />
              <span className="text-xs font-semibold text-theme-secondary">Environment Files</span>
              <span className="text-[10px] text-theme-subtle">Generated in worktree before setup scripts run</span>
            </div>

            <div className="bg-app-card/50 border border-app rounded-lg p-0.5 mb-2">
              <div className="flex items-center gap-1 text-[9px] text-theme-subtle px-2 py-1">
                <Info className="w-3 h-3" />
                Use <code className="text-accent-yellow bg-app-muted px-1 rounded">{'{port:0}'}</code> for base port, <code className="text-accent-yellow bg-app-muted px-1 rounded">{'{port:1}'}</code> for base+1, etc. Ports auto-assigned per workspace.
              </div>
            </div>

            {/* Env file tabs */}
            <div className="flex items-center gap-1 mb-2 flex-wrap">
              {config.envFiles.map((f, i) => (
                <div key={i} className={`flex items-center gap-1 text-[10px] font-mono px-2 py-1 rounded cursor-pointer ${activeEnvIdx === i ? 'bg-accent-soft text-accent border border-accent/30' : 'text-theme-muted hover:text-theme-secondary border border-app'}`}>
                  <button onClick={() => setActiveEnvIdx(i)} className="truncate max-w-[120px]">{f.path || 'untitled'}</button>
                  <button onClick={() => removeEnvFile(i)} className="hover:text-accent-red"><Trash2 className="w-2.5 h-2.5" /></button>
                </div>
              ))}
              <button onClick={addEnvFile} className="text-[10px] text-theme-muted hover:text-theme-secondary flex items-center gap-0.5 px-2 py-1 border border-dashed border-app rounded">
                <Plus className="w-3 h-3" /> Add .env
              </button>
            </div>

            {/* Active env file editor */}
            {config.envFiles.length > 0 && config.envFiles[activeEnvIdx] && (
              <div className="border border-app rounded-lg overflow-hidden">
                <div className="flex items-center gap-2 px-3 py-1.5 bg-app-muted/50 border-b border-app">
                  <span className="text-[10px] text-theme-muted">File path:</span>
                  <input value={config.envFiles[activeEnvIdx].path}
                    onChange={e => updateEnvFile(activeEnvIdx, 'path', e.target.value)}
                    placeholder=".env"
                    className="bg-transparent text-[11px] font-mono text-theme-secondary outline-none flex-1 placeholder:text-theme-subtle" />
                  <CopyButton text={config.envFiles[activeEnvIdx].content} />
                </div>
                <Editor
                  height="220px"
                  language="ini"
                  value={config.envFiles[activeEnvIdx].content}
                  onChange={v => updateEnvFile(activeEnvIdx, 'content', v ?? '')}
                  theme="vs-dark"
                  options={{
                    fontSize: 12,
                    fontFamily: "'JetBrains Mono', monospace",
                    minimap: { enabled: false },
                    scrollBeyondLastLine: false,
                    lineNumbers: 'on',
                    glyphMargin: false,
                    folding: false,
                    renderLineHighlight: 'line',
                    tabSize: 2,
                    padding: { top: 6, bottom: 6 },
                    wordWrap: 'on',
                  }}
                />
              </div>
            )}

            {config.envFiles.length === 0 && (
              <div className="text-[10px] text-theme-subtle py-2">No env files. Click "Add .env" to configure environment variables with port placeholders.</div>
            )}
          </div>

          {/* Setup Script */}
          <Section icon={<Play className="w-3.5 h-3.5 text-accent-green" />} title="Setup Script" subtitle="Runs after .env generation (e.g. npm install)">
            {config.setupScript.map((cmd, i) => (
              <ScriptRow key={i} value={cmd} onChange={v => updateScript('setupScript', i, v)} onRemove={() => removeScript('setupScript', i)} idx={i} />
            ))}
            <button onClick={() => addScript('setupScript')} className="text-[10px] text-theme-muted hover:text-theme-secondary flex items-center gap-1 mt-1"><Plus className="w-3 h-3" /> Add step</button>
          </Section>

          {/* Services */}
          <Section icon={<Terminal className="w-3.5 h-3.5 text-accent" />} title="Services" subtitle="Use {port:N} in commands — N = portOffset">
            <div className="text-[9px] text-theme-subtle mb-2 grid grid-cols-[80px_1fr_48px_80px_24px] gap-2 font-mono px-1">
              <span>Name</span><span>Command</span><span>Offset</span><span>Health</span><span></span>
            </div>
            {config.services.map((svc, i) => (
              <div key={i} className="grid grid-cols-[80px_1fr_48px_80px_24px] gap-2 mb-1.5 items-center">
                <input value={svc.name} onChange={e => updateService(i, 'name', e.target.value)} placeholder="api" className="input text-[11px] py-1" />
                <input value={svc.command} onChange={e => updateService(i, 'command', e.target.value)} placeholder="npm run dev" className="input text-[11px] py-1 font-mono" />
                <input value={svc.portOffset} onChange={e => updateService(i, 'portOffset', parseInt(e.target.value) || 0)} className="input text-[11px] py-1 text-center" type="number" />
                <input value={svc.healthCheck ?? ''} onChange={e => updateService(i, 'healthCheck', e.target.value)} placeholder="/health" className="input text-[11px] py-1" />
                <button onClick={() => removeService(i)} className="text-theme-subtle hover:text-accent-red p-0.5"><Trash2 className="w-3 h-3" /></button>
              </div>
            ))}
            <button onClick={addService} className="text-[10px] text-theme-muted hover:text-theme-secondary flex items-center gap-1 mt-1"><Plus className="w-3 h-3" /> Add service</button>
          </Section>

          {/* Auto-start */}
          <label className="flex items-center gap-2 text-xs text-theme-secondary cursor-pointer">
            <input type="checkbox" checked={config.autoStart} onChange={e => setConfig(c => ({ ...c, autoStart: e.target.checked }))} className="rounded border-app bg-surface-50" />
            Auto-start services when workspace opens
          </label>

          {/* Pre-PR Checks */}
          <Section icon={<FileText className="w-3.5 h-3.5 text-accent-yellow" />} title="Pre-PR Checks" subtitle="Must pass before creating PR">
            {config.prePrScript.map((cmd, i) => (
              <ScriptRow key={i} value={cmd} onChange={v => updateScript('prePrScript', i, v)} onRemove={() => removeScript('prePrScript', i)} idx={i} />
            ))}
            <button onClick={() => addScript('prePrScript')} className="text-[10px] text-theme-muted hover:text-theme-secondary flex items-center gap-1 mt-1"><Plus className="w-3 h-3" /> Add check</button>
          </Section>

          {/* Cleanup Script */}
          <Section icon={<Trash2 className="w-3.5 h-3.5 text-accent-red" />} title="Cleanup Script" subtitle="Runs before workspace archive">
            {config.cleanupScript.map((cmd, i) => (
              <ScriptRow key={i} value={cmd} onChange={v => updateScript('cleanupScript', i, v)} onRemove={() => removeScript('cleanupScript', i)} idx={i} />
            ))}
            <button onClick={() => addScript('cleanupScript')} className="text-[10px] text-theme-muted hover:text-theme-secondary flex items-center gap-1 mt-1"><Plus className="w-3 h-3" /> Add step</button>
          </Section>
        </div>
      </div>
    </div>
  );
}

function Section({ icon, title, subtitle, children }: { icon: React.ReactNode; title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="flex items-center gap-2 mb-2">
        {icon}<span className="text-xs font-semibold text-theme-secondary">{title}</span>
        <span className="text-[10px] text-theme-subtle">{subtitle}</span>
      </div>
      {children}
    </div>
  );
}

function ScriptRow({ value, onChange, onRemove, idx }: { value: string; onChange: (v: string) => void; onRemove: () => void; idx: number }) {
  return (
    <div className="flex items-center gap-2 mb-1">
      <span className="text-[10px] text-theme-subtle w-4 text-right shrink-0">{idx + 1}.</span>
      <input value={value} onChange={e => onChange(e.target.value)} className="input text-[11px] py-1 flex-1 font-mono" placeholder="command..." />
      <CopyButton text={value} />
      <button onClick={onRemove} className="text-theme-subtle hover:text-accent-red p-1"><Trash2 className="w-3 h-3" /></button>
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = () => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <button onClick={handleCopy} className="text-theme-subtle hover:text-theme-secondary p-1 shrink-0" title="Copy">
      {copied ? <Check className="w-3 h-3 text-accent-green" /> : <Copy className="w-3 h-3" />}
    </button>
  );
}
