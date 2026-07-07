/**
 * CommentTimeline — renders the timeline response (events: version_created,
 * comment_resolved, comment_reopened, comment_stale, comment_created).
 * Reverse-chronological. Each event compact with timestamp + actor.
 */
import { useEffect, useState } from 'react';
import {
  History, GitCommit, CheckCircle2, RotateCcw, AlertTriangle,
  MessageSquare, X as XIcon, RefreshCw,
} from 'lucide-react';
import { documents as documentsApi } from '../../services/api';
import type { TimelineEvent } from '../../services/documents';

export interface CommentTimelineProps {
  documentId: string;
  onClose: () => void;
  onJumpToVersion?: (versionNumber: number) => void;
}

export default function CommentTimeline({
  documentId, onClose, onJumpToVersion,
}: CommentTimelineProps) {
  const [events, setEvents] = useState<TimelineEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    documentsApi.getTimeline(documentId)
      .then(data => { if (!cancelled) setEvents(data.events ?? []); })
      .catch(err => { if (!cancelled) setError((err as Error).message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [documentId]);

  return (
    <div className="flex h-full flex-col bg-app-card border-l border-app w-[360px] shrink-0">
      {/* Header */}
      <div className="shrink-0 border-b border-app px-3 py-2.5">
        <div className="flex items-center gap-2">
          <History className="w-4 h-4 text-theme-muted shrink-0" />
          <h3 className="text-[13px] font-semibold text-theme-primary flex-1 truncate">
            Timeline
          </h3>
          <button
            onClick={() => {
              setLoading(true);
              documentsApi.getTimeline(documentId).then(data => setEvents(data.events ?? [])).catch(err => setError((err as Error).message)).finally(() => setLoading(false));
            }}
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

      {/* List */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading && (
          <div className="p-4 space-y-2">
            {[0, 1, 2].map(i => (
              <div key={i} className="h-12 rounded-md bg-app-muted/50 animate-pulse" />
            ))}
          </div>
        )}
        {error && (
          <div className="p-4 text-[11px] text-accent-red font-mono">{error}</div>
        )}
        {!loading && !error && events.length === 0 && (
          <div className="p-6 text-center">
            <History className="w-8 h-8 text-theme-subtle mx-auto mb-2" />
            <div className="text-xs text-theme-muted font-body">No events yet</div>
          </div>
        )}
        <div className="relative px-4 py-3">
          {/* Vertical line */}
          <div className="absolute left-[23px] top-0 bottom-0 w-px bg-app" />

          {events.map((evt, i) => (
            <div key={evt.eventId ?? i} className="relative flex items-start gap-3 pb-4 last:pb-0">
              {/* Icon */}
              <div className={`relative z-10 rounded-full p-1 ${
                evt.type === 'version_created' ? 'bg-accent-blue/15 text-accent-blue' :
                evt.type === 'comment_resolved' ? 'bg-accent-green/15 text-accent-green' :
                evt.type === 'comment_reopened' ? 'bg-accent-orange/15 text-accent-orange' :
                evt.type === 'comment_stale' ? 'bg-accent-orange/15 text-accent-orange' :
                'bg-accent-blue/10 text-accent-blue'
              }`}>
                {evt.type === 'version_created' && <GitCommit className="w-3.5 h-3.5" />}
                {evt.type === 'comment_resolved' && <CheckCircle2 className="w-3.5 h-3.5" />}
                {evt.type === 'comment_reopened' && <RotateCcw className="w-3.5 h-3.5" />}
                {evt.type === 'comment_stale' && <AlertTriangle className="w-3.5 h-3.5" />}
                {evt.type === 'comment_created' && <MessageSquare className="w-3.5 h-3.5" />}
              </div>

              {/* Content */}
              <div className="flex-1 min-w-0 pt-0.5">
                <div className="flex items-center gap-1.5">
                  <span className="text-[11px] font-mono text-theme-primary font-medium">
                    {eventLabel(evt)}
                  </span>
                  {evt.versionNumber && onJumpToVersion && (
                    <button
                      type="button"
                      onClick={() => onJumpToVersion(evt.versionNumber!)}
                      className="text-[9px] font-mono text-accent-blue hover:underline"
                    >
                      v{evt.versionNumber}
                    </button>
                  )}
                  {anchorLabel(evt) && (
                    <span className="rounded bg-yellow-400/15 px-1 py-0.5 text-[9px] font-mono text-yellow-700 dark:text-yellow-300">
                      {anchorLabel(evt)}
                    </span>
                  )}
                </div>
                <div className="text-[10px] font-mono text-theme-subtle mt-0.5">
                  {evt.actorName && <span>{evt.actorName} · </span>}
                  {formatTime(evt.timestamp)}
                </div>
                {evt.detail && (
                  <div className="text-[10px] font-body text-theme-muted italic mt-0.5 leading-relaxed">
                    {evt.detail}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Helpers ────────────────────────────────────────────────────────────────

function eventLabel(evt: TimelineEvent): string {
  switch (evt.type) {
    case 'version_created':   return 'Version created';
    case 'comment_resolved':  return 'Comment resolved';
    case 'comment_reopened':  return 'Comment reopened';
    case 'comment_stale':     return 'Comment became stale';
    case 'comment_created':   return 'Comment added';
    default:                  return evt.type;
  }
}

function anchorLabel(evt: TimelineEvent): string | null {
  if (evt.lineStart && evt.lineEnd && evt.lineEnd !== evt.lineStart) return `Lines ${evt.lineStart}–${evt.lineEnd}`;
  if (evt.lineStart) return `Line ${evt.lineStart}`;
  return null;
}

function formatTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const min = Math.floor(ms / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d`;
  return new Date(iso).toLocaleDateString();
}
