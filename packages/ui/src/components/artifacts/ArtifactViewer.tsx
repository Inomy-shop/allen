/**
 * ArtifactViewer — type-aware renderer for a single artifact.
 *
 * Renders:
 *   - markdown  → through the project's renderMarkdown (code blocks, links, …)
 *   - json      → pretty-printed, monospace, collapsible
 *   - csv       → table with header row, horizontal scroll for wide sheets
 *   - code      → monospace pre with language hint chip
 *   - text      → monospace pre
 *   - binary    → download-only link with metadata
 *
 * For text-based content types, checks for an associated document identity for
 * commenting and versioning. When identity exists, shows comment/version controls
 * in the header bar. When the artifact is eligible but no identity exists, shows
 * an "Enable Commenting" button. Reading experience remains unchanged when panels
 * are closed (R20).
 */
import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import {
  X as XIcon, Download, Copy, Trash2,
  FileText, FileJson, FileSpreadsheet, Code2, File, Database,
  MessageSquare, History, MessageSquarePlus, AlertTriangle,
  Bookmark,
} from 'lucide-react';
import { artifacts as artifactsApi, type ArtifactDoc } from '../../services/api';
import { documents as documentsApi } from '../../services/documents';
import type { DocumentIdentitySummary, DocumentContentType, DocumentCommentDoc, WriteAnchor } from '../../services/documents';
import { renderMarkdown } from '../chat/ChatMessageList';
import CommentPanel from './CommentPanel';
import CommentInput from './CommentInput';
import CommentAnchorOverlay from './CommentAnchorOverlay';
import VersionHistoryPanel from './VersionHistoryPanel';
import VersionDiffViewer from './VersionDiffViewer';
import CommentTimeline from './CommentTimeline';
import DocumentReviewRail from './DocumentReviewRail';

export interface ArtifactViewerProps {
  artifact: ArtifactDoc;
  onClose?: () => void;
  onDelete?: () => void;
  presentation?: 'embedded' | 'tab';
  baseTabLabel?: string;
  openTabs?: ArtifactDoc[];
  activeTabId?: string;
  onBaseTabSelect?: () => void;
  onTabSelect?: (artifactId: string) => void;
  onTabClose?: (artifactId: string) => void;
  hideTabStrip?: boolean;
}

// Text-based content types eligible for commenting.
const COMMENTABLE_TYPES: ReadonlySet<string> = new Set(['markdown', 'text', 'code', 'json', 'csv']);

type PanelView =
  | null
  | { kind: 'comments' }
  | { kind: 'versionHistory' }
  | { kind: 'diff'; v1: number; v2: number }
  | { kind: 'timeline' };

