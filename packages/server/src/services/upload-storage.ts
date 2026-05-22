/**
 * upload-storage — central helper for upload directory resolution and
 * optional S3-backed file storage with automatic local fallback.
 *
 * Storage policy (in priority order):
 *  1. S3 — when S3_UPLOAD_ENABLED=true and S3_UPLOAD_BUCKET are set, new
 *     uploads are stored in S3 and the returned StorageLocation records
 *     provider='s3' + s3Key + s3Bucket.
 *  2. Local fallback — if S3 is disabled OR the S3 upload attempt throws,
 *     the file is written to the local uploads directory and provider='local'
 *     is recorded.
 *
 * Reading:
 *   readStoredContent() uses the StorageLocation metadata to route reads.
 *   Legacy records that only have an absolutePath (no storageProvider) are
 *   served from that exact absolutePath — no migration required.
 *
 * Directory resolution:
 *   getUploadsDir() → process.env.UPLOADS_DIR ?? ~/.allen/uploads
 *
 * S3 env vars:
 *   S3_UPLOAD_ENABLED        — set to "true" to activate S3 storage
 *   S3_UPLOAD_BUCKET         — bucket name (required when enabled)
 *   S3_UPLOAD_REGION         — AWS region (default: us-east-1)
 *   S3_UPLOAD_PREFIX         — optional key prefix (e.g. "allen-uploads")
 *   S3_UPLOAD_ENDPOINT       — custom endpoint for MinIO / LocalStack
 *   S3_UPLOAD_FORCE_PATH_STYLE — set to "true" for path-style S3 URLs
 */

import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';

// ── Types ─────────────────────────────────────────────────────────────────

export type StorageProvider = 'local' | 's3';

/** Metadata that describes where a single file is stored. */
export interface StorageLocation {
  provider: StorageProvider;
  /** Full absolute path on disk — set when provider === 'local'. */
  localPath?: string;
  /** S3 object key — set when provider === 's3'. */
  s3Key?: string;
  /** S3 bucket name — set when provider === 's3'. */
  s3Bucket?: string;
}

export interface S3Config {
  bucket: string;
  region: string;
  prefix: string;
  endpoint: string | undefined;
  forcePathStyle: boolean;
}

// ── Directory helpers ─────────────────────────────────────────────────────

/**
 * Returns the uploads base directory.
 *
 * Priority:
 *   1. UPLOADS_DIR environment variable (explicit operator override)
 *   2. ~/.allen/uploads (stable, user-scoped default)
 */
export function getUploadsDir(): string {
  return process.env.UPLOADS_DIR ?? join(homedir(), '.allen', 'uploads');
}

/** Creates the directory (and any parents) if it does not already exist. */
export function ensureLocalDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

// ── S3 helpers ────────────────────────────────────────────────────────────

/** Returns true when S3 upload is enabled and the minimum config is present. */
export function isS3Enabled(): boolean {
  return process.env.S3_UPLOAD_ENABLED === 'true' && !!process.env.S3_UPLOAD_BUCKET;
}

export function getS3Config(): S3Config {
  return {
    bucket: process.env.S3_UPLOAD_BUCKET ?? '',
    region: process.env.S3_UPLOAD_REGION ?? 'us-east-1',
    prefix: process.env.S3_UPLOAD_PREFIX ?? '',
    endpoint: process.env.S3_UPLOAD_ENDPOINT,
    forcePathStyle: process.env.S3_UPLOAD_FORCE_PATH_STYLE === 'true',
  };
}

/**
 * Upload content to S3.
 *
 * Throws on any error so callers can fall back gracefully.
 * Exported so it can be mocked in unit tests.
 */
