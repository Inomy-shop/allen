import { Router, type Request, type Response } from 'express';
import { execFile } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { ObjectId, type Db } from 'mongodb';
import { UserService } from '../services/user.service.js';
import { runSystemHealth } from '../services/system-health.service.js';
import { contextProviderRuntimeConfig } from '../services/context/config/context-provider-config.js';
import { requireAuth, type AuthedRequest } from '../middleware/requireAuth.js';
import { requireAdmin } from '../middleware/requireAdmin.js';
import { invalidateModelCostCache } from '../services/model-cost.service.js';
import { getRuntimeConfigProvider, getRuntimeSecretsProvider } from '../runtime/config.js';
import { mcpCredentialEnvKey } from '../runtime/mcp-credentials.js';
import { MCP_PRESETS } from '../services/mcp.service.js';
import { ModelRegistryService, seedModelFullIdsForProvider } from '../services/model-registry.service.js';
import { OrgSeedService } from '../services/org-seed.js';
import { seedDefaultWorkflows } from '../seed.js';
import {
  CLAUDE_COMPATIBLE_PROVIDER_CONFIGS,
  getEnabledProvidersInDefaultOrder,
  normalizeDeepSeekAnthropicBaseUrl,
} from '../services/chat-providers.js';

const exec = promisify(execFile);
const ONBOARDING_STEPS = new Set(['health', 'model_defaults', 'repository', 'first_workflow', 'complete']);

type RuntimeSettingKind = 'boolean' | 'number' | 'path' | 'select' | 'string';

type RuntimeSettingOption = {
  label: string;
  value: string;
};

type RuntimeSettingShowWhen = {
  key: string;
  equals?: string;
  notEquals?: string;
  in?: string[];
};

type RuntimeSettingDef = {
  key: string;
  label: string;
  description?: string;
  kind: RuntimeSettingKind;
  defaultValue: string;
  placeholder?: string;
  options?: RuntimeSettingOption[];
  restartRequired?: boolean;
  readOnly?: boolean;
  advanced?: boolean;
  showWhen?: RuntimeSettingShowWhen;
};

type RuntimeSettingGroupDef = {
  id: string;
  title: string;
  description: string;
  fields: RuntimeSettingDef[];
};

type DesktopCogneeSetupStatus = {
  selected: boolean;
  configuredPython: string | null;
  pythonPath: string;
  venvPython: string;
  cogneeImportOk: boolean;
  setupRecommended: boolean;
  detail: string;
};

const PROVIDER_OPTIONS = [
  { label: 'Codex', value: 'codex' },
  { label: 'Claude', value: 'claude' },
  ...CLAUDE_COMPATIBLE_PROVIDER_CONFIGS.map((config) => ({ label: config.label, value: config.provider })),
] as const;

type ProviderOptionValue = (typeof PROVIDER_OPTIONS)[number]['value'];

// Static fallbacks derived from the model-registry seed list. These are only
// used when the model_registry collection is empty/unavailable — live values
// (dropdown options, validation) are resolved from the registry first.
const SEED_CLAUDE_MODEL_FULLIDS = seedModelFullIdsForProvider('claude');
const SEED_CODEX_MODEL_FULLIDS = seedModelFullIdsForProvider('codex');

const AGENT_MODEL_OPTIONS = [
  { label: 'Provider default', value: '' },
  ...SEED_CLAUDE_MODEL_FULLIDS.map((model) => ({ label: model, value: model })),
  ...SEED_CODEX_MODEL_FULLIDS.map((model) => ({ label: model, value: model })),
  ...CLAUDE_COMPATIBLE_PROVIDER_CONFIGS.flatMap((config) => config.modelSuggestions.map((model) => ({ label: model, value: model }))),
];

const CLAUDE_AGENT_MODEL_OPTIONS = new Set(['', ...SEED_CLAUDE_MODEL_FULLIDS]);
const CODEX_AGENT_MODEL_OPTIONS = new Set(['', ...SEED_CODEX_MODEL_FULLIDS]);

const CONTEXT_LLM_MODEL_OPTIONS = [
  ...SEED_CODEX_MODEL_FULLIDS.map((model) => ({ label: model, value: model })),
  ...SEED_CLAUDE_MODEL_FULLIDS.map((model) => ({ label: model, value: model })),
];

const RERANKER_MODEL_OPTIONS = [
  { label: 'BAAI/bge-reranker-base', value: 'BAAI/bge-reranker-base' },
  { label: 'BAAI/bge-reranker-large', value: 'BAAI/bge-reranker-large' },
  { label: 'BAAI/bge-reranker-v2-m3', value: 'BAAI/bge-reranker-v2-m3' },
] as const;

const COGNEE_EMBEDDING_MODEL_OPTIONS = [
  { label: 'BAAI/bge-small-en-v1.5', value: 'BAAI/bge-small-en-v1.5' },
  { label: 'BAAI/bge-base-en-v1.5', value: 'BAAI/bge-base-en-v1.5' },
  { label: 'BAAI/bge-large-en-v1.5', value: 'BAAI/bge-large-en-v1.5' },
] as const;

