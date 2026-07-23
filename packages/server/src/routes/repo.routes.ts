import { Router, type Request, type Response } from 'express';
import { RepoService } from '../services/repo.service.js';
import { RepoContextPacketService } from '../services/context/core/repo-context-packet.service.js';
import { isRecord, sha256 } from '../services/context/common/context-utils.js';
import { CogneeMemoryService } from '../services/context/cognee/cognee-memory.service.js';
import { RepoContextCurationService } from '../services/context/curation/repo-context-curation.service.js';
import { RepoMandatoryContextService } from '../services/context/mandatory/repo-mandatory-context.service.js';
import { RepoContextSetupService, SETUP_RUNS_COLLECTION } from '../services/context/setup/repo-context-setup.service.js';
import { RepoContextGraphService } from '../services/context/graph/repo-context-graph.service.js';
import { RepoContextEngine } from '../services/context/core/repo-context-engine.js';
import { WorkflowContextInjectionAdapter, summarizeInjection } from '../services/context/core/workflow-context-injection-adapter.js';
import { CuratedContextEditorService } from '../services/context/judge/curated-context-editor.service.js';
import { RepoContextPortabilityService } from '../services/context/portability/repo-context-portability.service.js';
import { isCogneeContextEnabled, isContextEngineEnabled } from '../services/context/config/context-provider-config.js';
import { executeChatTool } from '../services/chat-tools.js';
import { notDeletedFilter } from '../services/soft-delete.js';
import { param } from '../types.js';
import { ObjectId, type Db } from 'mongodb';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'];
const VIDEO_MIME_TYPES: Record<string, string> = {
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  m4v: 'video/x-m4v',
  ogv: 'video/ogg',
};

type ErrorPayload = { error: string; code?: string };

function contextProviderDisabledPayload(error = 'Context provider is disabled. Set ALLEN_CONTEXT_PROVIDER to enable context engine flows.'): Record<string, unknown> {
  return { error, code: 'CONTEXT_PROVIDER_DISABLED' };
}

/** Q6: shared error→HTTP mapping for the context-setup handlers. */
const CONTEXT_SETUP_ERROR_STATUS: Record<string, number> = {
  REPO_NOT_FOUND: 404,
  RUN_NOT_FOUND: 404,
  RUN_NOT_CANCELLABLE: 409,
  RUN_NOT_RESUMABLE: 409,
  INVALID_REPO_PATH: 400,
  INVALID_OPTIONS: 400,
};

function sendContextSetupError(res: Response, err: unknown, fallbackStatus = 400): void {
  const e = err as Error & { code?: string; statusCode?: number };
  const status = e.statusCode ?? (e.code ? CONTEXT_SETUP_ERROR_STATUS[e.code] : undefined) ?? fallbackStatus;
  const payload: ErrorPayload = { error: e.message, code: e.code };
  res.status(status).json(payload);
}

function activeCurationEntries(entries: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return entries.filter((entry) => entry.active !== false && entry.inclusion === 'include');
}

function curationEntryStats(entries: Array<Record<string, unknown>>): Record<string, number> {
  const uniqueEntries = uniqueCurationEntries(entries);
  return {
    total: entries.length,
    unique: uniqueEntries.length,
    active: uniqueEntries.filter((entry) => entry.inclusion === 'include').length,
    excluded: uniqueEntries.filter((entry) => entry.inclusion === 'exclude').length,
    stale: uniqueEntries.filter((entry) => entry.inclusion === 'stale').length,
  };
}

function uniqueCurationEntries(entries: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const byKey = new Map<string, Record<string, unknown>>();
  for (const entry of entries) {
    const key = String(entry.entryId ?? entry.path ?? '');
    if (!key) continue;
    const existing = byKey.get(key);
    if (!existing || curationEntryTime(entry) >= curationEntryTime(existing)) byKey.set(key, entry);
  }
  return Array.from(byKey.values());
}

function curationEntryTime(entry: Record<string, unknown>): number {
  const value = new Date(String(entry.updatedAt ?? entry.createdAt ?? 0)).getTime();
  return Number.isFinite(value) ? value : 0;
}

function numberQuery(value: unknown, fallback: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), max);
}

function stringArrayValue(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).map((item) => item.trim()).filter(Boolean);
  if (typeof value === 'string') return value.split(',').map((item) => item.trim()).filter(Boolean);
  return [];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value.trim() : undefined;
}

function normalizeCurationChunks(value: unknown): Array<Record<string, unknown>> | undefined {
  if (!Array.isArray(value)) return undefined;
  return value
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
    .map((item, index) => ({
      chunkId: stringValue(item.chunkId) || `chunk-${index + 1}`,
      heading: stringValue(item.heading) || `Chunk ${index + 1}`,
      text: stringValue(item.text) || '',
      targetGlobs: stringArrayValue(item.targetGlobs),
      targetRoles: stringArrayValue(item.targetRoles),
      sourceAnchors: stringArrayValue(item.sourceAnchors),
    }))
    .filter((chunk) => String(chunk.text ?? '').trim());
}

function curationContentPatch(body: Record<string, unknown>): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if (typeof body.curatedContext === 'string') patch.curatedContext = body.curatedContext;
  if (typeof body.retrievalText === 'string') patch.retrievalText = body.retrievalText;
  const chunks = normalizeCurationChunks(body.chunks);
  if (chunks) patch.chunks = chunks;
  if (typeof body.title === 'string') patch.title = body.title.trim();
  if (typeof body.path === 'string') patch.path = body.path.trim();
  if (typeof body.summary === 'string') patch.summary = body.summary.trim();
  if (typeof body.category === 'string') patch.category = body.category.trim() || 'manual';
  if (typeof body.inclusion === 'string') patch.inclusion = body.inclusion;
  const injectionPolicy = normalizeManualInjectionPolicy(body.injectionPolicy);
  if (injectionPolicy) patch.injectionPolicy = injectionPolicy;
  return patch;
}

const MANUAL_CURATION_POLICIES = new Set(['snippet', 'manifest_only', 'never_full_auto']);

function normalizeManualInjectionPolicy(value: unknown): string | undefined {
  if (value === 'mandatory_full') return 'snippet';
  if (typeof value !== 'string') return undefined;
  return MANUAL_CURATION_POLICIES.has(value) ? value : undefined;
}

function hasGeneratedCurationContent(value: Record<string, unknown>): boolean {
  return Boolean(
    stringValue(value.curatedContext)
    || stringValue(value.retrievalText)
    || (Array.isArray(value.chunks) && value.chunks.some((chunk) => Boolean(chunk && typeof chunk === 'object' && stringValue((chunk as Record<string, unknown>).text)))),
  );
}

const MAX_PLAYGROUND_TEXT_CHARS = 40_000;

function playgroundText(value: unknown): string | undefined {
  const text = stringValue(value);
  if (!text) return undefined;
  return text.length > MAX_PLAYGROUND_TEXT_CHARS
    ? `${text.slice(0, MAX_PLAYGROUND_TEXT_CHARS)}\n\n[truncated ${text.length - MAX_PLAYGROUND_TEXT_CHARS} chars]`
    : text;
}

async function loadLatestCurationEntryForPlayground(
  db: Db,
  repoId: string,
  entryId?: string,
  path?: string,
): Promise<Record<string, unknown> | undefined> {
  const clauses: Array<Record<string, unknown>> = [];
  if (entryId) clauses.push({ entryId });
  if (path) clauses.push({ path });
  if (!clauses.length) return undefined;
  const rows = await db.collection('repo_context_curation_entries')
    .find({ repoId, active: { $ne: false }, $or: clauses })
    .sort({ updatedAt: -1, createdAt: -1 })
    .limit(20)
    .toArray()
    .catch(() => []);
  return rows.find(hasGeneratedCurationContent) ?? rows[0];
}

