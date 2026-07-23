/**
 * DocumentService — bridges artifacts to commentable/versionable documents.
 *
 * Two collections:
 *   - `document_identities`  — one row per document, inline versions
 *   - `document_comments`    — threaded comments anchored to document locations
 *
 * Follows the DesignDocService / ArtifactService patterns: typed inline models,
 * constructor injection of `db: Db`, `ensureIndexes()` called at boot.
 */
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import type { Db, Collection, ObjectId } from 'mongodb';
import { ArtifactService } from './artifact.service.js';

// ── Exported Types (TDD §1.3) ─────────────────────────────────────────────

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
  createdAt: Date;
}

export interface DocumentIdentityDoc {
  _id?: ObjectId;
  documentId: string;
  sourceArtifactId: string;
  versions: DocumentVersion[];
  latestVersionNumber: number;
  contentType: DocumentContentType;
  createdAt: Date;
  updatedAt: Date;
}

export interface CommentAnchor {
  type: AnchorType;
  lineStart?: number;
  lineEnd?: number;
  snippet?: string;
  context: string;
  anchoredAtVersion: number;
  staleReason?: string;
  staleAt?: Date;
}

export interface CommentResolution {
  resolvedByUserId?: string;
  resolvedByAgentName?: string;
  resolvedAtVersion: number;
  resolutionNote: string;
  resolvedAt: Date;
}

export interface DocumentCommentDoc {
  _id?: ObjectId;
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
  resolution?: CommentResolution;
  reopenCount: number;
  lastReopenAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

// ── Diff types (Appendix B) ───────────────────────────────────────────────

export type DiffLineType = 'unchanged' | 'added' | 'removed' | 'modified';

export interface DiffLine {
  type: DiffLineType;
  lineNumberV1?: number;
  lineNumberV2?: number;
  text: string;
  oldText?: string;
}

export interface VersionCompareResult {
  documentId: string;
  v1: { versionNumber: number; createdAt: Date };
  v2: { versionNumber: number; createdAt: Date };
  diff: DiffLine[];
  addressedCommentIds: string[];
  stats: {
    linesAdded: number;
    linesRemoved: number;
    linesModified: number;
    linesUnchanged: number;
  };
}

// ── Timeline event types ──────────────────────────────────────────────────

export type TimelineEventType =
  | 'version_created'
  | 'comment_resolved'
  | 'comment_reopened'
  | 'comment_stale'
  | 'comment_created';

export interface TimelineEvent {
  eventType: TimelineEventType;
  timestamp: Date;
  data: Record<string, unknown>;
}

// ── Error codes (TDD §4) ──────────────────────────────────────────────────

export const ERROR_CODES = {
  ARTIFACT_NOT_FOUND: 'ARTIFACT_NOT_FOUND',
  ARTIFACT_INELIGIBLE: 'ARTIFACT_INELIGIBLE',
  DOCUMENT_NOT_FOUND: 'DOCUMENT_NOT_FOUND',
  VERSION_NOT_FOUND: 'VERSION_NOT_FOUND',
  CONTENT_REQUIRED: 'CONTENT_REQUIRED',
  ANCHOR_REQUIRED: 'ANCHOR_REQUIRED',
  BODY_REQUIRED: 'BODY_REQUIRED',
  RESOLUTION_NOTE_REQUIRED: 'RESOLUTION_NOTE_REQUIRED',
  IDENTITY_EXISTS: 'IDENTITY_EXISTS',
  CONTENT_UNCHANGED: 'CONTENT_UNCHANGED',
  COMMENT_ALREADY_RESOLVED: 'COMMENT_ALREADY_RESOLVED',
  COMMENT_ALREADY_OPEN: 'COMMENT_ALREADY_OPEN',
  COMMENT_IS_STALE: 'COMMENT_IS_STALE',
  INVALID_VERSION_PARAM: 'INVALID_VERSION_PARAM',
  ARTIFACT_ID_REQUIRED: 'ARTIFACT_ID_REQUIRED',
  INTERNAL: 'INTERNAL',
  VERSION_NOT_FOUND_V1: 'VERSION_NOT_FOUND_V1',
  VERSION_NOT_FOUND_V2: 'VERSION_NOT_FOUND_V2',
} as const;

function makeError(code: string, message: string, status: number): never {
  const err = new Error(message) as Error & { code: string; statusCode: number };
  err.code = code;
  err.statusCode = status;
  throw err;
}

const ELIGIBLE_CONTENT_TYPES = new Set(['markdown', 'text', 'code', 'json', 'csv']);

// ── LCS-based Diff (Appendix B) ───────────────────────────────────────────

/**
 * Compute line-based LCS (Longest Common Subsequence) between two string arrays.
 * Returns a 2D array usable by the backtracking below.
 */
function computeLCS(a: string[], b: string[]): number[][] {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1] + 1
        : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp;
}

