import express, { type Express } from 'express';
import cors from 'cors';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { Db } from 'mongodb';
import { resolve } from 'node:path';
import { connectDB, disconnectDB } from './database/mongo.js';
import { ensureIndexes } from './database/indexes.js';
import { workflowRoutes } from './routes/workflow.routes.js';
import { skillRoutes } from './routes/skill.routes.js';
import { executionRoutes } from './routes/execution.routes.js';
import { agentRoutes } from './routes/agent.routes.js';
import { teamRoutes } from './routes/team.routes.js';
import { streamRoutes } from './routes/stream.routes.js';
import { dashboardRoutes } from './routes/dashboard.routes.js';
import { usageRoutes, startUsageCacheWarmer } from './routes/usage.routes.js';
import { repoRoutes } from './routes/repo.routes.js';
import { learningRoutes, executionLearningsRoute } from './routes/learning.routes.js';
import { chatRoutes } from './routes/chat.routes.js';
import { chatExportImportRoutes } from './routes/chat-export-import.routes.js';
import { ChatService, backfillSessionOwners } from './services/chat.service.js';
import { mcpRoutes } from './routes/mcp.routes.js';
import { alertRoutes } from './routes/alert.routes.js';
import { workspaceRoutes, publicWorkspaceRoutes } from './routes/workspace.routes.js';
import { pullRequestRoutes } from './routes/pull-request.routes.js';
import { fileRoutes, publicFileRoutes } from './routes/file.routes.js';
import { artifactRoutes, publicArtifactRoutes } from './routes/artifact.routes.js';
import { ArtifactService } from './services/artifact.service.js';
import { slackRoutes } from './routes/slack.routes.js';
import { startTerminalWebSocketServer, type TerminalWebSocketServerHandle } from './services/workspace-terminal.js';
import { createWorkspaceProxy, createWorkspaceUpgradeHandler } from './services/workspace-proxy.js';
import { startFileWatchServer, stopFileWatchServer } from './services/workspace-watcher.js';
import { WorkspaceManager } from './services/workspace.service.js';
import { seedDefaultSkills, seedDefaultWorkflows, listDefaultWorkflowNames } from './seed.js';
import { setStreamDb } from './services/stream.service.js';
import { startMcpHealthMonitor, stopMcpHealthMonitor } from './services/mcp-health.service.js';
import { startMcpOrphanSweeper, type McpOrphanSweeperHandle } from './services/mcp-orphan-sweeper.service.js';
import { OrgSeedService } from './services/org-seed.js';
import { cleanupOrphanedSeedEntities } from './services/org-cleanup.js';
import { CronService } from './services/cron.service.js';
import { seedCronJobs } from './services/cron-seed.service.js';
import { createRepoScanIfChangedAction } from './services/context/scanner/repo-context-scanner.service.js';
import { RepoService, createRepoPullAllAction } from './services/repo.service.js';
import { createPrSyncAllAction } from './services/pull-request.service.js';
import { createMcpBundleCleanupAction } from './services/mcp-bundle.service.js';
import { createSelfHealingMonitorScanAction } from './services/self-healing-monitor.service.js';
import { runTrustBootstrap } from './services/trust-bootstrap.service.js';
import { seedContextQuality } from './services/context/judge/context-quality-seed.service.js';
import { cronRoutes } from './routes/cron.routes.js';
import { designDocRoutes } from './routes/design-doc.routes.js';
import { documentRoutes } from './routes/document.routes.js';
import { designStudioRoutes } from './routes/design-studio.routes.js';
import { createPreviewHandler, createChatPreviewHandler, DSTUDIO_PREVIEW_PREFIX, DSTUDIO_CHAT_PREVIEW_PREFIX } from './services/design-studio/preview.service.js';
import { createWorkspaceSiteHandler, DSTUDIO_SITE_PREFIX } from './services/design-studio/workspace-fs.js';
import { interventionRoutes } from './routes/intervention.routes.js';
import { watcherRoutes } from './routes/watcher.routes.js';
import { WatcherService } from './services/watcher.service.js';
import { linearRoutes } from './routes/linear.routes.js';
import { monitoringRoutes } from './routes/monitoring.routes.js';
import { internalContextEvaluationRoutes } from './routes/context-evaluation.routes.js';
import { contextRoutes } from './routes/context.routes.js';
import { contextQualityRoutes } from './routes/context-quality.routes.js';
import { authRoutes } from './routes/auth.routes.js';
import { systemRoutes } from './routes/system.routes.js';
import { userRoutes } from './routes/users.routes.js';
import { requireAuth } from './middleware/requireAuth.js';
import { blockIfMustReset } from './middleware/blockIfMustReset.js';
import { logger } from './logger.js';
import { requestLogger, errorLogger } from './middleware/request-logger.js';
import { isSeedOverrideEnabled } from './services/seed-policy.js';
import {
  configureRuntimeProviders,
  getRuntimeConfigProvider,
  type ConfigProvider,
  type SecretsProvider,
} from './runtime/config.js';

