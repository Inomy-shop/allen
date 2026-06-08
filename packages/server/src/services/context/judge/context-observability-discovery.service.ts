import type { Db } from 'mongodb';

export interface ContextAttemptCandidate {
  contextAttemptId: string;
  executionId: string;
  repoId?: string;
  repoName?: string;
  workflowName?: string;
  nodeName?: string;
  executionKind?: string;
  createdAt: Date;
  status: string;
  consideredCount?: number;
  injectedCount?: number;
}

export interface DiscoverCandidatesOptions {
  /** Lower bound for createdAt. Defaults to epoch (new Date(0)). */
  cursorDate?: Date;
  /** Restrict to specific repo IDs. Null/undefined means no filter. */
  repoIds?: string[] | null;
  /** Filter by executionKind (e.g. 'workflow_node', 'spawned_agent'). */
  executionKind?: string;
  /** Maximum number of results to return. Default: 20. */
  limit?: number;
  /**
   * When true (default), only return attempts where
   * contextInjection.consideredCount > 0 OR contextInjection.injectedCount > 0.
   */
  requireInjectionEvidence?: boolean;
}

export class ContextObservabilityDiscoveryService {
  constructor(private db: Db) {}

  async discoverCandidates(options: DiscoverCandidatesOptions): Promise<ContextAttemptCandidate[]> {
    const {
      cursorDate = new Date(0),
      repoIds,
      executionKind,
      limit = 20,
      requireInjectionEvidence = true,
    } = options;

    const query: Record<string, unknown> = {
      status: 'ready',
      createdAt: { $gt: cursorDate },
    };

    if (requireInjectionEvidence) {
      query['$or'] = [
        { 'contextInjection.consideredCount': { $gt: 0 } },
        { 'contextInjection.injectedCount': { $gt: 0 } },
      ];
    }

    if (repoIds && repoIds.length > 0) {
      query['repoId'] = { $in: repoIds };
    }

    if (executionKind) {
      query['executionKind'] = executionKind;
    }

    const docs = await this.db
      .collection('context_attempts')
      .find(query)
      .sort({ createdAt: -1 })  // newest-first: primary requirement — sort before limit
      .limit(limit)
      .project({
        _id: 0,
        contextAttemptId: 1,
        executionId: 1,
        repoId: 1,
        repoName: 1,
        workflowName: 1,
        nodeName: 1,
        executionKind: 1,
        createdAt: 1,
        status: 1,
        'contextInjection.consideredCount': 1,
        'contextInjection.injectedCount': 1,
      })
      .toArray();

    return docs.map((doc) => {
      const injection = doc['contextInjection'] as Record<string, unknown> | undefined;
      return {
        contextAttemptId: doc['contextAttemptId'] as string,
        executionId: doc['executionId'] as string,
        repoId: doc['repoId'] as string | undefined,
        repoName: doc['repoName'] as string | undefined,
        workflowName: doc['workflowName'] as string | undefined,
        nodeName: doc['nodeName'] as string | undefined,
        executionKind: doc['executionKind'] as string | undefined,
        createdAt: doc['createdAt'] as Date,
        status: doc['status'] as string,
        consideredCount: injection?.['consideredCount'] as number | undefined,
        injectedCount: injection?.['injectedCount'] as number | undefined,
      };
    });
  }
}