/**
 * Produce diff lines from LCS table. Walks the DP table backwards.
 */
function backtrackDiff(a: string[], b: string[], dp: number[][]): DiffLine[] {
  const result: DiffLine[] = [];
  let i = a.length;
  let j = b.length;

  // Collect in reverse, then reverse at the end.
  const reversed: DiffLine[] = [];

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      reversed.push({ type: 'unchanged', lineNumberV1: i, lineNumberV2: j, text: a[i - 1] });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      reversed.push({ type: 'added', lineNumberV2: j, text: b[j - 1] });
      j--;
    } else if (i > 0) {
      reversed.push({ type: 'removed', lineNumberV1: i, text: a[i - 1] });
      i--;
    }
  }

  // Reverse to get chronological order and merge adjacent chunks into
  // "modified" where a removal and an addition occupy the same conceptual
  // position.
  reversed.reverse();

  // Coalesce adjacent removed+added into modified where sensible.
  const merged: DiffLine[] = [];
  let idx = 0;
  while (idx < reversed.length) {
    const cur = reversed[idx];
    const next = reversed[idx + 1];
    if (
      cur.type === 'removed' &&
      next &&
      next.type === 'added'
    ) {
      merged.push({
        type: 'modified',
        lineNumberV1: cur.lineNumberV1,
        lineNumberV2: next.lineNumberV2,
        text: next.text,
        oldText: cur.text,
      });
      idx += 2;
    } else {
      merged.push(cur);
      idx++;
    }
  }

  return merged;
}

/**
 * Compute a line-based unified-style diff between two content strings.
 */
export function computeDiff(v1Content: string, v2Content: string): DiffLine[] {
  const v1Lines = v1Content.split('\n');
  const v2Lines = v2Content.split('\n');
  const lcs = computeLCS(v1Lines, v2Lines);
  return backtrackDiff(v1Lines, v2Lines, lcs);
}

// ── Anchor Re-Validation Helpers (Appendix A) ─────────────────────────────

/**
 * Approximate token overlap similarity (fraction of words shared).
 */
function tokenSimilarity(a: string, b: string): number {
  const tokenize = (s: string): Set<string> =>
    new Set(s.toLowerCase().split(/[^\w]+/).filter(Boolean));
  const aTokens = tokenize(a);
  const bTokens = tokenize(b);
  if (aTokens.size === 0 && bTokens.size === 0) return 1;
  let intersection = 0;
  for (const t of aTokens) {
    if (bTokens.has(t)) intersection++;
  }
  const union = aTokens.size + bTokens.size - intersection;
  return union === 0 ? 1 : intersection / union;
}

/**
 * Three-tier anchor re-validation per Appendix A.
 * Returns true if the anchor is still valid against newContent.
 */
function revalidateAnchor(anchor: CommentAnchor, newContent: string): boolean {
  const lines = newContent.split('\n');

  // Tier 1: Line-based match
  if (anchor.lineStart != null && anchor.lineEnd != null) {
    const startIdx = Math.max(0, anchor.lineStart - 1);
    const endIdx = Math.min(lines.length, anchor.lineEnd);
    const rangeText = lines.slice(startIdx, endIdx).join('\n');
    if (anchor.snippet && tokenSimilarity(anchor.snippet, rangeText) > 0.7) {
      return true;
    }
    // Also try context
    if (anchor.context && tokenSimilarity(anchor.context, rangeText) > 0.7) {
      return true;
    }
  }

  // Tier 2: Full-text snippet search
  if (anchor.snippet && newContent.includes(anchor.snippet)) {
    return true;
  }

  // Tier 3: Context similarity (Jaccard > 0.5)
  if (anchor.context) {
    // Search for a window in newContent that overlaps the context
    const windowSize = 100; // characters
    for (let i = 0; i < Math.max(1, newContent.length - windowSize); i += windowSize / 2) {
      const window = newContent.slice(i, i + windowSize);
      if (tokenSimilarity(anchor.context, window) > 0.5) {
        return true;
      }
    }
  }

  return false;
}

// ── Summary helpers ───────────────────────────────────────────────────────

export interface DocumentSummary {
  documentId: string;
  sourceArtifactId: string;
  latestVersionNumber: number;
  contentType: DocumentContentType;
  createdAt: Date;
  updatedAt: Date;
  latestContent: string;
  unresolvedCommentCount: number;
  resolvedCommentCount: number;
  staleCommentCount: number;
}

export interface VersionListResult {
  documentId: string;
  latestVersionNumber: number;
  versions: Array<Omit<DocumentVersion, 'content'>>;
}

