/**
 * Design Session Service
 *
 * Manages `design_sessions` and `design_messages` collections for the
 * Allen Desktop Design Tab. Each session represents a design conversation
 * thread that can dispatch to a workflow or agent, and accumulates
 * messages tracking user prompts and assistant responses.
 */

import type { Collection, Db } from 'mongodb';

// ── Types ──────────────────────────────────────────────────────────────────

export type RepoRole = 'source_repo' | 'design_repo';

export interface DesignRoutingDecision {
  mode: 'workflow' | 'agent' | 'direct';
  resolvedBy: 'auto' | 'user_override';
  workflowName?: string;
  agentName?: string;
  reason: string;
  outputMode: 'spec_only' | 'prototype';
  overrideKey?: 'auto' | 'full_workflow' | 'fast_frontend' | 'design_refinement' | 'design_review';
  needsConfirmation?: boolean;
}

export interface DesignSession {
  _id?: import('mongodb').ObjectId;
  kind: 'design';
  sourceSurface: 'design_tab';
  title: string;
  designRepoId: string;
  designRepoPath?: string;
  sourceRepoId?: string;
  sourceRepoPath?: string;
  workspaceId?: string;
  status: 'idle' | 'running' | 'failed' | 'archived';
  routingMode?: 'workflow' | 'agent';
  routingDecision?: DesignRoutingDecision;
  lastExecutionId?: string;
  lastAgentRunId?: string;
  hasExistingOutputs?: boolean;
  outputMode: 'spec_only' | 'prototype';
  ownerUserId?: string | null;
  ownerName?: string | null;
  ownerEmail?: string | null;
  createdAt: Date;
  updatedAt: Date;
  lastMessageAt: Date;
}

export interface DesignMessage {
  _id?: import('mongodb').ObjectId;
  designSessionId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  status: 'completed' | 'streaming' | 'failed';
  routingDecision?: DesignRoutingDecision;
  executionId?: string;
  agentRunId?: string;
  artifacts?: Array<{ artifactId: string; url: string; filename: string; contentType?: string }>;
  previewUrl?: string;
  senderUserId?: string;
  senderName?: string;
  senderEmail?: string;
  error?: string;
  createdAt: Date;
  completedAt?: Date;
}

// ── Service ────────────────────────────────────────────────────────────────

export class DesignSessionService {
  private sessions: Collection;
  private messages: Collection;

  constructor(db: Db) {
    this.sessions = db.collection('design_sessions');
    this.messages = db.collection('design_messages');
  }

  async list(filter: {
    status?: string;
    designRepoId?: string;
    limit?: number;
    ownerUserId?: string;
  }): Promise<DesignSession[]> {
    const query: Record<string, unknown> = {};
    if (filter.status) query.status = filter.status;
    if (filter.designRepoId) query.designRepoId = filter.designRepoId;
    if (filter.ownerUserId) query.ownerUserId = filter.ownerUserId;
    return this.sessions
      .find(query)
      .sort({ lastMessageAt: -1 })
      .limit(filter.limit ?? 100)
      .toArray() as Promise<DesignSession[]>;
  }

  async create(data: {
    title: string;
    designRepoId: string;
    sourceRepoId?: string;
    outputMode?: 'spec_only' | 'prototype';
    ownerUserId?: string;
    ownerName?: string;
    ownerEmail?: string;
  }): Promise<DesignSession> {
    const now = new Date();
    const doc: DesignSession = {
      kind: 'design',
      sourceSurface: 'design_tab',
      title: data.title,
      designRepoId: data.designRepoId,
      sourceRepoId: data.sourceRepoId,
      status: 'idle',
      outputMode: data.outputMode ?? 'spec_only',
      ownerUserId: data.ownerUserId ?? null,
      ownerName: data.ownerName ?? null,
      ownerEmail: data.ownerEmail ?? null,
      createdAt: now,
      updatedAt: now,
      lastMessageAt: now,
    };
    const result = await this.sessions.insertOne(doc);
    console.info('[design] session created', { designSessionId: result.insertedId.toString(), designRepoId: data.designRepoId });
    return { ...doc, _id: result.insertedId };
  }

  async findById(id: string): Promise<DesignSession | null> {
    const { ObjectId } = await import('mongodb');
    return this.sessions.findOne({ _id: new ObjectId(id) }) as Promise<DesignSession | null>;
  }

  async update(
    id: string,
    patch: Partial<Pick<
      DesignSession,
      | 'title'
      | 'sourceRepoId'
      | 'status'
      | 'outputMode'
      | 'workspaceId'
      | 'lastExecutionId'
      | 'lastAgentRunId'
      | 'routingDecision'
      | 'routingMode'
      | 'hasExistingOutputs'
    >>,
  ): Promise<DesignSession | null> {
    const { ObjectId } = await import('mongodb');
    const oid = new ObjectId(id);
    await this.sessions.updateOne(
      { _id: oid },
      { $set: { ...patch, updatedAt: new Date(), lastMessageAt: new Date() } },
    );
    return this.sessions.findOne({ _id: oid }) as Promise<DesignSession | null>;
  }

  async delete(id: string): Promise<void> {
    const { ObjectId } = await import('mongodb');
    await this.sessions.deleteOne({ _id: new ObjectId(id) });
    await this.messages.deleteMany({ designSessionId: id });
    console.info('[design] session deleted', { designSessionId: id });
  }

  async listMessages(
    designSessionId: string,
    opts?: { limit?: number; before?: string },
  ): Promise<DesignMessage[]> {
    const query: Record<string, unknown> = { designSessionId };
    if (opts?.before) {
      const { ObjectId } = await import('mongodb');
      query._id = { $lt: new ObjectId(opts.before) };
    }
    return this.messages
      .find(query)
      .sort({ createdAt: 1 })
      .limit(opts?.limit ?? 100)
      .toArray() as Promise<DesignMessage[]>;
  }

  async createMessage(data: Omit<DesignMessage, '_id' | 'createdAt'>): Promise<DesignMessage> {
    const doc: DesignMessage = {
      ...data,
      createdAt: new Date(),
    };
    const result = await this.messages.insertOne(doc);
    // Update session lastMessageAt
    const { ObjectId } = await import('mongodb');
    await this.sessions.updateOne(
      { _id: new ObjectId(data.designSessionId) },
      { $set: { lastMessageAt: new Date(), updatedAt: new Date() } },
    );
    return { ...doc, _id: result.insertedId };
  }

  async updateMessage(
    id: string,
    patch: Partial<Pick<DesignMessage, 'status' | 'content' | 'executionId' | 'agentRunId' | 'artifacts' | 'error' | 'completedAt'>>,
  ): Promise<void> {
    const { ObjectId } = await import('mongodb');
    await this.messages.updateOne(
      { _id: new ObjectId(id) },
      { $set: patch },
    );
  }
}
