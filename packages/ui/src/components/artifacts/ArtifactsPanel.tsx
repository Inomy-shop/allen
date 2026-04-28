/**
 * ArtifactsPanel — compact list of artifacts filed under a given root
 * (chat session, workflow execution, or standalone agent run).
 *
 * List-only. The viewer lives in a separate pane managed by the parent
 * (ArtifactsDrawer renders a second, wider slide-out when an artifact
 * is selected).
 *
 * Rendered from:
 *   - ExecutionDetailPage artifacts drawer (rootType='workflow')
 *   - Chat detail drawer (rootType='chat')
 *   - Agent execution page drawer (rootType='agent')
 */
import { useEffect, useMemo, useState } from 'react';
import {
  FileText, Code2, FileJson, Database, FileSpreadsheet, File,
  RefreshCw, Search, X as XIcon,
} from 'lucide-react';
import { artifacts as artifactsApi, type ArtifactDoc } from '../../services/api';

export interface ArtifactsPanelProps {
  rootType: 'chat' | 'workflow' | 'agent';
  rootId: string;
  /** Id of the currently selected artifact — drives the row highlight. */
  selectedId?: string | null;
  /** Called when the user clicks a row. Parent is expected to open the viewer. */
  onSelect?: (artifact: ArtifactDoc) => void;
  /** Optional close button rendered in the header — when set, the parent
   *  drawer/overlay can rely on the panel's own chrome instead of stacking
   *  another header on top. */
  onClose?: () => void;
  /** Polling interval ms (default 5000 while active, 0 to disable). */
  pollIntervalMs?: number;
}

