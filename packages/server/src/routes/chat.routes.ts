import { Router, type Request, type Response } from 'express';
import { param } from '../types.js';
import { ChatService, cancelChatSession } from '../services/chat.service.js';
import { executeChatTool } from '../services/chat-tools.js';
import type { Db } from 'mongodb';

export function chatRoutes(db: Db): Router {
  const router = Router();
  const chatService = new ChatService(db);

  // POST /api/chat/sessions/:id/cancel — kill the running LLM subprocess
  // AND clear the stale session so the next message starts fresh. Acts as
  // an interrupt: after this call, the user can immediately send a new
  // message without hitting "session busy" or "no rollout found" errors.
  router.post('/sessions/:id/cancel', async (req: Request, res: Response) => {
    const sessionId = param(req, 'id');
    const cancelled = await cancelChatSession(sessionId, db);
    res.json({ cancelled, sessionId });
  });

  // Helper — pull the Allen MCP's x-allen-* context headers off an
  // incoming tool-dispatch request. The MCP subprocess sets these from
  // its own env (ALLEN_CHAT_SESSION_ID, etc.) so the server can route
  // tool calls to the exact chat / spawn context that spawned this MCP,
  // instead of probing a global "any active" map. Missing headers are
  // fine; tools fall back to their historic lookup behaviour.
  const readToolContext = (req: Request) => {
    const hdr = (name: string) => {
      const v = req.header(name);
      return typeof v === 'string' && v.length > 0 ? v : undefined;
    };
    return {
      chatSessionId: hdr('x-allen-chat-session-id'),
      parentExecutionId: hdr('x-allen-parent-execution-id'),
      rootExecutionId: hdr('x-allen-root-execution-id'),
    };
  };

  // POST /api/chat/spawn-agent — Execute spawn_agent tool via API (used by Allen MCP server)
  router.post('/spawn-agent', async (req: Request, res: Response) => {
    try {
      const {
        agent_name, prompt, repo_path, session_id,
        // Spawn-tree linkage forwarded from the Allen MCP server's env.
        // The MCP server reads ALLEN_PARENT_EXECUTION_ID / _CALLER /
        // _ROOT_EXECUTION_ID from its subprocess env and puts them here so
        // chat-tools can build the caller-qualified workflowName and set
        // parentExecutionId / rootExecutionId on the spawned row.
        parent_execution_id, parent_caller, root_execution_id,
      } = req.body;
      if (!agent_name || !prompt) return res.status(400).json({ error: 'agent_name and prompt are required' });
      const result = await executeChatTool('spawn_agent', {
        agent_name, prompt, repo_path, session_id,
        parent_execution_id, parent_caller, root_execution_id,
      }, db, readToolContext(req));
      res.json(result);
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // POST /api/chat/tools/:toolName — Generic chat-tool dispatcher.
  // The Allen MCP server forwards unknown tool calls here, so any tool
  // registered in chatTools[] (including the phase-4 meta tools like
  // create_team, create_agent, etc.) is auto-callable from spawned agents
  // without needing a hardcoded case in allen-mcp-server.ts.
  // Permission gating happens INSIDE each tool's execute() function — meta
  // tools check the active session's currentAgent against an allow-list.
  router.post('/tools/:toolName', async (req: Request, res: Response) => {
    try {
      const toolName = param(req, 'toolName');
      const args = (req.body ?? {}) as Record<string, unknown>;
      const result = await executeChatTool(toolName, args, db, readToolContext(req));
      res.json(result);
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // POST /api/chat/delegate — Execute delegation tools via API (used by Allen MCP server)
  router.post('/delegate', async (req: Request, res: Response) => {
    try {
      const { tool, agent_name, task, context, conversation_id, answer } = req.body;
      const ctx = readToolContext(req);

      // Route to the right tool
      if (tool === 'answer_delegator' || tool === 'answer_question') {
        if (!conversation_id || !answer) return res.status(400).json({ error: 'conversation_id and answer are required' });
        const result = await executeChatTool('answer_delegator', { conversation_id, answer }, db, ctx);
        return res.json(result);
      }

      // Default: delegate_to_agent
      if (!agent_name || !task) return res.status(400).json({ error: 'agent_name and task are required' });
      const result = await executeChatTool('delegate_to_agent', { agent_name, task, context, conversation_id }, db, ctx);
      res.json(result);
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // GET /api/chat/delegations/:conversationId/activity — Persisted thread-event log
  // for a delegation, used by useChat.ts on refresh so running delegations
  // don't lose their visible progress when the client reloads. Returns
  // oldest-first so the UI can append in natural order. `since` filters to
  // events after that ISO timestamp; `limit` caps at 2000 (default 500).
  router.get('/delegations/:conversationId/activity', async (req: Request, res: Response) => {
    try {
      const conversationId = param(req, 'conversationId');
      const sinceRaw = req.query.since as string | undefined;
      const limitRaw = req.query.limit as string | undefined;
      const since = sinceRaw ? new Date(sinceRaw) : undefined;
      const limit = limitRaw ? Math.max(1, Math.min(parseInt(limitRaw, 10) || 500, 2000)) : 500;
      const { AgentActivityService } = await import('../services/agent-activity.service.js');
      const service = new AgentActivityService(db);
      const events = await service.listForRef(conversationId, { since, limit });
      console.log('[chat/activity] conv', conversationId, 'since', sinceRaw ?? '-', '→', events.length, 'rows');
      res.json({ events });
    } catch (err: unknown) {
      console.error('[chat/activity] failed:', (err as Error).message);
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // GET /api/chat/delegation/:id/status — Quick status check (non-blocking)
  router.get('/delegation/:id/status', async (req: Request, res: Response) => {
    try {
      const { AgentConversationService } = await import('../services/agent-conversation.service.js');
      const service = new AgentConversationService(db);
      const conv = await service.get(param(req, 'id'));
      if (!conv) return res.status(404).json({ error: 'Not found' });
      if (conv.status === 'active') {
        return res.json({ conversation_id: conv._id?.toString(), status: 'active', agent: conv.toAgent, turn_count: conv.turnCount });
      }
      if (conv.status === 'waiting_for_answer' && conv.pendingQuestion?.status === 'pending') {
        return res.json({
          conversation_id: conv._id?.toString(),
          status: 'waiting_for_answer',
          agent: conv.toAgent,
          question: conv.pendingQuestion.question,
          from_agent: conv.pendingQuestion.fromAgent,
        });
      }
      res.json({
        conversation_id: conv._id?.toString(),
        status: conv.status,
        agent: conv.toAgent,
        response: conv.response ?? conv.summary ?? '',
        summary: conv.summary,
        cost_usd: conv.costUsd,
        duration_ms: conv.durationMs,
        turn_count: conv.turnCount,
        hint: conv.status === 'completed' ? `To continue, call delegate_to_agent with conversation_id` : undefined,
      });
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
      const { provider, model, agentOverrides } = req.body ?? {};
      const session = await chatService.createSession(provider, model, 'ui', undefined, agentOverrides);
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
    console.log('[chat/stream] subscribe session', sessionId);
    chatService.subscribeToStream(sessionId, res);
  });

  // GET /api/chat/sessions/:id/streaming — Check if session is streaming
  router.get('/sessions/:id/streaming', (req: Request, res: Response) => {
    const sessionId = param(req, 'id');
    const streaming = chatService.isStreaming(sessionId);
    console.log('[chat/isStreaming]', sessionId, '→', streaming);
    res.json({ streaming });
  });

  // PATCH /api/chat/sessions/:id — Update session
  // Accepts: title, status, provider, model, agentOverrides
  router.patch('/sessions/:id', async (req: Request, res: Response) => {
    try {
      const id = param(req, 'id');
      const { title, status, provider, model, agentOverrides } = req.body ?? {};
      const session = await chatService.updateSession(id, { title, status, provider, model, agentOverrides });
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

  // POST /api/chat/ask-caller — Agent asks its caller a question (blocks until answered)
  router.post('/ask-caller', async (req: Request, res: Response) => {
    try {
      const { question, conversation_id } = req.body;
      if (!question) return res.status(400).json({ error: 'question is required' });
      // conversation_id can come from the request or from the active session context
      const result = await executeChatTool('ask_delegator', { question, _conversation_id: conversation_id }, db, readToolContext(req));
      res.json(result);
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // POST /api/chat/ask-user — Store a question for the user (non-blocking)
  router.post('/ask-user', async (req: Request, res: Response) => {
    try {
      const { question } = req.body;
      if (!question) return res.status(400).json({ error: 'question is required' });
      // Just store the question — don't block. The in-process ask_user tool handles blocking.
      // For MCP calls, the MCP handler polls /api/chat/ask-user/status
      const { getAnyActiveSession } = await import('../services/chat-tools.js');
      const activeCtx = getAnyActiveSession();
      if (!activeCtx) return res.status(400).json({ error: 'No active session' });
      const fromAgent = activeCtx.currentAgent ?? 'assistant';
      const sessionId = activeCtx.chatSessionId;
      const { ObjectId } = await import('mongodb');
      await db.collection('chat_sessions').updateOne(
        { _id: new ObjectId(sessionId) },
        { $set: { pendingUserQuestion: { question, fromAgent, status: 'pending', askedAt: new Date() } } },
      );
      activeCtx.broadcastEvent('user_question', { question, fromAgent });
      res.json({ stored: true, message: 'Question sent to user.' });
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // GET /api/chat/ask-user/status — Poll for user's answer
  router.get('/ask-user/status', async (_req: Request, res: Response) => {
    try {
      const { getAnyActiveSession } = await import('../services/chat-tools.js');
      const activeCtx = getAnyActiveSession();
      if (!activeCtx) return res.json({ status: 'no_session' });
      const sessionId = activeCtx.chatSessionId;
      const { ObjectId } = await import('mongodb');
      const session = await db.collection('chat_sessions').findOne({ _id: new ObjectId(sessionId) });
      const pq = session?.pendingUserQuestion;
      if (!pq) return res.json({ status: 'no_question' });
      if (pq.status === 'answered' && pq.answer) {
        // Clear the question
        await db.collection('chat_sessions').updateOne(
          { _id: new ObjectId(sessionId) },
          { $set: { pendingUserQuestion: null } },
        );
        return res.json({ status: 'answered', answer: pq.answer });
      }
      res.json({ status: 'pending' });
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // POST /api/chat/sessions/:id/agent-answer — User answers a question from an agent (ask_user)
  router.post('/sessions/:id/agent-answer', async (req: Request, res: Response) => {
    try {
      const sessionId = param(req, 'id');
      const { answer } = req.body;
      if (!answer) return res.status(400).json({ error: 'answer is required' });

      const { ObjectId } = await import('mongodb');
      const session = await db.collection('chat_sessions').findOne({ _id: new ObjectId(sessionId) });
      if (!session) return res.status(404).json({ error: 'Session not found' });
      if (!session.pendingUserQuestion || session.pendingUserQuestion.status !== 'pending') {
        return res.status(400).json({ error: 'No pending question' });
      }

      await db.collection('chat_sessions').updateOne(
        { _id: new ObjectId(sessionId) },
        {
          $set: {
            'pendingUserQuestion.status': 'answered',
            'pendingUserQuestion.answer': answer,
            'pendingUserQuestion.answeredAt': new Date(),
          },
        },
      );

      // Fan out to every other tab subscribed to this session's stream so
      // their ask_user popup clears immediately. The ask_user tool's poll
      // loop will still fire its own `user_answer` when it detects the
      // DB change, but its interval grows to 30s — too slow for a good
      // multi-tab experience.
      chatService.broadcastToSession(sessionId, 'user_answer', { answer });

      res.json({ answered: true });
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

  // POST /api/chat/query-database — Generic read-only MongoDB query.
  // Used by the allen_query_database MCP tool so any collection can be queried
  // without maintaining a hard-coded allowlist. Accepts collection, filter,
  // projection, sort, and limit. Results are capped at 100 documents.
  router.post('/query-database', async (req: Request, res: Response) => {
    try {
      const { collection, filter, projection, sort, limit } = req.body as {
        collection?: string;
        filter?: Record<string, unknown>;
        projection?: Record<string, unknown>;
        sort?: Record<string, unknown>;
        limit?: number;
      };
      if (!collection || typeof collection !== 'string') {
        return res.status(400).json({ error: 'collection is required' });
      }
      const cap = Math.min(Number(limit) || 20, 100);
      const cursor = db
        .collection(collection)
        .find(filter ?? {}, { projection: projection ?? {} })
        .sort((sort ?? {}) as Record<string, 1 | -1>)
        .limit(cap);
      const docs = await cursor.toArray();
      res.json(docs);
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  return router;
}