export interface VersionDetailResult {
  documentId: string;
  version: DocumentVersion;
  isLatest: boolean;
}

export interface AddVersionResult {
  documentId: string;
  versionNumber: number;
  contentHash: string;
  createdByOriginType: VersionOriginType;
  createdByAgentName?: string;
  createdByUserId?: string;
  addressedCommentIds?: string[];
  createdReason?: string;
  createdAt: Date;
  resolvedComments: Array<{ commentId: string; status: string }>;
  staleComments: Array<{ commentId: string; status: string; staleReason: string }>;
  unresolvedCommentIds: string[];
}

export interface RestoreVersionResult {
  documentId: string;
  newVersionNumber: number;
  restoredFromVersion: number;
  contentHash: string;
  createdByOriginType: VersionOriginType;
  createdReason: string;
  staleComments: Array<{ commentId: string; status: string; staleReason: string }>;
}

// ── DocumentService ───────────────────────────────────────────────────────

export class DocumentService {
  private identities: Collection<DocumentIdentityDoc>;
  private comments: Collection<DocumentCommentDoc>;

  constructor(private db: Db) {
    this.identities = db.collection<DocumentIdentityDoc>('document_identities');
    this.comments = db.collection<DocumentCommentDoc>('document_comments');
  }

  async ensureIndexes(): Promise<void> {
    await this.identities.createIndexes([
      { key: { documentId: 1 }, unique: true },
      { key: { sourceArtifactId: 1 } },
    ]);
    await this.comments.createIndexes([
      { key: { commentId: 1 }, unique: true },
      { key: { documentId: 1, status: 1, createdAt: 1 } },
      { key: { documentId: 1, threadId: 1, createdAt: 1 } },
      { key: { documentId: 1, createdAt: 1 } },
    ]);
  }

  // ── Identity Lookup ───────────────────────────────────────────────────

  async findIdentityByArtifactId(artifactId: string): Promise<DocumentIdentityDoc | null> {
    // Lazy bridge: the documentId may equal the artifactId, or sourceArtifactId stores
    // the original artifact that triggered creation.
    const byId = await this.identities.findOne({ documentId: artifactId });
    if (byId) return byId;
    return this.identities.findOne({ sourceArtifactId: artifactId });
  }

  async findIdentityByDocumentId(documentId: string): Promise<DocumentIdentityDoc | null> {
    return this.identities.findOne({ documentId });
  }

  // ── Lazy Identity Creation (D1) ───────────────────────────────────────

  async createFromArtifact(
    artifactId: string,
    opts?: { createdByUserId?: string; createdByAgentName?: string },
  ): Promise<DocumentIdentityDoc> {
    if (!artifactId) {
      makeError(ERROR_CODES.ARTIFACT_ID_REQUIRED, '"artifactId" is required', 400);
    }

    // Check if identity already exists
    const existing = await this.findIdentityByArtifactId(artifactId);
    if (existing) {
      makeError(
        ERROR_CODES.IDENTITY_EXISTS,
        `A document identity already exists for artifact "${artifactId}"`,
        409,
      );
    }

    // Read the artifact
    const artifactService = new ArtifactService(this.db);
    const result = await artifactService.readContent(artifactId);
    if (!result) {
      makeError(ERROR_CODES.ARTIFACT_NOT_FOUND, `Artifact "${artifactId}" not found`, 404);
    }

    // Eligibility check
    const contentType = result.doc.contentType as DocumentContentType;
    if (!ELIGIBLE_CONTENT_TYPES.has(contentType)) {
      makeError(
        ERROR_CODES.ARTIFACT_INELIGIBLE,
        `Artifact content type "${result.doc.contentType}" is not eligible for commenting`,
        400,
      );
    }

    const content = result.content.toString('utf-8');
    const contentHash = createHash('sha256').update(content).digest('hex');
    const now = new Date();
    const documentId = randomUUID();

    const version: DocumentVersion = {
      versionNumber: 1,
      content,
      contentHash,
      createdByUserId: opts?.createdByUserId,
      createdByAgentName: opts?.createdByAgentName,
      createdByOriginType: 'system',
      createdAt: now,
    };

    const identity: DocumentIdentityDoc = {
      documentId,
      sourceArtifactId: artifactId,
      versions: [version],
      latestVersionNumber: 1,
      contentType,
      createdAt: now,
      updatedAt: now,
    };

    await this.identities.insertOne(identity);
    return identity;
  }

  // ── Document Summary (D2 response) ────────────────────────────────────

