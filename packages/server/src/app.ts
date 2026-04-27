import dotenv from 'dotenv';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__dirname, '..', '..', '..', '.env') });

import express from 'express';
import cors from 'cors';
import { connectDB } from './database/mongo.js';
import { ensureIndexes } from './database/indexes.js';
import { workflowRoutes } from './routes/workflow.routes.js';
import { executionRoutes } from './routes/execution.routes.js';
import { agentRoutes } from './routes/agent.routes.js';
import { teamRoutes } from './routes/team.routes.js';
import { streamRoutes } from './routes/stream.routes.js';
import { secretRoutes } from './routes/secret.routes.js';
import { dashboardRoutes } from './routes/dashboard.routes.js';
import { repoRoutes } from './routes/repo.routes.js';
import { learningRoutes, executionLearningsRoute } from './routes/learning.routes.js';
import { chatRoutes } from './routes/chat.routes.js';
import { mcpRoutes } from './routes/mcp.routes.js';
import { alertRoutes } from './routes/alert.routes.js';
import { workspaceRoutes, publicWorkspaceRoutes } from './routes/workspace.routes.js';
import { pullRequestRoutes } from './routes/pull-request.routes.js';
import { fileRoutes, publicFileRoutes } from './routes/file.routes.js';
import { artifactRoutes, publicArtifactRoutes } from './routes/artifact.routes.js';
import { ArtifactService } from './services/artifact.service.js';
import { slackRoutes } from './routes/slack.routes.js';
import { startTerminalWebSocketServer } from './services/workspace-terminal.js';
import { createWorkspaceProxy, createWorkspaceUpgradeHandler } from './services/workspace-proxy.js';
import { startFileWatchServer } from './services/workspace-watcher.js';
import { WorkspaceManager } from './services/workspace.service.js';
import { seedDefaultWorkflows } from './seed.js';
import { setStreamDb } from './services/stream.service.js';
import { SecretService } from './services/secret.service.js';
import { McpService } from './services/mcp.service.js';
import { startMcpHealthMonitor } from './services/mcp-health.service.js';
import { OrgSeedService } from './services/org-seed.js';
import { cleanupOrphanedSeedEntities } from './services/org-cleanup.js';
import { CronService } from './services/cron.service.js';
import { seedCronJobs } from './services/cron-seed.service.js';
import { createRepoScanIfChangedAction } from './services/repo-context-scanner.service.js';
import { createRepoPullAllAction } from './services/repo.service.js';
import { createPrSyncAllAction } from './services/pull-request.service.js';
import { createMcpBundleCleanupAction } from './services/mcp-bundle.service.js';
import { runTrustBootstrap } from './services/trust-bootstrap.service.js';
import { cronRoutes } from './routes/cron.routes.js';
import { designDocRoutes } from './routes/design-doc.routes.js';
import { interventionRoutes } from './routes/intervention.routes.js';
import { linearRoutes } from './routes/linear.routes.js';
import { authRoutes } from './routes/auth.routes.js';
import { userRoutes } from './routes/users.routes.js';
import { bootstrapAdmin } from './services/adminBootstrap.js';
import { requireAuth } from './middleware/requireAuth.js';
import { blockIfMustReset } from './middleware/blockIfMustReset.js';

const PORT = parseInt(process.env.PORT ?? '4000', 10);

// ── Global error handlers ─────────────────────────────────────────────
//
// Native modules (node-pty, sharp, better-sqlite3, etc.) can throw
// errors that propagate up through async boundaries and bypass normal
// try/catch blocks in Express handlers. Without these top-level
// handlers, a single pty spawn failure or an awaited Promise rejection
// takes down the entire Allen server process — killing every chat
// session, every running workflow, and every MCP health check.
//
// Log loudly and KEEP GOING. Individual request handlers are still
// responsible for their own try/catch (we're not using this as a
// substitute for proper error handling), but this is the safety net
// that prevents a single bug from nuking the whole dev server.
process.on('uncaughtException', (err: Error, origin: string) => {
  console.error(`\n━━━ UNCAUGHT EXCEPTION [${origin}] ━━━`);
  console.error(err.stack ?? err.message ?? err);
  console.error(`━━━ Server is continuing — fix the root cause, this is a safety net, not a pattern ━━━\n`);
});

process.on('unhandledRejection', (reason: unknown, promise: Promise<unknown>) => {
  console.error(`\n━━━ UNHANDLED PROMISE REJECTION ━━━`);
  const r = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
  console.error(r);
  console.error(`Promise:`, promise);
  console.error(`━━━ Server is continuing — fix the root cause ━━━\n`);
});