async function enrichPlaygroundRefs(
  db: Db,
  repoId: string,
  refs: Array<Record<string, unknown>>,
): Promise<Array<Record<string, unknown>>> {
  const cache = new Map<string, Promise<Record<string, unknown> | undefined>>();
  return Promise.all(refs.map(async (ref) => {
    const providerMetadata = isRecord(ref.providerMetadata) ? ref.providerMetadata : {};
    if (ref.mandatory === true) {
      return {
        ...ref,
        playgroundContent: {
          mandatoryOnly: true,
          resolution: {
            path: stringValue(ref.path),
            providerId: stringValue(ref.providerId),
            mappingId: stringValue(providerMetadata.mappingId),
            agentName: stringValue(providerMetadata.agentName),
          },
          mandatoryContext: playgroundText(ref.content),
        },
      };
    }
    const sourceMetadata = isRecord(providerMetadata.sourceMetadata) ? providerMetadata.sourceMetadata : {};
    const entryId = stringValue(providerMetadata.curationEntryId) || stringValue(sourceMetadata.entryId) || stringValue(sourceMetadata.entry_id);
    const label = stringValue(providerMetadata.label) || stringValue(sourceMetadata.label);
    const path = stringValue(ref.path) || stringValue(sourceMetadata.path);
    const providerResolutionMethod = stringValue(providerMetadata.curationResolutionMethod);
    const cacheKey = `${entryId ?? ''}\0${path ?? ''}`;
    let entry: Record<string, unknown> | undefined;
    if (entryId || path) {
      if (!cache.has(cacheKey)) cache.set(cacheKey, loadLatestCurationEntryForPlayground(db, repoId, entryId, path));
      entry = await cache.get(cacheKey);
    }
    const chunks = Array.isArray(entry?.chunks)
      ? entry.chunks.filter(isRecord).map((chunk) => ({
        chunkId: stringValue(chunk.chunkId),
        heading: stringValue(chunk.heading),
        text: playgroundText(chunk.text),
      }))
      : undefined;
    return {
      ...ref,
      playgroundContent: {
        resolution: {
          entryId,
          label,
          path,
          curationEntryFound: Boolean(entry),
          method: providerResolutionMethod || (entry ? 'playground_display_fallback' : 'unresolved'),
          playgroundOnlyFallback: !providerResolutionMethod && Boolean(entry),
          curationEntryLookup: entryId || path ? { repoId, entryId, path } : undefined,
        },
        cogneeChunkText: playgroundText(providerMetadata.cogneeChunkText) || (ref.providerId === 'cognee_memory' ? playgroundText(ref.content) : undefined),
        selectedContent: playgroundText(ref.content),
        curatedContext: playgroundText(entry?.curatedContext),
        retrievalText: playgroundText(entry?.retrievalText),
        chunks,
        mandatoryContext: ref.mandatory ? playgroundText(ref.content) : undefined,
      },
    };
  }));
}

function playgroundRefs(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => isRecord(item)) : [];
}

