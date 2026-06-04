/**
 * Agent Activity Service — running log of intermediate events from
 * spawned-agent executions and historical agent conversation records.
 *
 * Today the chat-tools `emit()` / `onEvent()` path broadcasts live
 * spawned-agent activity to the chat SSE stream but never persists it.
 * Consequence: the main chat's `wait_for_execution` tools see only a
 * bare status; refreshing the UI during a long run loses the visible
 * progress. This service is the persistence layer that closes both gaps
 * — it's written every time
 * an agent emits an event and read by (a) the wait tools for their
 * `recent_activity` payload and (b) the UI replay routes.
 *
 * Schema:
 *   scope:         'execution' (ref = executions.id)
 *   refId:         the id the consumer indexes by
 *   chatSessionId: for session-scoped cleanup / UI listing
 *   agent:         the agent that produced the event
 *   type:          'text' | 'thinking' | 'tool_call' | 'tool_result'
 *   tool, content, toolUseId, durationMs — type-specific fields
 *
 * Content cap — text/thinking are truncated to 200 chars, tool_call
 * summaries to 100 chars. Prevents a runaway agent from filling the
 * collection with huge prompts.
 *
 * TTL — 7 days via `timestamp` TTL index (see database/indexes.ts). The
 * final response is still persisted in agent_conversations.messages[] or
 * the execution trace, so expiring activity is purely about bounding
 * live-event logs.
 */

import type { Collection, Db, ObjectId } from 'mongodb';

export type ActivityScope = 'execution';
export type ActivityType = 'text' | 'thinking' | 'tool_call' | 'tool_result';

// Per-row content caps. TEXT_CAP covers `text` and `thinking` rows; the
// UI's LiveFeed truncates further for display (80–100 chars) but the
// refresh-replay needs enough context to reconstruct what the agent was
// saying. TOOL_ARG_CAP is tighter — tool summaries tend to be short.
const TEXT_CAP = 1000;
const TOOL_ARG_CAP = 200;

export interface AgentActivityEvent {
  _id?: ObjectId;
  scope: ActivityScope;
  refId: string;
  chatSessionId?: string;
  agent: string;
  type: ActivityType;
  tool?: string;
  content?: string;
  toolUseId?: string;
  durationMs?: number;
  timestamp: Date;
}

/** Persisted shape returned by the read APIs. Matches what the UI and
 *  the main-agent wait tools consume. */
export interface PersistedActivityRow {
  id: string;
  scope: ActivityScope;
  refId: string;
  agent: string;
  type: ActivityType;
  tool?: string;
  content?: string;
  toolUseId?: string;
  durationMs?: number;
  at: string; // ISO timestamp (client-friendly)
}

function trimTo(str: string | undefined, max: number): string | undefined {
  if (typeof str !== 'string') return undefined;
  return str.length > max ? str.slice(0, max) : str;
}

export class AgentActivityService {
  private col: Collection<AgentActivityEvent>;

  constructor(private db: Db) {
    this.col = db.collection<AgentActivityEvent>('agent_activity');
  }

  /**
   * Persist one event. Called from `chat-tools.ts` at every `emit()` site.
   * Best-effort — caller does NOT await, so a Mongo hiccup never stalls
   * the spawn activity stream. Errors are swallowed + logged.
   */
  record(event: Omit<AgentActivityEvent, '_id' | 'timestamp'> & { timestamp?: Date }): Promise<void> {
    const doc: AgentActivityEvent = {
      scope: event.scope,
      refId: event.refId,
      chatSessionId: event.chatSessionId,
      agent: event.agent,
      type: event.type,
      tool: event.tool,
      content: event.type === 'tool_call' || event.type === 'tool_result'
        ? trimTo(event.content, TOOL_ARG_CAP)
        : trimTo(event.content, TEXT_CAP),
      toolUseId: event.toolUseId,
      durationMs: event.durationMs,
      timestamp: event.timestamp ?? new Date(),
    };
    return this.col.insertOne(doc)
      .then(() => undefined)
      .catch((err: unknown) => {
        // Never let a persistence hiccup interrupt the spawn activity stream.
        console.warn(`[agent-activity] persist failed (${doc.scope} ${doc.refId}):`, (err as Error).message);
      });
  }

  /**
   * Read recent events for a ref. Used by `wait_for_execution` and
   * `wait_for_execution` to return the last N events since a cursor, and
   * by the refresh-replay HTTP route.
   *
   * Results ordered oldest → newest so the UI can append in natural order.
   */
  async recent(refId: string, opts: { since?: Date; limit?: number } = {}): Promise<PersistedActivityRow[]> {
    const query: Record<string, unknown> = { refId };
    if (opts.since) {
      query.timestamp = { $gt: opts.since };
    }
    const limit = Math.max(1, Math.min(opts.limit ?? 10, 500));
    // Pull the latest N newest-first, then reverse so the caller gets
    // chronological order. Saves a collection-scan for wide windows.
    const docs = await this.col
      .find(query)
      .sort({ timestamp: -1 })
      .limit(limit)
      .toArray();
    docs.reverse();
    return docs.map(this.toRow);
  }

  /**
   * List every persisted event for a ref (paginated). Used by the UI
   * route that seeds the thread/node panel on page refresh. Ordered
   * chronologically.
   */
  async listForRef(
    refId: string,
    opts: { since?: Date; limit?: number; skip?: number } = {},
  ): Promise<PersistedActivityRow[]> {
    const query: Record<string, unknown> = { refId };
    if (opts.since) {
      query.timestamp = { $gt: opts.since };
    }
    const limit = Math.max(1, Math.min(opts.limit ?? 500, 2000));
    const skip = Math.max(0, opts.skip ?? 0);
    const docs = await this.col
      .find(query)
      .sort({ timestamp: 1 })
      .skip(skip)
      .limit(limit)
      .toArray();
    return docs.map(this.toRow);
  }

  private toRow = (d: AgentActivityEvent): PersistedActivityRow => ({
    id: d._id ? d._id.toHexString() : '',
    scope: d.scope,
    refId: d.refId,
    agent: d.agent,
    type: d.type,
    tool: d.tool,
    content: d.content,
    toolUseId: d.toolUseId,
    durationMs: d.durationMs,
    at: d.timestamp.toISOString(),
  });
}