  async getDocumentSummary(documentId: string): Promise<DocumentSummary> {
    const doc = await this.findIdentityByDocumentId(documentId);
    if (!doc) {
      makeError(ERROR_CODES.DOCUMENT_NOT_FOUND, `Document "${documentId}" not found`, 404);
    }

    const latestVersion = doc.versions[doc.versions.length - 1];
    const commentCounts = await this.getCommentCounts(documentId);

    return {
      documentId: doc.documentId,
      sourceArtifactId: doc.sourceArtifactId,
      latestVersionNumber: doc.latestVersionNumber,
      contentType: doc.contentType,
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
      latestContent: latestVersion.content,
      unresolvedCommentCount: commentCounts.unresolved,
      resolvedCommentCount: commentCounts.resolved,
      staleCommentCount: commentCounts.stale,
    };
  }

  // ── Version Management ────────────────────────────────────────────────

  async listVersions(documentId: string): Promise<VersionListResult> {
    const doc = await this.findIdentityByDocumentId(documentId);
    if (!doc) {
      makeError(ERROR_CODES.DOCUMENT_NOT_FOUND, `Document "${documentId}" not found`, 404);
    }

    return {
      documentId: doc.documentId,
      latestVersionNumber: doc.latestVersionNumber,
      versions: doc.versions.map((v) => ({
        versionNumber: v.versionNumber,
        contentHash: v.contentHash,
        createdByUserId: v.createdByUserId,
        createdByAgentName: v.createdByAgentName,
        createdByOriginType: v.createdByOriginType,
        addressedCommentIds: v.addressedCommentIds,
        createdReason: v.createdReason,
        createdAt: v.createdAt,
      })),
    };
  }

  async getVersion(documentId: string, versionNumber: number): Promise<VersionDetailResult> {
    const doc = await this.findIdentityByDocumentId(documentId);
    if (!doc) {
      makeError(ERROR_CODES.DOCUMENT_NOT_FOUND, `Document "${documentId}" not found`, 404);
    }

    const version = doc.versions.find((v) => v.versionNumber === versionNumber);
    if (!version) {
      makeError(
        ERROR_CODES.VERSION_NOT_FOUND,
        `Version ${versionNumber} not found`,
        404,
      );
    }

    return {
      documentId: doc.documentId,
      version,
      isLatest: versionNumber === doc.latestVersionNumber,
    };
  }

  async addVersion(
    documentId: string,
    content: string,
    opts?: {
      createdByUserId?: string;
      createdByAgentName?: string;
      addressedCommentIds?: string[];
      createdReason?: string;
    },
  ): Promise<AddVersionResult> {
    if (content == null || content === '') {
      makeError(ERROR_CODES.CONTENT_REQUIRED, '"content" is required', 400);
    }

    const doc = await this.findIdentityByDocumentId(documentId);
    if (!doc) {
      makeError(ERROR_CODES.DOCUMENT_NOT_FOUND, `Document "${documentId}" not found`, 404);
    }

    const contentHash = createHash('sha256').update(content).digest('hex');
    const latestVersion = doc.versions[doc.versions.length - 1];

    // SHA-256 dedup (409 on no-op)
    if (latestVersion.contentHash === contentHash) {
      makeError(
        ERROR_CODES.CONTENT_UNCHANGED,
        'New content is identical to current version',
        409,
      );
    }

    const now = new Date();
    const versionNumber = doc.latestVersionNumber + 1;
    const originType: VersionOriginType = opts?.createdByAgentName ? 'agent' : opts?.createdByUserId ? 'human' : 'agent';

    // Re-validate all open comment anchors (R15)
    const openComments = await this.comments
      .find({ documentId, status: { $in: ['open', 'resolved'] } })
      .toArray();

    const resolvedCommentIds = new Set<string>();
    const staleEntries: Array<{ commentId: string; staleReason: string }> = [];
    const staleCommentIds: string[] = [];
    const addressedIds = opts?.addressedCommentIds ?? [];

    for (const comment of openComments) {
      // Skip addressed comments — they'll be resolved explicitly
      if (addressedIds.includes(comment.commentId)) continue;

      if (comment.status === 'resolved') continue;

      const valid = revalidateAnchor(comment.anchor, content);
      if (!valid) {
        staleEntries.push({
          commentId: comment.commentId,
          staleReason: 'Anchor could not be re-mapped to new content',
        });
        staleCommentIds.push(comment.commentId);
      }
    }

    // Apply addressed comment resolutions
    if (addressedIds.length > 0) {
      for (const cid of addressedIds) {
        const comment = openComments.find((c) => c.commentId === cid);
        if (comment && comment.status !== 'resolved') {
          resolvedCommentIds.add(cid);
        }
      }
    }

    // Push the new version
    const newVersion: DocumentVersion = {
      versionNumber,
      content,
      contentHash,
      createdByUserId: opts?.createdByUserId,
      createdByAgentName: opts?.createdByAgentName,
      createdByOriginType: originType,
      addressedCommentIds: opts?.addressedCommentIds,
      createdReason: opts?.createdReason,
      createdAt: now,
    };

    await this.identities.updateOne(
      { documentId },
      {
        $push: { versions: newVersion },
        $set: { latestVersionNumber: versionNumber, updatedAt: now },
      },
    );

    // Resolve addressed comments
    const resolvedComments: Array<{ commentId: string; status: string }> = [];
    for (const cid of addressedIds) {
      const addressedComment = openComments.find((comment) => comment.commentId === cid);
      if (!addressedComment) continue;
      const resolution: CommentResolution = {
        resolvedByUserId: opts?.createdByUserId,
        resolvedByAgentName: opts?.createdByAgentName,
        resolvedAtVersion: versionNumber,
        resolutionNote: opts?.createdReason ?? 'Addressed in version update',
        resolvedAt: now,
      };
      await this.comments.updateMany(
        { documentId, threadId: addressedComment.threadId, status: { $ne: 'stale' } },
        {
          $set: {
            status: 'resolved',
            updatedAt: now,
          },
        },
      );
      await this.comments.updateOne(
        { documentId, commentId: cid },
        { $set: { resolution } },
      );
      resolvedComments.push({ commentId: cid, status: 'resolved' });
    }

    // Mark stale comments
    const staleResults: Array<{ commentId: string; status: string; staleReason: string }> = [];
    for (const entry of staleEntries) {
      await this.comments.updateOne(
        { commentId: entry.commentId, status: 'open' },
        {
          $set: {
            status: 'stale',
            'anchor.staleReason': entry.staleReason,
            'anchor.staleAt': now,
            updatedAt: now,
          },
        },
      );
      staleResults.push({ commentId: entry.commentId, status: 'stale', staleReason: entry.staleReason });
    }

    // Compute remaining unresolved comment IDs (open comments not addressed and not stale)
    const allComments = await this.comments
      .find({ documentId, parentCommentId: { $exists: false }, status: 'open' })
      .toArray();
    const unresolvedCommentIds = allComments.map((c) => c.commentId);

    return {
      documentId,
      versionNumber,
      contentHash,
      createdByOriginType: originType,
      createdByAgentName: opts?.createdByAgentName,
      createdByUserId: opts?.createdByUserId,
      addressedCommentIds: opts?.addressedCommentIds,
      createdReason: opts?.createdReason,
      createdAt: now,
      resolvedComments,
      staleComments: staleResults,
      unresolvedCommentIds,
    };
  }