export default function ArtifactViewer({
  artifact,
  onClose,
  onDelete,
  presentation = 'embedded',
  baseTabLabel = 'Back',
  openTabs = [artifact],
  activeTabId = artifact.artifactId,
  onBaseTabSelect,
  onTabSelect,
  onTabClose,
  hideTabStrip = false,
}: ArtifactViewerProps) {
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [saved, setSaved] = useState(artifact.saved ?? false);
  const [savingDocument, setSavingDocument] = useState(false);
  const [libraryStateError, setLibraryStateError] = useState<string | null>(null);

  const url = artifactsApi.contentUrl(artifact.artifactId);

  // ── Document Identity State ────────────────────────────────────────────
  const [docIdentity, setDocIdentity] = useState<DocumentIdentitySummary | null>(null);
  const [identityLoading, setIdentityLoading] = useState(false);
  const [creatingIdentity, setCreatingIdentity] = useState(false);
  const [identityError, setIdentityError] = useState<string | null>(null);

  // ── Panel State ────────────────────────────────────────────────────────
  const [panel, setPanel] = useState<PanelView>(null);
  const [selectedAnchor, setSelectedAnchor] = useState<WriteAnchor | undefined>(undefined);
  const [showCommentInput, setShowCommentInput] = useState(false);
  const [comments, setComments] = useState<DocumentCommentDoc[]>([]);
  const [commentsLoading, setCommentsLoading] = useState(false);
  const [commentsError, setCommentsError] = useState<string | null>(null);
  const [reviewRailOpen, setReviewRailOpen] = useState(true);

  // ── Viewing an older version ───────────────────────────────────────────
  const [viewingVersion, setViewingVersion] = useState<number | null>(null);
  const [vintageContent, setVintageContent] = useState<string | null>(null);
  const [vintageLoading, setVintageLoading] = useState(false);

  const contentRef = useRef<HTMLDivElement>(null);
  const commentsRequestIdRef = useRef(0);

  const isCommentable = COMMENTABLE_TYPES.has(artifact.contentType);
  const eligibleForCommenting = isCommentable && !docIdentity;

  // ── Load artifact content ────────────────────────────────────────────

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 15_000);
    setLoading(true);
    setError(null);
    fetch(url, { signal: controller.signal })
      .then(async r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        if (artifact.contentType === 'binary') return '';
        return r.text();
      })
      .then(text => { if (!cancelled) setContent(text); })
      .catch(err => {
        if (!cancelled) setError((err as Error).name === 'AbortError' ? 'Content request timed out' : (err as Error).message);
      })
      .finally(() => {
        window.clearTimeout(timeout);
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [url, artifact.contentType]);

  useEffect(() => {
    setSaved(artifact.saved ?? false);
    setLibraryStateError(null);
  }, [artifact.artifactId, artifact.saved]);

  // ── Check for document identity ──────────────────────────────────────

  useEffect(() => {
    if (!isCommentable) {
      setDocIdentity(null);
      setIdentityLoading(false);
      return;
    }
    let cancelled = false;
    // Never render the previous artifact's document identity while the next
    // identity is loading.
    setDocIdentity(null);
    setIdentityLoading(true);
    setIdentityError(null);
    documentsApi.getByArtifactId(artifact.artifactId)
      .then(data => {
        if (cancelled) return;
        if ('documentId' in data && data.documentId) {
          setDocIdentity(data as DocumentIdentitySummary);
        } else {
          setDocIdentity(null);
        }
      })
      .catch(err => {
        if (cancelled) return;
        if ((err as any)?.status === 404) {
          setDocIdentity(null);
        } else {
          setIdentityError((err as Error).message);
        }
      })
      .finally(() => { if (!cancelled) setIdentityLoading(false); });
    return () => { cancelled = true; };
  }, [artifact.artifactId, isCommentable]);

  // Close panels when artifact changes
  useEffect(() => {
    commentsRequestIdRef.current += 1;
    setPanel(null);
    setSelectedAnchor(undefined);
    setShowCommentInput(false);
    setComments([]);
    setCommentsError(null);
    setViewingVersion(null);
    setVintageContent(null);
  }, [artifact.artifactId]);

  const displayContent = vintageContent ?? docIdentity?.latestContent ?? content;
  const displayedVersionNumber = viewingVersion ?? docIdentity?.latestVersionNumber ?? null;
  const unresolvedCommentCount = useMemo(
    () => comments.filter(comment => !comment.parentCommentId && comment.status === 'open').length,
    [comments],
  );
  const commentsForHighlighting = useMemo(
    () => comments.filter(comment => comment.status !== 'resolved'),
    [comments],
  );

  const refreshComments = useCallback(async () => {
    const requestId = ++commentsRequestIdRef.current;
    if (!docIdentity) {
      setComments([]);
      setCommentsLoading(false);
      setCommentsError(null);
      return;
    }
    setCommentsLoading(true);
    setCommentsError(null);
    try {
      const data = await documentsApi.listComments(docIdentity.documentId, 'all');
      if (requestId === commentsRequestIdRef.current) setComments(data);
    } catch (err) {
      // Preserve the last known/optimistically-added comments when a refresh
      // fails. A successful mutation must never disappear because a follow-up
      // list request had a transient error.
      if (requestId === commentsRequestIdRef.current) {
        setCommentsError(err instanceof Error ? err.message : 'Comments could not be refreshed.');
      }
    } finally {
      if (requestId === commentsRequestIdRef.current) setCommentsLoading(false);
    }
  }, [docIdentity]);

  const applyCommentUpdates = useCallback((updates: DocumentCommentDoc[]) => {
    if (updates.length === 0) return;
    commentsRequestIdRef.current += 1;
    setComments(current => {
      const next = new Map(current.map(comment => [comment.commentId, comment]));
      updates.forEach(comment => next.set(comment.commentId, comment));
      return [...next.values()].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    });
    setCommentsError(null);
  }, []);

  const handleCommentsChanged = useCallback(async (updates: DocumentCommentDoc[] = []) => {
    applyCommentUpdates(updates);
    await refreshComments();
  }, [applyCommentUpdates, refreshComments]);

  useEffect(() => {
    refreshComments();
  }, [refreshComments]);

  async function handleCopy() {
    if (!displayContent) return;
    try {
      await navigator.clipboard.writeText(displayContent);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch { /* ignore */ }
  }

  // ── Lazy identity creation ──────────────────────────────────────────

  async function handleEnableCommenting() {
    setCreatingIdentity(true);
    setIdentityError(null);
    try {
      const doc = await documentsApi.create({ artifactId: artifact.artifactId });
      setDocIdentity({
        documentId: doc.documentId,
        sourceArtifactId: doc.sourceArtifactId,
        latestVersionNumber: doc.latestVersionNumber,
        contentType: doc.contentType as DocumentContentType,
        latestContent: doc.versions[doc.versions.length - 1]?.content ?? '',
        unresolvedCommentCount: 0,
        resolvedCommentCount: 0,
        staleCommentCount: 0,
      });
    } catch (err) {
      setIdentityError((err as Error).message);
    } finally {
      setCreatingIdentity(false);
    }
  }

  // ── Version actions ─────────────────────────────────────────────────

  const closePanel = useCallback(() => {
    setPanel(null);
    setShowCommentInput(false);
    setSelectedAnchor(undefined);
  }, []);

  async function handleViewVersion(vn: number) {
    if (!docIdentity) return;
    setVintageLoading(true);
    try {
      const data = await documentsApi.getVersion(docIdentity.documentId, vn);
      setViewingVersion(vn);
      setVintageContent(data.version.content);
    } catch (err) {
      setIdentityError((err as Error).message);
    } finally {
      setVintageLoading(false);
    }
  }

  function handleCompareToLatest(vn: number) {
    if (!docIdentity) return;
    setPanel({ kind: 'diff', v1: vn, v2: docIdentity.latestVersionNumber });
  }

  function handleRestoreVersion(_vn: number) {
    // Panel will refresh; parent reloads identity
    setViewingVersion(null);
    setVintageContent(null);
    // The VersionHistoryPanel handles the API call; we refresh identity
    setTimeout(() => {
      documentsApi.getByArtifactId(artifact.artifactId).then(data => {
        if ('documentId' in data && data.documentId) {
          setDocIdentity(data as DocumentIdentitySummary);
          setViewingVersion(null);
          setVintageContent(null);
        }
      }).catch(() => {});
    }, 500);
  }

  function handleJumpToAnchor(anchor: DocumentCommentDoc['anchor']) {
    if (contentRef.current && anchor.lineStart) {
      const renderedLine = findRenderedLineElement(contentRef.current, anchor.lineStart);
      if (renderedLine) {
        contentRef.current.scrollTo({
          top: Math.max(0, renderedLine.offsetTop - 100),
          behavior: 'smooth',
        });
      } else {
        const lineHeight = 20; // fallback for plain text/code overlays
        const targetY = (anchor.lineStart - 1) * lineHeight;
        contentRef.current.scrollTop = Math.max(0, targetY - 100);
      }
    }
    // Open comment panel if closed
    if (!panel || panel.kind !== 'comments') {
      setPanel({ kind: 'comments' });
    }
  }

  // ── Text selection → anchor ──────────────────────────────────────────

  function handleTextSelect() {
    if (!docIdentity) return;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) {
      setSelectedAnchor(undefined);
      setShowCommentInput(false);
      return;
    }
    const range = sel.getRangeAt(0);
    const snippet = sel.toString().trim();
    if (!snippet) return;

    // Count lines from selection start
    const container = contentRef.current;
    if (!container) return;

    const startSourceLine = findSourceLineForNode(range.startContainer, container, 'start');
    const endSourceLine = findSourceLineForNode(range.endContainer, container, 'end');

    // Prefer rendered markdown source-line metadata. Falling back to offset
    // math keeps plain text/code/json/csv behavior unchanged.
    const fullText = displayContent ?? '';
    let startLine: number;
    let endLine: number;
    if (startSourceLine && endSourceLine) {
      startLine = Math.min(startSourceLine, endSourceLine);
      endLine = Math.max(startSourceLine, endSourceLine);
    } else {
      const textBefore = fullText.substring(0, findNodeOffset(range.startContainer, range.startOffset, container));
      startLine = (textBefore.match(/\n/g)?.length ?? 0) + 1;
      endLine = startLine + (snippet.match(/\n/g)?.length ?? 0);
    }

    // Extract context: 2 lines before and after
    const lines = fullText.split('\n');
    const contextStart = Math.max(0, startLine - 3);
    const contextEnd = Math.min(lines.length, endLine + 2);
    const context = lines.slice(contextStart, contextEnd).join('\n');

    const anchor: WriteAnchor = {
      type: startLine === endLine ? 'line' : 'range',
      lineStart: startLine,
      lineEnd: endLine,
      snippet,
      context,
    };
    setSelectedAnchor(anchor);
    setShowCommentInput(true);
    if (presentation === 'tab') setReviewRailOpen(true);
  }

  // Content lines for anchor overlay
  const contentLines = useMemo(() => displayContent?.split('\n') ?? [], [displayContent]);
  const renderMarkdownLineAnchors = artifact.contentType === 'markdown' && Boolean(docIdentity);
  const artifactBodyClass = renderMarkdownLineAnchors
    ? 'artifact-viewer__reading py-4 pr-4 pl-10 md:py-5 md:pr-5 md:pl-12'
    : 'artifact-viewer__reading p-4 md:p-5';

  const Icon = iconForType(artifact.contentType);
  const documentTitle = artifact.filename
    .replace(/\.(md|markdown|json|csv|txt|text)$/i, '')
    .replace(/[-_]+/g, ' ');

  function handleDocumentComment() {
    if (!docIdentity) return;
    setSelectedAnchor({
      type: 'text_snippet',
      snippet: documentTitle,
      context: `Document-level feedback for ${documentTitle}`,
    });
    setShowCommentInput(true);
    if (presentation === 'tab') setReviewRailOpen(true);
  }

  function handleTabCommentSubmitted(comment: DocumentCommentDoc) {
    setShowCommentInput(false);
    setSelectedAnchor(undefined);
    applyCommentUpdates([comment]);
    setReviewRailOpen(true);
    void refreshComments();
  }

  function handleCommentCancel() {
    setShowCommentInput(false);
    setSelectedAnchor(undefined);
  }

  async function handleSaveToggle() {
    if (savingDocument) return;
    const nextSaved = !saved;
    setSaved(nextSaved);
    setSavingDocument(true);
    setLibraryStateError(null);
    try {
      const updated = await artifactsApi.updateLibraryState(artifact.artifactId, { saved: nextSaved });
      setSaved(updated.saved ?? false);
    } catch (cause) {
      setSaved(!nextSaved);
      setLibraryStateError(cause instanceof Error ? cause.message : 'Document library state could not be updated.');
    } finally {
      setSavingDocument(false);
    }
  }

  if (presentation === 'tab') {
    return (
      <div className={`document-tab-workspace ${reviewRailOpen ? 'with-review' : 'without-review'}`}>
        <main className="document-tab-main">
          {!hideTabStrip && <nav className="document-tab-strip" aria-label="Open content tabs">
            <button type="button" className="document-tab-strip__base" onClick={onBaseTabSelect}>{baseTabLabel}</button>
            {openTabs.map(tabArtifact => {
              const tabTitle = tabArtifact.filename
                .replace(/\.(md|markdown|json|csv|txt|text)$/i, '')
                .replace(/[-_]+/g, ' ');
              return (
                <button
                  type="button"
                  key={tabArtifact.artifactId}
                  className={`document-tab-strip__tab ${tabArtifact.artifactId === activeTabId ? 'on' : ''}`}
                  onClick={() => onTabSelect?.(tabArtifact.artifactId)}
                  title={tabTitle}
                >
                  <span>{tabTitle}</span>
                  <i
                    role="button"
                    tabIndex={0}
                    aria-label={`Close ${tabTitle}`}
                    onClick={event => { event.stopPropagation(); onTabClose?.(tabArtifact.artifactId); }}
                    onKeyDown={event => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        event.stopPropagation();
                        onTabClose?.(tabArtifact.artifactId);
                      }
                    }}
                  >×</i>
                </button>
              );
            })}
            <span />
          </nav>}

          <div ref={contentRef} className="document-tab-scroll">
            <article className="document-tab-document">
              <header className="document-tab-document__header">
                <span className="document-tab-document__glyph"><Icon /></span>
                <div className="document-tab-document__heading">
                  <div className="document-tab-document__title">{documentTitle}</div>
                  <div className="document-tab-document__meta">
                    {artifact.description || (artifact.contentType === 'markdown' ? 'document' : artifact.contentType)}
                    {docIdentity && <> · v{displayedVersionNumber ?? docIdentity.latestVersionNumber}</>}
                    <> · updated {formatRelativeTime(artifact.createdAt)}</>
                    {artifact.createdByAgent && <> by {artifact.createdByAgent}</>}
                  </div>
                </div>
                <button
                  type="button"
                  className={`document-tab-save ${saved ? 'on' : ''}`}
                  onClick={handleSaveToggle}
                  disabled={savingDocument}
                  aria-pressed={saved}
                >
                  <Bookmark />{savingDocument ? 'Saving…' : saved ? 'Saved' : 'Save'}
                </button>
                <button type="button" className="document-tab-action" onClick={handleCopy} disabled={!displayContent || artifact.contentType === 'binary'}><Copy />{copied ? 'Copied' : 'Copy'}</button>
                <a className="document-tab-action" href={url} download={artifact.filename}><Download />Download</a>
                <button type="button" className="document-tab-close" onClick={onClose} aria-label="Close document"><XIcon /></button>
              </header>

              {libraryStateError && <div className="document-tab-error">{libraryStateError}</div>}
              {identityError && <div className="document-tab-error">{identityError}</div>}
              {eligibleForCommenting && !creatingIdentity && (
                <button type="button" onClick={handleEnableCommenting} className="document-tab-enable-comments"><MessageSquarePlus />Enable commenting</button>
              )}
              {eligibleForCommenting && creatingIdentity && <div className="document-tab-loading">Enabling commenting…</div>}
              {viewingVersion && docIdentity && (
                <div className="artifact-viewer__version-banner">
                  <span>Viewing v{viewingVersion} · read-only</span>
                  <button type="button" onClick={() => { setViewingVersion(null); setVintageContent(null); }}>Back to latest</button>
                </div>
              )}

              <div className="document-tab-body" onMouseUp={handleTextSelect}>
                {loading && <div className="document-tab-loading">Loading…</div>}
                {identityLoading && !content && <div className="document-tab-loading">Checking comment eligibility…</div>}
                {error && <div className="document-tab-error">Failed to load: {error}</div>}
                {vintageLoading && <div className="document-tab-loading">Loading version…</div>}
                {!loading && !error && displayContent !== null && (
                  <>
                    {artifact.contentType === 'markdown' && (
                      renderMarkdownLineAnchors ? (
                        <MarkdownWithCommentAnchors
                          text={displayContent}
                          comments={commentsForHighlighting}
                          currentVersion={displayedVersionNumber ?? docIdentity?.latestVersionNumber ?? 0}
                          onJumpToComment={() => setReviewRailOpen(true)}
                        />
                      ) : (
                        <div className="prose prose-sm max-w-none">{renderMarkdown(displayContent) as React.ReactNode}</div>
                      )
                    )}
                    {artifact.contentType === 'json' && <JsonViewer text={displayContent} />}
                    {artifact.contentType === 'csv' && <CsvTable text={displayContent} />}
                    {artifact.contentType === 'code' && <pre className="document-tab-code">{displayContent}</pre>}
                    {artifact.contentType === 'text' && <pre className="document-tab-text">{displayContent}</pre>}
                    {artifact.contentType === 'binary' && <BinaryPreview url={url} filename={artifact.filename} size={artifact.sizeBytes} />}
                  </>
                )}
                {docIdentity && commentsForHighlighting.length > 0 && !renderMarkdownLineAnchors && (
                  <CommentAnchorOverlay
                    contentLines={contentLines}
                    comments={commentsForHighlighting}
                    currentVersion={docIdentity.latestVersionNumber}
                    onJumpToComment={() => setReviewRailOpen(true)}
                  />
                )}
              </div>

              {docIdentity && <div className="document-tab-hint">Select text for a line comment, or use “Comment on document” for document-level feedback.</div>}
            </article>
          </div>
        </main>

        {reviewRailOpen && (
          <DocumentReviewRail
            documentId={docIdentity?.documentId}
            documentTitle={documentTitle}
            currentVersion={docIdentity?.latestVersionNumber ?? 1}
            comments={comments}
            loading={identityLoading || commentsLoading}
            onClose={() => setReviewRailOpen(false)}
            onCommentDocument={handleDocumentComment}
            onJumpToAnchor={handleJumpToAnchor}
            onCommentsChanged={handleCommentsChanged}
            onViewVersion={handleViewVersion}
            commentAnchor={showCommentInput ? selectedAnchor : undefined}
            onCommentSubmitted={handleTabCommentSubmitted}
            onCommentCancel={handleCommentCancel}
          />
        )}

      </div>
    );
  }

  return (
    <div className="artifact-viewer flex h-full">
      {/* Viewer panel */}
      <div className="artifact-viewer__main flex h-full min-w-0 flex-1 flex-col bg-surface">
        {/* Header */}
        <div className="artifact-viewer__header shrink-0 border-b border-app bg-app-card px-4 py-3">
          <div className="artifact-viewer__header-row flex items-center gap-2.5">
            <span className="artifact-viewer__glyph"><Icon className={`w-4 h-4 shrink-0 ${colorForType(artifact.contentType)}`} /></span>
            <div className="flex-1 min-w-0">
              <div className="artifact-viewer__title text-[13px] text-theme-primary truncate">
                {documentTitle}
              </div>
              <div className="artifact-viewer__meta flex items-center gap-2 mt-0.5 text-[10px] font-mono text-theme-subtle">
                <span className="uppercase">{artifact.contentType}</span>
                {artifact.language && (
                  <>
                    <span>·</span>
                    <span>{artifact.language}</span>
                  </>
                )}
                {docIdentity && <><span>·</span><span>v{displayedVersionNumber ?? docIdentity.latestVersionNumber}</span></>}
                <span>·</span>
                <span>updated {formatRelativeTime(artifact.createdAt)}</span>
                {artifact.createdByAgent && (
                  <>
                    <span>·</span>
                    <span className="truncate">by {artifact.createdByAgent}</span>
                  </>
                )}
              </div>
            </div>
            <div className="artifact-viewer__actions shrink-0 flex items-center gap-1">
              {/* Comment/version controls — only when identity exists */}
              {docIdentity && (
                <>
                  <button
                    onClick={() => setPanel(p => p?.kind === 'comments' ? null : { kind: 'comments' })}
                    title="Toggle comments"
                    className={`artifact-viewer__action rounded-md p-1.5 transition-colors ${
                      panel?.kind === 'comments'
                        ? 'bg-accent-blue/15 text-accent-blue'
                        : 'text-theme-muted hover:bg-app-muted hover:text-theme-primary'
                    }`}
                  >
                    <MessageSquare className="w-3.5 h-3.5" />
                    <span>Comments{unresolvedCommentCount > 0 ? ` (${unresolvedCommentCount})` : ''}</span>
                  </button>
                  <button
                    onClick={() => setPanel(p => p?.kind === 'versionHistory' ? null : { kind: 'versionHistory' })}
                    title="Version history"
                    className={`artifact-viewer__action rounded-md p-1.5 transition-colors ${
                      panel?.kind === 'versionHistory'
                        ? 'bg-accent-blue/15 text-accent-blue'
                        : 'text-theme-muted hover:bg-app-muted hover:text-theme-primary'
                    }`}
                  >
                    <History className="w-3.5 h-3.5" />
                    <span>History</span>
                  </button>
                  <button
                    onClick={() => setPanel(p => p?.kind === 'timeline' ? null : { kind: 'timeline' })}
                    title="Timeline"
                    className={`artifact-viewer__action artifact-viewer__action--compact rounded-md p-1.5 transition-colors ${
                      panel?.kind === 'timeline'
                        ? 'bg-accent-blue/15 text-accent-blue'
                        : 'text-theme-muted hover:bg-app-muted hover:text-theme-primary'
                    }`}
                  >
                    <FileText className="w-3.5 h-3.5" />
                    <span>Timeline</span>
                  </button>
                </>
              )}
              <button
                onClick={handleCopy}
                disabled={!displayContent || artifact.contentType === 'binary'}
                title="Copy content"
                className="artifact-viewer__action rounded-md p-1.5 text-theme-muted transition-colors hover:bg-app-muted hover:text-theme-primary disabled:opacity-30"
              >
                <Copy className="w-3.5 h-3.5" />
                <span>{copied ? 'Copied' : 'Copy'}</span>
              </button>
              <a
                href={url}
                download={artifact.filename}
                title="Download"
                className="artifact-viewer__action rounded-md p-1.5 text-theme-muted transition-colors hover:bg-app-muted hover:text-theme-primary"
              >
                <Download className="w-3.5 h-3.5" />
                <span>Download</span>
              </a>
              {onDelete && (
                <button
                  onClick={onDelete}
                  title="Delete artifact"
                  className="artifact-viewer__icon-action rounded-md p-1.5 text-theme-muted transition-colors hover:bg-accent-red/10 hover:text-accent-red"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              )}
              {onClose && (
                <button
                  onClick={onClose}
                  title="Close viewer"
                  className="artifact-viewer__icon-action rounded-md p-1.5 text-theme-muted transition-colors hover:bg-app-muted hover:text-theme-primary"
                >
                  <XIcon className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          </div>
          {artifact.description && (
            <div className="text-[11px] text-theme-muted font-body italic">
              {artifact.description}
            </div>
          )}
          {/* Identity error / Enable Commenting */}
          {identityError && (
            <div className="text-[10px] text-accent-red font-mono mt-1">{identityError}</div>
          )}
          {eligibleForCommenting && !creatingIdentity && (
            <button
              type="button"
              onClick={handleEnableCommenting}
              className="mt-1.5 inline-flex items-center gap-1 rounded-md border border-dashed border-accent-blue/40 px-2.5 py-1 text-[10px] font-mono text-accent-blue transition-colors hover:border-accent-blue hover:bg-accent-blue/5"
            >
              <MessageSquarePlus className="w-3 h-3" />
              Enable Commenting
            </button>
          )}
          {eligibleForCommenting && creatingIdentity && (
            <div className="mt-1.5 text-[10px] font-mono text-theme-muted animate-pulse">
              Enabling commenting…
            </div>
          )}
        </div>

        {/* Body */}
        <div
          ref={contentRef}
          className="artifact-viewer__body min-h-0 flex-1 overflow-auto relative"
          onMouseUp={handleTextSelect}
        >
          {loading && displayContent === null && (
            <div className="p-6 text-xs text-theme-muted font-mono">Loading…</div>
          )}
          {identityLoading && !content && (
            <div className="p-6 text-xs text-theme-muted font-mono">Checking comment eligibility…</div>
          )}
          {error && displayContent === null && (
            <div className="p-6 text-xs text-accent-red font-mono">Failed to load: {error}</div>
          )}
          {vintageLoading && (
            <div className="p-6 text-xs text-theme-muted font-mono">Loading version…</div>
          )}
          {viewingVersion && docIdentity && (
            <div className="artifact-viewer__version-banner">
              <span>Viewing v{viewingVersion} · read-only</span>
              <button type="button" onClick={() => { setViewingVersion(null); setVintageContent(null); }}>Back to latest</button>
            </div>
          )}
          {displayContent !== null && (
            <div className={artifactBodyClass}>
              {artifact.contentType === 'markdown' && (
                renderMarkdownLineAnchors ? (
                  <MarkdownWithCommentAnchors
                    text={displayContent}
                    comments={commentsForHighlighting}
                    currentVersion={displayedVersionNumber ?? docIdentity?.latestVersionNumber ?? 0}
                    onJumpToComment={() => setPanel({ kind: 'comments' })}
                  />
                ) : (
                  <div className="prose prose-sm prose-invert max-w-none">
                    {renderMarkdown(displayContent) as React.ReactNode}
                  </div>
                )
              )}
              {artifact.contentType === 'json' && (
                <JsonViewer text={displayContent} />
              )}
              {artifact.contentType === 'csv' && (
                <CsvTable text={displayContent} />
              )}
              {artifact.contentType === 'code' && (
                <pre className="text-[12px] font-mono text-theme-primary whitespace-pre-wrap break-words leading-relaxed bg-app-muted/50 p-3 rounded border border-app">
                  {displayContent}
                </pre>
              )}
              {artifact.contentType === 'text' && (
                <pre className="text-[12px] font-body text-theme-secondary whitespace-pre-wrap break-words leading-relaxed">
                  {displayContent}
                </pre>
              )}
              {artifact.contentType === 'binary' && (
                <BinaryPreview url={url} filename={artifact.filename} size={artifact.sizeBytes} />
              )}
            </div>
          )}
          {docIdentity && commentsForHighlighting.length > 0 && !renderMarkdownLineAnchors && (
            <CommentAnchorOverlay
              contentLines={contentLines}
              comments={commentsForHighlighting}
              currentVersion={docIdentity.latestVersionNumber}
              onJumpToComment={() => setPanel({ kind: 'comments' })}
            />
          )}
        </div>

        {docIdentity && (
          <div className="artifact-viewer__hint">
            Select text for a line comment, or open Comments for document-level feedback.
          </div>
        )}

        {/* Inline comment input (text selection mode) */}
        {showCommentInput && docIdentity && selectedAnchor && (
          <CommentInput
            documentId={docIdentity.documentId}
            anchor={selectedAnchor}
            onSubmitted={(comment) => {
              setShowCommentInput(false);
              setSelectedAnchor(undefined);
              applyCommentUpdates([comment]);
              setPanel({ kind: 'comments' });
              void refreshComments();
            }}
            onCancel={() => {
              setShowCommentInput(false);
              setSelectedAnchor(undefined);
            }}
          />
        )}
      </div>

      {/* Side panels */}
      {panel?.kind === 'comments' && docIdentity && (
        <CommentPanel
          documentId={docIdentity.documentId}
          currentVersion={docIdentity.latestVersionNumber}
          comments={comments}
          loading={commentsLoading}
          error={commentsError}
          onClose={closePanel}
          onJumpToAnchor={handleJumpToAnchor}
          onCommentsChanged={handleCommentsChanged}
        />
      )}
      {panel?.kind === 'versionHistory' && docIdentity && (
        <VersionHistoryPanel
          documentId={docIdentity.documentId}
          latestVersionNumber={docIdentity.latestVersionNumber}
          onViewVersion={handleViewVersion}
          onCompareToLatest={handleCompareToLatest}
          onRestoreVersion={handleRestoreVersion}
          onClose={closePanel}
        />
      )}
      {panel?.kind === 'diff' && docIdentity && (
        <VersionDiffViewer
          documentId={docIdentity.documentId}
          v1={panel.v1}
          v2={panel.v2}
          onClose={closePanel}
        />
      )}
      {panel?.kind === 'timeline' && docIdentity && (
        <CommentTimeline
          documentId={docIdentity.documentId}
          onClose={closePanel}
          onJumpToVersion={handleViewVersion}
        />
      )}
    </div>
  );
}

// ── Markdown line anchoring ────────────────────────────────────────────────

export interface MarkdownLineBlock {
  key: string;
  startLine: number;
  endLine: number;
  text: string;
  blank: boolean;
}

/**
 * Split markdown into rendered source-line blocks. Most lines render one-to-one
 * so comment anchors can attach to the actual displayed line. Fenced code blocks
 * and tables render as a single semantic block because splitting them would
 * destroy their markdown rendering.
 */
export function splitMarkdownIntoRenderedLineBlocks(text: string): MarkdownLineBlock[] {
  const lines = text.split('\n');
  const blocks: MarkdownLineBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const lineNo = i + 1;
    const line = lines[i] ?? '';

    if (line.trim() === '') {
      blocks.push({
        key: `blank-${lineNo}`,
        startLine: lineNo,
        endLine: lineNo,
        text: '',
        blank: true,
      });
      i++;
      continue;
    }

    if (line.match(/^\s*```/)) {
      const start = i;
      i++;
      while (i < lines.length && !lines[i].match(/^\s*```/)) i++;
      if (i < lines.length) i++;
      blocks.push({
        key: `fence-${start + 1}`,
        startLine: start + 1,
        endLine: i,
        text: lines.slice(start, i).join('\n'),
        blank: false,
      });
      continue;
    }

    if (line.includes('|') && i + 1 < lines.length && lines[i + 1]?.match(/^\|?[\s-:|]+\|/)) {
      const start = i;
      i += 2;
      while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') i++;
      blocks.push({
        key: `table-${start + 1}`,
        startLine: start + 1,
        endLine: i,
        text: lines.slice(start, i).join('\n'),
        blank: false,
      });
      continue;
    }

    blocks.push({
      key: `line-${lineNo}`,
      startLine: lineNo,
      endLine: lineNo,
      text: line,
      blank: false,
    });
    i++;
  }

  return blocks;
}

