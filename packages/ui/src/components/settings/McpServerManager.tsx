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
  Server, Plus, Trash2, RefreshCw, PowerOff,
  CheckCircle, XCircle, HelpCircle, ExternalLink, ChevronDown, ChevronRight, Wrench,
  Package, FolderGit2, Loader2, AlertCircle, X as XIcon, Copy, Check,
  Search, Github, FileText, Table2, Video, Figma, BriefcaseBusiness, Database,
  HardDrive, MessageSquare, Brain, Folder, AlertTriangle, Pencil,
} from 'lucide-react';
import IconTooltipButton from '../common/IconTooltipButton';
import Select from '../common/Select';

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
  const [busy, setBusy] = useState<null | 'test' | 'delete' | 'reinstall'>(null);
  const [flash, setFlash] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);

  const sourceKind = server.source?.kind ?? (server.bundleId ? 'bundle (legacy)' : 'custom');
  const sourceLabel =
    server.source?.kind === 'preset' ? `preset · ${server.source.presetName}`
    : server.source?.kind === 'repo'  ? `repo · ${server.source.entryPath}`
    : sourceKind;
  const commandPreview = server.command
    ? `${server.command}${server.args?.length ? ' ' + server.args.join(' ') : ''}`
    : server.url ?? 'Not configured';
  const credentialKeys = [
    ...(server.envKeys ?? []).map((key) => `ALLEN_${key}`),
    ...(server.argKeys ?? []).map((key) => `ALLEN_${key}`),
  ];

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
    setBusy('delete');
    try {
      await api.delete(server._id);
      setDeleteOpen(false);
      onChange();
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className={`mcp-server-card rounded-lg border transition-colors ${server.enabled ? 'border-app bg-app-card' : 'border-app bg-app-muted/40 opacity-60'}`}>
      <div className="mcp-server-row flex items-center gap-3 px-4 py-3">
        <IconTooltipButton label={expanded ? 'Collapse details' : 'Expand details'} onClick={() => setExpanded(!expanded)}>
          {expanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
        </IconTooltipButton>
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
          <IconTooltipButton label="Test connection" tone="accent" onClick={handleTest} disabled={!!busy || !server.enabled}>
            {busy === 'test' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
          </IconTooltipButton>
          {server.source?.kind === 'repo' && (
            <IconTooltipButton label="Reinstall dependencies" tone="accent" onClick={handleReinstall} disabled={!!busy}>
              {busy === 'reinstall' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Package className="w-3.5 h-3.5" />}
            </IconTooltipButton>
          )}
          <IconTooltipButton label="Edit server" onClick={() => setEditOpen(true)} disabled={!!busy}>
            <Pencil className="w-3.5 h-3.5" />
          </IconTooltipButton>
          <IconTooltipButton label="Delete server" tone="danger" onClick={() => setDeleteOpen(true)} disabled={!!busy}>
            <Trash2 className="w-3.5 h-3.5" />
          </IconTooltipButton>
        </div>
      </div>

      {expanded && (
        <div className="border-t border-app bg-app px-4 py-4">
          <div className="grid gap-3 lg:grid-cols-[minmax(0,1.3fr)_minmax(260px,0.7fr)]">
            <section className="rounded-lg border border-app bg-app-card p-3">
              <div className="mb-2 flex items-center justify-between gap-3">
                <div className="text-[12px] font-semibold text-theme-primary">Connection</div>
                <span className="rounded-sm border border-app bg-app-muted px-1.5 py-0.5 font-mono text-[10px] text-theme-muted">
                  {server.source?.kind ?? sourceKind}
                </span>
              </div>
              <div className="space-y-2">
                <McpDetailLine label="Source" value={sourceLabel} />
                <McpDetailLine label={server.url ? 'URL' : 'Command'} value={commandPreview} mono />
              </div>
            </section>

            <section className="rounded-lg border border-app bg-app-card p-3">
              <div className="mb-2 text-[12px] font-semibold text-theme-primary">Diagnostics</div>
              <div className="space-y-2">
                <McpDetailLine
                  label="Server"
                  value={server.serverInfo ? `${server.serverInfo.name} v${server.serverInfo.version}` : 'Not tested'}
                />
                <McpDetailLine
                  label="Last tested"
                  value={server.lastTestedAt ? formatMcpDate(server.lastTestedAt) : 'Not tested'}
                />
              </div>
            </section>
          </div>

          <section className="mt-3 rounded-lg border border-app bg-app-card p-3">
            <div className="mb-2 flex items-center justify-between gap-3">
              <div className="text-[12px] font-semibold text-theme-primary">Credentials</div>
              <span className="rounded-sm border border-app bg-app-muted px-1.5 py-0.5 font-mono text-[10px] text-theme-muted">
                {credentialKeys.length} key{credentialKeys.length === 1 ? '' : 's'}
              </span>
            </div>
            {credentialKeys.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {credentialKeys.map((key) => (
                  <span key={key} className="rounded-md border border-app bg-app px-2 py-1 font-mono text-[11px] text-theme-secondary">
                    {key}
                  </span>
                ))}
              </div>
            ) : (
              <div className="text-[12px] text-theme-muted">No credentials required.</div>
            )}
          </section>

          {server.lastError && (
            <section className="mt-3 rounded-lg border border-accent-red/30 bg-accent-red/10 p-3">
              <div className="mb-2 text-[12px] font-semibold text-accent-red">Last error</div>
              <pre className="max-h-36 overflow-auto whitespace-pre-wrap font-mono text-[11px] leading-5 text-accent-red">
                {server.lastError}
              </pre>
            </section>
          )}
        </div>
      )}
      <McpDeleteDialog
        open={deleteOpen}
        serverName={server.name}
        busy={busy === 'delete'}
        onCancel={() => {
          if (!busy) setDeleteOpen(false);
        }}
        onConfirm={() => void handleDelete()}
      />
      <EditServerModal
        open={editOpen}
        server={server}
        onClose={() => setEditOpen(false)}
        onSaved={() => {
          setEditOpen(false);
          onChange();
        }}
      />
    </div>
  );
}

