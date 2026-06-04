/**
 * Tests for upload-storage.ts
 *
 * Covers:
 *   - getUploadsDir() default (when UPLOADS_DIR not set) → ~/.allen/uploads
 *   - getUploadsDir() with UPLOADS_DIR env override
 *   - storeContent() writes to local when S3 is disabled
 *   - storeContent() uploads to S3 when enabled and returns s3 location
 *   - storeContent() falls back to local when S3 upload fails
 *   - readStoredContent() reads from S3 when provider === 's3'
 *   - readStoredContent() reads from localPath when provider === 'local'
 *   - readStoredContent() reads from absolutePath for legacy records
 *     (no provider field)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { homedir } from 'node:os';

// ── Module-level mocks ────────────────────────────────────────────────────
// Must be hoisted before any imports from the module under test.

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(true),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    readFileSync: vi.fn().mockReturnValue(Buffer.from('file-content')),
  };
});

// Mock the AWS SDK — only imported dynamically inside uploadToS3 / readFromS3.
const mockS3Send = vi.hoisted(() => vi.fn());
vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: vi.fn().mockImplementation(() => ({ send: mockS3Send })),
  PutObjectCommand: vi.fn().mockImplementation((input: unknown) => input),
  GetObjectCommand: vi.fn().mockImplementation((input: unknown) => input),
}));

// Import the module under test AFTER mocks are established.
import {
  getUploadsDir,
  storeContent,
  readStoredContent,
  isS3Enabled,
} from './upload-storage.js';

// ── Helpers ───────────────────────────────────────────────────────────────

const originalUploadsDir = process.env.UPLOADS_DIR;
const originalS3Enabled  = process.env.S3_UPLOAD_ENABLED;
const originalS3Bucket   = process.env.S3_UPLOAD_BUCKET;

function resetEnv(): void {
  if (originalUploadsDir === undefined) delete process.env.UPLOADS_DIR;
  else process.env.UPLOADS_DIR = originalUploadsDir;
  if (originalS3Enabled === undefined) delete process.env.S3_UPLOAD_ENABLED;
  else process.env.S3_UPLOAD_ENABLED = originalS3Enabled;
  if (originalS3Bucket === undefined) delete process.env.S3_UPLOAD_BUCKET;
  else process.env.S3_UPLOAD_BUCKET = originalS3Bucket;
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('getUploadsDir()', () => {
  beforeEach(() => {
    delete process.env.UPLOADS_DIR;
  });
  afterEach(resetEnv);

  it('returns ~/.allen/uploads when UPLOADS_DIR is not set', () => {
    const expected = join(homedir(), '.allen', 'uploads');
    expect(getUploadsDir()).toBe(expected);
  });

  it('returns the UPLOADS_DIR env value when set', () => {
    process.env.UPLOADS_DIR = '/custom/uploads';
    expect(getUploadsDir()).toBe('/custom/uploads');
  });
});

describe('isS3Enabled()', () => {
  afterEach(resetEnv);

  it('returns false when S3_UPLOAD_ENABLED is not set', () => {
    delete process.env.S3_UPLOAD_ENABLED;
    delete process.env.S3_UPLOAD_BUCKET;
    expect(isS3Enabled()).toBe(false);
  });

  it('returns false when S3_UPLOAD_ENABLED=true but bucket is missing', () => {
    process.env.S3_UPLOAD_ENABLED = 'true';
    delete process.env.S3_UPLOAD_BUCKET;
    expect(isS3Enabled()).toBe(false);
  });

  it('returns true when both S3_UPLOAD_ENABLED=true and S3_UPLOAD_BUCKET are set', () => {
    process.env.S3_UPLOAD_ENABLED = 'true';
    process.env.S3_UPLOAD_BUCKET = 'my-bucket';
    expect(isS3Enabled()).toBe(true);
  });
});

describe('storeContent() — local mode (S3 disabled)', () => {
  beforeEach(() => {
    delete process.env.S3_UPLOAD_ENABLED;
    delete process.env.S3_UPLOAD_BUCKET;
    mockS3Send.mockReset();
    vi.mocked(require('node:fs').writeFileSync).mockReset?.();
  });
  afterEach(resetEnv);

  it('writes content to localPath and returns provider=local', async () => {
    const { writeFileSync } = await import('node:fs');
    const result = await storeContent({
      localPath: '/tmp/test/file.txt',
      s3Key: 'files/file.txt',
      content: 'hello world',
    });

    expect(result.provider).toBe('local');
    expect(result.localPath).toBe('/tmp/test/file.txt');
    expect(result.s3Key).toBeUndefined();
    expect(result.s3Bucket).toBeUndefined();
    expect(writeFileSync).toHaveBeenCalledWith('/tmp/test/file.txt', expect.any(Buffer));
  });

  it('does not call S3 when S3 is disabled', async () => {
    await storeContent({
      localPath: '/tmp/file.txt',
      s3Key: 'files/file.txt',
      content: 'data',
    });
    expect(mockS3Send).not.toHaveBeenCalled();
  });
});

describe('storeContent() — S3 mode', () => {
  beforeEach(() => {
    process.env.S3_UPLOAD_ENABLED = 'true';
    process.env.S3_UPLOAD_BUCKET = 'test-bucket';
    mockS3Send.mockReset();
  });
  afterEach(resetEnv);

  it('uploads to S3 and returns provider=s3 with key/bucket', async () => {
    mockS3Send.mockResolvedValueOnce({}); // PutObjectCommand success

    const result = await storeContent({
      localPath: '/tmp/file.md',
      s3Key: 'artifacts/chat/root/plan.md',
      content: '# Plan',
    });

    expect(result.provider).toBe('s3');
    expect(result.s3Bucket).toBe('test-bucket');
    // Key includes the s3Key we passed (prefix is empty by default)
    expect(result.s3Key).toBe('artifacts/chat/root/plan.md');
    expect(mockS3Send).toHaveBeenCalledTimes(1);
  });

  it('falls back to local when S3 upload throws an error', async () => {
    mockS3Send.mockRejectedValueOnce(new Error('S3 network error'));
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const result = await storeContent({
      localPath: '/tmp/fallback.md',
      s3Key: 'artifacts/chat/root/fallback.md',
      content: 'fallback content',
    });

    expect(result.provider).toBe('local');
    expect(result.localPath).toBe('/tmp/fallback.md');
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('S3 upload failed'));

    stderrSpy.mockRestore();
  });

  it('prepends S3_UPLOAD_PREFIX when set', async () => {
    process.env.S3_UPLOAD_PREFIX = 'allen-prod';
    mockS3Send.mockResolvedValueOnce({});

    const result = await storeContent({
      localPath: '/tmp/file.txt',
      s3Key: 'files/test.txt',
      content: 'data',
    });

    expect(result.s3Key).toBe('allen-prod/files/test.txt');
    delete process.env.S3_UPLOAD_PREFIX;
  });
});

describe('readStoredContent()', () => {
  beforeEach(() => {
    mockS3Send.mockReset();
  });
  afterEach(resetEnv);

  it('reads from localPath when provider=local', async () => {
    const { readFileSync } = await import('node:fs');
    vi.mocked(readFileSync).mockReturnValue(Buffer.from('local data') as unknown as string);

    const result = await readStoredContent({
      provider: 'local',
      localPath: '/some/local/file.txt',
    });

    expect(result.toString()).toBe('local data');
    expect(readFileSync).toHaveBeenCalledWith('/some/local/file.txt');
  });

  it('reads from absolutePath for legacy records (no provider)', async () => {
    const { readFileSync } = await import('node:fs');
    vi.mocked(readFileSync).mockReturnValue(Buffer.from('legacy data') as unknown as string);

    const result = await readStoredContent({
      absolutePath: '/legacy/absolute/path.md',
    });

    expect(result.toString()).toBe('legacy data');
    expect(readFileSync).toHaveBeenCalledWith('/legacy/absolute/path.md');
  });

  it('reads from S3 when provider=s3', async () => {
    const s3Content = Buffer.from('s3 object content');
    // Mock the async iterable that GetObjectCommand returns in res.Body
    mockS3Send.mockResolvedValueOnce({
      Body: (async function* () { yield s3Content; })(),
    });

    const result = await readStoredContent({
      provider: 's3',
      s3Key: 'artifacts/chat/abc/plan.md',
      s3Bucket: 'test-bucket',
    });

    expect(result).toEqual(s3Content);
    expect(mockS3Send).toHaveBeenCalledTimes(1);
  });

  it('throws when no usable path or s3 fields are provided', async () => {
    await expect(readStoredContent({})).rejects.toThrow(
      'Cannot read content: storage location has no usable path',
    );
  });
});
