import type { Db } from 'mongodb';

/**
 * On-demand cost rollups over the execution tree.
 *
 * Cost singularity invariant: the database stores cost ONLY as per-LLM-run
 * rows — execution_traces (one row per node per attempt) and chat_messages
 * (one row per assistant turn). Execution rows carry no cost; nothing stores
 * a parent+children combined figure. Every total a page shows (workflow
 * execution, agent execution, chat session, dashboard) is computed here, at
 * read time, by walking parentExecutionId links and summing each execution's
 * OWN traces.
 *
 * Traces with cost.method === 'child_execution' are sub-workflow links —
 * their child's spend lives on the child's own traces, so they are excluded
 * from every sum (that's the whole point).
 */

export interface CostTotals {
  /** Authoritative USD (token_computed/sdk_reported `cost.actual`). */
  costUsd: number;
  /** Legacy pre-token-costing estimates — kept separate, never mixed in. */
  estimatedUsd: number;
  inputCachedTokens: number;
  inputNonCachedTokens: number;
  outputTokens: number;
  /** Number of priced trace rows (node attempts / agent runs). */
  llmCalls: number;
}

export interface ModelBreakdownRow extends CostTotals {
  model: string;
  provider: string;
}

export interface ExecutionTreeCost {
  executionId: string;
  /** This execution's own traces only. */
  own: CostTotals;
  /** Own + every descendant in the spawn/nesting tree. */
  total: CostTotals;
  /** Direct children (depth-first, each with its own subtree totals). */
  children: ExecutionTreeCost[];
  /** Per-(provider, model) breakdown across the whole tree. */
  byModel: ModelBreakdownRow[];
  /** Number of executions in the tree (including this one). */
  treeSize: number;
}

export interface ChatSessionCost {
  sessionId: string;
  /** Assistant chat turns (chat_messages.costUsd) only. */
  messages: { costUsd: number; count: number };
  /** Executions spawned from this chat, each rolled up over its tree. */
  executions: Array<{ executionId: string; workflowName: string | null; total: CostTotals }>;
  /** messages + all execution trees. */
  totalCostUsd: number;
}

const ZERO: CostTotals = {
  costUsd: 0,
  estimatedUsd: 0,
  inputCachedTokens: 0,
  inputNonCachedTokens: 0,
  outputTokens: 0,
  llmCalls: 0,
};

/** Defensive bound — spawn depth is already capped far below this. */
const MAX_TREE_DEPTH = 12;

function addTotals(a: CostTotals, b: CostTotals): CostTotals {
  return {
    costUsd: a.costUsd + b.costUsd,
    estimatedUsd: a.estimatedUsd + b.estimatedUsd,
    inputCachedTokens: a.inputCachedTokens + b.inputCachedTokens,
    inputNonCachedTokens: a.inputNonCachedTokens + b.inputNonCachedTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    llmCalls: a.llmCalls + b.llmCalls,
  };
}

export class CostRollupService {
  constructor(private db: Db) {}

  /**
   * Own-trace cost for each requested execution — one grouped aggregation,
   * no tree walk. Used by list views in place of the removed executions.cost.
   */
  async getOwnCosts(executionIds: string[]): Promise<Map<string, CostTotals>> {
    const out = new Map<string, CostTotals>();
    if (executionIds.length === 0) return out;
    const rows = await this.db.collection('execution_traces').aggregate([
      { $match: { executionId: { $in: executionIds }, 'cost.method': { $ne: 'child_execution' } } },
      {
        $group: {
          _id: '$executionId',
          costUsd: { $sum: { $ifNull: ['$cost.actual', 0] } },
          estimatedUsd: { $sum: { $ifNull: ['$cost.estimated', 0] } },
          inputCachedTokens: { $sum: { $ifNull: ['$tokenUsage.inputCachedTokens', 0] } },
          inputNonCachedTokens: { $sum: { $ifNull: ['$tokenUsage.inputNonCachedTokens', 0] } },
          outputTokens: { $sum: { $ifNull: ['$tokenUsage.outputTokens', 0] } },
          llmCalls: { $sum: 1 },
        },
      },
    ]).toArray();
    for (const r of rows) {
      out.set(r._id as string, {
        costUsd: (r.costUsd as number) ?? 0,
        estimatedUsd: (r.estimatedUsd as number) ?? 0,
        inputCachedTokens: (r.inputCachedTokens as number) ?? 0,
        inputNonCachedTokens: (r.inputNonCachedTokens as number) ?? 0,
        outputTokens: (r.outputTokens as number) ?? 0,
        llmCalls: (r.llmCalls as number) ?? 0,
      });
    }
    return out;
  }