function McpDeleteDialog({
  open,
  serverName,
  busy,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  serverName: string;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/55 p-4 backdrop-blur-sm" onClick={onCancel}>
      <div className="w-full max-w-md overflow-hidden rounded-lg border border-app bg-app-card shadow-2xl" onClick={(event) => event.stopPropagation()}>
        <div className="flex items-start gap-3 border-b border-app px-5 py-4">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-accent-red/25 bg-accent-red/10">
            <AlertTriangle className="h-4 w-4 text-accent-red" />
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="text-[15px] font-semibold text-theme-primary">Delete MCP server</h3>
            <p className="mt-1 text-[12px] leading-5 text-theme-muted">
              Remove <span className="font-mono text-theme-primary">{serverName}</span> from Allen. This cannot be undone.
            </p>
          </div>
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="rounded-md p-1.5 text-theme-muted transition-colors hover:bg-app-muted hover:text-theme-secondary disabled:opacity-50"
            aria-label="Close"
          >
            <XIcon className="h-4 w-4" />
          </button>
        </div>
        <div className="flex justify-end gap-2 px-5 py-4">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="inline-flex h-9 items-center justify-center rounded-md border border-app bg-app-card px-3 text-[13px] font-medium text-theme-secondary transition-colors hover:bg-app-muted hover:text-theme-primary disabled:cursor-not-allowed disabled:opacity-60"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className="inline-flex h-9 items-center justify-center gap-2 rounded-md border border-accent-red/35 bg-accent-red px-3.5 text-[13px] font-medium text-white transition-colors hover:bg-accent-red/90 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
            Delete
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function parseKeyList(value: string): string[] {
  return Array.from(new Set(
    value
      .split(/[\n,]+/)
      .map((item) => bareCredentialKey(item))
      .filter(Boolean),
  ));
}

function parseArgs(value: string): string[] {
  return value
    .split('\n')
    .map((item) => item.trim())
    .filter(Boolean);
}

function EditServerModal({
  open,
  server,
  onClose,
  onSaved,
}: {
  open: boolean;
  server: McpServer;
  onClose: () => void;
  onSaved: () => void;
}) {
  if (!open) return null;

  const isPreset = server.source?.kind === 'preset';
  return (
    <McpServerModalShell
      title="Edit MCP server"
      description={isPreset
        ? <>Update variables for <span className="font-mono text-theme-secondary">{server.name}</span>. Preset command, name, path, and type are managed by Allen.</>
        : <>Update connection details for <span className="font-mono text-theme-secondary">{server.name}</span>.</>}
      onClose={onClose}
    >
      {isPreset
        ? <EditPresetServerForm server={server} onClose={onClose} onSaved={onSaved} />
        : <EditCustomServerForm server={server} onClose={onClose} onSaved={onSaved} />}
    </McpServerModalShell>
  );
}

function presetServerCredentialKeys(server: McpServer): string[] {
  return [...(server.envKeys ?? []), ...(server.argKeys ?? [])];
}

function EditPresetServerForm({
  server,
  onClose,
  onSaved,
}: {
  server: McpServer;
  onClose: () => void;
  onSaved: () => void;
}) {
  const isDesktop = typeof window !== 'undefined' && Boolean(window.allenDesktop);
  const [presets, setPresets] = useState<McpPreset[]>([]);
  const [credentialDrafts, setCredentialDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [missing, setMissing] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.presets().then(setPresets).catch(() => setPresets([]));
  }, []);

  const presetName = server.source?.kind === 'preset' ? server.source.presetName : undefined;
  const preset = presets.find((item) => item.name === presetName) ?? null;
  const keys = preset ? [...preset.envKeys, ...(preset.argKeys ?? [])] : presetServerCredentialKeys(server);
  const normalizedKeys = credentialKeys(keys);
  const isSaveDisabled = busy || (normalizedKeys.length === 0 && isDesktop);

  async function submit() {
    setBusy(true);
    setMissing(null);
    setError(null);
    try {
      await api.update(server._id, {
        credentials: isDesktop ? credentialsFromDrafts(keys, credentialDrafts) : undefined,
      });
      onSaved();
    } catch (e) {
      const err = e as Error;
      const missingCredentials = missingCredentialsFromError(err);
      if (missingCredentials) setMissing(missingCredentials);
      else setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="overflow-hidden rounded-lg border border-app bg-app-card">
      <div className="flex items-start gap-3 border-b border-app px-4 py-4">
        {preset ? <NativePresetIcon preset={preset} /> : <Server className="mt-1 h-5 w-5 shrink-0 text-theme-muted" />}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h4 className="text-[15px] font-semibold text-theme-primary">{presetName ?? server.name}</h4>
            <span className="rounded-sm border border-app bg-app-muted/45 px-1.5 py-0.5 font-mono text-[10px] text-theme-muted">
              {server.type}
            </span>
          </div>
          <p className="mt-1 max-w-3xl text-[12px] leading-5 text-theme-muted">
            {preset?.description ?? server.description}
          </p>
          <div className="mt-2 max-w-3xl truncate rounded-md border border-app bg-app px-2.5 py-1.5 font-mono text-[11px] text-theme-secondary">
            {preset ? presetCommandPreview(preset) : (server.command ? `${server.command}${server.args?.length ? ' ' + server.args.join(' ') : ''}` : server.url ?? 'Preset connection')}
          </div>
        </div>
      </div>

      <section className="p-4">
        <div className="rounded-lg border border-app bg-app p-3">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-[12px] font-semibold text-theme-primary">Variables</div>
              <p className="mt-1 text-[12px] leading-5 text-theme-muted">
                Add only the values. Leave a value blank to keep the existing saved value.
              </p>
            </div>
            <span className="shrink-0 rounded-sm border border-app bg-app-card px-1.5 py-0.5 font-mono text-[10px] text-theme-muted">
              {normalizedKeys.length} required
            </span>
          </div>

          {normalizedKeys.length > 0 ? (
            <div className="mt-3 space-y-2">
              {normalizedKeys.map((key) => (
                <label
                  key={key}
                  className="grid items-center gap-3 rounded-md border border-app bg-app-card p-3 md:grid-cols-[minmax(0,1fr)_minmax(260px,360px)]"
                >
                  <span className="min-w-0">
                    <span className="block text-[11px] font-medium text-theme-muted">Key</span>
                    <span className="mt-1 block truncate font-mono text-[11px] leading-5 text-theme-secondary" title={key}>
                      {key}
                    </span>
                  </span>
                  {isDesktop ? (
                    <input
                      type="password"
                      autoComplete="off"
                      value={credentialDrafts[key] ?? ''}
                      onChange={(event) => setCredentialDrafts((prev) => ({ ...prev, [key]: event.target.value }))}
                      placeholder="keep existing"
                      className="h-9 w-full rounded-md border border-app bg-app px-3 font-mono text-[12px] text-theme-primary outline-none transition-colors placeholder:text-theme-subtle focus:border-accent focus:ring-2 focus:ring-accent/15"
                    />
                  ) : (
                    <span className="truncate rounded-md border border-app bg-app px-3 py-2 font-mono text-[11px] text-theme-muted">
                      read from .env
                    </span>
                  )}
                </label>
              ))}
            </div>
          ) : (
            <div className="mt-3 rounded-md border border-app bg-app-card px-3 py-3 text-[12px] text-theme-muted">
              This preset has no variables to edit.
            </div>
          )}

          <div className="mt-3 space-y-2">
            {missing && <MissingEnvError missing={missing} onDismiss={() => setMissing(null)} />}
            {error && <div className="rounded-md border border-accent-red/30 bg-accent-red/10 px-3 py-2 font-mono text-[11px] text-accent-red">{error}</div>}
          </div>
        </div>
      </section>

      <div className="flex justify-end gap-2 border-t border-app px-4 py-4">
        <button
          type="button"
          onClick={onClose}
          disabled={busy}
          className="inline-flex h-9 items-center justify-center rounded-md border border-app bg-app-card px-3 text-[13px] font-medium text-theme-secondary transition-colors hover:bg-app-muted hover:text-theme-primary disabled:cursor-not-allowed disabled:opacity-60"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={() => void submit()}
          disabled={isSaveDisabled}
          className="inline-flex h-9 items-center justify-center gap-2 rounded-md border border-accent/40 bg-accent px-3.5 text-[13px] font-medium text-white transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-60"
        >
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle className="h-3.5 w-3.5" />}
          Save variables
        </button>
      </div>
    </div>
  );
}

function initialCredentialRows(server: McpServer): CredentialRow[] {
  return (server.envKeys ?? []).map((key) => ({
    id: `${server._id}-${key}`,
    key: bareCredentialKey(key),
  }));
}

function EditCustomServerForm({
  server,
  onClose,
  onSaved,
}: {
  server: McpServer;
  onClose: () => void;
  onSaved: () => void;
}) {
  const isDesktop = typeof window !== 'undefined' && Boolean(window.allenDesktop);
  const repoSource = server.source?.kind === 'repo' ? server.source : null;
  const isRepoSource = Boolean(repoSource);
  const [name, setName] = useState(server.name);
  const [type, setType] = useState<McpServer['type']>(server.type);
  const [entryPath, setEntryPath] = useState(repoSource?.entryPath ?? '');
  const [installPath, setInstallPath] = useState(repoSource?.installPath ?? '');
  const [command, setCommand] = useState(server.command ?? '');
  const [argsInput, setArgsInput] = useState((server.args ?? []).join('\n'));
  const [url, setUrl] = useState(server.url ?? '');
  const [headersInput, setHeadersInput] = useState(server.headers ? JSON.stringify(server.headers, null, 2) : '');
  const [pythonInterpreter, setPythonInterpreter] = useState(server.python?.interpreter ?? 'python3');
  const [requirementsPath, setRequirementsPath] = useState(server.python?.requirementsPath ?? '');
  const [envKeysInput, setEnvKeysInput] = useState((server.envKeys ?? []).map(bareCredentialKey).join('\n'));
  const [credentialRows, setCredentialRows] = useState<CredentialRow[]>(() => initialCredentialRows(server));
  const [credentialDrafts, setCredentialDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [missing, setMissing] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const isPyEntry = isRepoSource && entryPath.toLowerCase().endsWith('.py');
  const declaredEnvKeys = useMemo(() => parseKeyList(envKeysInput), [envKeysInput]);
  const rowEnvKeys = useMemo(
    () => credentialRows.map((row) => bareCredentialKey(row.key)).filter(Boolean),
    [credentialRows],
  );
  const envKeys = useMemo(
    () => Array.from(new Set(isDesktop ? rowEnvKeys : declaredEnvKeys)),
    [declaredEnvKeys, isDesktop, rowEnvKeys],
  );
  const requirementsDefault = useMemo(() => {
    if (!isPyEntry || !entryPath) return '';
    const last = entryPath.lastIndexOf('/');
    return last > 0 ? `${entryPath.slice(0, last)}/requirements.txt` : 'requirements.txt';
  }, [isPyEntry, entryPath]);

  function updateCredentialRow(id: string, nextKey: string) {
    setCredentialRows((current) => {
      const previous = current.find((row) => row.id === id);
      if (previous) {
        const previousFullKey = fullCredentialKey(previous.key);
        const nextFullKey = fullCredentialKey(nextKey);
        if (previousFullKey !== nextFullKey) {
          setCredentialDrafts((drafts) => {
            const next = { ...drafts };
            if (next[previousFullKey] !== undefined && next[nextFullKey] === undefined) {
              next[nextFullKey] = next[previousFullKey];
            }
            delete next[previousFullKey];
            return next;
          });
        }
      }
      return current.map((row) => row.id === id ? { ...row, key: nextKey } : row);
    });
  }

  function removeCredentialRow(id: string) {
    setCredentialRows((current) => {
      const row = current.find((item) => item.id === id);
      if (row) {
        const fullKey = fullCredentialKey(row.key);
        setCredentialDrafts((drafts) => {
          const next = { ...drafts };
          delete next[fullKey];
          return next;
        });
      }
      return current.filter((item) => item.id !== id);
    });
  }

  function addCredentialRow(key = '') {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    setCredentialRows((current) => [...current, { id, key }]);
  }

  async function submit() {
    if (!name.trim()) { setError('name required'); return; }
    if (isRepoSource && !entryPath.trim()) { setError('entry path required'); return; }
    setBusy(true);
    setMissing(null);
    setError(null);
    try {
      let headers: Record<string, string> | undefined;
      if (!isRepoSource && (type === 'http' || type === 'sse') && headersInput.trim()) {
        const parsed = JSON.parse(headersInput);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error('Headers must be a JSON object.');
        }
        headers = Object.fromEntries(Object.entries(parsed).map(([key, value]) => [key, String(value)]));
      }

      const trimmedCommand = command.trim();
      const body: Partial<McpServer> & { credentials?: Record<string, string> } = {
        name: name.trim(),
        envKeys,
        argKeys: server.argKeys ?? [],
        credentials: isDesktop ? credentialsFromDrafts([...envKeys, ...(server.argKeys ?? [])], credentialDrafts) : undefined,
      };

      if (repoSource) {
        body.type = 'stdio';
        body.source = {
          ...repoSource,
          entryPath: entryPath.trim(),
          installPath: installPath.trim() || undefined,
        };
        body.command = trimmedCommand;
        body.args = server.args ?? [];
        body.python = isPyEntry && !trimmedCommand
          ? {
              interpreter: pythonInterpreter.trim() || 'python3',
              ...(requirementsPath.trim() ? { requirementsPath: requirementsPath.trim() } : {}),
            }
          : undefined;
      } else {
        body.type = type;
        if (type === 'stdio') {
          body.command = trimmedCommand;
          body.args = parseArgs(argsInput);
          body.url = '';
          body.headers = {};
        } else {
          body.command = '';
          body.args = [];
          body.url = url.trim();
          body.headers = headers ?? {};
        }
      }

      await api.update(server._id, body);
      onSaved();
    } catch (e) {
      const err = e as Error;
      const missingCredentials = missingCredentialsFromError(err);
      if (missingCredentials) {
        setMissing(missingCredentials);
        if (isDesktop) {
          setCredentialRows((current) => {
            const existing = new Set(current.map((row) => fullCredentialKey(row.key)));
            const additions = missingCredentials
              .filter((key) => !existing.has(fullCredentialKey(key)))
              .map((key) => ({ id: `${Date.now()}-${key}`, key: bareCredentialKey(key) }));
            return [...current, ...additions];
          });
        }
      } else {
        setError(err.message);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <Field label="Name">
        <input
          type="text"
          placeholder="e.g. my-postgres"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="w-full px-2.5 py-1.5 rounded-md border border-app bg-app-card text-theme-primary text-sm font-mono placeholder:text-theme-subtle focus:outline-none focus:border-accent-blue/60"
        />
      </Field>

      {isRepoSource ? (
        <>
          <Field label="Entry file">
            <input
              type="text"
              placeholder="e.g. .claude/mcp/postgres/server.mjs"
              value={entryPath}
              onChange={(e) => {
                const value = e.target.value;
                setEntryPath(value);
                if (value) setCommand(value.toLowerCase().endsWith('.py') ? '' : commandForExtension(value));
              }}
              className="w-full px-2.5 py-1.5 rounded-md border border-app bg-app-card text-theme-primary text-sm font-mono placeholder:text-theme-subtle focus:outline-none focus:border-accent-blue/60"
            />
          </Field>

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
              </Field>

              <Field label="requirements.txt">
                <input
                  type="text"
                  value={requirementsPath}
                  onChange={(e) => setRequirementsPath(e.target.value)}
                  placeholder={requirementsDefault || 'auto-detected sibling'}
                  className="w-full px-2.5 py-1.5 rounded-md border border-app bg-app-card text-theme-primary text-sm font-mono placeholder:text-theme-subtle focus:outline-none focus:border-accent-blue/60"
                />
              </Field>
            </>
          )}
        </>
      ) : (
        <>
          <Field label="Type">
            <select
              value={type}
              onChange={(event) => setType(event.target.value as McpServer['type'])}
              className="h-9 w-full rounded-md border border-app bg-app-card px-2.5 text-sm text-theme-primary outline-none transition-colors focus:border-accent-blue/60"
            >
              <option value="stdio">stdio</option>
              <option value="http">http</option>
              <option value="sse">sse</option>
            </select>
          </Field>
          {type === 'stdio' ? (
            <>
              <Field label="Command">
                <input
                  value={command}
                  onChange={(event) => setCommand(event.target.value)}
                  placeholder="node"
                  className="w-full px-2.5 py-1.5 rounded-md border border-app bg-app-card text-theme-primary text-sm font-mono placeholder:text-theme-subtle focus:outline-none focus:border-accent-blue/60"
                />
              </Field>
              <Field label="Args">
                <textarea
                  value={argsInput}
                  onChange={(event) => setArgsInput(event.target.value)}
                  rows={3}
                  placeholder="one argument per line"
                  className="w-full px-2.5 py-1.5 rounded-md border border-app bg-app-card text-theme-primary text-sm font-mono placeholder:text-theme-subtle focus:outline-none focus:border-accent-blue/60"
                />
              </Field>
            </>
          ) : (
            <>
              <Field label="URL">
                <input
                  value={url}
                  onChange={(event) => setUrl(event.target.value)}
                  placeholder="https://..."
                  className="w-full px-2.5 py-1.5 rounded-md border border-app bg-app-card text-theme-primary text-sm font-mono placeholder:text-theme-subtle focus:outline-none focus:border-accent-blue/60"
                />
              </Field>
              <Field label="Headers JSON">
                <textarea
                  value={headersInput}
                  onChange={(event) => setHeadersInput(event.target.value)}
                  rows={3}
                  placeholder='{"Authorization":"Bearer ..."}'
                  className="w-full px-2.5 py-1.5 rounded-md border border-app bg-app-card text-theme-primary text-sm font-mono placeholder:text-theme-subtle focus:outline-none focus:border-accent-blue/60"
                />
              </Field>
            </>
          )}
        </>
      )}

      {isDesktop ? (
        <Field label="Credential values">
          <div className="space-y-2">
            {credentialRows.map((row) => {
              const fullKey = fullCredentialKey(row.key);
              return (
                <div key={row.id} className="grid grid-cols-[minmax(0,0.85fr)_minmax(0,1fr)_auto] gap-2">
                  <input
                    type="text"
                    value={row.key}
                    onChange={(event) => updateCredentialRow(row.id, event.target.value)}
                    placeholder="API_KEY"
                    className="min-w-0 px-2.5 py-1.5 rounded-md border border-app bg-app-card text-theme-primary text-sm font-mono placeholder:text-theme-subtle focus:outline-none focus:border-accent-blue/60"
                  />
                  <input
                    type="password"
                    autoComplete="off"
                    value={credentialDrafts[fullKey] ?? ''}
                    onChange={(event) => setCredentialDrafts((prev) => ({ ...prev, [fullKey]: event.target.value }))}
                    placeholder="keep existing"
                    className="min-w-0 px-2.5 py-1.5 rounded-md border border-app bg-app-card text-theme-primary text-sm font-mono placeholder:text-theme-subtle focus:outline-none focus:border-accent-blue/60"
                  />
                  <IconTooltipButton label="Remove credential" tone="danger" onClick={() => removeCredentialRow(row.id)}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </IconTooltipButton>
                </div>
              );
            })}
            <button
              type="button"
              onClick={() => addCredentialRow()}
              className="inline-flex items-center gap-1.5 rounded-md border border-app px-2.5 py-1.5 text-[12px] text-theme-secondary transition-colors hover:bg-app-muted hover:text-theme-primary"
            >
              <Plus className="h-3.5 w-3.5" />
              Add credential
            </button>
            <div className="text-[10px] text-theme-subtle font-body">
              Values are saved in the desktop secret store. Blank values keep the existing saved value.
            </div>
          </div>
        </Field>
      ) : (
        <Field label="Env keys">
          <textarea
            placeholder="Bare credential names from .env — e.g. POSTGRES_HOST, POSTGRES_PORT"
            value={envKeysInput}
            onChange={(e) => setEnvKeysInput(e.target.value)}
            className="w-full px-2.5 py-1.5 rounded-md border border-app bg-app-card text-theme-primary text-sm font-mono placeholder:text-theme-subtle focus:outline-none focus:border-accent-blue/60 min-h-[60px]"
          />
          {envKeys.length > 0 && (
            <div className="text-[10px] text-theme-subtle mt-1 font-mono">
              Web expects these to exist in .env as: <span className="text-theme-muted">{credentialKeys(envKeys).join(', ')}</span>
            </div>
          )}
        </Field>
      )}

      {missing && <MissingEnvError missing={missing} onDismiss={() => setMissing(null)} />}
      {error && <div className="text-xs text-accent-red font-mono">{error}</div>}

      <div className="flex justify-end gap-2 pt-2">
        <button
          onClick={onClose}
          disabled={busy}
          className="px-3 py-1.5 rounded-md border border-app text-theme-secondary hover:bg-app-muted text-sm font-body transition-colors disabled:cursor-not-allowed disabled:opacity-60"
        >
          Cancel
        </button>
        <button
          onClick={() => void submit()}
          disabled={busy || !name.trim() || (isRepoSource && !entryPath.trim())}
          className="px-3 py-1.5 rounded-md bg-accent-blue text-white hover:opacity-90 disabled:opacity-40 text-sm font-body flex items-center gap-1.5 transition-opacity"
        >
          {busy && <Loader2 className="w-3 h-3 animate-spin" />}
          Save changes
        </button>
      </div>
    </div>
  );
}

function McpDetailLine({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="grid gap-2 text-[12px] sm:grid-cols-[88px_minmax(0,1fr)]">
      <div className="text-theme-muted">{label}</div>
      <div className={`min-w-0 truncate text-theme-secondary ${mono ? 'font-mono' : ''}`} title={value}>
        {value}
      </div>
    </div>
  );
}

function formatMcpDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString([], {
    day: 'numeric',
    hour: '2-digit',
    hour12: true,
    minute: '2-digit',
    month: 'short',
    year: 'numeric',
  });
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
            Missing required credential{missing.length > 1 ? 's' : ''}
          </div>
          <div className="text-theme-muted mb-2">
            Add the following in this dialog or in Settings → Integrations → Secrets, then retry:
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

function fullCredentialKey(key: string): string {
  return key.startsWith('ALLEN_') ? key : `ALLEN_${key}`;
}

function credentialKeys(keys: string[]): string[] {
  return Array.from(new Set(keys.map((key) => fullCredentialKey(key.trim())).filter(Boolean)));
}

function credentialsFromDrafts(keys: string[], drafts: Record<string, string>): Record<string, string> | undefined {
  const entries = credentialKeys(keys)
    .map((key) => [key, drafts[key]?.trim() ?? ''] as const)
    .filter(([, value]) => value !== '');
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function missingCredentialsFromError(error: Error): string[] | null {
  const body = (error as Error & { body?: { missing?: unknown } }).body;
  if (body && Array.isArray(body.missing)) return body.missing.map(String);
  const match = error.message.match(/Missing required credentials?: ([^.]+)\./);
  return match ? match[1].split(',').map((item) => item.trim()).filter(Boolean) : null;
}

function CredentialInputs({
  keys,
  drafts,
  onDraftChange,
}: {
  keys: string[];
  drafts: Record<string, string>;
  onDraftChange: (key: string, value: string) => void;
}) {
  const normalized = credentialKeys(keys);
  if (normalized.length === 0) return null;
  return (
    <div className="mt-2 space-y-1.5">
      {normalized.map((key) => (
        <input
          key={key}
          type="password"
          autoComplete="off"
          value={drafts[key] ?? ''}
          onChange={(event) => onDraftChange(key, event.target.value)}
          placeholder={`${key} value`}
          className="w-full px-2.5 py-1.5 rounded-md border border-app bg-app-card text-theme-primary text-xs font-mono placeholder:text-theme-subtle focus:outline-none focus:border-accent-blue/60"
        />
      ))}
    </div>
  );
}

// ── Add MCP: choose Preset or Repo ──────────────────────────────────────────

type AddMode = 'preset' | 'repo';

type PresetCategory = 'Google' | 'Development' | 'Design' | 'Data' | 'Productivity' | 'Local';

const CATEGORY_STYLES: Record<PresetCategory, string> = {
  Google: 'border-accent-blue/25 bg-accent-blue/10 text-accent-blue',
  Development: 'border-accent-green/25 bg-accent-green/10 text-accent-green',
  Design: 'border-accent-yellow/25 bg-accent-yellow/10 text-accent-yellow',
  Data: 'border-accent-blue/25 bg-accent-blue/10 text-accent-blue',
  Productivity: 'border-app bg-app-muted/45 text-theme-secondary',
  Local: 'border-app bg-app-muted/45 text-theme-secondary',
};

function presetCategory(preset: McpPreset): PresetCategory {
  if (preset.name.startsWith('google-')) return 'Google';
  if (['github', 'git'].includes(preset.name)) return 'Development';
  if (preset.name === 'figma') return 'Design';
  if (['postgres', 'mongodb', 'mysql'].includes(preset.name)) return 'Data';
  if (['filesystem', 'memory'].includes(preset.name)) return 'Local';
  return 'Productivity';
}

function PresetIcon({ preset, className = 'h-4 w-4' }: { preset: McpPreset; className?: string }) {
  const name = preset.name;
  const Icon =
    name === 'github' ? Github
    : name === 'google-docs' ? FileText
    : name === 'google-sheets' ? Table2
    : name === 'google-meet' ? Video
    : name === 'google-workspace' ? HardDrive
    : name === 'figma' ? Figma
    : name === 'jira' || name === 'linear' ? BriefcaseBusiness
    : name === 'postgres' || name === 'mongodb' || name === 'mysql' ? Database
    : name === 'slack' ? MessageSquare
    : name === 'memory' ? Brain
    : name === 'filesystem' ? Folder
    : Package;
  return <Icon className={className} />;
}

function NativePresetIcon({ preset }: { preset: McpPreset }) {
  const name = preset.name;
  if (name === 'figma') {
    return (
      <div className="grid h-8 w-8 grid-cols-2 grid-rows-3 overflow-hidden rounded-md border border-app bg-app-card p-1">
        <span className="rounded-full bg-[#f24e1e]" />
        <span className="rounded-full bg-[#ff7262]" />
        <span className="rounded-full bg-[#a259ff]" />
        <span className="rounded-full bg-[#1abcfe]" />
        <span className="rounded-full bg-[#0acf83]" />
      </div>
    );
  }
  if (name === 'github') {
    return (
      <div className="flex h-8 w-8 items-center justify-center rounded-md border border-app bg-app-card text-theme-primary">
        <Github className="h-4 w-4" />
      </div>
    );
  }
  if (name === 'google-docs') return <BrandTile label="D" color="bg-[#1a73e8]" Icon={FileText} />;
  if (name === 'google-sheets') return <BrandTile label="S" color="bg-[#188038]" Icon={Table2} />;
  if (name === 'google-meet') return <BrandTile label="M" color="bg-[#1a73e8]" Icon={Video} />;
  if (name === 'google-workspace') return <GoogleTile />;
  if (name === 'jira') return <BrandTile label="J" color="bg-[#0c66e4]" Icon={BriefcaseBusiness} />;
  if (name === 'linear') return <BrandTile label="L" color="bg-[#5e6ad2]" Icon={BriefcaseBusiness} />;
  if (name === 'slack') return <BrandTile label="S" color="bg-[#4a154b]" Icon={MessageSquare} />;
  if (name === 'postgres') return <PostgresTile />;
  if (name === 'mongodb') return <MongoDbTile />;
  if (name === 'mysql') return <MySqlTile />;
  if (name === 'memory') return <BrandTile label="M" color="bg-app-muted" Icon={Brain} muted />;
  if (name === 'filesystem') return <BrandTile label="F" color="bg-app-muted" Icon={Folder} muted />;
  return (
    <div className={`flex h-8 w-8 items-center justify-center rounded-md border ${CATEGORY_STYLES[presetCategory(preset)]}`}>
      <PresetIcon preset={preset} className="h-4 w-4" />
    </div>
  );
}

function BrandTile({
  Icon,
  color,
  muted = false,
}: {
  label: string;
  Icon: React.ComponentType<{ className?: string }>;
  color: string;
  muted?: boolean;
}) {
  return (
    <div className={`flex h-8 w-8 items-center justify-center rounded-md border ${muted ? 'border-app text-theme-secondary' : 'border-transparent text-white'} ${color}`}>
      <Icon className="h-3.5 w-3.5" />
    </div>
  );
}

function GoogleTile() {
  return (
    <div className="grid h-8 w-8 grid-cols-2 overflow-hidden rounded-md border border-app bg-app-card">
      <span className="bg-[#4285f4]" />
      <span className="bg-[#34a853]" />
      <span className="bg-[#fbbc04]" />
      <span className="bg-[#ea4335]" />
    </div>
  );
}

function PostgresTile() {
  return (
    <div className="flex h-8 w-8 items-center justify-center rounded-md border border-transparent bg-[#336791] text-white">
      <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path
          d="M6.7 13.4C5.3 12.5 4.5 11 4.5 9.3c0-3.1 2.9-5.4 6.6-5.4h2c3.7 0 6.4 2.4 6.4 5.6 0 1.8-.8 3.3-2.4 4.2"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M8.3 8.6v6.7c0 1.4 1 2.4 2.4 2.4h.9"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M15.7 8.6v7.2c0 2.7-1.5 4.1-3.7 4.1-.9 0-1.8-.2-2.5-.7"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M15.8 13.8c1.3.1 2.3.5 2.8 1.2.5.7.3 1.5-.3 1.9-.9.6-2.6.2-4.2-.9"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <circle cx="9" cy="9.3" r=".8" fill="currentColor" />
        <circle cx="15" cy="9.3" r=".8" fill="currentColor" />
      </svg>
    </div>
  );
}

function MongoDbTile() {
  return (
    <div className="flex h-8 w-8 items-center justify-center rounded-md border border-[#13aa52]/25 bg-app-card">
      <svg className="h-5 w-5 text-[#13aa52]" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path
          d="M12.2 2.7c3.2 3.1 5.2 6.6 5.2 10 0 4.1-2.4 6.9-5.2 8.6-2.8-1.7-5.1-4.5-5.1-8.6 0-3.4 1.9-6.9 5.1-10Z"
          fill="currentColor"
        />
        <path
          d="M12.2 5.5v14.9"
          stroke="white"
          strokeWidth="1.4"
          strokeLinecap="round"
          opacity=".85"
        />
      </svg>
    </div>
  );
}

function MySqlTile() {
  return (
    <div className="flex h-8 w-8 items-center justify-center rounded-md border border-[#00758f]/25 bg-app-card">
      <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path
          d="M4.5 15.8c2.1-4.5 6.2-7.4 11.3-7.9 1.7-.2 3.1.1 4.1.9-1.3.1-2.3.5-3 1.3 1.4.2 2.5.9 3.2 2-2.1-.4-3.9-.1-5.4.8-1.8 1.1-2.9 3.2-4.6 4.4-2 1.4-4.4.8-5.6-1.5Z"
          fill="#00758f"
        />
        <path
          d="M8.1 12.8c1.2-.7 2.7-1 4.2-.9-1.1.7-2 1.6-2.7 2.7-.8-.4-1.3-1-1.5-1.8Z"
          fill="#f29111"
        />
        <path
          d="M15.1 8.3c.6-1.1 1.5-1.8 2.7-2.2-.2 1.1-.8 2-1.8 2.7"
          stroke="#00758f"
          strokeWidth="1.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </div>
  );
}

function presetCommandPreview(preset: McpPreset): string {
  if (preset.type === 'http' || preset.type === 'sse') return preset.url ?? preset.type;
  return [preset.command, ...(preset.args ?? [])].filter(Boolean).join(' ');
}

function McpServerModalShell({
  title,
  description,
  onClose,
  closeDisabled = false,
  tabs,
  children,
  maxWidth = 'max-w-4xl',
}: {
  title: string;
  description: React.ReactNode;
  onClose: () => void;
  closeDisabled?: boolean;
  tabs?: React.ReactNode;
  children: React.ReactNode;
  maxWidth?: string;
}) {
  useEffect(() => {
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !closeDisabled) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener('keydown', onKey);
    };
  }, [closeDisabled, onClose]);

  // Portal to document.body so no ancestor's backdrop-filter / transform /
  // contain / filter creates a containing block that clips a `position:
  // fixed` overlay. The McpServerManager card uses `backdrop-blur-sm` on
  // both the sticky header and the `.card` class itself — either would trap
  // a fixed modal rendered as a direct child of the card.
  return createPortal(
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center overflow-y-auto bg-black/55 p-4 backdrop-blur-sm"
      onClick={() => { if (!closeDisabled) onClose(); }}
    >
      <div
        className={`flex max-h-[88vh] w-full ${maxWidth} flex-col overflow-hidden rounded-lg border border-app bg-app-card shadow-2xl`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4 border-b border-app px-5 py-4">
          <div className="min-w-0">
            <h3 className="text-[15px] font-semibold text-theme-primary">{title}</h3>
            <p className="mt-1 text-[12px] leading-5 text-theme-muted">{description}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={closeDisabled}
            className="rounded-md p-1.5 text-theme-muted transition-colors hover:bg-app-muted hover:text-theme-secondary disabled:cursor-not-allowed disabled:opacity-60"
          >
            <XIcon className="h-4 w-4" />
          </button>
        </div>
        {tabs}
        <div className="min-w-0 flex-1 overflow-y-auto overflow-x-hidden p-5">
          {children}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function AddServerModal({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
  const [mode, setMode] = useState<AddMode>('preset');

  return (
    <McpServerModalShell
      title="Add MCP server"
      description="Connect Allen to external tools through curated presets or a repository-hosted MCP server."
      onClose={onClose}
      tabs={(
        <div className="flex gap-1 border-b border-app px-5 pt-3">
          <TabButton active={mode === 'preset'} onClick={() => setMode('preset')} icon={<Package className="h-3.5 w-3.5" />}>Preset</TabButton>
          <TabButton active={mode === 'repo'} onClick={() => setMode('repo')} icon={<FolderGit2 className="h-3.5 w-3.5" />}>Repository</TabButton>
        </div>
      )}
    >
      {mode === 'preset' ? <AddFromPreset onAdded={onAdded} onClose={onClose} /> : <AddFromRepo onAdded={onAdded} onClose={onClose} />}
    </McpServerModalShell>
  );
}

function TabButton({ active, onClick, icon, children }: { active: boolean; onClick: () => void; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1.5 rounded-t border-b-2 px-3 py-2 text-[12px] font-medium transition-colors ${
        active
          ? 'border-accent text-theme-primary'
          : 'border-transparent text-theme-muted hover:text-theme-secondary'
      }`}
    >
      {icon}{children}
    </button>
  );
}

// ── Preset picker ───────────────────────────────────────────────────────────

function AddFromPreset({ onAdded, onClose, initialPresetName }: { onAdded: () => void; onClose: () => void; initialPresetName?: string }) {
  const [presets, setPresets] = useState<McpPreset[]>([]);
  const [configuringName, setConfiguringName] = useState<string | null>(initialPresetName ?? null);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [missing, setMissing] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [credentialDrafts, setCredentialDrafts] = useState<Record<string, Record<string, string>>>({});
  const [nameDrafts, setNameDrafts] = useState<Record<string, string>>({});
  const [connectResult, setConnectResult] = useState<{
    presetName: string;
    status: 'testing' | 'connected' | 'failed';
    text: string;
  } | null>(null);

  useEffect(() => {
    api.presets()
      .then(setPresets)
      .catch((e) => setError(e.message));
  }, []);

  const filteredPresets = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return presets;
    return presets.filter((preset) => (
      preset.name.toLowerCase().includes(needle)
      || preset.description.toLowerCase().includes(needle)
    ));
  }, [presets, query]);

  const configuringPreset = presets.find((preset) => preset.name === configuringName) ?? null;

  // When opened directly for a specific preset, show a loading spinner until the
  // presets list resolves, then jump straight to the configure form.
  if (initialPresetName && !configuringPreset) {
    if (presets.length === 0 && !error) {
      return (
        <div className="flex items-center justify-center gap-2 py-12 font-mono text-[12px] text-theme-muted">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading preset…
        </div>
      );
    }
    return (
      <div className="rounded-md border border-accent-red/30 bg-accent-red/10 px-4 py-4 text-[12px] text-accent-red">
        Preset &quot;{initialPresetName}&quot; not found.
      </div>
    );
  }

  function presetCredentialKeys(preset: McpPreset): string[] {
    return [...preset.envKeys, ...(preset.argKeys ?? [])];
  }

  async function add(p: McpPreset) {
    setMissing(null);
    setError(null);
    setConnectResult(null);
    const serverName = (nameDrafts[p.name] ?? p.name).trim();
    if (!serverName) {
      setError('MCP server name is required.');
      return;
    }
    setBusy(p.name);
    let created: McpServer | null = null;
    try {
      setConnectResult({ presetName: p.name, status: 'testing', text: 'Checking connection' });
      created = await api.create({
        name: serverName,
        type: p.type,
        description: p.description,
        enabled: true,
        source: { kind: 'preset', presetName: p.name },
        credentials: credentialsFromDrafts(presetCredentialKeys(p), credentialDrafts[p.name] ?? {}),
      });

      const result = await api.test(created._id);
      if (result.status === 'connected') {
        setConnectResult({
          presetName: p.name,
          status: 'connected',
          text: `${result.toolCount ?? 0} tool${result.toolCount === 1 ? '' : 's'} available`,
        });
        onAdded();
        return;
      }

      await api.delete(created._id).catch(() => {});
      setConnectResult({
        presetName: p.name,
        status: 'failed',
        text: result.error ?? 'Connection test failed',
      });
    } catch (e) {
      const err = e as Error;
      if (created?._id) await api.delete(created._id).catch(() => {});
      const missingCredentials = missingCredentialsFromError(err);
      setConnectResult(null);
      if (missingCredentials) {
        setMissing(missingCredentials);
      } else {
        setError(err.message);
      }
    } finally {
      setBusy(null);
    }
  }

  if (configuringPreset) {
    const keys = presetCredentialKeys(configuringPreset);
    const resultForPreset = connectResult?.presetName === configuringPreset.name ? connectResult : null;
    const isTesting = resultForPreset?.status === 'testing';
    const isConnected = resultForPreset?.status === 'connected';
    return (
      <div className="overflow-hidden rounded-lg border border-app bg-app-card">
        <div className="flex items-start gap-3 border-b border-app px-4 py-4">
          <NativePresetIcon preset={configuringPreset} />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h4 className="text-[15px] font-semibold text-theme-primary">Connect {configuringPreset.name}</h4>
              <span className="rounded-sm border border-app bg-app-muted/45 px-1.5 py-0.5 font-mono text-[10px] text-theme-muted">
                {configuringPreset.type}
              </span>
              {resultForPreset?.status === 'connected' ? (
                <span className="inline-flex items-center gap-1 rounded-sm border border-accent-green/20 bg-accent-green/10 px-1.5 py-0.5 text-[10px] font-medium text-accent-green">
                  <CheckCircle className="h-3 w-3" />
                  Connected
                </span>
              ) : resultForPreset?.status === 'failed' ? (
                <span className="inline-flex items-center gap-1 rounded-sm border border-accent-red/25 bg-accent-red/10 px-1.5 py-0.5 text-[10px] font-medium text-accent-red">
                  <XCircle className="h-3 w-3" />
                  Connection failed
                </span>
              ) : isTesting ? (
                <span className="inline-flex items-center gap-1 rounded-sm border border-accent/25 bg-accent/10 px-1.5 py-0.5 text-[10px] font-medium text-accent">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  Checking connection
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 rounded-sm border border-app bg-app-muted/45 px-1.5 py-0.5 text-[10px] font-medium text-theme-muted">
                  <CheckCircle className="h-3 w-3" />
                  Ready to connect
                </span>
              )}
            </div>
            <p className="mt-1 max-w-3xl text-[12px] leading-5 text-theme-muted">{configuringPreset.description}</p>
            <div className="mt-2 max-w-3xl truncate rounded-md border border-app bg-app px-2.5 py-1.5 font-mono text-[11px] text-theme-secondary">
              {presetCommandPreview(configuringPreset)}
            </div>
            {resultForPreset && (
              <div className={`mt-2 rounded-md border px-2.5 py-2 text-[12px] ${
                resultForPreset.status === 'connected'
                  ? 'border-accent-green/25 bg-accent-green/10 text-accent-green'
                  : resultForPreset.status === 'failed'
                    ? 'border-accent-red/25 bg-accent-red/10 text-accent-red'
                    : 'border-app bg-app text-theme-muted'
              }`}>
                {resultForPreset.text}
              </div>
            )}
          </div>
          {configuringPreset.docsUrl && (
            <a
              href={configuringPreset.docsUrl}
              target="_blank"
              rel="noreferrer"
              className="rounded-md p-1.5 text-theme-muted transition-colors hover:bg-app-muted hover:text-accent"
              title="Open documentation"
            >
              <ExternalLink className="h-4 w-4" />
            </a>
          )}
        </div>

        <div className="p-4">
          <div className="space-y-4">
            <section className="rounded-lg border border-app bg-app p-3">
              <label className="block">
                <span className="text-[12px] font-semibold text-theme-primary">MCP name</span>
                <input
                  value={nameDrafts[configuringPreset.name] ?? configuringPreset.name}
                  onChange={(event) => {
                    const value = event.target.value;
                    setNameDrafts((prev) => ({ ...prev, [configuringPreset.name]: value }));
                    setError(null);
                    setConnectResult(null);
                  }}
                  disabled={isTesting || isConnected}
                  placeholder={configuringPreset.name}
                  className="mt-2 h-9 w-full rounded-md border border-app bg-app-card px-3 font-mono text-[12px] text-theme-primary outline-none transition-colors placeholder:text-theme-subtle focus:border-accent focus:ring-2 focus:ring-accent/15 disabled:cursor-not-allowed disabled:opacity-70"
                />
              </label>
            </section>

            <section className="rounded-lg border border-app bg-app p-3">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-[12px] font-semibold text-theme-primary">Variables</div>
                  <p className="mt-1 text-[12px] leading-5 text-theme-muted">
                    Add only the values. Allen stores them and forwards the matching keys to this MCP server.
                  </p>
                </div>
                <span className="shrink-0 rounded-sm border border-app bg-app-card px-1.5 py-0.5 font-mono text-[10px] text-theme-muted">
                  {keys.length} required
                </span>
              </div>

              {keys.length > 0 ? (
                <div className="mt-3 space-y-2">
                  {credentialKeys(keys).map((key) => (
                    <label
                      key={key}
                      className="grid items-center gap-3 rounded-md border border-app bg-app-card p-3 md:grid-cols-[minmax(0,1fr)_minmax(260px,360px)]"
                    >
                      <span className="min-w-0">
                        <span className="block text-[11px] font-medium text-theme-muted">Key</span>
                        <span className="mt-1 block truncate font-mono text-[11px] leading-5 text-theme-secondary" title={key}>
                          {key}
                        </span>
                      </span>
                      <input
                        type="password"
                        autoComplete="off"
                        value={credentialDrafts[configuringPreset.name]?.[key] ?? ''}
                        onChange={(event) => {
                          const value = event.target.value;
                          setConnectResult(null);
                          setCredentialDrafts((prev) => ({
                            ...prev,
                            [configuringPreset.name]: { ...(prev[configuringPreset.name] ?? {}), [key]: value },
                          }));
                        }}
                        disabled={isTesting || isConnected}
                        placeholder="Enter value"
                        className="h-9 w-full rounded-md border border-app bg-app px-3 font-mono text-[12px] text-theme-primary outline-none transition-colors placeholder:text-theme-subtle focus:border-accent focus:ring-2 focus:ring-accent/15 disabled:cursor-not-allowed disabled:opacity-70"
                      />
                    </label>
                  ))}
                </div>
              ) : (
                <div className="mt-3 rounded-md border border-app bg-app-card px-3 py-3 text-[12px] text-theme-muted">
                  No variables are required. Connect will register the preset with its default connection.
                </div>
              )}

              <div className="mt-3 space-y-2">
                {missing && <MissingEnvError missing={missing} onDismiss={() => setMissing(null)} />}
                {error && <div className="rounded-md border border-accent-red/30 bg-accent-red/10 px-3 py-2 font-mono text-[11px] text-accent-red">{error}</div>}
              </div>
            </section>
          </div>
        </div>

        <div className="flex justify-end gap-2 border-t border-app px-4 py-4">
          <button
            type="button"
            onClick={() => {
              if (!busy) {
                if (initialPresetName) {
                  // Opened directly for a preset — Back closes the modal.
                  onClose();
                } else {
                  setConfiguringName(null);
                }
                setMissing(null);
                setError(null);
                setConnectResult(null);
              }
            }}
            disabled={isTesting}
            className="inline-flex h-9 items-center justify-center rounded-md border border-app bg-app-card px-3 text-[13px] font-medium text-theme-secondary transition-colors hover:bg-app-muted hover:text-theme-primary disabled:cursor-not-allowed disabled:opacity-60"
          >
            Back
          </button>
          <button
            type="button"
            onClick={() => {
              if (isConnected) onClose();
              else void add(configuringPreset);
            }}
            disabled={isTesting}
            className="inline-flex h-9 items-center justify-center gap-2 rounded-md border border-accent/40 bg-accent px-3.5 text-[13px] font-medium text-white transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isTesting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle className="h-3.5 w-3.5" />}
            {isConnected ? 'Done' : isTesting ? 'Testing' : 'Connect'}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-[520px] rounded-lg border border-app bg-app">
      <div className="flex flex-col gap-3 border-b border-app p-3 md:flex-row md:items-center md:justify-between">
        <div className="min-w-0">
          <div className="text-[13px] font-semibold text-theme-primary">Available presets</div>
          <p className="mt-0.5 text-[12px] text-theme-muted">Choose a service, then connect with the required variables.</p>
        </div>
        <label className="relative block md:w-72">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-theme-subtle" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search presets"
            className="h-9 w-full rounded-md border border-app bg-app-card pl-8 pr-3 text-[13px] text-theme-primary outline-none transition-colors placeholder:text-theme-subtle focus:border-accent focus:ring-2 focus:ring-accent/15"
          />
        </label>
      </div>
      <div className="max-h-[460px] overflow-y-auto p-3">
        <div className="grid gap-2">
          {filteredPresets.map((preset) => {
            const keys = presetCredentialKeys(preset);
            return (
              <div
                key={preset.name}
                className="grid gap-3 rounded-lg border border-app bg-app-card p-3 transition-colors hover:border-app-strong hover:bg-app-muted/25 md:grid-cols-[minmax(0,1fr)_auto]"
              >
                <div className="flex min-w-0 items-start gap-3">
                  <NativePresetIcon preset={preset} />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-[13px] font-semibold text-theme-primary">{preset.name}</span>
                      <span className="rounded-sm border border-app bg-app-muted/45 px-1.5 py-0.5 font-mono text-[10px] text-theme-muted">
                        {preset.type}
                      </span>
                    </div>
                    <p className="mt-1 text-[12px] leading-5 text-theme-muted">{preset.description}</p>
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <span className="max-w-full truncate rounded-sm bg-app-muted px-1.5 py-0.5 font-mono text-[10px] text-theme-subtle">
                        {presetCommandPreview(preset)}
                      </span>
                      <span className="rounded-sm bg-app-muted px-1.5 py-0.5 font-mono text-[10px] text-theme-muted">
                        {keys.length > 0 ? `${keys.length} variables` : 'no variables'}
                      </span>
                    </div>
                  </div>
                </div>
                <div className="flex items-center justify-end gap-2">
                  {preset.docsUrl && (
                    <a
                      href={preset.docsUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-app text-theme-muted transition-colors hover:bg-app-muted hover:text-accent"
                      title="Open documentation"
                    >
                      <ExternalLink className="h-3.5 w-3.5" />
                    </a>
                  )}
                  <button
                    type="button"
                    onClick={() => {
                      setNameDrafts((prev) => ({ ...prev, [preset.name]: prev[preset.name] ?? preset.name }));
                      setConfiguringName(preset.name);
                      setMissing(null);
                      setError(null);
                      setConnectResult(null);
                    }}
                    className="inline-flex h-8 items-center justify-center rounded-md border border-accent/40 bg-accent px-3 text-[12px] font-medium text-white transition-colors hover:bg-accent-hover"
                  >
                    Connect
                  </button>
                </div>
              </div>
            );
          })}
          {filteredPresets.length === 0 && (
            <div className="rounded-lg border border-dashed border-app px-4 py-10 text-center text-[12px] text-theme-muted">
              No matching presets.
            </div>
          )}
        </div>
      </div>
      <div className="flex justify-end border-t border-app p-3">
        <button
          type="button"
          onClick={onClose}
          className="inline-flex h-9 items-center justify-center rounded-md border border-app bg-app-card px-3 text-[13px] font-medium text-theme-secondary transition-colors hover:bg-app-muted hover:text-theme-primary"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

// ── Repo picker ─────────────────────────────────────────────────────────────

interface RepoSummary { _id: string; name: string; path: string; }
type CredentialRow = { id: string; key: string };

function bareCredentialKey(key: string): string {
  return key.trim().split('=')[0]?.trim().replace(/^ALLEN_/, '') ?? '';
}

function AddFromRepo({ onAdded, onClose }: { onAdded: () => void; onClose: () => void }) {
  const isDesktop = typeof window !== 'undefined' && Boolean(window.allenDesktop);
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
  const [credentialRows, setCredentialRows] = useState<CredentialRow[]>([]);
  const [credentialDrafts, setCredentialDrafts] = useState<Record<string, string>>({});
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

  const declaredEnvKeys = useMemo(
    () => envKeysInput.split(/[\s,]+/).map((s) => bareCredentialKey(s)).filter(Boolean),
    [envKeysInput],
  );
  const rowEnvKeys = useMemo(
    () => credentialRows.map((row) => bareCredentialKey(row.key)).filter(Boolean),
    [credentialRows],
  );
  const envKeys = useMemo(
    () => Array.from(new Set(isDesktop ? rowEnvKeys : declaredEnvKeys)),
    [declaredEnvKeys, isDesktop, rowEnvKeys],
  );
  const repoOptions = useMemo(
    () => [
      { value: '', label: 'Pick a repo' },
      ...userRepos.map(repo => ({
        value: repo._id,
        label: repo.name,
        sublabel: repo.path,
      })),
    ],
    [userRepos],
  );
  const candidateOptions = useMemo(
    () => [
      { value: '', label: 'Pick a candidate' },
      ...(discover?.candidates ?? []).map(candidate => ({
        value: candidate.repoRelative,
        label: candidate.repoRelative,
        sublabel: candidate.detectedLanguage,
      })),
    ],
    [discover?.candidates],
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
        credentials: isDesktop ? credentialsFromDrafts(envKeys, credentialDrafts) : undefined,
        command: trimmedCommand || undefined,
        python: pythonBlock,
      });
      onAdded();
      onClose();
    } catch (e) {
      const err = e as Error;
      const missingCredentials = missingCredentialsFromError(err);
      if (missingCredentials) {
        setMissing(missingCredentials);
        if (isDesktop) {
          setCredentialRows((current) => {
            const existing = new Set(current.map((row) => fullCredentialKey(row.key)));
            const additions = missingCredentials
              .filter((key) => !existing.has(fullCredentialKey(key)))
              .map((key) => ({ id: `${Date.now()}-${key}`, key: bareCredentialKey(key) }));
            return [...current, ...additions];
          });
        }
      } else {
        setError(err.message);
      }
    } finally {
      setBusy(false);
    }
  }

  function updateCredentialRow(id: string, nextKey: string) {
    setCredentialRows((current) => {
      const previous = current.find((row) => row.id === id);
      if (previous) {
        const previousFullKey = fullCredentialKey(previous.key);
        const nextFullKey = fullCredentialKey(nextKey);
        if (previousFullKey !== nextFullKey) {
          setCredentialDrafts((drafts) => {
            const next = { ...drafts };
            if (next[previousFullKey] !== undefined && next[nextFullKey] === undefined) {
              next[nextFullKey] = next[previousFullKey];
            }
            delete next[previousFullKey];
            return next;
          });
        }
      }
      return current.map((row) => row.id === id ? { ...row, key: nextKey } : row);
    });
  }

  function removeCredentialRow(id: string) {
    setCredentialRows((current) => {
      const row = current.find((item) => item.id === id);
      if (row) {
        const fullKey = fullCredentialKey(row.key);
        setCredentialDrafts((drafts) => {
          const next = { ...drafts };
          delete next[fullKey];
          return next;
        });
      }
      return current.filter((item) => item.id !== id);
    });
  }

  function addCredentialRow(key = '') {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    setCredentialRows((current) => [...current, { id, key }]);
  }

  return (
    <div className="space-y-4">
      <Field label="Repo">
        <Select
          value={selectedRepo?._id ?? ''}
          onChange={(value) => {
            const repo = userRepos.find((r) => r._id === value);
            if (repo) onPickRepo(repo);
          }}
          options={repoOptions}
          placeholder="Pick a repo"
          searchPlaceholder="Search repos..."
        />
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
                <Select
                  value={entryPath}
                  onChange={(value) => {
                    setEntryPath(value);
                    const last = value.lastIndexOf('/');
                    if (last > 0) setInstallPath(value.slice(0, last));
                    const candidate = discover?.candidates.find((c) => c.repoRelative === value);
                    // For Python candidates, leave Command empty so Allen
                    // creates an isolated venv; user can override manually.
                    if (candidate) {
                      setCommand(candidate.detectedLanguage === 'python' ? '' : commandForCandidate(candidate));
                    }
                  }}
                  options={candidateOptions}
                  placeholder="Pick a candidate"
                  searchPlaceholder="Search candidates..."
                />
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
              placeholder="e.g. my-postgres"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full px-2.5 py-1.5 rounded-md border border-app bg-app-card text-theme-primary text-sm font-mono placeholder:text-theme-subtle focus:outline-none focus:border-accent-blue/60"
            />
          </Field>

          {isDesktop ? (
            <Field label="Credential values">
              <div className="space-y-2">
                {credentialRows.map((row) => {
                  const fullKey = fullCredentialKey(row.key);
                  return (
                    <div key={row.id} className="grid grid-cols-[minmax(0,0.85fr)_minmax(0,1fr)_auto] gap-2">
                      <input
                        type="text"
                        value={row.key}
                        onChange={(event) => updateCredentialRow(row.id, event.target.value)}
                        placeholder="API_KEY"
                        className="min-w-0 px-2.5 py-1.5 rounded-md border border-app bg-app-card text-theme-primary text-sm font-mono placeholder:text-theme-subtle focus:outline-none focus:border-accent-blue/60"
                      />
                      <input
                        type="password"
                        autoComplete="off"
                        value={credentialDrafts[fullKey] ?? ''}
                        onChange={(event) => setCredentialDrafts((prev) => ({ ...prev, [fullKey]: event.target.value }))}
                        placeholder="value"
                        className="min-w-0 px-2.5 py-1.5 rounded-md border border-app bg-app-card text-theme-primary text-sm font-mono placeholder:text-theme-subtle focus:outline-none focus:border-accent-blue/60"
                      />
                      <IconTooltipButton label="Remove credential" tone="danger" onClick={() => removeCredentialRow(row.id)}>
                        <Trash2 className="h-3.5 w-3.5" />
                      </IconTooltipButton>
                    </div>
                  );
                })}
                <button
                  type="button"
                  onClick={() => addCredentialRow()}
                  className="inline-flex items-center gap-1.5 rounded-md border border-app px-2.5 py-1.5 text-[12px] text-theme-secondary transition-colors hover:bg-app-muted hover:text-theme-primary"
                >
                  <Plus className="h-3.5 w-3.5" />
                  Add credential
                </button>
                <div className="text-[10px] text-theme-subtle font-body">
                  Values are saved in the desktop secret store. The MCP receives each value under the bare key name.
                </div>
              </div>
            </Field>
          ) : (
            <Field label="Env keys">
              <textarea
                placeholder="Bare credential names from .env — e.g. POSTGRES_HOST, POSTGRES_PORT"
                value={envKeysInput}
                onChange={(e) => setEnvKeysInput(e.target.value)}
                className="w-full px-2.5 py-1.5 rounded-md border border-app bg-app-card text-theme-primary text-sm font-mono placeholder:text-theme-subtle focus:outline-none focus:border-accent-blue/60 min-h-[60px]"
              />
              {envKeys.length > 0 && (
                <div className="text-[10px] text-theme-subtle mt-1 font-mono">
                  Web expects these to exist in .env as: <span className="text-theme-muted">{credentialKeys(envKeys).join(', ')}</span>
                </div>
              )}
            </Field>
          )}
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
    <div className="space-y-1.5">
      <label className="block text-[12px] font-medium text-theme-secondary">
        {label}
      </label>
      {children}
    </div>
  );
}

// ── Direct preset connect modal ────────────────────────────────────────────

/**
 * Opens the preset connect flow directly for the given preset (e.g. 'linear', 'github').
 * Skips the preset picker grid and jumps straight to the credential form.
 * Used by disconnected-state cards on TicketsPage, PullRequestListPage, and DashboardPage.
 */
export function McpPresetConnectModal({
  presetName,
  onClose,
  onConnected,
}: {
  presetName: string;
  onClose: () => void;
  onConnected: () => void;
}) {
  return (
    <McpServerModalShell
      title={`Connect ${presetName}`}
      description={`Provide the required credentials to connect Allen to ${presetName}.`}
      onClose={onClose}
      maxWidth="max-w-2xl"
    >
      <AddFromPreset
        onAdded={onConnected}
        onClose={onClose}
        initialPresetName={presetName}
      />
    </McpServerModalShell>
  );
}

// ── Main ────────────────────────────────────────────────────────────────────

export default function McpServerManager() {
  const isDesktop = typeof window !== 'undefined' && Boolean(window.allenDesktop);
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
    <div className="mcp-settings-panel">
      <div className="mcp-panel-head border-b border-app pb-4">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <Server className="w-4 h-4 text-accent-blue" />
              <h2 className="font-label text-xs uppercase tracking-widest text-theme-muted">Configured Servers</h2>
            </div>
            <p className="text-[11px] text-theme-muted font-body">
              {isDesktop
                ? 'Credentials are stored by Allen and passed only to the MCP servers that explicitly request them.'
                : 'Credentials are read from .env and passed only to the MCP servers that explicitly request them.'}
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

      <div className="mcp-panel-body space-y-3 pt-4">
        {err && <div className="text-xs text-accent-red font-mono">{err}</div>}

        {loading ? (
          <div className="text-xs text-theme-muted flex items-center gap-2">
            <Loader2 className="w-3 h-3 animate-spin" /> loading…
          </div>
        ) : servers.length === 0 ? (
          <div className="py-14 text-center">
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
            <div className="mcp-server-groups space-y-4">
              {ownerKeys.map(ownerLabel => (
                <div key={ownerLabel} className="mcp-server-group">
                  <h3 className="overline text-theme-muted mb-2 px-1">{ownerLabel}</h3>
                  <div className="mcp-server-list space-y-2">
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
