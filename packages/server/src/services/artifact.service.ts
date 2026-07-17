/**
 * ArtifactService — hierarchical, public file storage keyed by the "root"
 * context that spawned the work (chat session, workflow run, or standalone
 * agent run).
 *
 * Physical layout (local storage):
 *   <UPLOADS_DIR>/artifacts/<rootType>/<rootId>/<filename>
 *
 * S3 layout (when S3_UPLOAD_ENABLED=true):
 *   s3://<S3_UPLOAD_BUCKET>/[prefix/]artifacts/<rootType>/<rootId>/<filename>
 *
 * Storage selection at write time:
 *   1. Try S3 when S3_UPLOAD_ENABLED=true and S3_UPLOAD_BUCKET is set.
 *   2. On S3 failure (or when S3 is disabled) fall back to local disk.
 *   3. The storageProvider / s3Key / s3Bucket fields on ArtifactDoc record
 *      where the file actually ended up.
 *
 * Read routing:
 *   - storageProvider === 's3'  → stream from S3 (s3Key + s3Bucket)
 *   - storageProvider === 'local' or missing → read from absolutePath
 *     (legacy records that pre-date S3 support always have absolutePath set)
 *
 * Metadata lives in the `artifacts` Mongo collection so the UI can list
 * files by root without stat-walking disk. Files are public via
 * `GET /api/artifacts/:artifactId/content` — the UUID acts as a signed
 * token (same pattern as the existing `/api/files/:filename` route).
 *
 * Inheritance rule — enforced by the callers that spawn agents:
 *   - A workflow-node agent and every sub-agent it spawns file under the
 *     ROOT workflow execution's id (never the per-node spawn id).
 *   - A chat-spawned agent and every sub-agent files under the chat
 *     session id.
 *   - A standalone agent run files under its own exec id.
 */
import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync, mkdirSync, unlinkSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import type { Db, Collection } from 'mongodb';
import {
  getUploadsDir,
  storeContent,
  readStoredContent,
  type StorageProvider,
} from './upload-storage.js';

export type ArtifactRootType = 'chat' | 'workflow' | 'agent';
export type ArtifactContentType = 'markdown' | 'json' | 'csv' | 'text' | 'code' | 'binary';

const COMMENTABLE_CONTENT_TYPES = new Set<ArtifactContentType>(['markdown', 'json', 'csv', 'text', 'code']);

export interface ArtifactSpawnContext {
  /** Where the save call originated. */
  originType: 'chat' | 'workflow_node' | 'spawn_agent' | 'standalone' | 'system';
  /** Immediate parent — the node or agent that actually called save. */
  parentId?: string;
  /** Workflow node name (when originType is workflow_node). */
  nodeName?: string;
  /** Agent name (when originType is spawn_agent / standalone). */
  agentName?: string;
  /** The spawned agent's own execution id (for trace drill-down even
   *  though the artifact is filed under the root). */
  agentExecutionId?: string;
}

export interface ArtifactDoc {
  artifactId: string;
  rootType: ArtifactRootType;
  rootId: string;
  spawnContext: ArtifactSpawnContext;
  filename: string;
  relativePath: string;     // under the root directory
  /** Full disk path. Set for local artifacts; empty string for S3-only artifacts. */
  absolutePath: string;
  contentType: ArtifactContentType;
  sizeBytes: number;
  /** SHA-256 digest of the original bytes stored for this artifact. */
  sha256?: string;
  description?: string;
  language?: string;        // hint for code content — e.g. "python", "sql"
  createdAt: Date;
  createdByAgent?: string;
  createdByUserId?: string;
  /**
   * Where the content is physically stored.
   * - 'local'  → read from absolutePath (default / legacy behaviour)
   * - 's3'     → read from s3Key in s3Bucket
   * - undefined → legacy record; treat as 'local' (absolutePath always set)
   */
  storageProvider?: StorageProvider;
  /** S3 object key — populated when storageProvider === 's3'. */
  s3Key?: string;
  /** S3 bucket name — populated when storageProvider === 's3'. */
  s3Bucket?: string;
}

export interface SaveArtifactInput {
  rootType: ArtifactRootType;
  rootId: string;
  filename: string;
  content: string;
  contentType?: ArtifactContentType;
  description?: string;
  language?: string;
  spawnContext?: Partial<ArtifactSpawnContext>;
  createdByAgent?: string;
  createdByUserId?: string;
  overwrite?: boolean;
}

export interface SaveArtifactResult {
  artifactId: string;
  url: string;           // public URL for viewing/downloading
  publicUrl?: string;    // absolute URL (set by MCP server layer)
  rootType: ArtifactRootType;
  rootId: string;
  filename: string;
  absolutePath: string;
  sizeBytes: number;
  sha256: string;
  overwritten: boolean;
  storageProvider: StorageProvider;
  s3Key?: string;
  s3Bucket?: string;
}

/**
 * Artifact storage base — parallel to the existing flat `uploads/` dir.
 * Separate subdirectory so hierarchical artifacts don't collide with the
 * legacy UUID-named `upload_file` artifacts.
 */
