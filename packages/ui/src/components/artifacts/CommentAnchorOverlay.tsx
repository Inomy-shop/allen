/**
 * CommentAnchorOverlay — renders gutter markers + line/range highlights
 * on top of the rendered document.
 *
 * For markdown/text/code: simple line-indexed overlay div absolutely
 * positioned over the content area. The parent must supply contentRef
 * and a line-count calculation via contentLines.
 *
 * Stale anchors get a distinct warning icon in the gutter.
 */
import { useMemo } from 'react';
import { MessageSquare, AlertTriangle } from 'lucide-react';
import type { DocumentCommentDoc } from '../../services/documents';

export interface CommentAnchorOverlayProps {
  /** Line-counted content (must match the rendered content 1:1). */
  contentLines: string[];
  /** All comments to render markers for. */
  comments: DocumentCommentDoc[];
  /** The current version of the document (to detect stale vs fresh). */
  currentVersion: number;
  onJumpToComment: (commentId: string) => void;
}

export default function CommentAnchorOverlay({
  contentLines,
  comments,
  currentVersion,
  onJumpToComment,
}: CommentAnchorOverlayProps) {
  // Build a map: line number (1-based) → comments anchored on that line
  const lineMap = useMemo(() => {
    const map = new Map<number, DocumentCommentDoc[]>();
    for (const c of comments) {
      const anchor = c.anchor;
      let line = 0;
      if (anchor.type === 'line' && anchor.lineStart) {
        line = anchor.lineStart;
      } else if (anchor.type === 'range' && anchor.lineStart) {
        line = anchor.lineStart;
      } else if (anchor.type === 'text_snippet') {
        // text_snippet anchors don't have precise lines; we skip gutter markers
        continue;
      }
      if (line < 1 || line > contentLines.length) continue;
      const arr = map.get(line) ?? [];
      arr.push(c);
      map.set(line, arr);
    }
    return map;
  }, [comments, contentLines.length]);

  // Build line/range overlays. These are deliberately yellow so anchors are
  // visibly comments, not selections or status colors.
  const ranges = useMemo(() => {
    const result: Array<{
      lineStart: number;
      lineEnd: number;
      comments: DocumentCommentDoc[];
    }> = [];
    for (const c of comments) {
      const a = c.anchor;
      if ((a.type === 'range' || a.type === 'line') && a.lineStart) {
        const lineEnd = a.type === 'range' ? (a.lineEnd ?? a.lineStart) : a.lineStart;
        // Check overlap with existing
        const existing = result.find(
          r => r.lineStart === a.lineStart && r.lineEnd === lineEnd,
        );
        if (existing) {
          existing.comments.push(c);
        } else {
          result.push({ lineStart: a.lineStart, lineEnd, comments: [c] });
        }
      }
    }
    return result;
  }, [comments]);

  if (comments.length === 0) return null;

  return (
    <div className="absolute inset-0 pointer-events-none" aria-hidden="true">
      {/* Gutter markers */}
      <div className="absolute left-0 top-0 w-5 bottom-0 z-10">
        {Array.from(lineMap.entries()).map(([lineNo, ccs]) => {
          // Compute approximate Y position
          const yPct = ((lineNo - 1) / Math.max(contentLines.length, 1)) * 100;
          const hasStale = ccs.some(c => c.status === 'stale');
          return (
            <button
              key={lineNo}
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onJumpToComment(ccs[0].commentId);
              }}
              className="pointer-events-auto absolute left-1 rounded p-0.5 transition-colors hover:bg-app-muted"
              style={{ top: `${yPct}%` }}
              title={`${ccs.length} comment${ccs.length > 1 ? 's' : ''} at line ${lineNo}`}
            >
              {hasStale ? (
                <AlertTriangle className="w-3 h-3 text-accent-orange" />
              ) : (
                <MessageSquare className="w-3 h-3 text-yellow-600 dark:text-yellow-300" />
              )}
            </button>
          );
        })}
      </div>

      {/* Range highlights */}
      {ranges.map((r, i) => {
        const topPct = ((r.lineStart - 1) / Math.max(contentLines.length, 1)) * 100;
        const heightPct = Math.max(
          ((r.lineEnd - r.lineStart + 1) / Math.max(contentLines.length, 1)) * 100,
          2,
        );
        const hasStale = r.comments.some(c => c.status === 'stale');
        return (
          <button
            key={i}
            type="button"
            onClick={() => onJumpToComment(r.comments[0].commentId)}
            className="pointer-events-auto absolute left-6 right-0 rounded-sm border-l-2 border-yellow-500/70 bg-yellow-300/20 transition-colors hover:bg-yellow-300/35"
            style={{ top: `${topPct}%`, height: `${heightPct}%` }}
            title={`${r.comments.length} comment${r.comments.length > 1 ? 's' : ''} on lines ${r.lineStart}–${r.lineEnd}`}
          >
            {hasStale && (
              <div className="absolute top-0 right-0">
                <AlertTriangle className="w-3 h-3 text-accent-orange" />
              </div>
            )}
          </button>
        );
      })}
    </div>
  );
}
