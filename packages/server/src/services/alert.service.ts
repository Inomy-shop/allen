/**
 * Alert Service
 * Event-driven alerts for proactive intelligence.
 * Alerts are written when things happen (execution fails, MCP disconnects, etc.)
 * UI reads them via the notification bell.
 */

import type { Db } from 'mongodb';
import { ObjectId } from 'mongodb';

export type AlertSeverity = 'info' | 'warning' | 'error';
export type AlertCategory = 'execution' | 'mcp' | 'workflow' | 'system';

export interface Alert {
  _id?: ObjectId;
  title: string;
  message: string;
  severity: AlertSeverity;
  category: AlertCategory;
  read: boolean;
  /** Optional link to related resource */
  link?: string;
  /** Metadata for context */
  meta?: Record<string, unknown>;
  createdAt: Date;
}

export class AlertService {
  private db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  private get collection() {
    return this.db.collection('alerts');
  }

  async create(alert: Omit<Alert, '_id' | 'read' | 'createdAt'>): Promise<Alert> {
    const doc: Alert = { ...alert, read: false, createdAt: new Date() };
    const result = await this.collection.insertOne(doc);
    return { ...doc, _id: result.insertedId };
  }

  async list(opts: { unreadOnly?: boolean; limit?: number } = {}): Promise<Alert[]> {
    const filter: Record<string, unknown> = {};
    if (opts.unreadOnly) filter.read = false;
    const limit = opts.limit ?? 50;
    return this.collection.find(filter).sort({ createdAt: -1 }).limit(limit).toArray() as Promise<Alert[]>;
  }

  async unreadCount(): Promise<number> {
    return this.collection.countDocuments({ read: false });
  }

  async markRead(id: string): Promise<void> {
    await this.collection.updateOne({ _id: new ObjectId(id) }, { $set: { read: true } });
  }

  async markAllRead(): Promise<void> {
    await this.collection.updateMany({ read: false }, { $set: { read: true } });
  }

  async dismiss(id: string): Promise<void> {
    await this.collection.deleteOne({ _id: new ObjectId(id) });
  }

  // ── Event Triggers ──

  async onExecutionFailed(execId: string, workflowName: string, error: string): Promise<void> {
    await this.create({
      title: `Execution failed: ${workflowName}`,
      message: error.slice(0, 200),
      severity: 'error',
      category: 'execution',
      link: `/executions/${execId}`,
      meta: { executionId: execId, workflowName },
    });
  }

  async onMcpServerDisconnected(serverName: string, error: string): Promise<void> {
    await this.create({
      title: `MCP server disconnected: ${serverName}`,
      message: error.slice(0, 200),
      severity: 'warning',
      category: 'mcp',
      meta: { serverName },
    });
  }

  async onChatError(sessionId: string, error: string): Promise<void> {
    await this.create({
      title: 'Chat error',
      message: error.slice(0, 200),
      severity: 'error',
      category: 'system',
      link: `/chat/${sessionId}`,
      meta: { sessionId },
    });
  }
}
