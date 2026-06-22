/**
 * Tests for system routes — Model Registry endpoints (ENG-1825).
 *
 * Auth pattern: POST/PATCH/DELETE /api/system/models use requireAuth + requireAdmin.
 * GET /api/system/models is public (no auth).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { systemRoutes } from './system.routes.js';
import { ModelRegistryService } from '../services/model-registry.service.js';

// ── Module-level mocks ──────────────────────────────────────────────────────

// We mock requireAuth and requireAdmin so we can control auth outcomes.
// Tests that need admin access set these mock implementations appropriately.

type AuthMock = (req: any, res: any, next: any) => void;
let requireAuthImpl: AuthMock = (_req, _res, next) => next();
let requireAdminImpl: AuthMock = (req, res, next) => {
  if (!req.user) return res.status(401).json({ error: 'unauthorized' });
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'admin_only' });
  return next();
};

vi.mock('../middleware/requireAuth.js', () => ({
  requireAuth: vi.fn((req: any, res: any, next: any) => requireAuthImpl(req, res, next)),
}));
vi.mock('../middleware/requireAdmin.js', () => ({
  requireAdmin: vi.fn((req: any, res: any, next: any) => requireAdminImpl(req, res, next)),
}));

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeMockDb() {
  const store: Record<string, any[]> = { model_registry: [] };
  const collectionCache = new Map<string, any>();

  function buildCollection(name: string) {
    return {
      find: (query: Record<string, any> = {}) => {
        let results = [...(store[name] ?? [])];
        for (const [key, value] of Object.entries(query)) {
          if (key === 'isActive' && value === true) {
            results = results.filter((d) => d.isActive === true);
          } else if (key === 'provider') {
            results = results.filter((d) => d.provider === value);
          }
        }
        // Sort by provider + sortOrder (simplified)
        results.sort((a, b) => String(a.provider).localeCompare(String(b.provider)));
        return {
          sort: () => ({ toArray: async () => [...results] }),
          toArray: async () => [...results],
        };
      },
      findOne: async (query: Record<string, any>) => {
        return store[name].find((d) => {
          return Object.entries(query).every(([k, v]) => {
            if (k === '_id') return String(d._id) === String(v);
            return d[k] === v;
          });
        }) ?? null;
      },
      insertOne: async (doc: any) => {
        store[name].push({ ...doc });
        return { insertedId: doc._id };
      },
      updateMany: async (query: any, update: any) => {
        let modifiedCount = 0;
        const $unset = update.$unset ?? {};
        for (const doc of store[name]) {
          const hit = Object.entries(query).every(([key, value]: [string, any]) =>
            value && typeof value === 'object' && '$exists' in value
              ? (key in doc) === value.$exists
              : doc[key] === value,
          );
          if (!hit) continue;
          for (const key of Object.keys($unset)) {
            if (key in doc) { delete doc[key]; modifiedCount++; }
          }
        }
        return { modifiedCount };
      },
      updateOne: async (q: any, u: any) => {
        const idx = store[name].findIndex((d) => {
          return Object.entries(q).every(([k, v]) => {
            if (k === '_id') return String(d._id) === String(v);
            return d[k] === v;
          });
        });
        if (idx >= 0 && u.$set) {
          store[name][idx] = { ...store[name][idx], ...u.$set };
        }
        return { matchedCount: idx >= 0 ? 1 : 0 };
      },
      findOneAndUpdate: async (q: any, u: any, _opts?: any) => {
        const idx = store[name].findIndex((d) => {
          return Object.entries(q).every(([k, v]) => {
            if (k === '_id') return String(d._id) === String(v);
            return d[k] === v;
          });
        });
        if (idx >= 0 && u.$set) {
          store[name][idx] = { ...store[name][idx], ...u.$set };
          return store[name][idx];
        }
        return null;
      },
      insertMany: async (docs: any[]) => {
        store[name].push(...docs);
      },
      deleteOne: async () => ({ deletedCount: 0 }),
      countDocuments: async () => store[name].length,
    };
  }

  return {
    store,
    collection: (name: string) => {
      const existing = collectionCache.get(name);
      if (existing) return existing;
      const coll = buildCollection(name);
      collectionCache.set(name, coll);
      return coll;
    },
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('system routes — model registry auth (AC-004)', () => {
  let mockDb: ReturnType<typeof makeMockDb>;
  let app: express.Express;

  beforeEach(() => {
    vi.clearAllMocks();
    mockDb = makeMockDb();
    app = express();
    app.use(express.json());
    app.use('/api/system', systemRoutes(mockDb as any));
    // Reset auth mocks to default (pass-through for requireAuth, check role for requireAdmin)
    requireAuthImpl = (_req, _res, next) => next();
    requireAdminImpl = (req, res, next) => {
      if (!req.user) return res.status(401).json({ error: 'unauthorized' });
      if (req.user.role !== 'admin') return res.status(403).json({ error: 'admin_only' });
      return next();
    };
  });

  it('POST /api/system/models returns 403 for non-admin user', async () => {
    // Simulate an authenticated non-admin user
    app = express();
    app.use(express.json());
    // Mount a middleware that sets req.user (simulating requireAuth having run)
    // then override requireAdmin behavior via the mock
    requireAuthImpl = (req, _res, next) => {
      req.user = { sub: 'user-1', role: 'user', email: 'user@test.com' };
      next();
    };
    requireAdminImpl = (req, res, next) => {
      if (!req.user) return res.status(401).json({ error: 'unauthorized' });
      if (req.user.role !== 'admin') return res.status(403).json({ error: 'admin_only' });
      return next();
    };
    app.use('/api/system', systemRoutes(mockDb as any));

    const res = await request(app)
      .post('/api/system/models')
      .send({ provider: 'codex', fullId: 'test', displayName: 'Test', providerDisplayName: 'Codex' });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('admin_only');
  });

  it('PATCH /api/system/models/:id returns 403 for non-admin user', async () => {
    requireAuthImpl = (req, _res, next) => {
      req.user = { sub: 'user-1', role: 'user', email: 'user@test.com' };
      next();
    };
    requireAdminImpl = (req, res, next) => {
      if (!req.user) return res.status(401).json({ error: 'unauthorized' });
      if (req.user.role !== 'admin') return res.status(403).json({ error: 'admin_only' });
      return next();
    };
    app = express();
    app.use(express.json());
    app.use('/api/system', systemRoutes(mockDb as any));

    const res = await request(app)
      .patch('/api/system/models/507f191e810c19729de860ea')
      .send({ displayName: 'Test' });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('admin_only');
  });

  it('DELETE /api/system/models/:id returns 403 for non-admin user', async () => {
    requireAuthImpl = (req, _res, next) => {
      req.user = { sub: 'user-1', role: 'user', email: 'user@test.com' };
      next();
    };
    requireAdminImpl = (req, res, next) => {
      if (!req.user) return res.status(401).json({ error: 'unauthorized' });
      if (req.user.role !== 'admin') return res.status(403).json({ error: 'admin_only' });
      return next();
    };
    app = express();
    app.use(express.json());
    app.use('/api/system', systemRoutes(mockDb as any));

    const res = await request(app)
      .delete('/api/system/models/507f191e810c19729de860ea');
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('admin_only');
  });

  it('POST /api/system/models returns 201 for admin user', async () => {
    requireAuthImpl = (req, _res, next) => {
      req.user = { sub: 'admin-1', role: 'admin', email: 'admin@test.com' };
      next();
    };
    requireAdminImpl = (req, res, next) => {
      if (!req.user) return res.status(401).json({ error: 'unauthorized' });
      if (req.user.role !== 'admin') return res.status(403).json({ error: 'admin_only' });
      return next();
    };
    app = express();
    app.use(express.json());
    app.use('/api/system', systemRoutes(mockDb as any));

    const res = await request(app)
      .post('/api/system/models')
      .send({ provider: 'codex', fullId: 'test-full', displayName: 'Test Model', providerDisplayName: 'Codex' });
    expect(res.status).toBe(201);
    expect(res.body.fullId).toBe('test-full');
    expect(res.body.displayName).toBe('Test Model');
  });

  it('GET /api/system/models is public (no auth required)', async () => {
    // Seed some models manually via the service
    const ModelRegistryService = (await import('../services/model-registry.service.js')).ModelRegistryService;
    const service = new ModelRegistryService(mockDb as any);
    await service.syncSeedModels();

    // No auth middleware set up — should still work
    const res = await request(app).get('/api/system/models');
    expect(res.status).toBe(200);
    expect(res.body.models).toBeDefined();
    expect(Array.isArray(res.body.models)).toBe(true);
    expect(res.body.models.length).toBeGreaterThan(0);
  });

  it('GET /api/system/models/recovery backfills provider display names from seeded provider data', async () => {
    mockDb.store.model_registry.push(
      {
        provider: 'claude',
        fullId: 'claude-sonnet-4-5-20250929',
        displayName: 'Claude sonnet 4.5',
        isActive: true,
        sortOrder: 0,
      },
      {
        provider: 'claude',
        fullId: 'claude-opus-4-8',
        displayName: 'Opus 4.8',
        providerDisplayName: 'Claude',
        isActive: true,
        sortOrder: 4,
        tier: 'opus',
      },
    );

    const res = await request(app).get('/api/system/models/recovery');

    expect(res.status).toBe(200);
    expect(res.body.providers).toEqual([
      {
        provider: 'claude',
        providerDisplayName: 'Claude',
        models: [
          { fullId: 'claude-sonnet-4-5-20250929', displayName: 'Claude sonnet 4.5' },
          { fullId: 'claude-opus-4-8', displayName: 'Opus 4.8', tier: 'opus' },
        ],
      },
    ]);
  });

  it('GET /api/system/models?includeInactive=true returns deactivated models', async () => {
    const ModelRegistryService = (await import('../services/model-registry.service.js')).ModelRegistryService;
    const service = new ModelRegistryService(mockDb as any);
    const model = await service.create({
      provider: 'codex',
      fullId: 'test-full',
      displayName: 'Test Model',
      providerDisplayName: 'Codex',
    });
    await service.softDelete(String(model._id));

    // Without includeInactive — should not return deactivated
    const resActive = await request(app).get('/api/system/models');
    expect(resActive.body.models.length).toBe(0);

    // With includeInactive=true — should return all
    const resAll = await request(app).get('/api/system/models?includeInactive=true');
    expect(resAll.body.models.length).toBe(1);
    expect(resAll.body.models[0].isActive).toBe(false);
  });

  it('POST /api/system/models validates input and returns 400 for invalid provider', async () => {
    requireAuthImpl = (req, _res, next) => {
      req.user = { sub: 'admin-1', role: 'admin', email: 'admin@test.com' };
      next();
    };
    requireAdminImpl = (req, res, next) => {
      if (!req.user) return res.status(401).json({ error: 'unauthorized' });
      if (req.user.role !== 'admin') return res.status(403).json({ error: 'admin_only' });
      return next();
    };
    app = express();
    app.use(express.json());
    app.use('/api/system', systemRoutes(mockDb as any));

    const res = await request(app)
      .post('/api/system/models')
      .send({ provider: 'unknown', fullId: 'test', displayName: 'Test', providerDisplayName: 'Unknown' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('UNKNOWN_PROVIDER');
  });
});
