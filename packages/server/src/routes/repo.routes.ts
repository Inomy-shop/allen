import { Router, type Request, type Response } from 'express';
import { dirname } from 'node:path';
import { RepoService } from '../services/repo.service.js';
import { RepoKnowledgeGraphService, isRepoKnowledgeGraphValidationError } from '../services/context/allen-knowledge-graph/repo-knowledge-graph.service.js';
import { isRecord } from '../services/context/allen-knowledge-graph/repo-knowledge-graph-utils.js';
import { CogneeMemoryService } from '../services/context/cognee/cognee-memory.service.js';
import { RepoContextCurationService } from '../services/context/curation/repo-context-curation.service.js';
import { RepoMandatoryContextService } from '../services/context/mandatory/repo-mandatory-context.service.js';
import { RepoContextGraphService } from '../services/context/graph/repo-context-graph.service.js';
import { RepoContextEngine } from '../services/context/core/repo-context-engine.js';
import { WorkflowContextInjectionAdapter, summarizeInjection } from '../services/context/core/workflow-context-injection-adapter.js';
import { isCogneeContextEnabled, isContextEngineEnabled, isGraphContextEnabled } from '../services/context/config/context-provider-config.js';
import { executeChatTool } from '../services/chat-tools.js';
import { param } from '../types.js';
import { ObjectId, type Db } from 'mongodb';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

function contextProviderDisabledPayload(error = 'Context provider is disabled. Set ALLEN_CONTEXT_PROVIDER to enable context engine flows.'): Record<string, unknown> {
  return { error, code: 'CONTEXT_PROVIDER_DISABLED' };
}

function activeCurationEntries(entries: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return entries.filter((entry) => entry.inclusion === 'include');
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
  if (typeof body.injectionPolicy === 'string') patch.injectionPolicy = body.injectionPolicy;
  return patch;
}

function hasGeneratedCurationContent(value: Record<string, unknown>): boolean {
  return Boolean(
    stringValue(value.curatedContext)
    || stringValue(value.retrievalText)
    || (Array.isArray(value.chunks) && value.chunks.some((chunk) => Boolean(chunk && typeof chunk === 'object' && stringValue((chunk as Record<string, unknown>).text)))),
  );
}

const MAX_DEBUG_TEXT_CHARS = 40_000;

function debugText(value: unknown): string | undefined {
  const text = stringValue(value);
  if (!text) return undefined;
  return text.length > MAX_DEBUG_TEXT_CHARS
    ? `${text.slice(0, MAX_DEBUG_TEXT_CHARS)}\n\n[truncated ${text.length - MAX_DEBUG_TEXT_CHARS} chars]`
    : text;
}

async function loadLatestCurationEntryForDebug(
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
    .find({ repoId, $or: clauses })
    .sort({ updatedAt: -1, createdAt: -1 })
    .limit(20)
    .toArray()
    .catch(() => []);
  return rows.find(hasGeneratedCurationContent) ?? rows[0];
}

async function enrichDebugRefs(
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
        debugContent: {
          mandatoryOnly: true,
          resolution: {
            path: stringValue(ref.path),
            providerId: stringValue(ref.providerId),
            mappingId: stringValue(providerMetadata.mappingId),
            agentName: stringValue(providerMetadata.agentName),
          },
          mandatoryContext: debugText(ref.content),
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
      if (!cache.has(cacheKey)) cache.set(cacheKey, loadLatestCurationEntryForDebug(db, repoId, entryId, path));
      entry = await cache.get(cacheKey);
    }
    const chunks = Array.isArray(entry?.chunks)
      ? entry.chunks.filter(isRecord).map((chunk) => ({
        chunkId: stringValue(chunk.chunkId),
        heading: stringValue(chunk.heading),
        text: debugText(chunk.text),
      }))
      : undefined;
    return {
      ...ref,
      debugContent: {
        resolution: {
          entryId,
          label,
          path,
          curationEntryFound: Boolean(entry),
          method: providerResolutionMethod || (entry ? 'debug_display_fallback' : 'unresolved'),
          debugOnlyFallback: !providerResolutionMethod && Boolean(entry),
          curationEntryLookup: entryId || path ? { repoId, entryId, path } : undefined,
        },
        cogneeChunkText: debugText(providerMetadata.cogneeChunkText) || (ref.providerId === 'cognee_memory' ? debugText(ref.content) : undefined),
        selectedContent: debugText(ref.content),
        curatedContext: debugText(entry?.curatedContext),
        retrievalText: debugText(entry?.retrievalText),
        chunks,
        mandatoryContext: ref.mandatory ? debugText(ref.content) : undefined,
      },
    };
  }));
}

