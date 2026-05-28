import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { MongoClient, type Db } from 'mongodb';
import { getRequiredProviders } from './llm-defaults.js';

const exec = promisify(execFile);

export type HealthCheckStatus = 'pass' | 'warn' | 'fail';

export type HealthCheckId =
  | 'node'
  | 'npm'
  | 'mongodb'
  | 'git'
  | 'claude_cli'
  | 'claude_auth'
  | 'codex_cli'
  | 'codex_auth';

export interface SystemHealthCheck {
  id: HealthCheckId;
  label: string;
  required: boolean;
  status: HealthCheckStatus;
  version?: string;
  detail: string;
  fix?: {
    summary: string;
    commands?: string[];
    docsPath?: string;
  };
}

export interface SystemHealthSummary {
  status: HealthCheckStatus;
  generatedAt: string;
  requiredPassed: boolean;
  checks: SystemHealthCheck[];
}

interface CommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  errorCode?: string;
}

const COMMAND_TIMEOUT_MS = 5000;

function firstLine(value: string): string | undefined {
  const line = value.split('\n').map(part => part.trim()).find(Boolean);
  return line ? line.slice(0, 120) : undefined;
}

async function runCommand(command: string, args: string[], timeout = COMMAND_TIMEOUT_MS): Promise<CommandResult> {
  try {
    const result = await exec(command, args, {
      timeout,
      env: {
        ...process.env,
        CI: process.env.CI ?? '1',
        NO_COLOR: '1',
      },
    });
    return {
      ok: true,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  } catch (err) {
    const error = err as Error & {
      code?: string | number;
      stdout?: string;
      stderr?: string;
      killed?: boolean;
      signal?: string;
    };
    return {
      ok: false,
      stdout: typeof error.stdout === 'string' ? error.stdout : '',
      stderr: typeof error.stderr === 'string' ? error.stderr : '',
      errorCode: error.killed || error.signal === 'SIGTERM' ? 'timeout' : String(error.code ?? 'failed'),
    };
  }
}

async function resolveExecutable(command: string, options?: {
  envVar?: string;
  skipNodeModulesBin?: boolean;
}): Promise<string | null> {
  const override = options?.envVar ? process.env[options.envVar]?.trim() : undefined;
  if (override) return override;

  const result = await runCommand('which', ['-a', command], 2000);
  if (!result.ok) return null;

  const candidates = result.stdout
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .filter(candidate => !options?.skipNodeModulesBin || !candidate.includes('/node_modules/.bin/'));

  return candidates[0] ?? null;
}

async function checkNode(): Promise<SystemHealthCheck> {
  let version = process.version;
  let detailRuntime = 'Node runtime';

  if (process.env.ALLEN_DESKTOP === '1') {
    const executable = await resolveExecutable('node', { skipNodeModulesBin: true });
    if (!executable) {
      return {
        id: 'node',
        label: 'Node.js',
        required: true,
        status: 'fail',
        version: process.version,
        detail: `Allen Desktop is running inside Electron's embedded Node ${process.version}, but workflows need a Node.js 22+ command on PATH.`,
        fix: {
          summary: 'Install Node.js 22 or newer, then restart Allen Desktop from an environment where node is on PATH.',
          commands: ['nvm install 22 && nvm use 22'],
          docsPath: 'README.md',
        },
      };
    }

    const result = await runCommand(executable, ['--version'], 2000);
    if (result.ok && result.stdout.trim()) {
      version = result.stdout.trim();
      detailRuntime = `Node command at ${executable}`;
    }
  }

  const major = Number(version.replace(/^v/, '').split('.')[0] ?? 0);
  const ok = major >= 22;
  return {
    id: 'node',
    label: 'Node.js',
    required: true,
    status: ok ? 'pass' : 'fail',
    version,
    detail: ok ? `${detailRuntime} is compatible.` : 'Allen requires Node.js 22 or newer.',
    fix: ok ? undefined : {
      summary: 'Install Node.js 22 or newer, then restart Allen.',
      commands: ['nvm install 22 && nvm use 22'],
      docsPath: 'README.md',
    },
  };
}

async function checkVersionCommand(params: {
  id: HealthCheckId;
  label: string;
  command: string;
  args: string[];
  required: boolean;
  minimumMajor?: number;
  installCommand?: string;
  docsPath?: string;
  envVar?: string;
  skipNodeModulesBin?: boolean;
}): Promise<SystemHealthCheck> {
  const executable = await resolveExecutable(params.command, {
    envVar: params.envVar,
    skipNodeModulesBin: params.skipNodeModulesBin,
  });
  if (!executable) {
    const status: HealthCheckStatus = params.required ? 'fail' : 'warn';
    return {
      id: params.id,
      label: params.label,
      required: params.required,
      status,
      detail: `${params.label} was not found on PATH.`,
      fix: {
        summary: `Install ${params.label} and restart Allen.`,
        commands: params.installCommand ? [params.installCommand] : undefined,
        docsPath: params.docsPath,
      },
    };
  }

  const result = await runCommand(executable, params.args);
  if (!result.ok) {
    const status: HealthCheckStatus = params.required ? 'fail' : 'warn';
    return {
      id: params.id,
      label: params.label,
      required: params.required,
      status,
      detail: result.errorCode === 'timeout'
        ? `${params.label} check timed out.`
        : `${params.label} was not found on PATH.`,
      fix: {
        summary: `Install ${params.label} and restart Allen.`,
        commands: params.installCommand ? [params.installCommand] : undefined,
        docsPath: params.docsPath,
      },
    };
  }

  const version = firstLine(result.stdout) ?? firstLine(result.stderr);
  let majorOk = true;
  if (params.minimumMajor != null && version) {
    const match = version.match(/(\d+)(?:\.\d+)?(?:\.\d+)?/);
    majorOk = match ? Number(match[1]) >= params.minimumMajor : true;
  }

  return {
    id: params.id,
    label: params.label,
    required: params.required,
    status: majorOk ? 'pass' : 'fail',
    version,
    detail: majorOk
      ? `${params.label} is available.`
      : `${params.label} is installed but does not meet the required version.`,
    fix: majorOk ? undefined : {
      summary: `Upgrade ${params.label}.`,
      commands: params.installCommand ? [params.installCommand] : undefined,
      docsPath: params.docsPath,
    },
  };
}

async function checkMongoDB(db?: Db): Promise<SystemHealthCheck> {
  try {
    if (db) {
      await Promise.race([
        db.command({ ping: 1 }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000)),
      ]);
    } else {
      const uri = process.env.MONGODB_URI ?? 'mongodb://localhost:27017/allen';
      const client = new MongoClient(uri, { serverSelectionTimeoutMS: 3000 });
      try {
        await client.connect();
        await client.db().command({ ping: 1 });
      } finally {
        await client.close().catch(() => {});
      }
    }
    return {
      id: 'mongodb',
      label: 'MongoDB',
      required: true,
      status: 'pass',
      detail: 'MongoDB is reachable.',
    };
  } catch {
    return {
      id: 'mongodb',
      label: 'MongoDB',
      required: true,
      status: 'fail',
      detail: 'MongoDB is not reachable.',
      fix: {
        summary: 'Start MongoDB and retry the health check.',
        commands: [
          'brew services start mongodb-community@7.0',
          'mongosh --eval "db.runCommand({ ping: 1 })"',
        ],
        docsPath: 'docs/troubleshooting.md',
      },
    };
  }
}

