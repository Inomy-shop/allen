import { request } from './apiCore';

// ── Shared Types (TDD §1.3) ────────────────────────────────────────────────────

export type DocumentContentType = 'markdown' | 'text' | 'code' | 'json' | 'csv';
export type VersionOriginType = 'human' | 'agent' | 'system';
export type CommentStatus = 'open' | 'resolved' | 'stale';
export type AnchorType = 'line' | 'range' | 'text_snippet';
export type AuthorType = 'human' | 'agent';

export interface DocumentVersion {
  versionNumber: number;
  content: string;
  contentHash: string;
  createdByUserId?: string;
  createdByAgentName?: string;
  createdByOriginType: VersionOriginType;
  addressedCommentIds?: string[];
  createdReason?: string;
  createdAt: string;
}

export interface DocumentIdentityDoc {
  documentId: string;
  sourceArtifactId: string;
  versions: DocumentVersion[];
  latestVersionNumber: number;
  contentType: DocumentContentType;
  createdAt: string;
  updatedAt: string;
}

export interface DocumentIdentitySummary {
  documentId: string;
  sourceArtifactId: string;
  latestVersionNumber: number;
  contentType: DocumentContentType;
  latestContent: string;
  unresolvedCommentCount: number;
  resolvedCommentCount: number;
  staleCommentCount: number;
  createdAt?: string;
  updatedAt?: string;
}

export interface CommentAnchor {
  type: AnchorType;
  lineStart?: number;
  lineEnd?: number;
  snippet?: string;
  context: string;
  anchoredAtVersion: number;
  staleReason?: string;
  staleAt?: string;
}

export interface CommentResolution {
  resolvedByUserId?: string;
  resolvedByAgentName?: string;
  resolvedByDisplayName?: string;
  resolvedByEmail?: string;
  resolvedAtVersion: number;
  resolutionNote: string;
  resolvedAt: string;
}

export interface DocumentCommentDoc {
  commentId: string;
  documentId: string;
  threadId: string;
  parentCommentId?: string;
  authorType: AuthorType;
  authorUserId?: string;
  authorAgentName?: string;
  authorDisplayName?: string;
  authorEmail?: string;
  body: string;
  status: CommentStatus;
  anchor: CommentAnchor;
  resolution?: CommentResolution;
  reopenCount: number;
  lastReopenAt?: string;
  createdAt: string;
  updatedAt: string;
  /** Nested replies when grouped by thread (not on raw doc) */
  replies?: DocumentCommentDoc[];
}

export interface WriteAnchor {
  type: AnchorType;
  lineStart?: number;
  lineEnd?: number;
  snippet?: string;
  context: string;
}

// ── Diff & Compare Types ──────────────────────────────────────────────────────

export type DiffLineType = 'added' | 'removed' | 'modified' | 'unchanged';

export interface DiffLine {
  type: DiffLineType;
  lineNumberV1?: number;
  lineNumberV2?: number;
  text: string;
  oldText?: string;
}

export interface CompareResponse {
  documentId: string;
  v1: { versionNumber: number; createdAt: string };
  v2: { versionNumber: number; createdAt: string };
  diff: DiffLine[];
  addressedCommentIds: string[];
  stats: {
    linesAdded: number;
    linesRemoved: number;
    linesModified: number;
    linesUnchanged: number;
  };
}

export interface VersionListEntry {
  versionNumber: number;
  contentHash: string;
  createdByUserId?: string;
  createdByAgentName?: string;
  createdByOriginType: VersionOriginType;
  addressedCommentIds?: string[];
  createdReason?: string;
  createdAt: string;
}

export interface VersionListResponse {
  documentId: string;
  latestVersionNumber: number;
  versions: VersionListEntry[];
}

export interface VersionDetailResponse {
  documentId: string;
  version: DocumentVersion;
  isLatest: boolean;
}

export interface CreateVersionResponse {
  documentId: string;
  versionNumber: number;
  contentHash: string;
  createdByOriginType: VersionOriginType;
  createdByAgentName?: string;
  addressedCommentIds?: string[];
  createdReason?: string;
  createdAt: string;
  resolvedComments?: DocumentCommentDoc[];
  staleComments?: DocumentCommentDoc[];
  unresolvedCommentIds?: string[];
}