  /**
   * Every execution id in the tree rooted at `executionId`, including the
   * root, plus the parent→children adjacency. BFS over the indexed
   * parentExecutionId link.
   */
  private async collectTree(executionId: string): Promise<{ ids: string[]; childrenOf: Map<string, string[]> }> {
    const ids: string[] = [executionId];
    const seen = new Set<string>([executionId]);
    const childrenOf = new Map<string, string[]>();
    let frontier = [executionId];
    for (let depth = 0; depth < MAX_TREE_DEPTH && frontier.length > 0; depth++) {
      const rows = await this.db.collection('executions')
        .find({ parentExecutionId: { $in: frontier } }, { projection: { id: 1, parentExecutionId: 1 } })
        .toArray();
      const next: string[] = [];
      for (const row of rows) {
        const id = row.id as string | undefined;
        const parent = row.parentExecutionId as string | undefined;
        if (!id || !parent || seen.has(id)) continue;
        seen.add(id);
        ids.push(id);
        next.push(id);
        const siblings = childrenOf.get(parent) ?? [];
        siblings.push(id);
        childrenOf.set(parent, siblings);
      }
      frontier = next;
    }
    return { ids, childrenOf };
  }

  /**
   * Full on-demand rollup for one execution: own cost, subtree totals at
   * every level, and a per-(provider, model) breakdown across the tree.
   */
  async getExecutionTreeCost(executionId: string): Promise<ExecutionTreeCost> {
    const { ids, childrenOf } = await this.collectTree(executionId);
    const [ownCosts, byModel] = await Promise.all([
      this.getOwnCosts(ids),
      this.getModelBreakdown(ids),
    ]);

    const build = (id: string): ExecutionTreeCost => {
      const own = ownCosts.get(id) ?? ZERO;
      const children = (childrenOf.get(id) ?? []).map(build);
      const total = children.reduce((acc, c) => addTotals(acc, c.total), own);
      const treeSize = children.reduce((acc, c) => acc + c.treeSize, 1);
      // byModel only on the root node — subtree breakdowns aren't needed by
      // any current reader and would multiply aggregation cost.
      return { executionId: id, own, total, children, byModel: [], treeSize };
    };

    const root = build(executionId);
    root.byModel = byModel;
    return root;
  }

  /** Per-(provider, model) sums over a set of executions' own traces. */
  private async getModelBreakdown(executionIds: string[]): Promise<ModelBreakdownRow[]> {
    if (executionIds.length === 0) return [];
    const rows = await this.db.collection('execution_traces').aggregate([
      { $match: { executionId: { $in: executionIds }, 'cost.method': { $ne: 'child_execution' } } },
      {
        $group: {
          _id: { model: { $ifNull: ['$cost.model', 'unknown'] }, provider: { $ifNull: ['$provider', 'unknown'] } },
          costUsd: { $sum: { $ifNull: ['$cost.actual', 0] } },
          estimatedUsd: { $sum: { $ifNull: ['$cost.estimated', 0] } },
          inputCachedTokens: { $sum: { $ifNull: ['$tokenUsage.inputCachedTokens', 0] } },
          inputNonCachedTokens: { $sum: { $ifNull: ['$tokenUsage.inputNonCachedTokens', 0] } },
          outputTokens: { $sum: { $ifNull: ['$tokenUsage.outputTokens', 0] } },
          llmCalls: { $sum: 1 },
        },
      },
      { $sort: { costUsd: -1 } },
    ]).toArray();
    return rows.map((r) => ({
      model: (r._id as { model: string }).model,
      provider: (r._id as { provider: string }).provider,
      costUsd: (r.costUsd as number) ?? 0,
      estimatedUsd: (r.estimatedUsd as number) ?? 0,
      inputCachedTokens: (r.inputCachedTokens as number) ?? 0,
      inputNonCachedTokens: (r.inputNonCachedTokens as number) ?? 0,
      outputTokens: (r.outputTokens as number) ?? 0,
      llmCalls: (r.llmCalls as number) ?? 0,
    }));
  }