const DESKTOP_RUNTIME_SETTING_GROUPS: RuntimeSettingGroupDef[] = [
  {
    id: 'runtime',
    title: 'Local Runtime',
    description: 'Desktop-owned paths and startup behavior. Changes here are written to the desktop runtime config, not the repo .env file.',
    fields: [
      { key: 'ALLEN_HOME', label: 'Allen home directory', kind: 'path', defaultValue: '~/.allen', readOnly: true },
      { key: 'WORKSPACE_BASE_DIR', label: 'Workspace directory', kind: 'path', defaultValue: '~/.allen/workspaces', readOnly: true },
      { key: 'UPLOADS_DIR', label: 'Local uploads directory', kind: 'path', defaultValue: '~/.allen/uploads', readOnly: true },
      { key: 'MCP_BUNDLES_DIR', label: 'MCP bundles directory', kind: 'path', defaultValue: '~/.allen/mcp-servers', readOnly: true, advanced: true },
      { key: 'SEED_OVERRIDE', label: 'Refresh built-ins on startup', description: 'Overwrite seeded agents, workflows, skills, and schedules from the bundled definitions.', kind: 'boolean', defaultValue: 'false', restartRequired: true },
      { key: 'TERMINAL_WS_PORT', label: 'Terminal websocket port', description: 'Leave empty to let desktop choose a local port.', kind: 'number', defaultValue: 'auto', restartRequired: true, advanced: true },
      { key: 'ALLEN_DISABLE_AUTO_UPDATE', label: 'Disable auto update', kind: 'boolean', defaultValue: 'false', restartRequired: true, advanced: true },
    ],
  },
  {
    id: 'artifacts',
    title: 'Artifacts & Uploads',
    description: 'Controls where generated artifacts and uploaded files are stored and how public links are created.',
    fields: [
      { key: 'S3_UPLOAD_ENABLED', label: 'Store uploads in S3', kind: 'boolean', defaultValue: 'false' },
      { key: 'S3_UPLOAD_BUCKET', label: 'S3 bucket', kind: 'string', defaultValue: '', showWhen: { key: 'S3_UPLOAD_ENABLED', equals: 'true' } },
      { key: 'S3_UPLOAD_REGION', label: 'S3 region', kind: 'string', defaultValue: 'us-east-1', placeholder: 'us-east-1', showWhen: { key: 'S3_UPLOAD_ENABLED', equals: 'true' } },
      { key: 'S3_UPLOAD_PREFIX', label: 'S3 key prefix', kind: 'string', defaultValue: '', showWhen: { key: 'S3_UPLOAD_ENABLED', equals: 'true' } },
      { key: 'S3_UPLOAD_ENDPOINT', label: 'Custom S3 endpoint', kind: 'string', defaultValue: '', advanced: true, showWhen: { key: 'S3_UPLOAD_ENABLED', equals: 'true' } },
      { key: 'S3_UPLOAD_FORCE_PATH_STYLE', label: 'Use path-style S3 URLs', kind: 'boolean', defaultValue: 'false', advanced: true, showWhen: { key: 'S3_UPLOAD_ENABLED', equals: 'true' } },
      { key: 'ALLEN_APP_BASE_URL', label: 'App base URL for approvals', kind: 'string', defaultValue: '', advanced: true },
    ],
  },
  {
    id: 'agents',
    title: 'Agents & Workflows Model Configuration',
    description: 'Defaults for new chat sessions, seeded workflow agents, and Claude/Codex execution behavior.',
    fields: [
      { key: 'ALLEN_DEFAULT_CHAT_PROVIDER', label: 'Default chat provider', kind: 'select', defaultValue: 'codex', options: [...PROVIDER_OPTIONS] },
      { key: 'ALLEN_DEFAULT_CHAT_MODEL', label: 'Default chat model', description: 'Used when new chat sessions are created.', kind: 'select', defaultValue: 'provider default', options: [...AGENT_MODEL_OPTIONS], showWhen: { key: 'ALLEN_DEFAULT_CHAT_PROVIDER', notEquals: '' } },
      { key: 'ALLEN_DEFAULT_AGENT_PROVIDER', label: 'Default workflow agent provider', description: 'Preserve keeps the role-specific provider mix from seed definitions.', kind: 'select', defaultValue: 'preserve seeded mix', options: [{ label: 'Preserve seeded mix', value: '' }, ...PROVIDER_OPTIONS], restartRequired: true },
      { key: 'ALLEN_DEFAULT_AGENT_MODEL', label: 'Default workflow agent model', description: 'Used when a flattened workflow agent provider is selected.', kind: 'select', defaultValue: 'provider default', options: [...AGENT_MODEL_OPTIONS], restartRequired: true, showWhen: { key: 'ALLEN_DEFAULT_AGENT_PROVIDER', notEquals: '' } },
      { key: 'CLAUDE_BIN', label: 'Claude CLI path', kind: 'path', defaultValue: 'auto from PATH' },
      { key: 'ALLEN_SYSTEM_PROMPT_MODE', label: 'System prompt mode', kind: 'select', defaultValue: 'append', options: [{ label: 'Append', value: 'append' }, { label: 'Custom', value: 'custom' }], advanced: true },
      { key: 'ALLEN_AGENT_SKIP_LEARNINGS', label: 'Skip learned context in prompts', kind: 'boolean', defaultValue: 'false', advanced: true },
      { key: 'CHAT_PERSISTENT_RUNTIME_ENABLED', label: 'Keep chat runtime warm', kind: 'boolean', defaultValue: 'true', advanced: true },
      { key: 'CHAT_RUNTIME_IDLE_MS', label: 'Chat runtime idle timeout', kind: 'number', defaultValue: '900000', advanced: true },
      { key: 'CHAT_RUNTIME_LOGS_ENABLED', label: 'Enable runtime logs', kind: 'boolean', defaultValue: 'false', advanced: true },
    ],
  },
  {
    id: 'context',
    title: 'Context',
    description: 'Controls repository context, Cognee memory, semantic reranking, and context injection budgets.',
    fields: [
      { key: 'ALLEN_CONTEXT_PROVIDER', label: 'Cognee context', description: 'Enable Cognee-backed repository context. Saving this change applies to future context builds without restarting the app.', kind: 'select', defaultValue: 'disabled', options: [{ label: 'Disabled', value: '' }, { label: 'Allen', value: 'allen' }, { label: 'Cognee', value: 'cognee' }, { label: 'Cognee Memory', value: 'cognee_memory' }] },
      { key: 'ALLEN_CONTEXT_LLM_PROVIDER', label: 'Context LLM provider', kind: 'select', defaultValue: 'codex', options: [...PROVIDER_OPTIONS], showWhen: { key: 'ALLEN_CONTEXT_PROVIDER', notEquals: '' } },
      { key: 'ALLEN_CONTEXT_LLM_MODEL', label: 'Context LLM model', kind: 'select', defaultValue: 'gpt-5.5', options: [...CONTEXT_LLM_MODEL_OPTIONS], showWhen: { key: 'ALLEN_CONTEXT_PROVIDER', notEquals: '' } },
      { key: 'ALLEN_PYTHON', label: 'Python environment path', kind: 'path', defaultValue: 'system Python', readOnly: true, showWhen: { key: 'ALLEN_CONTEXT_PROVIDER', notEquals: '' } },
      { key: 'ALLEN_CONTEXT_MAX_FILE_CHARS', label: 'Max chars per context file', kind: 'number', defaultValue: '60000', advanced: true, showWhen: { key: 'ALLEN_CONTEXT_PROVIDER', notEquals: '' } },
      { key: 'ALLEN_CONTEXT_MAX_TOTAL_CHARS', label: 'Max total context chars', kind: 'number', defaultValue: '180000', advanced: true, showWhen: { key: 'ALLEN_CONTEXT_PROVIDER', notEquals: '' } },
      { key: 'ALLEN_CONTEXT_MAX_INJECTED_REFS', label: 'Max injected refs', kind: 'number', defaultValue: '12', advanced: true, showWhen: { key: 'ALLEN_CONTEXT_PROVIDER', notEquals: '' } },
      { key: 'ALLEN_CONTEXT_RERANKER', label: 'Semantic reranker', kind: 'select', defaultValue: 'disabled', options: [{ label: 'Disabled', value: '' }, { label: 'BGE', value: 'bge' }], showWhen: { key: 'ALLEN_CONTEXT_PROVIDER', notEquals: '' } },
      { key: 'ALLEN_CONTEXT_RERANKER_MODEL', label: 'Reranker model', kind: 'select', defaultValue: 'BAAI/bge-reranker-base', options: [...RERANKER_MODEL_OPTIONS], showWhen: { key: 'ALLEN_CONTEXT_RERANKER', equals: 'bge' } },
      { key: 'ALLEN_CONTEXT_RERANKER_TIMEOUT_MS', label: 'Reranker timeout', kind: 'number', defaultValue: '120000', advanced: true, showWhen: { key: 'ALLEN_CONTEXT_RERANKER', equals: 'bge' } },
      { key: 'ALLEN_COGNEE_DATA_DIR', label: 'Cognee data directory', kind: 'path', defaultValue: '~/.allen/cognee', readOnly: true, showWhen: { key: 'ALLEN_CONTEXT_PROVIDER', in: ['cognee', 'cognee_memory'] } },
      { key: 'ALLEN_COGNEE_TIMEOUT_MS', label: 'Cognee timeout', kind: 'number', defaultValue: '14400000 ingest / 120000 search', advanced: true, showWhen: { key: 'ALLEN_CONTEXT_PROVIDER', in: ['cognee', 'cognee_memory'] } },
      { key: 'ALLEN_COGNEE_EMBEDDING_PROVIDER', label: 'Cognee embedding provider', kind: 'select', defaultValue: 'local', options: [{ label: 'Local', value: 'local' }], advanced: true, showWhen: { key: 'ALLEN_CONTEXT_PROVIDER', in: ['cognee', 'cognee_memory'] } },
      { key: 'ALLEN_COGNEE_EMBEDDING_MODEL', label: 'Cognee embedding model', kind: 'select', defaultValue: 'BAAI/bge-small-en-v1.5', options: [...COGNEE_EMBEDDING_MODEL_OPTIONS], advanced: true, showWhen: { key: 'ALLEN_CONTEXT_PROVIDER', in: ['cognee', 'cognee_memory'] } },
      { key: 'ALLEN_CONTEXT_SEMANTIC_EVALUATOR', label: 'Semantic evaluator', kind: 'select', defaultValue: 'deepeval', options: [{ label: 'DeepEval', value: 'deepeval' }, { label: 'Disabled', value: 'disabled' }], showWhen: { key: 'ALLEN_CONTEXT_PROVIDER', notEquals: '' } },
      { key: 'ALLEN_DEEPEVAL_SCRIPT', label: 'DeepEval script', kind: 'path', defaultValue: 'bundled evaluator', advanced: true, showWhen: { key: 'ALLEN_CONTEXT_SEMANTIC_EVALUATOR', equals: 'deepeval' } },
    ],
  },
  {
    id: 'developer',
    title: 'Developer & Diagnostics',
    description: 'Low-level settings for local troubleshooting. Most users should leave these at defaults.',
    fields: [
      { key: 'LOG_LEVEL', label: 'Log level', kind: 'select', defaultValue: 'info', options: [{ label: 'Default', value: '' }, { label: 'Debug', value: 'debug' }, { label: 'Info', value: 'info' }, { label: 'Warn', value: 'warn' }, { label: 'Error', value: 'error' }], advanced: true },
      { key: 'LOG_FORMAT', label: 'Log format', kind: 'select', defaultValue: 'pretty', options: [{ label: 'Pretty', value: 'pretty' }, { label: 'JSON', value: 'json' }], advanced: true },
      { key: 'ALLEN_TERMINAL_SHELL', label: 'Terminal shell', kind: 'path', defaultValue: 'system shell', advanced: true },
      { key: 'GIT_SSH_COMMAND', label: 'Git SSH command', kind: 'string', defaultValue: 'ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new', advanced: true },
      { key: 'ALLEN_DISABLE_SWEEPER', label: 'Disable MCP orphan cleanup', kind: 'boolean', defaultValue: 'false', advanced: true },
      { key: 'ALLEN_DESKTOP_MONGOD_BINARY', label: 'Custom MongoDB binary', kind: 'path', defaultValue: 'bundled MongoDB', restartRequired: true, advanced: true },
    ],
  },
  ...CLAUDE_COMPATIBLE_PROVIDER_CONFIGS.map((config): RuntimeSettingGroupDef => {
    const defaultBaseUrl = config.provider === 'deepseek'
      ? normalizeDeepSeekAnthropicBaseUrl(config.defaultBaseUrl)
      : config.defaultBaseUrl;
    return {
      id: config.provider,
      title: config.label,
      description: `${config.label} API provider configuration. Allen uses the Claude Code binary with your ${config.label} credentials. Set the API key in the ${config.label} section to enable this provider.`,
      fields: [
        {
          key: config.baseUrlEnv,
          label: 'API base URL',
          description: config.baseUrlDescription,
          kind: 'string',
          defaultValue: defaultBaseUrl,
          placeholder: defaultBaseUrl,
        },
        {
          key: config.modelEnv,
          label: config.opusModelEnv ? 'Default/Sonnet model' : 'Default model',
          description: `Primary ${config.label} model for chat and agents${config.opusModelEnv ? ' (sonnet-equivalent role)' : ''}. Open text — enter any ${config.label} model ID.`,
          kind: 'string',
          defaultValue: config.defaultModel,
          placeholder: config.defaultModel,
        },
        ...(config.opusModelEnv ? [{
          key: config.opusModelEnv,
          label: 'Opus model',
          description: `High-capability ${config.label} model used for opus-equivalent roles.`,
          kind: 'string' as const,
          defaultValue: config.defaultOpusModel ?? config.defaultModel,
          placeholder: config.defaultOpusModel ?? config.defaultModel,
        }] : []),
        {
          key: config.flashModelEnv,
          label: 'Fast model',
          description: 'Fast/lightweight model for quick operations (haiku-equivalent role).',
          kind: 'string',
          defaultValue: config.defaultFlashModel,
          placeholder: config.defaultFlashModel,
        },
      ],
    };
  }),
];