function artifactsRoot(): string {
  return join(getUploadsDir(), 'artifacts');
}

function rootDir(rootType: ArtifactRootType, rootId: string): string {
  return join(artifactsRoot(), rootType, rootId);
}

/**
 * Safe-filename guard — reject traversal attempts and absolute paths.
 * Allows forward-slash-separated subpaths (e.g. "design/plan.md") so
 * agents can organize their artifacts, but every segment must be clean.
 */
const SEGMENT_RE = /^[A-Za-z0-9._@+()\- ]+$/;

function sanitizeRelativePath(raw: string): string {
  if (!raw) throw new Error('filename is required');
  if (raw.length > 200) throw new Error('filename too long (max 200 chars)');
  // Normalise separators, strip any leading slashes
  const normalised = raw.replace(/\\/g, '/').replace(/^\/+/, '');
  const segments = normalised.split('/').filter(Boolean);
  if (segments.length === 0) throw new Error('filename is required');
  if (segments.length > 4) throw new Error('filename has too many path segments (max 4)');
  for (const seg of segments) {
    if (seg === '..' || seg === '.') throw new Error(`invalid path segment: "${seg}"`);
    if (!SEGMENT_RE.test(seg)) throw new Error(`invalid character in path segment: "${seg}"`);
  }
  return segments.join('/');
}

/** Rough content-type inference from extension when caller doesn't specify. */
function inferContentType(filename: string): ArtifactContentType {
  const ext = filename.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? '';
  switch (ext) {
    case 'md': case 'markdown':            return 'markdown';
    case 'json':                           return 'json';
    case 'csv':                            return 'csv';
    case 'txt': case 'log':                return 'text';
    case 'ts': case 'tsx': case 'js': case 'jsx':
    case 'py': case 'go': case 'rs': case 'java': case 'sql':
    case 'yaml': case 'yml': case 'sh': case 'html': case 'css':
      return 'code';
    default:                               return 'text';
  }
}

function inferLanguage(filename: string): string | undefined {
  const ext = filename.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? '';
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
    py: 'python', go: 'go', rs: 'rust', java: 'java', sql: 'sql',
    yaml: 'yaml', yml: 'yaml', sh: 'bash', html: 'html', css: 'css',
  };
  return map[ext];
}

/** Decode the MCP/API binary wire format without silently accepting corrupt base64. */
export function decodeArtifactContent(content: string, contentType: ArtifactContentType): Buffer {
  if (contentType !== 'binary') return Buffer.from(content, 'utf8');

  const normalized = content.replace(/\s/g, '');
  if (
    normalized.length % 4 !== 0
    || !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)
  ) {
    throw Object.assign(new Error('binary artifact content must be valid base64'), { statusCode: 400 });
  }
  const decoded = Buffer.from(normalized, 'base64');
  if (decoded.toString('base64') !== normalized) {
    throw Object.assign(new Error('binary artifact content must be valid base64'), { statusCode: 400 });
  }
  return decoded;
}

export class ArtifactService {
  private col: Collection<ArtifactDoc>;

  constructor(private db: Db) {
    this.col = db.collection<ArtifactDoc>('artifacts');
  }

  async ensureIndexes(): Promise<void> {
    await this.col.createIndexes([
      { key: { artifactId: 1 }, unique: true },
      { key: { rootType: 1, rootId: 1, createdAt: -1 } },
      { key: { rootId: 1 } },
      { key: { createdAt: -1 } },
    ]);
  }

