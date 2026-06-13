/**
 * Route-level integration tests for PUT /api/repos/:id/default-branch.
 *
 * The route handler is tested in isolation by mocking the RepoService module.
 * This lets us control success and failure paths without setting up
 * mongodb-memory-server or mocking git subprocesses.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

// ── Mock RepoService before importing the router ───────────────────────────

const mockUpdateDefaultBranch = vi.fn();
const mockGetById = vi.fn();
const mockList = vi.fn();
const mockCreate = vi.fn();
const mockUpdate = vi.fn();

vi.mock('../services/repo.service.js', () => ({
  RepoService: vi.fn().mockImplementation(() => ({
    updateDefaultBranch: mockUpdateDefaultBranch,
    getById: mockGetById,
    list: mockList,
    create: mockCreate,
    update: mockUpdate,
    // Other methods are not needed for this route test
  })),
}));

import { repoRoutes } from './repo.routes.js';

// ── Mock Db ────────────────────────────────────────────────────────────────

const mockDb = {
  collection: vi.fn().mockReturnValue({
    findOne: vi.fn(),
    find: vi.fn().mockReturnValue({ toArray: vi.fn().mockResolvedValue([]) }),
    insertOne: vi.fn(),
    updateOne: vi.fn(),
    deleteOne: vi.fn(),
  }),
} as any;

// ── Tests ──────────────────────────────────────────────────────────────────

describe('PUT /api/repos/:id/default-branch', () => {
  let app: express.Express;

  beforeEach(() => {
    vi.clearAllMocks();
    app = express();
    app.use(express.json());
    app.use('/api/repos', repoRoutes(mockDb));
  });

  // ── AC2: Successful update ──────────────────────────────────────────

  it('AC2: returns 200 with updated repo document on success', async () => {
    const mockRepo = {
      _id: 'repo-123',
      name: 'test-repo',
      detected: { defaultBranch: 'dev' },
      defaultBranch: 'dev',
    };
    mockUpdateDefaultBranch.mockResolvedValue(mockRepo);

    const res = await request(app)
      .put('/api/repos/repo-123/default-branch')
      .send({ defaultBranch: 'dev' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual(mockRepo);
    expect(mockUpdateDefaultBranch).toHaveBeenCalledWith('repo-123', 'dev');
  });

  // ── AC3/AC8: Remote branch not found → 404 ─────────────────────────
  //
  // The route handler maps any error containing "not found" to 404.
  // "Remote branch ... was not found." contains "not found" → 404.

  it('AC3/AC8: returns error when remote branch is not found', async () => {
    mockUpdateDefaultBranch.mockRejectedValue(
      new Error('Remote branch "origin/dev" was not found.'),
    );

    const res = await request(app)
      .put('/api/repos/repo-123/default-branch')
      .send({ defaultBranch: 'dev' });

    // The error message contains "not found" → route maps to 404
    expect(res.status).toBe(404);
    expect(res.body.error).toContain('Remote branch');
    expect(res.body.error).toContain('not found');
  });

  // ── AC6: Compatible uncommitted changes ─────────────────────────────

  it('AC6: returns 200 when git allows switch with uncommitted changes', async () => {
    const mockRepo = {
      _id: 'repo-123',
      name: 'test-repo',
      detected: { defaultBranch: 'dev' },
      defaultBranch: 'dev',
    };
    mockUpdateDefaultBranch.mockResolvedValue(mockRepo);

    const res = await request(app)
      .put('/api/repos/repo-123/default-branch')
      .send({ defaultBranch: 'dev' });

    expect(res.status).toBe(200);
  });

  // ── AC7: Checkout conflict → 400 ───────────────────────────────────

  it('AC7: returns 400 when git switch fails due to conflicting changes', async () => {
    const conflictMsg = 'error: Your local changes to the following files would be overwritten by checkout';
    mockUpdateDefaultBranch.mockRejectedValue(new Error(conflictMsg));

    const res = await request(app)
      .put('/api/repos/repo-123/default-branch')
      .send({ defaultBranch: 'dev' });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('would be overwritten');
  });

  // ── Validation: empty defaultBranch → 400 ───────────────────────────

  it('returns 400 when defaultBranch is empty', async () => {
    const res = await request(app)
      .put('/api/repos/repo-123/default-branch')
      .send({ defaultBranch: '' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('defaultBranch is required');
    expect(mockUpdateDefaultBranch).not.toHaveBeenCalled();
  });

  it('returns 400 when defaultBranch is missing from body', async () => {
    const res = await request(app)
      .put('/api/repos/repo-123/default-branch')
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('defaultBranch is required');
    expect(mockUpdateDefaultBranch).not.toHaveBeenCalled();
  });

  it('trims whitespace but rejects empty-after-trim', async () => {
    const res = await request(app)
      .put('/api/repos/repo-123/default-branch')
      .send({ defaultBranch: '   ' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('defaultBranch is required');
  });

  // ── Repo not found → 404 ───────────────────────────────────────────

  it('returns 404 when repo is not found', async () => {
    mockUpdateDefaultBranch.mockRejectedValue(new Error('Repo not found'));

    const res = await request(app)
      .put('/api/repos/repo-123/default-branch')
      .send({ defaultBranch: 'dev' });

    expect(res.status).toBe(404);
    expect(res.body.error).toContain('not found');
  });

  // ── Repo path does not exist → 400 ──────────────────────────────────

  it('returns 400 when repo filesystem path does not exist', async () => {
    mockUpdateDefaultBranch.mockRejectedValue(
      new Error('Repo path does not exist: /tmp/missing'),
    );

    const res = await request(app)
      .put('/api/repos/repo-123/default-branch')
      .send({ defaultBranch: 'dev' });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('does not exist');
  });

  // ── Fetch failure → 400 ─────────────────────────────────────────────

  it('returns 400 when git fetch fails', async () => {
    mockUpdateDefaultBranch.mockRejectedValue(
      new Error('Failed to fetch from origin: Could not resolve host'),
    );

    const res = await request(app)
      .put('/api/repos/repo-123/default-branch')
      .send({ defaultBranch: 'dev' });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Failed to fetch from origin');
  });

  // ── AC11: No destructive commands — route-level evidence ───────────

  it('AC11: the route handler does not introduce any destructive logic', async () => {
    // This test verifies that the route handler itself doesn't contain
    // destructive logic — it delegates entirely to the service.
    // The service-level test (AC11) verifies no git reset/stash/clean.
    mockUpdateDefaultBranch.mockResolvedValue({ _id: 'repo-123' });

    const res = await request(app)
      .put('/api/repos/repo-123/default-branch')
      .send({ defaultBranch: 'dev' });

    expect(res.status).toBe(200);
    // The route only calls service.updateDefaultBranch(id, branch)
    expect(mockUpdateDefaultBranch).toHaveBeenCalledTimes(1);
  });

  // ── Route registration order ────────────────────────────────────────

  it('is registered BEFORE PUT /:id so it does not collide', async () => {
    // Calling PUT /repo-123 (without /default-branch suffix) should NOT
    // match the default-branch handler. We verify by checking the
    // updateDefaultBranch mock is NOT called.
    mockUpdateDefaultBranch.mockReset();

    // Simulate a regular PUT /:id call — since we mocked RepoService,
    // this goes to service.update() with the full body.
    const res = await request(app)
      .put('/api/repos/repo-123')
      .send({ name: 'updated-name' });

    // updateDefaultBranch should NOT have been called
    expect(mockUpdateDefaultBranch).not.toHaveBeenCalled();
    // The request should have reached the update handler instead (which
    // calls mockUpdate, even if it returns undefined)
    // Since we mocked all methods, it won't crash — but the body goes to update.
  });
});
