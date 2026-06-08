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

// Mock fs and child_process so background-clone code doesn't fire in tests
vi.mock('node:fs', () => ({
  existsSync: vi.fn().mockReturnValue(false), // pretend directory does not exist
}));
vi.mock('node:child_process', () => ({
  execFile: vi.fn((_cmd: unknown, _args: unknown, _optsOrCb: unknown, _cb: unknown) => {
    const cb = typeof _optsOrCb === 'function' ? _optsOrCb : _cb;
    if (typeof cb === 'function') cb(null, '', '');
    return { on: vi.fn(), stdout: { on: vi.fn() }, stderr: { on: vi.fn() } };
  }),
}));
vi.mock('@allen/engine', () => ({
  resolveRepositoriesDir: vi.fn().mockReturnValue('/mock/allen/repositories'),
}));

import { DesignRepoService, DEFAULT_UI_DESIGNS_CLONE_URL, DEFAULT_UI_DESIGNS_HTTPS_URL, DEFAULT_UI_DESIGNS_LOCAL_PATH } from './design-repo.service.js';

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

  // ── bootstrapUiDesigns — default preview config ──────────────────────────────

  describe('bootstrapUiDesigns — default preview config', () => {
    it('attaches default preview config when bootstrapping a NEW ui-designs placeholder', async () => {
      mocks.colFindOne.mockResolvedValue(null); // no existing repo
      mocks.colInsertOne.mockResolvedValue({ insertedId: 'new-id' });

      const result = await service.bootstrapUiDesigns();

      // insertOne must include designPreviewConfig with ui-designs defaults
      expect(mocks.colInsertOne).toHaveBeenCalledWith(
        expect.objectContaining({
          designPreviewConfig: expect.objectContaining({
            enabled: true,
            startCommand: 'npm run dev',
            portMode: 'fixed',
            fixedPort: 3001,
          }),
        }),
      );
      expect(result.designPreviewConfig).toMatchObject({
        enabled: true,
        startCommand: 'npm run dev',
      });
    });

    it('attaches default preview config when bootstrapping an EXISTING repo with no config', async () => {
      const existingRepo = { _id: 'existing-id', name: 'ui-designs', roles: ['design_repo'], isDefaultDesignRepo: false };
      mocks.colFindOne.mockResolvedValue(existingRepo);

      await service.bootstrapUiDesigns();

      // updateOne must set designPreviewConfig
      expect(mocks.colUpdateOne).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({
          $set: expect.objectContaining({
            designPreviewConfig: expect.objectContaining({
              enabled: true,
              startCommand: 'npm run dev',
              portMode: 'fixed',
              fixedPort: 3001,
            }),
          }),
        }),
      );
    });

    it('preserves existing designPreviewConfig when bootstrapping an existing repo that already has one', async () => {
      const existingConfig = { enabled: true, startCommand: 'my-custom-start', portMode: 'auto', workingDirectory: 'app' };
      const existingRepo = {
        _id: 'existing-id',
        name: 'ui-designs',
        roles: ['design_repo'],
        isDefaultDesignRepo: false,
        designPreviewConfig: existingConfig,
      };
      mocks.colFindOne.mockResolvedValue(existingRepo);

      await service.bootstrapUiDesigns();

      // updateOne must NOT include designPreviewConfig in $set
      const updateCall = mocks.colUpdateOne.mock.calls[0];
      const setFields = updateCall?.[1]?.$set ?? {};
      expect(setFields).not.toHaveProperty('designPreviewConfig');
    });
  });

  // ── bootstrapUiDesigns — known default clone URL and path ────────────────────

  describe('bootstrapUiDesigns — known defaults (DEFAULT_UI_DESIGNS_CLONE_URL, DEFAULT_UI_DESIGNS_LOCAL_PATH)', () => {
    it('sets DEFAULT_UI_DESIGNS_CLONE_URL as cloneUrl in new placeholder', async () => {
      mocks.colFindOne.mockResolvedValue(null);
      mocks.colInsertOne.mockResolvedValue({ insertedId: 'new-id' });

      await service.bootstrapUiDesigns();

      const insertCall = mocks.colInsertOne.mock.calls[0];
      expect(insertCall[0].cloneUrl).toBe('git@github.com:Inomy-shop/ui-designs.git');
    });

    it('sets a non-empty path in new placeholder (uses DEFAULT_UI_DESIGNS_LOCAL_PATH)', async () => {
      mocks.colFindOne.mockResolvedValue(null);
      mocks.colInsertOne.mockResolvedValue({ insertedId: 'new-id' });

      await service.bootstrapUiDesigns();

      const insertCall = mocks.colInsertOne.mock.calls[0];
      // path must be non-empty — single-click should not leave path empty
      expect(insertCall[0].path).toBeTruthy();
      expect(typeof insertCall[0].path).toBe('string');
      expect(insertCall[0].path.length).toBeGreaterThan(0);
    });

    it('bootstrap does NOT require caller to supply clone URL (no user input needed)', async () => {
      mocks.colFindOne.mockResolvedValue(null);
      mocks.colInsertOne.mockResolvedValue({ insertedId: 'new-id' });

      // Call with no arguments — must still produce meaningful cloneUrl + path
      await service.bootstrapUiDesigns(); // no name, no path

      const insertCall = mocks.colInsertOne.mock.calls[0];
      expect(insertCall[0].cloneUrl).toMatch(/github\.com.*ui-designs/);
      expect(insertCall[0].path).toBeTruthy();
    });

    it('accepts optional localPath override and uses it as path', async () => {
      mocks.colFindOne.mockResolvedValue(null);
      mocks.colInsertOne.mockResolvedValue({ insertedId: 'new-id' });

      await service.bootstrapUiDesigns('ui-designs', '/custom/path/ui-designs');

      const insertCall = mocks.colInsertOne.mock.calls[0];
      expect(insertCall[0].path).toBe('/custom/path/ui-designs');
    });

    it('sets DEFAULT_UI_DESIGNS_CLONE_URL on existing repo that has no cloneUrl', async () => {
      const existingRepo = { _id: 'existing-id', name: 'ui-designs', roles: ['design_repo'], path: '/some/path', isDefaultDesignRepo: false };
      mocks.colFindOne.mockResolvedValue(existingRepo);

      await service.bootstrapUiDesigns();

      expect(mocks.colUpdateOne).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({
          $set: expect.objectContaining({
            cloneUrl: 'git@github.com:Inomy-shop/ui-designs.git',
          }),
        }),
      );
    });

    it('sets default path on existing repo that has empty path', async () => {
      const existingRepo = { _id: 'existing-id', name: 'ui-designs', roles: ['design_repo'], path: '', isDefaultDesignRepo: false };
      mocks.colFindOne.mockResolvedValue(existingRepo);

      await service.bootstrapUiDesigns();

      const updateCall = mocks.colUpdateOne.mock.calls[0];
      const setFields = updateCall?.[1]?.$set ?? {};
      expect(setFields.path).toBeTruthy();
      expect(setFields.path.length).toBeGreaterThan(0);
    });
  });

  // ── onboardRepo — default preview config for ui-designs ─────────────────────

  describe('onboardRepo — default preview config for ui-designs', () => {
    it('attaches default preview config for NEW repo named "ui-designs" when no previewConfig given', async () => {
      mocks.colFindOne.mockResolvedValue(null); // no existing
      mocks.colInsertOne.mockResolvedValue({ insertedId: 'new-id' });

      await service.onboardRepo({ name: 'ui-designs', path: '/my/ui-designs' });

      expect(mocks.colInsertOne).toHaveBeenCalledWith(
        expect.objectContaining({
          designPreviewConfig: expect.objectContaining({
            enabled: true,
            startCommand: 'npm run dev',
            portMode: 'fixed',
            fixedPort: 3001,
          }),
        }),
      );
    });

    it('attaches default preview config for EXISTING repo named "ui-designs" with no config', async () => {
      const existingRepo = { _id: 'repo-id', name: 'ui-designs', roles: [] };
      mocks.colFindOne.mockResolvedValue(existingRepo);

      await service.onboardRepo({ name: 'ui-designs', path: '/my/ui-designs' });

      expect(mocks.colUpdateOne).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({
          $set: expect.objectContaining({
            designPreviewConfig: expect.objectContaining({ enabled: true, startCommand: 'npm run dev' }),
          }),
        }),
      );
    });

    it('does NOT attach default preview config for a non-ui-designs repo name', async () => {
      mocks.colFindOne.mockResolvedValue(null);
      mocks.colInsertOne.mockResolvedValue({ insertedId: 'new-id' });

      await service.onboardRepo({ name: 'my-custom-repo', path: '/my/custom-repo' });

      const insertCall = mocks.colInsertOne.mock.calls[0];
      expect(insertCall[0]).not.toHaveProperty('designPreviewConfig');
    });

    it('uses the explicit previewConfig when provided, not the default', async () => {
      mocks.colFindOne.mockResolvedValue(null);
      mocks.colInsertOne.mockResolvedValue({ insertedId: 'new-id' });

      const customConfig = {
        enabled: true,
        workingDirectory: 'custom-dir',
        startCommand: 'yarn dev',
        portMode: 'auto' as const,
      };
      await service.onboardRepo({ name: 'ui-designs', path: '/my/ui-designs', previewConfig: customConfig });

      expect(mocks.colInsertOne).toHaveBeenCalledWith(
        expect.objectContaining({
          designPreviewConfig: expect.objectContaining({
            startCommand: 'yarn dev',
            workingDirectory: 'custom-dir',
          }),
        }),
      );
    });
  });

  // ── healthCheckPath default ──────────────────────────────────────────────────

  describe('UI_DESIGNS_DEFAULT_PREVIEW_CONFIG — healthCheckPath', () => {
    it('bootstrapUiDesigns placeholder has empty healthCheckPath (not "/")', async () => {
      mocks.colFindOne.mockResolvedValue(null); // no existing repo
      mocks.colInsertOne.mockResolvedValue({ insertedId: 'new-id' });

      await service.bootstrapUiDesigns();

      const insertCall = mocks.colInsertOne.mock.calls[0];
      expect(insertCall[0].designPreviewConfig.healthCheckPath).toBe('');
    });

    it('bootstrapUiDesigns new placeholder has non-empty path (DEFAULT_UI_DESIGNS_LOCAL_PATH)', async () => {
      mocks.colFindOne.mockResolvedValue(null);
      mocks.colInsertOne.mockResolvedValue({ insertedId: 'new-id' });

      await service.bootstrapUiDesigns();

      const insertCall = mocks.colInsertOne.mock.calls[0];
      expect(insertCall[0].path).toBeTruthy();
    });

    it('onboardRepo new ui-designs has empty healthCheckPath', async () => {
      mocks.colFindOne.mockResolvedValue(null);
      mocks.colInsertOne.mockResolvedValue({ insertedId: 'new-id' });

      await service.onboardRepo({ name: 'ui-designs', path: '/my/ui-designs' });

      const insertCall = mocks.colInsertOne.mock.calls[0];
      expect(insertCall[0].designPreviewConfig.healthCheckPath).toBe('');
    });
  });

  // ── onboardRepo — path update for existing placeholder ──────────────────────

  describe('onboardRepo — path update for existing placeholder', () => {
    it('updates path and promotes placeholder to registered when path provided', async () => {
      const existingRepo = { _id: 'placeholder-id', name: 'ui-designs', roles: ['design_repo'], status: 'placeholder', path: '' };
      mocks.colFindOne.mockResolvedValue(existingRepo);

      await service.onboardRepo({ name: 'ui-designs', path: '/my/real/ui-designs' });

      expect(mocks.colUpdateOne).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({
          $set: expect.objectContaining({
            path: '/my/real/ui-designs',
            status: 'registered',
          }),
        }),
      );
    });

    it('does not change status when existing repo is not a placeholder', async () => {
      const existingRepo = { _id: 'repo-id', name: 'ui-designs', roles: ['design_repo'], status: 'registered', path: '/old/path' };
      mocks.colFindOne.mockResolvedValue(existingRepo);

      await service.onboardRepo({ name: 'ui-designs', path: '/new/path' });

      const updateCall = mocks.colUpdateOne.mock.calls[0];
      const setFields = updateCall?.[1]?.$set ?? {};
      expect(setFields.path).toBe('/new/path');
      expect(setFields.status).toBeUndefined();
    });
  });

  // ── testPreviewConfig — missing repo path ────────────────────────────────────

  describe('testPreviewConfig — missing repo path', () => {
    it('returns failed when repo has no path and no workspaceId provided', async () => {
      // getPreviewConfig returns a valid config
      const validConfig = {
        enabled: true,
        workingDirectory: '.',
        startCommand: 'npm run dev',
        portMode: 'auto' as const,
        lastValidationStatus: 'unknown' as const,
      };
      // First findOne call: getPreviewConfig → repo with config
      // Second findOne call: getRepoById → repo with no path
      mocks.colFindOne
        .mockResolvedValueOnce({ designPreviewConfig: validConfig, _id: 'repo-id' }) // getPreviewConfig → findOne via getRepoById in getPreviewConfig
        .mockResolvedValueOnce({ _id: 'repo-id', path: '', name: 'ui-designs' }); // getRepoById

      const result = await service.testPreviewConfig('aabbccddeeff001122334455');

      expect(result.status).toBe('failed');
      expect(result.logs.some((l) => l.toLowerCase().includes('path not configured'))).toBe(true);
    });
  });
});

