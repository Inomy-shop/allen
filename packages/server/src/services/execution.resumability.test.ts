import { describe, expect, it, vi } from 'vitest';

// Mock @allen/engine before importing execution.service, since the engine package
// is a workspace dependency that may not be built in CI. computeResumability is a
// pure function with no engine runtime dependency — these stubs satisfy the imports.
vi.mock('@allen/engine', () => ({
  AllenEngine: vi.fn(),
  StateManager: vi.fn(),
  loadAgents: vi.fn(),
  getBuiltIns: vi.fn(),
}));

vi.mock('./stream.service.js', () => ({
  createSSEEmitter: vi.fn(),
}));

vi.mock('./intervention.service.js', () => ({
  InterventionService: vi.fn(),
}));

vi.mock('./workspace.service.js', () => ({
  WorkspaceManager: vi.fn(),
}));

vi.mock('./artifact.service.js', () => ({
  ArtifactService: vi.fn(),
}));

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { computeResumability } from './execution.service.js';

describe('computeResumability', () => {
  describe('failed executions', () => {
    it('is resumable when failedNode is set', () => {
      const result = computeResumability({
        status: 'failed',
        failedNode: 'my-node',
        completedNodes: [],
      });
      expect(result.resumable).toBe(true);
      expect(result.resumeBlockedReason).toBeUndefined();
    });

    it('is not resumable when failedNode is absent', () => {
      const result = computeResumability({ status: 'failed', completedNodes: [] });
      expect(result.resumable).toBe(false);
      expect(result.resumeBlockedReason).toMatch(/no failed node/i);
    });

    it('is not resumable when failedNode is null', () => {
      const result = computeResumability({ status: 'failed', failedNode: null });
      expect(result.resumable).toBe(false);
      expect(result.resumeBlockedReason).toMatch(/no failed node/i);
    });
  });

  describe('cancelled executions', () => {
    it('is resumable when completedNodes is non-empty', () => {
      const result = computeResumability({
        status: 'cancelled',
        completedNodes: ['step-1', 'step-2'],
      });
      expect(result.resumable).toBe(true);
      expect(result.resumeBlockedReason).toBeUndefined();
    });

    it('is not resumable when completedNodes is empty', () => {
      const result = computeResumability({ status: 'cancelled', completedNodes: [] });
      expect(result.resumable).toBe(false);
      expect(result.resumeBlockedReason).toMatch(/cancelled before any nodes/i);
    });

    it('is not resumable when completedNodes is absent', () => {
      const result = computeResumability({ status: 'cancelled' });
      expect(result.resumable).toBe(false);
      expect(result.resumeBlockedReason).toMatch(/cancelled before any nodes/i);
    });
  });

  describe('other statuses', () => {
    it.each(['running', 'queued', 'waiting_for_input', 'completed'])(
      'is not resumable for status: %s',
      (status) => {
        const result = computeResumability({ status });
        expect(result.resumable).toBe(false);
        expect(result.resumeBlockedReason).toContain(status);
      },
    );
  });

  describe('edge cases', () => {
    it('handles undefined status gracefully', () => {
      const result = computeResumability({});
      expect(result.resumable).toBe(false);
      expect(result.resumeBlockedReason).toContain('unknown');
    });
  });
});
