import { useState, useEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import {
  mcp as api,
  repos as reposApi,
  type McpServer,
  type McpPreset,
  type McpDiscoverResult,
} from '../../services/api';
import { commandForExtension, commandForCandidate } from './mcp-command';
import {
  Server, Plus, Trash2, RefreshCw, Power, PowerOff,
  CheckCircle, XCircle, HelpCircle, ExternalLink, ChevronDown, ChevronRight, Wrench,
  Package, FolderGit2, Loader2, AlertCircle, X as XIcon, Copy, Check,
} from 'lucide-react';

// ── Status badge ────────────────────────────────────────────────────────────

const STATUS_STYLES: Record<string, { icon: React.ReactNode; color: string; label: string }> = {
  connected: { icon: <CheckCircle className="w-3.5 h-3.5" />, color: 'text-accent-green', label: 'Connected' },
  failed:    { icon: <XCircle className="w-3.5 h-3.5" />, color: 'text-accent-red', label: 'Failed' },
  untested:  { icon: <HelpCircle className="w-3.5 h-3.5" />, color: 'text-theme-muted', label: 'Untested' },
  disabled:  { icon: <PowerOff className="w-3.5 h-3.5" />, color: 'text-theme-subtle', label: 'Disabled' },
};

function StatusBadge({ status }: { status: string }) {
  const s = STATUS_STYLES[status] ?? STATUS_STYLES.untested;
  return (
    <span className={`flex items-center gap-1 text-[10px] font-mono ${s.color}`}>
      {s.icon} {s.label}
    </span>
  );
}

// ── One server card ─────────────────────────────────────────────────────────

function ServerCard({
  server,
  onChange,
}: {
  server: McpServer;
  onChange: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState<null | 'test' | 'toggle' | 'delete' | 'reinstall'>(null);
  const [flash, setFlash] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const sourceKind = server.source?.kind ?? (server.bundleId ? 'bundle (legacy)' : 'custom');
  const sourceLabel =
    server.source?.kind === 'preset' ? `preset · ${server.source.presetName}`
    : server.source?.kind === 'repo'  ? `repo · ${server.source.entryPath}`
    : sourceKind;

  async function handleTest() {
    setBusy('test');
    try {
      const result = await api.test(server._id);
      setFlash(result.status === 'connected'
        ? { kind: 'ok', text: `${result.toolCount ?? 0} tool${result.toolCount === 1 ? '' : 's'}` }
        : { kind: 'err', text: result.error ?? 'failed' });
      // Defer onChange so the flash has time to render before the parent's
      // loading state unmounts ServerCard. React 18 batches synchronous state
      // updates, so calling onChange() immediately would batch setLoading(true)
      // with setFlash(...) and unmount the card before the flash paints.
      setTimeout(() => onChange(), 300);
    } finally {
      setBusy(null);
      setTimeout(() => setFlash(null), 4000);
    }
  }

  async function handleToggle() {
    setBusy('toggle');
    try { await api.toggle(server._id); onChange(); } finally { setBusy(null); }
  }

  async function handleReinstall() {
    setBusy('reinstall');
    try {
      const r = await api.reinstall(server._id);
      const pm = r.packageManager ?? '?';
      const seconds = Math.round((r.durationMs ?? 0) / 1000);
      let text: string;
      if (r.skipped) {
        text = 'already installed';
      } else if (pm === 'pip') {
        text = r.requirementsInstalled
          ? `venv recreated, installed ${r.requirementsPath ?? 'requirements.txt'} (${seconds}s)`
          : `empty venv recreated — no requirements.txt (${seconds}s)`;
      } else {
        text = `installed via ${pm} (${seconds}s)`;
      }
      setFlash({ kind: 'ok', text });
    } catch (e) {
      setFlash({ kind: 'err', text: (e as Error).message });
    } finally {
      setBusy(null);
      setTimeout(() => setFlash(null), 5000);
    }
  }

  async function handleDelete() {
    if (!confirm(`Delete MCP server "${server.name}"?`)) return;
    setBusy('delete');
    try { await api.delete(server._id); onChange(); } finally { setBusy(null); }
  }

  return (
    <div className={`border rounded-lg overflow-hidden transition-colors ${server.enabled ? 'border-app bg-app-card' : 'border-app bg-app-muted/40 opacity-60'}`}>
      <div className="flex items-center gap-3 px-4 py-3">
        <button
          onClick={() => setExpanded(!expanded)}
          className="text-theme-muted hover:text-theme-secondary"
          title={expanded ? 'Collapse details' : 'Expand details'}
        >
          {expanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
        </button>
        <Server className={`w-4 h-4 shrink-0 ${server.enabled ? 'text-accent-blue' : 'text-theme-subtle'}`} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-body text-theme-primary">{server.name}</span>
            <span className="text-[10px] font-mono text-theme-subtle bg-app-muted px-1.5 py-0.5 rounded">{server.type}</span>
            {server.toolCount != null && server.toolCount > 0 && (
              <span className="text-[10px] font-mono text-theme-subtle flex items-center gap-0.5">
                <Wrench className="w-2.5 h-2.5" />{server.toolCount} tools
              </span>
            )}
          </div>
          <div className="text-[11px] text-theme-muted font-body truncate">{server.description || sourceLabel}</div>
        </div>
        {flash && (
          <span className={`text-[11px] font-mono ${flash.kind === 'ok' ? 'text-accent-green' : 'text-accent-red'}`}>
            {flash.kind === 'ok' ? '✓' : '✗'} {flash.text}
          </span>
        )}
        <StatusBadge status={server.status} />
        <div className="flex items-center gap-1">
          <button
            onClick={handleTest}
            disabled={!!busy || !server.enabled}
            className="p-1.5 rounded-md hover:bg-app-muted text-theme-muted hover:text-accent-blue disabled:opacity-30 transition-colors"
            title="Test connection"
          >
            {busy === 'test' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
          </button>
          {server.source?.kind === 'repo' && (
            <button
              onClick={handleReinstall}
              disabled={!!busy}
              className="p-1.5 rounded-md hover:bg-app-muted text-theme-muted hover:text-accent-blue disabled:opacity-30 transition-colors"
              title="Reinstall dependencies"
            >
              {busy === 'reinstall' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Package className="w-3.5 h-3.5" />}
            </button>
          )}
          <button
            onClick={handleToggle}
            disabled={!!busy}
            className="p-1.5 rounded-md hover:bg-app-muted text-theme-muted hover:text-accent-yellow disabled:opacity-30 transition-colors"
            title={server.enabled ? 'Disable' : 'Enable'}
          >
            {server.enabled ? <Power className="w-3.5 h-3.5" /> : <PowerOff className="w-3.5 h-3.5" />}
          </button>
          <button
            onClick={handleDelete}
            disabled={!!busy}
            className="p-1.5 rounded-md hover:bg-accent-red/10 text-theme-muted hover:text-accent-red disabled:opacity-30 transition-colors"
            title="Delete"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {expanded && (
        <div className="px-4 py-3 border-t border-app bg-surface-200/20 space-y-2 text-xs">
          <DetailRow label="Source">{sourceLabel}</DetailRow>
          {server.command && (
            <DetailRow label="Command">
              <span className="font-mono text-theme-secondary">
                {server.command}{server.args?.length ? ' ' + server.args.slice(0, 3).join(' ') + (server.args.length > 3 ? ' …' : '') : ''}
              </span>
            </DetailRow>
          )}
          {(server.envKeys?.length ?? 0) > 0 && (
            <DetailRow label="Env">
              <div className="font-mono text-[11px] space-y-0.5">
                {server.envKeys!.map((k) => (
                  <div key={k} className="text-theme-secondary">
                    <span className="text-theme-subtle">ALLEN_</span>{k}
                  </div>
                ))}
              </div>
            </DetailRow>
          )}
          {(server.argKeys?.length ?? 0) > 0 && (
            <DetailRow label="Arg keys">
              <div className="font-mono text-[11px] space-y-0.5">
                {server.argKeys!.map((k) => (
                  <div key={k} className="text-theme-secondary">
                    <span className="text-theme-subtle">ALLEN_</span>{k}
                  </div>
                ))}
              </div>
            </DetailRow>
          )}
          {server.serverInfo && (
            <DetailRow label="Server info">
              <span className="text-theme-secondary">{server.serverInfo.name} v{server.serverInfo.version}</span>
            </DetailRow>
          )}
          {server.lastError && (
            <DetailRow label="Last error">
              <span className="text-accent-red font-mono whitespace-pre-wrap">{server.lastError}</span>
            </DetailRow>
          )}
          {server.lastTestedAt && (
            <DetailRow label="Last tested">
              <span className="text-theme-subtle">{new Date(server.lastTestedAt).toLocaleString()}</span>
            </DetailRow>
          )}
        </div>
      )}
    </div>
  );
}

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3">
      <div className="w-24 overline shrink-0 pt-0.5">
        {label}
      </div>
      <div className="flex-1 min-w-0">{children}</div>
    </div>
  );
}

// ── Missing-env error box ───────────────────────────────────────────────────

function MissingEnvError({ missing, onDismiss }: { missing: string[]; onDismiss: () => void }) {
  const [copied, setCopied] = useState(false);
  const block = missing.map((k) => `${k}=`).join('\n');
  async function copy() {
    await navigator.clipboard.writeText(block);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }
  return (
    <div className="border border-red-500/40 bg-red-500/5 rounded-lg p-3 text-xs">
      <div className="flex items-start gap-2">
        <AlertCircle className="w-4 h-4 text-accent-red shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <div className="font-body font-semibold text-accent-red mb-1">
            Missing required env var{missing.length > 1 ? 's' : ''} in Allen's .env
          </div>
          <div className="text-theme-muted mb-2">
            Add the following to <code className="font-mono text-theme-secondary">.env</code> at the Allen project root, then restart the server:
          </div>
          <pre className="bg-app-muted border border-app rounded p-2 font-mono text-[11px] text-theme-secondary select-all overflow-x-auto">{block}</pre>
          <div className="flex gap-2 mt-2">
            <button
              onClick={copy}
              className="px-2 py-1 rounded-md border border-app hover:bg-app-muted text-theme-secondary flex items-center gap-1 text-[11px] transition-colors"
            >
              {copied ? <Check className="w-3 h-3 text-accent-green" /> : <Copy className="w-3 h-3" />}
              {copied ? 'Copied' : 'Copy'}
            </button>
            <button
              onClick={onDismiss}
              className="px-2 py-1 rounded-md border border-app hover:bg-app-muted text-theme-muted text-[11px] transition-colors"
            >
              Dismiss
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Add MCP: choose Preset or Repo ──────────────────────────────────────────

type AddMode = 'preset' | 'repo';

function AddServerModal({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
  const [mode, setMode] = useState<AddMode>('preset');

  // Lock body scroll while modal is open + close on Escape.
  useEffect(() => {
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  // Portal to document.body so no ancestor's backdrop-filter / transform /
  // contain / filter creates a containing block that clips a `position:
  // fixed` overlay. The McpServerManager card uses `backdrop-blur-sm` on
  // both the sticky header and the `.card` class itself — either would trap
  // a fixed modal rendered as a direct child of the card.
  return createPortal(
    <div
      className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-start justify-center z-[9999] p-4 overflow-y-auto"
      onClick={onClose}
    >
      <div
        className="bg-surface-50 border border-app rounded-lg w-full max-w-2xl max-h-[85vh] overflow-hidden flex flex-col shadow-2xl mt-[8vh]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-app">
          <h3 className="font-heading text-sm text-theme-primary tracking-wider">Add MCP Server</h3>
          <button onClick={onClose} className="p-1 rounded-md hover:bg-app-muted text-theme-muted hover:text-theme-secondary transition-colors">
            <XIcon className="w-4 h-4" />
          </button>
        </div>
        <div className="flex gap-1 px-5 pt-3 border-b border-app">
          <TabButton active={mode === 'preset'} onClick={() => setMode('preset')} icon={<Package className="w-3.5 h-3.5" />}>From Preset</TabButton>
          <TabButton active={mode === 'repo'} onClick={() => setMode('repo')} icon={<FolderGit2 className="w-3.5 h-3.5" />}>From Repo</TabButton>
        </div>
        <div className="flex-1 overflow-y-auto p-5">
          {mode === 'preset' ? <AddFromPreset onAdded={onAdded} onClose={onClose} /> : <AddFromRepo onAdded={onAdded} onClose={onClose} />}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function TabButton({ active, onClick, icon, children }: { active: boolean; onClick: () => void; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-label uppercase tracking-[0.15em] rounded-t border-b-2 transition-colors ${
        active
          ? 'border-accent-blue text-theme-primary'
          : 'border-transparent text-theme-muted hover:text-theme-secondary'
      }`}
    >
      {icon}{children}
    </button>
  );
}

// ── Preset picker ───────────────────────────────────────────────────────────

function AddFromPreset({ onAdded, onClose }: { onAdded: () => void; onClose: () => void }) {
  const [presets, setPresets] = useState<McpPreset[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [missing, setMissing] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { api.presets().then(setPresets).catch((e) => setError(e.message)); }, []);

  async function add(p: McpPreset) {
    setMissing(null);
    setError(null);
    setBusy(p.name);
    try {
      await api.create({
        name: p.name,
        type: p.type,
        description: p.description,
        enabled: true,
        source: { kind: 'preset', presetName: p.name },
      });
      onAdded();
      onClose();
    } catch (e) {
      const err = e as Error;
      const match = err.message.match(/Missing required env vars? in Allen's \.env: ([^.]+)\./);
      if (match) setMissing(match[1].split(',').map((s) => s.trim()));
      else setError(err.message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-theme-muted font-body">
        Click a preset to add it. If any <code className="font-mono text-theme-secondary">ALLEN_*</code> env vars are missing from Allen's <code className="font-mono text-theme-secondary">.env</code>, we'll tell you exactly which ones.
      </p>
      {missing && <MissingEnvError missing={missing} onDismiss={() => setMissing(null)} />}
      {error && <div className="text-xs text-accent-red font-mono">{error}</div>}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {presets.map((p) => (
          <button
            key={p.name}
            onClick={() => add(p)}
            disabled={!!busy}
            className="text-left p-3 rounded-lg border border-app bg-app-muted/50 hover:border-accent-blue/60 hover:bg-app-card disabled:opacity-50 transition-colors"
          >
            <div className="flex items-center justify-between gap-2">
              <div className="font-mono text-xs text-theme-primary font-semibold">{p.name}</div>
              {busy === p.name ? (
                <Loader2 className="w-3 h-3 animate-spin text-accent-blue" />
              ) : (
                <a
                  href={p.docsUrl}
                  target="_blank"
                  rel="noreferrer"
                  onClick={(e) => e.stopPropagation()}
                  className="text-theme-subtle hover:text-accent-blue transition-colors"
                  title="Docs"
                >
                  <ExternalLink className="w-3 h-3" />
                </a>
              )}
            </div>
            <div className="text-[11px] text-theme-muted font-body mt-0.5">{p.description}</div>
            {(p.envKeys.length > 0 || (p.argKeys?.length ?? 0) > 0) && (
              <div className="text-[10px] text-theme-subtle font-mono mt-1.5">
                needs: {[...p.envKeys, ...(p.argKeys ?? [])].map((k) => `ALLEN_${k}`).join(', ')}
              </div>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}

// ── Repo picker ─────────────────────────────────────────────────────────────

interface RepoSummary { _id: string; name: string; path: string; }

function AddFromRepo({ onAdded, onClose }: { onAdded: () => void; onClose: () => void }) {
  const [userRepos, setUserRepos] = useState<RepoSummary[]>([]);
  const [selectedRepo, setSelectedRepo] = useState<RepoSummary | null>(null);
  const [discover, setDiscover] = useState<McpDiscoverResult | null>(null);
  const [discovering, setDiscovering] = useState(false);
  const [entryPath, setEntryPath] = useState('');
  const [installPath, setInstallPath] = useState('');
  const [command, setCommand] = useState<string>('');
  const [pythonInterpreter, setPythonInterpreter] = useState<string>('python3');
  const [requirementsPath, setRequirementsPath] = useState<string>('');
  const [name, setName] = useState('');
  const [envKeysInput, setEnvKeysInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [missing, setMissing] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const isPyEntry = entryPath.toLowerCase().endsWith('.py');
  // Default the requirements path to a sibling file when entry is .py and the
  // user hasn't typed one. This is a best-effort hint — the backend tolerates
  // a missing file (creates an empty venv with a console warning).
  const requirementsDefault = useMemo(() => {
    if (!isPyEntry || !entryPath) return '';
    const last = entryPath.lastIndexOf('/');
    return last > 0 ? `${entryPath.slice(0, last)}/requirements.txt` : 'requirements.txt';
  }, [isPyEntry, entryPath]);

  useEffect(() => {
    reposApi.list().then((list) =>
      setUserRepos((list ?? []).map((r: any) => ({ _id: r._id, name: r.name, path: r.path }))),
    );
  }, []);

  async function onPickRepo(repo: RepoSummary) {
    setSelectedRepo(repo);
    setDiscovering(true);
    setDiscover(null);
    try { setDiscover(await api.discover(repo._id)); }
    catch (e) { setError((e as Error).message); }
    finally { setDiscovering(false); }
  }

  const envKeys = useMemo(
    () => envKeysInput.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean),
    [envKeysInput],
  );

  async function submit() {
    if (!selectedRepo) { setError('pick a repo'); return; }
    if (!entryPath) { setError('entry path required'); return; }
    if (!name.trim()) { setError('name required'); return; }
    setMissing(null);
    setError(null);
    setBusy(true);
    try {
      const trimmedCommand = command.trim();
      // Send python block ONLY for .py entries with no manual command override.
      // Backend ignores it for other shapes; sending it unconditionally would
      // pollute non-Python records.
      const pythonBlock = isPyEntry && !trimmedCommand
        ? {
            interpreter: pythonInterpreter.trim() || 'python3',
            ...(requirementsPath.trim() ? { requirementsPath: requirementsPath.trim() } : {}),
          }
        : undefined;
      await api.create({
        name: name.trim(),
        type: 'stdio',
        description: '',
        enabled: true,
        source: {
          kind: 'repo',
          repoId: selectedRepo._id,
          entryPath,
          installPath: installPath || undefined,
        },
        envKeys,
        command: trimmedCommand || undefined,
        python: pythonBlock,
      });
      onAdded();
      onClose();
    } catch (e) {
      const err = e as Error;
      const match = err.message.match(/Missing required env vars? in Allen's \.env: ([^.]+)\./);
      if (match) setMissing(match[1].split(',').map((s) => s.trim()));
      else setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <Field label="Repo">
        <select
          className="w-full px-2.5 py-1.5 rounded-md border border-app bg-app-card text-theme-primary text-sm font-body focus:outline-none focus:border-accent-blue/60"
          value={selectedRepo?._id ?? ''}
          onChange={(e) => {
            const repo = userRepos.find((r) => r._id === e.target.value);
            if (repo) onPickRepo(repo);
          }}
        >
          <option value="">Pick a repo…</option>
          {userRepos.map((r) => <option key={r._id} value={r._id}>{r.name}</option>)}
        </select>
      </Field>

      {selectedRepo && (
        <Field label="Entry file">
          {discovering ? (
            <div className="text-xs text-theme-muted flex items-center gap-2">
              <Loader2 className="w-3 h-3 animate-spin" /> scanning repo…
            </div>
          ) : (
            <div className="space-y-1.5">
              {(discover?.candidates ?? []).length > 0 && (
                <select
                  className="w-full px-2.5 py-1.5 rounded-md border border-app bg-app-card text-theme-primary text-sm font-mono focus:outline-none focus:border-accent-blue/60"
                  value={entryPath}
                  onChange={(e) => {
                    setEntryPath(e.target.value);
                    const last = e.target.value.lastIndexOf('/');
                    if (last > 0) setInstallPath(e.target.value.slice(0, last));
                    const candidate = discover?.candidates.find((c) => c.repoRelative === e.target.value);
                    // For Python candidates, leave Command empty so Allen
                    // creates an isolated venv; user can override manually.
                    if (candidate) {
                      setCommand(candidate.detectedLanguage === 'python' ? '' : commandForCandidate(candidate));
                    }
                  }}
                >
                  <option value="">Pick a candidate…</option>
                  {discover!.candidates.map((c) => (
                    <option key={c.repoRelative} value={c.repoRelative}>{c.repoRelative}</option>
                  ))}
                </select>
              )}
              <input
                type="text"
                placeholder="or type path, e.g. .claude/mcp/postgres/server.mjs"
                value={entryPath}
                onChange={(e) => {
                  const v = e.target.value;
                  setEntryPath(v);
                  // .py → empty (Allen-managed venv); other ext → auto-fill node/npx tsx.
                  if (v) setCommand(v.toLowerCase().endsWith('.py') ? '' : commandForExtension(v));
                }}
                className="w-full px-2.5 py-1.5 rounded-md border border-app bg-app-card text-theme-primary text-sm font-mono placeholder:text-theme-subtle focus:outline-none focus:border-accent-blue/60"
              />
            </div>
          )}
        </Field>
      )}

      {selectedRepo && entryPath && (
        <>
          <Field label="Install dir">
            <input
              type="text"
              placeholder="auto (entry file's directory)"
              value={installPath}
              onChange={(e) => setInstallPath(e.target.value)}
              className="w-full px-2.5 py-1.5 rounded-md border border-app bg-app-card text-theme-primary text-sm font-mono placeholder:text-theme-subtle focus:outline-none focus:border-accent-blue/60"
            />
            <div className="text-[10px] text-theme-subtle mt-1 font-body">
              Directory containing <code className="font-mono text-theme-muted">package.json</code>. Leave blank to use the entry file's folder.
            </div>
          </Field>

          <Field label="Command">
            <input
              type="text"
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              placeholder={isPyEntry ? 'leave blank — Allen will create a venv' : 'e.g. node, npx tsx'}
              className="w-full px-2.5 py-1.5 rounded-md border border-app bg-app-card text-theme-primary text-sm font-mono placeholder:text-theme-subtle focus:outline-none focus:border-accent-blue/60"
            />
            {isPyEntry && !command && (
              <p className="text-[10px] text-theme-subtle font-body mt-1">
                Allen will create an isolated venv at <code className="font-mono text-theme-muted">~/.allen/venvs/&lt;id&gt;/</code> and install requirements.txt on first spawn.
              </p>
            )}
            {isPyEntry && command && (
              <p className="text-[10px] text-theme-subtle font-body mt-1">
                Manual command set — Allen will skip venv creation. The interpreter you specify must have the required packages installed.
              </p>
            )}
          </Field>

          {isPyEntry && !command && (
            <>
              <Field label="Python interpreter">
                <input
                  type="text"
                  value={pythonInterpreter}
                  onChange={(e) => setPythonInterpreter(e.target.value)}
                  placeholder="python3"
                  className="w-full px-2.5 py-1.5 rounded-md border border-app bg-app-card text-theme-primary text-sm font-mono placeholder:text-theme-subtle focus:outline-none focus:border-accent-blue/60"
                />
                <div className="text-[10px] text-theme-subtle mt-1 font-body">
                  Used once to bootstrap the venv (e.g. <code className="font-mono text-theme-muted">python3.11</code>). Must be on PATH or absolute.
                </div>
              </Field>

              <Field label="requirements.txt">
                <input
                  type="text"
                  value={requirementsPath}
                  onChange={(e) => setRequirementsPath(e.target.value)}
                  placeholder={requirementsDefault || 'auto-detected sibling'}
                  className="w-full px-2.5 py-1.5 rounded-md border border-app bg-app-card text-theme-primary text-sm font-mono placeholder:text-theme-subtle focus:outline-none focus:border-accent-blue/60"
                />
                <div className="text-[10px] text-theme-subtle mt-1 font-body">
                  Repo-relative path. Leave blank to auto-detect a sibling <code className="font-mono text-theme-muted">requirements.txt</code> next to the entry. To update deps later, delete this MCP and re-add it.
                </div>
              </Field>
            </>
          )}

          <Field label="Name">
            <input
              type="text"
              placeholder="e.g. inomy-postgres"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full px-2.5 py-1.5 rounded-md border border-app bg-app-card text-theme-primary text-sm font-mono placeholder:text-theme-subtle focus:outline-none focus:border-accent-blue/60"
            />
          </Field>

          <Field label="Env keys">
            <textarea
              placeholder="Bare env var names (comma or newline separated) — e.g. POSTGRES_HOST, POSTGRES_PORT"
              value={envKeysInput}
              onChange={(e) => setEnvKeysInput(e.target.value)}
              className="w-full px-2.5 py-1.5 rounded-md border border-app bg-app-card text-theme-primary text-sm font-mono placeholder:text-theme-subtle focus:outline-none focus:border-accent-blue/60 min-h-[60px]"
            />
            {envKeys.length > 0 && (
              <div className="text-[10px] text-theme-subtle mt-1 font-mono">
                Allen will look these up as: <span className="text-theme-muted">{envKeys.map((k) => `ALLEN_${k}`).join(', ')}</span>
              </div>
            )}
          </Field>
        </>
      )}

      {missing && <MissingEnvError missing={missing} onDismiss={() => setMissing(null)} />}
      {error && <div className="text-xs text-accent-red font-mono">{error}</div>}

      <div className="flex justify-end gap-2 pt-2">
        <button
          onClick={onClose}
          className="px-3 py-1.5 rounded-md border border-app text-theme-secondary hover:bg-app-muted text-sm font-body transition-colors"
        >
          Cancel
        </button>
        <button
          onClick={submit}
          disabled={busy || !selectedRepo || !entryPath || !name.trim()}
          className="px-3 py-1.5 rounded-md bg-accent-blue text-white hover:opacity-90 disabled:opacity-40 text-sm font-body flex items-center gap-1.5 transition-opacity"
        >
          {busy && <Loader2 className="w-3 h-3 animate-spin" />}
          Add
        </button>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block overline mb-1.5">
        {label}
      </label>
      {children}
    </div>
  );
}

// ── Main ────────────────────────────────────────────────────────────────────

export default function McpServerManager() {
  const [servers, setServers] = useState<McpServer[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  async function refresh() {
    setLoading(true);
    setErr(null);
    try { setServers(await api.list()); }
    catch (e) { setErr((e as Error).message); }
    finally { setLoading(false); }
  }
  useEffect(() => { refresh(); }, []);

  return (
    <div className="card">
      {/* Sticky header — Add button stays visible as the list scrolls.
          `top-0` sticks to the nearest scroll ancestor (SettingsPage's
          overflow-auto container). Solid bg-surface-100 masks list rows
          scrolling underneath, and z-20 keeps it above ServerCards. */}
      <div className="sticky top-0 z-20 bg-surface-100/95 backdrop-blur-sm border-b border-app rounded-t-sm px-6 py-4">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <Server className="w-4 h-4 text-accent-blue" />
              <h2 className="font-label text-xs uppercase tracking-widest text-theme-muted">Configured Servers</h2>
            </div>
            <p className="text-[11px] text-theme-muted font-body">
              Env vars go in Allen's <code className="font-mono text-theme-secondary">.env</code> with an <code className="font-mono text-theme-secondary">ALLEN_</code> prefix. Restart after editing.
            </p>
          </div>
          <button
            onClick={() => setAdding(true)}
            className="px-3 py-1.5 rounded-md bg-accent-blue text-white hover:opacity-90 text-sm font-body flex items-center gap-1.5 transition-opacity shrink-0"
          >
            <Plus className="w-4 h-4" /> Add
          </button>
        </div>
      </div>

      <div className="p-6 space-y-3">
        {err && <div className="text-xs text-accent-red font-mono">{err}</div>}

        {loading ? (
          <div className="text-xs text-theme-muted flex items-center gap-2">
            <Loader2 className="w-3 h-3 animate-spin" /> loading…
          </div>
        ) : servers.length === 0 ? (
          <div className="border border-dashed border-app rounded-lg p-8 text-center">
            <Server className="w-6 h-6 mx-auto text-theme-subtle mb-2" />
            <div className="text-sm text-theme-secondary font-body mb-1">No MCP servers yet</div>
            <div className="text-xs text-theme-muted font-body">
              Click <span className="font-semibold text-theme-secondary">Add</span> to register one from a preset or from a repo.
            </div>
          </div>
        ) : (() => {
          // Group servers by owner display name
          const grouped = servers.reduce((acc, srv) => {
            const ownerLabel = srv.ownerName ?? srv.ownerEmail ?? '(unknown)';
            if (!acc[ownerLabel]) acc[ownerLabel] = [];
            acc[ownerLabel].push(srv);
            return acc;
          }, {} as Record<string, McpServer[]>);
          const ownerKeys = Object.keys(grouped).sort();

          return (
            <div className="space-y-4">
              {ownerKeys.map(ownerLabel => (
                <div key={ownerLabel}>
                  <h3 className="overline text-theme-muted mb-2 px-1">{ownerLabel}</h3>
                  <div className="space-y-2">
                    {grouped[ownerLabel].map((s) => (
                      <ServerCard key={s._id} server={s} onChange={refresh} />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          );
        })()}
      </div>

      {adding && <AddServerModal onClose={() => setAdding(false)} onAdded={refresh} />}
    </div>
  );
}
