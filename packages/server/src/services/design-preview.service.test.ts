import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmdirSync, mkdirSync } from 'node:fs';
import { tmpdir, platform } from 'node:os';
import { join } from 'node:path';
import { DesignPreviewService } from './design-preview.service.js';

describe('DesignPreviewService.validateConfig', () => {
  const service = new DesignPreviewService();
  const baseConfig = {
    enabled: true,
    workingDirectory: 'app',
    startCommand: 'npm start',
    portMode: 'auto' as const,
  };

  it('valid config passes', () => {
    expect(service.validateConfig(baseConfig).ok).toBe(true);
  });

  it('enabled with no startCommand is invalid', () => {
    const r = service.validateConfig({ ...baseConfig, startCommand: '' });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('DESIGN_PREVIEW_START_COMMAND_REQUIRED');
  });

  it('absolute workingDirectory is invalid', () => {
    const r = service.validateConfig({ ...baseConfig, workingDirectory: '/absolute/path' });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('DESIGN_PREVIEW_WORKDIR_ABSOLUTE');
  });

  it('workingDirectory with .. is invalid', () => {
    const r = service.validateConfig({ ...baseConfig, workingDirectory: '../escape' });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('DESIGN_PREVIEW_WORKDIR_INVALID');
  });

  it('fixed portMode without fixedPort is invalid', () => {
    const r = service.validateConfig({ ...baseConfig, portMode: 'fixed' as const });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('DESIGN_PREVIEW_FIXED_PORT_REQUIRED');
  });

  it('auto portMode is valid', () => {
    const r = service.validateConfig({ ...baseConfig, portMode: 'auto' });
    expect(r.ok).toBe(true);
  });
});

describe('DesignPreviewService.toWorkspaceConfig', () => {
  const service = new DesignPreviewService();

  it('translates Next/Vite config correctly', () => {
    const config = {
      enabled: true,
      workingDirectory: 'app',
      installCommand: 'npm ci',
      buildCommand: 'npm run build',
      startCommand: 'npm run dev',
      portMode: 'auto' as const,
    };
    const ws = service.toWorkspaceConfig(config);
    expect(ws.setupScript).toEqual(['npm ci', 'npm run build']);
    expect(ws.services[0].name).toBe('preview');
    expect(ws.services[0].portOffset).toBe(0);
    expect(ws.autoStart).toBe(false);
  });

  it('build command omitted works', () => {
    const config = {
      enabled: true,
      workingDirectory: 'app',
      startCommand: 'npm start',
      portMode: 'auto' as const,
    };
    const ws = service.toWorkspaceConfig(config);
    expect(ws.setupScript).toEqual([]);
  });

  it('{port} token converts to {port:0}', () => {
    const config = {
      enabled: true,
      workingDirectory: 'app',
      startCommand: 'next dev --port {port}',
      portMode: 'auto' as const,
    };
    const ws = service.toWorkspaceConfig(config);
    expect(ws.services[0].command).toContain('{port:0}');
  });
});

describe('DesignPreviewService.testConfig — SF-002 safety (REQ-033, REQ-034)', () => {
  const service = new DesignPreviewService();
  const validConfig = {
    enabled: true,
    workingDirectory: 'subdir',
    startCommand: 'npm run dev',
    portMode: 'auto' as const,
  };

  it('returns failed when config validation fails (e.g. missing startCommand)', async () => {
    const result = await service.testConfig(
      { ...validConfig, startCommand: '' },
      '/some/worktree',
    );
    expect(result.status).toBe('failed');
    expect(result.logs.some((l) => l.includes('validation failed'))).toBe(true);
  });

  it('returns failed when workingDirectory does not exist in worktree', async () => {
    const result = await service.testConfig(
      validConfig,
      '/nonexistent-worktree-path-xyz',
    );
    expect(result.status).toBe('failed');
    expect(result.logs.some((l) => l.includes('Working directory not found'))).toBe(true);
  });

  it('returns passed when workingDirectory exists in worktree (uses existsSync, not shell)', async () => {
    // Create a real temp directory to test the happy path
    const tmpRoot = mkdtempSync(join(tmpdir(), 'design-preview-test-'));
    const subDir = join(tmpRoot, 'subdir');
    mkdirSync(subDir);
    try {
      const result = await service.testConfig(validConfig, tmpRoot);
      expect(result.status).toBe('passed');
      expect(result.logs.some((l) => l.includes('Working directory exists'))).toBe(true);
    } finally {
      rmdirSync(subDir);
      rmdirSync(tmpRoot);
    }
  });

  it('does NOT execute shell commands — workingDirectory with shell metacharacters is safe', async () => {
    // A malicious workingDirectory that would execute commands if execSync were used.
    // With existsSync this is just a path lookup that returns false (dir doesn't exist).
    const maliciousConfig = {
      ...validConfig,
      workingDirectory: 'app$(echo INJECTED)',
    };
    // validateConfig passes (relative, no '..') — the safety is in testConfig using existsSync
    const validationResult = service.validateConfig(maliciousConfig);
    expect(validationResult.ok).toBe(true); // config is "valid" syntactically

    // But testConfig should safely fail with "not found", not execute the subshell
    const result = await service.testConfig(maliciousConfig, '/tmp');
    expect(result.status).toBe('failed');
    expect(result.logs.some((l) => l.includes('Working directory not found'))).toBe(true);
  });
});
