import { createHmac } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { internalContextEvaluationRoutes } from '../../src/routes/context-evaluation.routes.js';
import { runChatLLM } from '../../src/services/chat-llm.js';

vi.mock('../../src/services/chat-llm.js', () => ({
  PROVIDERS: [
    { provider: 'codex' },
    { provider: 'claude-cli' },
  ],
  runChatLLM: vi.fn(async () => ({
    text: '{"status":"passed","scores":{"overall":1},"summary":"ok"}',
    costUsd: 0,
    durationMs: 10,
    model: 'gpt-test',
    provider: 'codex',
    trace: [],
  })),
}));

describe('internalContextEvaluationRoutes', () => {
  const originalContextProvider = process.env.ALLEN_CONTEXT_PROVIDER;
  const originalCogneeLlmProvider = process.env.ALLEN_COGNEE_LLM_PROVIDER;
  const originalCogneeLlmModel = process.env.ALLEN_COGNEE_LLM_MODEL;

  beforeEach(() => {
    process.env.ALLEN_CONTEXT_PROVIDER = 'graph';
    vi.clearAllMocks();
  });

  afterEach(() => {
    if (originalContextProvider === undefined) delete process.env.ALLEN_CONTEXT_PROVIDER;
    else process.env.ALLEN_CONTEXT_PROVIDER = originalContextProvider;
    if (originalCogneeLlmProvider === undefined) delete process.env.ALLEN_COGNEE_LLM_PROVIDER;
    else process.env.ALLEN_COGNEE_LLM_PROVIDER = originalCogneeLlmProvider;
    if (originalCogneeLlmModel === undefined) delete process.env.ALLEN_COGNEE_LLM_MODEL;
    else process.env.ALLEN_COGNEE_LLM_MODEL = originalCogneeLlmModel;
  });

  it('verifies HMAC against the exact raw JSON body', async () => {
    process.env.JWT_ACCESS_SECRET = 'test-context-eval-secret';
    const app = express();
    app.use('/api/internal/context-evaluation', express.raw({ type: 'application/json' }), internalContextEvaluationRoutes({} as any));
    const rawBody = Buffer.from('{"prompt":"Hello \\u2603", "model":"gpt-test"}');
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = sign(timestamp, rawBody, process.env.JWT_ACCESS_SECRET);

    const res = await request(app)
      .post('/api/internal/context-evaluation/judge')
      .set('content-type', 'application/json')
      .set('x-allen-context-eval-timestamp', timestamp)
      .set('x-allen-context-eval-signature', signature)
      .send(rawBody.toString('utf8'));

    expect(res.status).toBe(200);
    expect(res.body.text).toContain('"status":"passed"');
    expect(runChatLLM).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      model: 'gpt-test',
      messages: [{ role: 'user', content: 'Hello ☃' }],
      skipTools: true,
    }));
  });

  it('rejects invalid signatures', async () => {
    process.env.JWT_ACCESS_SECRET = 'test-context-eval-secret';
    const app = express();
    app.use('/api/internal/context-evaluation', express.raw({ type: 'application/json' }), internalContextEvaluationRoutes({} as any));

    const res = await request(app)
      .post('/api/internal/context-evaluation/judge')
      .set('content-type', 'application/json')
      .set('x-allen-context-eval-timestamp', String(Math.floor(Date.now() / 1000)))
      .set('x-allen-context-eval-signature', 'bad-signature')
      .send('{"prompt":"Hello","model":"gpt-test"}');

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid context evaluation judge signature');
  });

  it('serves Cognee OpenAI-compatible chat completions through Allen Codex', async () => {
    process.env.ALLEN_CONTEXT_PROVIDER = 'cognee';
    process.env.JWT_ACCESS_SECRET = 'test-context-eval-secret';
    const app = express();
    app.use('/api/internal/context-evaluation', express.raw({ type: 'application/json' }), internalContextEvaluationRoutes({} as any));

    const res = await request(app)
      .post('/api/internal/context-evaluation/cognee-llm/v1/chat/completions')
      .set('content-type', 'application/json')
      .set('authorization', 'Bearer test-context-eval-secret')
      .send(JSON.stringify({
        model: 'gpt-test',
        messages: [{ role: 'user', content: 'Recall repo context' }],
      }));

    expect(res.status).toBe(200);
    expect(res.body.choices?.[0]?.message?.content).toContain('"status":"passed"');
    expect(runChatLLM).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      model: 'gpt-test',
      provider: 'codex',
      messages: [{ role: 'user', content: 'user: Recall repo context' }],
      skipTools: true,
    }));
  });

  it('uses configured Cognee LLM provider and model when the request omits them', async () => {
    process.env.ALLEN_CONTEXT_PROVIDER = 'cognee';
    process.env.JWT_ACCESS_SECRET = 'test-context-eval-secret';
    process.env.ALLEN_COGNEE_LLM_PROVIDER = 'claude-cli';
    process.env.ALLEN_COGNEE_LLM_MODEL = 'claude-test';
    const app = express();
    app.use('/api/internal/context-evaluation', express.raw({ type: 'application/json' }), internalContextEvaluationRoutes({} as any));

    const res = await request(app)
      .post('/api/internal/context-evaluation/cognee-llm/v1/chat/completions')
      .set('content-type', 'application/json')
      .set('authorization', 'Bearer test-context-eval-secret')
      .send(JSON.stringify({
        messages: [{ role: 'user', content: 'Recall repo context' }],
      }));

    expect(res.status).toBe(200);
    expect(runChatLLM).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      provider: 'claude-cli',
      model: 'claude-test',
      messages: [{ role: 'user', content: 'user: Recall repo context' }],
      skipTools: true,
    }));
  });
});

function sign(timestamp: string, rawBody: Buffer, secret: string): string {
  return createHmac('sha256', secret)
    .update(timestamp)
    .update('.')
    .update(rawBody)
    .digest('hex');
}
