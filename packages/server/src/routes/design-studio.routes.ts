/**
 * Allen Design Studio — HTTP routes (/api/design-studio/*)
 *
 * Surfaces the three-tier model (workspaces → sessions → versions) plus the
 * analysis/discovery, generation/iteration, variant, preview, and export flows.
 * Mounted AFTER requireAuth. The unauthenticated preview static route is mounted
 * separately in server.ts (see createPreviewHandler).
 */

import { Router, type Request, type Response } from 'express';
import type { Db } from 'mongodb';
import { DesignStudioStore } from '../services/design-studio/store.service.js';
import { DesignStudioLLM, makeDefaultCompleter, renderDesignContext, buildDesignerPersona, type Completer } from '../services/design-studio/llm.service.js';
import { scanRepoForStyle } from '../services/design-studio/repo-scan.js';
import { scanRepoForContext } from '../services/design-studio/repo-scan.js';
import { materializeRepoContext, type RepoContextData } from '../services/design-studio/workspace-fs.js';
import type { RepoContextAnalysis } from '../services/design-studio/llm.service.js';
import { buildPreview } from '../services/design-studio/preview.service.js';
import { exportVersion } from '../services/design-studio/export.service.js';
import { RepoService } from '../services/repo.service.js';
import { ChatService } from '../services/chat.service.js';
import { getEnabledProvidersFromRegistry, type ProviderConfig } from '../services/chat-providers.js';
import { ensureWorkspaceDir, listWorkspaceFiles, exportWorkspace, materializeDesignSystemKit, materializeProMaxDesignIntelligence, readWorkspaceFile } from '../services/design-studio/workspace-fs.js';
import { generateProMaxDesignIntelligence } from '../services/design-studio/ui-ux-pro-max.js';
import type { DesignProfile, GreenfieldBrief } from '../services/design-studio/types.js';
import { logger } from '../logger.js';

const DESIGN_STUDIO_DEFAULT_PROVIDER = 'claude';
const DESIGN_STUDIO_DEFAULT_MODEL = 'claude-opus-4-8';

function err(res: Response, status: number, message: string, code: string): void {
  res.status(status).json({ error: message, code });
}

function normalizeStudioSelectionInput(input: { provider?: unknown; model?: unknown }): { provider: string; model: string } {
  const rawProvider = typeof input.provider === 'string' && input.provider.trim() ? input.provider.trim() : DESIGN_STUDIO_DEFAULT_PROVIDER;
  const provider = rawProvider === 'claude-cli' ? 'claude' : rawProvider;
  const rawModel = typeof input.model === 'string' && input.model.trim() ? input.model.trim() : DESIGN_STUDIO_DEFAULT_MODEL;
  const model = provider === 'claude' && rawModel === 'opus' ? DESIGN_STUDIO_DEFAULT_MODEL : rawModel;
  return { provider, model };
}

function listProviderModels(provider: ProviderConfig): string[] {
  return provider.models.length ? provider.models : (provider.modelSuggestions ?? []);
}

function chooseAvailableStudioModel(provider: ProviderConfig, requestedModel: string): string {
  if (provider.open) return requestedModel;

  const models = listProviderModels(provider);
  if (models.length === 0 || models.includes(requestedModel)) return requestedModel;

  if (provider.provider === DESIGN_STUDIO_DEFAULT_PROVIDER) {
    if (models.includes(DESIGN_STUDIO_DEFAULT_MODEL)) return DESIGN_STUDIO_DEFAULT_MODEL;
    const opusModel = [...models].reverse().find((m) => m.toLowerCase().includes('opus'));
    if (opusModel) return opusModel;
  }

  if (models.includes(provider.defaultModel)) return provider.defaultModel;
  return models[0] ?? requestedModel;
}

function isModelNotFoundError(error: unknown): boolean {
  const e = error as Error & { status?: number; statusCode?: number; code?: unknown };
  const message = String(e?.message ?? '').toLowerCase();
  return e?.status === 404
    || e?.statusCode === 404
    || String(e?.code ?? '').toLowerCase() === 'not_found'
    || (message.includes('404') && (message.includes('model') || message.includes('not found')));
}

