import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import type { BuiltInFunction } from '../types.js';

const exec = promisify(execFile);

async function fileExists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

export const runBuild: BuiltInFunction = async (_config, state) => {
  const cwd = (state.worktree_path as string) ?? (state.repo_path as string) ?? process.cwd();

  // Auto-detect build system
  const detectors: Array<{ file: string; cmd: string; args: string[] }> = [
    { file: 'package.json', cmd: 'npm', args: ['run', 'build'] },
    { file: 'Cargo.toml', cmd: 'cargo', args: ['build'] },
    { file: 'Makefile', cmd: 'make', args: [] },
    { file: 'go.mod', cmd: 'go', args: ['build', './...'] },
    { file: 'pom.xml', cmd: 'mvn', args: ['compile'] },
    { file: 'build.gradle', cmd: 'gradle', args: ['build'] },
  ];

  for (const det of detectors) {
    if (await fileExists(join(cwd, det.file))) {
      try {
        await exec(det.cmd, det.args, { cwd, timeout: 120000 });
        return { build_passed: true, build_errors: '' };
      } catch (err: unknown) {
        const message = err instanceof Error ? (err as Error & { stderr?: string }).stderr ?? err.message : String(err);
        return { build_passed: false, build_errors: message };
      }
    }
  }

  return { build_passed: true, build_errors: 'No build system detected — skipped' };
};

export const runTests: BuiltInFunction = async (_config, state) => {
  const cwd = (state.worktree_path as string) ?? (state.repo_path as string) ?? process.cwd();

  const detectors: Array<{ file: string; cmd: string; args: string[] }> = [
    { file: 'package.json', cmd: 'npm', args: ['test'] },
    { file: 'Cargo.toml', cmd: 'cargo', args: ['test'] },
    { file: 'go.mod', cmd: 'go', args: ['test', './...'] },
    { file: 'Makefile', cmd: 'make', args: ['test'] },
    { file: 'pom.xml', cmd: 'mvn', args: ['test'] },
  ];

  for (const det of detectors) {
    if (await fileExists(join(cwd, det.file))) {
      try {
        const { stdout } = await exec(det.cmd, det.args, { cwd, timeout: 300000 });
        return { test_passed: true, test_output: stdout.slice(-2000) };
      } catch (err: unknown) {
        const e = err as Error & { stdout?: string; stderr?: string };
        const output = (e.stdout ?? '') + '\n' + (e.stderr ?? '');
        return { test_passed: false, test_output: output.slice(-2000) };
      }
    }
  }

  return { test_passed: true, test_output: 'No test framework detected — skipped' };
};