export interface StartAllenServerOptions {
  mode?: 'web' | 'desktop';
  host?: string;
  port?: number;
  terminalHost?: string;
  terminalWsPort?: number;
  db?: Db;
  mongoUri?: string;
  configProvider?: ConfigProvider;
  secretsProvider?: SecretsProvider;
  runBootTasks?: boolean;
  startBackgroundServices?: boolean;
  startTerminalServer?: boolean;
  manageDbConnection?: boolean;
  staticUiDir?: string;
}

export interface AllenServerHandle {
  app: Express;
  db: Db;
  httpServer: Server;
  baseUrl: string;
  port: number;
  terminalWsUrl: string | null;
  stop(): Promise<void>;
}

function parsePort(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function closeHttpServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

function listen(app: Express, port: number, host?: string): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = host ? app.listen(port, host) : app.listen(port);
    server.once('error', reject);
    server.once('listening', () => {
      server.off('error', reject);
      const address = server.address() as AddressInfo | string | null;
      const boundPort = typeof address === 'object' && address != null ? address.port : port;
      resolve({ server, port: boundPort });
    });
  });
}

async function registerCronActions(db: Db, cronService: CronService): Promise<void> {
  cronService.registerSystemAction(createRepoScanIfChangedAction(db));
  cronService.registerSystemAction(createRepoPullAllAction(db));
  cronService.registerSystemAction(createPrSyncAllAction(db));
  cronService.registerSystemAction(createMcpBundleCleanupAction(db));
  cronService.registerSystemAction(createSelfHealingMonitorScanAction(db));
}

