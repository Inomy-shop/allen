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
import { streamRoutes } from './routes/stream.routes.js';
import { secretRoutes } from './routes/secret.routes.js';
import { dashboardRoutes } from './routes/dashboard.routes.js';
import { repoRoutes } from './routes/repo.routes.js';
import { learningRoutes, executionLearningsRoute } from './routes/learning.routes.js';
import { chatRoutes } from './routes/chat.routes.js';
import { mcpRoutes } from './routes/mcp.routes.js';
import { alertRoutes } from './routes/alert.routes.js';
import { workspaceRoutes } from './routes/workspace.routes.js';
import { pullRequestRoutes } from './routes/pull-request.routes.js';
import { slackRoutes } from './routes/slack.routes.js';
import { startTerminalWebSocketServer } from './services/workspace-terminal.js';
import { createWorkspaceProxy } from './services/workspace-proxy.js';
import { startFileWatchServer } from './services/workspace-watcher.js';
import { WorkspaceManager } from './services/workspace.service.js';
import { seedDefaultAgents, seedDefaultWorkflows } from './seed.js';
import { setStreamDb } from './services/stream.service.js';
import { SecretService } from './services/secret.service.js';
import { McpService } from './services/mcp.service.js';
import { startMcpHealthMonitor } from './services/mcp-health.service.js';

const PORT = parseInt(process.env.PORT ?? '4000', 10);

async function main(): Promise<void> {
  const db = await connectDB();
  await ensureIndexes(db);
  await new SecretService(db).migrateLegacyPlaintext();
  const mcpSvc = new McpService(db);
  await mcpSvc.migrateLegacyEnvLiterals();
  await mcpSvc.migrateGhCliServersToSecret();
  await mcpSvc.syncPresetDescriptions();
  await seedDefaultAgents(db);
  await seedDefaultWorkflows(db);
  setStreamDb(db);

  const app = express();

  app.use(cors());

  // Slack webhook needs the raw body for HMAC signature verification.
  // Mount BEFORE express.json() so the body isn't pre-parsed.
  app.use('/api/slack', express.raw({ type: 'application/json', limit: '5mb' }), slackRoutes(db));

  app.use(express.json({ limit: '10mb' }));

  // Health check
  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // Routes
  app.use('/api/workflows', workflowRoutes(db));
  app.use('/api/executions', executionRoutes(db));
  app.use('/api/executions', streamRoutes());
  app.use('/api/agents', agentRoutes(db));
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

  // Preview reverse proxy — must be after json middleware but catches /api/workspaces/:id/preview/*
  app.use('/api/workspaces/:id/preview', createWorkspaceProxy(db));

  app.listen(PORT, () => {
    console.log(`FlowForge server running on http://localhost:${PORT}`);
  });

  // Start the MCP server health monitor (5-min background loop, alerts on outages)
  startMcpHealthMonitor(db);

  // Start file watch WebSocket server on port 4025
  startFileWatchServer();

  // Start dedicated WebSocket terminal server on port 4024
  const wsManager = new WorkspaceManager(db);
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
