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
import { seedDefaultRoles, seedDefaultWorkflows } from './seed.js';

const PORT = parseInt(process.env.PORT ?? '4000', 10);

async function main(): Promise<void> {
  const db = await connectDB();
  await ensureIndexes(db);
  await seedDefaultRoles(db);
  await seedDefaultWorkflows(db);

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
