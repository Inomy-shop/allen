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
import { roleRoutes } from './routes/role.routes.js';
import { streamRoutes } from './routes/stream.routes.js';
import { secretRoutes } from './routes/secret.routes.js';
import { dashboardRoutes } from './routes/dashboard.routes.js';
import { repoRoutes } from './routes/repo.routes.js';
import { learningRoutes, executionLearningsRoute } from './routes/learning.routes.js';
import { chatRoutes } from './routes/chat.routes.js';
import { mcpRoutes } from './routes/mcp.routes.js';
import { alertRoutes } from './routes/alert.routes.js';
import { seedDefaultRoles, seedDefaultWorkflows } from './seed.js';
import { setStreamDb } from './services/stream.service.js';

const PORT = parseInt(process.env.PORT ?? '4000', 10);

async function main(): Promise<void> {
  const db = await connectDB();
  await ensureIndexes(db);
  await seedDefaultRoles(db);
  await seedDefaultWorkflows(db);
  setStreamDb(db);

  const app = express();

  app.use(cors());
  app.use(express.json({ limit: '10mb' }));

  // Health check
  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // Routes
  app.use('/api/workflows', workflowRoutes(db));
  app.use('/api/executions', executionRoutes(db));
  app.use('/api/executions', streamRoutes());
  app.use('/api/roles', roleRoutes(db));
  app.use('/api/secrets', secretRoutes(db));
  app.use('/api/dashboard', dashboardRoutes(db));
  app.use('/api/repos', repoRoutes(db));
  app.use('/api/learnings', learningRoutes(db));
  app.use('/api/executions', executionLearningsRoute(db));
  app.use('/api/chat', chatRoutes(db));
  app.use('/api/mcp', mcpRoutes(db));
  app.use('/api/alerts', alertRoutes(db));

  app.listen(PORT, () => {
    console.log(`FlowForge server running on http://localhost:${PORT}`);
    console.log(`API endpoints:`);
    console.log(`  GET  /api/health`);
    console.log(`  CRUD /api/workflows`);
    console.log(`  CRUD /api/executions`);
    console.log(`  CRUD /api/roles`);
    console.log(`  CRUD /api/secrets`);
    console.log(`  GET  /api/dashboard/stats`);
    console.log(`  GET  /api/dashboard/cost`);
  });
}

main().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
// reload trigger 1775250852
