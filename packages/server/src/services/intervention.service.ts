/**
 * Intervention Service
 *
 * Owns the `workflow_interventions` collection. Every human pause in
 * any workflow (feature, bug, or existing coding-workflow via the
 * engine hook) becomes an intervention record. The service has three
 * core responsibilities:
 *
 *   1. `create()` — called when a workflow pauses. Writes the
 *      intervention, dispatches a chat card (future), fires a Slack
 *      notification via SlackNotifier. Returns the intervention ID.
 *   2. `respond()` — called when the user answers. Persists the
 *      response, triggers the correct next action (advance, loop-back
 *      with feedback, abandon), and proxies to the existing
 *      submit_execution_input endpoint for loop-back retries so the
 *      engine's retry-with-feedback machinery handles session resume.
 *   3. `list()` / `get()` — read paths powering the Interventions
 *      page and the execution-page sidebar.
 *
 * The service does NOT render cards itself — that's the
 * SlackNotifier's job for Slack, and the UI's job for chat/page.
 * The service just owns the envelope shape and the workflow
 * transitions.
 */

import type { Collection, Db, ObjectId } from 'mongodb';
import { randomUUID } from 'node:crypto';
import { SlackNotifier, type InterventionCardInput } from './slack-notifier.js';

// ── Types ────────────────────────────────────────────────────────────────

export type InterventionSeverity = 'question' | 'approval' | 'escalation';

export type InterventionStatus = 'pending' | 'answered' | 'expired' | 'skipped';

export type InterventionDecision =
  | 'approve'
  | 'request_changes'
  | 'reject'
  | 'answer';

export type InterventionScope =
  | 'requirements'
  | 'architecture'
  | 'technical_design'
  | 'all'
  | null;

export interface InterventionOption {
  label: string;
  value: string;
  primary?: boolean;
  destructive?: boolean;
}

export interface InterventionDocLink {
  label: string;
  url: string;
  kind?: 'prd' | 'hla' | 'tdd' | 'pr' | 'diff' | 'logs' | 'summary' | 'external';
}

/**
 * Field definition carried from the human node's `fields` config. The UI
 * uses this to render the form dynamically, and the respond handler uses
 * the field names to build the submitInput payload so state keys match
 * whatever the workflow YAML declared.
 */
export interface InterventionField {
  name: string;
  label?: string;
  type?: 'text' | 'textarea' | 'select' | string;
  required?: boolean;
  options?: string[];
  placeholder?: string;
}

export interface InterventionDoc {
  _id?: ObjectId;
  intervention_id: string;
  workflow_run_id: string;
  workflow_name: string;
  chat_session_id?: string;
  started_by_user_id?: string;
  started_by_user_email?: string;
  stage: string;
  severity: InterventionSeverity;
  title: string;
  context_summary: string;
  question: string;
  options: InterventionOption[];
  fields: InterventionField[];
  docs: InterventionDocLink[];
  round_info?: { current: number; max: number };
  user_request?: string;
  deadline?: Date;
  status: InterventionStatus;
  response?: {
    decision: InterventionDecision;
    feedback?: string;
    scope?: InterventionScope;
    answer?: string;
  };
  retry_triggered?: {
    target_node: string;
    retry_attempt: number;
    retry_source: string;
  };
  answered_at?: Date;
  answered_by_user_id?: string;
  slack_delivery?: {
    dm_sent: boolean;
    channel_sent: boolean;
    errors: string[];
  };
  created_at: Date;
}

export interface CreateInterventionInput {
  workflow_run_id: string;
  workflow_name: string;
  chat_session_id?: string;
  started_by_user_id?: string;
  started_by_user_email?: string;
  stage: string;
  severity: InterventionSeverity;
  title: string;
  context_summary: string;
  question: string;
  options: InterventionOption[];
  fields?: InterventionField[];
  docs?: InterventionDocLink[];
  round_info?: { current: number; max: number };
  user_request?: string;
  deadline?: Date;
}

// ── Service ──────────────────────────────────────────────────────────────

export class InterventionService {
  private col: Collection;
  private notifier: SlackNotifier;

  constructor(db: Db) {
    this.col = db.collection('workflow_interventions');
    this.notifier = new SlackNotifier(db);
  }

  /**
   * Create a new intervention record and dispatch notifications.
   * Returns the intervention ID (not the Mongo _id) for use in
   * external links and Slack messages.
   */
  async create(input: CreateInterventionInput): Promise<InterventionDoc> {
    const intervention_id = this.generateInterventionId();
    const now = new Date();
    const doc: InterventionDoc = {
      intervention_id,
      workflow_run_id: input.workflow_run_id,
      workflow_name: input.workflow_name,
      chat_session_id: input.chat_session_id,
      started_by_user_id: input.started_by_user_id,
      started_by_user_email: input.started_by_user_email,
      stage: input.stage,
      severity: input.severity,
      title: input.title,
      context_summary: input.context_summary,
      question: input.question,
      options: input.options,
      fields: input.fields ?? [],
      docs: input.docs ?? [],
      round_info: input.round_info,
      user_request: input.user_request,
      deadline: input.deadline,
      status: 'pending',
      created_at: now,
    };

    const result = await this.col.insertOne(doc);
    doc._id = result.insertedId;

    // Fire Slack notification asynchronously — we don't block the
    // intervention creation on Slack being reachable.
    this.dispatchSlack(doc).catch(err => {
      console.error('[intervention] slack dispatch failed:', err);
    });

    return doc;
  }

