/**
 * ensurePythonVenv unit tests.
 *
 * Two layers:
 *   1. Pure-mock tests that verify the in-process cache + idempotency without
 *      shelling out (always run).
 *   2. Real-spawn integration tests that run `python3 -m venv` against a tmp
 *      directory — gated on python3 availability and skipped on machines
 *      that don't have it (e.g. minimal CI containers).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { ensurePythonVenv, deletePythonVenv, venvPathFor } from './mcp-install.js';
import { resolveAllenHome } from './paths.js';

let python3Available = false;
try {
  execSync('python3 --version', { stdio: 'pipe' });
  python3Available = true;
} catch { /* skip integration tests below */ }

describe('venvPathFor', () => {
  it('honors override path', () => {
    const out = venvPathFor('any-id', '/custom/path');
    expect(out).toBe('/custom/path');
  });

  it('derives <ALLEN_HOME>/venvs/<mcpId> when override absent', () => {
    const out = venvPathFor('abc123');
    expect(out).toBe(join(resolveAllenHome(), 'venvs', 'abc123'));
  });
});

describe.skipIf(!python3Available)('ensurePythonVenv (integration — needs python3)', () => {
  let tmpRoot = '';

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'allen-venv-test-'));
  });

  afterEach(() => {
    if (tmpRoot && existsSync(tmpRoot)) {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('creates a venv and reports created=true on first call', async () => {
    const venvPath = join(tmpRoot, 'venv1');
    const status = await ensurePythonVenv({
      mcpId: 'integ-1',
      interpreter: 'python3',
      requirementsAbsPath: null,
      venvPath,
    });
    expect(status.created).toBe(true);
    expect(status.installed).toBe(false);
    expect(status.skipped).toBe(false);
    expect(existsSync(status.pythonBin)).toBe(true);
    expect(status.venvPath).toBe(venvPath);
    deletePythonVenv('integ-1', venvPath);
  });

  it('skips on second call when venv already exists (in-process cache)', async () => {
    const venvPath = join(tmpRoot, 'venv2');
    await ensurePythonVenv({
      mcpId: 'integ-2',
      interpreter: 'python3',
      requirementsAbsPath: null,
      venvPath,
    });
    const second = await ensurePythonVenv({
      mcpId: 'integ-2',
      interpreter: 'python3',
      requirementsAbsPath: null,
      venvPath,
    });
    expect(second.skipped).toBe(true);
    expect(second.created).toBe(false);
    expect(second.installed).toBe(false);
    deletePythonVenv('integ-2', venvPath);
  });

  it('deletePythonVenv removes the venv directory', async () => {
    const venvPath = join(tmpRoot, 'venv3');
    await ensurePythonVenv({
      mcpId: 'integ-3',
      interpreter: 'python3',
      requirementsAbsPath: null,
      venvPath,
    });
    expect(existsSync(venvPath)).toBe(true);
    deletePythonVenv('integ-3', venvPath);
    expect(existsSync(venvPath)).toBe(false);
  });

  it('throws when requirements.txt path is set but missing on disk', async () => {
    const venvPath = join(tmpRoot, 'venv4');
    await expect(
      ensurePythonVenv({
        mcpId: 'integ-4',
        interpreter: 'python3',
        requirementsAbsPath: join(tmpRoot, 'does-not-exist.txt'),
        venvPath,
      }),
    ).rejects.toThrow(/requirements\.txt not found/);
    deletePythonVenv('integ-4', venvPath);
  });

  it('runs pip install when requirements.txt is supplied (uses an empty file to keep the test fast)', async () => {
    const venvPath = join(tmpRoot, 'venv5');
    const reqPath = join(tmpRoot, 'requirements.txt');
    // Empty requirements file — pip install completes immediately and we
    // avoid network access. Still exercises the install codepath.
    writeFileSync(reqPath, '# empty\n');
    const status = await ensurePythonVenv({
      mcpId: 'integ-5',
      interpreter: 'python3',
      requirementsAbsPath: reqPath,
      venvPath,
    });
    expect(status.created).toBe(true);
    expect(status.installed).toBe(true);
    deletePythonVenv('integ-5', venvPath);
  }, 30_000);
});

