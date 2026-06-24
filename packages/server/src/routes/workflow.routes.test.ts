import { vi } from 'vitest';

vi.mock('@allen/engine', () => ({
  validateWorkflow: vi.fn(() => ({ valid: true, errors: [], warnings: [] })),
  loadAgents: vi.fn(() => ({})),
  getBuiltIns: vi.fn(() => ({})),
  generateMermaid: vi.fn(() => 'graph TD\n  A-->B'),
}));

import express from 'express';
import request from 'supertest';
import { MongoClient, ObjectId, type Db } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { workflowRoutes } from './workflow.routes.js';

describe('workflowRoutes OpenRouter warnings', () => {
  let mongo: MongoMemoryServer;
  let client: MongoClient;
  let db: Db;
  let app: express.Express;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    client = new MongoClient(mongo.getUri());
    await client.connect();
    db = client.db('workflow-routes-test');
    app = express();
    app.use(express.json());
    app.use('/api/workflows', workflowRoutes(db));
  });

  beforeEach(async () => {
    await db.collection('workflows').deleteMany({});
  });

  afterAll(async () => {
    await client.close();
    await mongo.stop();
  });

  it('returns warnings for non-Claude OpenRouter workflow node overrides on create', async () => {
    const res = await request(app)
      .post('/api/workflows')
      .send({
        parsed: {
          name: 'openrouter-warning-flow',
          description: 'Test workflow',
          nodes: {
            plan: {
              type: 'agent',
              agent: 'planner',
              agentOverrides: {
                provider: 'openrouter',
                model: 'google/gemini-2.5-pro',
              },
            },
            build: {
              type: 'agent',
              agent: 'builder',
              agentOverrides: {
                provider: 'openrouter',
                model: 'anthropic/claude-sonnet-4-6',
              },
            },
          },
        },
      });

    expect(res.status).toBe(201);
    expect(res.body.warnings).toEqual([
      expect.objectContaining({
        node: 'plan',
        code: 'openrouter_non_claude_experimental',
        model: 'google/gemini-2.5-pro',
      }),
    ]);
    expect(res.body.warnings[0].message).toContain('Claude Code');
  });

  it('returns warnings for non-Claude OpenRouter workflow node overrides on update', async () => {
    const id = new ObjectId();
    await db.collection('workflows').insertOne({
      _id: id,
      name: 'openrouter-update-flow',
      description: 'Test workflow',
      version: 1,
      yaml: '',
      parsed: { name: 'openrouter-update-flow', nodes: {} },
      validation: { valid: true, errors: [], warnings: [] },
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const res = await request(app)
      .put(`/api/workflows/${id.toHexString()}`)
      .send({
        parsed: {
          name: 'openrouter-update-flow',
          description: 'Updated workflow',
          nodes: {
            review: {
              type: 'agent',
              agent: 'reviewer',
              agentOverrides: {
                provider: 'openrouter',
                model: 'deepseek/deepseek-chat-v4',
              },
            },
          },
        },
      });

    expect(res.status).toBe(200);
    expect(res.body.warnings).toEqual([
      expect.objectContaining({
        node: 'review',
        code: 'openrouter_non_claude_experimental',
        model: 'deepseek/deepseek-chat-v4',
      }),
    ]);
  });
});