export async function uploadToS3(
  key: string,
  content: Buffer,
  contentType = 'application/octet-stream',
): Promise<{ s3Key: string; s3Bucket: string }> {
  const { S3Client, PutObjectCommand } = await import('@aws-sdk/client-s3');
  const cfg = getS3Config();
  const client = new S3Client({
    region: cfg.region,
    ...(cfg.endpoint
      ? { endpoint: cfg.endpoint, forcePathStyle: cfg.forcePathStyle }
      : {}),
  });
  const fullKey = cfg.prefix ? `${cfg.prefix}/${key}` : key;
  await client.send(
    new PutObjectCommand({
      Bucket: cfg.bucket,
      Key: fullKey,
      Body: content,
      ContentType: contentType,
    }),
  );
  return { s3Key: fullKey, s3Bucket: cfg.bucket };
}

/**
 * Read an object from S3 and return it as a Buffer.
 *
 * Exported so it can be mocked in unit tests.
 */
export async function readFromS3(s3Key: string, s3Bucket: string): Promise<Buffer> {
  const { S3Client, GetObjectCommand } = await import('@aws-sdk/client-s3');
  const cfg = getS3Config();
  const client = new S3Client({
    region: cfg.region,
    ...(cfg.endpoint
      ? { endpoint: cfg.endpoint, forcePathStyle: cfg.forcePathStyle }
      : {}),
  });
  const res = await client.send(new GetObjectCommand({ Bucket: s3Bucket, Key: s3Key }));
  const body = res.Body;
  if (!body) throw new Error(`S3 object "${s3Key}" in bucket "${s3Bucket}" has no body`);
  const chunks: Uint8Array[] = [];
  for await (const chunk of body as AsyncIterable<Uint8Array>) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

// ── Core store / read API ─────────────────────────────────────────────────

export interface StoreContentOptions {
  /**
   * Absolute local path to write to when storing locally.
   * The parent directory is created automatically.
   */
  localPath: string;
  /**
   * Key to use in S3 (the configured S3_UPLOAD_PREFIX is prepended
   * automatically, so pass a logical key without the prefix).
   */
  s3Key: string;
  /** File content as a string (UTF-8) or raw Buffer. */
  content: Buffer | string;
  /** Content-Type header sent to S3 (default: application/octet-stream). */
  contentType?: string;
}

/**
 * Persists content to S3 if enabled, otherwise (or on S3 failure) to disk.
 *
 * S3 failures are logged to stderr and automatically fall back to local
 * storage so no data is ever lost — the returned StorageLocation records
 * which backend was ultimately used.
 */
export async function storeContent(opts: StoreContentOptions): Promise<StorageLocation> {
  const buf =
    typeof opts.content === 'string' ? Buffer.from(opts.content, 'utf-8') : opts.content;

  if (isS3Enabled()) {
    try {
      const { s3Key, s3Bucket } = await uploadToS3(opts.s3Key, buf, opts.contentType);
      return { provider: 's3', s3Key, s3Bucket };
    } catch (err) {
      process.stderr.write(
        `[upload-storage] S3 upload failed for key "${opts.s3Key}", falling back to local: ${(err as Error).message}\n`,
      );
    }
  }

  // Local fallback
  mkdirSync(dirname(opts.localPath), { recursive: true });
  writeFileSync(opts.localPath, buf);
  return { provider: 'local', localPath: opts.localPath };
}

/**
 * Read content from a StorageLocation (as produced by storeContent or
 * stored in artifact / uploaded_files metadata).
 *
 * Legacy records that have only `absolutePath` (no provider field) are
 * served transparently from that path — no schema migration required.
 */
export async function readStoredContent(location: {
  provider?: StorageProvider;
  localPath?: string;
  s3Key?: string;
  s3Bucket?: string;
  /** Legacy field — honoured when provider is absent or 'local'. */
  absolutePath?: string;
}): Promise<Buffer> {
  if (location.provider === 's3' && location.s3Key && location.s3Bucket) {
    return readFromS3(location.s3Key, location.s3Bucket);
  }

  // Local / legacy: prefer explicit localPath then legacy absolutePath.
  const filePath = location.localPath ?? location.absolutePath;
  if (filePath) {
    return readFileSync(filePath);
  }

  throw new Error(
    'Cannot read content: storage location has no usable path (no localPath, absolutePath, or s3 fields)',
  );
}