async function checkAuthCommand(params: {
  id: HealthCheckId;
  label: string;
  command: string;
  args: string[];
  required: boolean;
  authCommand: string;
  docsPath?: string;
  envVar?: string;
  skipNodeModulesBin?: boolean;
}): Promise<SystemHealthCheck> {
  const executable = await resolveExecutable(params.command, {
    envVar: params.envVar,
    skipNodeModulesBin: params.skipNodeModulesBin,
  });
  if (!executable) {
    const status: HealthCheckStatus = params.required ? 'fail' : 'warn';
    return {
      id: params.id,
      label: params.label,
      required: params.required,
      status,
      detail: `${params.label} CLI was not found on PATH.`,
      fix: {
        summary: `Install ${params.label} and restart Allen.`,
        commands: [params.authCommand],
        docsPath: params.docsPath,
      },
    };
  }

  const result = await runCommand(executable, params.args, 8000);
  if (result.ok) {
    return {
      id: params.id,
      label: params.label,
      required: params.required,
      status: 'pass',
      detail: `${params.label} is authenticated.`,
    };
  }

  const status: HealthCheckStatus = params.required ? 'fail' : 'warn';
  const timedOut = result.errorCode === 'timeout';
  return {
    id: params.id,
    label: params.label,
    required: params.required,
    status,
    detail: timedOut
      ? `${params.label} auth check timed out. The CLI may be waiting for an interactive prompt.`
      : `${params.label} is not authenticated or could not verify auth non-interactively.`,
    fix: {
      summary: `Authenticate ${params.label} in a terminal, then retry.`,
      commands: [params.authCommand],
      docsPath: params.docsPath,
    },
  };
}