  async save(input: SaveArtifactInput): Promise<SaveArtifactResult> {
    const relativePath = sanitizeRelativePath(input.filename);
    const contentType = input.contentType ?? inferContentType(relativePath);
    const language = input.language ?? inferLanguage(relativePath);
    const contentBytes = decodeArtifactContent(input.content, contentType);
    const dir = rootDir(input.rootType, input.rootId);
    const absolutePath = join(dir, relativePath);

    // Ensure the local directory exists (needed for local fallback and legacy).
    mkdirSync(dirname(absolutePath), { recursive: true });

    // Check for collision — if filename already exists for this root, we
    // overwrite only when opt-in. This prevents accidental clobbering
    // when two agents pick the same name.
    let overwritten = false;
    const existing = await this.col.findOne({
      rootType: input.rootType,
      rootId: input.rootId,
      relativePath,
    });
    if (existing) {
      if (!input.overwrite) {
        throw Object.assign(
          new Error(`Artifact "${relativePath}" already exists for this root. Pass overwrite=true to replace.`),
          { statusCode: 409 },
        );
      }
      overwritten = true;
    }

    // S3 key mirrors the local directory hierarchy so objects are easy to
    // browse in the S3 console and identify by root.
    const s3Key = `artifacts/${input.rootType}/${input.rootId}/${relativePath}`;

    const location = await storeContent({
      localPath: absolutePath,
      s3Key,
      content: contentBytes,
    });

    const sizeBytes = contentBytes.length;
    const sha256 = createHash('sha256').update(contentBytes).digest('hex');

    const artifactId = existing?.artifactId ?? randomUUID();
    const now = new Date();

    const doc: ArtifactDoc = {
      artifactId,
      rootType: input.rootType,
      rootId: input.rootId,
      spawnContext: {
        originType: input.spawnContext?.originType ?? 'system',
        parentId: input.spawnContext?.parentId,
        nodeName: input.spawnContext?.nodeName,
        agentName: input.spawnContext?.agentName,
        agentExecutionId: input.spawnContext?.agentExecutionId,
      },
      filename: relativePath.split('/').pop()!,
      relativePath,
      // absolutePath is set for local artifacts; empty string for S3-only.
      absolutePath: location.provider === 'local' ? (location.localPath ?? absolutePath) : absolutePath,
      contentType,
      sizeBytes,
      sha256,
      description: input.description,
      language,
      createdAt: existing?.createdAt ?? now,
      createdByAgent: input.createdByAgent,
      createdByUserId: input.createdByUserId,
      storageProvider: location.provider,
      s3Key: location.s3Key,
      s3Bucket: location.s3Bucket,
    };

    if (existing) {
      await this.col.updateOne(
        { artifactId },
        { $set: { ...doc, createdAt: existing.createdAt } },
      );
    } else {
      await this.col.insertOne(doc);
    }

    await this.enableCommentingByDefault(artifactId, contentType, input.content, {
      createdByUserId: input.createdByUserId,
      createdByAgentName: input.createdByAgent ?? input.spawnContext?.agentName,
    });

    return {
      artifactId,
      url: `/api/artifacts/${artifactId}/content`,
      rootType: input.rootType,
      rootId: input.rootId,
      filename: doc.filename,
      absolutePath: doc.absolutePath,
      sizeBytes,
      sha256,
      overwritten,
      storageProvider: location.provider,
      s3Key: location.s3Key,
      s3Bucket: location.s3Bucket,
    };
  }


  private async enableCommentingByDefault(
    artifactId: string,
    contentType: ArtifactContentType,
    content: string,
    opts: { createdByUserId?: string; createdByAgentName?: string },
  ): Promise<void> {
    if (!COMMENTABLE_CONTENT_TYPES.has(contentType)) return;

    try {
      const { DocumentService } = await import('./document.service.js');
      const documentService = new DocumentService(this.db);
      const existing = await documentService.findIdentityByArtifactId(artifactId);
      if (!existing) {
        await documentService.createFromArtifact(artifactId, opts);
        return;
      }

      const latestVersion = existing.versions[existing.versions.length - 1];
      if (latestVersion?.content === content) return;

      await documentService.addVersion(existing.documentId, content, {
        ...opts,
        createdReason: 'Artifact content updated',
      });
    } catch (err: unknown) {
      // Commenting/versioning should be enabled by default for text artifacts,
      // but artifact persistence itself is the primary operation.
      console.warn(
        `[artifacts] Failed to enable commenting for artifact ${artifactId}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  async get(artifactId: string): Promise<ArtifactDoc | null> {
    return this.col.findOne({ artifactId });
  }

  async readContent(artifactId: string): Promise<{ doc: ArtifactDoc; content: Buffer } | null> {
    const doc = await this.get(artifactId);
    if (!doc) return null;

    // S3-backed artifact — stream from S3.
    if (doc.storageProvider === 's3' && doc.s3Key && doc.s3Bucket) {
      const content = await readStoredContent({
        provider: 's3',
        s3Key: doc.s3Key,
        s3Bucket: doc.s3Bucket,
      });
      return { doc, content };
    }

    // Local or legacy — read from absolutePath.
    if (!doc.absolutePath || !existsSync(doc.absolutePath)) {
      // FS orphan — metadata says we have it, disk doesn't. Surface clearly.
      throw new Error(`Artifact "${artifactId}" has metadata but the file is missing on disk`);
    }
    const content = await readStoredContent({ absolutePath: doc.absolutePath });
    return { doc, content };
  }

  async list(
    filter: { rootType?: ArtifactRootType; rootId?: string; limit?: number; skip?: number } = {},
  ): Promise<ArtifactDoc[]> {
    const query: Record<string, unknown> = {};
    if (filter.rootType) query.rootType = filter.rootType;
    if (filter.rootId) query.rootId = filter.rootId;
    return this.col
      .find(query)
      .sort({ createdAt: -1 })
      .skip(filter.skip ?? 0)
      .limit(filter.limit ?? 200)
      .toArray();
  }

  async delete(artifactId: string): Promise<boolean> {
    const doc = await this.col.findOne({ artifactId });
    if (!doc) return false;
    // Best-effort local file cleanup (no-op for S3-only artifacts).
    try {
      if (doc.absolutePath && existsSync(doc.absolutePath)) unlinkSync(doc.absolutePath);
    } catch { /* best effort */ }
    await this.col.deleteOne({ artifactId });
    return true;
  }

  /** Counts by root — used to show "N artifacts" badges in the UI. */
  async countForRoot(rootType: ArtifactRootType, rootId: string): Promise<number> {
    return this.col.countDocuments({ rootType, rootId });
  }
}