const DESKTOP_RUNTIME_SETTING_DEFS = new Map(
  DESKTOP_RUNTIME_SETTING_GROUPS.flatMap((group) => group.fields.map((field) => [field.key, field] as const)),
);

function chatModelOptionsForProvider(provider: string): RuntimeSettingOption[] {
  if (provider === 'claude') {
    return [...CLAUDE_AGENT_MODEL_OPTIONS]
      .filter((value) => value !== '')
      .map((value) => ({ label: value, value }));
  }
  if (provider === 'codex') {
    return [...CODEX_AGENT_MODEL_OPTIONS]
      .filter((value) => value !== '')
      .map((value) => ({ label: value, value }));
  }
  const config = CLAUDE_COMPATIBLE_PROVIDER_CONFIGS.find((item) => item.provider === provider);
  return (config?.modelSuggestions ?? []).map((value) => ({ label: value, value }));
}

/**
 * Registry-aware version of chatModelOptionsForProvider.
 * Queries the model_registry for active models belonging to the given provider.
 * Falls back to the static hardcoded sets when the registry is empty/unavailable.
 */
async function chatModelOptionsForProviderFromRegistry(provider: string, db: Db): Promise<RuntimeSettingOption[]> {
  try {
    const registryModels = await db.collection('model_registry')
      .find({ provider, isActive: true })
      .sort({ sortOrder: 1 })
      .project({ fullId: 1, displayName: 1 })
      .toArray();
    if (registryModels.length > 0) {
      return registryModels.map((m) => ({ label: (m.displayName as string) || (m.fullId as string), value: m.fullId as string }));
    }
  } catch {
    // Registry unavailable — fall through to static defaults
  }
  return chatModelOptionsForProvider(provider);
}

function fallbackChatModelForProvider(provider: string): string {
  if (provider === 'claude') return 'claude-sonnet-4-6';
  if (provider === 'codex') return 'gpt-5.5';
  return CLAUDE_COMPATIBLE_PROVIDER_CONFIGS.find((item) => item.provider === provider)?.defaultModel ?? 'gpt-5.5';
}

/**
 * Registry-aware default model for a provider: the active `tier: 'default'`
 * entry (lowest sortOrder), then the first active entry, then the static
 * fallback above.
 */
async function defaultChatModelForProviderFromRegistry(provider: string, db: Db): Promise<string> {
  try {
    const tierDefault = await db.collection('model_registry').findOne(
      { provider, isActive: true, tier: 'default' },
      { sort: { sortOrder: 1 }, projection: { fullId: 1 } },
    );
    if (tierDefault?.fullId) return tierDefault.fullId as string;
    const firstActive = await db.collection('model_registry').findOne(
      { provider, isActive: true },
      { sort: { sortOrder: 1 }, projection: { fullId: 1 } },
    );
    if (firstActive?.fullId) return firstActive.fullId as string;
  } catch {
    // Registry unavailable — fall through to static default
  }
  return fallbackChatModelForProvider(provider);
}

const COGNEE_CONTEXT_PROVIDERS = new Set(['cognee', 'cognee_memory']);
const COGNEE_CONTEXT_VENV_DIR = resolve(homedir(), '.allen/python/context-eval');
const COGNEE_CONTEXT_VENV_PYTHON = resolve(COGNEE_CONTEXT_VENV_DIR, 'bin/python');
const COGNEE_CONTEXT_DATA_DIR = resolve(homedir(), '.allen/cognee');

const BASE_SECRET_DEFS = [
  ...CLAUDE_COMPATIBLE_PROVIDER_CONFIGS.map((config) => ({ key: config.apiKeyEnv, label: `${config.label} API key`, group: config.label })),
  { key: 'ALLEN_GITHUB_PERSONAL_ACCESS_TOKEN', label: 'GitHub personal access token', group: 'GitHub' },
  { key: 'ALLEN_LINEAR_ACCESS_TOKEN', label: 'Linear access token', group: 'Linear' },
  { key: 'ALLEN_SLACK_BOT_TOKEN', label: 'Slack bot token', group: 'Slack' },
  { key: 'ALLEN_SLACK_SIGNING_SECRET', label: 'Slack signing secret', group: 'Slack' },
  { key: 'ALLEN_SLACK_TEAM_ID', label: 'Slack team ID', group: 'Slack' },
] as const;

async function secretDefinitions(db: Db): Promise<Array<{ key: string; label: string; group: string }>> {
  const defs = new Map<string, { key: string; label: string; group: string }>();
  for (const def of BASE_SECRET_DEFS) defs.set(def.key, def);
  for (const preset of MCP_PRESETS) {
    for (const rawKey of [...(preset.envKeys ?? []), ...(preset.argKeys ?? [])]) {
      const key = mcpCredentialEnvKey(rawKey);
      if (!defs.has(key)) {
        defs.set(key, {
          key,
          label: key,
          group: `MCP: ${preset.name}`,
        });
      }
    }
  }
  const servers = await db.collection('mcp_servers')
    .find({}, { projection: { name: 1, envKeys: 1, argKeys: 1 } })
    .toArray();
  for (const server of servers) {
    const serverName = typeof server.name === 'string' && server.name ? server.name : 'Custom';
    for (const rawKey of [...(server.envKeys ?? []), ...(server.argKeys ?? [])]) {
      const key = mcpCredentialEnvKey(String(rawKey));
      if (!defs.has(key)) {
        defs.set(key, {
          key,
          label: key,
          group: `MCP: ${serverName}`,
        });
      }
    }
  }
  return Array.from(defs.values()).sort((a, b) => a.group.localeCompare(b.group) || a.key.localeCompare(b.key));
}

async function validateRuntimeSecretKey(input: unknown, db: Db): Promise<string> {
  const key = String(input ?? '').trim();
  const allowed = new Set((await secretDefinitions(db)).map((def) => def.key));
  if (!allowed.has(key)) throw new Error('unsupported_secret_key');
  return key;
}

function dateIso(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string' && value) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
  return null;
}

