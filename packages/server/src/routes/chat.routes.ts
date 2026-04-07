import { Router, type Request, type Response } from 'express';
import { param } from '../types.js';
import { ChatService } from '../services/chat.service.js';
import { executeChatTool } from '../services/chat-tools.js';
import type { Db } from 'mongodb';

export function chatRoutes(db: Db): Router {
  const router = Router();
  const chatService = new ChatService(db);

  // POST /api/chat/spawn-agent — Execute spawn_agent tool via API (used by FlowForge MCP server)
  router.post('/spawn-agent', async (req: Request, res: Response) => {
    try {
      const { agent_name, prompt, repo_path } = req.body;
      if (!agent_name || !prompt) return res.status(400).json({ error: 'agent_name and prompt are required' });
      const result = await executeChatTool('spawn_agent', { agent_name, prompt, repo_path }, db);
      res.json(result);
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // POST /api/chat/delegate — Execute delegate_to_agent tool via API (used by FlowForge MCP server)
  router.post('/delegate', async (req: Request, res: Response) => {
    try {
      const { agent_name, task, context } = req.body;
      if (!agent_name || !task) return res.status(400).json({ error: 'agent_name and task are required' });
      const result = await executeChatTool('delegate_to_agent', { agent_name, task, context }, db);
      res.json(result);
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // GET /api/chat/sessions — List all sessions
  router.get('/sessions', async (_req: Request, res: Response) => {
    try {
      const sessions = await chatService.listSessions();
      res.json(sessions);
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // GET /api/chat/providers — List available LLM providers
  router.get('/providers', (_req: Request, res: Response) => {
    res.json(chatService.getProviders());
  });

  // POST /api/chat/sessions — Create new session
  router.post('/sessions', async (req: Request, res: Response) => {
    try {
      const { provider, model } = req.body ?? {};
      const session = await chatService.createSession(provider, model);
      res.status(201).json(session);
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // GET /api/chat/sessions/:id — Get session with messages
  router.get('/sessions/:id', async (req: Request, res: Response) => {
    try {
      const id = param(req, 'id');
      const session = await chatService.getSession(id);
      if (!session) return res.status(404).json({ error: 'Session not found' });
      res.json(session);
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // GET /api/chat/sessions/:id/messages — Paginated messages
  router.get('/sessions/:id/messages', async (req: Request, res: Response) => {
    try {
      const sessionId = param(req, 'id');
      const before = req.query.before as string | undefined;
      const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 50;
      const result = await chatService.getMessages(sessionId, before, limit);
      res.json(result);
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // POST /api/chat/sessions/:id/messages — Send message (SSE response)
  // Body: { content: string, agent?: string }
  // When `agent` is provided, the message is routed through that team agent's system prompt.
  router.post('/sessions/:id/messages', async (req: Request, res: Response) => {
    try {
      const sessionId = param(req, 'id');
      const { content, agent } = req.body;
      if (!content || typeof content !== 'string') {
        return res.status(400).json({ error: 'content is required' });
      }
      // sendMessage handles SSE headers and streaming
      await chatService.sendMessage(sessionId, content, res, agent);
    } catch (err: unknown) {
      if (!res.headersSent) {
        res.status(500).json({ error: (err as Error).message });
      }
    }
  });

  // GET /api/chat/sessions/:id/stream — Subscribe to active stream (reconnection)
  router.get('/sessions/:id/stream', (req: Request, res: Response) => {
    const sessionId = param(req, 'id');
    chatService.subscribeToStream(sessionId, res);
  });

  // GET /api/chat/sessions/:id/streaming — Check if session is streaming
  router.get('/sessions/:id/streaming', (req: Request, res: Response) => {
    const sessionId = param(req, 'id');
    res.json({ streaming: chatService.isStreaming(sessionId) });
  });

  // PATCH /api/chat/sessions/:id — Update session (title, status)
  router.patch('/sessions/:id', async (req: Request, res: Response) => {
    try {
      const id = param(req, 'id');
      const { title, status } = req.body;
      const session = await chatService.updateSession(id, { title, status });
      if (!session) return res.status(404).json({ error: 'Session not found' });
      res.json(session);
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // POST /api/chat/embeddings/backfill — Generate embeddings for learnings that don't have them
  router.post('/embeddings/backfill', async (_req: Request, res: Response) => {
    try {
      const { backfillEmbeddings } = await import('../services/embedding.service.js');
      const count = await backfillEmbeddings(db);
      res.json({ indexed: count });
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // GET /api/chat/sessions/:id/logs — Get execution traces for a session
  router.get('/sessions/:id/logs', async (req: Request, res: Response) => {
    try {
      const sessionId = param(req, 'id');
      const limit = Math.min(parseInt(req.query.limit as string ?? '50', 10), 200);
      const logs = await db.collection('chat_logs')
        .find({ sessionId })
        .sort({ timestamp: -1 })
        .limit(limit)
        .toArray();
      logs.reverse();
      res.json(logs);
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // GET /api/chat/logs — Get all chat logs (cross-session)
  router.get('/logs', async (req: Request, res: Response) => {
    try {
      const limit = Math.min(parseInt(req.query.limit as string ?? '50', 10), 200);
      const status = req.query.status as string | undefined;
      const filter: Record<string, unknown> = {};
      if (status) filter.status = status;

      const logs = await db.collection('chat_logs')
        .find(filter)
        .sort({ timestamp: -1 })
        .limit(limit)
        .toArray();
      res.json(logs);
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // GET /api/chat/logs/:logId — Get single log with full trace
  router.get('/logs/:logId', async (req: Request, res: Response) => {
    try {
      const { ObjectId } = await import('mongodb');
      const log = await db.collection('chat_logs').findOne({ _id: new ObjectId(param(req, 'logId')) });
      if (!log) return res.status(404).json({ error: 'Log not found' });
      res.json(log);
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // GET /api/chat/sessions/:id/threads — Get agent-to-agent conversations for a session
  router.get('/sessions/:id/threads', async (req: Request, res: Response) => {
    try {
      const sessionId = param(req, 'id');
      const { AgentConversationService } = await import('../services/agent-conversation.service.js');
      const service = new AgentConversationService(db);
      const threads = await service.forSession(sessionId);
      res.json(threads);
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // DELETE /api/chat/sessions/:id — Delete session
  router.delete('/sessions/:id', async (req: Request, res: Response) => {
    try {
      const id = param(req, 'id');
      await chatService.deleteSession(id);
      res.status(204).send();
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  return router;
}
