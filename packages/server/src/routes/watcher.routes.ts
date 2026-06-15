/**
 * Execution Watcher Routes
 *
 * Provides read-only API endpoints for the UI to query active watchers.
 *
 * @see TDD §2.1 — GET /api/execution-watchers
 * @see TDD §2.2 — GET /api/execution-watchers/:executionId
 */

import { Router, type Request, type Response } from 'express';
import type { Db } from 'mongodb';
import type { WatcherUIDoc, ExecutionWatcherDoc } from '../services/watcher.service.js';

const COLLECTION = 'execution_watchers';

function toWatcherUIDoc(doc: ExecutionWatcherDoc): WatcherUIDoc {
  return {
    watcherId: doc.watcherId,
    executionId: doc.executionId,
    executionType: doc.executionType,
    watcherStatus: doc.watcherStatus,
    executionState: doc.executionState,
    triggerSentForState: doc.triggerSentForState,
    latestStatusText: doc.latestStatusText,
    lastCheckedAt: doc.lastCheckedAt instanceof Date
      ? doc.lastCheckedAt.toISOString()
      : String(doc.lastCheckedAt),
    updateSeq: doc.updateSeq,
  };
}

export function watcherRoutes(db: Db): Router {
  const router = Router();

  // GET /api/execution-watchers?chatSessionId=X
  // TDD §2.1 — List active watchers for a chat session
  router.get('/', async (req: Request, res: Response) => {
    const chatSessionId = req.query.chatSessionId as string | undefined;

    if (!chatSessionId) {
      res.status(400).json({ error: 'Missing required query parameter: chatSessionId' });
      return;
    }

    try {
      const docs = await db.collection<ExecutionWatcherDoc>(COLLECTION)
        .find({
          chatSessionId,
          watcherStatus: { $in: ['active', 'waiting'] },
        })
        .sort({ createdAt: 1 })
        .toArray();

      const result: WatcherUIDoc[] = docs.map(toWatcherUIDoc);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: 'Failed to fetch watchers' });
    }
  });

  // GET /api/execution-watchers/:executionId
  // TDD §2.2 — Get single watcher by execution ID
  router.get('/:executionId', async (req: Request, res: Response) => {
    const { executionId } = req.params;

    try {
      const doc = await db.collection<ExecutionWatcherDoc>(COLLECTION).findOne({ executionId });

      if (!doc) {
        res.status(404).json({ error: `No watcher found for execution ${executionId}` });
        return;
      }

      res.json(toWatcherUIDoc(doc));
    } catch (err) {
      res.status(500).json({ error: 'Failed to fetch watcher' });
    }
  });

  return router;
}