async function runBootTasks(db: Db, cronService: CronService): Promise<void> {
  await ensureIndexes(db);
  await new ArtifactService(db).ensureIndexes();

  // Seed model registry on first boot (NFR-001: zero-downtime migration)
  try {
    const { ModelRegistryService, runAliasToFullIdMigration, runProviderRenameMigration } = await import('./services/model-registry.service.js');
    // Provider rename must run BEFORE the seeder: the seeder inserts docs
    // under the new provider id, and the rename migration dedupes against them.
    try {
      await runProviderRenameMigration(db);
    } catch (err) {
      logger.warn('[model-registry] Provider rename migration failed — continuing boot', { component: 'model-registry', error: (err as Error).message });
    }
    await new ModelRegistryService(db).syncSeedModels();
    try {
      await runAliasToFullIdMigration(db);
    } catch (err) {
      logger.warn('[model-registry] Migration failed — continuing boot', { component: 'model-registry', error: (err as Error).message });
    }
  } catch (err) {
    logger.error('[model-registry] Seed failed — continuing boot', { component: 'model-registry', error: (err as Error).message });
  }

  try {
    const { syncMcpToCodex } = await import('./services/chat-providers.js');
    await syncMcpToCodex(db);
    logger.info('[mcp] Initial Codex sync complete', { component: 'mcp' });
  } catch (err) {
    logger.error('[mcp] Initial Codex sync failed', { component: 'mcp', error: (err as Error).message });
  }

  try {
    await seedContextQuality(db);
  } catch (err) {
    logger.error('[context-quality-seed] Startup seed failed — continuing boot', {
      component: 'context-quality-seed',
      error: (err as Error).message,
    });
  }

  try {
    const { RepoContextSetupService } = await import('./services/context/setup/repo-context-setup.service.js');
    const setupService = await RepoContextSetupService.createForBoot(db);
    await setupService.reconcileSetupRuns();
    logger.info('[repo-context-setup] Boot reconciliation complete', { component: 'repo-context-setup' });
  } catch (err) {
    logger.error('[repo-context-setup] Boot reconciliation failed — continuing boot', {
      component: 'repo-context-setup',
      error: (err as Error).message,
    });
  }

  try {
    const chatSvc = new ChatService(db);
    await new WatcherService(db, chatSvc).runReconciliation();
    logger.info('[watcher] Boot reconciliation complete', { component: 'watcher' });
  } catch (err) {
    logger.error('[watcher] Boot reconciliation failed — continuing boot', { component: 'watcher', error: (err as Error).message });
  }

  await new OrgSeedService(db).seed();
  await seedDefaultWorkflows(db);
  await seedDefaultSkills(db);

  if (isSeedOverrideEnabled()) {
    const keepWorkflows = listDefaultWorkflowNames();
    await cleanupOrphanedSeedEntities(
      db,
      OrgSeedService.seedTeamNames,
      OrgSeedService.seedAgentNames,
      keepWorkflows,
    );
  }

  await seedCronJobs(db);
  try {
    const { scanned, updated } = await backfillSessionOwners(db);
    if (scanned > 0) {
      logger.info('[chat] Backfilled session owners', { component: 'chat', scanned, updated });
    }
  } catch (err) {
    logger.error('[chat] Session owner backfill failed', { component: 'chat', error: (err as Error).message });
  }

  await registerCronActions(db, cronService);
  await cronService.start();

  // Hourly background re-warm of the usage dashboard cache (Settings →
  // Usage). Reports stay ≤1h stale without any request paying the
  // aggregation cost; the Refresh button forces an immediate recompute.
  startUsageCacheWarmer(db);

  runTrustBootstrap().catch((err) => {
    logger.warn('[trust-bootstrap] bootstrap crashed', { component: 'trust-bootstrap', error: (err as Error).message });
  });
}

