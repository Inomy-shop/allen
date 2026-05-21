import { execFile } from 'node:child_process';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

interface DetectedInfo {
  language: string[];
  framework: string[];
  packageManager: string;
  defaultBranch: string;
  remoteUrl?: string;
}

interface ScanResult extends DetectedInfo {
  context: string;
}

async function runGit(repoPath: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', args, { cwd: repoPath, timeout: 5000 });
    return stdout.trim();
  } catch {
    return '';
  }
}

function readJsonFile(filePath: string): Record<string, unknown> | null {
  try {
    if (!existsSync(filePath)) return null;
    return JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

function detectLanguages(repoPath: string): string[] {
  const languages: string[] = [];

  const pkg = readJsonFile(join(repoPath, 'package.json'));
  if (pkg) {
    const deps = { ...(pkg.dependencies as Record<string, string> ?? {}), ...(pkg.devDependencies as Record<string, string> ?? {}) };
    if (deps['typescript'] || existsSync(join(repoPath, 'tsconfig.json'))) {
      languages.push('typescript');
    }
    languages.push('javascript');
  }

  if (existsSync(join(repoPath, 'Cargo.toml'))) languages.push('rust');
  if (existsSync(join(repoPath, 'go.mod'))) languages.push('go');
  if (existsSync(join(repoPath, 'requirements.txt')) || existsSync(join(repoPath, 'pyproject.toml')) || existsSync(join(repoPath, 'setup.py'))) {
    languages.push('python');
  }
  if (existsSync(join(repoPath, 'pom.xml')) || existsSync(join(repoPath, 'build.gradle'))) languages.push('java');

  return languages.length > 0 ? languages : ['unknown'];
}

function detectFrameworks(repoPath: string): string[] {
  const frameworks: string[] = [];
  const pkg = readJsonFile(join(repoPath, 'package.json'));

  if (pkg) {
    const allDeps = {
      ...(pkg.dependencies as Record<string, string> ?? {}),
      ...(pkg.devDependencies as Record<string, string> ?? {}),
    };
    const depNames = Object.keys(allDeps);

    const frameworkMap: Record<string, string> = {
      express: 'express',
      react: 'react',
      vue: 'vue',
      next: 'next',
      nuxt: 'nuxt',
      vite: 'vite',
      svelte: 'svelte',
      angular: 'angular',
      fastify: 'fastify',
      nestjs: 'nestjs',
      '@nestjs/core': 'nestjs',
      tailwindcss: 'tailwind',
      prisma: 'prisma',
      '@prisma/client': 'prisma',
    };

    for (const dep of depNames) {
      const normalized = dep.toLowerCase();
      if (frameworkMap[normalized]) {
        if (!frameworks.includes(frameworkMap[normalized])) {
          frameworks.push(frameworkMap[normalized]);
        }
      }
    }
  }

  // Python frameworks
  if (existsSync(join(repoPath, 'requirements.txt'))) {
    try {
      const content = readFileSync(join(repoPath, 'requirements.txt'), 'utf-8').toLowerCase();
      if (content.includes('fastapi')) frameworks.push('fastapi');
      if (content.includes('flask')) frameworks.push('flask');
      if (content.includes('django')) frameworks.push('django');
    } catch { /* ignore */ }
  }

  // Go frameworks
  if (existsSync(join(repoPath, 'go.mod'))) {
    try {
      const content = readFileSync(join(repoPath, 'go.mod'), 'utf-8').toLowerCase();
      if (content.includes('gin-gonic')) frameworks.push('gin');
      if (content.includes('gorilla/mux')) frameworks.push('gorilla');
    } catch { /* ignore */ }
  }

  return frameworks;
}

function detectPackageManager(repoPath: string): string {
  if (existsSync(join(repoPath, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(join(repoPath, 'yarn.lock'))) return 'yarn';
  if (existsSync(join(repoPath, 'package-lock.json'))) return 'npm';
  if (existsSync(join(repoPath, 'Cargo.lock'))) return 'cargo';
  if (existsSync(join(repoPath, 'go.sum'))) return 'go';
  if (existsSync(join(repoPath, 'requirements.txt')) || existsSync(join(repoPath, 'pyproject.toml'))) return 'pip';
  return 'unknown';
}

async function detectDefaultBranch(repoPath: string): Promise<string> {
  // Try symbolic ref first
  const symRef = await runGit(repoPath, ['symbolic-ref', 'refs/remotes/origin/HEAD']);
  if (symRef) {
    const parts = symRef.split('/');
    return parts[parts.length - 1];
  }

  // Check if common branches exist
  const branches = await runGit(repoPath, ['branch', '-a']);
  if (branches.includes('main')) return 'main';
  if (branches.includes('master')) return 'master';
  if (branches.includes('development')) return 'development';

  // Fallback to current branch
  const current = await runGit(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
  return current || 'main';
}

async function detectRemoteUrl(repoPath: string): Promise<string | undefined> {
  const url = await runGit(repoPath, ['remote', 'get-url', 'origin']);
  return url || undefined;
}

function generateContext(repoPath: string, languages: string[], frameworks: string[]): string {
  // Try README first
  const readmePaths = ['README.md', 'readme.md', 'README.rst', 'README.txt'];
  for (const readmeName of readmePaths) {
    const readmePath = join(repoPath, readmeName);
    if (existsSync(readmePath)) {
      try {
        const content = readFileSync(readmePath, 'utf-8');
        // Get first meaningful paragraph (skip headings and badges)
        const lines = content.split('\n');
        let paragraph = '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) {
            if (paragraph) break;
            continue;
          }
          // Skip headings, badges, and images
          if (trimmed.startsWith('#') || trimmed.startsWith('![') || trimmed.startsWith('[![')) continue;
          paragraph += (paragraph ? ' ' : '') + trimmed;
        }
        if (paragraph && paragraph.length > 10) {
          return paragraph.slice(0, 300);
        }
      } catch { /* ignore */ }
    }
  }

  // Generate from detected info
  const name = basename(repoPath);
  const lang = languages.filter(l => l !== 'unknown').join(', ') || 'unknown language';
  const fw = frameworks.length > 0 ? ` using ${frameworks.join(', ')}` : '';
  return `${name} - ${lang} project${fw}`;
}

export async function scanRepo(repoPath: string): Promise<ScanResult> {
  // Validate path
  if (!existsSync(repoPath) || !statSync(repoPath).isDirectory()) {
    return {
      language: ['unknown'],
      framework: [],
      packageManager: 'unknown',
      defaultBranch: 'main',
      context: `${basename(repoPath)} - project directory`,
    };
  }

  const language = detectLanguages(repoPath);
  const framework = detectFrameworks(repoPath);
  const packageManager = detectPackageManager(repoPath);
  const defaultBranch = await detectDefaultBranch(repoPath);
  const remoteUrl = await detectRemoteUrl(repoPath);
  const context = generateContext(repoPath, language, framework);

  return {
    language,
    framework,
    packageManager,
    defaultBranch,
    remoteUrl,
    context,
  };
}
