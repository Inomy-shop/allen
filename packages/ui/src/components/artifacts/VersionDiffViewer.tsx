/**
 * VersionDiffViewer — Renders the compareVersions response.
 * Side-by-side line-diff coloring (added/removed/modified/unchanged).
 * Shows addressedCommentIds linkage when present.
 */
import { useState, useEffect, useMemo } from 'react';
import {
  ArrowLeftRight, CheckCircle2, X as XIcon,
} from 'lucide-react';
import { documents as documentsApi } from '../../services/api';
import type { CompareResponse, DiffLine } from '../../services/documents';

export interface VersionDiffViewerProps {
  documentId: string;
  v1: number;
  v2: number;
  onClose: () => void;
}

export default function VersionDiffViewer({
  documentId, v1, v2, onClose,
}: VersionDiffViewerProps) {
  const [compare, setCompare] = useState<CompareResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    documentsApi.compareVersions(documentId, v1, v2)
      .then(data => { if (!cancelled) setCompare(data); })
      .catch(err => { if (!cancelled) setError((err as Error).message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [documentId, v1, v2]);

  return (
    <div className="flex h-full flex-col bg-app-card border-l border-app w-[640px] shrink-0">
      {/* Header */}
      <div className="shrink-0 border-b border-app px-3 py-2.5">
        <div className="flex items-center gap-2">
          <ArrowLeftRight className="w-4 h-4 text-theme-muted shrink-0" />
          <h3 className="text-[13px] font-semibold text-theme-primary flex-1 truncate">
            Diff — v{v1} ↔ v{v2}
          </h3>
          <button
            onClick={onClose}
            className="rounded p-1 text-theme-muted transition-colors hover:bg-app-muted hover:text-theme-primary"
            title="Close diff"
          >
            <XIcon className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="min-h-0 flex-1 overflow-auto">
        {loading && (
          <div className="p-6 text-xs font-mono text-theme-muted">Loading diff…</div>
        )}
        {error && (
          <div className="p-4 text-[11px] text-accent-red font-mono">{error}</div>
        )}
        {compare && (
          <>
            {/* Stats bar */}
            <div className="shrink-0 border-b border-app px-3 py-1.5 flex items-center gap-3 text-[10px] font-mono">
              <span className="text-accent-green">+{compare.stats.linesAdded}</span>
              <span className="text-accent-red">-{compare.stats.linesRemoved}</span>
              <span className="text-accent-orange">~{compare.stats.linesModified}</span>
              <span className="text-theme-subtle">{compare.stats.linesUnchanged} unchanged</span>
              <span className="text-theme-subtle ml-auto">v{compare.v1.versionNumber} → v{compare.v2.versionNumber}</span>
            </div>

            {/* Addressed comment IDs */}
            {compare.addressedCommentIds.length > 0 && (
              <div className="shrink-0 border-b border-app px-3 py-1.5 flex items-center gap-1.5 text-[10px] font-mono text-accent-green">
                <CheckCircle2 className="w-3 h-3" />
                <span>
                  {compare.addressedCommentIds.length} comment{compare.addressedCommentIds.length > 1 ? 's' : ''} addressed
                </span>
              </div>
            )}

            {/* Side-by-side diff */}
            <div className="grid grid-cols-2 divide-x divide-app">
              <DiffSide lines={compare.diff} side="v1" versionLabel={`v${compare.v1.versionNumber}`} />
              <DiffSide lines={compare.diff} side="v2" versionLabel={`v${compare.v2.versionNumber}`} />
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ── Diff Side ──────────────────────────────────────────────────────────────

function DiffSide({
  lines, side, versionLabel,
}: {
  lines: DiffLine[];
  side: 'v1' | 'v2';
  versionLabel: string;
}) {
  const rendered = useMemo(() => {
    const result: Array<{
      lineNumber?: number;
      text: string;
      oldText?: string;
      type: DiffLine['type'];
      empty: boolean;
    }> = [];

    for (const line of lines) {
      if (side === 'v1') {
        if (line.type === 'added') {
          // Show blank on the v1 side for added lines
          result.push({ text: '', type: 'added', empty: true });
        } else {
          result.push({
            lineNumber: line.lineNumberV1,
            text: line.type === 'modified' ? (line.oldText ?? line.text) : line.text,
            type: line.type,
            empty: false,
          });
        }
      } else {
        if (line.type === 'removed') {
          // Show blank on the v2 side for removed lines
          result.push({ text: '', type: 'removed', empty: true });
        } else {
          result.push({
            lineNumber: line.lineNumberV2,
            text: line.text,
            type: line.type,
            empty: false,
          });
        }
      }
    }
    return result;
  }, [lines, side]);

  return (
    <div className="overflow-auto">
      <div className="sticky top-0 z-10 bg-app-card border-b border-app px-2 py-1 text-[9px] font-mono text-theme-subtle uppercase tracking-wide">
        {versionLabel}
      </div>
      {rendered.map((line, i) => (
        <div
          key={i}
          className={`flex text-[11px] font-mono leading-relaxed ${
            line.type === 'added' ? 'bg-accent-green/10' :
            line.type === 'removed' ? 'bg-accent-red/10' :
            line.type === 'modified' ? 'bg-accent-orange/10' :
            ''
          } ${line.empty ? 'text-theme-subtle/40' : 'text-theme-primary'}`}
        >
          <span className="w-12 shrink-0 text-right pr-2 text-[10px] text-theme-subtle select-none border-r border-app py-px">
            {line.lineNumber ?? ''}
          </span>
          <span className="flex-1 px-2 whitespace-pre-wrap break-words py-px">
            {line.empty ? '·' : line.text}
          </span>
        </div>
      ))}
    </div>
  );
}
