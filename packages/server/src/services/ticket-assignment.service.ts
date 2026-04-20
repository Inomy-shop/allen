/**
 * Local overlay for assigning Allen agents to Linear tickets.
 *
 * Linear's native `assignee` field targets a Linear user, not an Allen agent.
 * We store an additive mapping (linearIssueId → agentName) in Mongo so the
 * Tickets UI can surface who "owns" a ticket on the Allen side without
 * writing anything back to Linear.
 */

import type { Collection, Db } from 'mongodb';

export type TicketAssignmentStatus = 'manual' | 'pending' | 'running' | 'failed' | 'completed';

export interface TicketAssignment {
  linearIssueId: string;
  agentName: string;
  assignedAt: Date;
  assignedBy: string;
  note?: string;
  /**
   * Optional fields populated when assignment is also a dispatch (agent
   * actually started work in a workspace). `status: 'manual'` means a plain
   * assignment with no workspace/execution.
   */
  status?: TicketAssignmentStatus;
  workspaceId?: string;
  workspacePath?: string;
  executionId?: string;
  error?: string;
  repoId?: string;
  branch?: string;
}

export class TicketAssignmentService {
  private col: Collection<TicketAssignment>;

  constructor(db: Db) {
    this.col = db.collection<TicketAssignment>('ticket_assignments');
    this.col.createIndex({ linearIssueId: 1 }, { unique: true }).catch(() => {});
  }

  async get(linearIssueId: string): Promise<TicketAssignment | null> {
    const doc = await this.col.findOne({ linearIssueId });
    return doc ?? null;
  }

  async getAllAsMap(): Promise<Map<string, TicketAssignment>> {
    const docs = await this.col.find({}).toArray();
    return new Map(docs.map(d => [d.linearIssueId, d]));
  }

  async set(linearIssueId: string, agentName: string, assignedBy: string, note?: string): Promise<TicketAssignment> {
    const now = new Date();
    const doc: TicketAssignment = {
      linearIssueId,
      agentName,
      assignedAt: now,
      assignedBy,
      status: 'manual',
      ...(note ? { note } : {}),
    };
    await this.col.updateOne(
      { linearIssueId },
      { $set: doc },
      { upsert: true },
    );
    return doc;
  }

  /** Patch an existing assignment (e.g. as a dispatch progresses). */
  async patch(linearIssueId: string, updates: Partial<TicketAssignment>): Promise<TicketAssignment | null> {
    await this.col.updateOne({ linearIssueId }, { $set: updates });
    return this.get(linearIssueId);
  }

  /** Replace or insert a full dispatch record. */
  async upsertDispatch(doc: TicketAssignment): Promise<TicketAssignment> {
    await this.col.updateOne(
      { linearIssueId: doc.linearIssueId },
      { $set: doc },
      { upsert: true },
    );
    return doc;
  }

  async clear(linearIssueId: string): Promise<void> {
    await this.col.deleteOne({ linearIssueId });
  }
}
