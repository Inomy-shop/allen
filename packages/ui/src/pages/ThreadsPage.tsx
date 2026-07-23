import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Inbox, Search } from 'lucide-react';
import { chat as chatApi, type ChatSession } from '../services/api';
import { getModelDisplay } from '../hooks/useModelRegistry';
import {
  TEAM_CLASSIFICATION_META,
  teamClassificationKey,
  type TeamClassificationKey,
} from '../types/teamClassification';

type SessionFilter = 'all' | 'running' | 'needs-you' | 'completed' | 'failed';
type SpaceFilter = 'all' | TeamClassificationKey;

function shortAge(value?: string) {
  if (!value) return 'now';
  const minutes = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 60_000));
  if (minutes < 60) return `${Math.max(1, minutes)}m`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h`;
  return `${Math.floor(minutes / 1440)}d`;
}

function sessionState(session: ChatSession): SessionFilter {
  return session.status === 'archived' ? 'completed' : 'running';
}

function ModelMark({ provider }: { provider?: string }) {
  const openAi = /codex|openai|gpt/i.test(provider ?? '');
  return openAi ? (
    <svg viewBox="0 0 16 16" fill="none" stroke="#10A37F" strokeWidth="1.5" aria-hidden="true"><circle cx="8" cy="8" r="5.7"/><path d="M8 2.3v11.4M3.1 5.2l9.8 5.6M12.9 5.2 3.1 10.8"/></svg>
  ) : (
    <svg viewBox="0 0 16 16" fill="none" stroke="#D97757" strokeWidth="1.9" strokeLinecap="round" aria-hidden="true"><path d="M8 1.6v2.7M8 11.7v2.7M1.6 8h2.7M11.7 8h2.7M3.5 3.5l1.9 1.9M10.6 10.6l1.9 1.9M12.5 3.5l-1.9 1.9M5.4 10.6l-1.9 1.9"/></svg>
  );
}

export default function ThreadsPage() {
  const navigate = useNavigate();
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<SessionFilter>('all');
  const [space, setSpace] = useState<SpaceFilter>('all');

  useEffect(() => {
    let cancelled = false;
    chatApi.listSessions({ includeStudio: true }).then((items) => {
      if (!cancelled) setSessions(items ?? []);
    }).catch(() => {
      if (!cancelled) setSessions([]);
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, []);

  const visible = useMemo(() => sessions
    .filter((session) => filter === 'all' || sessionState(session) === filter)
    .filter((session) => space === 'all' || teamClassificationKey(session.teamClassification, session.studioWorkspaceId) === space)
    .filter((session) => {
      const value = `${session.title} ${session.repoName ?? ''} ${session.workspaceName ?? ''} ${session.provider ?? ''} ${session.model ?? ''} ${session.studioWorkspaceId ? 'studio design' : ''}`.toLowerCase();
      return !query.trim() || value.includes(query.trim().toLowerCase());
    })
    .sort((a, b) => new Date(b.lastMessageAt ?? 0).getTime() - new Date(a.lastMessageAt ?? 0).getTime()), [filter, query, sessions, space]);

  const count = (value: SessionFilter) => value === 'all' ? sessions.length : sessions.filter((item) => sessionState(item) === value).length;
  const spaceCount = (value: TeamClassificationKey) => sessions
    .filter((item) => teamClassificationKey(item.teamClassification, item.studioWorkspaceId) === value).length;

  return (
    <section className="v8-page v8-sessions" data-screen-label="sessions">
      <div className="v8-page__wrap">
        <header className="v8-pagehead">
          <div>
            <h1>Sessions</h1>
            <p>Everything Allen is running, waiting on, or has finished for you.</p>
          </div>
          <button type="button" className="v8-btn v8-btn--ink" onClick={() => navigate('/chat')}>New session</button>
        </header>

        <div className="v8-tabs">
          {([
            ['all', 'All'], ['running', 'Running'], ['needs-you', 'Needs you'], ['completed', 'Completed'], ['failed', 'Failed'],
          ] as const).map(([value, label]) => (
            <button key={value} type="button" className={filter === value ? 'on' : ''} onClick={() => setFilter(value)}>{label} <span>{count(value)}</span></button>
          ))}
          <span className="v8-tabs__spacer" />
          <label className="v8-search"><Search /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search sessions…" /></label>
        </div>

        <div className="v8-chips">
          <button type="button" className={space === 'all' ? 'on' : ''} onClick={() => setSpace('all')}>All spaces</button>
          {(Object.keys(TEAM_CLASSIFICATION_META) as TeamClassificationKey[]).map((value) => (
            <button key={value} type="button" className={space === value ? `on ${value}` : value} onClick={() => setSpace(value)}><i />{TEAM_CLASSIFICATION_META[value].label} <span>{spaceCount(value)}</span></button>
          ))}
        </div>

        {loading ? <div className="v8-filter-empty">Loading sessions…</div> : visible.length === 0 ? (
          sessions.length === 0 ? (
            <div className="v8-empty"><span className="glyph"><Inbox /></span><h2>No sessions yet</h2><p>Start your first session and it will show up here with live status, diffs, and checkpoints.</p><button className="v8-btn v8-btn--ink" type="button" onClick={() => navigate('/chat')}>New session</button></div>
          ) : <div className="v8-filter-empty">No sessions match this filter.</div>
        ) : (
          <div className="v8-panel">
            {visible.map((session) => {
              const state = sessionState(session);
              const itemSpace = teamClassificationKey(session.teamClassification, session.studioWorkspaceId);
              const display = getModelDisplay(session.provider ?? '', session.model);
              const model = display.modelLabel || display.providerLabel || 'Default model';
              const context = session.workspaceName || session.repoName || `${session.messageCount ?? 0} messages`;
              const destination = session.studioWorkspaceId
                ? `/studio/sessions/${session._id}?ws=${encodeURIComponent(session.studioWorkspaceId)}`
                : `/chat/${session._id}`;
              return (
                <Link className="v8-session-row" key={session._id} to={destination}>
                  <span className={`v8-state-dot ${state}`} />
                  <div className="v8-row-main">
                    <h2>{session.title || 'Untitled conversation'}</h2>
                    <p>
                      <span className={`v8-space-tag ${itemSpace}`}><i />{TEAM_CLASSIFICATION_META[itemSpace].short}</span>
                      {session.studioWorkspaceId && <><b>·</b><span className="v8-studio-tag">Studio</span></>}
                      <b>·</b>{session.activeAgent || 'allen assistant'}<b>·</b>{context}
                    </p>
                  </div>
                  <div className="v8-row-cols">
                    <span className="v8-model"><ModelMark provider={session.provider} />{model}</span>
                    <span className={`v8-status ${state}`}>{state === 'completed' ? 'completed' : 'running'}</span>
                    <time>{shortAge(session.lastMessageAt)}</time>
                  </div>
                </Link>
              );
            })}
          </div>
        )}
        {!loading && visible.length > 0 && <p className="v8-page-foot">Showing {visible.length} of {sessions.length} sessions</p>}
      </div>
    </section>
  );
}