  async restoreVersion(
    documentId: string,
    versionNumber: number,
    opts?: { createdByUserId?: string; createdByAgentName?: string },
  ): Promise<RestoreVersionResult> {
    const doc = await this.findIdentityByDocumentId(documentId);
    if (!doc) {
      makeError(ERROR_CODES.DOCUMENT_NOT_FOUND, `Document "${documentId}" not found`, 404);
    }

    const sourceVersion = doc.versions.find((v) => v.versionNumber === versionNumber);
    if (!sourceVersion) {
      makeError(
        ERROR_CODES.VERSION_NOT_FOUND,
        `Version ${versionNumber} not found`,
        404,
      );
    }

    const latestVersion = doc.versions[doc.versions.length - 1];
    const content = sourceVersion.content;
    const contentHash = createHash('sha256').update(content).digest('hex');

    // 409 if identical to current latest
    if (latestVersion.contentHash === contentHash) {
      makeError(
        ERROR_CODES.CONTENT_UNCHANGED,
        'Restored content is identical to current version',
        409,
      );
    }

    const now = new Date();
    const newVersionNumber = doc.latestVersionNumber + 1;

    const newVersion: DocumentVersion = {
      versionNumber: newVersionNumber,
      content,
      contentHash,
      createdByUserId: opts?.createdByUserId,
      createdByAgentName: opts?.createdByAgentName,
      createdByOriginType: 'system',
      createdReason: `Restored from version ${versionNumber}`,
      createdAt: now,
    };

    await this.identities.updateOne(
      { documentId },
      {
        $push: { versions: newVersion },
        $set: { latestVersionNumber: newVersionNumber, updatedAt: now },
      },
    );

    // Re-validate all open comment anchors
    const openComments = await this.comments
      .find({ documentId, status: 'open' })
      .toArray();

    const staleEntries: Array<{ commentId: string; staleReason: string }> = [];
    for (const comment of openComments) {
      const valid = revalidateAnchor(comment.anchor, content);
      if (!valid) {
        staleEntries.push({
          commentId: comment.commentId,
          staleReason: 'Anchor could not be re-mapped to restored content',
        });
      }
    }

    const staleResults: Array<{ commentId: string; status: string; staleReason: string }> = [];
    for (const entry of staleEntries) {
      await this.comments.updateOne(
        { commentId: entry.commentId, status: 'open' },
        {
          $set: {
            status: 'stale',
            'anchor.staleReason': entry.staleReason,
            'anchor.staleAt': now,
            updatedAt: now,
          },
        },
      );
      staleResults.push({ commentId: entry.commentId, status: 'stale', staleReason: entry.staleReason });
    }

    return {
      documentId,
      newVersionNumber,
      restoredFromVersion: versionNumber,
      contentHash,
      createdByOriginType: 'system',
      createdReason: `Restored from version ${versionNumber}`,
      staleComments: staleResults,
    };
  }