export function createAllenExpressApp(db: Db, cronService: CronService, options: {
  staticUiDir?: string;
} = {}): Express {
  const app = express();

  app.use(cors());

  const WORKSPACE_SUBDOMAIN_REGEX = /^([a-z][a-z0-9_-]*)-([a-f0-9]{10,})\./;
  const subdomainProxy = createWorkspaceProxy(db);

  app.use((req, res, next) => {
    const host = req.hostname || req.headers.host?.split(':')[0] || '';
    const match = host.match(WORKSPACE_SUBDOMAIN_REGEX);
    if (!match) return next();

    const [, serviceName, wsId] = match;
    if (req.url.startsWith('/api/') || req.url.startsWith('/ws/')) {
      logger.debug('[subdomain-proxy] routing request', { component: 'subdomain-proxy', method: req.method, host, url: req.url, service: serviceName, wsId });
    }
    (req.query as Record<string, string>).service = serviceName;
    req.params = { ...req.params, id: wsId };
    return subdomainProxy(req, res, next);
  });

  app.use('/api/slack', express.raw({ type: 'application/json', limit: '5mb' }), slackRoutes(db));
  app.use('/api/internal/context-evaluation', express.raw({ type: 'application/json', limit: '10mb' }), internalContextEvaluationRoutes(db));
  app.use(express.json({ limit: '10mb' }));
  app.use(requestLogger());

  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  app.use('/api/auth', authRoutes(db));
  app.use('/api/system', systemRoutes(db));
  app.use('/api/files', publicFileRoutes(db));
  app.use('/api/artifacts', publicArtifactRoutes(db));
  app.use('/api/executions', streamRoutes());
  app.use('/api/workspaces', publicWorkspaceRoutes(db));
  app.use('/api/workspaces/:id/preview', createWorkspaceProxy(db));

  // Design Studio previews are served unauthenticated so they open in the
  // user's real local browser. Mounted before requireAuth. The chat-session
  // route serves a session's HTML/CSS/JS artifacts as a mini static site (so
  // multi-screen prototypes with relative links work); it is mounted first so
  // "chat" isn't captured by the token route's :token param.
  app.use(`${DSTUDIO_CHAT_PREVIEW_PREFIX}/:sessionId/:file?`, createChatPreviewHandler(db));
  app.use(`${DSTUDIO_PREVIEW_PREFIX}/:token/:file?`, createPreviewHandler());
  // Serve a workspace's design-system folder as a static site (Open in browser).
  app.use(`${DSTUDIO_SITE_PREFIX}/:workspaceId/:file(*)?`, createWorkspaceSiteHandler());

  app.use('/api', requireAuth, blockIfMustReset);

  app.use('/api/users', userRoutes(db));
  app.use('/api/workflows', workflowRoutes(db));
  app.use('/api/skills', skillRoutes(db));
  app.use('/api/executions', executionRoutes(db));
  app.use('/api/context', contextRoutes(db));
  app.use('/api/context/quality', contextQualityRoutes(db));
  app.use('/api/agents', agentRoutes(db));
  app.use('/api/teams', teamRoutes(db));
  app.use('/api/dashboard', dashboardRoutes(db));
  app.use('/api/usage', usageRoutes(db));
  app.use('/api/repos', repoRoutes(db));
  app.use('/api/learnings', learningRoutes(db));
  app.use('/api/executions', executionLearningsRoute(db));
  app.use('/api/chat', chatRoutes(db));
  app.use('/api/chat', chatExportImportRoutes(db));
  app.use('/api/mcp', mcpRoutes(db));
  app.use('/api/alerts', alertRoutes(db));
  app.use('/api/workspaces', workspaceRoutes(db));
  app.use('/api/pull-requests', pullRequestRoutes(db));
  app.use('/api/crons', cronRoutes(db, cronService));
  app.use('/api/design-docs', designDocRoutes(db));
  app.use('/api/documents', documentRoutes(db));
  app.use('/api/design-studio', designStudioRoutes(db));
  app.use('/api/interventions', interventionRoutes(db));
  app.use('/api/execution-watchers', watcherRoutes(db));
  app.use('/api/linear', linearRoutes(db));
  app.use('/api/monitoring', monitoringRoutes(db));
  app.use('/api/files', fileRoutes(db));
  app.use('/api/artifacts', artifactRoutes(db));

  if (options.staticUiDir) {
    app.use(express.static(options.staticUiDir));
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api/') || req.path.startsWith('/ws/')) return next();
      res.sendFile(resolve(options.staticUiDir!, 'index.html'));
    });
  }

  app.use(errorLogger());

  app.locals.workspaceSubdomainRegex = WORKSPACE_SUBDOMAIN_REGEX;
  return app;
}

