/**
 * Agent Conversation Service
 * Manages agent-to-agent delegation conversations.
 * Each delegation creates a conversation record in the agent_conversations collection.
 */

import type { Db, ObjectId } from 'mongodb';

export interface AgentMessage {
  agent: string;
  content: string;
  toolCalls?: { tool: string; args: Record<string, unknown>; result?: Record<string, unknown>; durationMs?: number }[];
  timestamp: Date;
}

export interface AgentConversation {
  _id?: ObjectId;
  chatSessionId: string;
  parentMessageId: string;
  fromAgent: string;
  toAgent: string;
  task: string;
  context?: Record<string, unknown>;
  status: 'active' | 'completed' | 'failed' | 'timeout';
  messages: AgentMessage[];
  summary?: string;
  response?: string;
  costUsd: number;
  durationMs: number;
  depth: number;
  parentConversationId?: string;
  startedAt: Date;
  completedAt?: Date;
}

const MAX_DELEGATION_DEPTH = 3;
const DELEGATION_TIMEOUT_MS = 120_000;

export class AgentConversationService {
  constructor(private db: Db) {}

  private get col() { return this.db.collection('agent_conversations'); }

  /**
   * Create a new agent conversation record.
   */
  async create(params: {
    chatSessionId: string;
    parentMessageId: string;
    fromAgent: string;
    toAgent: string;
    task: string;
    context?: Record<string, unknown>;
    depth: number;
    parentConversationId?: string;
  }): Promise<AgentConversation> {
    const doc: AgentConversation = {
      chatSessionId: params.chatSessionId,
      parentMessageId: params.parentMessageId,
      fromAgent: params.fromAgent,
      toAgent: params.toAgent,
      task: params.task,
      context: params.context,
      status: 'active',
      messages: [],
      costUsd: 0,
      durationMs: 0,
      depth: params.depth,
      parentConversationId: params.parentConversationId,
      startedAt: new Date(),
    };
    const result = await this.col.insertOne(doc);
    return { ...doc, _id: result.insertedId };
  }

  /**
   * Add a message to a conversation.
   */
  async addMessage(conversationId: string, message: AgentMessage): Promise<void> {
    const { ObjectId } = await import('mongodb');
    await this.col.updateOne(
      { _id: new ObjectId(conversationId) },
      { $push: { messages: message as any } },
    );
  }

  /**
   * Complete a conversation with response and summary.
   */
  async complete(conversationId: string, response: string, summary: string, costUsd: number): Promise<void> {
    const { ObjectId } = await import('mongodb');
    const doc = await this.col.findOne({ _id: new ObjectId(conversationId) });
    const durationMs = doc ? Date.now() - new Date(doc.startedAt).getTime() : 0;

    await this.col.updateOne(
      { _id: new ObjectId(conversationId) },
      {
        $set: {
          status: 'completed',
          response,
          summary,
          costUsd,
          durationMs,
          completedAt: new Date(),
        },
      },
    );
  }

  /**
   * Mark a conversation as failed.
   */
  async fail(conversationId: string, error: string): Promise<void> {
    const { ObjectId } = await import('mongodb');
    const doc = await this.col.findOne({ _id: new ObjectId(conversationId) });
    const durationMs = doc ? Date.now() - new Date(doc.startedAt).getTime() : 0;

    await this.col.updateOne(
      { _id: new ObjectId(conversationId) },
      {
        $set: {
          status: 'failed',
          summary: `Failed: ${error}`,
          durationMs,
          completedAt: new Date(),
        },
      },
    );
  }

  /**
   * Get conversations for a chat session.
   */
  async forSession(chatSessionId: string): Promise<AgentConversation[]> {
    return this.col
      .find({ chatSessionId })
      .sort({ startedAt: -1 })
      .limit(50)
      .toArray() as Promise<AgentConversation[]>;
  }

  /**
   * Check if delegation depth is within limits.
   */
  canDelegate(currentDepth: number): boolean {
    return currentDepth < MAX_DELEGATION_DEPTH;
  }

  get maxDepth(): number { return MAX_DELEGATION_DEPTH; }
  get timeoutMs(): number { return DELEGATION_TIMEOUT_MS; }
}