// ── backgroundCloneIfAbsent — SSH-first clone logic ──────────────────────────

describe('backgroundCloneIfAbsent — SSH-first clone logic', () => {
  it('DEFAULT_UI_DESIGNS_HTTPS_URL constant is the HTTPS form of the ui-designs repo', () => {
    expect(DEFAULT_UI_DESIGNS_HTTPS_URL).toBe('https://github.com/Inomy-shop/ui-designs.git');
  });

  it('DEFAULT_UI_DESIGNS_LOCAL_PATH uses resolveRepositoriesDir() from @allen/engine', () => {
    // The path must include the mocked resolveRepositoriesDir path
    expect(DEFAULT_UI_DESIGNS_LOCAL_PATH).toContain('/mock/allen/repositories');
    expect(DEFAULT_UI_DESIGNS_LOCAL_PATH).toContain('ui-designs');
  });

  it('DEFAULT_UI_DESIGNS_CLONE_URL is the SSH form — SSH is the primary clone URL', () => {
    expect(DEFAULT_UI_DESIGNS_CLONE_URL).toBe('git@github.com:Inomy-shop/ui-designs.git');
  });

  it('DEFAULT_UI_DESIGNS_LOCAL_PATH is non-empty and auto-computed — no user path input required', () => {
    // Path is computed automatically from resolveRepositoriesDir(); never empty
    expect(DEFAULT_UI_DESIGNS_LOCAL_PATH).toBeTruthy();
    expect(DEFAULT_UI_DESIGNS_LOCAL_PATH.length).toBeGreaterThan(0);
    expect(DEFAULT_UI_DESIGNS_LOCAL_PATH).not.toBe('');
    expect(DEFAULT_UI_DESIGNS_LOCAL_PATH).toContain('ui-designs');
  });
});
