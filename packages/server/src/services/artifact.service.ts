/**
 * ArtifactService — hierarchical, public file storage keyed by the "root"
 * context that spawned the work (chat session, workflow run, or standalone
 * agent run).
 *
 * Physical layout:
 *   <UPLOADS_DIR>/artifacts/<rootType>/<rootId>/<filename>
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
import { randomUUID } from 'node:crypto';
import {
  existsSync, mkdirSync, writeFileSync, readFileSync, statSync, unlinkSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import type { Db, Collection } from 'mongodb';

export type ArtifactRootType = 'chat' | 'workflow' | 'agent';
export type ArtifactContentType = 'markdown' | 'json' | 'csv' | 'text' | 'code' | 'binary';

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
  absolutePath: string;     // full disk path
  contentType: ArtifactContentType;
  sizeBytes: number;
  description?: string;
  language?: string;        // hint for code content — e.g. "python", "sql"
  createdAt: Date;
  createdByAgent?: string;
  createdByUserId?: string;
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
  rootType: ArtifactRootType;
  rootId: string;
  filename: string;
  absolutePath: string;
  sizeBytes: number;
  overwritten: boolean;
}

function uploadsDir(): string {
  return process.env.UPLOADS_DIR ?? join(process.cwd(), '..', '..', 'uploads');
}

/**
 * Artifact storage base — parallel to the existing flat `uploads/` dir.
 * Separate subdirectory so hierarchical artifacts don't collide with the
 * legacy UUID-named `upload_file` artifacts.
 */
function artifactsRoot(): string {
  return join(uploadsDir(), 'artifacts');
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
    const dir = rootDir(input.rootType, input.rootId);
    const absolutePath = join(dir, relativePath);

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

    writeFileSync(absolutePath, input.content, 'utf8');
    const size = statSync(absolutePath).size;

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
      absolutePath,
      contentType,
      sizeBytes: size,
      description: input.description,
      language,
      createdAt: existing?.createdAt ?? now,
      createdByAgent: input.createdByAgent,
      createdByUserId: input.createdByUserId,
    };

    if (existing) {
      await this.col.updateOne(
        { artifactId },
        { $set: { ...doc, createdAt: existing.createdAt } },
      );
    } else {
      await this.col.insertOne(doc);
    }

    return {
      artifactId,
      url: `/api/artifacts/${artifactId}/content`,
      rootType: input.rootType,
      rootId: input.rootId,
      filename: doc.filename,
      absolutePath,
      sizeBytes: size,
      overwritten,
    };
  }

  async get(artifactId: string): Promise<ArtifactDoc | null> {
    return this.col.findOne({ artifactId });
  }

  async readContent(artifactId: string): Promise<{ doc: ArtifactDoc; content: Buffer } | null> {
    const doc = await this.get(artifactId);
    if (!doc) return null;
    if (!existsSync(doc.absolutePath)) {
      // FS orphan — metadata says we have it, disk doesn't. Surface clearly.
      throw new Error(`Artifact "${artifactId}" has metadata but the file is missing on disk`);
    }
    return { doc, content: readFileSync(doc.absolutePath) };
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
    try { if (existsSync(doc.absolutePath)) unlinkSync(doc.absolutePath); } catch { /* best effort */ }
    await this.col.deleteOne({ artifactId });
    return true;
  }

  /** Counts by root — used to show "N artifacts" badges in the UI. */
  async countForRoot(rootType: ArtifactRootType, rootId: string): Promise<number> {
    return this.col.countDocuments({ rootType, rootId });
  }
}
