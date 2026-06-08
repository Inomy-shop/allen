/**
 * Design Routes — Sessions, Messages, and Run
 *
 * All endpoints under /api/design/sessions/* for the Allen Desktop Design Tab.
 * Handles CRUD for design sessions, message management, and the run endpoint
 * that dispatches to workflows or agents per the routing decision.
 */

import { Router, type Request, type Response } from 'express';
import type { Db } from 'mongodb';
import { DesignSessionService } from '../services/design-session.service.js';
import { DesignRoutingService } from '../services/design-routing.service.js';
import { DesignRepoService } from '../services/design-repo.service.js';
import { param } from '../types.js';

// ── Helpers ────────────────────────────────────────────────────────────────

function apiError(res: Response, status: number, message: string, code: string, details?: object): void {
  res.status(status).json({ error: message, code, ...(details ? { details } : {}) });
}

// ── Router ─────────────────────────────────────────────────────────────────

export function designRoutes(db: Db): Router {
  const router = Router();
  const sessionService = new DesignSessionService(db);
  const routingService = new DesignRoutingService(db);
  const repoService = new DesignRepoService(db);

  // ── GET /api/design/sessions ─────────────────────────────────────────────
  // List sessions with optional filters
  router.get('/sessions', async (req: Request, res: Response) => {
    try {
      const { status, designRepoId, limit } = req.query as Record<string, string>;
      const currentUserId = (req as any).user?.sub as string | undefined;
      const sessions = await sessionService.list({
        status: status ?? undefined,
        designRepoId: designRepoId ?? undefined,
        limit: limit ? Number.parseInt(limit, 10) : undefined,
        ownerUserId: currentUserId,
      });
      res.json(sessions);
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message, code: 'INTERNAL_ERROR' });
    }
  });

  // ── POST /api/design/sessions ────────────────────────────────────────────
  // Create a new design session
  router.post('/sessions', async (req: Request, res: Response) => {
    try {
      const { title, designRepoId, sourceRepoId, outputMode } = req.body ?? {};
      const currentUserId = (req as any).user?.sub as string | undefined;
      const currentUserEmail = (req as any).user?.email as string | undefined;

      if (!designRepoId) {
        return apiError(res, 400, 'designRepoId is required', 'DESIGN_REPO_REQUIRED');
      }

      const session = await sessionService.create({
        title: title ?? 'New Design Session',
        designRepoId,
        sourceRepoId,
        outputMode,
        ownerUserId: currentUserId,
        ownerName: undefined,
        ownerEmail: currentUserEmail,
      });

      res.status(201).json(session);
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message, code: 'INTERNAL_ERROR' });
    }
  });

  // ── GET /api/design/sessions/:id ─────────────────────────────────────────
  // Get a session by id
  router.get('/sessions/:id', async (req: Request, res: Response) => {
    try {
      const session = await sessionService.findById(param(req, 'id'));
      if (!session) {
        return apiError(res, 404, 'Design session not found', 'DESIGN_SESSION_NOT_FOUND');
      }
      res.json(session);
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message, code: 'INTERNAL_ERROR' });
    }
  });

  // ── PATCH /api/design/sessions/:id ───────────────────────────────────────
  // Patch allowed fields on a session
  router.patch('/sessions/:id', async (req: Request, res: Response) => {
    try {
      const id = param(req, 'id');
      const { title, sourceRepoId, status, outputMode } = req.body ?? {};

      // Ownership check
      const existing = await sessionService.findById(id);
      if (!existing) {
        return apiError(res, 404, 'Design session not found', 'DESIGN_SESSION_NOT_FOUND');
      }
      const currentUserId = (req as any).user?.sub as string | undefined;
      if (existing.ownerUserId && currentUserId && existing.ownerUserId !== currentUserId) {
        return apiError(res, 403, 'Forbidden', 'DESIGN_SESSION_FORBIDDEN');
      }

      const allowedFields = ['title', 'sourceRepoId', 'status', 'outputMode'];
      const receivedFields = Object.keys(req.body ?? {});
      const invalidFields = receivedFields.filter((f) => !allowedFields.includes(f));
      if (invalidFields.length > 0) {
        return apiError(res, 400, `Invalid patch fields: ${invalidFields.join(', ')}`, 'DESIGN_SESSION_PATCH_INVALID', { invalidFields });
      }

      const patch: Record<string, unknown> = {};
      if (title !== undefined) patch.title = title;
      if (sourceRepoId !== undefined) patch.sourceRepoId = sourceRepoId;
      if (status !== undefined) patch.status = status;
      if (outputMode !== undefined) patch.outputMode = outputMode;

      const updated = await sessionService.update(id, patch as any);
      if (!updated) {
        return apiError(res, 404, 'Design session not found', 'DESIGN_SESSION_NOT_FOUND');
      }
      res.json(updated);
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message, code: 'INTERNAL_ERROR' });
    }
  });

  // ── DELETE /api/design/sessions/:id ──────────────────────────────────────
  // Delete a session (and its messages)
  router.delete('/sessions/:id', async (req: Request, res: Response) => {
    try {
      const id = param(req, 'id');
      const existing = await sessionService.findById(id);
      if (!existing) {
        return apiError(res, 404, 'Design session not found', 'DESIGN_SESSION_NOT_FOUND');
      }
      const currentUserId = (req as any).user?.sub as string | undefined;
      if (existing.ownerUserId && currentUserId && existing.ownerUserId !== currentUserId) {
        return apiError(res, 403, 'Forbidden', 'DESIGN_SESSION_FORBIDDEN');
      }
      await sessionService.delete(id);
      res.status(204).send();
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message, code: 'INTERNAL_ERROR' });
    }
  });

  // ── GET /api/design/sessions/:id/messages ────────────────────────────────
  // List messages for a session
  router.get('/sessions/:id/messages', async (req: Request, res: Response) => {
    try {
      const id = param(req, 'id');
      const session = await sessionService.findById(id);
      if (!session) {
        return apiError(res, 404, 'Design session not found', 'DESIGN_SESSION_NOT_FOUND');
      }
      const currentUserId = (req as any).user?.sub as string | undefined;
      if (session.ownerUserId && currentUserId && session.ownerUserId !== currentUserId) {
        return apiError(res, 403, 'Forbidden', 'DESIGN_SESSION_FORBIDDEN');
      }
      const { limit, before } = req.query as Record<string, string>;
      const messages = await sessionService.listMessages(id, {
        limit: limit ? Number.parseInt(limit, 10) : undefined,
        before: before ?? undefined,
      });
      res.json(messages);
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message, code: 'INTERNAL_ERROR' });
    }
  });

  // ── POST /api/design/sessions/:id/messages ───────────────────────────────
  // Create a message in a session
  router.post('/sessions/:id/messages', async (req: Request, res: Response) => {
    try {
      const id = param(req, 'id');
      const { role, content, status: msgStatus, senderUserId, senderName, senderEmail } = req.body ?? {};

      if (!content || typeof content !== 'string' || content.trim() === '') {
        return apiError(res, 400, 'content is required and must be non-empty', 'DESIGN_MESSAGE_INVALID');
      }

      const message = await sessionService.createMessage({
        designSessionId: id,
        role: role ?? 'user',
        content,
        status: msgStatus ?? 'completed',
        senderUserId,
        senderName,
        senderEmail,
      });

      res.status(201).json(message);
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message, code: 'INTERNAL_ERROR' });
    }
  });

  // ── POST /api/design/sessions/:id/run ────────────────────────────────────
  // Run endpoint: dispatch design session to workflow or agent (REQ-022)
  router.post('/sessions/:id/run', async (req: Request, res: Response) => {
    const id = param(req, 'id');
    try {
      const { prompt, routingOverride } = req.body ?? {};

      // Step 1: validate body
      if (!prompt || typeof prompt !== 'string' || prompt.trim() === '') {
        return apiError(res, 400, 'prompt is required', 'DESIGN_RUN_INVALID');
      }

      // Step 2: look up session
      const session = await sessionService.findById(id);
      if (!session) {
        return apiError(res, 404, 'Design session not found', 'DESIGN_SESSION_NOT_FOUND');
      }
      const currentUserId = (req as any).user?.sub as string | undefined;
      if (session.ownerUserId && currentUserId && session.ownerUserId !== currentUserId) {
        return apiError(res, 403, 'Forbidden', 'DESIGN_SESSION_FORBIDDEN');
      }

      // Resolve repo paths from repo records
      let designRepoPath: string | undefined;
      let sourceRepoPath: string | undefined;
      try {
        const designRepo = await db.collection('repos').findOne(
          { $or: [{ _id: (await import('mongodb').then(m => new m.ObjectId(session.designRepoId))) }, { name: session.designRepoId }] }
        ) as { path?: string } | null;
        designRepoPath = designRepo?.path ?? session.designRepoPath;
      } catch {
        designRepoPath = session.designRepoPath;
      }
      if (session.sourceRepoId) {
        try {
          const { ObjectId } = await import('mongodb');
          const sourceRepo = await db.collection('repos').findOne(
            { $or: [{ _id: new ObjectId(session.sourceRepoId) }, { name: session.sourceRepoId }] }
          ) as { path?: string } | null;
          sourceRepoPath = sourceRepo?.path ?? session.sourceRepoPath;
        } catch {
          sourceRepoPath = session.sourceRepoPath;
        }
      }

      // Step 3: create user message
      await sessionService.createMessage({
        designSessionId: id,
        role: 'user',
        content: prompt,
        status: 'completed',
      });

      // Step 4: resolve routing decision (before creating placeholder so we know the mode)
      const decision = await routingService.resolveRoute(session, routingOverride, prompt);

      // Step 5: create assistant placeholder message
      // For direct mode, create it as 'completed' immediately (no agent will update it).
      const assistantMsg = await sessionService.createMessage({
        designSessionId: id,
        role: 'assistant',
        content: '',
        status: decision.mode === 'direct' ? 'completed' : 'streaming',
        routingDecision: decision,
      });

      // Step 6: dispatch
      let dispatchResult: { executionId?: string; agentRunId?: string; directResponse?: string };
      try {
        dispatchResult = await routingService.dispatch(decision, {
          prompt,
          designRepoPath,
          sourceRepoPath,
          designSessionId: id,
          messageId: assistantMsg._id!.toString(),
        });
      } catch (dispatchErr: unknown) {
        const code = (dispatchErr as any).code ?? 'DESIGN_DISPATCH_FAILED';

        // Missing required workflow inputs → convert to a clarification direct response
        // rather than surfacing a raw schema error to the user.
        if (code === 'DESIGN_MISSING_WORKFLOW_INPUTS') {
          const clarification = (dispatchErr as any).clarification as string;
          await sessionService.updateMessage(assistantMsg._id!.toString(), {
            status: 'completed',
            content: clarification,
            completedAt: new Date(),
          });
          await sessionService.update(id, {
            status: 'idle',
            // 'direct' is not in the routingMode union; use 'agent' as proxy
            routingMode: 'agent',
            routingDecision: decision,
          });
          return res.json({
            designSessionId: id,
            messageId: assistantMsg._id!.toString(),
            routingDecision: decision,
            status: 'completed',
            directResponse: clarification,
          });
        }

        // Real dispatch error → 502
        await sessionService.updateMessage(assistantMsg._id!.toString(), {
          status: 'failed',
          error: (dispatchErr as Error).message,
          completedAt: new Date(),
        });
        await sessionService.update(id, { status: 'failed' });
        return res.status(502).json({
          error: (dispatchErr as Error).message,
          code,
        });
      }

      // Step 7a: direct mode — fill in the response and return immediately
      if (decision.mode === 'direct' && dispatchResult.directResponse) {
        await sessionService.updateMessage(assistantMsg._id!.toString(), {
          status: 'completed',
          content: dispatchResult.directResponse,
          completedAt: new Date(),
        });
        // Session stays idle
        await sessionService.update(id, {
          status: 'idle',
          // 'direct' is not in the routingMode union; use 'agent' as proxy
          routingMode: 'agent',
          routingDecision: decision,
        });

        console.info('[design] run direct', {
          designSessionId: id,
          mode: 'direct',
        });

        return res.json({
          designSessionId: id,
          messageId: assistantMsg._id!.toString(),
          routingDecision: decision,
          status: 'completed',
          directResponse: dispatchResult.directResponse,
        });
      }

      // Step 7b: async mode (workflow / agent) — mark session as running
      await sessionService.update(id, {
        status: 'running',
        routingMode: decision.mode === 'workflow' ? 'workflow' : 'agent',
        routingDecision: decision,
        hasExistingOutputs: true,
        ...(dispatchResult.executionId ? { lastExecutionId: dispatchResult.executionId } : {}),
        ...(dispatchResult.agentRunId ? { lastAgentRunId: dispatchResult.agentRunId } : {}),
      });

      // Update assistant message with dispatch result
      await sessionService.updateMessage(assistantMsg._id!.toString(), {
        executionId: dispatchResult.executionId,
        agentRunId: dispatchResult.agentRunId,
      });

      console.info('[design] run dispatched', {
        designSessionId: id,
        mode: decision.mode,
        executionId: dispatchResult.executionId,
        agentRunId: dispatchResult.agentRunId,
      });

      // Step 8: return result
      res.json({
        designSessionId: id,
        messageId: assistantMsg._id!.toString(),
        routingDecision: decision,
        executionId: dispatchResult.executionId,
        agentRunId: dispatchResult.agentRunId,
        status: 'running',
      });
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message, code: 'INTERNAL_ERROR' });
    }
  });

  // ── GET /api/design/sessions/:id/reconcile ────────────────────────────
  // Reconcile streaming messages against their execution records.
  // Call this from the UI while polling a running session.
  router.get('/sessions/:id/reconcile', async (req: Request, res: Response) => {
    const id = param(req, 'id');
    try {
      const session = await sessionService.findById(id);
      if (!session) {
        return apiError(res, 404, 'Design session not found', 'DESIGN_SESSION_NOT_FOUND');
      }
      const currentUserId = (req as any).user?.sub as string | undefined;
      if (session.ownerUserId && currentUserId && session.ownerUserId !== currentUserId) {
        return apiError(res, 403, 'Forbidden', 'DESIGN_SESSION_FORBIDDEN');
      }

      // Find all streaming assistant messages for this session
      const messages = await sessionService.listMessages(id);
      const streamingMsgs = messages.filter(
        (m) => m.role === 'assistant' && m.status === 'streaming' && (m.agentRunId ?? m.executionId),
      );

      let reconciledCount = 0;
      const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled', 'error']);

      for (const msg of streamingMsgs) {
        const execId = msg.agentRunId ?? msg.executionId;
        if (!execId) continue;

        // Look up execution record
        const execRow = await db.collection('executions').findOne(
          { id: execId },
          { projection: { status: 1, errorMessage: 1, id: 1 } },
        ) as { status: string; errorMessage?: string; id: string } | null;

        if (!execRow || !TERMINAL_STATUSES.has(execRow.status)) continue;

        const msgId = msg._id!.toString();

        if (execRow.status === 'completed') {
          // Try to get response text from the latest execution trace
          const trace = await db.collection('execution_traces').findOne(
            { executionId: execId },
            { sort: { attempt: -1 }, projection: { rawResponse: 1, output: 1 } },
          ) as { rawResponse?: string; output?: Record<string, unknown> } | null;

          const responseText =
            (typeof trace?.rawResponse === 'string' && trace.rawResponse.trim()
              ? trace.rawResponse.trim()
              : null)
            ?? (typeof trace?.output?.response === 'string' && (trace.output.response as string).trim()
              ? (trace.output.response as string).trim()
              : null)
            ?? 'Design session completed. Check the execution for details.';

          await sessionService.updateMessage(msgId, {
            status: 'completed',
            content: responseText,
            completedAt: new Date(),
          });
        } else {
          // failed or cancelled
          const errorText = execRow.errorMessage ?? `Execution ${execRow.status}`;
          await sessionService.updateMessage(msgId, {
            status: 'failed',
            error: errorText,
            content: '',
            completedAt: new Date(),
          });
        }
        reconciledCount++;
      }

      // Refresh session status: if no more streaming messages, mark session idle (or failed)
      const refreshedMessages = await sessionService.listMessages(id);
      const stillStreaming = refreshedMessages.some(
        (m) => m.role === 'assistant' && m.status === 'streaming',
      );
      const anyFailed = refreshedMessages.some(
        (m) => m.role === 'assistant' && m.status === 'failed',
      );

      let newSessionStatus: 'running' | 'idle' | 'failed' = session.status as 'running' | 'idle' | 'failed';
      if (!stillStreaming && session.status === 'running') {
        newSessionStatus = anyFailed ? 'failed' : 'idle';
        await sessionService.update(id, { status: newSessionStatus });
      }

      const updatedSession = await sessionService.findById(id);

      res.json({
        reconciledCount,
        sessionStatus: newSessionStatus,
        session: updatedSession,
        messages: refreshedMessages,
      });
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message, code: 'INTERNAL_ERROR' });
    }
  });

  return router;
}