function stableManualCurationEntryId(repoId: string, body: Record<string, unknown>): string {
  const seed = stringValue(body.path) || stringValue(body.title) || randomUUID();
  const slug = seed.toLowerCase().replace(/[^a-z0-9._/-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 160) || randomUUID();
  return `manual:${repoId}:${slug}`;
}

function safeRepoPath(repoPath: string, rawPath: string): string | null {
  const root = resolve(repoPath);
  const fullPath = resolve(root, rawPath);
  return fullPath === root || fullPath.startsWith(`${root}${sep}`) ? fullPath : null;
}

async function listRepoFiles(repoPath: string): Promise<Array<{ path: string; isDir: boolean }>> {
  const execOptions = { cwd: repoPath, timeout: 10_000 };
  const [tracked, untracked] = await Promise.all([
    exec('git', ['ls-files'], execOptions).catch(() => ({ stdout: '' })),
    exec('git', ['ls-files', '--others', '--exclude-standard'], execOptions).catch(() => ({ stdout: '' })),
  ]);
  const ignored = ['.git', 'node_modules/', '.DS_Store', 'dist/', '.turbo/', 'coverage/', '.next/'];
  return Array.from(new Set([
    ...tracked.stdout.trim().split('\n').filter(Boolean),
    ...untracked.stdout.trim().split('\n').filter(Boolean),
  ]))
    .filter(file => !ignored.some(ig => file.startsWith(ig) || file.includes(`/${ig}`)))
    .sort()
    .map(path => ({ path, isDir: false }));
}

function readRepoFile(repoPath: string, rawFilePath: string): Record<string, unknown> {
  const fullPath = safeRepoPath(repoPath, rawFilePath);
  if (!fullPath) {
    const err = new Error('Path traversal blocked') as Error & { status?: number };
    err.status = 403;
    throw err;
  }
  if (!existsSync(fullPath)) {
    const err = new Error('File not found') as Error & { status?: number };
    err.status = 404;
    throw err;
  }
  const stats = statSync(fullPath);
  if (!stats.isFile()) {
    const err = new Error('Path is not a file') as Error & { status?: number };
    err.status = 400;
    throw err;
  }
  const ext = extname(rawFilePath).slice(1).toLowerCase();
  const isImage = IMAGE_EXTENSIONS.includes(ext);
  const isVideo = Boolean(VIDEO_MIME_TYPES[ext]);
  if (isImage || isVideo) {
    const maxMediaSize = (isVideo ? 100 : 50) * 1024 * 1024;
    if (stats.size > maxMediaSize) {
      const err = new Error(`${isVideo ? 'Video' : 'Image'} file too large (max ${isVideo ? 100 : 50}MB)`) as Error & { status?: number };
      err.status = 413;
      throw err;
    }
    return {
      path: rawFilePath,
      content: readFileSync(fullPath).toString('base64'),
      isImage,
      isVideo,
      mimeType: isVideo
        ? VIDEO_MIME_TYPES[ext]
        : `image/${ext === 'jpg' ? 'jpeg' : ext === 'svg' ? 'svg+xml' : ext}`,
    };
  }
  const maxTextSize = 10 * 1024 * 1024;
  if (stats.size > maxTextSize) {
    const err = new Error('Text file too large (max 10MB)') as Error & { status?: number };
    err.status = 413;
    throw err;
  }
  return { path: rawFilePath, content: readFileSync(fullPath, 'utf-8'), isImage: false };
}

function repoBranchDebug(repo: Record<string, unknown> | null | undefined) {
  if (!repo) return null;
  const detected = repo.detected as { defaultBranch?: unknown } | undefined;
  return {
    id: String(repo._id ?? ''),
    name: stringValue(repo.name),
    path: stringValue(repo.path),
    branch: stringValue(repo.branch),
    defaultBranch: stringValue(repo.defaultBranch),
    detectedDefaultBranch: stringValue(detected?.defaultBranch),
  };
}

export function repoRoutes(db: Db): Router {
  const router = Router();
  const service = new RepoService(db);
  const repoContextPacket = new RepoContextPacketService(db);
  const cogneeMemory = new CogneeMemoryService(db);
  const contextCuration = new RepoContextCurationService(db);
  const mandatoryContext = new RepoMandatoryContextService(db);
  const contextGraph = new RepoContextGraphService(db, cogneeMemory, mandatoryContext);
  const curatedContextEditor = new CuratedContextEditorService(db);
  const portabilityService = new RepoContextPortabilityService(db);

  // Setup service — DO NOT create new CogneeMemoryService; reuse existing instance
  const spawnAgentFn = (args: Record<string, unknown>, spawnDb: Db) =>
    executeChatTool('spawn_agent', args, spawnDb).then((r) => ({ execution_id: String(r.execution_id ?? '') }));
  const setupService = new RepoContextSetupService(db, contextCuration, mandatoryContext, cogneeMemory, spawnAgentFn);

  // GET /api/repos
  router.get('/', async (_req: Request, res: Response) => {
    try {
      const repos = await service.list();
      console.info('[workspace-create-debug] repo api list', {
        count: repos.length,
        repos: repos.map(repoBranchDebug),
      });
      res.json(repos);
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // POST /api/repos — create from local path (legacy)
  router.post('/', async (req: Request, res: Response) => {
    try {
      const repo = await service.create(req.body);
      res.status(201).json(repo);
    } catch (err: unknown) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // POST /api/repos/validate-local — preflight local repo connection
  router.post('/validate-local', async (req: Request, res: Response) => {
    try {
      const { path } = req.body ?? {};
      const result = await service.validateLocalPath(String(path ?? ''));
      res.json(result);
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // POST /api/repos/validate-clone — preflight GitHub clone connection
  router.post('/validate-clone', async (req: Request, res: Response) => {
    try {
      const result = await service.validateCloneUrl(req.body ?? {});
      res.json(result);
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // POST /api/repos/clone — clone from GitHub URL and register
  router.post('/clone', async (req: Request, res: Response) => {
    try {
      const { url, branch, name, description, tags } = req.body;
      if (!url) return res.status(400).json({ error: 'url is required' });
      const repo = await service.createFromUrl({ url, branch, name, description, tags });
      res.status(201).json(repo);
    } catch (err: unknown) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // GET /api/repos/context?path=... — path-based context lookup (used by MCP tool)
  // MUST be registered BEFORE GET /:id, otherwise Express matches /:id first with
  // id="context" and the ObjectId() call throws.
  router.get('/context', async (req: Request, res: Response) => {
    try {
      const path = String(req.query.path ?? '');
      if (!path) return res.status(400).json({ error: 'path query param is required' });
      const ctx = await service.getContextByPath(path);
      if (!ctx) return res.status(404).json({ error: 'No context found for that path' });
      res.json(ctx);
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // POST /api/repos/context-curation/prepare — coordinator setup for repo context curation.
  router.post('/context-curation/prepare', async (req: Request, res: Response) => {
    try {
      if (!isContextEngineEnabled()) return res.status(409).json(contextProviderDisabledPayload('Context provider is disabled.'));
      const result = await contextCuration.prepareForCoordinator(req.body ?? {});
      res.status(201).json(result);
    } catch (err: unknown) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // POST /api/repos/context-curation/assignments — coordinator registers worker file assignments.
  router.post('/context-curation/assignments', async (req: Request, res: Response) => {
    try {
      if (!isContextEngineEnabled()) return res.status(409).json(contextProviderDisabledPayload('Context provider is disabled.'));
      const result = await contextCuration.registerAssignmentsFromAgent(req.body ?? {});
      res.status(201).json(result);
    } catch (err: unknown) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // POST /api/repos/context-curation/assignment-plan — deterministic worker batches for coordinator fanout.
  router.post('/context-curation/assignment-plan', async (req: Request, res: Response) => {
    try {
      if (!isContextEngineEnabled()) return res.status(409).json(contextProviderDisabledPayload('Context provider is disabled.'));
      const result = await contextCuration.planAssignmentsFromAgent(req.body ?? {});
      res.status(201).json(result);
    } catch (err: unknown) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // POST /api/repos/context-curation/stage-status — validate temporary curation staging rows.
  router.post('/context-curation/stage-status', async (req: Request, res: Response) => {
    try {
      if (!isContextEngineEnabled()) return res.status(409).json(contextProviderDisabledPayload('Context provider is disabled.'));
      const result = await contextCuration.getStageStatusFromAgent(req.body ?? {});
      res.json(result);
    } catch (err: unknown) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // POST /api/repos/context-curation/promote — atomically copy validated staging rows into final collections.
  router.post('/context-curation/promote', async (req: Request, res: Response) => {
    try {
      if (!isContextEngineEnabled()) return res.status(409).json(contextProviderDisabledPayload('Context provider is disabled.'));
      const result = await contextCuration.promoteStageFromAgent(req.body ?? {});
      res.status(201).json(result);
    } catch (err: unknown) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // POST /api/repos/context-curation/stage — staging save for repo-context-curation-worker agents.
  router.post('/context-curation/stage', async (req: Request, res: Response) => {
    try {
      if (!isContextEngineEnabled()) return res.status(409).json(contextProviderDisabledPayload('Context provider is disabled.'));
      const result = await contextCuration.saveStageFromAgent(req.body ?? {});
      res.status(201).json(result);
    } catch (err: unknown) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // POST /api/repos/mandatory-context — save mandatory agent mappings from repo-mandatory-context-mapper.
  // D2: single-writer enforcement — while a setup run is actively running for the
  // repo, this legacy save is rejected with 410 Gone and callers must use the
  // proposals endpoint (POST /:id/mandatory-context/proposals) instead.
  router.post('/mandatory-context', async (req: Request, res: Response) => {
    try {
      if (!isContextEngineEnabled()) return res.status(409).json(contextProviderDisabledPayload('Context provider is disabled.'));
      const repoId = stringValue(req.body?.repo_id ?? req.body?.repoId);
      if (repoId) {
        const activeRun = await db.collection(SETUP_RUNS_COLLECTION).findOne({ repoId, status: 'running' });
        if (activeRun) {
          return res.status(410).json({ error: 'Use proposal endpoint during setup run', code: 'setup_run_active_use_proposals' });
        }
      }
      const result = await mandatoryContext.saveManyFromAgent(req.body ?? {});
      res.status(201).json(result);
    } catch (err: unknown) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // GET /api/repos/skill-body?path=...&refId=... — load full repo skill file by graph ref.
  router.get('/skill-body', async (req: Request, res: Response) => {
    try {
      if (!isContextEngineEnabled()) return res.status(409).json(contextProviderDisabledPayload('Allen context provider is disabled.'));
      const path = String(req.query.path ?? '');
      const refId = req.query.refId ? String(req.query.refId) : undefined;
      const skillPath = req.query.skillPath ? String(req.query.skillPath) : undefined;
      if (!path) return res.status(400).json({ error: 'path query param is required' });
      if (!skillPath) return res.status(400).json({ error: 'skillPath is required' });
      const result = await repoContextPacket.getSkillBody({ repoPath: path, refId, skillPath });
      res.json(result);
    } catch (err: unknown) {
      const msg = (err as Error).message;
      const status = msg.includes('not found') || msg.includes('No knowledge graph') ? 404 : 400;
      res.status(status).json({ error: msg });
    }
  });

  // GET /api/repos/context-body?path=...&refId=... — load full repo context file or selected Cognee ref.
  router.get('/context-body', async (req: Request, res: Response) => {
    try {
      if (!isContextEngineEnabled()) return res.status(409).json(contextProviderDisabledPayload('Allen context provider is disabled.'));
      const path = String(req.query.path ?? '');
      const refId = req.query.refId ? String(req.query.refId) : undefined;
      const contextPath = req.query.contextPath ? String(req.query.contextPath) : undefined;
      if (!path) return res.status(400).json({ error: 'path query param is required' });
      if (!refId && !contextPath) return res.status(400).json({ error: 'refId or contextPath is required' });
      const result = await repoContextPacket.getContextBody({ repoPath: path, refId, contextPath });
      res.json(result);
    } catch (err: unknown) {
      const msg = (err as Error).message;
      const status = msg.includes('not found') || msg.includes('No knowledge graph') ? 404 : 400;
      res.status(status).json({ error: msg });
    }
  });

  // GET /api/repos/by-pr-url?url=<pr_url>
  // Identify the registered repo whose remote matches the GitHub PR URL.
  // Used by the pr-workspace-resolver agent via Allen MCP's
  // find_repo_for_pr_url tool.
  router.get('/by-pr-url', async (req: Request, res: Response) => {
    try {
      const url = String(req.query.url ?? '');
      if (!url) return res.status(400).json({ error: 'url query param is required' });
      const { PullRequestService } = await import('../services/pull-request.service.js');
      const prService = new PullRequestService(db);
      const repo = await prService.identifyRepoForPrUrl(url);
      if (!repo) return res.status(404).json({ error: 'No registered repo matches this PR URL' });
      res.json(repo);
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // GET /api/repos/:id/all-files — browse registered repository files.
  router.get('/:id/all-files', async (req: Request, res: Response) => {
    const repoId = param(req, 'id');
    const started = Date.now();
    console.info('[chat-files-api] repo all-files:start', { repoId });
    try {
      const repo = await service.getById(repoId);
      if (!repo?.path || typeof repo.path !== 'string') return res.status(404).json({ error: 'Repo not found' });
      const files = await listRepoFiles(repo.path);
      console.info('[chat-files-api] repo all-files:success', { repoId, count: files.length, ms: Date.now() - started });
      res.json(files);
    } catch (err: unknown) {
      console.error('[chat-files-api] repo all-files:failed', { repoId, ms: Date.now() - started, error: (err as Error).message });
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // GET /api/repos/:id/file/* — read a file from a registered repository.
  router.get('/:id/file/*', async (req: Request, res: Response) => {
    const repoId = param(req, 'id');
    const rawFilePath = (req.params as Record<string, string>)[0] ?? '';
    const started = Date.now();
    console.info('[chat-files-api] repo file:start', { repoId, path: rawFilePath });
    try {
      const repo = await service.getById(repoId);
      if (!repo?.path || typeof repo.path !== 'string') return res.status(404).json({ error: 'Repo not found' });
      const file = readRepoFile(repo.path, rawFilePath);
      console.info('[chat-files-api] repo file:success', { repoId, path: rawFilePath, ms: Date.now() - started });
      res.json(file);
    } catch (err: unknown) {
      const status = typeof (err as { status?: unknown }).status === 'number' ? (err as { status: number }).status : 500;
      console.error('[chat-files-api] repo file:failed', { repoId, path: rawFilePath, ms: Date.now() - started, error: (err as Error).message });
      res.status(status).json({ error: (err as Error).message });
    }
  });

  // GET /api/repos/:id
  router.get('/:id', async (req: Request, res: Response) => {
    try {
      const repo = await service.getById(param(req, 'id'));
      if (!repo) return res.status(404).json({ error: 'Not found' });
      console.info('[workspace-create-debug] repo api get', repoBranchDebug(repo));
      res.json(repo);
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // PUT /api/repos/:id/default-branch — change default branch
  // MUST be registered BEFORE PUT /:id, otherwise Express matches :id = "default-branch".
  router.put('/:id/default-branch', async (req: Request, res: Response) => {
    try {
      const branch = String(req.body?.defaultBranch ?? '').trim();
      if (!branch) return res.status(400).json({ error: 'defaultBranch is required' });
      const repo = await service.updateDefaultBranch(param(req, 'id'), branch);
      res.json(repo);
    } catch (err: unknown) {
      const message = (err as Error).message;
      if (message.includes('not found')) return res.status(404).json({ error: message });
      res.status(400).json({ error: message });
    }
  });

  // PUT /api/repos/:id
  router.put('/:id', async (req: Request, res: Response) => {
    try {
      const repo = await service.update(param(req, 'id'), req.body);
      res.json(repo);
    } catch (err: unknown) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // DELETE /api/repos/:id
  router.delete('/:id', async (req: Request, res: Response) => {
    try {
      await service.delete(param(req, 'id'));
      res.status(204).send();
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // POST /api/repos/:id/pull — pull latest from origin
  router.post('/:id/pull', async (req: Request, res: Response) => {
    try {
      const rescan = req.query.rescan === 'true' || req.body?.rescan === true;
      const result = await service.pull(param(req, 'id'), { rescan });
      res.json(result);
    } catch (err: unknown) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // POST /api/repos/:id/scan — shallow rescan (existing)
  router.post('/:id/scan', async (req: Request, res: Response) => {
    try {
      const repo = await service.scan(param(req, 'id'));
      res.json(repo);
    } catch (err: unknown) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // POST /api/repos/:id/scan/cancel — cancel/clear an in-progress repo scan
  router.post('/:id/scan/cancel', async (req: Request, res: Response) => {
    try {
      const result = await service.cancelScan(param(req, 'id'));
      res.json(result);
    } catch (err: unknown) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // POST /api/repos/:id/rescan-context — deep agent-driven context rescan (async, returns 202)
  router.post('/:id/rescan-context', async (req: Request, res: Response) => {
    try {
      const result = await service.rescanContext(param(req, 'id'));
      res.status(result.scheduled ? 202 : 409).json(result);
    } catch (err: unknown) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // GET /api/repos/:id/cognee — local Cognee dataset ingestion status.
  router.get('/:id/cognee', async (req: Request, res: Response) => {
    try {
      if (!isCogneeContextEnabled()) return res.status(409).json(contextProviderDisabledPayload('Cognee context provider is disabled.'));
      const status = await cogneeMemory.getStatus(param(req, 'id'));
      if (!status) return res.status(404).json({ error: 'No Cognee dataset found for repo' });
      res.json(status);
    } catch (err: unknown) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // GET /api/repos/:id/context-management — management payload for curated, mandatory, and graph context.
  router.get('/:id/context-management', async (req: Request, res: Response) => {
    try {
      if (!isContextEngineEnabled()) return res.status(409).json(contextProviderDisabledPayload('Context provider is disabled.'));
      const repoId = param(req, 'id');
      const [profile, allEntries, mandatoryMappings, agents, cogneeStatus] = await Promise.all([
        contextCuration.getLatest(repoId).catch(() => null),
        db.collection('repo_context_curation_entries').find({ repoId, active: { $ne: false } }, { sort: { path: 1, updatedAt: -1 } }).toArray(),
        mandatoryContext.list(repoId),
        mandatoryContext.listAgents(),
        cogneeMemory.getStatus(repoId).catch(() => null),
      ]);
      const entries = activeCurationEntries(allEntries);
      res.json({ profile, entries, allEntries, curationStats: curationEntryStats(allEntries), mandatoryMappings, agents, cogneeStatus });
    } catch (err: unknown) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  router.get('/:id/context-management/entries', async (req: Request, res: Response) => {
    try {
      if (!isContextEngineEnabled()) return res.status(409).json(contextProviderDisabledPayload('Context provider is disabled.'));
      const repoId = param(req, 'id');
      const includeInactive = String(req.query['includeInactive'] ?? '') === 'true';
      const entries = await db.collection('repo_context_curation_entries')
        .find({ repoId, ...(includeInactive ? {} : { active: { $ne: false } }) }, { sort: { path: 1, updatedAt: -1 } })
        .toArray();
      res.json(entries);
    } catch (err: unknown) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  router.get('/:id/context-management/mandatory', async (req: Request, res: Response) => {
    try {
      if (!isContextEngineEnabled()) return res.status(409).json(contextProviderDisabledPayload('Context provider is disabled.'));
      const agentName = req.query.agentName ? String(req.query.agentName) : undefined;
      // enabled query param: true | false | all (default: no filter = all)
      let enabledFilter: boolean | 'all' | undefined;
      const enabledRaw = req.query.enabled ? String(req.query.enabled) : undefined;
      if (enabledRaw === 'true') enabledFilter = true;
      else if (enabledRaw === 'false') enabledFilter = false;
      else if (enabledRaw === 'all') enabledFilter = 'all';
      res.json(await mandatoryContext.list(param(req, 'id'), { agentName, enabled: enabledFilter }));
    } catch (err: unknown) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  router.post('/:id/context-management/mandatory', async (req: Request, res: Response) => {
    try {
      if (!isContextEngineEnabled()) return res.status(409).json(contextProviderDisabledPayload('Context provider is disabled.'));
      res.json(await mandatoryContext.upsert(param(req, 'id'), req.body ?? {}));
    } catch (err: unknown) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  router.patch('/:id/context-management/mandatory/:mappingId', async (req: Request, res: Response) => {
    try {
      if (!isContextEngineEnabled()) return res.status(409).json(contextProviderDisabledPayload('Context provider is disabled.'));
      res.json(await mandatoryContext.update(param(req, 'id'), param(req, 'mappingId'), req.body ?? {}));
    } catch (err: unknown) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  router.post('/:id/context-management/playground', async (req: Request, res: Response) => {
    try {
      if (!isContextEngineEnabled()) return res.status(409).json(contextProviderDisabledPayload('Context provider is disabled.'));
      const repoId = param(req, 'id');
      const repo = await db.collection('repos').findOne({ _id: new ObjectId(repoId) });
      if (!repo?.path) return res.status(404).json({ error: 'Repo not found' });
      const query = String(req.body?.query ?? '').trim();
      if (!query) return res.status(400).json({ error: 'query is required' });
      const indexId = `context-playground:${repoId}`;
      const packet = await new RepoContextEngine(undefined, undefined, { db }).buildPacket({
        packetId: `playground-${randomUUID()}`,
        executionId: `playground-${randomUUID()}`,
        repoId,
        repoName: String(repo.name ?? ''),
        repoPath: String(repo.path),
        indexId,
        indexFreshness: 'provider_runtime',
        workflowName: 'context_management_playground',
        nodeName: String(req.body?.agentName ?? req.body?.nodeRole ?? 'playground'),
        nodeRole: String(req.body?.nodeRole ?? req.body?.agentName ?? 'playground'),
        executionKind: 'chat_agent',
        targetRole: String(req.body?.agentName ?? req.body?.nodeRole ?? 'playground'),
        attempt: 1,
        state: { repo_path: repo.path, task: query },
        prompt: query,
        provider: 'unknown',
        currentFiles: stringArrayValue(req.body?.currentFiles),
        nodes: [],
      });
      const adapter = new WorkflowContextInjectionAdapter();
      const injection = await adapter.buildInjection({
        packet,
        provider: 'unknown',
        repoPath: String(repo.path),
      });
      const contextInjection = summarizeInjection(injection);
      const [candidateRefs, selectedRefs, injectableRefs, rejectedRefs, availableRefs] = await Promise.all([
        enrichPlaygroundRefs(db, repoId, playgroundRefs(packet.candidateRefs)),
        enrichPlaygroundRefs(db, repoId, playgroundRefs(packet.selectedRefs)),
        enrichPlaygroundRefs(db, repoId, playgroundRefs(packet.injectableRefs)),
        enrichPlaygroundRefs(db, repoId, playgroundRefs(packet.rejectedRefs)),
        enrichPlaygroundRefs(db, repoId, playgroundRefs(packet.availableRefs)),
      ]);
      res.json({
        saved: false,
        packet: {
          packetId: packet.packetId,
          repoId: packet.repoId,
          repoName: packet.repoName,
          indexId: packet.indexId,
          indexFreshness: packet.indexFreshness,
          retrievalProviders: packet.retrievalProviders,
          rerankerProviders: packet.rerankerProviders,
          providerDiagnostics: packet.providerDiagnostics,
          rerankerDiagnostics: packet.rerankerDiagnostics,
          contextQuery: {
            role: packet.contextQueryIntent?.role,
            roleFamily: packet.contextQueryIntent?.roleFamily,
            renderedQueryHash: packet.renderedContextQueryHash,
            renderedQueryLength: packet.renderedContextQueryLength,
            renderedQuery: packet.renderedContextQuery,
            queryIntentHash: packet.contextQueryIntentHash,
            requiredCategories: packet.contextQueryIntent?.requiredCategories,
            preferredCategories: packet.contextQueryIntent?.preferredCategories,
            exclusionCategories: packet.contextQueryIntent?.exclusionCategories,
            pathScopes: packet.contextQueryIntent?.pathScopes,
            categoryDiagnostics: packet.contextQueryIntent?.categoryDiagnostics,
            currentFiles: packet.currentFiles,
          },
          candidateRefs,
          selectedRefs,
          injectableRefs,
          rejectedRefs,
          availableRefs,
          providerTraces: packet.providerTraces,
          rerankerTraces: packet.rerankerTraces,
        },
        injection: contextInjection,
        playground: {
          contextQueryIntent: packet.contextQueryIntent,
          renderedContextQuery: packet.renderedContextQuery,
          providerDiagnostics: packet.providerDiagnostics,
          rerankerDiagnostics: packet.rerankerDiagnostics,
          packingDiagnostics: contextInjection.packingDiagnostics,
          injection: contextInjection,
        },
      });
    } catch (err: unknown) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  router.patch('/:id/context-management/entries/:entryId', async (req: Request, res: Response) => {
    try {
      if (!isContextEngineEnabled()) return res.status(409).json(contextProviderDisabledPayload('Context provider is disabled.'));
      const repoId = param(req, 'id');
      const entryId = param(req, 'entryId');
      const patch = curationContentPatch(req.body ?? {});
      if (Object.keys(patch).length === 0) return res.status(400).json({ error: 'At least one editable curation field is required' });
      if (!hasGeneratedCurationContent(patch)) return res.status(400).json({ error: 'curatedContext, retrievalText, or at least one chunk is required' });
      const existing = await curatedContextEditor.getEntry(repoId, entryId);
      if (!existing) return res.status(404).json({ error: 'Curated context entry not found' });
      const result = await curatedContextEditor.applyEdit(
        repoId,
        entryId,
        {
          ...patch,
          manualOverride: true,
          source: 'manual_context_management',
        },
        { actor: 'user', source: 'manual_context_management', action: 'update' },
      );
      res.json(result.entry);
    } catch (err: unknown) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  router.post('/:id/context-management/entries', async (req: Request, res: Response) => {
    try {
      if (!isContextEngineEnabled()) return res.status(409).json(contextProviderDisabledPayload('Context provider is disabled.'));
      const repoId = param(req, 'id');
      const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body as Record<string, unknown> : {};
      const patch = curationContentPatch(body);
      if (!hasGeneratedCurationContent(patch)) return res.status(400).json({ error: 'curatedContext, retrievalText, or at least one chunk is required' });
      const title = stringValue(patch.title) || stringValue(patch.path);
      if (!title) return res.status(400).json({ error: 'title or path is required' });
      const entryId = stringValue(body.entryId) || stableManualCurationEntryId(repoId, body);
      const contentForHash = [
        stringValue(patch.curatedContext),
        stringValue(patch.retrievalText),
        Array.isArray(patch.chunks) ? patch.chunks.map((chunk) => stringValue((chunk as Record<string, unknown>).text)).filter(Boolean).join('\n\n') : '',
      ].filter(Boolean).join('\n\n');
      const entry = {
        entryId,
        repoId,
        path: stringValue(patch.path) || `manual/${entryId.replace(/[^a-zA-Z0-9._-]+/g, '-')}`,
        sourceHash: `manual:${sha256(contentForHash)}`,
        title,
        category: stringValue(patch.category) || 'manual',
        inclusion: stringValue(patch.inclusion) || 'include',
        authority: 'medium',
        freshness: 'current',
        injectionPolicy: stringValue(patch.injectionPolicy) || 'snippet',
        summary: stringValue(patch.summary) || String(contentForHash).replace(/\s+/g, ' ').trim().slice(0, 240),
        curatedContext: patch.curatedContext,
        retrievalText: patch.retrievalText,
        chunks: Array.isArray(patch.chunks) ? patch.chunks : [],
        aliases: stringArrayValue(body.aliases),
        appliesToGlobs: stringArrayValue(body.appliesToGlobs),
        sourceAnchors: stringArrayValue(body.sourceAnchors),
        reasoning: 'User-created curated context entry.',
        curationVersion: 1,
        promptVersion: 1,
        configHash: 'manual',
        manualOverride: true,
        source: 'user_added',
      };
      const existing = await db.collection('repo_context_curation_entries').findOne({ repoId, entryId, active: { $ne: false } });
      if (existing) return res.status(409).json({ error: 'Curated context entry already exists' });
      const result = await curatedContextEditor.applyEdit(
        repoId,
        entryId,
        entry as any,
        { actor: 'user', source: 'manual_context_management', action: 'create' },
      );
      res.status(201).json(result.entry);
    } catch (err: unknown) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // POST /api/repos/:id/context-management/entries/bulk-delete — bulk archive curated context entries
  router.post('/:id/context-management/entries/bulk-delete', async (req: Request, res: Response) => {
    try {
      if (!isContextEngineEnabled()) return res.status(409).json(contextProviderDisabledPayload('Context provider is disabled.'));
      const repoId = param(req, 'id');
      const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body as Record<string, unknown> : {};
      const entryIds = stringArrayValue(body.entryIds);
      if (!entryIds.length) return res.status(400).json({ error: 'entryIds must be a non-empty array' });
      if (entryIds.length > 200) return res.status(400).json({ error: 'entryIds exceeds max batch size of 200' });
      const result = await curatedContextEditor.archiveMany(
        repoId,
        entryIds,
        { actor: 'user', source: 'manual_context_management' },
      );
      res.json(result);
    } catch (err: unknown) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // POST /api/repos/:id/context-management/mandatory/bulk-delete — bulk deactivate mandatory mappings
  router.post('/:id/context-management/mandatory/bulk-delete', async (req: Request, res: Response) => {
    try {
      if (!isContextEngineEnabled()) return res.status(409).json(contextProviderDisabledPayload('Context provider is disabled.'));
      const repoId = param(req, 'id');
      const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body as Record<string, unknown> : {};
      const mappingIds = stringArrayValue(body.mappingIds);
      if (!mappingIds.length) return res.status(400).json({ error: 'mappingIds must be a non-empty array' });
      if (mappingIds.length > 200) return res.status(400).json({ error: 'mappingIds exceeds max batch size of 200' });
      const reason = typeof body.reason === 'string' ? body.reason.trim() : undefined;
      const result = await mandatoryContext.deactivateMany(repoId, mappingIds, { reason });
      res.json(result);
    } catch (err: unknown) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  router.delete('/:id/context-management/entries/:entryId', async (req: Request, res: Response) => {
    try {
      if (!isContextEngineEnabled()) return res.status(409).json(contextProviderDisabledPayload('Context provider is disabled.'));
      const repoId = param(req, 'id');
      const entryId = param(req, 'entryId');
      const existing = await curatedContextEditor.getEntry(repoId, entryId);
      if (!existing) return res.status(404).json({ error: 'Curated context entry not found' });
      const result = await curatedContextEditor.applyEdit(
        repoId,
        entryId,
        {},
        { actor: 'user', source: 'manual_context_management', action: 'archive' },
      );
      res.json(result.entry);
    } catch (err: unknown) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  router.get('/:id/context-management/graph', async (req: Request, res: Response) => {
    try {
      if (!isContextEngineEnabled()) return res.status(409).json(contextProviderDisabledPayload('Context provider is disabled.'));
      const repoId = param(req, 'id');
      const graph = await contextGraph.getGraph(repoId, {
        maxNodes: numberQuery(req.query.maxNodes, 120, 5000),
        maxEdges: numberQuery(req.query.maxEdges, 240, 10000),
        query: req.query.query ? String(req.query.query) : undefined,
        nodeType: req.query.nodeType ? String(req.query.nodeType) : undefined,
        relationship: req.query.relationship ? String(req.query.relationship) : undefined,
        expandNodeId: req.query.expandNodeId ? String(req.query.expandNodeId) : undefined,
      });
      res.json(graph);
    } catch (err: unknown) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  router.get('/:id/context-management/graph/nodes/:nodeId', async (req: Request, res: Response) => {
    try {
      if (!isContextEngineEnabled()) return res.status(409).json(contextProviderDisabledPayload('Context provider is disabled.'));
      const repoId = param(req, 'id');
      res.json(await contextGraph.getNodeDetail(repoId, decodeURIComponent(param(req, 'nodeId')), {
        maxRelatedNodes: numberQuery(req.query.maxRelatedNodes, 500, 2000),
        maxRelatedEdges: numberQuery(req.query.maxRelatedEdges, 1000, 5000),
        includeDocuments: req.query.includeDocuments !== 'false',
      }));
    } catch (err: unknown) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // ── Context Portability Routes ────────────────────────────────────────────

  // GET /:id/context-management/export/preview
  router.get('/:id/context-management/export/preview', async (req: Request, res: Response) => {
    if (!isContextEngineEnabled()) return res.status(409).json(contextProviderDisabledPayload());
    try {
      const result = await portabilityService.previewExport(param(req, 'id'));
      return res.json(result);
    } catch (err) {
      const e = err as Error & { code?: string; statusCode?: number };
      return res.status(e.statusCode ?? 500).json({ error: e.message, code: e.code });
    }
  });

  // GET /:id/context-management/export
  router.get('/:id/context-management/export', async (req: Request, res: Response) => {
    if (!isContextEngineEnabled()) return res.status(409).json(contextProviderDisabledPayload());
    try {
      const pkg = await portabilityService.buildExport(param(req, 'id'));
      const repoName = String((pkg.sourceRepo as Record<string, unknown>)?.repoName ?? 'repo');
      const filename = `${repoName.replace(/[^a-z0-9_-]/gi, '_')}-context-package.json`;
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      return res.json(pkg);
    } catch (err) {
      const e = err as Error & { code?: string; statusCode?: number };
      return res.status(e.statusCode ?? 500).json({ error: e.message, code: e.code });
    }
  });

  // POST /:id/context-management/import/preview
  router.post('/:id/context-management/import/preview', async (req: Request, res: Response) => {
    if (!isContextEngineEnabled()) return res.status(409).json(contextProviderDisabledPayload());
    const pkg = req.body?.package;
    if (!pkg || typeof pkg !== 'object') return res.status(400).json({ error: 'Request body must include a "package" object', code: 'PACKAGE_INVALID' });
    try {
      const result = await portabilityService.previewImport(param(req, 'id'), pkg as Record<string, unknown>);
      return res.json(result);
    } catch (err) {
      const e = err as Error & { code?: string; statusCode?: number };
      return res.status(e.statusCode ?? 400).json({ error: e.message, code: e.code });
    }
  });

  // POST /:id/context-management/import
  router.post('/:id/context-management/import', async (req: Request, res: Response) => {
    if (!isContextEngineEnabled()) return res.status(409).json(contextProviderDisabledPayload());
    const pkg = req.body?.package;
    if (!pkg || typeof pkg !== 'object') return res.status(400).json({ error: 'Request body must include a "package" object', code: 'PACKAGE_INVALID' });
    try {
      const confirmRepoNameMismatch = req.body?.confirmRepoNameMismatch === true;
      const result = await portabilityService.applyImport(param(req, 'id'), pkg as Record<string, unknown>, { confirmRepoNameMismatch });
      console.info(JSON.stringify({ event: 'repo.context.import.applied', targetRepoId: param(req, 'id'), imported: result.imported, checksumValid: result.checksumValid }));
      return res.json(result);
    } catch (err) {
      const e = err as Error & { code?: string; statusCode?: number; repoNameMismatch?: unknown };
      console.info(JSON.stringify({ event: 'repo.context.import.rejected', targetRepoId: param(req, 'id'), code: e.code }));
      return res.status(e.statusCode ?? 400).json({ error: e.message, code: e.code, repoNameMismatch: e.repoNameMismatch });
    }
  });

  // ── Context Setup Routes ──────────────────────────────────────────────────
  // NOTE: /runs must be declared BEFORE /:setupRunId to prevent Express from
  // matching 'runs' as a setupRunId parameter value.

  // POST /api/repos/:id/context-setup — start or return active setup run
  router.post('/:id/context-setup', async (req: Request, res: Response) => {
    try {
      if (!isContextEngineEnabled()) return res.status(409).json(contextProviderDisabledPayload('context-setup'));
      const repoId = param(req, 'id');
      const options = (req.body?.options && typeof req.body.options === 'object') ? req.body.options : {};
      const requestedBy = (req as Request & { user?: { _id?: unknown } }).user?._id ? String((req as Request & { user?: { _id?: unknown } }).user!._id) : undefined;
      const { setupRun, deduped } = await setupService.startOrReturn(repoId, options, requestedBy, 'ui');
      res.status(deduped ? 200 : 201).json({ setupRun, deduped });
    } catch (err: unknown) {
      sendContextSetupError(res, err, 409);
    }
  });

  // GET /api/repos/:id/context-setup — active or latest setup run
  router.get('/:id/context-setup', async (req: Request, res: Response) => {
    try {
      if (!isContextEngineEnabled()) return res.status(409).json(contextProviderDisabledPayload('context-setup'));
      const repoId = param(req, 'id');
      const result = await setupService.getActiveOrLatest(repoId);
      res.json(result);
    } catch (err: unknown) {
      sendContextSetupError(res, err);
    }
  });

  // GET /api/repos/:id/context-setup/runs — history (MUST be before /:setupRunId)
  router.get('/:id/context-setup/runs', async (req: Request, res: Response) => {
    try {
      if (!isContextEngineEnabled()) return res.status(409).json(contextProviderDisabledPayload('context-setup'));
      const repoId = param(req, 'id');
      const limit = Math.min(Number(req.query.limit ?? 10) || 10, 50);
      const runs = await setupService.listHistory(repoId, limit);
      res.json({ runs });
    } catch (err: unknown) {
      sendContextSetupError(res, err);
    }
  });

  // GET /api/repos/:id/context-setup/:setupRunId — detail
  router.get('/:id/context-setup/:setupRunId', async (req: Request, res: Response) => {
    try {
      if (!isContextEngineEnabled()) return res.status(409).json(contextProviderDisabledPayload('context-setup'));
      const result = await setupService.get(param(req, 'setupRunId'));
      res.json(result);
    } catch (err: unknown) {
      sendContextSetupError(res, err);
    }
  });

  // POST /api/repos/:id/context-setup/:setupRunId/cancel
  router.post('/:id/context-setup/:setupRunId/cancel', async (req: Request, res: Response) => {
    try {
      if (!isContextEngineEnabled()) return res.status(409).json(contextProviderDisabledPayload('context-setup'));
      const setupRun = await setupService.cancel(param(req, 'setupRunId'));
      res.status(202).json({ setupRun });
    } catch (err: unknown) {
      sendContextSetupError(res, err);
    }
  });

  // POST /api/repos/:id/context-setup/:setupRunId/resume
  router.post('/:id/context-setup/:setupRunId/resume', async (req: Request, res: Response) => {
    try {
      if (!isContextEngineEnabled()) return res.status(409).json(contextProviderDisabledPayload('context-setup'));
      const setupRun = await setupService.resume(param(req, 'setupRunId'));
      res.status(202).json({ setupRun });
    } catch (err: unknown) {
      sendContextSetupError(res, err);
    }
  });

  // POST /api/repos/:id/mandatory-context/proposals — agent-facing proposal staging.
  // Three modes:
  //   mode:'stage'    → batched, resumable upsert of staged mapping rows (≤25 per call)
  //   mode:'finalize' → assemble the single 'proposed' doc from staged rows
  //   no mode         → legacy whole-packet body (unchanged behavior)
  router.post('/:id/mandatory-context/proposals', async (req: Request, res: Response) => {
    try {
      if (!isContextEngineEnabled()) return res.status(409).json(contextProviderDisabledPayload('context-setup'));
      const repoId = param(req, 'id');
      const { mode, setupRunId, affectedAgentNames, mappings } = req.body ?? {};
      if (mode !== undefined && mode !== 'stage' && mode !== 'finalize') {
        return res.status(400).json({ error: `Unknown mode '${String(mode)}' — expected 'stage' or 'finalize'`, code: 'INVALID_OPTIONS' });
      }
      if (!setupRunId || typeof setupRunId !== 'string') {
        return res.status(400).json({ error: 'setupRunId is required', code: 'INVALID_OPTIONS' });
      }
      if (mode === 'stage') {
        return await handleProposalStage(db, res, { repoId, setupRunId, mappings });
      }
      if (mode === 'finalize') {
        return await handleProposalFinalize(db, res, {
          repoId,
          setupRunId,
          affectedAgentNames,
          expectedMappingCount: req.body?.expectedMappingCount,
        });
      }
      if (!Array.isArray(affectedAgentNames)) {
        return res.status(400).json({ error: 'affectedAgentNames must be an array', code: 'INVALID_OPTIONS' });
      }
      if (!Array.isArray(mappings)) {
        return res.status(400).json({ error: 'mappings must be an array', code: 'INVALID_OPTIONS' });
      }

      // Validate setupRunId belongs to an active run on this repo
      const activeRun = await findActiveSetupRun(db, repoId, setupRunId);
      if (!activeRun) {
        return res.status(409).json({ error: 'No active setup run found for the given setupRunId', code: 'NO_ACTIVE_SETUP_RUN' });
      }

      // Validate affectedAgentNames ⊇ unique(mappings[].agentName)
      // Dev adaptation: exclude soft-deleted agents so a deleted agent doesn't pass validation
      // NOTE: replaceForRun re-validates the same constraints — intentional defense-in-depth, not accidental duplication.
      const agentNames = db.collection('agents');
      const mappingAgentNames = [...new Set((mappings as Array<{ agentName?: string }>).map((m) => m.agentName).filter(Boolean))] as string[];
      for (const name of [...affectedAgentNames as string[], ...mappingAgentNames]) {
        const exists = await agentNames.findOne({ name, ...notDeletedFilter });
        if (!exists) {
          return res.status(400).json({ error: `Agent '${name}' not found in agents collection`, code: 'INVALID_AGENT_NAME' });
        }
      }
      for (const name of mappingAgentNames) {
        if (!(affectedAgentNames as string[]).includes(name)) {
          return res.status(400).json({ error: `Agent '${name}' in mappings is not in affectedAgentNames`, code: 'AGENT_NOT_AFFECTED' });
        }
      }

      // Demote any prior outstanding proposal (latest-wins)
      const now = new Date();
      await db.collection('mandatory_context_proposals').updateMany(
        { setupRunId, status: 'proposed' },
        { $set: { status: 'rejected', rejectedAt: now, rejectionReason: 'superseded' } },
      );

      // Insert new proposal
      const proposalId = randomUUID();
      const proposal = {
        proposalId,
        setupRunId,
        repoId,
        affectedAgentNames,
        mappings,
        status: 'proposed',
        createdAt: now,
      };

      try {
        await db.collection('mandatory_context_proposals').insertOne(proposal);
      } catch (insertErr: unknown) {
        if ((insertErr as { code?: number }).code === 11000) {
          return res.status(409).json({ error: 'Concurrent proposal conflict — retry', code: 'PROPOSAL_CONFLICT' });
        }
        throw insertErr;
      }

      res.status(201).json({ proposalId });
    } catch (err: unknown) {
      sendContextSetupError(res, err);
    }
  });

  // ── End Context Setup Routes ──────────────────────────────────────────────

  // POST /api/repos/:id/cognee/refresh — manually ingest/cognify repo memory.
  router.post('/:id/cognee/refresh', async (req: Request, res: Response) => {
    try {
      if (!isCogneeContextEnabled()) return res.status(409).json(contextProviderDisabledPayload('Cognee context provider is disabled.'));
      const pullLatest = req.query.pullLatest === 'true' || req.body?.pullLatest === true;
      const cleanRebuild = req.query.cleanRebuild === 'true' || req.body?.cleanRebuild === true;
      const status = await cogneeMemory.scheduleRefreshRepo(param(req, 'id'), { pullLatest, cleanRebuild });
      res.status(202).json(status);
    } catch (err: unknown) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // POST /api/repos/:id/cognee/stop — stop an active local Cognee context build.
  router.post('/:id/cognee/stop', async (req: Request, res: Response) => {
    try {
      if (!isCogneeContextEnabled()) return res.status(409).json(contextProviderDisabledPayload('Cognee context provider is disabled.'));
      const status = await cogneeMemory.stopRefreshRepo(param(req, 'id'));
      res.status(202).json(status);
    } catch (err: unknown) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // GET /api/repos/:id/context — fetch the stored deep context doc
  router.get('/:id/context', async (req: Request, res: Response) => {
    try {
      const ctx = await service.getContext(param(req, 'id'));
      if (!ctx) return res.status(404).json({ error: 'No context found for that repo' });
      res.json(ctx);
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  return router;
}

// ── Mandatory-context proposal staging helpers ────────────────────────────────

/** Max mappings accepted by a single mode:'stage' call. */
const PROPOSAL_STAGE_BATCH_LIMIT = 25;

/** Shared active-setup-run lookup for all proposal modes. */
function findActiveSetupRun(db: Db, repoId: string, setupRunId: string): Promise<Record<string, unknown> | null> {
  return db.collection('repo_context_setup_runs').findOne({
    setupRunId,
    repoId,
    status: { $in: ['running', 'partial'] },
  }) as Promise<Record<string, unknown> | null>;
}

/** Upsert key for a staged proposal row: (setupRunId, agentName, title) + sourcePath when present. */
function stagedRowKey(setupRunId: string, mapping: { agentName: string; title: string; sourcePath?: string }): Record<string, unknown> {
  return {
    setupRunId,
    agentName: mapping.agentName,
    title: mapping.title,
    ...(mapping.sourcePath ? { sourcePath: mapping.sourcePath } : {}),
    status: 'staged',
  };
}

/** mode:'stage' — bulk upsert of staged mapping rows (resumable; safe to re-stage the same key). */
async function handleProposalStage(
  db: Db,
  res: Response,
  body: { repoId: string; setupRunId: string; mappings: unknown },
): Promise<void> {
  const { repoId, setupRunId } = body;
  if (!Array.isArray(body.mappings)) {
    res.status(400).json({ error: 'mappings must be an array', code: 'INVALID_OPTIONS' });
    return;
  }
  if (body.mappings.length === 0) {
    res.status(400).json({ error: 'mappings must not be empty for mode "stage"', code: 'INVALID_OPTIONS' });
    return;
  }
  if (body.mappings.length > PROPOSAL_STAGE_BATCH_LIMIT) {
    res.status(400).json({ error: `mappings exceeds the stage batch limit of ${PROPOSAL_STAGE_BATCH_LIMIT} (got ${body.mappings.length}) — split into smaller batches`, code: 'STAGE_BATCH_TOO_LARGE' });
    return;
  }
  const mappings = body.mappings as Array<{ agentName?: string; sourcePath?: string; sourceHash?: string; title?: string; content?: string; reasoning?: string }>;
  for (const m of mappings) {
    if (!m || typeof m !== 'object' || typeof m.agentName !== 'string' || !m.agentName || typeof m.title !== 'string' || !m.title || typeof m.content !== 'string' || !m.content) {
      res.status(400).json({ error: 'each mapping requires agentName, title, and content', code: 'INVALID_OPTIONS' });
      return;
    }
  }

  const activeRun = await findActiveSetupRun(db, repoId, setupRunId);
  if (!activeRun) {
    res.status(409).json({ error: 'No active setup run found for the given setupRunId', code: 'NO_ACTIVE_SETUP_RUN' });
    return;
  }

  // Validate each mapping's agentName exists (same agent lookup as the legacy path, incl. soft-delete filter)
  const agents = db.collection('agents');
  for (const name of [...new Set(mappings.map((m) => m.agentName as string))]) {
    const exists = await agents.findOne({ name, ...notDeletedFilter });
    if (!exists) {
      res.status(400).json({ error: `Agent '${name}' not found in agents collection`, code: 'INVALID_AGENT_NAME' });
      return;
    }
  }

  const proposals = db.collection('mandatory_context_proposals');
  const now = new Date();
  for (const m of mappings) {
    await proposals.updateOne(
      stagedRowKey(setupRunId, m as { agentName: string; title: string; sourcePath?: string }),
      {
        $set: {
          repoId,
          content: m.content,
          ...(m.sourcePath ? { sourcePath: m.sourcePath } : {}),
          ...(m.sourceHash ? { sourceHash: m.sourceHash } : {}),
          ...(m.reasoning ? { reasoning: m.reasoning } : {}),
          updatedAt: now,
        },
        // createdAt: keeps staged rows on the same TTL cleanup as proposal docs
        $setOnInsert: { stagedAt: now, createdAt: now },
      },
      { upsert: true },
    );
  }

  const totalStaged = await proposals.countDocuments({ setupRunId, status: 'staged' });
  res.status(200).json({ staged: mappings.length, totalStaged });
}

/** mode:'finalize' — assemble the single 'proposed' doc from staged rows and mark them consumed. */
async function handleProposalFinalize(
  db: Db,
  res: Response,
  body: { repoId: string; setupRunId: string; affectedAgentNames: unknown; expectedMappingCount: unknown },
): Promise<void> {
  const { repoId, setupRunId } = body;
  if (!Array.isArray(body.affectedAgentNames)) {
    res.status(400).json({ error: 'affectedAgentNames must be an array', code: 'INVALID_OPTIONS' });
    return;
  }
  const affectedAgentNames = body.affectedAgentNames as string[];
  const expectedMappingCount = body.expectedMappingCount;
  if (typeof expectedMappingCount !== 'number' || !Number.isInteger(expectedMappingCount) || expectedMappingCount < 0) {
    res.status(400).json({ error: 'expectedMappingCount must be a non-negative integer', code: 'INVALID_OPTIONS' });
    return;
  }

  const activeRun = await findActiveSetupRun(db, repoId, setupRunId);
  if (!activeRun) {
    res.status(409).json({ error: 'No active setup run found for the given setupRunId', code: 'NO_ACTIVE_SETUP_RUN' });
    return;
  }

  const proposals = db.collection('mandatory_context_proposals');
  const stagedRows = await proposals.find({ setupRunId, status: 'staged' }).toArray();

  // Validate all affectedAgentNames exist (same defense-in-depth as the legacy path; staged
  // agentNames were validated at stage time and must be ⊆ affectedAgentNames below)
  const agents = db.collection('agents');
  for (const name of affectedAgentNames) {
    const exists = await agents.findOne({ name, ...notDeletedFilter });
    if (!exists) {
      res.status(400).json({ error: `Agent '${name}' not found in agents collection`, code: 'INVALID_AGENT_NAME' });
      return;
    }
  }
  for (const name of [...new Set(stagedRows.map((r) => String(r.agentName ?? '')))]) {
    if (!affectedAgentNames.includes(name)) {
      res.status(400).json({ error: `Agent '${name}' in staged mappings is not in affectedAgentNames`, code: 'AGENT_NOT_AFFECTED' });
      return;
    }
  }
  if (stagedRows.length !== expectedMappingCount) {
    res.status(400).json({
      error: `Staged mapping count ${stagedRows.length} does not match expectedMappingCount ${expectedMappingCount} — verify staged coverage and re-stage missing mappings`,
      code: 'STAGED_COUNT_MISMATCH',
      stagedCount: stagedRows.length,
      expectedMappingCount,
    });
    return;
  }

  // Demote any prior outstanding proposal (latest-wins — same as the legacy path)
  const now = new Date();
  await proposals.updateMany(
    { setupRunId, status: 'proposed' },
    { $set: { status: 'rejected', rejectedAt: now, rejectionReason: 'superseded' } },
  );

  // Insert the single proposal doc assembled from staged rows (same shape as the
  // legacy path so the orchestrator apply flow is untouched)
  const proposalId = randomUUID();
  const proposal = {
    proposalId,
    setupRunId,
    repoId,
    affectedAgentNames,
    mappings: stagedRows.map((r) => ({
      agentName: String(r.agentName ?? ''),
      ...(r.sourcePath ? { sourcePath: String(r.sourcePath) } : {}),
      ...(r.sourceHash ? { sourceHash: String(r.sourceHash) } : {}),
      title: String(r.title ?? ''),
      content: String(r.content ?? ''),
      ...(r.reasoning ? { reasoning: String(r.reasoning) } : {}),
    })),
    status: 'proposed',
    createdAt: now,
  };

  try {
    await proposals.insertOne(proposal);
  } catch (insertErr: unknown) {
    if ((insertErr as { code?: number }).code === 11000) {
      res.status(409).json({ error: 'Concurrent proposal conflict — retry', code: 'PROPOSAL_CONFLICT' });
      return;
    }
    throw insertErr;
  }

  // Mark staged rows consumed. Use consumedProposalId (not proposalId) as the
  // audit/link field so that staged rows never carry proposalId — which would
  // collide with the partial unique index that identifies final proposal docs.
  await proposals.updateMany(
    { setupRunId, status: 'staged' },
    { $set: { status: 'consumed_into_proposal', consumedProposalId: proposalId, updatedAt: now } },
  );

  res.status(201).json({ proposalId, mappingCount: proposal.mappings.length });
}
