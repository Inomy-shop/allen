import express, { type Express } from 'express';
import { MongoClient, type Db } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { authRoutes } from '../routes/auth.routes.js';
import { userRoutes } from '../routes/users.routes.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { blockIfMustReset } from '../middleware/blockIfMustReset.js';
import { bootstrapAdmin } from '../services/adminBootstrap.js';

export interface TestContext {
  app: Express;
  db: Db;
  client: MongoClient;
  mongo: MongoMemoryServer;
  stop: () => Promise<void>;
}

/**
 * Spin up an in-memory MongoDB + minimal Express app wired with only the
 * auth surface (auth routes, users routes, auth middleware). This is what
 * the e2e tests hit via supertest — no heavy services, no network, no disk.
 *
 * Also exposes GET /api/protected — a tiny route behind requireAuth +
 * blockIfMustReset used to verify the global gate behavior.
 */
export async function makeTestApp(options?: {
  adminEmail?: string;
  adminPassword?: string;
  bootstrap?: boolean;
}): Promise<TestContext> {
  process.env.JWT_ACCESS_SECRET = 'test-access-secret-do-not-use-in-prod';
  process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-do-not-use-in-prod';
  process.env.ADMIN_EMAIL = options?.adminEmail ?? 'admin@test.local';
  process.env.ADMIN_PASSWORD = options?.adminPassword ?? 'BootAdmin!234';
  // Keep tokens short in tests so we can optionally exercise refresh flows
  // without actually sleeping.
  process.env.ACCESS_TOKEN_TTL = '1d';
  process.env.REFRESH_TOKEN_TTL = '7d';

  const mongo = await MongoMemoryServer.create();
  const client = new MongoClient(mongo.getUri());
  await client.connect();
  const db = client.db('flowforge-test');

  // Minimal indexes for auth-only tests (matches production shape).
  await db.collection('users').createIndex({ email: 1 }, { unique: true });
  await db.collection('refresh_tokens').createIndex({ tokenHash: 1 }, { unique: true });
  await db.collection('refresh_tokens').createIndex({ jti: 1 }, { unique: true });

  if (options?.bootstrap !== false) {
    await bootstrapAdmin(db);
  }

  const app = express();
  app.use(express.json());

  app.use('/api/auth', authRoutes(db));

  app.use('/api', requireAuth, blockIfMustReset);

  // Probe route — blanket-gated, just returns who you are.
  app.get('/api/protected', (req, res) => {
    res.json({ ok: true, user: (req as express.Request & { user?: unknown }).user });
  });

  app.use('/api/users', userRoutes(db));

  async function stop() {
    await client.close();
    await mongo.stop();
  }

  return { app, db, client, mongo, stop };
}