export async function startAllenServer(options: StartAllenServerOptions = {}): Promise<AllenServerHandle> {
  configureRuntimeProviders({
    configProvider: options.configProvider,
    secretsProvider: options.secretsProvider,
  });
  const config = getRuntimeConfigProvider();
  const mode = options.mode ?? 'web';
  const host = options.host ?? config.get('HOST');
  const port = options.port ?? parsePort(config.get('PORT'), 4023);
  const terminalWsPort = options.terminalWsPort ?? (
    config.get('TERMINAL_WS_PORT') ? parsePort(config.get('TERMINAL_WS_PORT'), 4024) : undefined
  );
  const shouldManageDb = options.manageDbConnection ?? !options.db;
  const db = options.db ?? await connectDB(options.mongoUri ?? config.get('MONGODB_URI'));
  const runStartupTasks = options.runBootTasks ?? true;
  const startBackgroundServices = options.startBackgroundServices ?? true;
  const startTerminalServer = options.startTerminalServer ?? true;
  const cronService = new CronService(db);

  if (runStartupTasks) {
    await runBootTasks(db, cronService);
  } else {
    await registerCronActions(db, cronService);
  }

  setStreamDb(db);

  const app = createAllenExpressApp(db, cronService, { staticUiDir: options.staticUiDir });
  const { server: httpServer, port: boundPort } = await listen(app, port, host);
  process.env.PORT = String(boundPort);
  const baseHost = host ?? 'localhost';
  const baseUrl = `http://${baseHost}:${boundPort}`;
  if (mode === 'desktop' || !process.env.ALLEN_API_URL) process.env.ALLEN_API_URL = baseUrl;
  if (mode === 'desktop' || !process.env.ALLEN_INTERNAL_API_URL) process.env.ALLEN_INTERNAL_API_URL = baseUrl;

  logger.info('Allen server started', { port: boundPort, env: process.env.NODE_ENV, pid: process.pid, mode });

  const workspaceSubdomainRegex = app.locals.workspaceSubdomainRegex as RegExp;
  const wsUpgradeHandler = createWorkspaceUpgradeHandler(db, (req) => {
    const reqHost = (req.headers.host ?? '').split(':')[0];
    const m = reqHost.match(workspaceSubdomainRegex);
    if (!m) return null;
    return { serviceName: m[1], wsId: m[2] };
  });
  httpServer.on('upgrade', (req, socket, head) => {
    void wsUpgradeHandler(req, socket, head);
  });

  let orphanSweeperHandle: McpOrphanSweeperHandle | null = null;
  let watcherServiceHandle: WatcherService | null = null;
  if (startBackgroundServices) {
    startMcpHealthMonitor(db);
    orphanSweeperHandle = startMcpOrphanSweeper();
    watcherServiceHandle = new WatcherService(db, new ChatService(db));
    watcherServiceHandle.startPoller();
  }

  startFileWatchServer();

  const wsManager = new WorkspaceManager(db);
  const stalePidCleanup = wsManager.cleanupStalePids()
    .catch(err => logger.error('[workspace] stale PID cleanup failed', { component: 'workspace', error: (err as Error).message }));

  let terminalHandle: TerminalWebSocketServerHandle | null = null;
  if (startTerminalServer) {
    const repoService = new RepoService(db);
    terminalHandle = startTerminalWebSocketServer(async (workspaceId: string) => {
      const ws = await wsManager.get(workspaceId);
      return ws?.worktreePath ?? null;
    }, async (repoId: string) => {
      const repo = await repoService.getById(repoId);
      return typeof repo?.path === 'string' ? repo.path : null;
    }, {
      host: options.terminalHost ?? '127.0.0.1',
      port: terminalWsPort,
      server: mode === 'desktop' ? httpServer : undefined,
      serverPort: mode === 'desktop' ? boundPort : undefined,
    });
    await terminalHandle.ready;
  }

  return {
    app,
    db,
    httpServer,
    baseUrl,
    port: boundPort,
    get terminalWsUrl() {
      return terminalHandle?.url ?? null;
    },
    stop: async () => {
      const errors: Error[] = [];
      const collect = async (fn: () => Promise<void> | void): Promise<void> => {
        try {
          await fn();
        } catch (err) {
          errors.push(err instanceof Error ? err : new Error(String(err)));
        }
      };

      await collect(() => terminalHandle?.stop());
      await collect(() => stopFileWatchServer());
      await collect(() => orphanSweeperHandle?.stop());
      await collect(() => stopMcpHealthMonitor());
      await collect(() => watcherServiceHandle?.stopPoller());
      await collect(() => cronService.stop());
      await collect(() => closeHttpServer(httpServer));
      await collect(() => stalePidCleanup);
      if (shouldManageDb) await collect(() => disconnectDB());

      if (errors.length > 0) {
        throw new AggregateError(errors, 'Failed to stop Allen server cleanly');
      }
    },
  };
}