  /**
   * Chat session total: own assistant messages + every execution spawned
   * from the chat, each rolled up over its full tree. Chat message cost
   * covers only the assistant's own session tokens (spawned work is never in
   * it), so message + tree sums count every LLM call exactly once.
   */
  async getChatSessionCost(sessionId: string): Promise<ChatSessionCost> {
    const msgAgg = await this.db.collection('chat_messages').aggregate([
      { $match: { sessionId, costUsd: { $gt: 0 } } },
      { $group: { _id: null, costUsd: { $sum: '$costUsd' }, count: { $sum: 1 } } },
    ]).toArray();
    const messages = {
      costUsd: (msgAgg[0]?.costUsd as number) ?? 0,
      count: (msgAgg[0]?.count as number) ?? 0,
    };

    // Top-level executions linked to this chat. Children of these roots are
    // covered by the tree walk — only roots are listed here (a row that has
    // a parent inside the same chat is someone's descendant already).
    const linked = await this.db.collection('executions')
      .find({ 'meta.chatSessionId': sessionId }, { projection: { id: 1, workflowName: 1, parentExecutionId: 1 } })
      .toArray();
    const linkedIds = new Set(linked.map((r) => r.id as string).filter(Boolean));
    const roots = linked.filter((r) => {
      const parent = r.parentExecutionId as string | undefined | null;
      return !parent || !linkedIds.has(parent);
    });

    const executions: ChatSessionCost['executions'] = [];
    for (const row of roots) {
      const id = row.id as string | undefined;
      if (!id) continue;
      const tree = await this.getExecutionTreeCost(id);
      executions.push({
        executionId: id,
        workflowName: (row.workflowName as string | undefined) ?? null,
        total: tree.total,
      });
    }

    const totalCostUsd = executions.reduce((acc, e) => acc + e.total.costUsd, messages.costUsd);
    return { sessionId, messages, executions, totalCostUsd };
  }

  /**
   * Session totals for a list view, batched: one messages aggregation, one
   * shared BFS over every session's execution trees, one own-cost
   * aggregation. Returns sessionId → total USD (messages + execution trees).
   */
  async getChatSessionsCostBatch(sessionIds: string[]): Promise<Map<string, number>> {
    const totals = new Map<string, number>();
    if (sessionIds.length === 0) return totals;

    const msgRows = await this.db.collection('chat_messages').aggregate([
      { $match: { sessionId: { $in: sessionIds }, costUsd: { $gt: 0 } } },
      { $group: { _id: '$sessionId', costUsd: { $sum: '$costUsd' } } },
    ]).toArray();
    for (const r of msgRows) totals.set(r._id as string, (r.costUsd as number) ?? 0);

    // Seed: executions directly linked to each session; BFS children inherit
    // their parent's owning session.
    const sessionOf = new Map<string, string>();
    const linked = await this.db.collection('executions')
      .find({ 'meta.chatSessionId': { $in: sessionIds } }, { projection: { id: 1, 'meta.chatSessionId': 1 } })
      .toArray();
    for (const row of linked) {
      const id = row.id as string | undefined;
      const sid = (row.meta as { chatSessionId?: string } | undefined)?.chatSessionId;
      if (id && sid && !sessionOf.has(id)) sessionOf.set(id, sid);
    }
    let frontier = [...sessionOf.keys()];
    for (let depth = 0; depth < MAX_TREE_DEPTH && frontier.length > 0; depth++) {
      const rows = await this.db.collection('executions')
        .find({ parentExecutionId: { $in: frontier } }, { projection: { id: 1, parentExecutionId: 1 } })
        .toArray();
      const next: string[] = [];
      for (const row of rows) {
        const id = row.id as string | undefined;
        const parent = row.parentExecutionId as string | undefined;
        if (!id || !parent || sessionOf.has(id)) continue;
        const sid = sessionOf.get(parent);
        if (!sid) continue;
        sessionOf.set(id, sid);
        next.push(id);
      }
      frontier = next;
    }

    const ownCosts = await this.getOwnCosts([...sessionOf.keys()]);
    for (const [executionId, own] of ownCosts) {
      const sid = sessionOf.get(executionId);
      if (!sid) continue;
      totals.set(sid, (totals.get(sid) ?? 0) + own.costUsd);
    }
    return totals;
  }
}