async function main(): Promise<void> {
  const db = await connectDB();
  await ensureIndexes(db);
  await new ArtifactService(db).ensureIndexes();
  await bootstrapAdmin(db);
  // Secrets + @secret:KEY migrations removed. MCP env now comes straight
  // from Allen's root .env via the ALLEN_ prefix convention — see
  // packages/engine/src/mcp-loader.ts.

  // Sync MCP servers into Codex CLI's global config ONCE on boot.
  // Per-chat sync is disabled to avoid races between parallel sessions
  // rewriting the global Codex config concurrently.
  try {
    const { syncMcpToCodex } = await import('./services/chat-providers.js');
    await syncMcpToCodex(db);
    console.log('[mcp] Initial Codex sync complete');
  } catch (err) {
    console.error('[mcp] Initial Codex sync failed:', (err as Error).message);
  }
  // Build the full 10-team org chart. Runs BEFORE legacy seeds to avoid
  // duplicate key conflicts on the teamName_lead_unique index.
  await new OrgSeedService(db).seed();
  // Legacy seeds disabled — the new OrgSeedService replaces both.
  // await seedDefaultAgents(db);
  // await new TeamSeedService(db).migrate();
  await seedDefaultWorkflows(db);

  // Remove orphaned seed teams/agents/workflows from prior schemas.
  // Meta team is always protected by cleanupOrphanedSeedEntities.
  // Keep this list in sync with the .yml files in packages/engine/workflows/.
  await cleanupOrphanedSeedEntities(
    db,
    OrgSeedService.seedTeamNames,
    OrgSeedService.seedAgentNames,
    [
      'coding-workflow',
      'feature-plan-and-implement',
      'bug-investigate-and-fix',
      'resolve-pr-reviews',
      'understand-and-plan',
      'test-human-intervention',
      'test-chat-loop',
      'test-create-workspace',
      'test-artifacts',
    ],
  );
  await seedCronJobs(db);
  setStreamDb(db);

  // Boot the cron scheduler + register system actions
  const cronService = new CronService(db);
  cronService.registerSystemAction(createRepoScanIfChangedAction(db));
  cronService.registerSystemAction(createRepoPullAllAction(db));
  cronService.registerSystemAction(createPrSyncAllAction(db));
  cronService.registerSystemAction(createMcpBundleCleanupAction(db));
  const { createCodeRabbitSweepAction } = await import('./services/coderabbit-sweep.service.js');
  cronService.registerSystemAction(createCodeRabbitSweepAction(db));
  await cronService.start();

  // Pre-answer the "trust this directory?" prompts from Codex and
  // Claude CLI in <ALLEN_HOME>. Fire-and-forget — the server boots
  // even if `expect` or the CLIs aren't installed. Without this, the
  // first workflow spawn in a fresh install hangs on the interactive
  // trust dialog until manually answered.
  runTrustBootstrap().catch((err) => {
    console.warn('[trust-bootstrap] bootstrap crashed:', (err as Error).message);
  });

  const app = express();

  app.use(cors());

  // Workspace subdomain proxy — MUST be before express.json() and API routes.
  // express.json() consumes the request body stream; if it runs first, the
  // proxy forwards an empty body and POST/PUT/PATCH requests hang or fail.
  const WORKSPACE_SUBDOMAIN_REGEX = /^([a-z][a-z0-9_-]*)-([a-f0-9]{10,})\./;
  const subdomainProxy = createWorkspaceProxy(db);

  app.use((req, res, next) => {
    const host = req.hostname || req.headers.host?.split(':')[0] || '';
    const match = host.match(WORKSPACE_SUBDOMAIN_REGEX);
    if (!match) return next();

    const [, serviceName, wsId] = match;
    if (req.url.startsWith('/api/') || req.url.startsWith('/ws/')) {
      console.log(`[subdomain-proxy] ${req.method} ${host}${req.url} → service=${serviceName} wsId=${wsId}`);
    }
    (req.query as Record<string, string>).service = serviceName;
    req.params = { ...req.params, id: wsId };
    return subdomainProxy(req, res, next);
  });

  // Slack webhook needs the raw body for HMAC signature verification.
  // Mount BEFORE express.json() so the body isn't pre-parsed.
  app.use('/api/slack', express.raw({ type: 'application/json', limit: '5mb' }), slackRoutes(db));

  app.use(express.json({ limit: '10mb' }));

  // Health check (public)
  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // Auth routes (public — login, refresh; logout/reset/me are auth-gated inside the router)
  app.use('/api/auth', authRoutes(db));

  // Public file downloads — intentionally mounted BEFORE the auth middleware
  // so links generated by agents (upload_file tool) are clickable from chat,
  // Slack, and email without forcing a login. Uploaded filenames are random
  // UUIDs so the link itself acts as the capability (signed-URL pattern).
  // Write operations stay behind auth via `fileRoutes()` mounted further down.
  app.use('/api/files', publicFileRoutes());

  // Public artifact content — same no-auth pattern as /api/files.
  // Artifact UUIDs are unguessable, so the URL itself is the capability.
  // Write operations stay behind auth via `artifactRoutes()` below.
  app.use('/api/artifacts', publicArtifactRoutes(db));

  // Execution SSE stream — mounted BEFORE requireAuth so the browser's
  // EventSource (which cannot send an Authorization header) can subscribe.
  // The execution id is an unguessable UUID, same capability-URL model as
  // /api/files. Authenticated mutation of execution state still goes through
  // `executionRoutes` below, which sits behind requireAuth.
  app.use('/api/executions', streamRoutes());

  // Workspace service log SSE — same EventSource constraint as executions.
  // Workspace id is a 24-char ObjectId acting as the capability URL.
  app.use('/api/workspaces', publicWorkspaceRoutes(db));

  // Workspace preview reverse proxy — same constraint: the iframe and
  // "open in new tab" link cannot send an Authorization header. Subdomain
  // routing already bypasses requireAuth via the host-based proxy mounted
  // earlier; this path-based proxy is the localhost-dev fallback.
  app.use('/api/workspaces/:id/preview', createWorkspaceProxy(db));

  // Every API route below this line requires a valid access token, and if
  // the user has `mustResetPassword: true` they can only hit /api/auth/*.
  app.use('/api', requireAuth, blockIfMustReset);

  // Admin-only user management
  app.use('/api/users', userRoutes(db));

  // Routes
  app.use('/api/workflows', workflowRoutes(db));
  app.use('/api/executions', executionRoutes(db));
  app.use('/api/agents', agentRoutes(db));
  app.use('/api/teams', teamRoutes(db));
  app.use('/api/secrets', secretRoutes(db));
  app.use('/api/dashboard', dashboardRoutes(db));
  app.use('/api/repos', repoRoutes(db));
  app.use('/api/learnings', learningRoutes(db));
  app.use('/api/executions', executionLearningsRoute(db));
  app.use('/api/chat', chatRoutes(db));
  app.use('/api/mcp', mcpRoutes(db));
  app.use('/api/alerts', alertRoutes(db));
  app.use('/api/workspaces', workspaceRoutes(db));
  app.use('/api/pull-requests', pullRequestRoutes(db));
  app.use('/api/crons', cronRoutes(db, cronService));
  app.use('/api/design-docs', designDocRoutes(db));
  app.use('/api/interventions', interventionRoutes(db));
  app.use('/api/linear', linearRoutes(db));
  app.use('/api/files', fileRoutes());
  app.use('/api/artifacts', artifactRoutes(db));

  const httpServer = app.listen(PORT, () => {
    console.log(`Allen server running on http://localhost:${PORT}`);
  });

  // Forward WebSocket upgrades for workspace subdomains so Vite HMR (and
  // any other WS the workspace's services use, e.g. Next /_next/webpack-hmr)
  // works. Without this, http-proxy-middleware's `ws: true` is dead code —
  // the upgrade event has to be wired to the underlying http.Server
  // explicitly. Subdomain-only: path-based previews don't need WS because
  // local dev points the iframe straight at the service port.
  const wsUpgradeHandler = createWorkspaceUpgradeHandler(db, (req) => {
    const host = (req.headers.host ?? '').split(':')[0];
    const m = host.match(WORKSPACE_SUBDOMAIN_REGEX);
    if (!m) return null;
    return { serviceName: m[1], wsId: m[2] };
  });
  httpServer.on('upgrade', (req, socket, head) => {
    void wsUpgradeHandler(req, socket, head);
  });

  // Start the MCP server health monitor (5-min background loop, alerts on outages)
  startMcpHealthMonitor(db);

  // Start file watch WebSocket server on port 4025
  startFileWatchServer();

  // Clean up stale service PIDs from a previous server run
  const wsManager = new WorkspaceManager(db);
  wsManager.cleanupStalePids().catch(err => console.error('[workspace] stale PID cleanup failed:', err));

  // Start dedicated WebSocket terminal server on port 4024
  startTerminalWebSocketServer(async (workspaceId: string) => {
    const ws = await wsManager.get(workspaceId);
    return ws?.worktreePath ?? null;
  });
}

main().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
// reload trigger 1775250852
