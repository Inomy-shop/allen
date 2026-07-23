import { useEffect, useMemo, useState } from 'react';
import { FileText, MessageCircle, Search, Star, X } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { artifacts as artifactsApi, type ArtifactDoc } from '../services/api';
import { resourceScopeKey, useDocumentTabStore } from '../stores/documentTabStore';
import TeamClassificationSelect from '../components/common/TeamClassificationSelect';
import {
  TEAM_CLASSIFICATION_META,
  teamClassificationKey,
  type TeamClassification,
  type TeamClassificationKey,
} from '../types/teamClassification';

type DocumentFilter = 'saved' | 'favorites' | 'review' | 'recent';
type DocumentSpace = 'all' | TeamClassificationKey;

function displayTitle(filename: string) {
  return filename.replace(/\.(md|markdown|json|csv|txt)$/i, '').replace(/[-_]+/g, ' ');
}

function extension(filename: string) {
  const match = filename.match(/(\.[^.]+)$/);
  return match?.[1] ?? '';
}

function relativeTime(value: string) {
  const elapsed = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(elapsed) || elapsed < 60_000) return 'now';
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function documentType(artifact: ArtifactDoc) {
  if (/prd/i.test(artifact.filename)) return 'PRD';
  if (/report/i.test(artifact.filename)) return 'report';
  if (/brief/i.test(artifact.filename)) return 'brief';
  if (/plan/i.test(artifact.filename)) return 'plan';
  return artifact.contentType === 'markdown' ? 'document' : artifact.contentType;
}