export async function runSystemHealth(db?: Db): Promise<SystemHealthSummary> {
  // Required-ness for each LLM CLI is derived from the env config the setup
  // script writes. A codex-only install no longer FAILs the health check on
  // missing Claude (and vice versa); preserve mode keeps both required.
  const llm = getRequiredProviders();
  const checks = await Promise.all([
    checkNode(),
    checkVersionCommand({
      id: 'npm',
      label: 'npm',
      command: 'npm',
      args: ['--version'],
      required: true,
      minimumMajor: 10,
      installCommand: 'npm install -g npm@10',
      docsPath: 'README.md',
    }),
    checkMongoDB(db),
    checkVersionCommand({
      id: 'git',
      label: 'Git',
      command: 'git',
      args: ['--version'],
      required: true,
      installCommand: 'brew install git',
      docsPath: 'README.md',
    }),
    checkVersionCommand({
      id: 'claude_cli',
      label: 'Claude Code CLI',
      command: 'claude',
      args: ['--version'],
      required: llm.claude,
      // Use the standalone installer — the npm package @anthropic-ai/claude-code
      // is the Agent SDK shim and lacks the --agent flag Allen's engine needs.
      // Matches scripts/setup.sh.
      installCommand: 'curl -fsSL https://claude.ai/install.sh | bash',
      docsPath: 'docs/first-workflow.md',
      envVar: 'CLAUDE_BIN',
      skipNodeModulesBin: true,
    }),
    checkAuthCommand({
      id: 'claude_auth',
      label: 'Claude Code',
      command: 'claude',
      args: ['auth', 'status'],
      required: llm.claude,
      authCommand: 'claude',
      docsPath: 'docs/first-workflow.md',
      envVar: 'CLAUDE_BIN',
      skipNodeModulesBin: true,
    }),
    checkVersionCommand({
      id: 'codex_cli',
      label: 'Codex CLI',
      command: 'codex',
      args: ['--version'],
      required: llm.codex,
      installCommand: 'npm install -g @openai/codex',
      docsPath: 'docs/first-workflow.md',
    }),
    checkAuthCommand({
      id: 'codex_auth',
      label: 'Codex',
      command: 'codex',
      args: ['login', 'status'],
      required: llm.codex,
      authCommand: 'codex',
      docsPath: 'docs/first-workflow.md',
    }),
  ]);

  const requiredFailed = checks.some(check => check.required && check.status === 'fail');
  const warnings = checks.some(check => check.status === 'warn');
  return {
    status: requiredFailed ? 'fail' : warnings ? 'warn' : 'pass',
    generatedAt: new Date().toISOString(),
    requiredPassed: !requiredFailed,
    checks,
  };
}
