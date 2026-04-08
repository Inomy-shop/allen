import { useState, useEffect } from 'react';
import { workspaces } from '../../services/workspaceService';
import { Plus, Trash2, Save, Settings, Terminal, Play, Key, FileCode } from 'lucide-react';

interface ServiceConfig {
  name: string;
  command: string;
  portOffset: number;
  healthCheck?: string;
  env?: Record<string, string>;
}

interface WorkspaceConfig {
  setupScript: string[];
  cleanupScript: string[];
  prePrScript: string[];
  services: ServiceConfig[];
  envVars: Record<string, string>;
  autoStart: boolean;
}

export function WorkspaceConfigEditor({ repoId, onClose }: { repoId: string; onClose: () => void }) {
  const [config, setConfig] = useState<WorkspaceConfig>({
    setupScript: [], cleanupScript: [], prePrScript: [],
    services: [], envVars: {}, autoStart: false,
  });
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    workspaces.getConfig(repoId).then(c => {
      if (c) setConfig({
        setupScript: c.setupScript ?? [],
        cleanupScript: c.cleanupScript ?? [],
        prePrScript: c.prePrScript ?? [],
        services: c.services ?? [],
        envVars: c.envVars ?? {},
        autoStart: c.autoStart ?? false,
      });
    }).catch(() => {}).finally(() => setLoading(false));
  }, [repoId]);

  async function handleSave() {
    setSaving(true);
    try { await workspaces.saveConfig(repoId, config); onClose(); } catch (err: any) { alert(err.message); }
    setSaving(false);
  }

  function updateScript(field: 'setupScript' | 'cleanupScript' | 'prePrScript', idx: number, val: string) {
    setConfig(c => ({ ...c, [field]: c[field].map((s, i) => i === idx ? val : s) }));
  }
  function addScript(field: 'setupScript' | 'cleanupScript' | 'prePrScript') {
    setConfig(c => ({ ...c, [field]: [...c[field], ''] }));
  }
  function removeScript(field: 'setupScript' | 'cleanupScript' | 'prePrScript', idx: number) {
    setConfig(c => ({ ...c, [field]: c[field].filter((_, i) => i !== idx) }));
  }

  function updateService(idx: number, key: keyof ServiceConfig, val: any) {
    setConfig(c => ({ ...c, services: c.services.map((s, i) => i === idx ? { ...s, [key]: val } : s) }));
  }
  function addService() {
    setConfig(c => ({ ...c, services: [...c.services, { name: '', command: '', portOffset: c.services.length, healthCheck: '' }] }));
  }
  function removeService(idx: number) {
    setConfig(c => ({ ...c, services: c.services.filter((_, i) => i !== idx) }));
  }

  const envEntries = Object.entries(config.envVars);

  if (loading) return <div className="p-4 text-gray-500 text-sm">Loading config...</div>;

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-surface-100 border border-border/30 rounded-lg w-[640px] max-h-[85vh] flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="flex items-center gap-2 px-4 py-3 border-b border-border/20 shrink-0">
          <Settings className="w-4 h-4 text-gray-400" />
          <span className="text-sm font-semibold text-white">Workspace Configuration</span>
          <span className="flex-1" />
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300 text-xs">Cancel</button>
          <button onClick={handleSave} disabled={saving} className="btn-primary text-xs py-1 px-3 flex items-center gap-1 disabled:opacity-50">
            <Save className="w-3 h-3" />{saving ? 'Saving...' : 'Save'}
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-5">
          {/* Setup Script */}
          <Section icon={<Play className="w-3.5 h-3.5 text-emerald-400" />} title="Setup Script" subtitle="Runs after worktree creation">
            {config.setupScript.map((cmd, i) => (
              <ScriptRow key={i} value={cmd} onChange={v => updateScript('setupScript', i, v)} onRemove={() => removeScript('setupScript', i)} idx={i} />
            ))}
            <button onClick={() => addScript('setupScript')} className="text-[10px] text-gray-500 hover:text-gray-300 flex items-center gap-1 mt-1"><Plus className="w-3 h-3" /> Add step</button>
          </Section>

          {/* Services */}
          <Section icon={<Terminal className="w-3.5 h-3.5 text-blue-400" />} title="Services" subtitle="Full-stack services with port assignment">
            {config.services.map((svc, i) => (
              <div key={i} className="flex items-start gap-2 mb-2">
                <input value={svc.name} onChange={e => updateService(i, 'name', e.target.value)} placeholder="name" className="input text-[11px] py-1 w-20" />
                <input value={svc.command} onChange={e => updateService(i, 'command', e.target.value)} placeholder="npm run dev -- --port {port}" className="input text-[11px] py-1 flex-1" />
                <input value={svc.portOffset} onChange={e => updateService(i, 'portOffset', parseInt(e.target.value) || 0)} placeholder="+0" className="input text-[11px] py-1 w-12 text-center" type="number" />
                <input value={svc.healthCheck ?? ''} onChange={e => updateService(i, 'healthCheck', e.target.value)} placeholder="/health" className="input text-[11px] py-1 w-20" />
                <button onClick={() => removeService(i)} className="text-gray-600 hover:text-red-400 p-1 mt-0.5"><Trash2 className="w-3 h-3" /></button>
              </div>
            ))}
            <button onClick={addService} className="text-[10px] text-gray-500 hover:text-gray-300 flex items-center gap-1 mt-1"><Plus className="w-3 h-3" /> Add service</button>
          </Section>

          {/* Auto-start */}
          <label className="flex items-center gap-2 text-xs text-gray-400 cursor-pointer">
            <input type="checkbox" checked={config.autoStart} onChange={e => setConfig(c => ({ ...c, autoStart: e.target.checked }))}
              className="rounded border-border/30 bg-surface-50" />
            Auto-start services when workspace opens
          </label>

          {/* Pre-PR Checks */}
          <Section icon={<FileCode className="w-3.5 h-3.5 text-amber-400" />} title="Pre-PR Checks" subtitle="Must pass before creating a PR">
            {config.prePrScript.map((cmd, i) => (
              <ScriptRow key={i} value={cmd} onChange={v => updateScript('prePrScript', i, v)} onRemove={() => removeScript('prePrScript', i)} idx={i} />
            ))}
            <button onClick={() => addScript('prePrScript')} className="text-[10px] text-gray-500 hover:text-gray-300 flex items-center gap-1 mt-1"><Plus className="w-3 h-3" /> Add check</button>
          </Section>

          {/* Cleanup Script */}
          <Section icon={<Trash2 className="w-3.5 h-3.5 text-red-400" />} title="Cleanup Script" subtitle="Runs before archive">
            {config.cleanupScript.map((cmd, i) => (
              <ScriptRow key={i} value={cmd} onChange={v => updateScript('cleanupScript', i, v)} onRemove={() => removeScript('cleanupScript', i)} idx={i} />
            ))}
            <button onClick={() => addScript('cleanupScript')} className="text-[10px] text-gray-500 hover:text-gray-300 flex items-center gap-1 mt-1"><Plus className="w-3 h-3" /> Add step</button>
          </Section>

          {/* Environment Variables */}
          <Section icon={<Key className="w-3.5 h-3.5 text-purple-400" />} title="Environment Variables" subtitle="Injected into all scripts and services">
            {envEntries.map(([k, v], i) => (
              <div key={i} className="flex items-center gap-2 mb-1">
                <input value={k} onChange={e => {
                  const newVars = { ...config.envVars };
                  delete newVars[k];
                  newVars[e.target.value] = v;
                  setConfig(c => ({ ...c, envVars: newVars }));
                }} className="input text-[11px] py-1 w-36 font-mono" placeholder="KEY" />
                <input value={v} onChange={e => setConfig(c => ({ ...c, envVars: { ...c.envVars, [k]: e.target.value } }))} className="input text-[11px] py-1 flex-1 font-mono" placeholder="value" />
                <button onClick={() => { const nv = { ...config.envVars }; delete nv[k]; setConfig(c => ({ ...c, envVars: nv })); }} className="text-gray-600 hover:text-red-400 p-1"><Trash2 className="w-3 h-3" /></button>
              </div>
            ))}
            <button onClick={() => setConfig(c => ({ ...c, envVars: { ...c.envVars, '': '' } }))} className="text-[10px] text-gray-500 hover:text-gray-300 flex items-center gap-1 mt-1"><Plus className="w-3 h-3" /> Add variable</button>
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
        {icon}
        <span className="text-xs font-semibold text-gray-300">{title}</span>
        <span className="text-[10px] text-gray-600">{subtitle}</span>
      </div>
      {children}
    </div>
  );
}

function ScriptRow({ value, onChange, onRemove, idx }: { value: string; onChange: (v: string) => void; onRemove: () => void; idx: number }) {
  return (
    <div className="flex items-center gap-2 mb-1">
      <span className="text-[10px] text-gray-600 w-4 text-right shrink-0">{idx + 1}.</span>
      <input value={value} onChange={e => onChange(e.target.value)} className="input text-[11px] py-1 flex-1 font-mono" placeholder="command..." />
      <button onClick={onRemove} className="text-gray-600 hover:text-red-400 p-1"><Trash2 className="w-3 h-3" /></button>
    </div>
  );
}