export default function DocumentsPlaceholderPage() {
  const navigate = useNavigate();
  const openDocument = useDocumentTabStore(state => state.openDocument);
  const setActiveResourceScope = useDocumentTabStore(state => state.setActiveScope);
  const [items, setItems] = useState<ArtifactDoc[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [actionError, setActionError] = useState('');
  const [filter, setFilter] = useState<DocumentFilter>('saved');
  const [space, setSpace] = useState<DocumentSpace>('all');
  const [search, setSearch] = useState('');
  const [modalOpen, setModalOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [type, setType] = useState('PRD');
  const [favoriteIds, setFavoriteIds] = useState<Set<string>>(() => new Set());
  const [updatingFavoriteIds, setUpdatingFavoriteIds] = useState<Set<string>>(() => new Set());
  const [updatingClassificationIds, setUpdatingClassificationIds] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    let cancelled = false;
    artifactsApi.list({ limit: 500 })
      .then((result) => {
        if (cancelled) return;
        const savedDocuments = result.filter(item => item.contentType !== 'binary' && item.saved === true);
        setItems(savedDocuments);
        setFavoriteIds(new Set(savedDocuments.filter(item => item.favorite).map(item => item.artifactId)));
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : 'Documents could not be loaded.');
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!modalOpen) return undefined;
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') setModalOpen(false); };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [modalOpen]);

  const counts = useMemo(() => {
    const next: Record<TeamClassificationKey, number> = { engineering: 0, marketing: 0, product: 0, design: 0, unknown: 0 };
    items.forEach(item => { next[teamClassificationKey(item.teamClassification)] += 1; });
    return next;
  }, [items]);

  const visible = useMemo(() => {
    const query = search.trim().toLowerCase();
    const recentCutoff = Date.now() - 72 * 60 * 60 * 1000;
    return items.filter(item => {
      if (space !== 'all' && teamClassificationKey(item.teamClassification) !== space) return false;
      if (filter === 'favorites' && !favoriteIds.has(item.artifactId)) return false;
      if (filter === 'review' && !/review|approval|comment/i.test(`${item.description ?? ''} ${item.filename}`)) return false;
      if (filter === 'recent' && new Date(item.createdAt).getTime() < recentCutoff) return false;
      if (query && !`${item.filename} ${item.description ?? ''} ${item.createdByAgent ?? ''}`.toLowerCase().includes(query)) return false;
      return true;
    });
  }, [favoriteIds, filter, items, search, space]);

  const grouped = useMemo(() => {
    const groups = new Map<TeamClassificationKey, Map<string, ArtifactDoc[]>>();
    visible.forEach(item => {
      const itemSpace = teamClassificationKey(item.teamClassification);
      const roots = groups.get(itemSpace) ?? new Map<string, ArtifactDoc[]>();
      const rootKey = `${item.rootType}:${item.rootId}`;
      roots.set(rootKey, [...(roots.get(rootKey) ?? []), item]);
      groups.set(itemSpace, roots);
    });
    return groups;
  }, [visible]);

  async function toggleFavorite(id: string) {
    if (updatingFavoriteIds.has(id)) return;
    const nextFavorite = !favoriteIds.has(id);
    setActionError('');
    setFavoriteIds(current => {
      const next = new Set(current);
      if (nextFavorite) next.add(id); else next.delete(id);
      return next;
    });
    setUpdatingFavoriteIds(current => new Set(current).add(id));
    try {
      const updated = await artifactsApi.updateLibraryState(id, { favorite: nextFavorite });
      setFavoriteIds(current => {
        const next = new Set(current);
        if (updated.favorite) next.add(id); else next.delete(id);
        return next;
      });
    } catch (cause) {
      setFavoriteIds(current => {
        const next = new Set(current);
        if (nextFavorite) next.delete(id); else next.add(id);
        return next;
      });
      setActionError(cause instanceof Error ? cause.message : 'Favorite could not be updated.');
    } finally {
      setUpdatingFavoriteIds(current => {
        const next = new Set(current);
        next.delete(id);
        return next;
      });
    }
  }

  async function updateClassification(item: ArtifactDoc, value: TeamClassification | null) {
    if (updatingClassificationIds.has(item.artifactId)) return;
    const previous = item.teamClassification ?? null;
    setActionError('');
    setItems(current => current.map(candidate => candidate.artifactId === item.artifactId
      ? { ...candidate, teamClassification: value, teamClassificationSource: 'manual' }
      : candidate));
    setUpdatingClassificationIds(current => new Set(current).add(item.artifactId));
    try {
      const updated = await artifactsApi.updateClassification(item.artifactId, value);
      setItems(current => current.map(candidate => candidate.artifactId === item.artifactId
        ? { ...candidate, ...updated }
        : candidate));
    } catch (cause) {
      setItems(current => current.map(candidate => candidate.artifactId === item.artifactId
        ? { ...candidate, teamClassification: previous }
        : candidate));
      setActionError(cause instanceof Error ? cause.message : 'Document team could not be updated.');
    } finally {
      setUpdatingClassificationIds(current => {
        const next = new Set(current);
        next.delete(item.artifactId);
        return next;
      });
    }
  }

  function createDocument() {
    const prompt = `Create a ${type.toLowerCase()} document titled "${title.trim() || 'Untitled document'}" and save it as an Allen artifact.`;
    navigate(`/chat?prompt=${encodeURIComponent(prompt)}`);
  }

  return (
    <section className="v8-page v8-documents" aria-labelledby="documents-title">
      <div className="v8-page__wrap">
        <header className="v8-pagehead">
          <div>
            <h1 id="documents-title">Documents</h1>
            <p>Documents you've saved from sessions — versioned and open for comments. Everything else a session writes stays in that session until you save it.</p>
          </div>
          <button type="button" className="v8-btn v8-btn--ink" onClick={() => setModalOpen(true)}>New document</button>
        </header>

        <div className="v8-tabs v8-documents-tabs">
          <button type="button" className={filter === 'saved' ? 'on' : ''} onClick={() => setFilter('saved')}>Saved <span>{items.length}</span></button>
          <button type="button" className={filter === 'favorites' ? 'on' : ''} onClick={() => setFilter('favorites')}>Favorites <span>{favoriteIds.size}</span></button>
          <button type="button" className={filter === 'review' ? 'on' : ''} onClick={() => setFilter('review')}>Needs your review <span>{items.filter(item => /review|approval|comment/i.test(`${item.description ?? ''} ${item.filename}`)).length}</span></button>
          <button type="button" className={filter === 'recent' ? 'on' : ''} onClick={() => setFilter('recent')}>Recently updated</button>
          <span className="v8-tabs__spacer" />
          <label className="v8-search"><Search /><input value={search} onChange={event => setSearch(event.target.value)} placeholder="Search documents…" /></label>
        </div>

        <div className="v8-chips">
          <button type="button" className={space === 'all' ? 'on' : ''} onClick={() => setSpace('all')}>All spaces</button>
          {(Object.keys(TEAM_CLASSIFICATION_META) as TeamClassificationKey[]).map(key => (
            <button type="button" key={key} className={`${space === key ? 'on ' : ''}${key}`} onClick={() => setSpace(key)}>
              <i style={{ background: TEAM_CLASSIFICATION_META[key].color }} />{TEAM_CLASSIFICATION_META[key].label} <span>{counts[key]}</span>
            </button>
          ))}
        </div>

        {loading && <div className="v8-documents-status">Loading documents…</div>}
        {!loading && error && <div className="v8-documents-status error">{error}</div>}
        {!loading && !error && actionError && <div className="v8-documents-inline-error">{actionError}</div>}

        {!loading && !error && visible.length === 0 && (
          <div className="v8-empty">
            <span className="glyph"><FileText /></span>
            <h2>{items.length ? 'No documents match this filter' : 'No saved documents yet'}</h2>
            <p>{items.length ? 'Try another space, view, or search.' : 'Open a session document and choose Save to add it here. Saving does not mark it as a favorite.'}</p>
            {!items.length && <button className="v8-btn v8-btn--ink" type="button" onClick={() => setModalOpen(true)}>New document</button>}
          </div>
        )}

        {!loading && !error && (Object.keys(TEAM_CLASSIFICATION_META) as TeamClassificationKey[]).map(key => {
          const roots = grouped.get(key);
          if (!roots?.size) return null;
          return (
            <section className="v8-documents-space" key={key}>
              <div className="v8-documents-spacehead"><i style={{ background: TEAM_CLASSIFICATION_META[key].color }} /><h2>{TEAM_CLASSIFICATION_META[key].label}</h2><span>{Array.from(roots.values()).reduce((sum, docs) => sum + docs.length, 0)}</span></div>
              {Array.from(roots.entries()).map(([rootKey, docs]) => (
                <div className="v8-documents-group" key={rootKey}>
                  <div className="v8-documents-session"><MessageCircle /><span>{docs[0]?.description || `${docs[0]?.rootType} session · ${docs[0]?.rootId}`}</span>{docs[0]?.rootType === 'chat' && <button type="button" onClick={() => navigate(`/chat/${docs[0].rootId}`)}>Open session →</button>}</div>
                  {docs.map(item => (
                    <div className="v8-documents-row" key={item.artifactId}>
                      <button className="v8-documents-open" type="button" onClick={() => {
                        const scopeKey = resourceScopeKey('surface', 'documents');
                        setActiveResourceScope(scopeKey);
                        openDocument(item, { sourceLabel: 'Documents', scopeKey });
                      }}>
                        <span className="v8-documents-icon"><FileText /></span>
                        <span className="v8-documents-copy"><b>{displayTitle(item.filename)}<em>{extension(item.filename)}</em></b><small>{documentType(item)} <i>·</i> v1 <i>·</i> updated {relativeTime(item.createdAt)} by {item.createdByAgent || 'Allen'}</small></span>
                      </button>
                      <TeamClassificationSelect
                        compact
                        value={item.teamClassification ?? null}
                        onChange={(value) => void updateClassification(item, value)}
                        disabled={updatingClassificationIds.has(item.artifactId)}
                        ariaLabel={`Team for ${item.filename}`}
                      />
                      <button
                        type="button"
                        className={`v8-documents-star ${favoriteIds.has(item.artifactId) ? 'on' : ''}`}
                        onClick={() => toggleFavorite(item.artifactId)}
                        disabled={updatingFavoriteIds.has(item.artifactId)}
                        aria-pressed={favoriteIds.has(item.artifactId)}
                        aria-label={favoriteIds.has(item.artifactId) ? `Remove ${item.filename} from favorites` : `Add ${item.filename} to favorites`}
                      >
                        <Star />
                      </button>
                      <time dateTime={item.createdAt}>{relativeTime(item.createdAt)}</time>
                    </div>
                  ))}
                </div>
              ))}
            </section>
          );
        })}

        {!loading && !error && items.length > 0 && <p className="v8-documents-foot">{items.length} saved documents across {Object.values(counts).filter(Boolean).length} spaces · from {new Set(items.map(item => `${item.rootType}:${item.rootId}`)).size} sessions</p>}
      </div>

      {modalOpen && (
        <div className="v8-modal-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) setModalOpen(false); }}>
          <div className="v8-modal" role="dialog" aria-modal="true" aria-labelledby="new-document-title">
            <button className="v8-modal-close" type="button" onClick={() => setModalOpen(false)} aria-label="Close"><X /></button>
            <h2 id="new-document-title">New document</h2>
            <label>Title<input autoFocus value={title} onChange={event => setTitle(event.target.value)} placeholder="e.g. Agent Template Gallery PRD" /></label>
            <div className="v8-modal-grid">
              <label>Type<select className="select-native" value={type} onChange={event => setType(event.target.value)}><option>PRD</option><option>Report</option><option>Brief</option><option>Notes</option></select></label>
              <label>Session<select className="select-native"><option>Start a new session</option></select></label>
            </div>
            <p>Documents live with their session — versioned and open for comments.</p>
            <div className="v8-modal-actions"><button className="btn btn-secondary" type="button" onClick={() => setModalOpen(false)}>Cancel</button><button className="v8-btn v8-btn--ink" type="button" onClick={createDocument}>Create</button></div>
          </div>
        </div>
      )}
    </section>
  );
}