export default function ArtifactsPanel({
  rootType, rootId, selectedId, onSelect, onClose, pollIntervalMs = 5000,
}: ArtifactsPanelProps) {
  const [items, setItems] = useState<ArtifactDoc[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setError(null);
    try {
      const data = await artifactsApi.list({ rootType, rootId, limit: 500 });
      setItems(data ?? []);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, [rootType, rootId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!pollIntervalMs) return;
    const t = setInterval(load, pollIntervalMs);
    return () => clearInterval(t);
  }, [rootType, rootId, pollIntervalMs]); // eslint-disable-line react-hooks/exhaustive-deps

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return items;
    return items.filter(a =>
      a.filename.toLowerCase().includes(q)
      || a.relativePath.toLowerCase().includes(q)
      || (a.description ?? '').toLowerCase().includes(q)
      || (a.spawnContext?.nodeName ?? '').toLowerCase().includes(q)
      || (a.spawnContext?.agentName ?? '').toLowerCase().includes(q),
    );
  }, [items, search]);

  const grouped = useMemo(() => {
    const map = new Map<string, ArtifactDoc[]>();
    for (const a of filtered) {
      const key = a.spawnContext?.nodeName
        ?? a.spawnContext?.agentName
        ?? a.spawnContext?.originType
        ?? 'other';
      const arr = map.get(key) ?? [];
      arr.push(a);
      map.set(key, arr);
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [filtered]);

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="shrink-0 px-3 py-2.5 border-b border-border/20 bg-surface-100/30">
        <div className="flex items-center gap-2 mb-2">
          <FileText className="w-4 h-4 text-accent-blue shrink-0" />
          <h3 className="font-heading text-sm font-semibold text-theme-primary tracking-wide truncate">
            Artifacts
          </h3>
          <span className="text-[10px] font-mono text-theme-muted bg-surface-200/40 px-1.5 py-0.5 rounded-full shrink-0">
            {items.length}
          </span>
          <button
            onClick={load}
            disabled={loading}
            className="ml-auto p-1 rounded-md hover:bg-surface-200/60 text-theme-muted hover:text-theme-secondary transition-colors disabled:opacity-50"
            title="Refresh"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          </button>
          {onClose && (
            <button
              onClick={onClose}
              className="p-1 rounded-md hover:bg-surface-200/60 text-theme-muted hover:text-theme-secondary transition-colors"
              title="Close"
            >
              <XIcon className="w-4 h-4" />
            </button>
          )}
        </div>
        <div className="relative">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-theme-subtle pointer-events-none" />
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Filter…"
            className="w-full pl-7 pr-2 py-1.5 text-[11px] rounded-md border border-border/40 bg-surface-100/60 text-theme-primary focus:outline-none focus:border-accent-blue/60 focus:ring-1 focus:ring-accent-blue/30"
          />
        </div>
      </div>

      {/* List */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {error && (
          <div className="p-3 text-[11px] text-accent-red font-mono">{error}</div>
        )}
        {!loading && filtered.length === 0 && (
          <EmptyState hasSearch={!!search.trim()} rootType={rootType} />
        )}
        {grouped.map(([group, list]) => (
          <div key={group} className="border-b border-border/10 last:border-b-0">
            <div className="sticky top-0 bg-surface-50/95 backdrop-blur-sm px-3 py-1 overline border-b border-border/10 truncate">
              {group}
            </div>
            {list.map(a => (
              <ArtifactRow
                key={a.artifactId}
                artifact={a}
                selected={selectedId === a.artifactId}
                onClick={() => onSelect?.(a)}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Row ────────────────────────────────────────────────────────────────

function ArtifactRow({
  artifact, selected, onClick,
}: {
  artifact: ArtifactDoc;
  selected: boolean;
  onClick: () => void;
}) {
  const Icon = iconForType(artifact.contentType);
  return (
    <button
      onClick={onClick}
      className={`w-full flex items-start gap-2 px-3 py-2 text-left hover:bg-surface-200/30 transition-colors border-l-2 ${
        selected
          ? 'bg-accent-blue/5 border-accent-blue'
          : 'border-transparent'
      }`}
    >
      <Icon className={`w-3.5 h-3.5 mt-0.5 shrink-0 ${colorForType(artifact.contentType)}`} />
      <div className="flex-1 min-w-0">
        <div className="text-[11px] font-mono text-theme-primary truncate">
          {artifact.filename}
        </div>
        <div className="text-[9px] font-mono text-theme-subtle truncate">
          {artifact.relativePath !== artifact.filename && <span>{artifact.relativePath.replace('/' + artifact.filename, '')} · </span>}
          {formatSize(artifact.sizeBytes)} · {formatTime(artifact.createdAt)}
        </div>
        {artifact.description && (
          <div className="text-[10px] text-theme-muted italic mt-0.5 truncate">
            {artifact.description}
          </div>
        )}
      </div>
    </button>
  );
}

// ── Empty state ────────────────────────────────────────────────────────

function EmptyState({ hasSearch, rootType }: { hasSearch: boolean; rootType: string }) {
  if (hasSearch) {
    return (
      <div className="p-4 text-center">
        <div className="text-[11px] text-theme-muted font-body">No matches.</div>
      </div>
    );
  }
  return (
    <div className="p-4 text-center">
      <FileText className="w-8 h-8 text-theme-subtle mx-auto mb-2" />
      <h4 className="text-xs font-heading font-semibold text-theme-primary mb-1">
        No artifacts yet
      </h4>
      <p className="text-[10px] text-theme-muted font-body leading-relaxed">
        Files saved by agents in this {rootType} will appear here.
      </p>
    </div>
  );
}

// ── Helpers ────────────────────────────────────────────────────────────

function iconForType(t: ArtifactDoc['contentType']) {
  switch (t) {
    case 'markdown': return FileText;
    case 'json':     return FileJson;
    case 'csv':      return FileSpreadsheet;
    case 'code':     return Code2;
    case 'binary':   return Database;
    case 'text':
    default:         return File;
  }
}

function colorForType(t: ArtifactDoc['contentType']): string {
  switch (t) {
    case 'markdown': return 'text-accent-blue';
    case 'json':     return 'text-accent-yellow';
    case 'csv':      return 'text-accent-green';
    case 'code':     return 'text-accent-purple';
    case 'binary':   return 'text-theme-muted';
    case 'text':
    default:         return 'text-theme-secondary';
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const min = Math.floor(ms / 60_000);
  if (min < 1) return 'now';
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d`;
  return new Date(iso).toLocaleDateString();
}