  async compareVersions(
    documentId: string,
    v1: number,
    v2: number,
  ): Promise<VersionCompareResult> {
    const doc = await this.findIdentityByDocumentId(documentId);
    if (!doc) {
      makeError(ERROR_CODES.DOCUMENT_NOT_FOUND, `Document "${documentId}" not found`, 404);
    }

    const version1 = doc.versions.find((v) => v.versionNumber === v1);
    if (!version1) {
      makeError(ERROR_CODES.VERSION_NOT_FOUND, `Version ${v1} not found`, 404);
    }

    const version2 = doc.versions.find((v) => v.versionNumber === v2);
    if (!version2) {
      makeError(ERROR_CODES.VERSION_NOT_FOUND, `Version ${v2} not found`, 404);
    }

    const diff = computeDiff(version1.content, version2.content);

    // Collect all addressed comment IDs from versions between v1 and v2 (inclusive v2)
    const addressedCommentIds = new Set<string>();
    for (const v of doc.versions) {
      if (v.versionNumber <= v2 && v.addressedCommentIds) {
        v.addressedCommentIds.forEach((id) => addressedCommentIds.add(id));
      }
    }

    // Compute stats
    let linesAdded = 0;
    let linesRemoved = 0;
    let linesModified = 0;
    let linesUnchanged = 0;
    for (const line of diff) {
      if (line.type === 'added') linesAdded++;
      else if (line.type === 'removed') linesRemoved++;
      else if (line.type === 'modified') linesModified++;
      else if (line.type === 'unchanged') linesUnchanged++;
    }

    return {
      documentId,
      v1: { versionNumber: v1, createdAt: version1.createdAt },
      v2: { versionNumber: v2, createdAt: version2.createdAt },
      diff,
      addressedCommentIds: [...addressedCommentIds],
      stats: { linesAdded, linesRemoved, linesModified, linesUnchanged },
    };
  }

  // ── Comment Management ────────────────────────────────────────────────

  private async getCommentCounts(documentId: string): Promise<{
    unresolved: number;
    resolved: number;
    stale: number;
  }> {
    const [unresolved, resolved, stale] = await Promise.all([
      this.comments.countDocuments({ documentId, parentCommentId: { $exists: false }, status: 'open' }),
      this.comments.countDocuments({ documentId, parentCommentId: { $exists: false }, status: 'resolved' }),
      this.comments.countDocuments({ documentId, parentCommentId: { $exists: false }, status: 'stale' }),
    ]);
    return { unresolved, resolved, stale };
  }

  async listComments(
    documentId: string,
    statusFilter?: 'open' | 'resolved' | 'stale' | 'all',
  ): Promise<DocumentCommentDoc[]> {
    const doc = await this.findIdentityByDocumentId(documentId);
    if (!doc) {
      makeError(ERROR_CODES.DOCUMENT_NOT_FOUND, `Document "${documentId}" not found`, 404);
    }

    const filter: Record<string, unknown> = { documentId };
    if (statusFilter && statusFilter !== 'all') {
      filter.status = statusFilter;
    }

    return this.comments.find(filter).sort({ createdAt: 1 }).toArray();
  }

  async addComment(
    documentId: string,
    body: string,
    anchor: CommentAnchor,
    author?: { userId?: string; agentName?: string },
  ): Promise<DocumentCommentDoc> {
    if (!body || body.trim() === '') {
      makeError(ERROR_CODES.BODY_REQUIRED, '"body" is required', 400);
    }
    if (!anchor || !anchor.type || !anchor.context) {
      makeError(ERROR_CODES.ANCHOR_REQUIRED, '"anchor" with type and context is required', 400);
    }

    const doc = await this.findIdentityByDocumentId(documentId);
    if (!doc) {
      makeError(ERROR_CODES.DOCUMENT_NOT_FOUND, `Document "${documentId}" not found`, 404);
    }

    const now = new Date();
    const commentId = randomUUID();
    const threadId = randomUUID();

    const comment: DocumentCommentDoc = {
      commentId,
      documentId,
      threadId,
      parentCommentId: undefined,
      authorType: author?.agentName ? 'agent' : 'human',
      authorUserId: author?.userId,
      authorAgentName: author?.agentName,
      body,
      status: 'open',
      anchor: {
        ...anchor,
        anchoredAtVersion: doc.latestVersionNumber,
      },
      reopenCount: 0,
      createdAt: now,
      updatedAt: now,
    };

    await this.comments.insertOne(comment);
    return comment;
  }

