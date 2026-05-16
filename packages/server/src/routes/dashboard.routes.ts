import { Router, type Request, type Response } from 'express';
import { DashboardService } from '../services/dashboard.service.js';
import { LinearService } from '../services/linear.service.js';
import type { Db } from 'mongodb';

type NavCounts = {
  mywork: number;
  inbox: number;
  threads: number;
  tickets?: number;
  pulls: number;
  workspaces: number;
  activity: number;
  learnings: number;
};

const NAV_COUNTS_TTL_MS = 60_000;
const TICKET_COUNT_TTL_MS = 5 * 60_000;
let navCountsCache: { at: number; data: NavCounts } | null = null;
let ticketCountCache: { at: number; count: number } | null = null;
let ticketCountRefresh: Promise<void> | null = null;

function refreshTicketCount(db: Db): void {
  if (ticketCountRefresh) return;
  ticketCountRefresh = (async () => {
    try {
      const linearService = new LinearService(db);
      const count = await linearService.listIssues({ limit: 200 }).then(issues => issues.length);
      ticketCountCache = { at: Date.now(), count };
      if (navCountsCache) {
        navCountsCache = {
          at: navCountsCache.at,
          data: { ...navCountsCache.data, tickets: count },
        };
      }
    } catch {
      // Keep the last ticket count, if any. Badge freshness should not block
      // app shell rendering.
    } finally {
      ticketCountRefresh = null;
    }
  })();
}

export function dashboardRoutes(db: Db): Router {
  const router = Router();
  const service = new DashboardService(db);

  // GET /api/dashboard/stats
  router.get('/stats', async (_req: Request, res: Response) => {
    try {
      const stats = await service.getStats();
      res.json(stats);
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // GET /api/dashboard/cost
  router.get('/cost', async (_req: Request, res: Response) => {
    try {
      const cost = await service.getCostBreakdown();
      res.json(cost);
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // GET /api/dashboard/nav-counts
  //
  // Compact counts for the app shell badges. This keeps every page from
  // downloading full ticket/PR/session/workspace/execution lists just to
  // render numbers in the sidebar.
  router.get('/nav-counts', async (_req: Request, res: Response) => {
    try {
      if (navCountsCache && Date.now() - navCountsCache.at < NAV_COUNTS_TTL_MS) {
        return res.json(navCountsCache.data);
      }

      const [
        pendingInterventions,
        chatSessions,
        pullRequests,
        workspaces,
        executions,
        activeChatRuns,
        learnings,
      ] = await Promise.all([
        db.collection('workflow_interventions').countDocuments({ status: 'pending' }),
        db.collection('chat_sessions').countDocuments({}),
        db.collection('pull_requests').countDocuments({}),
        db.collection('workspaces').countDocuments({ status: { $ne: 'archived' } }),
        db.collection('executions').countDocuments({}),
        db.collection('executions').countDocuments({
          status: 'running',
          'meta.chatSessionId': { $exists: true, $nin: [null, ''] },
        }),
        db.collection('learnings').countDocuments({}),
      ]);
      if (!ticketCountCache || Date.now() - ticketCountCache.at > TICKET_COUNT_TTL_MS) {
        refreshTicketCount(db);
      }

      const data: NavCounts = {
        mywork: pendingInterventions + activeChatRuns,
        inbox: pendingInterventions,
        threads: chatSessions,
        ...(ticketCountCache ? { tickets: ticketCountCache.count } : {}),
        pulls: pullRequests,
        workspaces,
        activity: executions,
        learnings,
      };
      navCountsCache = { at: Date.now(), data };
      res.json(data);
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  return router;
}