export interface DesignStudioRoutesOptions {
  /** Override the LLM completer (used by tests). */
  completerFactory?: (db: Db) => Completer;
}

export function designStudioRoutes(db: Db, opts: DesignStudioRoutesOptions = {}): Router {
  const router = Router();
  const store = new DesignStudioStore(db);
  const repos = new RepoService(db);
  const makeLLM = (override?: { provider?: string; model?: string }): DesignStudioLLM =>
    new DesignStudioLLM(opts.completerFactory ? opts.completerFactory(db) : makeDefaultCompleter(db, override));

  const userId = (req: Request): string | undefined => (req as any).user?.sub as string | undefined;

  async function resolveStudioModelSelection(
    input: { provider?: unknown; model?: unknown },
    requestId?: string,
  ): Promise<{ provider: string; model: string }> {
    const requested = normalizeStudioSelectionInput(input);
    const providers = await getEnabledProvidersFromRegistry(db);
    const providerConfig = providers.find((p) => p.provider === requested.provider)
      ?? providers.find((p) => p.provider === DESIGN_STUDIO_DEFAULT_PROVIDER)
      ?? providers[0];

    if (!providerConfig) return requested;

    const model = chooseAvailableStudioModel(providerConfig, requested.model);
    const resolved = { provider: String(providerConfig.provider), model };

    if (resolved.provider !== requested.provider || resolved.model !== requested.model) {
      logger.warn('[design-studio] resolved unavailable Studio model', {
        component: 'design-studio',
        requestId,
        requestedProvider: requested.provider,
        requestedModel: requested.model,
        provider: resolved.provider,
        model: resolved.model,
      });
    }

    return resolved;
  }

  async function resolveStudioFallbackModel(provider: string, failedModel: string): Promise<string | undefined> {
    const providers = await getEnabledProvidersFromRegistry(db).catch(() => []);
    const cfg = providers.find((p) => p.provider === provider);
    if (!cfg || cfg.open) return undefined;
    const models = listProviderModels(cfg).filter((m) => m !== failedModel);
    if (provider === DESIGN_STUDIO_DEFAULT_PROVIDER) {
      const opusModel = [...models].reverse().find((m) => m.toLowerCase().includes('opus'));
      if (opusModel) return opusModel;
    }
    if (models.includes(cfg.defaultModel)) return cfg.defaultModel;
    return models[0];
  }

  async function refreshProMaxIntelligence(input: {
    workspaceId: string;
    workspaceName: string;
    profile?: DesignProfile;
    brief?: GreenfieldBrief;
    scan?: Awaited<ReturnType<typeof scanRepoForStyle>>;
    requestId?: string;
  }): Promise<void> {
    try {
      const insight = await generateProMaxDesignIntelligence({
        workspaceName: input.workspaceName,
        profile: input.profile,
        brief: input.brief,
        scan: input.scan,
      });
      await materializeProMaxDesignIntelligence(input.workspaceId, insight);
    } catch (e) {
      logger.warn('[design-studio] UI/UX Pro Max intelligence generation skipped', {
        component: 'design-studio',
        workspaceId: input.workspaceId,
        requestId: input.requestId,
        error: (e as Error).message,
      });
    }
  }

  async function refreshRepoContext(input: {
    workspaceId: string;
    sourceRepoPath: string;
    requestId?: string;
  }): Promise<void> {
    try {
      const contextScan = await scanRepoForContext(input.sourceRepoPath);
      const llm = makeLLM();
      const analysis: RepoContextAnalysis = await llm.analyzeRepoContext(contextScan, { repoPath: input.sourceRepoPath });
      const data: RepoContextData = {
        ...analysis,
        generatedAt: new Date().toISOString(),
      };
      await materializeRepoContext(input.workspaceId, data);
    } catch (e) {
      logger.warn('[design-studio] repo context analysis skipped', {
        component: 'design-studio',
        workspaceId: input.workspaceId,
        requestId: input.requestId,
        error: (e as Error).message,
      });
    }
  }

  // ── Workspaces ────────────────────────────────────────────────────────────

  router.get('/workspaces', async (req, res) => {
    try {
      res.json(await store.listWorkspaces(userId(req)));
    } catch (e) {
      err(res, 500, (e as Error).message, 'INTERNAL_ERROR');
    }
  });

  // Create (or reuse) a workspace. Repo mode dedupes per repo (R22) and analyzes.
  router.post('/workspaces', async (req, res) => {
    try {
      const { kind, repoId, name } = req.body ?? {};
      if (kind !== 'repo' && kind !== 'greenfield') return err(res, 400, 'kind must be repo|greenfield', 'BAD_KIND');

      if (kind === 'repo') {
        if (!repoId) return err(res, 400, 'repoId required for repo workspace', 'REPO_REQUIRED');
        const existing = await store.findRepoWorkspace(repoId, userId(req));
        if (existing) return res.status(200).json(existing);
        const repo = await repos.getById(repoId);
        if (!repo) return err(res, 404, 'repo not found', 'REPO_NOT_FOUND');
        const ws = await store.createWorkspace({
          kind: 'repo',
          name: (name as string) || String(repo.name ?? 'Repository'),
          sourceRepoId: repoId,
          sourceRepoPath: String(repo.path ?? ''),
          ownerUserId: userId(req),
        });
        return res.status(201).json(ws);
      }

      const ws = await store.createWorkspace({ kind: 'greenfield', name: (name as string) || 'New idea', ownerUserId: userId(req) });
      res.status(201).json(ws);
    } catch (e) {
      err(res, 500, (e as Error).message, 'INTERNAL_ERROR');
    }
  });

  router.get('/workspaces/:id', async (req, res) => {
    const ws = await store.getWorkspace(req.params.id);
    if (!ws) return err(res, 404, 'workspace not found', 'NOT_FOUND');
    res.json(ws);
  });

  router.delete('/workspaces/:id', async (req, res) => {
    await store.deleteWorkspace(req.params.id);
    res.status(204).end();
  });

  // Mode A: analyze the repo → produce a profile (R3/R4.1/R4.2).
  router.post('/workspaces/:id/analyze', async (req, res) => {
    try {
      const ws = await store.getWorkspace(req.params.id);
      if (!ws) return err(res, 404, 'workspace not found', 'NOT_FOUND');
      if (ws.kind !== 'repo' || !ws.sourceRepoPath) return err(res, 400, 'not a repo workspace', 'BAD_WORKSPACE');

      // Optional user-selected provider/model for analysis.
      let { provider, model } = await resolveStudioModelSelection({
        provider: req.body?.provider ?? ws.analysisProvider,
        model: req.body?.model ?? ws.analysisModel,
      }, (req as any).requestId);

      await store.updateWorkspace(req.params.id, { profileStatus: 'analyzing', analysisProvider: provider, analysisModel: model });
      const scan = await scanRepoForStyle(ws.sourceRepoPath);
      // Pass the repo path so the agent can explore the repo with its file tools,
      // not just the truncated scan excerpt.
      let profile: DesignProfile;
      try {
        profile = await makeLLM({ provider, model }).analyzeRepo(scan, { repoPath: ws.sourceRepoPath });
      } catch (e) {
        const fallbackModel = isModelNotFoundError(e) ? await resolveStudioFallbackModel(provider, model) : undefined;
        if (!fallbackModel) throw e;
        logger.warn('[design-studio] retrying repo analysis with fallback model after provider 404', {
          component: 'design-studio',
          workspaceId: req.params.id,
          requestId: (req as any).requestId,
          provider,
          failedModel: model,
          fallbackModel,
          error: (e as Error).message,
        });
        model = fallbackModel;
        await store.updateWorkspace(req.params.id, { analysisProvider: provider, analysisModel: model });
        profile = await makeLLM({ provider, model }).analyzeRepo(scan, { repoPath: ws.sourceRepoPath });
      }

      // Decide the gate: inconsistent (R4.1) or multi-theme (R4.2) needs a choice.
      const needsChoice = profile.consistency.consistent === false || (profile.themes?.length ?? 0) >= 2;
      const status = needsChoice ? 'needs_choice' : 'needs_review';
      const updated = await store.setProfile(req.params.id, profile, status, scan.fingerprint);
      await ensureWorkspaceDir(req.params.id, profile, {
        workspaceName: ws.name,
        sourceRepoName: ws.kind === 'repo' ? ws.name : undefined,
        sourceRepoPath: ws.kind === 'repo' ? ws.sourceRepoPath : undefined,
        sourceRepoId: ws.kind === 'repo' ? ws.sourceRepoId : undefined,
      });
      await materializeDesignSystemKit(req.params.id, profile);
      await refreshProMaxIntelligence({
        workspaceId: req.params.id,
        workspaceName: ws.name,
        profile,
        scan,
        requestId: (req as any).requestId,
      });
      if (ws.sourceRepoPath) {
        await refreshRepoContext({
          workspaceId: req.params.id,
          sourceRepoPath: ws.sourceRepoPath,
          requestId: (req as any).requestId,
        });
      }
      res.json(updated);
    } catch (e) {
      await store.setProfileStatus(req.params.id, 'pending').catch(() => {});
      logger.error('[design-studio] repo analysis failed', {
        component: 'design-studio',
        workspaceId: req.params.id,
        requestId: (req as any).requestId,
        error: (e as Error).message,
        stack: (e as Error).stack,
      });
      err(res, 500, (e as Error).message, 'ANALYZE_FAILED');
    }
  });

  // Confirm / correct the profile and the required choices (R4/R4.1/R4.2).
  router.post('/workspaces/:id/profile', async (req, res) => {
    try {
      const ws = await store.getWorkspace(req.params.id);
      if (!ws || !ws.profile) return err(res, 404, 'no profile to confirm', 'NO_PROFILE');
      const { profile: edited, strategy, selectedTheme } = req.body ?? {};
      const profile: DesignProfile = { ...ws.profile, ...(edited ?? {}) };

      // Enforce the mandatory choices before confirmation.
      if (profile.consistency.consistent === false) {
        const chosen = strategy ?? profile.consistency.strategy;
        if (chosen !== 'mimic' && chosen !== 'normalize') {
          return err(res, 400, 'inconsistent repo requires strategy: mimic|normalize', 'STRATEGY_REQUIRED');
        }
        profile.consistency.strategy = chosen;
      }
      if ((profile.themes?.length ?? 0) >= 2) {
        const theme = selectedTheme ?? profile.selectedTheme;
        if (!theme) return err(res, 400, 'multiple themes require selectedTheme', 'THEME_REQUIRED');
        profile.selectedTheme = theme;
      }

      const updated = await store.setProfile(req.params.id, profile, 'confirmed');
      await ensureWorkspaceDir(req.params.id, profile, {
        workspaceName: ws.name,
        sourceRepoName: ws.kind === 'repo' ? ws.name : undefined,
        sourceRepoPath: ws.kind === 'repo' ? ws.sourceRepoPath : undefined,
        sourceRepoId: ws.kind === 'repo' ? ws.sourceRepoId : undefined,
      });
      await materializeDesignSystemKit(req.params.id, profile);
      const scan = ws.kind === 'repo' && ws.sourceRepoPath
        ? await scanRepoForStyle(ws.sourceRepoPath).catch(() => undefined)
        : undefined;
      await refreshProMaxIntelligence({
        workspaceId: req.params.id,
        workspaceName: ws.name,
        profile,
        scan,
        requestId: (req as any).requestId,
      });
      res.json(updated);
    } catch (e) {
      err(res, 500, (e as Error).message, 'INTERNAL_ERROR');
    }
  });

  // R22.2 — has the repo changed since the profile was built?
  router.get('/workspaces/:id/repo-change', async (req, res) => {
    try {
      const ws = await store.getWorkspace(req.params.id);
      if (!ws) return err(res, 404, 'workspace not found', 'NOT_FOUND');
      if (ws.kind !== 'repo' || !ws.sourceRepoPath) return res.json({ changed: false });
      const scan = await scanRepoForStyle(ws.sourceRepoPath);
      res.json({ changed: !!ws.repoFingerprint && scan.fingerprint !== ws.repoFingerprint, hasProfile: !!ws.profile });
    } catch (e) {
      err(res, 500, (e as Error).message, 'INTERNAL_ERROR');
    }
  });

  // REQ-005: Manual refresh — re-run full analysis + context update for a confirmed workspace.
  // The workspace stays in "confirmed" status; this just refreshes the system/ files.
  router.post('/workspaces/:id/refresh', async (req, res) => {
    try {
      const ws = await store.getWorkspace(req.params.id);
      if (!ws) return err(res, 404, 'workspace not found', 'NOT_FOUND');
      if (ws.kind !== 'repo' || !ws.sourceRepoPath) return err(res, 400, 'refresh only available for repo workspaces', 'BAD_WORKSPACE');
      if (ws.profileStatus !== 'confirmed') return err(res, 409, 'workspace must be confirmed before refresh', 'NOT_CONFIRMED');

      const { provider, model } = await resolveStudioModelSelection({
        provider: req.body?.provider ?? ws.analysisProvider,
        model: req.body?.model ?? ws.analysisModel,
      }, (req as any).requestId);

      // Re-run full style analysis to refresh design system kit.
      const scan = await scanRepoForStyle(ws.sourceRepoPath);
      let profile;
      try {
        profile = await makeLLM({ provider, model }).analyzeRepo(scan, { repoPath: ws.sourceRepoPath });
      } catch (e) {
        const fallbackModel = isModelNotFoundError(e) ? await resolveStudioFallbackModel(provider, model) : undefined;
        if (!fallbackModel) throw e;
        profile = await makeLLM({ provider, model: fallbackModel }).analyzeRepo(scan, { repoPath: ws.sourceRepoPath });
      }

      // Persist updated profile (keeping status as 'confirmed').
      const updated = await store.setProfile(req.params.id, profile, 'confirmed', scan.fingerprint);

      // Refresh all system/ files.
      await ensureWorkspaceDir(req.params.id, profile, {
        workspaceName: ws.name,
        sourceRepoName: ws.name,
        sourceRepoPath: ws.sourceRepoPath,
        sourceRepoId: ws.sourceRepoId,
      });
      await materializeDesignSystemKit(req.params.id, profile);
      await refreshProMaxIntelligence({
        workspaceId: req.params.id,
        workspaceName: ws.name,
        profile,
        scan,
        requestId: (req as any).requestId,
      });
      await refreshRepoContext({
        workspaceId: req.params.id,
        sourceRepoPath: ws.sourceRepoPath,
        requestId: (req as any).requestId,
      });

      res.json(updated);
    } catch (e) {
      logger.error('[design-studio] workspace refresh failed', {
        component: 'design-studio',
        workspaceId: req.params.id,
        requestId: (req as any).requestId,
        error: (e as Error).message,
        stack: (e as Error).stack,
      });
      err(res, 500, (e as Error).message, 'REFRESH_FAILED');
    }
  });

  // Mode B — greenfield discovery synthesis (R6/R7/R22.3).
  router.post('/workspaces/:id/greenfield', async (req, res) => {
    try {
      const ws = await store.getWorkspace(req.params.id);
      if (!ws) return err(res, 404, 'workspace not found', 'NOT_FOUND');
      if (ws.kind !== 'greenfield') return err(res, 400, 'not a greenfield workspace', 'BAD_WORKSPACE');
      const { idea, answers } = req.body ?? {};
      const brief = await makeLLM().synthesizeBrief({ idea: idea ?? ws.name, answers: answers ?? {} });
      const updated = await store.setGreenfieldBrief(req.params.id, brief, 'confirmed');
      await ensureWorkspaceDir(req.params.id, undefined, { workspaceName: ws.name });
      await refreshProMaxIntelligence({
        workspaceId: req.params.id,
        workspaceName: ws.name,
        brief,
        requestId: (req as any).requestId,
      });
      res.json(updated);
    } catch (e) {
      err(res, 500, (e as Error).message, 'GREENFIELD_FAILED');
    }
  });

  // ── Sessions ────────────────────────────────────────────────────────────────

  router.get('/workspaces/:id/sessions', async (req, res) => {
    res.json(await store.listSessions(req.params.id));
  });

  // Files in the workspace's shared design-system folder.
  router.get('/workspaces/:id/files', async (req, res) => {
    try {
      const ws = await store.getWorkspace(req.params.id);
      await ensureWorkspaceDir(req.params.id, ws?.profile, {
        workspaceName: ws?.name,
        sourceRepoName: ws?.kind === 'repo' ? ws.name : undefined,
        sourceRepoPath: ws?.kind === 'repo' ? ws.sourceRepoPath : undefined,
        sourceRepoId: ws?.kind === 'repo' ? ws.sourceRepoId : undefined,
      });
      res.json(await listWorkspaceFiles(req.params.id));
    } catch (e) {
      err(res, 500, (e as Error).message, 'INTERNAL_ERROR');
    }
  });

  router.get('/workspaces/:id/files/content', async (req, res) => {
    try {
      const ws = await store.getWorkspace(req.params.id);
      await ensureWorkspaceDir(req.params.id, ws?.profile, {
        workspaceName: ws?.name,
        sourceRepoName: ws?.kind === 'repo' ? ws.name : undefined,
        sourceRepoPath: ws?.kind === 'repo' ? ws.sourceRepoPath : undefined,
        sourceRepoId: ws?.kind === 'repo' ? ws.sourceRepoId : undefined,
      });
      const path = typeof req.query.path === 'string' ? req.query.path : '';
      res.json(await readWorkspaceFile(req.params.id, path));
    } catch (e) {
      err(res, 400, (e as Error).message, 'READ_FILE_FAILED');
    }
  });

  // Export the whole design system as a standalone offline bundle.
  router.post('/workspaces/:id/export', async (req, res) => {
    try {
      const ws = await store.getWorkspace(req.params.id);
      if (!ws) return err(res, 404, 'workspace not found', 'NOT_FOUND');
      const result = await exportWorkspace(req.params.id, { name: ws.name, destinationDir: req.body?.destinationDir });
      res.json(result);
    } catch (e) {
      err(res, 500, (e as Error).message, 'EXPORT_FAILED');
    }
  });

  // Chat-based design sessions for this workspace (the persona-driven flow).
  // These are chat_sessions tagged with studioWorkspaceId; they open in Studio.
  router.get('/workspaces/:id/designs', async (req, res) => {
    try {
      const uid = userId(req);
      const query: Record<string, unknown> = { studioWorkspaceId: req.params.id };
      if (uid) query.ownerUserId = uid;
      const docs = await db.collection('chat_sessions')
        .find(query)
        .project({ title: 1, lastMessageAt: 1, createdAt: 1, messageCount: 1 })
        .sort({ lastMessageAt: -1 })
        .limit(200)
        .toArray();
      res.json(docs.map((d) => ({
        _id: String(d._id),
        title: (d.title as string) ?? 'Design',
        lastMessageAt: d.lastMessageAt ?? d.createdAt,
        messageCount: d.messageCount ?? 0,
      })));
    } catch (e) {
      err(res, 500, (e as Error).message, 'INTERNAL_ERROR');
    }
  });

  router.post('/workspaces/:id/sessions', async (req, res) => {
    const ws = await store.getWorkspace(req.params.id);
    if (!ws) return err(res, 404, 'workspace not found', 'NOT_FOUND');
    const session = await store.createSession({ workspaceId: req.params.id, title: req.body?.title, ownerUserId: userId(req) });
    res.status(201).json(session);
  });

  router.get('/sessions/:id', async (req, res) => {
    const s = await store.getSession(req.params.id);
    if (!s) return err(res, 404, 'session not found', 'NOT_FOUND');
    res.json(s);
  });

  router.delete('/sessions/:id', async (req, res) => {
    await store.deleteSession(req.params.id);
    res.status(204).end();
  });

  router.get('/sessions/:id/messages', async (req, res) => {
    res.json(await store.listMessages(req.params.id));
  });

  router.get('/sessions/:id/versions', async (req, res) => {
    res.json(await store.listVersions(req.params.id));
  });

  // Build the generator context from the workspace profile/brief, gating on confirm.
  async function requireContext(workspaceId: string): Promise<{ context: string } | { code: string; message: string }> {
    const ws = await store.getWorkspace(workspaceId);
    if (!ws) return { code: 'NOT_FOUND', message: 'workspace not found' };
    if (ws.profileStatus !== 'confirmed') return { code: 'NOT_CONFIRMED', message: 'confirm the design profile/brief before generating' };
    const profile: DesignProfile | undefined = ws.profile;
    const brief: GreenfieldBrief | undefined = ws.greenfieldBrief;
    if (!profile && !brief) return { code: 'NO_CONTEXT', message: 'workspace has no profile or brief' };
    return { context: renderDesignContext({ profile, brief }) };
  }

  // Start a chat-based design session: creates a chat session running the
  // "UI Designer" persona (per-session prompt) bound to the workspace's repo.
  // Returns the chat session id; the UI renders ChatPage on it.
  router.post('/workspaces/:id/start', async (req, res) => {
    try {
      const ctx = await requireContext(req.params.id);
      if ('code' in ctx) return err(res, 409, ctx.message, ctx.code);
      const ws = await store.getWorkspace(req.params.id);
      if (!ws) return err(res, 404, 'workspace not found', 'NOT_FOUND');

      // The session runs in the workspace's persistent design-system folder so
      // every thread reads/extends the same shared system (not the user's repo).
      const dir = await ensureWorkspaceDir(req.params.id, ws.profile, {
        workspaceName: ws.name,
        sourceRepoName: ws.kind === 'repo' ? ws.name : undefined,
        sourceRepoPath: ws.kind === 'repo' ? ws.sourceRepoPath : undefined,
        sourceRepoId: ws.kind === 'repo' ? ws.sourceRepoId : undefined,
      });
      const persona = buildDesignerPersona(ctx.context, {
        workspaceName: ws.name,
        sourceRepoName: ws.kind === 'repo' ? ws.name : undefined,
      });
      const { provider, model } = await resolveStudioModelSelection({
        provider: req.body?.provider,
        model: req.body?.model,
      }, (req as any).requestId);
      const agentOverrides = req.body?.agentOverrides && typeof req.body.agentOverrides === 'object' && !Array.isArray(req.body.agentOverrides)
        ? req.body.agentOverrides
        : undefined;
      const chat = new ChatService(db);
      const userEmail = (req as any).user?.email as string | undefined;
      const uid = userId(req);
      const chatSession = await chat.createSession(
        provider,
        model,
        'ui',
        undefined,
        agentOverrides,
        ws.kind === 'repo' ? ws.sourceRepoId : undefined,
        { userId: uid, email: userEmail },
        { systemPromptOverride: persona, studioWorkspaceId: req.params.id, repoPath: dir },
      );
      // Give it a friendly default title; keep titleSource as default so the
      // normal chat auto-title pass replaces it after the first design request.
      await db.collection('chat_sessions').updateOne(
        { _id: chatSession._id },
        { $set: { title: 'New Design Chat', titleSource: 'default' } },
      );
      res.status(201).json({ chatSessionId: String(chatSession._id) });
    } catch (e) {
      err(res, 500, (e as Error).message, 'START_FAILED');
    }
  });

  // Generate a prototype (optionally as 2–3 variants) for a brief (R8/R9/R10).
  router.post('/sessions/:id/generate', async (req, res) => {
    try {
      const session = await store.getSession(req.params.id);
      if (!session) return err(res, 404, 'session not found', 'NOT_FOUND');
      const { instruction, variants } = req.body ?? {};
      if (!instruction) return err(res, 400, 'instruction required', 'NO_INSTRUCTION');
      const ctx = await requireContext(session.workspaceId);
      if ('code' in ctx) return err(res, 409, ctx.message, ctx.code);

      await store.addMessage({ sessionId: req.params.id, role: 'user', content: instruction });
      const llm = makeLLM();

      if (variants && Number(variants) >= 2) {
        const generated = await llm.generateVariants({ context: ctx.context, instruction, count: Number(variants) });
        const created = await store.addVariantGroup({
          sessionId: req.params.id,
          workspaceId: session.workspaceId,
          label: instruction.slice(0, 60),
          prompt: instruction,
          variants: generated.map((g) => ({ screens: g.screens, inventedElements: g.invented })),
        });
        const groupId = created[0]?.groupId;
        await store.addMessage({
          sessionId: req.params.id,
          role: 'assistant',
          content: `Generated ${created.length} distinct directions. Direction A is selected — pick another to continue from it.`,
          groupId,
        });
        return res.status(201).json({ variants: created, groupId });
      }

      const g = await llm.generate({ context: ctx.context, instruction });
      const version = await store.addVersion({
        sessionId: req.params.id,
        workspaceId: session.workspaceId,
        kind: 'generation',
        label: instruction.slice(0, 60),
        prompt: instruction,
        screens: g.screens,
        inventedElements: g.invented,
      });
      const inventedNote = g.invented.length ? ` New elements not found in the design context: ${g.invented.join(', ')}.` : '';
      await store.addMessage({ sessionId: req.params.id, role: 'assistant', content: `Created a ${g.screens.length}-screen prototype.${inventedNote}`, versionId: String(version._id) });
      res.status(201).json({ version });
    } catch (e) {
      err(res, 500, (e as Error).message, 'GENERATE_FAILED');
    }
  });

  // Surgical iteration on the current version (R13/R14/R16).
  router.post('/sessions/:id/iterate', async (req, res) => {
    try {
      const session = await store.getSession(req.params.id);
      if (!session) return err(res, 404, 'session not found', 'NOT_FOUND');
      const { instruction, scopeFileName } = req.body ?? {};
      if (!instruction) return err(res, 400, 'instruction required', 'NO_INSTRUCTION');
      const current = await store.getCurrentVersion(req.params.id);
      if (!current) return err(res, 409, 'nothing to iterate on — generate first', 'NO_CURRENT');
      const ctx = await requireContext(session.workspaceId);
      if ('code' in ctx) return err(res, 409, ctx.message, ctx.code);

      await store.addMessage({ sessionId: req.params.id, role: 'user', content: instruction });
      const r = await makeLLM().iterate({
        context: ctx.context,
        instruction,
        current: current.screens,
        scope: scopeFileName ? { fileName: scopeFileName } : undefined,
      });
      const version = await store.addVersion({
        sessionId: req.params.id,
        workspaceId: session.workspaceId,
        kind: 'iteration',
        label: instruction.slice(0, 60),
        prompt: instruction,
        screens: r.screens,
        parentVersionId: String(current._id),
        inventedElements: r.invented,
      });
      await store.addMessage({
        sessionId: req.params.id,
        role: 'assistant',
        content: `Applied your change to ${r.changedFiles.length || 'the'} screen(s): ${r.changedFiles.join(', ') || 'updated'}.`,
        versionId: String(version._id),
      });
      res.status(201).json({ version, changedFiles: r.changedFiles });
    } catch (e) {
      err(res, 500, (e as Error).message, 'ITERATE_FAILED');
    }
  });

  // ── Versions: variants, restore, branch, preview, export ────────────────────

  router.post('/versions/:id/select-variant', async (req, res) => {
    const v = await store.selectVariant(req.params.id);
    if (!v) return err(res, 404, 'version not found', 'NOT_FOUND');
    res.json(v);
  });

  router.post('/versions/:id/restore', async (req, res) => {
    try {
      const v = await store.restoreVersion(req.params.id, 'restore');
      res.status(201).json(v);
    } catch (e) {
      err(res, 404, (e as Error).message, 'NOT_FOUND');
    }
  });

  router.post('/versions/:id/branch', async (req, res) => {
    try {
      const v = await store.restoreVersion(req.params.id, 'branch');
      res.status(201).json(v);
    } catch (e) {
      err(res, 404, (e as Error).message, 'NOT_FOUND');
    }
  });

  router.post('/versions/:id/preview', async (req, res) => {
    const v = await store.getVersion(req.params.id);
    if (!v) return err(res, 404, 'version not found', 'NOT_FOUND');
    const { url } = await buildPreview(req.params.id, v.screens);
    res.json({ url });
  });

  router.post('/versions/:id/export', async (req, res) => {
    try {
      const v = await store.getVersion(req.params.id);
      if (!v) return err(res, 404, 'version not found', 'NOT_FOUND');
      const session = await store.getSession(v.sessionId);
      const result = await exportVersion(v, { sessionTitle: session?.title, destinationDir: req.body?.destinationDir });
      res.json({ dir: result.dir, files: result.files, manifest: result.manifest });
    } catch (e) {
      err(res, 500, (e as Error).message, 'EXPORT_FAILED');
    }
  });

  return router;
}
