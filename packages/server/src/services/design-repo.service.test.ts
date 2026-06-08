/**
 * Unit tests for DesignRepoService (AC-018)
 *
 * Covers: listDesignRepos, getDefault, setDefault,
 *         savePreviewConfig (validation + persistence)
 * Uses a mock db — no express, no supertest, no mongodb value imports.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock mongodb so `await import('mongodb')` inside the service resolves cleanly.
// vi.mock calls are hoisted by vitest before any imports, so this always runs first.
vi.mock('mongodb', () => {
  class ObjectId {
    private _hex: string;
    constructor(id?: string) {
      this._hex = id ?? '000000000000000000000000';
    }
    toString() {
      return this._hex;
    }
  }
  return { ObjectId };
});

import { DesignRepoService } from './design-repo.service.js';

// ── Mock factory ──────────────────────────────────────────────────────────────

function makeMockDb() {
  const colFindOne = vi.fn().mockResolvedValue(null);
  const colInsertOne = vi.fn();
  const colUpdateOne = vi.fn().mockResolvedValue({ modifiedCount: 1 });
  const colUpdateMany = vi.fn().mockResolvedValue({ modifiedCount: 0 });
  const colToArray = vi.fn().mockResolvedValue([]);

  const reposMock = {
    findOne: colFindOne,
    insertOne: colInsertOne,
    updateOne: colUpdateOne,
    updateMany: colUpdateMany,
    find: vi.fn(() => ({
      sort: vi.fn().mockReturnThis(),
      toArray: colToArray,
    })),
  };

  const db = {
    collection: vi.fn(() => reposMock),
  } as any;

  return {
    db,
    colFindOne,
    colInsertOne,
    colUpdateOne,
    colUpdateMany,
    colToArray,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('DesignRepoService', () => {
  let mocks: ReturnType<typeof makeMockDb>;
  let service: DesignRepoService;

  beforeEach(() => {
    mocks = makeMockDb();
    service = new DesignRepoService(mocks.db);
  });

  // ── listDesignRepos ─────────────────────────────────────────────────────────

  describe('listDesignRepos', () => {
    it('returns repos that have the design_repo role', async () => {
      const repos = [
        { name: 'ui-designs', roles: ['design_repo'], isDefaultDesignRepo: true },
        { name: 'other-designs', roles: ['design_repo', 'source_repo'] },
      ];
      mocks.colToArray.mockResolvedValue(repos);

      const result = await service.listDesignRepos();

      expect(result).toHaveLength(2);
      expect(result[0].roles).toContain('design_repo');
      expect(result[1].roles).toContain('design_repo');
    });

    it('returns empty array when no design repos exist', async () => {
      mocks.colToArray.mockResolvedValue([]);

      const result = await service.listDesignRepos();

      expect(result).toEqual([]);
    });

    it('returns repos with isDefaultDesignRepo=true', async () => {
      const repos = [{ name: 'main-designs', isDefaultDesignRepo: true, roles: ['design_repo'] }];
      mocks.colToArray.mockResolvedValue(repos);

      const result = await service.listDesignRepos();

      expect(result).toHaveLength(1);
      expect(result[0].isDefaultDesignRepo).toBe(true);
    });
  });

  // ── getDefault ──────────────────────────────────────────────────────────────

  describe('getDefault', () => {
    it('returns the repo marked as default design repo', async () => {
      const repo = { name: 'ui-designs', isDefaultDesignRepo: true, roles: ['design_repo'] };
      mocks.colFindOne.mockResolvedValue(repo);

      const result = await service.getDefault();

      expect(result).not.toBeNull();
      expect(result.isDefaultDesignRepo).toBe(true);
      expect(result.name).toBe('ui-designs');
    });

    it('returns null when no default design repo is set', async () => {
      mocks.colFindOne.mockResolvedValue(null);

      const result = await service.getDefault();

      expect(result).toBeNull();
    });
  });

  // ── setDefault ──────────────────────────────────────────────────────────────

  describe('setDefault', () => {
    it('clears existing defaults before setting the new one', async () => {
      const updatedRepo = { name: 'ui-designs', isDefaultDesignRepo: true };
      mocks.colFindOne.mockResolvedValue(updatedRepo);

      await service.setDefault('aabbccddeeff001122334455');

      expect(mocks.colUpdateMany).toHaveBeenCalledWith(
        { isDefaultDesignRepo: true },
        expect.objectContaining({
          $set: expect.objectContaining({ isDefaultDesignRepo: false }),
        }),
      );
    });

    it('sets isDefaultDesignRepo=true on the target repo', async () => {
      const updatedRepo = { name: 'ui-designs', isDefaultDesignRepo: true };
      mocks.colFindOne.mockResolvedValue(updatedRepo);

      await service.setDefault('aabbccddeeff001122334455');

      expect(mocks.colUpdateOne).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({
          $set: expect.objectContaining({ isDefaultDesignRepo: true }),
        }),
      );
    });

    it('returns the updated repo after setting as default', async () => {
      const updatedRepo = { name: 'ui-designs', isDefaultDesignRepo: true };
      mocks.colFindOne.mockResolvedValue(updatedRepo);

      const result = await service.setDefault('aabbccddeeff001122334455');

      expect(result).not.toBeNull();
      expect(result.isDefaultDesignRepo).toBe(true);
    });
  });

  // ── savePreviewConfig — validation (validatePreviewConfig behaviour) ─────────

  describe('savePreviewConfig — validation', () => {
    it('throws for invalid config with no startCommand', async () => {
      const invalidConfig = {
        enabled: true,
        workingDirectory: 'app',
        startCommand: '',  // empty — violates DESIGN_PREVIEW_START_COMMAND_REQUIRED
        portMode: 'auto' as const,
      };

      await expect(service.savePreviewConfig('repo-id', invalidConfig)).rejects.toThrow();
    });

    it('throws error with code DESIGN_PREVIEW_START_COMMAND_REQUIRED', async () => {
      const invalidConfig = {
        enabled: true,
        workingDirectory: 'app',
        startCommand: '',
        portMode: 'auto' as const,
      };

      try {
        await service.savePreviewConfig('repo-id', invalidConfig);
        expect.unreachable('should have thrown');
      } catch (err: any) {
        expect(err.code).toBe('DESIGN_PREVIEW_START_COMMAND_REQUIRED');
      }
    });

    it('throws with code DESIGN_PREVIEW_WORKDIR_ABSOLUTE for absolute workingDirectory', async () => {
      const invalidConfig = {
        enabled: true,
        workingDirectory: '/absolute/path',
        startCommand: 'npm start',
        portMode: 'auto' as const,
      };

      try {
        await service.savePreviewConfig('repo-id', invalidConfig);
        expect.unreachable('should have thrown');
      } catch (err: any) {
        expect(err.code).toBe('DESIGN_PREVIEW_WORKDIR_ABSOLUTE');
      }
    });

    it('throws with code DESIGN_PREVIEW_FIXED_PORT_REQUIRED when portMode=fixed and no fixedPort', async () => {
      const invalidConfig = {
        enabled: true,
        workingDirectory: 'app',
        startCommand: 'npm start',
        portMode: 'fixed' as const,
        // fixedPort intentionally omitted
      };

      try {
        await service.savePreviewConfig('repo-id', invalidConfig);
        expect.unreachable('should have thrown');
      } catch (err: any) {
        expect(err.code).toBe('DESIGN_PREVIEW_FIXED_PORT_REQUIRED');
      }
    });
  });

  // ── savePreviewConfig — persistence (updatePreviewConfig behaviour) ──────────

  describe('savePreviewConfig — persistence', () => {
    it('saves valid config with lastValidationStatus=unknown', async () => {
      const validConfig = {
        enabled: true,
        workingDirectory: 'app',
        startCommand: 'npm start',
        portMode: 'auto' as const,
      };

      const result = await service.savePreviewConfig('aabbccddeeff001122334455', validConfig);

      expect(result.lastValidationStatus).toBe('unknown');
    });

    it('calls updateOne on the repos collection to persist config', async () => {
      const validConfig = {
        enabled: true,
        workingDirectory: 'app',
        startCommand: 'npm run dev',
        portMode: 'auto' as const,
      };

      await service.savePreviewConfig('aabbccddeeff001122334455', validConfig);

      expect(mocks.colUpdateOne).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({
          $set: expect.objectContaining({
            designPreviewConfig: expect.objectContaining({
              lastValidationStatus: 'unknown',
              startCommand: 'npm run dev',
            }),
          }),
        }),
      );
    });

    it('strips lastValidatedAt and lastValidationError before saving', async () => {
      const validConfig = {
        enabled: true,
        workingDirectory: 'app',
        startCommand: 'npm start',
        portMode: 'auto' as const,
        lastValidatedAt: new Date('2024-01-01'),
        lastValidationError: 'old error',
      };

      const result = await service.savePreviewConfig('aabbccddeeff001122334455', validConfig);

      expect(result.lastValidatedAt).toBeUndefined();
      expect(result.lastValidationError).toBeUndefined();
    });
  });
});