function readDesktopRuntimeConfigFile(configPath: string | undefined): Record<string, string> {
  if (!configPath || !existsSync(configPath)) return {};
  try {
    const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'string') out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

function writeDesktopRuntimeConfigFile(configPath: string, values: Record<string, string>): void {
  writeFileSync(configPath, JSON.stringify(values, null, 2) + '\n', { mode: 0o600 });
  chmodSync(configPath, 0o600);
}

async function detectPathCommand(command: string): Promise<string | undefined> {
  try {
    const { stdout } = await exec('/bin/zsh', ['-lc', `command -v ${command} || true`], { timeout: 1500 });
    const value = stdout.trim().split('\n')[0]?.trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}

async function detectedRuntimeDefaults(configPath: string | undefined): Promise<Record<string, string>> {
  void configPath;
  const allenRoot = resolve(homedir(), '.allen');
  const [claudeBin, pythonBin] = await Promise.all([
    detectPathCommand('claude'),
    detectPathCommand('python3 || command -v python'),
  ]);

  return {
    ALLEN_HOME: allenRoot,
    WORKSPACE_BASE_DIR: resolve(allenRoot, 'workspaces'),
    UPLOADS_DIR: resolve(allenRoot, 'uploads'),
    MCP_BUNDLES_DIR: resolve(allenRoot, 'mcp-servers'),
    ALLEN_COGNEE_DATA_DIR: COGNEE_CONTEXT_DATA_DIR,
    ...(claudeBin ? { CLAUDE_BIN: claudeBin } : {}),
    ...(pythonBin ? { ALLEN_PYTHON: pythonBin, PYTHON: pythonBin } : {}),
    ...(process.env.SHELL ? { ALLEN_TERMINAL_SHELL: process.env.SHELL } : {}),
  };
}

function normalizeRuntimeSettingValue(field: RuntimeSettingDef, raw: unknown): string | undefined {
  if (raw === null || raw === undefined) return undefined;
  if (field.kind === 'boolean') {
    if (typeof raw === 'boolean') return raw ? 'true' : 'false';
    return String(raw).trim().toLowerCase() === 'true' ? 'true' : 'false';
  }

  const value = String(raw).trim();
  if (!value) {
    if (field.kind === 'path') {
      return undefined;
    }
    if (field.kind === 'select') {
      const allowed = new Set((field.options ?? []).map((option) => option.value));
      if (!allowed.has('')) throw new Error(`invalid_value:${field.key}`);
    }
    return '';
  }
  if (field.kind === 'select') {
    const allowed = new Set((field.options ?? []).map((option) => option.value));
    if (!allowed.has(value) && !field.key.endsWith('_MODEL')) {
      throw new Error(`invalid_value:${field.key}`);
    }
  }
  if (field.kind === 'number') {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) {
      throw new Error(`invalid_value:${field.key}`);
    }
  }
  if (field.key === 'ALLEN_DEEPSEEK_BASE_URL') {
    return normalizeDeepSeekAnthropicBaseUrl(value);
  }
  return value;
}

function runtimeSettingValue(
  field: RuntimeSettingDef,
  persisted: Record<string, string>,
  detectedDefaults: Record<string, string>,
): {
  currentValue: string;
  configuredValue: string | null;
  source: 'desktop_config' | 'env' | 'default';
  defaultValue: string;
} {
  const defaultValue = detectedDefaults[field.key] ?? field.defaultValue;
  if (persisted[field.key] !== undefined) {
    const persistedValue = field.key === 'ALLEN_DEEPSEEK_BASE_URL'
      ? normalizeDeepSeekAnthropicBaseUrl(persisted[field.key])
      : persisted[field.key];
    if (field.key === 'ALLEN_CONTEXT_SEMANTIC_EVALUATOR' && persistedValue === '') {
      return {
        currentValue: defaultValue,
        configuredValue: null,
        source: 'default',
        defaultValue,
      };
    }
    return {
      currentValue: persistedValue,
      configuredValue: persistedValue,
      source: 'desktop_config',
      defaultValue,
    };
  }

  const configValue = getRuntimeConfigProvider().get(field.key);
  if (configValue !== undefined) {
    const runtimeConfigValue = field.key === 'ALLEN_DEEPSEEK_BASE_URL'
      ? normalizeDeepSeekAnthropicBaseUrl(configValue)
      : configValue;
    return {
      currentValue: runtimeConfigValue,
      configuredValue: null,
      source: 'env',
      defaultValue,
    };
  }

  const currentDefault = defaultValue === 'disabled'
    || defaultValue === 'auto'
    || defaultValue.startsWith('<')
    || defaultValue.includes(' ')
    ? ''
    : defaultValue;
  return {
    currentValue: field.kind === 'boolean' ? (defaultValue === 'true' ? 'true' : 'false') : currentDefault,
    configuredValue: null,
    source: 'default',
    defaultValue,
  };
}

function currentRuntimeSettingValue(
  key: string,
  persisted: Record<string, string>,
  detectedDefaults: Record<string, string>,
): string {
  const field = DESKTOP_RUNTIME_SETTING_DEFS.get(key);
  if (!field) return '';
  return runtimeSettingValue(field, persisted, detectedDefaults).currentValue;
}

async function pythonCanImportCognee(pythonPath: string): Promise<{ ok: boolean; detail: string }> {
  if (!pythonPath) return { ok: false, detail: 'Python path is empty.' };
  if (pythonPath.includes('/') && !existsSync(pythonPath)) {
    return { ok: false, detail: `Python executable does not exist: ${pythonPath}` };
  }

  try {
    await exec(pythonPath, [
      '-c',
      'import cognee; from fastembed import TextEmbedding; print("ok")',
    ], { timeout: 15000, maxBuffer: 1024 * 1024 });
    return { ok: true, detail: 'Cognee and fastembed import successfully.' };
  } catch (err) {
    const output = err as ExecErrorWithOutput;
    const detail = (output.stderr || output.stdout || output.message).trim();
    return { ok: false, detail: detail || 'Cognee import check failed.' };
  }
}

async function desktopCogneeSetupStatus(
  persisted: Record<string, string>,
  detectedDefaults: Record<string, string>,
  options: { verifyImport?: boolean } = {},
): Promise<DesktopCogneeSetupStatus> {
  const provider = currentRuntimeSettingValue('ALLEN_CONTEXT_PROVIDER', persisted, detectedDefaults);
  const configuredPython = persisted.ALLEN_PYTHON ?? getRuntimeConfigProvider().get('ALLEN_PYTHON') ?? null;
  const pythonPath = configuredPython
    ?? detectedDefaults.ALLEN_PYTHON
    ?? detectedDefaults.PYTHON
    ?? 'python3';
  const selected = COGNEE_CONTEXT_PROVIDERS.has(provider);
  const importCheck = options.verifyImport
    ? await pythonCanImportCognee(pythonPath)
    : {
      ok: Boolean(configuredPython),
      detail: configuredPython
        ? 'Python import check is deferred until setup runs.'
        : `ALLEN_PYTHON is not set. Desktop setup will create ${COGNEE_CONTEXT_VENV_PYTHON} and use it for Cognee.`,
    };
  const setupRecommended = selected && (!configuredPython || !importCheck.ok);

  return {
    selected,
    configuredPython,
    pythonPath,
    venvPython: COGNEE_CONTEXT_VENV_PYTHON,
    cogneeImportOk: importCheck.ok,
    setupRecommended,
    detail: importCheck.detail,
  };
}

async function desktopRuntimeSettingsPayload(db: Db) {
  const config = getRuntimeConfigProvider();
  const desktop = config.get('ALLEN_DESKTOP') === '1';
  const configPath = config.get('ALLEN_DESKTOP_CONFIG_PATH');
  const persisted = readDesktopRuntimeConfigFile(configPath);
  const defaults = await detectedRuntimeDefaults(configPath);
  const enabledProviderOptions = (await getEnabledProvidersInDefaultOrder()).map((provider) => ({
    label: provider.label,
    value: provider.provider,
  }));
  const enabledProviderValues = new Set<string>(enabledProviderOptions.map((option) => option.value));

  // Pre-compute model options and registry-backed default models for all
  // enabled providers (Fix 3A)
  const modelOptionsCache = new Map<string, RuntimeSettingOption[]>();
  const defaultModelCache = new Map<string, string>();
  for (const opt of enabledProviderOptions) {
    const options = await chatModelOptionsForProviderFromRegistry(opt.value, db).catch(() => []);
    modelOptionsCache.set(opt.value, options);
    const defaultModel = await defaultChatModelForProviderFromRegistry(opt.value, db)
      .catch(() => fallbackChatModelForProvider(opt.value));
    defaultModelCache.set(opt.value, defaultModel);
  }

  function normalizeProviderField(field: RuntimeSettingDef, value: ReturnType<typeof runtimeSettingValue>) {
    if (field.key === 'ALLEN_DEFAULT_CHAT_PROVIDER') {
      return {
        ...field,
        options: enabledProviderOptions,
        ...value,
        currentValue: enabledProviderValues.has(value.currentValue) ? value.currentValue : enabledProviderOptions[0]?.value ?? 'codex',
      };
    }
    if (field.key === 'ALLEN_DEFAULT_CHAT_MODEL') {
      const chatProvider = currentRuntimeSettingValue('ALLEN_DEFAULT_CHAT_PROVIDER', persisted, defaults);
      const normalizedProvider = enabledProviderValues.has(chatProvider) ? chatProvider : enabledProviderOptions[0]?.value ?? 'codex';
      const modelOptions = modelOptionsCache.get(normalizedProvider) ?? [];
      const fallbackModel = defaultModelCache.get(normalizedProvider) ?? fallbackChatModelForProvider(normalizedProvider);
      const modelValues = new Set(modelOptions.map((option) => option.value));
      const currentValue = value.currentValue && (modelValues.has(value.currentValue) || modelOptions.length === 0)
        ? value.currentValue
        : fallbackModel;
      return {
        ...field,
        options: modelOptions.length > 0 ? modelOptions : [{ label: currentValue, value: currentValue }],
        ...value,
        currentValue,
      };
    }
    if (field.key === 'ALLEN_DEFAULT_AGENT_PROVIDER') {
      return {
        ...field,
        options: [{ label: 'Preserve seeded mix', value: '' }, ...enabledProviderOptions],
        ...value,
        currentValue: value.currentValue === '' || enabledProviderValues.has(value.currentValue) ? value.currentValue : '',
      };
    }
    if (field.key === 'ALLEN_DEFAULT_AGENT_MODEL') {
      const agentProvider = currentRuntimeSettingValue('ALLEN_DEFAULT_AGENT_PROVIDER', persisted, defaults);
      if (!agentProvider || !enabledProviderValues.has(agentProvider)) {
        return { ...field, ...value };
      }
      const modelOptions = modelOptionsCache.get(agentProvider) ?? [];
      if (modelOptions.length === 0) return { ...field, ...value };
      const withProviderDefault = [{ label: 'Provider default', value: '' }, ...modelOptions];
      const modelValues = new Set(withProviderDefault.map((option) => option.value));
      return {
        ...field,
        options: withProviderDefault,
        ...value,
        currentValue: modelValues.has(value.currentValue) ? value.currentValue : '',
      };
    }
    if (field.key === 'ALLEN_CONTEXT_LLM_MODEL') {
      const contextProvider = currentRuntimeSettingValue('ALLEN_CONTEXT_LLM_PROVIDER', persisted, defaults) || 'codex';
      const modelOptions = modelOptionsCache.get(contextProvider) ?? [];
      if (modelOptions.length === 0) return { ...field, ...value };
      const modelValues = new Set(modelOptions.map((option) => option.value));
      const fallbackModel = defaultModelCache.get(contextProvider) ?? fallbackChatModelForProvider(contextProvider);
      const currentValue = value.currentValue && modelValues.has(value.currentValue)
        ? value.currentValue
        : modelValues.has(fallbackModel) ? fallbackModel : modelOptions[0].value;
      return {
        ...field,
        options: modelOptions,
        ...value,
        currentValue,
      };
    }
    if (field.key === 'ALLEN_CONTEXT_LLM_PROVIDER') {
      return {
        ...field,
        options: enabledProviderOptions,
        ...value,
        currentValue: enabledProviderValues.has(value.currentValue) ? value.currentValue : enabledProviderOptions[0]?.value ?? 'codex',
      };
    }
    return { ...field, ...value };
  }

  return {
    desktop,
    editable: desktop && Boolean(configPath),
    configPath: desktop ? configPath ?? null : null,
    contextSetup: desktop
      ? await desktopCogneeSetupStatus(persisted, defaults)
      : {
        selected: false,
        configuredPython: null,
        pythonPath: '',
        venvPython: COGNEE_CONTEXT_VENV_PYTHON,
        cogneeImportOk: false,
        setupRecommended: false,
        detail: 'Desktop-only setup is unavailable in web mode.',
      },
    groups: DESKTOP_RUNTIME_SETTING_GROUPS.map((group) => ({
      ...group,
      fields: group.fields.map((field) => {
        const value = runtimeSettingValue(field, persisted, defaults);
        return {
          ...normalizeProviderField(field, value),
          restartRequired: Boolean(field.restartRequired),
          readOnly: Boolean(field.readOnly),
          advanced: Boolean(field.advanced),
        };
      }),
    })),
  };
}

function updateRuntimeProviderValue(key: string, value: string | undefined): void {
  const provider = getRuntimeConfigProvider() as {
    set?: (runtimeKey: string, runtimeValue: string) => void;
    delete?: (runtimeKey: string) => void;
  };
  if (value === undefined) {
    delete process.env[key];
    provider.delete?.(key);
    return;
  }
  provider.set?.(key, value);
  if (value === '') delete process.env[key];
  else process.env[key] = value;
}

function isProviderValue(value: string): value is ProviderOptionValue {
  return PROVIDER_OPTIONS.some((option) => option.value === value);
}

async function validateAgentModelForProvider(provider: ProviderOptionValue | '', model: string, db: Db): Promise<void> {
  if (!provider) {
    if (model) throw new Error('agent_model_requires_agent_provider');
    return;
  }
  if (CLAUDE_COMPATIBLE_PROVIDER_CONFIGS.some((config) => config.provider === provider)) {
    // Claude-compatible API providers use open model fields — any string is valid.
    return;
  }
  // For closed providers (claude-cli, codex), check the registry first, fall back to static sets.
  try {
    const registryModels = await db.collection('model_registry')
      .find({ provider, isActive: true })
      .project({ fullId: 1 })
      .toArray();
    if (registryModels.length > 0) {
      const validFullIds = new Set(registryModels.map((m) => m.fullId as string));
      if (!validFullIds.has(model)) {
        // Also allow empty string (provider default)
        if (model !== '') throw new Error('invalid_agent_model_for_provider');
      }
      return;
    }
  } catch {
    // Registry unavailable — fall through to static defaults
  }
  const allowed = provider === 'codex' ? CODEX_AGENT_MODEL_OPTIONS : CLAUDE_AGENT_MODEL_OPTIONS;
  if (!allowed.has(model)) throw new Error('invalid_agent_model_for_provider');
}

async function refreshDesktopSeedDefaults(db: Db): Promise<void> {
  const previousSeedOverride = process.env.SEED_OVERRIDE;
  process.env.SEED_OVERRIDE = 'true';
  try {
    await new OrgSeedService(db).seed();
    await seedDefaultWorkflows(db);
  } finally {
    if (previousSeedOverride === undefined) delete process.env.SEED_OVERRIDE;
    else process.env.SEED_OVERRIDE = previousSeedOverride;
  }
}

function findContextSetupScript(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  const candidates = [
    ...(resourcesPath ? [resolve(resourcesPath, 'scripts/setup-context-engine.sh')] : []),
    resolve(process.cwd(), 'scripts/setup-context-engine.sh'),
    resolve(process.cwd(), '../../scripts/setup-context-engine.sh'),
    resolve(here, '../../../../scripts/setup-context-engine.sh'),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function desktopCogneeRuntimeDefaults(provider: string): Record<string, string> {
  return {
    ALLEN_CONTEXT_PROVIDER: COGNEE_CONTEXT_PROVIDERS.has(provider) ? provider : 'cognee',
    ALLEN_PYTHON: COGNEE_CONTEXT_VENV_PYTHON,
    ALLEN_COGNEE_DATA_DIR: COGNEE_CONTEXT_DATA_DIR,
    ALLEN_COGNEE_EMBEDDING_PROVIDER: 'local',
    ALLEN_COGNEE_EMBEDDING_MODEL: 'BAAI/bge-small-en-v1.5',
    ALLEN_CONTEXT_LLM_PROVIDER: getRuntimeConfigProvider().get('ALLEN_CONTEXT_LLM_PROVIDER') ?? 'codex',
    ALLEN_CONTEXT_LLM_MODEL: getRuntimeConfigProvider().get('ALLEN_CONTEXT_LLM_MODEL') ?? 'gpt-5.5',
    ALLEN_CONTEXT_RERANKER: getRuntimeConfigProvider().get('ALLEN_CONTEXT_RERANKER') ?? 'bge',
    ALLEN_CONTEXT_RERANKER_MODEL: getRuntimeConfigProvider().get('ALLEN_CONTEXT_RERANKER_MODEL') ?? 'BAAI/bge-reranker-base',
    ALLEN_CONTEXT_SEMANTIC_EVALUATOR: getRuntimeConfigProvider().get('ALLEN_CONTEXT_SEMANTIC_EVALUATOR') ?? 'deepeval',
  };
}

function persistDesktopRuntimeValues(
  configPath: string,
  values: Record<string, string>,
  options: { overwrite?: Set<string> } = {},
): void {
  const persisted = readDesktopRuntimeConfigFile(configPath);
  for (const [key, value] of Object.entries(values)) {
    const shouldOverwrite = options.overwrite?.has(key) ?? false;
    if (!shouldOverwrite && persisted[key] !== undefined && persisted[key].trim() !== '') continue;
    persisted[key] = value;
    updateRuntimeProviderValue(key, value);
  }
  writeDesktopRuntimeConfigFile(configPath, persisted);
}

async function runDesktopCogneeSetup(configPath: string, provider: string): Promise<{
  output: string[];
  setup: DesktopCogneeSetupStatus;
}> {
  const scriptPath = findContextSetupScript();
  if (!scriptPath) {
    throw new Error('context_setup_script_missing');
  }

  const defaults = await detectedRuntimeDefaults(configPath);
  const bootstrapPython = defaults.PYTHON ?? defaults.ALLEN_PYTHON ?? process.env.PYTHON ?? 'python3';
  let stdout = '';
  let stderr = '';
  try {
    const result = await exec('bash', [
      scriptPath,
      '--no-env',
      '--skip-warmup',
      '--python',
      bootstrapPython,
    ], {
      timeout: 15 * 60 * 1000,
      maxBuffer: 20 * 1024 * 1024,
      env: {
        ...process.env,
        ALLEN_CONTEXT_VENV_DIR: COGNEE_CONTEXT_VENV_DIR,
      },
    });
    stdout = result.stdout;
    stderr = result.stderr;
  } catch (err) {
    const output = err as ExecErrorWithOutput;
    const detail = (output.stderr || output.stdout || output.message).trim();
    throw new Error(`context_setup_failed:${detail || 'unknown error'}`);
  }

  persistDesktopRuntimeValues(configPath, desktopCogneeRuntimeDefaults(provider), {
    overwrite: new Set(['ALLEN_CONTEXT_PROVIDER', 'ALLEN_PYTHON', 'ALLEN_COGNEE_DATA_DIR']),
  });

  const persisted = readDesktopRuntimeConfigFile(configPath);
  const detected = await detectedRuntimeDefaults(configPath);
  const output = `${stdout}\n${stderr}`.trim().split('\n').filter(Boolean).slice(-80);
  return {
    output,
    setup: await desktopCogneeSetupStatus(persisted, detected, { verifyImport: true }),
  };
}

function onboardingProgressPayload(onboarding: Record<string, unknown>) {
  const completedAt = dateIso(onboarding.completedAt);
  const skippedAt = dateIso(onboarding.skippedAt);
  const rawStep = typeof onboarding.step === 'string' ? onboarding.step : 'health';
  const step = ONBOARDING_STEPS.has(rawStep) ? rawStep : 'health';
  const complete = Boolean(completedAt || skippedAt);
  return {
    complete,
    skipped: Boolean(skippedAt),
    step: complete ? 'complete' : step,
    completedAt,
    skippedAt,
  };
}

type OnboardingProgressPayload = ReturnType<typeof onboardingProgressPayload>;

async function adminSetupProgress(db: Db): Promise<OnboardingProgressPayload> {
  const adminUsers = await db.collection('users')
    .find({ role: 'admin' }, { projection: { onboarding: 1, updatedAt: 1, createdAt: 1 } })
    .sort({ updatedAt: -1, createdAt: -1 })
    .toArray();

  const adminProgress = adminUsers.map(user => onboardingProgressPayload((user.onboarding ?? {}) as Record<string, unknown>));
  const complete = adminProgress.find(progress => progress.complete);
  if (complete) return complete;

  return adminProgress.find(progress => progress.step !== 'health') ?? adminProgress[0] ?? onboardingProgressPayload({});
}

type ExecErrorWithOutput = Error & {
  stdout?: string;
  stderr?: string;
  killed?: boolean;
  signal?: string;
};

function sanitizeSshHost(input: unknown): string {
  const host = String(input ?? 'github.com').trim().toLowerCase();
  if (!/^[a-z0-9.-]+$/.test(host)) {
    throw new Error('Invalid SSH host');
  }
  return host;
}

async function runSshAuthCheck(host: string): Promise<{ stdout: string; stderr: string; timedOut: boolean }> {
  try {
    const { stdout, stderr } = await exec('ssh', [
      '-T',
      '-o', 'BatchMode=yes',
      '-o', 'StrictHostKeyChecking=accept-new',
      `git@${host}`,
    ], { timeout: 8000 });
    return { stdout, stderr, timedOut: false };
  } catch (err) {
    const output = err as ExecErrorWithOutput;
    return {
      stdout: output.stdout ?? '',
      stderr: output.stderr ?? '',
      timedOut: output.killed === true || output.signal === 'SIGTERM',
    };
  }
}

export function systemRoutes(db: Db): Router {
  const router = Router();
  const users = new UserService(db);

  // GET /api/system/onboarding-status
  //
  // Public by design: the UI needs to know whether it should show first-admin
  // bootstrap before anyone can log in. Keep the response coarse and avoid
  // exposing user records, emails, env config, or filesystem details.
  router.get('/onboarding-status', async (_req: Request, res: Response) => {
    try {
      const [userCount, adminCount] = await Promise.all([
        users.countUsers(),
        users.countAdmins(),
      ]);
      const isFirstRun = userCount === 0;
      const setupProgress = isFirstRun ? onboardingProgressPayload({ step: 'account' }) : await adminSetupProgress(db);
      return res.json({
        isFirstRun,
        userCount,
        adminCount,
        complete: isFirstRun ? false : setupProgress.complete,
        step: isFirstRun ? 'account' : setupProgress.step,
      });
    } catch (err) {
      console.error('[system/onboarding-status]', err);
      return res.status(500).json({ error: 'onboarding_status_failed' });
    }
  });

  // GET /api/system/health
  //
  // Public during onboarding. The health service intentionally returns coarse
  // status and fix guidance only; it does not expose env values, secrets,
  // absolute local paths, or raw command output.
  router.get('/health', async (_req: Request, res: Response) => {
    try {
      const health = await runSystemHealth(db);
      return res.json(health);
    } catch (err) {
      console.error('[system/health]', err);
      return res.status(500).json({ error: 'system_health_failed' });
    }
  });

  router.get('/runtime-config', (_req: Request, res: Response) => {
    return res.json({
      contextEngine: contextProviderRuntimeConfig(),
    });
  });

  router.get('/desktop-runtime', requireAuth, async (_req: AuthedRequest, res: Response) => {
    try {
      const config = getRuntimeConfigProvider();
      const secrets = getRuntimeSecretsProvider();
      const secretStatus = await Promise.all((await secretDefinitions(db)).map(async (def) => {
        const secretValue = await secrets.getSecret(def.key);
        const configValue = config.get(def.key);
        return {
          ...def,
          configured: Boolean(secretValue || configValue),
          source: secretValue ? 'secret' : configValue ? 'config' : 'missing',
        };
      }));

      return res.json({
        desktop: config.get('ALLEN_DESKTOP') === '1',
        paths: {
          allenHome: config.get('ALLEN_HOME') ?? null,
          workspaceBaseDir: config.get('WORKSPACE_BASE_DIR') ?? null,
        },
        runtime: {
          terminalWsPort: config.get('TERMINAL_WS_PORT') ?? null,
          mongoUriConfigured: Boolean(config.get('MONGODB_URI')),
          managedMongo: config.get('ALLEN_DESKTOP') === '1' && !config.get('MONGODB_URI'),
        },
        secrets: secretStatus,
      });
    } catch (err) {
      console.error('[system/desktop-runtime]', err);
      return res.status(500).json({ error: 'desktop_runtime_status_failed' });
    }
  });

  router.get('/desktop-runtime/settings', requireAuth, async (_req: AuthedRequest, res: Response) => {
    try {
      return res.json(await desktopRuntimeSettingsPayload(db));
    } catch (err) {
      console.error('[system/desktop-runtime/settings]', err);
      return res.status(500).json({ error: 'desktop_runtime_settings_failed' });
    }
  });

  router.patch('/desktop-runtime/settings', requireAuth, async (req: AuthedRequest, res: Response) => {
    try {
      const config = getRuntimeConfigProvider();
      if (config.get('ALLEN_DESKTOP') !== '1') {
        return res.status(400).json({ error: 'desktop_runtime_settings_are_desktop_only' });
      }
      const configPath = config.get('ALLEN_DESKTOP_CONFIG_PATH');
      if (!configPath) {
        return res.status(400).json({ error: 'desktop_runtime_config_path_missing' });
      }

      const values = req.body?.values;
      if (!values || typeof values !== 'object' || Array.isArray(values)) {
        return res.status(400).json({ error: 'values_required' });
      }

      const persisted = readDesktopRuntimeConfigFile(configPath);
      for (const [key, rawValue] of Object.entries(values as Record<string, unknown>)) {
        const field = DESKTOP_RUNTIME_SETTING_DEFS.get(key);
        if (!field) return res.status(400).json({ error: `unsupported_runtime_setting:${key}` });
        if (field.readOnly) continue;
        const normalized = normalizeRuntimeSettingValue(field, rawValue);
        if (normalized === undefined) {
          delete persisted[key];
          updateRuntimeProviderValue(key, undefined);
        } else {
          persisted[key] = normalized;
          updateRuntimeProviderValue(key, normalized);
        }
      }

      writeDesktopRuntimeConfigFile(configPath, persisted);
      return res.json(await desktopRuntimeSettingsPayload(db));
    } catch (err) {
      const message = (err as Error).message;
      const status = message.startsWith('invalid_value:') ? 400 : 500;
      console.error('[system/desktop-runtime/settings:update]', err);
      return res.status(status).json({ error: message });
    }
  });

  router.post('/desktop-runtime/onboarding/model-defaults', requireAuth, requireAdmin, async (req: AuthedRequest, res: Response) => {
    try {
      const config = getRuntimeConfigProvider();
      if (config.get('ALLEN_DESKTOP') !== '1') {
        return res.status(400).json({ error: 'desktop_model_defaults_are_desktop_only' });
      }
      const configPath = config.get('ALLEN_DESKTOP_CONFIG_PATH');
      if (!configPath) {
        return res.status(400).json({ error: 'desktop_runtime_config_path_missing' });
      }

      const chatProviderRaw = String(req.body?.chatProvider ?? '').trim();
      const agentProviderRaw = String(req.body?.agentProvider ?? '').trim();
      const agentModel = String(req.body?.agentModel ?? '').trim();
      if (!isProviderValue(chatProviderRaw)) {
        return res.status(400).json({ error: 'invalid_chat_provider' });
      }
      if (agentProviderRaw && !isProviderValue(agentProviderRaw)) {
        return res.status(400).json({ error: 'invalid_agent_provider' });
      }
      await validateAgentModelForProvider(agentProviderRaw as ProviderOptionValue | '', agentModel, db);

      const persisted = readDesktopRuntimeConfigFile(configPath);
      persisted.ALLEN_DEFAULT_CHAT_PROVIDER = chatProviderRaw;
      updateRuntimeProviderValue('ALLEN_DEFAULT_CHAT_PROVIDER', chatProviderRaw);
      if (agentProviderRaw) {
        persisted.ALLEN_DEFAULT_AGENT_PROVIDER = agentProviderRaw;
        updateRuntimeProviderValue('ALLEN_DEFAULT_AGENT_PROVIDER', agentProviderRaw);
      } else {
        delete persisted.ALLEN_DEFAULT_AGENT_PROVIDER;
        updateRuntimeProviderValue('ALLEN_DEFAULT_AGENT_PROVIDER', undefined);
      }
      if (agentProviderRaw && agentModel) {
        persisted.ALLEN_DEFAULT_AGENT_MODEL = agentModel;
        updateRuntimeProviderValue('ALLEN_DEFAULT_AGENT_MODEL', agentModel);
      } else {
        delete persisted.ALLEN_DEFAULT_AGENT_MODEL;
        updateRuntimeProviderValue('ALLEN_DEFAULT_AGENT_MODEL', undefined);
      }
      writeDesktopRuntimeConfigFile(configPath, persisted);

      await refreshDesktopSeedDefaults(db);

      // ALLEN_DEFAULT_AGENT_PROVIDER and ALLEN_DEFAULT_AGENT_MODEL are
      // onboarding-only — they set the initial provider/model flattening for
      // the seed, then must be cleaned up so they never re-fire on subsequent
      // restarts. If we keep them in the config file, setupDesktopRuntime
      // forwards them to process.env, resolveAgentProviderModel reads them
      // back, and ALL agents get overwritten to the onboarding provider on
      // every app start — even with SEED_OVERRIDE disabled.
      delete process.env.ALLEN_DEFAULT_AGENT_PROVIDER;
      delete process.env.ALLEN_DEFAULT_AGENT_MODEL;
      delete persisted.ALLEN_DEFAULT_AGENT_PROVIDER;
      delete persisted.ALLEN_DEFAULT_AGENT_MODEL;
      writeDesktopRuntimeConfigFile(configPath, persisted);

      return res.json({
        chatProvider: chatProviderRaw,
        agentProvider: agentProviderRaw,
        agentModel: agentProviderRaw ? agentModel : '',
        settings: await desktopRuntimeSettingsPayload(db),
      });
    } catch (err) {
      const message = (err as Error).message;
      const status = [
        'agent_model_requires_agent_provider',
        'invalid_agent_model_for_provider',
      ].includes(message) ? 400 : 500;
      console.error('[system/desktop-runtime/onboarding/model-defaults]', err);
      return res.status(status).json({ error: message });
    }
  });

  router.post('/desktop-runtime/context/cognee/setup', requireAuth, async (req: AuthedRequest, res: Response) => {
    try {
      const config = getRuntimeConfigProvider();
      if (config.get('ALLEN_DESKTOP') !== '1') {
        return res.status(400).json({ error: 'desktop_context_setup_is_desktop_only' });
      }
      const configPath = config.get('ALLEN_DESKTOP_CONFIG_PATH');
      if (!configPath) {
        return res.status(400).json({ error: 'desktop_runtime_config_path_missing' });
      }

      const requestedProvider = typeof req.body?.provider === 'string' ? req.body.provider : '';
      const provider = COGNEE_CONTEXT_PROVIDERS.has(requestedProvider) ? requestedProvider : 'cognee';
      const setupResult = await runDesktopCogneeSetup(configPath, provider);

      return res.json({
        ...setupResult,
        settings: await desktopRuntimeSettingsPayload(db),
      });
    } catch (err) {
      const message = (err as Error).message;
      const status = message === 'context_setup_script_missing' ? 404 : 500;
      console.error('[system/desktop-runtime/context/cognee/setup]', err);
      return res.status(status).json({ error: message });
    }
  });

  router.put('/desktop-runtime/secrets', requireAuth, async (req: AuthedRequest, res: Response) => {
    try {
      const key = await validateRuntimeSecretKey(req.body?.key, db);
      const value = String(req.body?.value ?? '');
      if (!value.trim()) return res.status(400).json({ error: 'secret_value_required' });
      const secrets = getRuntimeSecretsProvider();
      if (!secrets.setSecret) return res.status(400).json({ error: 'runtime_secrets_are_read_only' });
      await secrets.setSecret(key, value);
      process.env[key] = value;
      return res.json({ key, configured: true, source: 'secret' });
    } catch (err) {
      const message = (err as Error).message;
      const status = message === 'unsupported_secret_key' ? 400 : 500;
      return res.status(status).json({ error: message });
    }
  });

  router.delete('/desktop-runtime/secrets/:key', requireAuth, async (req: AuthedRequest, res: Response) => {
    try {
      const config = getRuntimeConfigProvider();
      if (config.get('ALLEN_DESKTOP') !== '1') return res.status(400).json({ error: 'desktop_runtime_only' });
      const key = await validateRuntimeSecretKey(req.params.key, db);
      const secrets = getRuntimeSecretsProvider();
      if (!secrets.deleteSecret) return res.status(400).json({ error: 'runtime_secrets_are_read_only' });
      await secrets.deleteSecret(key);
      (config as { delete?: (runtimeKey: string) => void }).delete?.(key);
      delete process.env[key];
      return res.status(204).send();
    } catch (err) {
      const message = (err as Error).message;
      const status = message === 'unsupported_secret_key' ? 400 : 500;
      return res.status(status).json({ error: message });
    }
  });

  router.get('/onboarding-progress', requireAuth, async (req: AuthedRequest, res: Response) => {
    try {
      const userId = req.user?.sub;
      if (!userId) return res.status(401).json({ error: 'unauthorized' });
      if (req.user?.role !== 'admin') {
        return res.json({
          complete: true,
          skipped: false,
          step: 'complete',
          completedAt: null,
          skippedAt: null,
        });
      }
      void userId;
      return res.json(await adminSetupProgress(db));
    } catch (err) {
      console.error('[system/onboarding-progress]', err);
      return res.status(500).json({ error: 'onboarding_progress_failed' });
    }
  });

  router.patch('/onboarding-progress', requireAuth, async (req: AuthedRequest, res: Response) => {
    try {
      const userId = req.user?.sub;
      if (!userId) return res.status(401).json({ error: 'unauthorized' });
      if (req.user?.role !== 'admin') return res.status(403).json({ error: 'admin_only' });

      const step = typeof req.body?.step === 'string' ? req.body.step : undefined;
      const action = typeof req.body?.action === 'string' ? req.body.action : undefined;
      if (step && !ONBOARDING_STEPS.has(step)) {
        return res.status(400).json({ error: 'invalid_onboarding_step' });
      }
      if (action && action !== 'complete' && action !== 'skip') {
        return res.status(400).json({ error: 'invalid_onboarding_action' });
      }

      const now = new Date();
      const currentUser = await db.collection('users').findOne(
        { _id: new ObjectId(userId) },
        { projection: { onboarding: 1 } },
      );
      const currentOnboarding = (currentUser?.onboarding ?? {}) as Record<string, unknown>;
      const currentProgress = onboardingProgressPayload(currentOnboarding);
      if (!action && currentProgress.complete) {
        return res.json(currentProgress);
      }

      const set: Record<string, unknown> = {
        'onboarding.updatedAt': now,
      };
      const unset: Record<string, ''> = {};
      if (step) set['onboarding.step'] = step;
      if (action === 'complete') {
        set['onboarding.step'] = 'complete';
        set['onboarding.completedAt'] = now;
        unset['onboarding.skippedAt'] = '';
      }
      if (action === 'skip') {
        set['onboarding.step'] = 'complete';
        set['onboarding.skippedAt'] = now;
        unset['onboarding.completedAt'] = '';
      }

      const update: Record<string, unknown> = { $set: set };
      if (Object.keys(unset).length > 0) update.$unset = unset;
      await db.collection('users').updateOne({ _id: new ObjectId(userId) }, update);
      return res.json(onboardingProgressPayload({
        ...currentOnboarding,
        ...(step ? { step } : {}),
        ...(action === 'complete' ? { step: 'complete', completedAt: now, skippedAt: undefined } : {}),
        ...(action === 'skip' ? { step: 'complete', skippedAt: now, completedAt: undefined } : {}),
        updatedAt: now,
      }));
    } catch (err) {
      console.error('[system/onboarding-progress]', err);
      return res.status(500).json({ error: 'onboarding_progress_failed' });
    }
  });

  // POST /api/system/verify-ssh
  //
  // Verifies SSH auth for Git hosting without exposing raw command output.
  router.post('/verify-ssh', async (req: Request, res: Response) => {
    try {
      const host = sanitizeSshHost(req.body?.host);
      const { stdout, stderr, timedOut } = await runSshAuthCheck(host);
      const text = `${stdout}\n${stderr}`;
      const ok = /successfully authenticated|authenticated/i.test(text);
      return res.json({
        ok,
        host,
        detail: ok
          ? `SSH authentication to ${host} is working.`
          : timedOut
            ? `SSH authentication to ${host} timed out.`
            : `SSH did not confirm authentication to ${host}.`,
        fix: ok ? undefined : {
          summary: `Add an SSH key to ${host}, then retry.`,
          commands: [`ssh -T git@${host}`],
          docsPath: 'docs/first-workflow.md',
        },
      });
    } catch (err) {
      const message = (err as Error).message;
      const host = (() => {
        try { return sanitizeSshHost(req.body?.host); } catch { return 'github.com'; }
      })();
      return res.json({
        ok: false,
        host,
        detail: message === 'Invalid SSH host'
          ? message
          : `SSH authentication to ${host} failed or timed out.`,
        fix: {
          summary: `Add an SSH key to ${host}, then retry.`,
          commands: [`ssh -T git@${host}`],
          docsPath: 'docs/first-workflow.md',
        },
      });
    }
  });

  // ════════════════════════════════════════════════════════════════════════════
  // Model Registry API (REQ-006)
  // ════════════════════════════════════════════════════════════════════════════

  const modelRegistry = new ModelRegistryService(db);

  /**
   * POST /api/system/providers/:provider/recheck-auth
   * CLI providers only (claude, codex). Bypasses the auth-status cache and
   * re-runs the CLI login check — backs the "Check again" button in Settings.
   */
  router.post('/providers/:provider/recheck-auth', requireAuth, async (req: AuthedRequest, res: Response) => {
    try {
      const { getCliAuthStatus, isCliProvider, cliLoginCommand } = await import('../services/cli-auth.service.js');
      const provider = String(req.params.provider);
      if (!isCliProvider(provider)) {
        return res.status(400).json({ error: 'not_a_cli_provider' });
      }
      const authStatus = await getCliAuthStatus(provider, { fresh: true });
      return res.json({
        provider,
        authStatus,
        ...(authStatus !== 'logged_in' ? { loginCommand: cliLoginCommand(provider) } : {}),
      });
    } catch (err) {
      console.error('[system/providers:recheck-auth]', err);
      return res.status(500).json({ error: 'recheck_auth_failed' });
    }
  });

  /**
   * GET /api/system/models
   * Public — needed for unauthenticated onboarding
   * Query params: includeInactive (boolean), provider (string, optional)
   */
  router.get('/models', async (req: Request, res: Response) => {
    try {
      const includeInactive = req.query.includeInactive === 'true';
      const provider = typeof req.query.provider === 'string' ? req.query.provider : undefined;
      const models = await modelRegistry.list({ includeInactive, provider });
      return res.json({ models });
    } catch (err) {
      console.error('[system/models:list]', err);
      return res.status(500).json({ error: 'model_registry_list_failed' });
    }
  });

  /**
   * GET /api/system/models/recovery
   * Public — returns active models grouped by provider for the recovery
   * dropdown in the model-recovery UI.
   */
  router.get('/models/recovery', async (req: Request, res: Response) => {
    try {
      const groups = await modelRegistry.listAvailableForRecovery();
      return res.json({ providers: groups });
    } catch (err) {
      console.error('[system/models/recovery]', err);
      return res.status(500).json({ error: 'model_registry_recovery_failed' });
    }
  });

  /**
   * GET /api/system/models/:id
   * Public — returns single model or 404
   */
  router.get('/models/:id', async (req: Request, res: Response) => {
    try {
      const model = await modelRegistry.getById(String(req.params.id));
      if (!model) return res.status(404).json({ error: 'model_not_found' });
      return res.json(model);
    } catch (err) {
      const message = (err as Error).message;
      if (message.includes('ObjectId')) return res.status(400).json({ error: 'invalid_model_id' });
      console.error('[system/models:get]', err);
      return res.status(500).json({ error: 'model_registry_get_failed' });
    }
  });

  /**
   * POST /api/system/models
   * Requires admin. Creates a new model registry entry.
   */
  router.post('/models', requireAuth, requireAdmin, async (req: AuthedRequest, res: Response) => {
    try {
      const model = await modelRegistry.create({
        provider: String(req.body.provider ?? ''),
        fullId: String(req.body.fullId ?? ''),
        displayName: req.body.displayName,
        providerDisplayName: String(req.body.providerDisplayName ?? ''),
        costInputPerMTok: req.body.costInputPerMTok,
        costOutputPerMTok: req.body.costOutputPerMTok,
        costCacheReadPerMTok: req.body.costCacheReadPerMTok,
        tier: req.body.tier ?? null,
        sortOrder: req.body.sortOrder ?? 0,
      });
      invalidateModelCostCache();
      return res.status(201).json(model);
    } catch (err) {
      const message = (err as Error).message;
      if (message === 'DUPLICATE_PROVIDER_FULL_ID') return res.status(409).json({ error: 'duplicate_provider_full_id' });
      if (message.startsWith('UNKNOWN_PROVIDER') || message.startsWith('DISPLAY_NAME_') || message.startsWith('PROVIDER_DISPLAY_NAME_') || message.startsWith('FULL_ID_') || message.startsWith('INVALID_') || message.startsWith('TIER_')) {
        return res.status(400).json({ error: message });
      }
      console.error('[system/models:create]', err);
      return res.status(500).json({ error: 'model_registry_create_failed' });
    }
  });

  /**
   * PATCH /api/system/models/:id
   * Requires admin. Partial update. Provider and fullId are immutable.
   */
  router.patch('/models/:id', requireAuth, requireAdmin, async (req: AuthedRequest, res: Response) => {
    try {
      // Immutable fields guard — reject only actual CHANGES. Clients that
      // echo the full form object back (unchanged provider/fullId) must not
      // fail a cost-only edit.
      if (req.body.provider !== undefined || req.body.fullId !== undefined) {
        const existing = await modelRegistry.getById(String(req.params.id));
        if (!existing) return res.status(404).json({ error: 'model_not_found' });
        const providerChanged = req.body.provider !== undefined && req.body.provider !== existing.provider;
        const fullIdChanged = req.body.fullId !== undefined && req.body.fullId !== existing.fullId;
        if (providerChanged || fullIdChanged) {
          return res.status(400).json({ error: 'provider_and_fullid_are_immutable' });
        }
      }
      const model = await modelRegistry.update(String(req.params.id), {
        fullId: req.body.fullId,
        displayName: req.body.displayName,
        providerDisplayName: req.body.providerDisplayName,
        costInputPerMTok: req.body.costInputPerMTok,
        costOutputPerMTok: req.body.costOutputPerMTok,
        costCacheReadPerMTok: req.body.costCacheReadPerMTok,
        tier: req.body.tier,
        sortOrder: req.body.sortOrder,
        isActive: req.body.isActive,
      });
      if (!model) return res.status(404).json({ error: 'model_not_found' });
      invalidateModelCostCache();
      return res.json(model);
    } catch (err) {
      const message = (err as Error).message;
      if (message === 'INVALID_TIER') return res.status(400).json({ error: message });
      if (message.includes('ObjectId')) return res.status(400).json({ error: 'invalid_model_id' });
      console.error('[system/models:update]', err);
      return res.status(500).json({ error: 'model_registry_update_failed' });
    }
  });

  /**
   * DELETE /api/system/models/:id
   * Requires admin. Soft-deletes by setting isActive=false.
   */
  router.delete('/models/:id', requireAuth, requireAdmin, async (req: AuthedRequest, res: Response) => {
    try {
      const model = await modelRegistry.softDelete(String(req.params.id));
      if (!model) return res.status(404).json({ error: 'model_not_found' });
      invalidateModelCostCache();
      return res.json({ deleted: true, model });
    } catch (err) {
      const message = (err as Error).message;
      if (message.includes('ObjectId')) return res.status(400).json({ error: 'invalid_model_id' });
      console.error('[system/models:delete]', err);
      return res.status(500).json({ error: 'model_registry_delete_failed' });
    }
  });

  return router;
}