export interface RestoreVersionResponse {
  documentId: string;
  newVersionNumber: number;
  restoredFromVersion: number;
  contentHash: string;
  createdByOriginType: VersionOriginType;
  createdReason: string;
  staleComments?: DocumentCommentDoc[];
}

export interface CreateCommentResponse {
  commentId: string;
  documentId: string;
  threadId: string;
  parentCommentId?: string;
  authorType: AuthorType;
  authorUserId?: string;
  authorAgentName?: string;
  body: string;
  status: CommentStatus;
  anchor: CommentAnchor;
  createdAt: string;
}

export interface ResolveCommentResponse {
  commentId: string;
  status: 'resolved';
  resolution: CommentResolution;
}

export interface ReopenCommentResponse {
  commentId: string;
  status: 'open';
  reopenCount: number;
  lastReopenAt: string;
}

// ── Timeline Types ────────────────────────────────────────────────────────────

export type TimelineEventType =
  | 'version_created'
  | 'comment_resolved'
  | 'comment_reopened'
  | 'comment_stale'
  | 'comment_created';

export interface TimelineEvent {
  type: TimelineEventType;
  eventId: string;
  timestamp: string;
  actorName?: string;
  actorType?: AuthorType | 'system';
  /** The version number this event relates to, if applicable */
  versionNumber?: number;
  /** The comment ID this event relates to, if applicable */
  commentId?: string;
  /** Optional line anchor metadata for compact timeline rows. */
  lineStart?: number;
  lineEnd?: number;
  detail?: string;
}

export interface TimelineResponse {
  documentId: string;
  events: TimelineEvent[];
}

// ── Eligibility Check Types ───────────────────────────────────────────────────

export interface ArtifactEligibilityResult {
  error: string;
  eligibleForCommenting: boolean;
  contentType?: DocumentContentType;
}


// ── Timeline Normalization ───────────────────────────────────────────────────