export function commentOverlapsMarkdownBlock(
  comment: DocumentCommentDoc,
  block: Pick<MarkdownLineBlock, 'startLine' | 'endLine'>,
): boolean {
  const anchor = comment.anchor;
  if (!anchor.lineStart) return false;
  const anchorEnd = anchor.type === 'range'
    ? (anchor.lineEnd ?? anchor.lineStart)
    : anchor.lineStart;
  return anchor.lineStart <= block.endLine && anchorEnd >= block.startLine;
}

export function commentStartsInMarkdownBlock(
  comment: DocumentCommentDoc,
  block: Pick<MarkdownLineBlock, 'startLine' | 'endLine'>,
): boolean {
  const lineStart = comment.anchor.lineStart;
  return Boolean(lineStart && lineStart >= block.startLine && lineStart <= block.endLine);
}

function MarkdownWithCommentAnchors({
  text,
  comments,
  currentVersion,
  onJumpToComment,
}: {
  text: string;
  comments: DocumentCommentDoc[];
  currentVersion: number;
  onJumpToComment: (commentId: string) => void;
}) {
  const blocks = useMemo(() => splitMarkdownIntoRenderedLineBlocks(text), [text]);

  return (
    <div className="prose prose-sm prose-invert max-w-none">
      <div className="artifact-markdown-lines space-y-0">
        {blocks.map(block => {
          if (block.blank) {
            return (
              <div
                key={block.key}
                data-source-line={block.startLine}
                data-source-line-end={block.endLine}
                className="h-3"
              />
            );
          }

          const blockComments = comments.filter(comment => commentOverlapsMarkdownBlock(comment, block));
          const markerComments = blockComments.filter(comment => commentStartsInMarkdownBlock(comment, block));
          const hasComments = blockComments.length > 0;
          const hasStale = blockComments.some(comment => comment.status === 'stale');
          const markerHasStale = markerComments.some(comment => comment.status === 'stale');
          const markerIsCurrent = markerComments.some(comment => comment.anchor.anchoredAtVersion === currentVersion);
          const label = block.startLine === block.endLine
            ? `Line ${block.startLine}`
            : `Lines ${block.startLine}-${block.endLine}`;

          return (
            <div
              key={block.key}
              data-source-line={block.startLine}
              data-source-line-end={block.endLine}
              className={`artifact-markdown-line relative -mx-2 rounded-sm border-l-2 px-2 py-0.5 ${
                hasComments
                  ? 'border-yellow-500/70 bg-yellow-300/20 dark:bg-yellow-300/15'
                  : 'border-transparent'
              } ${hasStale ? 'border-accent-orange/80 bg-accent-orange/10' : ''}`}
            >
              {markerComments.length > 0 && (
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    onJumpToComment(markerComments[0].commentId);
                  }}
                  className="not-prose absolute -left-6 top-1 inline-flex items-center rounded p-0.5 text-yellow-700 transition-colors hover:bg-yellow-300/30 dark:text-yellow-300"
                  title={`${markerComments.length} comment${markerComments.length === 1 ? '' : 's'} starting at ${label.toLowerCase()}`}
                  aria-label={`${markerComments.length} comment${markerComments.length === 1 ? '' : 's'} starting at ${label}`}
                >
                  {markerHasStale || !markerIsCurrent ? (
                    <AlertTriangle className="h-3 w-3 text-accent-orange" />
                  ) : (
                    <MessageSquare className="h-3 w-3" />
                  )}
                </button>
              )}
              <div className="[&_.markdown-body]:my-0 [&_.markdown-body>*:first-child]:mt-0 [&_.markdown-body>*:last-child]:mb-0">
                {renderMarkdown(block.text) as React.ReactNode}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Helper: Find text offset within a container ─────────────────────────────

function findSourceLineForNode(
  node: Node,
  container: HTMLElement,
  boundary: 'start' | 'end',
): number | null {
  let el: Element | null = node.nodeType === Node.ELEMENT_NODE
    ? node as Element
    : node.parentElement;

  while (el && el !== container) {
    if (el instanceof HTMLElement && el.dataset.sourceLine) {
      const start = Number.parseInt(el.dataset.sourceLine, 10);
      const end = Number.parseInt(el.dataset.sourceLineEnd ?? el.dataset.sourceLine, 10);
      const line = boundary === 'end' ? end : start;
      return Number.isFinite(line) ? line : null;
    }
    el = el.parentElement;
  }

  return null;
}

export function findRenderedLineElement(container: HTMLElement, line: number): HTMLElement | null {
  const nodes = Array.from(container.querySelectorAll<HTMLElement>('[data-source-line]'));
  return nodes.find(node => {
    const start = Number.parseInt(node.dataset.sourceLine ?? '', 10);
    const end = Number.parseInt(node.dataset.sourceLineEnd ?? node.dataset.sourceLine ?? '', 10);
    return Number.isFinite(start) && Number.isFinite(end) && line >= start && line <= end;
  }) ?? null;
}

function findNodeOffset(node: Node, offset: number, container: HTMLElement): number {
  let totalOffset = 0;
  let found = false;

  function walk(n: Node): boolean {
    if (found) return true;
    if (n === node) {
      // For text nodes, offset is within the node's text
      if (n.nodeType === Node.TEXT_NODE) {
        totalOffset += offset;
      }
      found = true;
      return true;
    }
    if (n.nodeType === Node.TEXT_NODE) {
      totalOffset += (n.textContent?.length ?? 0);
    } else {
      for (let i = 0; i < n.childNodes.length; i++) {
        if (walk(n.childNodes[i])) return true;
      }
    }
    return false;
  }

  walk(container);
  return totalOffset;
}

// ── JSON ───────────────────────────────────────────────────────────────

function JsonViewer({ text }: { text: string }) {
  const formatted = useMemo(() => {
    try { return JSON.stringify(JSON.parse(text), null, 2); }
    catch { return text; }
  }, [text]);
  return (
    <pre className="text-[12px] font-mono text-theme-primary whitespace-pre-wrap break-words leading-relaxed bg-[rgb(var(--color-editor-background))] p-3 rounded border border-app">
      {formatted}
    </pre>
  );
}

// ── CSV ────────────────────────────────────────────────────────────────

/**
 * Parse CSV — handles quoted values, escaped quotes ("" → "), and
 * multi-line fields. Good enough for the 99% case; agents producing
 * exotic dialects can emit JSON instead.
 */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else {
        field += c;
      }
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(field); field = '';
        rows.push(row); row = [];
      } else {
        field += c;
      }
    }
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter(r => r.length > 1 || (r.length === 1 && r[0] !== ''));
}

function CsvTable({ text }: { text: string }) {
  const rows = useMemo(() => parseCsv(text), [text]);
  if (rows.length === 0) {
    return <div className="text-xs text-theme-muted italic">Empty CSV</div>;
  }
  const [header, ...body] = rows;
  return (
    <div className="overflow-x-auto rounded-md border border-app">
      <table className="min-w-full text-[11px] font-mono">
        <thead className="bg-app-muted border-b border-app sticky top-0">
          <tr>
            {header.map((h, i) => (
              <th key={i} className="px-3 py-1.5 text-left font-label uppercase tracking-wider text-theme-muted whitespace-nowrap">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((r, i) => (
            <tr key={i} className="border-b border-border/10 last:border-b-0 hover:bg-surface-200/20">
              {header.map((_, j) => (
                <td key={j} className="px-3 py-1.5 text-theme-secondary align-top whitespace-pre-wrap break-words max-w-[280px]">
                  {r[j] ?? ''}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="px-3 py-1.5 text-[10px] font-mono text-theme-subtle bg-app-muted/50 border-t border-app">
        {body.length} row{body.length === 1 ? '' : 's'} · {header.length} column{header.length === 1 ? '' : 's'}
      </div>
    </div>
  );
}

// ── Binary ─────────────────────────────────────────────────────────────

function BinaryPreview({ url, filename, size }: { url: string; filename: string; size: number }) {
  const ext = filename.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? '';
  const isImage = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext);
  if (isImage) {
    return (
      <div className="flex flex-col items-center gap-2">
        <img
          src={url}
          alt={filename}
          className="max-w-full max-h-[70vh] rounded border border-app bg-app-muted/40"
        />
        <div className="text-[10px] font-mono text-theme-subtle">{filename} · {formatSize(size)}</div>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-3 p-4 rounded-md border border-app bg-app-muted/50">
      <Database className="w-6 h-6 text-theme-muted shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="text-xs font-mono text-theme-primary truncate">{filename}</div>
        <div className="text-[10px] font-mono text-theme-subtle">{formatSize(size)} · binary — click download to save</div>
      </div>
      <a
        href={url}
        download={filename}
        className="px-3 py-1.5 rounded-md bg-accent-blue text-white text-xs font-body hover:opacity-90 flex items-center gap-1.5"
      >
        <Download className="w-3 h-3" /> Download
      </a>
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

function formatRelativeTime(value: string): string {
  const elapsed = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(elapsed) || elapsed < 60_000) return 'just now';
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