  async addReply(
    documentId: string,
    parentCommentId: string,
    body: string,
    author?: { userId?: string; agentName?: string },
  ): Promise<DocumentCommentDoc> {
    if (!body || body.trim() === '') {
      makeError(ERROR_CODES.BODY_REQUIRED, '"body" is required', 400);
    }

    const doc = await this.findIdentityByDocumentId(documentId);
    if (!doc) {
      makeError(ERROR_CODES.DOCUMENT_NOT_FOUND, `Document "${documentId}" not found`, 404);
    }

    // Find the parent comment to get its threadId
    const parent = await this.comments.findOne({ commentId: parentCommentId, documentId });
    if (!parent) {
      makeError(ERROR_CODES.DOCUMENT_NOT_FOUND, `Comment "${parentCommentId}" not found`, 404);
    }

    const now = new Date();
    const commentId = randomUUID();

    const reply: DocumentCommentDoc = {
      commentId,
      documentId,
      threadId: parent.threadId,
      parentCommentId,
      authorType: author?.agentName ? 'agent' : 'human',
      authorUserId: author?.userId,
      authorAgentName: author?.agentName,
      body,
      status: parent.status, // Inherit the thread's status
      anchor: parent.anchor, // Inherit anchor from parent
      reopenCount: 0,
      createdAt: now,
      updatedAt: now,
    };

    await this.comments.insertOne(reply);
    return reply;
  }

  async resolveComment(
    documentId: string,
    commentId: string,
    resolutionNote: string,
    resolver?: { userId?: string; agentName?: string },
  ): Promise<DocumentCommentDoc> {
    if (!resolutionNote || resolutionNote.trim() === '') {
      makeError(ERROR_CODES.RESOLUTION_NOTE_REQUIRED, '"resolutionNote" is required', 400);
    }

    const doc = await this.findIdentityByDocumentId(documentId);
    if (!doc) {
      makeError(ERROR_CODES.DOCUMENT_NOT_FOUND, `Document "${documentId}" not found`, 404);
    }

    const comment = await this.comments.findOne({ commentId, documentId });
    if (!comment) {
      makeError(ERROR_CODES.DOCUMENT_NOT_FOUND, `Comment "${commentId}" not found`, 404);
    }

    if (comment.status === 'resolved') {
      makeError(
        ERROR_CODES.COMMENT_ALREADY_RESOLVED,
        `Comment "${commentId}" is already resolved`,
        409,
      );
    }

    const now = new Date();
    const resolution: CommentResolution = {
      resolvedByUserId: resolver?.userId,
      resolvedByAgentName: resolver?.agentName,
      resolvedAtVersion: doc.latestVersionNumber,
      resolutionNote,
      resolvedAt: now,
    };

    // A comment status belongs to the whole thread. Keep replies synchronized
    // so filters, counts, and subsequent replies cannot observe split state.
    await this.comments.updateMany(
      { documentId, threadId: comment.threadId, status: { $ne: 'stale' } },
      {
        $set: {
          status: 'resolved',
          updatedAt: now,
        },
      },
    );

    await this.comments.updateOne(
      { documentId, commentId },
      { $set: { resolution } },
    );

    const updated = await this.comments.findOne({ commentId })!;
    return updated!;
  }

  async resolveAllComments(
    documentId: string,
    resolutionNote: string,
    resolver?: { userId?: string; agentName?: string },
  ): Promise<DocumentCommentDoc[]> {
    if (!resolutionNote || resolutionNote.trim() === '') {
      makeError(ERROR_CODES.RESOLUTION_NOTE_REQUIRED, '"resolutionNote" is required', 400);
    }

    const doc = await this.findIdentityByDocumentId(documentId);
    if (!doc) {
      makeError(ERROR_CODES.DOCUMENT_NOT_FOUND, `Document "${documentId}" not found`, 404);
    }

    const openThreads = await this.comments.find({
      documentId,
      parentCommentId: { $exists: false },
      status: 'open',
    }).toArray();

    if (openThreads.length === 0) return [];

    const now = new Date();
    const resolution: CommentResolution = {
      resolvedByUserId: resolver?.userId,
      resolvedByAgentName: resolver?.agentName,
      resolvedAtVersion: doc.latestVersionNumber,
      resolutionNote,
      resolvedAt: now,
    };
    const threadIds = openThreads.map((comment) => comment.threadId);
    const commentIds = openThreads.map((comment) => comment.commentId);

    await this.comments.updateMany(
      { documentId, threadId: { $in: threadIds }, status: 'open' },
      { $set: { status: 'resolved', updatedAt: now } },
    );
    await this.comments.updateMany(
      { documentId, commentId: { $in: commentIds } },
      { $set: { resolution } },
    );

    return this.comments.find({ documentId, commentId: { $in: commentIds } }).sort({ createdAt: 1 }).toArray();
  }

