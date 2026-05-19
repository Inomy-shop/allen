import { createHmac, timingSafeEqual } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import type { Db } from 'mongodb';
import { PROVIDERS, runChatLLM, type ChatProvider } from '../services/chat-llm.js';
import { isCogneeContextEnabled, isContextEngineEnabled } from '../services/context-provider-config.js';

const MAX_CLOCK_SKEW_MS = 5 * 60_000;

export function internalContextEvaluationRoutes(db: Db): Router {
  const router = Router();

  router.post('/judge', async (req: Request, res: Response) => {
    try {
      if (!isContextEngineEnabled()) return res.status(409).json(contextProviderDisabledPayload());
      const { body, rawBody } = parseSignedJsonBody(req.body);
      const prompt = typeof body.prompt === 'string' ? body.prompt : '';
      if (!prompt.trim()) return res.status(400).json({ error: 'prompt is required' });
      const verification = verifyJudgeSignature(req, rawBody);
      if (!verification.ok) return res.status(verification.status).json({ error: verification.error });

      let text = '';
      const result = await runChatLLM(db, {
        provider: 'codex',
        model: typeof body.model === 'string'
          ? body.model
          : process.env.ALLEN_CONTEXT_SEMANTIC_JUDGE_MODEL ?? 'gpt-5.5',
        systemPrompt: '',
        messages: [{ role: 'user', content: prompt }],
        skipTools: true,
        cwd: process.env.ALLEN_CONTEXT_SEMANTIC_JUDGE_CWD ?? '/tmp/allen/context-evaluator',
        onText: (chunk) => { text = chunk; },
        onToolStart: () => undefined,
        onToolResult: () => undefined,
      });
      res.json({
        text: result.text || text,
        model: result.model,
        provider: result.provider,
        durationMs: result.durationMs,
        costUsd: result.costUsd,
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post('/cognee-llm', async (req: Request, res: Response) => {
    try {
      if (!isCogneeContextEnabled()) return res.status(409).json(contextProviderDisabledPayload('Cognee context provider is disabled.'));
      const { body, rawBody } = parseSignedJsonBody(req.body);
      const prompt = typeof body.prompt === 'string' ? body.prompt : '';
      if (!prompt.trim()) return res.status(400).json({ error: 'prompt is required' });
      const verification = verifyJudgeSignature(req, rawBody, process.env.ALLEN_COGNEE_LLM_SECRET);
      if (!verification.ok) return res.status(verification.status).json({ error: verification.error });

      let text = '';
      const provider = resolveCogneeLlmProvider(body.provider);
      const model = typeof body.model === 'string'
        ? body.model
        : process.env.ALLEN_COGNEE_LLM_MODEL ?? 'gpt-5.5';
      const result = await runChatLLM(db, {
        provider,
        model,
        systemPrompt: typeof body.systemPrompt === 'string' ? body.systemPrompt : '',
        messages: [{ role: 'user', content: prompt }],
        skipTools: true,
        cwd: process.env.ALLEN_COGNEE_LLM_CWD ?? '/tmp/allen/cognee-llm',
        onText: (chunk) => { text = chunk; },
        onToolStart: () => undefined,
        onToolResult: () => undefined,
      });
      res.json({
        text: result.text || text,
        model: result.model,
        provider: result.provider,
        durationMs: result.durationMs,
        costUsd: result.costUsd,
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post('/cognee-llm/v1/chat/completions', async (req: Request, res: Response) => {
    try {
      if (!isCogneeContextEnabled()) return res.status(409).json(contextProviderDisabledPayload('Cognee context provider is disabled.'));
      const { body, rawBody } = parseSignedJsonBody(req.body);
      const verification = verifyCogneeOpenAiCompatibleAuth(req, rawBody);
      if (!verification.ok) return res.status(verification.status).json({ error: verification.error });
      const messages = Array.isArray(body.messages)
        ? body.messages
          .map((message) => typeof message?.content === 'string' ? { role: String(message.role ?? 'user'), content: message.content } : null)
          .filter(Boolean) as Array<{ role: string; content: string }>
        : [];
      const prompt = messages.length > 0
        ? messages.map((message) => `${message.role}: ${message.content}`).join('\n\n')
        : typeof body.prompt === 'string' ? body.prompt : '';
      if (!prompt.trim()) return res.status(400).json({ error: 'messages or prompt is required' });
      let text = '';
      const provider = resolveCogneeLlmProvider(body.provider);
      const model = typeof body.model === 'string' ? body.model : process.env.ALLEN_COGNEE_LLM_MODEL ?? 'gpt-5.5';
      const result = await runChatLLM(db, {
        provider,
        model,
        systemPrompt: '',
        messages: [{ role: 'user', content: prompt }],
        skipTools: true,
        cwd: process.env.ALLEN_COGNEE_LLM_CWD ?? '/tmp/allen/cognee-llm',
        onText: (chunk) => { text = chunk; },
        onToolStart: () => undefined,
        onToolResult: () => undefined,
      });
      const content = result.text || text;
      res.json({
        id: `allen-cognee-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: result.model,
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
        usage: {},
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  return router;
}

function resolveCogneeLlmProvider(override?: unknown): ChatProvider {
  const raw = typeof override === 'string' && override.trim()
    ? override.trim()
    : process.env.ALLEN_COGNEE_LLM_PROVIDER ?? 'codex';
  const normalized = raw === 'allen_codex' ? 'codex' : raw;
  return (PROVIDERS.some((provider) => provider.provider === normalized) ? normalized : 'codex') as ChatProvider;
}

function contextProviderDisabledPayload(error = 'Context provider is disabled. Set ALLEN_CONTEXT_PROVIDER to enable context engine flows.'): Record<string, unknown> {
  return { error, code: 'CONTEXT_PROVIDER_DISABLED' };
}

function parseSignedJsonBody(value: unknown): { body: Record<string, unknown>; rawBody: Buffer } {
  const rawBody = Buffer.isBuffer(value)
    ? value
    : typeof value === 'string'
      ? Buffer.from(value)
      : Buffer.from(JSON.stringify(value ?? {}));
  const parsed = JSON.parse(rawBody.toString('utf8')) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('context evaluation judge body must be a JSON object');
  }
  return { body: parsed as Record<string, unknown>, rawBody };
}

function verifyJudgeSignature(req: Request, rawBody: Buffer, overrideSecret?: string): { ok: true } | { ok: false; status: number; error: string } {
  const secret = overrideSecret ?? process.env.ALLEN_CONTEXT_EVAL_JUDGE_SECRET ?? process.env.JWT_ACCESS_SECRET;
  if (!secret) return { ok: false, status: 503, error: 'context evaluation judge secret is not configured' };
  const timestamp = String(req.header('x-allen-context-eval-timestamp') ?? '');
  const signature = String(req.header('x-allen-context-eval-signature') ?? '');
  if (!timestamp || !signature) return { ok: false, status: 401, error: 'missing context evaluation judge signature' };
  const timestampMs = Number(timestamp) * 1000;
  if (!Number.isFinite(timestampMs) || Math.abs(Date.now() - timestampMs) > MAX_CLOCK_SKEW_MS) {
    return { ok: false, status: 401, error: 'stale context evaluation judge signature' };
  }
  const expected = createHmac('sha256', secret)
    .update(timestamp)
    .update('.')
    .update(rawBody)
    .digest('hex');
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(signature);
  if (expectedBuffer.length !== actualBuffer.length || !timingSafeEqual(expectedBuffer, actualBuffer)) {
    return { ok: false, status: 401, error: 'invalid context evaluation judge signature' };
  }
  return { ok: true };
}

function verifyCogneeOpenAiCompatibleAuth(req: Request, rawBody: Buffer): { ok: true } | { ok: false; status: number; error: string } {
  const secret = process.env.ALLEN_COGNEE_LLM_SECRET ?? process.env.ALLEN_CONTEXT_EVAL_JUDGE_SECRET ?? process.env.JWT_ACCESS_SECRET;
  const auth = String(req.header('authorization') ?? '');
  if (secret && auth === `Bearer ${secret}`) return { ok: true };
  return verifyJudgeSignature(req, rawBody, secret);
}
