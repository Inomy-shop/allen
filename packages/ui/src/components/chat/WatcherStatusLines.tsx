import React from 'react';
import { Loader2, Clock } from 'lucide-react';
import type { WatcherUIDoc } from '../../services/api';

// ── timeAgo (local helper, mirrors ChatMessageList) ─────────────────────────
function timeAgo(dateStr?: string | null): string {
  if (!dateStr) return 'recently';
  const ms = Date.now() - new Date(dateStr).getTime();
  const min = Math.floor(ms / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

// ── Icon helpers ─────────────────────────────────────────────────────────────

function watcherStatusIcon(executionState: WatcherUIDoc['executionState']) {
  switch (executionState) {
    case 'waiting_for_input':
      return <Clock className="w-3.5 h-3.5 text-accent-yellow shrink-0" aria-hidden="true" />;
    case 'running':
    default:
      return <Loader2 className="w-3.5 h-3.5 text-accent animate-spin shrink-0" aria-hidden="true" />;
  }
}

function shouldShowWatcher(watcher: WatcherUIDoc, assistantStreaming: boolean): boolean {
  if (assistantStreaming) return false;
  if (watcher.watcherStatus !== 'active' && watcher.watcherStatus !== 'waiting') return false;
  if (watcher.executionState === 'running') return true;
  if (watcher.executionState === 'waiting_for_input') {
    return watcher.triggerSentForState !== 'waiting_for_input';
  }
  return false;
}

function watcherLabel(watcher: WatcherUIDoc): string {
  const text = watcher.latestStatusText.trim();
  const firstSentence = text.split(/\.\s+/)[0] || text;
  return firstSentence.replace(/^chat:spawn_agent\//, '');
}

// ── Single watcher line ──────────────────────────────────────────────────────

export interface WatcherStatusLineProps {
  watcher: WatcherUIDoc;
}

export const WatcherStatusLine = React.memo(function WatcherStatusLine({
  watcher,
}: WatcherStatusLineProps) {
  // NOTE: intentionally non-clickable — no onClick, role="button", or cursor-pointer.
  return (
    <div className="ch-msg allen watcher-status-message al-msg-enter" key={watcher.executionId}>
      <div className="ch-avatar">a</div>
      <div className="ch-msg-body">
        <div className="ch-msg-head">
          <span className="ch-msg-who">watcher</span>
          <span className="ch-msg-ts">monitoring</span>
          <span className="ch-msg-ts">checked {timeAgo(watcher.lastCheckedAt)}</span>
        </div>
        <div className="ch-msg-text watcher-status-text">
          {watcherStatusIcon(watcher.executionState)}
          <span>{watcherLabel(watcher)}</span>
        </div>
      </div>
    </div>
  );
});

// ── Watcher status lines list ────────────────────────────────────────────────

export interface WatcherStatusLinesProps {
  watchers: WatcherUIDoc[];
  assistantStreaming?: boolean;
}

export function WatcherStatusLines({ watchers, assistantStreaming = false }: WatcherStatusLinesProps) {
  const visibleWatchers = watchers.filter((watcher) => shouldShowWatcher(watcher, assistantStreaming));
  if (!visibleWatchers.length) return null;

  return (
    <section className="watcher-status-feed" aria-label="Execution watchers">
      {visibleWatchers.map((watcher) => (
        <WatcherStatusLine key={watcher.executionId} watcher={watcher} />
      ))}
    </section>
  );
}
