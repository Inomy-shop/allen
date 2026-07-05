/**
 * VersionHistoryPanel — lists versions with creator/timestamp/reason.
 * "View", "Compare to latest", "Restore" actions. Latest version badged.
 */
import { useEffect, useState, useCallback } from 'react';
import {
  History, Eye, GitBranch, RotateCcw, X as XIcon, RefreshCw,
  Bot, User, Shield,
} from 'lucide-react';
import { documents as documentsApi } from '../../services/api';
import type { VersionListEntry } from '../../services/documents';

export interface VersionHistoryPanelProps {
  documentId: string;
  latestVersionNumber: number;
  onViewVersion: (versionNumber: number) => void;
  onCompareToLatest: (versionNumber: number) => void;
  onRestoreVersion: (versionNumber: number) => void;
  onClose: () => void;
}

export default function VersionHistoryPanel({
  documentId,
  latestVersionNumber,
  onViewVersion,
  onCompareToLatest,
  onRestoreVersion,
  onClose,
}: VersionHistoryPanelProps) {
  const [versions, setVersions] = useState<VersionListEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [restoringVersion, setRestoringVersion] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await documentsApi.listVersions(documentId);
      setVersions(data.versions);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [documentId]);

  useEffect(() => { load(); }, [load]);

  async function handleRestore(vn: number) {
    if (!confirm(`Restore version ${vn}? This creates a new version with the restored content.`)) return;
    setRestoringVersion(vn);
    setError(null);
    try {
      await documentsApi.restoreVersion(documentId, vn);
      onRestoreVersion(vn);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setRestoringVersion(null);
    }
  }

  // Sort descending (newest first)
  const sorted = [...versions].sort((a, b) => b.versionNumber - a.versionNumber);

  return (
    <div className="flex h-full flex-col bg-app-card border-l border-app w-[360px] shrink-0">
      {/* Header */}
      <div className="shrink-0 border-b border-app px-3 py-2.5">
        <div className="flex items-center gap-2">
          <History className="w-4 h-4 text-theme-muted shrink-0" />
          <h3 className="text-[13px] font-semibold text-theme-primary flex-1 truncate">
            Version History
          </h3>
          <button
            onClick={load}
            disabled={loading}
            className="rounded p-1 text-theme-muted transition-colors hover:bg-app-muted hover:text-theme-primary disabled:opacity-50"
            title="Refresh"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          </button>
          <button
            onClick={onClose}
            className="rounded p-1 text-theme-muted transition-colors hover:bg-app-muted hover:text-theme-primary"
            title="Close"
          >
            <XIcon className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="shrink-0 px-3 py-1.5 text-[10px] text-accent-red font-mono bg-accent-red/5 border-b border-app">
          {error}
        </div>
      )}

      {/* List */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading && versions.length === 0 && (
          <div className="p-4 space-y-2">
            {[0, 1, 2].map(i => (
              <div key={i} className="h-16 rounded-md bg-app-muted/50 animate-pulse" />
            ))}
          </div>
        )}
        {!loading && sorted.length === 0 && (
          <div className="p-6 text-center">
            <History className="w-8 h-8 text-theme-subtle mx-auto mb-2" />
            <div className="text-xs text-theme-muted font-body">No versions yet</div>
          </div>
        )}
        {sorted.map((v, i) => {
          const isLatest = v.versionNumber === latestVersionNumber;
          return (
            <div
              key={v.versionNumber}
              className={`border-b border-app last:border-b-0 px-3 py-2.5 ${
                isLatest ? 'bg-accent-blue/5' : ''
              }`}
            >
              <div className="flex items-start gap-2">
                <span className="text-[11px] font-mono text-theme-primary font-semibold shrink-0 w-16">
                  v{v.versionNumber}
                </span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5 mb-0.5">
                    {v.createdByOriginType === 'agent' && (
                      <Bot className="w-3 h-3 text-accent-purple shrink-0" />
                    )}
                    {v.createdByOriginType === 'human' && (
                      <User className="w-3 h-3 text-accent-blue shrink-0" />
                    )}
                    {v.createdByOriginType === 'system' && (
                      <Shield className="w-3 h-3 text-theme-muted shrink-0" />
                    )}
                    <span className="text-[10px] font-mono text-theme-secondary truncate">
                      {v.createdByAgentName ?? v.createdByUserId ?? v.createdByOriginType}
                    </span>
                    {isLatest && (
                      <span className="text-[9px] font-mono text-accent-blue uppercase bg-accent-blue/10 px-1 rounded">
                        Latest
                      </span>
                    )}
                  </div>
                  {v.createdReason && (
                    <div className="text-[10px] font-body text-theme-muted italic truncate mb-0.5">
                      {v.createdReason}
                    </div>
                  )}
                  <div className="text-[9px] font-mono text-theme-subtle">
                    {formatFullTime(v.createdAt)}
                  </div>
                  {v.addressedCommentIds && v.addressedCommentIds.length > 0 && (
                    <div className="text-[9px] font-mono text-accent-green mt-0.5">
                      Addressed {v.addressedCommentIds.length} comment{v.addressedCommentIds.length > 1 ? 's' : ''}
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-0.5 shrink-0">
                  <button
                    type="button"
                    onClick={() => onViewVersion(v.versionNumber)}
                    title="View this version"
                    className="rounded p-1 text-theme-muted transition-colors hover:bg-app-muted hover:text-theme-primary"
                  >
                    <Eye className="w-3.5 h-3.5" />
                  </button>
                  {!isLatest && (
                    <>
                      <button
                        type="button"
                        onClick={() => onCompareToLatest(v.versionNumber)}
                        title="Compare to latest"
                        className="rounded p-1 text-theme-muted transition-colors hover:bg-app-muted hover:text-theme-primary"
                      >
                        <GitBranch className="w-3.5 h-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => handleRestore(v.versionNumber)}
                        disabled={restoringVersion === v.versionNumber}
                        title="Restore this version"
                        className="rounded p-1 text-accent-orange/60 transition-colors hover:bg-accent-orange/10 hover:text-accent-orange disabled:opacity-30"
                      >
                        <RotateCcw className={`w-3.5 h-3.5 ${restoringVersion === v.versionNumber ? 'animate-spin' : ''}`} />
                      </button>
                    </>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Helper ─────────────────────────────────────────────────────────────────

function formatFullTime(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffDays = Math.floor(diffMs / 86_400_000);
  if (diffDays < 1) {
    return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  }
  if (diffDays < 7) {
    return `${diffDays}d ago · ${d.toLocaleDateString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' })}`;
  }
  return d.toLocaleDateString(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}