  /**
   * Record a response to an intervention. The caller is expected to
   * have already triggered any downstream workflow action (loop-back
   * retry, advance, etc.) — this method just persists the response
   * and optional retry metadata onto the record.
   *
   * The actual loop-back mechanics live in the route handler (or a
   * caller that knows the workflow context), because the intervention
   * service intentionally doesn't depend on the execution service to
   * avoid a dependency cycle.
   */
  async recordResponse(
    intervention_id: string,
    input: {
      decision: InterventionDecision;
      feedback?: string;
      scope?: InterventionScope;
      answer?: string;
      answered_by_user_id?: string;
      retry_triggered?: { target_node: string; retry_attempt: number; retry_source: string };
    },
  ): Promise<InterventionDoc> {
    const existing = (await this.col.findOne({ intervention_id })) as InterventionDoc | null;
    if (!existing) throw new Error(`Intervention ${intervention_id} not found`);
    if (existing.status !== 'pending') {
      throw new Error(
        `Intervention ${intervention_id} is already ${existing.status} (answered by ${existing.answered_by_user_id ?? 'unknown'})`,
      );
    }

    const update: Record<string, unknown> = {
      status: 'answered',
      response: {
        decision: input.decision,
        feedback: input.feedback,
        scope: input.scope,
        answer: input.answer,
      },
      answered_at: new Date(),
      answered_by_user_id: input.answered_by_user_id,
    };
    if (input.retry_triggered) update.retry_triggered = input.retry_triggered;

    await this.col.updateOne({ intervention_id }, { $set: update });
    return { ...existing, ...(update as Partial<InterventionDoc>) };
  }

  async get(intervention_id: string): Promise<InterventionDoc | null> {
    return this.col.findOne({ intervention_id }) as Promise<InterventionDoc | null>;
  }

  /**
   * List interventions with optional filters. Powers the Interventions
   * list page. Most filters are optional; sort is always newest first.
   */
  async list(filter: {
    status?: InterventionStatus;
    workflow_run_id?: string;
    started_by_user_id?: string;
    workflow_name?: string;
    severity?: InterventionSeverity;
    limit?: number;
  } = {}): Promise<InterventionDoc[]> {
    const query: Record<string, unknown> = {};
    if (filter.status) query.status = filter.status;
    if (filter.workflow_run_id) query.workflow_run_id = filter.workflow_run_id;
    if (filter.started_by_user_id) query.started_by_user_id = filter.started_by_user_id;
    if (filter.workflow_name) query.workflow_name = filter.workflow_name;
    if (filter.severity) query.severity = filter.severity;
    return this.col
      .find(query)
      .sort({ created_at: -1 })
      .limit(filter.limit ?? 100)
      .toArray() as Promise<InterventionDoc[]>;
  }

  /**
   * List all interventions for one workflow run, chronologically.
   * Used by the workflow execution page sidebar.
   */
  async listForWorkflowRun(workflow_run_id: string): Promise<InterventionDoc[]> {
    return this.col
      .find({ workflow_run_id })
      .sort({ created_at: 1 })
      .toArray() as Promise<InterventionDoc[]>;
  }

  /**
   * Mark all pending interventions for a run as `skipped` except the given
   * intervention_id. Used when the engine moves past a human pause without
   * the user answering the matching intervention (e.g. the dialog was used
   * but an older loop-iteration intervention is still sitting as pending).
   * Returns the count of interventions skipped.
   */
  async skipStalePending(
    workflow_run_id: string,
    keep_intervention_id?: string,
    stage?: string,
  ): Promise<number> {
    const query: Record<string, unknown> = {
      workflow_run_id,
      status: 'pending',
    };
    if (keep_intervention_id) query.intervention_id = { $ne: keep_intervention_id };
    if (stage) query.stage = stage;
    const result = await this.col.updateMany(query, {
      $set: {
        status: 'skipped',
        answered_at: new Date(),
        answered_by_user_id: 'system:engine-advanced',
      },
    });
    return result.modifiedCount ?? 0;
  }

  // ── Helpers ────────────────────────────────────────────────────────────

  private generateInterventionId(): string {
    // Short human-readable ID, e.g. "INT-abc123".
    return `INT-${randomUUID().slice(0, 8)}`;
  }

  private async dispatchSlack(doc: InterventionDoc): Promise<void> {
    const appBaseUrl = process.env.ALLEN_APP_BASE_URL ?? undefined;
    const cardInput: InterventionCardInput = {
      intervention_id: doc.intervention_id,
      workflow_run_id: doc.workflow_run_id,
      workflow_name: doc.workflow_name,
      stage: doc.stage,
      severity: doc.severity,
      title: doc.title,
      context_summary: doc.context_summary,
      question: doc.question,
      options: doc.options,
      docs: doc.docs,
      round_info: doc.round_info,
      user_request: doc.user_request,
    };
    const delivery = await this.notifier.deliver(cardInput, {
      recipientUserEmail: doc.started_by_user_email,
      appBaseUrl,
    });
    // Persist delivery result for audit.
    await this.col.updateOne(
      { intervention_id: doc.intervention_id },
      { $set: { slack_delivery: delivery } },
    );
  }
}
