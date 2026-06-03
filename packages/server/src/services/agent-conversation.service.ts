/**
 * Agent Conversation Service
 * Manages bidirectional agent-to-agent conversations.
 * Each pair of agents gets ONE conversation thread — all back-and-forth happens inside it.
 */

import type { Db, ObjectId } from 'mongodb';

export interface AgentMessage {
  agent: string;
  type: 'message' | 'question' | 'answer' | 'status';
  content: string;
  toolCalls?: { tool: string; args: Record<string, unknown>; result?: Record<string, unknown>; durationMs?: number }[];
  timestamp: Date;
}

export interface PendingQuestion {
  fromAgent: string;
  question: string;
  status: 'pending' | 'answered';
  answer?: string;
  askedAt: Date;
  answeredAt?: Date;
}

export interface AgentConversation {
  _id?: ObjectId;
  chatSessionId: string;
  parentMessageId: string;
  /**
   * Every assistant message that issued or continued this historical conversation, in order.
   * Populated on create and via $addToSet on every continue, so the UI can
   * render the thread card under each turn that touched it instead of only
   * the original anchor. Legacy rows have just `parentMessageId`.
   */
  parentMessageIds?: string[];
  fromAgent: string;
  toAgent: string;
  task: string;
  context?: Record<string, unknown>;
  status: 'active' | 'waiting_for_answer' | 'completed' | 'failed';
  messages: AgentMessage[];
  summary?: string;
  response?: string;
  /** CLI session/thread IDs for BOTH agents (for resume) */
  sessions: Record<string, string>;
  /** Pending question from target agent to caller */
  pendingQuestion?: PendingQuestion;
  costUsd: number;
  durationMs: number;
  turnCount: number;
  depth: number;
  parentConversationId?: string;
  startedAt: Date;
  completedAt?: Date;
}

export class AgentConversationService {
  constructor(private db: Db) {}

  private get col() { return this.db.collection('agent_conversations'); }

  private async oid(id: string) {
    const { ObjectId } = await import('mongodb');
    return new ObjectId(id);
  }

  /**
   * Find an active or waiting_for_answer conversation between two agents in a session.
   * Returns null if no active conversation exists.
   */
  async findActiveConversation(chatSessionId: string, fromAgent: string, toAgent: string): Promise<AgentConversation | null> {
    return this.col.findOne({
      chatSessionId,
      fromAgent,
      toAgent,
      status: { $in: ['active', 'waiting_for_answer'] },
    }) as Promise<AgentConversation | null>;
  }

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
      parentMessageIds: [params.parentMessageId],
      fromAgent: params.fromAgent,
      toAgent: params.toAgent,
      task: params.task,
      context: params.context,
      status: 'active',
      messages: [],
      sessions: {},
      costUsd: 0,
      durationMs: 0,
      turnCount: 0,
      depth: params.depth,
      parentConversationId: params.parentConversationId,
      startedAt: new Date(),
    };
    const result = await this.col.insertOne(doc);
    return { ...doc, _id: result.insertedId };
  }

  async get(conversationId: string): Promise<AgentConversation | null> {
    return this.col.findOne({ _id: await this.oid(conversationId) }) as Promise<AgentConversation | null>;
  }

  /**
   * Reset a completed/failed conversation back to `active` for a continuation turn.
   * Clears the prior turn's terminal fields (response/summary/cost/duration) so
   * status checks can't short-circuit on stale data, and anchors the thread
   * to the current assistant message via parentMessageIds.
   */
  async markContinuation(conversationId: string, parentMessageId: string): Promise<void> {
    await this.col.updateOne(
      { _id: await this.oid(conversationId) },
      {
        $set: { status: 'active' },
        $unset: { response: '', summary: '', completedAt: '' },
        $addToSet: { parentMessageIds: parentMessageId },
      },
    );
  }

  async addMessage(conversationId: string, message: AgentMessage): Promise<void> {
    await this.col.updateOne(
      { _id: await this.oid(conversationId) },
      { $push: { messages: message as any }, $inc: { turnCount: 1 } },
    );
  }

  async saveSessionId(conversationId: string, agentName: string, sessionId: string): Promise<void> {
    await this.col.updateOne(
      { _id: await this.oid(conversationId) },
      { $set: { [`sessions.${agentName}`]: sessionId } },
    );
  }

  async addCost(conversationId: string, costUsd: number): Promise<void> {
    await this.col.updateOne(
      { _id: await this.oid(conversationId) },
      { $inc: { costUsd } },
    );
  }

  /**
   * Target agent asks a question to the caller. Conversation pauses.
   */
  async askQuestion(conversationId: string, fromAgent: string, question: string): Promise<void> {
    await this.col.updateOne(
      { _id: await this.oid(conversationId) },
      {
        $set: {
          status: 'waiting_for_answer',
          pendingQuestion: {
            fromAgent,
            question,
            status: 'pending',
            askedAt: new Date(),
          },
        },
        $push: {
          messages: {
            agent: fromAgent,
            type: 'question',
            content: question,
            timestamp: new Date(),
          } as any,
        },
        $inc: { turnCount: 1 },
      },
    );
  }

  /**
   * Caller answers the pending question. Conversation resumes.
   */
  async answerQuestion(conversationId: string, fromAgent: string, answer: string): Promise<void> {
    await this.col.updateOne(
      { _id: await this.oid(conversationId) },
      {
        $set: {
          status: 'active',
          'pendingQuestion.status': 'answered',
          'pendingQuestion.answer': answer,
          'pendingQuestion.answeredAt': new Date(),
        },
        $push: {
          messages: {
            agent: fromAgent,
            type: 'answer',
            content: answer,
            timestamp: new Date(),
          } as any,
        },
        $inc: { turnCount: 1 },
      },
    );
  }

  /**
   * Check if a pending question has been answered.
   */
  async isQuestionAnswered(conversationId: string): Promise<{ answered: boolean; answer?: string }> {
    const conv = await this.get(conversationId);
    if (!conv?.pendingQuestion) return { answered: false };
    if (conv.pendingQuestion.status === 'answered') {
      return { answered: true, answer: conv.pendingQuestion.answer };
    }
    return { answered: false };
  }

  async complete(conversationId: string, response: string, summary: string, costUsd: number): Promise<void> {
    const doc = await this.col.findOne({ _id: await this.oid(conversationId) });
    const durationMs = doc ? Date.now() - new Date(doc.startedAt).getTime() : 0;
    await this.col.updateOne(
      { _id: await this.oid(conversationId) },
      { $set: { status: 'completed', response, summary, costUsd, durationMs, pendingQuestion: null, completedAt: new Date() } },
    );
  }

  async fail(conversationId: string, error: string): Promise<void> {
    const doc = await this.col.findOne({ _id: await this.oid(conversationId) });
    const durationMs = doc ? Date.now() - new Date(doc.startedAt).getTime() : 0;
    await this.col.updateOne(
      { _id: await this.oid(conversationId) },
      { $set: { status: 'failed', summary: `Failed: ${error}`, durationMs, pendingQuestion: null, completedAt: new Date() } },
    );
  }

  async forSession(chatSessionId: string): Promise<AgentConversation[]> {
    return this.col.find({ chatSessionId }).sort({ startedAt: -1 }).limit(50).toArray() as Promise<AgentConversation[]>;
  }
}