  async reopenComment(
    documentId: string,
    commentId: string,
    userId?: string,
  ): Promise<DocumentCommentDoc> {
    const comment = await this.comments.findOne({ commentId, documentId });
    if (!comment) {
      makeError(ERROR_CODES.DOCUMENT_NOT_FOUND, `Comment "${commentId}" not found`, 404);
    }

    if (comment.status === 'open') {
      makeError(
        ERROR_CODES.COMMENT_ALREADY_OPEN,
        `Comment "${commentId}" is already open`,
        409,
      );
    }

    if (comment.status === 'stale') {
      makeError(
        ERROR_CODES.COMMENT_IS_STALE,
        `Comment "${commentId}" is stale and cannot be reopened directly`,
        409,
      );
    }

    const now = new Date();

    await this.comments.updateMany(
      { documentId, threadId: comment.threadId, status: 'resolved' },
      {
        $set: {
          status: 'open',
          updatedAt: now,
          lastReopenAt: now,
        },
        $unset: { resolution: '' },
      },
    );

    await this.comments.updateOne(
      { documentId, commentId },
      { $inc: { reopenCount: 1 } },
    );

    const updated = await this.comments.findOne({ commentId })!;
    return updated!;
  }

  // ── Timeline (D13) ────────────────────────────────────────────────────

  async getTimeline(documentId: string): Promise<TimelineEvent[]> {
    const doc = await this.findIdentityByDocumentId(documentId);
    if (!doc) {
      makeError(ERROR_CODES.DOCUMENT_NOT_FOUND, `Document "${documentId}" not found`, 404);
    }

    const events: TimelineEvent[] = [];

    // Version created events
    for (const v of doc.versions) {
      events.push({
        eventType: 'version_created',
        timestamp: v.createdAt,
        data: {
          versionNumber: v.versionNumber,
          createdByOriginType: v.createdByOriginType,
          createdByAgentName: v.createdByAgentName,
          createdByUserId: v.createdByUserId,
          createdReason: v.createdReason,
          addressedCommentIds: v.addressedCommentIds,
        },
      });
    }

    // Comment created / resolved / reopened / stale events
    const allComments = await this.comments
      .find({ documentId })
      .toArray();

    for (const c of allComments) {
      // Only top-level comments get created events (replies are part of thread)
      if (!c.parentCommentId) {
        events.push({
          eventType: 'comment_created',
          timestamp: c.createdAt,
          data: {
            commentId: c.commentId,
            threadId: c.threadId,
            authorType: c.authorType,
            authorAgentName: c.authorAgentName,
            authorUserId: c.authorUserId,
            body: c.body,
            status: c.status,
            lineStart: c.anchor.lineStart,
            lineEnd: c.anchor.lineEnd,
          },
        });
      }

      if (c.resolution) {
        events.push({
          eventType: 'comment_resolved',
          timestamp: c.resolution.resolvedAt,
          data: {
            commentId: c.commentId,
            resolvedAtVersion: c.resolution.resolvedAtVersion,
            resolvedByAgentName: c.resolution.resolvedByAgentName,
            resolvedByUserId: c.resolution.resolvedByUserId,
            resolutionNote: c.resolution.resolutionNote,
            lineStart: c.anchor.lineStart,
            lineEnd: c.anchor.lineEnd,
          },
        });
      }

      if (c.lastReopenAt) {
        events.push({
          eventType: 'comment_reopened',
          timestamp: c.lastReopenAt,
          data: {
            commentId: c.commentId,
            reopenCount: c.reopenCount,
            lineStart: c.anchor.lineStart,
            lineEnd: c.anchor.lineEnd,
          },
        });
      }

      if (c.anchor.staleReason && c.anchor.staleAt) {
        events.push({
          eventType: 'comment_stale',
          timestamp: c.anchor.staleAt,
          data: {
            commentId: c.commentId,
            staleReason: c.anchor.staleReason,
            lineStart: c.anchor.lineStart,
            lineEnd: c.anchor.lineEnd,
          },
        });
      }
    }

    // Sort reverse chronological
    events.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
    return events;
  }
}
