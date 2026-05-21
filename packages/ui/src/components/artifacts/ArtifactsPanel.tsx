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
  ChevronRight, RefreshCw, Search, X as XIcon,
} from 'lucide-react';
import { artifacts as artifactsApi, type ArtifactDoc } from '../../services/api';

export interface ArtifactsPanelProps {
  rootType: 'chat' | 'workflow' | 'agent';
  rootId: string;
  /** Id of the currently selected artifact — drives the row highlight. */
  selectedId?: string | null;
  /** Called when the user clicks a row. Parent is expected to open the viewer. */
  onSelect?: (artifact: ArtifactDoc) => void;
  /** Called after every successful load so parents can sync selection. */
  onItemsChange?: (artifacts: ArtifactDoc[]) => void;
  /** Optional close button rendered in the header — when set, the parent
   *  drawer/overlay can rely on the panel's own chrome instead of stacking
   *  another header on top. */
  onClose?: () => void;
  /** Polling interval ms (default 5000 while active, 0 to disable). */
  pollIntervalMs?: number;
}

export default function ArtifactsPanel({
  rootType, rootId, selectedId, onSelect, onItemsChange, onClose, pollIntervalMs = 5000,
}: ArtifactsPanelProps) {
  const [items, setItems] = useState<ArtifactDoc[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setError(null);
    try {
      const data = await artifactsApi.list({ rootType, rootId, limit: 500 });
      const sorted = [...(data ?? [])].sort((a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      );
      setItems(sorted);
      onItemsChange?.(sorted);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    setLoading(true);
    setItems([]);
    load();
  }, [rootType, rootId]); // eslint-disable-line react-hooks/exhaustive-deps

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
        ?? 'Ungrouped';
      const arr = map.get(key) ?? [];
      arr.push(a);
      map.set(key, arr);
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [filtered]);

  return (
    <div className="flex h-full flex-col bg-app-card">
      {/* Header */}
      <div className="shrink-0 border-b border-app px-4 py-3">
        <div className="flex items-center gap-2 mb-2">
          <FileText className="w-4 h-4 text-theme-muted shrink-0" />
          <h3 className="text-[13px] font-semibold text-theme-primary truncate">
            Artifacts
          </h3>
          <span className="text-[10px] font-mono text-theme-muted bg-app-muted px-1.5 py-0.5 rounded-full shrink-0">
            {items.length}
          </span>
          <button
            onClick={load}
            disabled={loading}
            className="ml-auto rounded p-1.5 text-theme-muted transition-colors hover:bg-app-muted hover:text-theme-primary disabled:opacity-50"
            title="Refresh"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          </button>
          {onClose && (
            <button
              onClick={onClose}
              className="rounded p-1.5 text-theme-muted transition-colors hover:bg-app-muted hover:text-theme-primary"
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
            className="w-full rounded-md border border-app bg-app-card py-1.5 pl-7 pr-2 text-[11px] text-theme-primary focus:border-accent-blue/60 focus:outline-none focus:ring-1 focus:ring-accent-blue/30"
          />
        </div>
      </div>

      {/* List */}
      <div className="min-h-0 flex-1 overflow-y-auto bg-app-muted/35 px-2.5 py-2">
        {loading && items.length === 0 && (
          <div className="space-y-2">
            {[0, 1, 2].map(index => (
              <div key={index} className="h-12 rounded-md bg-app-muted/50 animate-pulse" />
            ))}
          </div>
        )}
        {error && (
          <div className="p-3 text-[11px] text-accent-red font-mono">{error}</div>
        )}
        {!loading && filtered.length === 0 && (
          <EmptyState hasSearch={!!search.trim()} rootType={rootType} />
        )}
        {grouped.map(([group, list]) => (
          <div key={group} className="mb-3 last:mb-0">
            <div className="sticky top-0 z-10 mb-1 bg-app-muted/95 px-1.5 py-1 overline backdrop-blur-sm truncate">
              {group}
            </div>
            <div className="cr-list">
            {list.map(a => (
              <ArtifactRow
                key={a.artifactId}
                artifact={a}
                selected={selectedId === a.artifactId}
                onClick={() => onSelect?.(a)}
              />
            ))}
            </div>
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
    <button type="button" onClick={onClick} className={`cr-list-row w-full ${selected ? 'active' : ''}`}>
      <span className="cr-ref-ic repo">
        <Icon className="h-3 w-3" />
      </span>
      <span className="cr-list-body">
        <span className="cr-list-title">
          <span>{artifact.filename}</span>
        </span>
        <span className="cr-list-sub">
          {humanType(artifact.contentType)} · {formatSize(artifact.sizeBytes)} · {formatTime(artifact.createdAt)}
        </span>
        {artifact.description && (
          <span className="cr-list-sub italic">
            {artifact.description}
          </span>
        )}
      </span>
      <ChevronRight className="h-3.5 w-3.5 text-theme-subtle" />
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

function humanType(value?: string | null): string {
  if (!value) return 'File';
  return value.replace(/[_-]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
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
