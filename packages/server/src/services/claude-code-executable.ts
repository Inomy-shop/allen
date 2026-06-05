import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

function packagedClaudeCodeExecutable(): string | undefined {
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  if (!resourcesPath) return undefined;

  const candidate = resolve(
    resourcesPath,
    'app.asar.unpacked',
    'node_modules',
    '@anthropic-ai',
    'claude-code',
    'cli.js',
  );
  return existsSync(candidate) ? candidate : undefined;
}

function detectedClaudeCodeExecutable(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const override = env.CLAUDE_BIN?.trim();
  if (override) return override;

  const result = spawnSync('which', ['-a', 'claude'], { encoding: 'utf8', env });
  return (result.stdout ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .find((candidate) => !candidate.includes('/node_modules/.bin/'));
}

export function resolveClaudeCodeExecutable(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return detectedClaudeCodeExecutable(env) ?? packagedClaudeCodeExecutable();
}