function debugRefs(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => isRecord(item)) : [];
}

function stableManualCurationEntryId(repoId: string, body: Record<string, unknown>): string {
  const seed = stringValue(body.path) || stringValue(body.title) || randomUUID();
  const slug = seed.toLowerCase().replace(/[^a-z0-9._/-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 160) || randomUUID();
  return `manual:${repoId}:${slug}`;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

async function markContextDatasetStale(db: Db, repoId: string, entryId: string): Promise<void> {
  const now = new Date();
  await db.collection('repo_cognee_datasets').updateOne(
    { repoId },
    {
      $set: { curatedContextStale: true, updatedAt: now },
      $push: { diagnostics: { code: 'curated_context_stale', severity: 'info', entryId, message: 'Curated context was manually changed and needs context rebuild/update.' } },
    } as never,
  ).catch(() => {});
}

function safeRepoPath(repoPath: string, rawPath: string): string | null {
  const root = resolve(repoPath);
  const fullPath = resolve(root, rawPath);
  return fullPath === root || fullPath.startsWith(`${root}${sep}`) ? fullPath : null;
}

async function listRepoFiles(repoPath: string): Promise<Array<{ path: string; isDir: boolean }>> {
  const [tracked, untracked] = await Promise.all([
    exec('git', ['ls-files'], { cwd: repoPath }).catch(() => ({ stdout: '' })),
    exec('git', ['ls-files', '--others', '--exclude-standard'], { cwd: repoPath }).catch(() => ({ stdout: '' })),
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
  const imageExtensions = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'];
  if (imageExtensions.includes(ext)) {
    const maxImageSize = 50 * 1024 * 1024;
    if (stats.size > maxImageSize) {
      const err = new Error('Image file too large (max 50MB)') as Error & { status?: number };
      err.status = 413;
      throw err;
    }
    return {
      path: rawFilePath,
      content: readFileSync(fullPath).toString('base64'),
      isImage: true,
      mimeType: `image/${ext === 'jpg' ? 'jpeg' : ext === 'svg' ? 'svg+xml' : ext}`,
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

export function repoRoutes(db: Db): Router {
  const router = Router();
  const service = new RepoService(db);
  const knowledgeGraph = new RepoKnowledgeGraphService(db);
  const cogneeMemory = new CogneeMemoryService(db);
  const contextCuration = new RepoContextCurationService(db);
  const mandatoryContext = new RepoMandatoryContextService(db);
  const contextGraph = new RepoContextGraphService(db, cogneeMemory, mandatoryContext);

  // GET /api/repos
  router.get('/', async (_req: Request, res: Response) => {
    try {
      const repos = await service.list();
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
      if (!isGraphContextEnabled()) return res.status(409).json(contextProviderDisabledPayload('Allen context provider is disabled.'));
      const path = String(req.query.path ?? '');
      if (!path) return res.status(400).json({ error: 'path query param is required' });
      const ctx = await service.getContextByPath(path);
      if (!ctx) return res.status(404).json({ error: 'No context found for that path' });
      res.json(ctx);
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // GET /api/repos/knowledge-graph?path=... — path-based graph lookup (used by MCP tool)
  router.get('/knowledge-graph', async (req: Request, res: Response) => {
    try {
      if (!isGraphContextEnabled()) return res.status(409).json(contextProviderDisabledPayload('Allen context provider is disabled.'));
      const path = String(req.query.path ?? '');
      if (!path) return res.status(400).json({ error: 'path query param is required' });
      let current = path;
      let resolvedRepo: Record<string, unknown> | null = null;
      for (let i = 0; i < 10; i++) {
        const repo = await db.collection('repos').findOne({ path: current });
        if (repo) { resolvedRepo = repo; break; }
        const workspace = await db.collection('workspaces').findOne({ worktreePath: current }).catch(() => null);
        if (workspace?.repoId) {
          resolvedRepo = await db.collection('repos').findOne({ _id: new ObjectId(workspace.repoId as string) });
          if (resolvedRepo) break;
        }
        const parent = dirname(current);
        if (!parent || parent === current || parent === '/') break;
        current = parent;
      }
      if (!resolvedRepo) return res.status(404).json({ error: 'No registered repo found for that path' });
      const graph = await knowledgeGraph.getLatestGraph(String(resolvedRepo._id));
      if (!graph) return res.status(404).json({ error: 'No knowledge graph found for that repo' });
      res.json(graph);
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // POST /api/repos/knowledge-graph?path=... — path-based save for MCP agents.
  router.post('/knowledge-graph', async (req: Request, res: Response) => {
    try {
      if (!isContextEngineEnabled()) return res.status(409).json(contextProviderDisabledPayload());
      const path = String(req.query.path ?? req.body?.repo_path ?? '');
      if (!path) return res.status(400).json({ error: 'path query param or repo_path body field is required' });
      const result = await knowledgeGraph.saveGeneratedGraph({
        repoPath: path,
        graph: req.body?.graph,
        graphJson: req.body?.graph_json ?? req.body?.graphJson,
        graphMode: req.body?.graph_mode ?? req.body?.graphMode,
        sourceExecutionId: req.body?.source_execution_id ?? req.body?.sourceExecutionId,
        source: 'agent_tool',
      });
      res.status(201).json(result);
    } catch (err: unknown) {
      if (isRepoKnowledgeGraphValidationError(err)) {
        return res.status(400).json((err as { payload: unknown }).payload);
      }
      res.status(400).json({ error: (err as Error).message });
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
  router.post('/mandatory-context', async (req: Request, res: Response) => {
    try {
      if (!isContextEngineEnabled()) return res.status(409).json(contextProviderDisabledPayload('Context provider is disabled.'));
      const result = await mandatoryContext.saveManyFromAgent(req.body ?? {});
      res.status(201).json(result);
    } catch (err: unknown) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // GET /api/repos/skill-body?path=...&refId=... — load full repo skill file by graph ref.
  router.get('/skill-body', async (req: Request, res: Response) => {
    try {
      if (!isGraphContextEnabled()) return res.status(409).json(contextProviderDisabledPayload('Allen context provider is disabled.'));
      const path = String(req.query.path ?? '');
      const refId = req.query.refId ? String(req.query.refId) : undefined;
      const skillPath = req.query.skillPath ? String(req.query.skillPath) : undefined;
      if (!path) return res.status(400).json({ error: 'path query param is required' });
      if (!refId && !skillPath) return res.status(400).json({ error: 'refId or skillPath is required' });
      const result = await knowledgeGraph.getSkillBody({ repoPath: path, refId, skillPath });
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
      const result = await knowledgeGraph.getContextBody({ repoPath: path, refId, contextPath });
      res.json(result);
    } catch (err: unknown) {
      const msg = (err as Error).message;
      const status = msg.includes('not found') || msg.includes('No knowledge graph') ? 404 : 400;
      res.status(status).json({ error: msg });
    }
  });

  // GET /api/repos/search-knowledge?path=...&query=... — find knowledge refs for follow-up context loading.
  router.get('/search-knowledge', async (req: Request, res: Response) => {
    try {
      if (!isGraphContextEnabled()) return res.status(409).json(contextProviderDisabledPayload('Allen context provider is disabled.'));
      const path = String(req.query.path ?? '');
      const query = String(req.query.query ?? '');
      const nodeRole = req.query.nodeRole ? String(req.query.nodeRole) : undefined;
      const currentFilesRaw = req.query.currentFiles;
      const currentFiles = Array.isArray(currentFilesRaw)
        ? currentFilesRaw.map(String)
        : typeof currentFilesRaw === 'string' && currentFilesRaw.length > 0
          ? currentFilesRaw.split(',').map((v) => v.trim()).filter(Boolean)
          : undefined;
      const limit = req.query.limit ? Number(req.query.limit) : undefined;
      if (!path) return res.status(400).json({ error: 'path query param is required' });
      if (!query.trim()) return res.status(400).json({ error: 'query query param is required' });
      const result = await knowledgeGraph.searchRepoKnowledge({ repoPath: path, query, nodeRole, currentFiles, limit });
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
    try {
      const repo = await service.getById(param(req, 'id'));
      if (!repo?.path || typeof repo.path !== 'string') return res.status(404).json({ error: 'Repo not found' });
      res.json(await listRepoFiles(repo.path));
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // GET /api/repos/:id/file/* — read a file from a registered repository.
  router.get('/:id/file/*', async (req: Request, res: Response) => {
    try {
      const repo = await service.getById(param(req, 'id'));
      if (!repo?.path || typeof repo.path !== 'string') return res.status(404).json({ error: 'Repo not found' });
      const rawFilePath = (req.params as Record<string, string>)[0] ?? '';
      res.json(readRepoFile(repo.path, rawFilePath));
    } catch (err: unknown) {
      const status = typeof (err as { status?: unknown }).status === 'number' ? (err as { status: number }).status : 500;
      res.status(status).json({ error: (err as Error).message });
    }
  });

  // GET /api/repos/:id
  router.get('/:id', async (req: Request, res: Response) => {
    try {
      const repo = await service.getById(param(req, 'id'));
      if (!repo) return res.status(404).json({ error: 'Not found' });
      res.json(repo);
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
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

  // POST /api/repos/:id/rescan-context — deep agent-driven context rescan (async, returns 202)
  router.post('/:id/rescan-context', async (req: Request, res: Response) => {
    try {
      if (!isGraphContextEnabled()) return res.status(409).json(contextProviderDisabledPayload('Allen context provider is disabled.'));
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

  // GET /api/repos/:id/context-curation — fetch latest repo context curation profile.
  router.get('/:id/context-curation', async (req: Request, res: Response) => {
    try {
      if (!isContextEngineEnabled()) return res.status(409).json(contextProviderDisabledPayload('Context provider is disabled.'));
      const profile = await contextCuration.getLatest(param(req, 'id'));
      if (!profile) return res.status(404).json({ error: 'No context curation profile found for repo' });
      res.json(profile);
    } catch (err: unknown) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // POST /api/repos/:id/context-curation/refresh — incrementally curate repo context.
  router.post('/:id/context-curation/refresh', async (req: Request, res: Response) => {
    try {
      if (!isContextEngineEnabled()) return res.status(409).json(contextProviderDisabledPayload('Context provider is disabled.'));
      const repo = await db.collection('repos').findOne({ _id: new ObjectId(param(req, 'id')) });
      if (!repo) return res.status(404).json({ error: 'Repo not found' });
      const scope = req.body?.scope ?? (req.body?.documentsOnly ? { mode: 'documents' } : undefined);
      const prompt = [
        `Run repo context curation for ${String(repo.name ?? 'this repo')}.`,
        `repo_id: ${String(repo._id)}`,
        `repo_path: ${String(repo.path ?? '')}`,
        scope ? `scope: ${JSON.stringify(scope)}` : 'scope: default incremental context inventory',
        req.body?.force ? 'force: true' : 'force: false',
        'Prepare the run, spawn worker agents as needed, validate staging, retry incomplete files, and promote only after validation passes.',
      ].join('\n');
      const result = await executeChatTool('spawn_agent', {
        agent_name: 'repo-context-curator',
        prompt,
        repo_path: String(repo.path ?? ''),
      }, db);
      res.status(202).json(result);
    } catch (err: unknown) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // POST /api/repos/:id/context-curation/stop — stop active context curation.
  router.post('/:id/context-curation/stop', async (req: Request, res: Response) => {
    try {
      if (!isContextEngineEnabled()) return res.status(409).json(contextProviderDisabledPayload('Context provider is disabled.'));
      const profile = await contextCuration.stop(param(req, 'id'));
      res.status(202).json(profile);
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
        db.collection('repo_context_curation_entries').find({ repoId }, { sort: { path: 1, updatedAt: -1 } }).toArray(),
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
      const entries = await db.collection('repo_context_curation_entries').find({ repoId }, { sort: { path: 1, updatedAt: -1 } }).toArray();
      res.json(entries);
    } catch (err: unknown) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  router.get('/:id/context-management/mandatory', async (req: Request, res: Response) => {
    try {
      if (!isContextEngineEnabled()) return res.status(409).json(contextProviderDisabledPayload('Context provider is disabled.'));
      const agentName = req.query.agentName ? String(req.query.agentName) : undefined;
      res.json(await mandatoryContext.list(param(req, 'id'), { agentName }));
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

  router.get('/:id/context-management/search', async (req: Request, res: Response) => {
    try {
      if (!isGraphContextEnabled()) return res.status(409).json(contextProviderDisabledPayload('Allen context provider is disabled.'));
      const repo = await db.collection('repos').findOne({ _id: new ObjectId(param(req, 'id')) });
      if (!repo?.path) return res.status(404).json({ error: 'Repo not found' });
      const query = String(req.query.query ?? '');
      if (!query.trim()) return res.status(400).json({ error: 'query query param is required' });
      const nodeRole = req.query.nodeRole ? String(req.query.nodeRole) : undefined;
      const limit = req.query.limit ? Number(req.query.limit) : undefined;
      const result = await knowledgeGraph.searchRepoKnowledge({ repoPath: String(repo.path), query, nodeRole, limit });
      res.json(result);
    } catch (err: unknown) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  router.post('/:id/context-management/debug-search', async (req: Request, res: Response) => {
    try {
      if (!isContextEngineEnabled()) return res.status(409).json(contextProviderDisabledPayload('Context provider is disabled.'));
      const repoId = param(req, 'id');
      const repo = await db.collection('repos').findOne({ _id: new ObjectId(repoId) });
      if (!repo?.path) return res.status(404).json({ error: 'Repo not found' });
      const query = String(req.body?.query ?? '').trim();
      if (!query) return res.status(400).json({ error: 'query is required' });
      const graphMode = isGraphContextEnabled() ? 'full_graph' : 'mandatory_context_map';
      const index = await knowledgeGraph.getLatestIndex(repoId, graphMode).catch(() => null);
      const indexId = index ? String(index.indexId) : `context-debug:${repoId}`;
      const nodes = index ? await db.collection('knowledge_nodes').find({ repoId, indexId }).toArray() : [];
      const packet = await new RepoContextEngine(undefined, undefined, { db }).buildPacket({
        packetId: `debug-${randomUUID()}`,
        executionId: `debug-${randomUUID()}`,
        repoId,
        repoName: String(repo.name ?? ''),
        repoPath: String(repo.path),
        indexId,
        indexFreshness: String((index?.freshness as { status?: string } | undefined)?.status ?? (index ? 'fresh' : 'unindexed')),
        workflowName: 'context_management_debug',
        nodeName: String(req.body?.agentName ?? req.body?.nodeRole ?? 'debugger'),
        nodeRole: String(req.body?.nodeRole ?? req.body?.agentName ?? 'debugger'),
        executionKind: 'chat_agent',
        targetRole: String(req.body?.agentName ?? req.body?.nodeRole ?? 'debugger'),
        attempt: 1,
        state: { repo_path: repo.path, task: query },
        prompt: query,
        provider: 'unknown',
        currentFiles: stringArrayValue(req.body?.currentFiles),
        nodes: nodes as never[],
      });
      const adapter = new WorkflowContextInjectionAdapter();
      const injection = await adapter.buildInjection({
        packet,
        provider: 'unknown',
        repoPath: String(repo.path),
      });
      const contextInjection = summarizeInjection(injection);
      const [candidateRefs, selectedRefs, injectableRefs, rejectedRefs, availableRefs] = await Promise.all([
        enrichDebugRefs(db, repoId, debugRefs(packet.candidateRefs)),
        enrichDebugRefs(db, repoId, debugRefs(packet.selectedRefs)),
        enrichDebugRefs(db, repoId, debugRefs(packet.injectableRefs)),
        enrichDebugRefs(db, repoId, debugRefs(packet.rejectedRefs)),
        enrichDebugRefs(db, repoId, debugRefs(packet.availableRefs)),
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
        debug: {
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
      const now = new Date();
      const result = await db.collection('repo_context_curation_entries').findOneAndUpdate(
        { repoId, entryId },
        {
          $set: {
            ...patch,
            manualOverride: true,
            cogneeSyncStatus: 'stale',
            updatedAt: now,
          },
        },
        { returnDocument: 'after' },
      );
      if (!result) return res.status(404).json({ error: 'Curated context entry not found' });
      await markContextDatasetStale(db, repoId, entryId);
      res.json(result);
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
      const now = new Date();
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
        cogneeSyncStatus: 'stale',
        createdAt: now,
        updatedAt: now,
      };
      const existing = await db.collection('repo_context_curation_entries').findOne({ repoId, entryId });
      if (existing) return res.status(409).json({ error: 'Curated context entry already exists' });
      await db.collection('repo_context_curation_entries').insertOne(entry);
      await markContextDatasetStale(db, repoId, entryId);
      res.status(201).json(entry);
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
      if (!isGraphContextEnabled()) return res.status(409).json(contextProviderDisabledPayload('Allen context provider is disabled.'));
      const ctx = await service.getContext(param(req, 'id'));
      if (!ctx) return res.status(404).json({ error: 'No context found for that repo' });
      res.json(ctx);
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  return router;
}