interface RawTimelineEvent {
  eventType: TimelineEventType;
  timestamp: string;
  data?: Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function actorForRawEvent(type: TimelineEventType, data: Record<string, unknown>): { actorName?: string; actorType?: TimelineEvent['actorType'] } {
  if (type === 'version_created') {
    const agent = asString(data.createdByAgentName);
    if (agent) return { actorName: agent, actorType: 'agent' };
    return {
      actorName: asString(data.createdByUserDisplayName) ?? asString(data.createdByUserEmail) ?? asString(data.createdByUserId),
      actorType: (asString(data.createdByUserId) || asString(data.createdByUserDisplayName) || asString(data.createdByUserEmail)) ? 'human' : 'system',
    };
  }
  if (type === 'comment_resolved') {
    const agent = asString(data.resolvedByAgentName);
    if (agent) return { actorName: agent, actorType: 'agent' };
    return {
      actorName: asString(data.resolvedByDisplayName) ?? asString(data.resolvedByEmail) ?? asString(data.resolvedByUserId),
      actorType: (asString(data.resolvedByUserId) || asString(data.resolvedByDisplayName) || asString(data.resolvedByEmail)) ? 'human' : 'system',
    };
  }
  if (type === 'comment_created') {
    const agent = asString(data.authorAgentName);
    if (agent) return { actorName: agent, actorType: 'agent' };
    return {
      actorName: asString(data.authorDisplayName) ?? asString(data.authorEmail) ?? asString(data.authorUserId),
      actorType: (asString(data.authorUserId) || asString(data.authorDisplayName) || asString(data.authorEmail)) ? 'human' : 'system',
    };
  }
  return { actorName: asString(data.actorName), actorType: 'system' };
}

function detailForRawEvent(type: TimelineEventType, data: Record<string, unknown>): string | undefined {
  if (type === 'version_created') return asString(data.createdReason);
  if (type === 'comment_resolved') return asString(data.resolutionNote);
  if (type === 'comment_stale') return asString(data.staleReason);
  if (type === 'comment_created') return asString(data.body);
  return asString(data.detail);
}

export function normalizeTimelineResponse(documentId: string, data: TimelineResponse | RawTimelineEvent[]): TimelineResponse {
  if (!Array.isArray(data)) {
    return { documentId: data.documentId ?? documentId, events: Array.isArray(data.events) ? data.events : [] };
  }

  return {
    documentId,
    events: data.map((evt, index) => {
      const raw = evt.data ?? {};
      const actor = actorForRawEvent(evt.eventType, raw);
      return {
        type: evt.eventType,
        eventId: `${evt.eventType}-${asString(raw.commentId) ?? asNumber(raw.versionNumber) ?? index}-${evt.timestamp}`,
        timestamp: evt.timestamp,
        ...actor,
        versionNumber: asNumber(raw.versionNumber) ?? asNumber(raw.resolvedAtVersion),
        commentId: asString(raw.commentId),
        lineStart: asNumber(raw.lineStart),
        lineEnd: asNumber(raw.lineEnd),
        detail: detailForRawEvent(evt.eventType, raw),
      };
    }),
  };
}

// ── API Client ────────────────────────────────────────────────────────────────

export const documents = {
  // ── D0: Lookup by artifact ──────────────────────────────────────────────
  getByArtifactId: (artifactId: string) =>
    request<DocumentIdentitySummary | ArtifactEligibilityResult>(`/documents/by-artifact/${artifactId}`),

  // ── D1: Create identity (lazy bridge) ───────────────────────────────────
  create: (body: { artifactId: string }) =>
    request<DocumentIdentityDoc>('/documents', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  // ── D2: Get document with latest + comment summary ──────────────────────
  get: (documentId: string) =>
    request<DocumentIdentitySummary>(`/documents/${documentId}`),

  // ── D3: List versions (metadata only) ───────────────────────────────────
  listVersions: (documentId: string) =>
    request<VersionListResponse>(`/documents/${documentId}/versions`),

  // ── D4: Get specific version ────────────────────────────────────────────
  getVersion: (documentId: string, versionNumber: number) =>
    request<VersionDetailResponse>(`/documents/${documentId}/versions/${versionNumber}`),

  // ── D5: Create new version ──────────────────────────────────────────────
  createVersion: (
    documentId: string,
    body: { content: string; addressedCommentIds?: string[]; createdReason?: string },
  ) =>
    request<CreateVersionResponse>(`/documents/${documentId}/versions`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  // ── D6: Restore version ─────────────────────────────────────────────────
  restoreVersion: (documentId: string, versionNumber: number) =>
    request<RestoreVersionResponse>(`/documents/${documentId}/versions/${versionNumber}/restore`, {
      method: 'POST',
    }),

  // ── D7: Compare versions ────────────────────────────────────────────────
  compareVersions: (documentId: string, v1: number, v2: number) =>
    request<CompareResponse>(`/documents/${documentId}/versions/compare?v1=${v1}&v2=${v2}`),

  // ── D8: List comments ───────────────────────────────────────────────────
  listComments: (documentId: string, status?: 'open' | 'resolved' | 'stale' | 'all') => {
    const qs = status && status !== 'open' ? `?status=${status}` : '';
    return request<DocumentCommentDoc[]>(`/documents/${documentId}/comments${qs}`);
  },

  // ── D9: Create comment ──────────────────────────────────────────────────
  createComment: (
    documentId: string,
    body: { body: string; anchor: WriteAnchor },
  ) =>
    request<CreateCommentResponse>(`/documents/${documentId}/comments`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  // ── D10: Reply to comment ───────────────────────────────────────────────
  replyToComment: (documentId: string, commentId: string, body: { body: string }) =>
    request<DocumentCommentDoc>(`/documents/${documentId}/comments/${commentId}/reply`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  // ── D11: Resolve comment ────────────────────────────────────────────────
  resolveComment: (documentId: string, commentId: string, body: { resolutionNote: string }) =>
    request<ResolveCommentResponse>(`/documents/${documentId}/comments/${commentId}/resolve`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  // ── D12: Reopen comment ─────────────────────────────────────────────────
  reopenComment: (documentId: string, commentId: string) =>
    request<ReopenCommentResponse>(`/documents/${documentId}/comments/${commentId}/reopen`, {
      method: 'POST',
    }),

  // ── D13: Timeline ───────────────────────────────────────────────────────
  getTimeline: async (documentId: string): Promise<TimelineResponse> => {
    const data = await request<TimelineResponse | RawTimelineEvent[]>(`/documents/${documentId}/timeline`);
    return normalizeTimelineResponse(documentId, data);
  },
};
