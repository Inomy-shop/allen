/**
 * Deterministic Execution Watcher Service
 *
 * Automatically monitors chat-started or chat-resumed workflow and agent
 * executions, keeps one latest watcher status line per watched execution,
 * and invisibly triggers the correct Assistant when the execution completes,
 * fails, is cancelled, or waits for input.
 *
 * @see PRD  — Deterministic Execution Watcher
 * @see TDD §1 — Data Models
 * @see TDD §3 — Sequence Diagrams
 */

import type { Db } from 'mongodb';
import { randomUUID } from 'node:crypto';
import { logger } from '../logger.js';
import type { ChatService } from './chat.service.js';

// ── Types ──────────────────────────────────────────────────────────────────

export interface ExecutionWatcherDoc {
  watcherId: string;
  executionId: string;
  chatSessionId: string;
  originatingMessageId: string | null;
  userId: string | null;
  executionType: 'workflow' | 'agent' | 'lead';
  rootExecutionId: string | null;
  watcherStatus: 'active' | 'waiting' | 'resolved' | 'replaced';
  executionState: 'running' | 'waiting_for_input' | 'completed' | 'failed' | 'cancelled';
  triggerSentForState: string | null;
  latestStatusText: string;
  nextPollAt: Date;
  lastPolledAt: Date;
  lastCheckedAt: Date;
  slackTeamId: string | null;
  slackChannelId: string | null;
  slackThreadTs: string | null;
  updateSeq: number;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Shape returned to the UI — a subset of ExecutionWatcherDoc.
 */
export interface WatcherUIDoc {
  watcherId: string;
  executionId: string;
  executionType: 'workflow' | 'agent' | 'lead';
  watcherStatus: 'active' | 'waiting' | 'resolved' | 'replaced';
  executionState: 'running' | 'waiting_for_input' | 'completed' | 'failed' | 'cancelled';
  triggerSentForState: string | null;
  latestStatusText: string;
  lastCheckedAt: string; // ISO8601
  updateSeq: number;
}

/**
 * Payload accepted by POST /api/chat/sessions/:id/watcher-trigger.
 */
export interface WatcherTriggerPayload {
  executionId: string;
  triggerType: 'watcher_completed' | 'watcher_failed' | 'watcher_cancelled' | 'watcher_waiting_for_input';
  triggerContext: WatcherTriggerContext;
}

/**
 * Compact structured context payload delivered to the Assistant via a hidden
 * chat message when a terminal / waiting-for-input state is reached.
 */
export interface WatcherTriggerContext {
  executionId: string;
  executionType: 'workflow' | 'agent' | 'lead';
  workflowName: string | null;
  agentName: string | null;
  currentNode: string | null;
  status: string;
  recentMilestones: string[];
  relevantArtifactUrls: string[];
  finalResponse: string | null;
  errorMessage: string | null;
  inputRequest: string | null;
  validNextActions: string[];
}

// ── Milestone Vocabulary ────────────────────────────────────────────────────
// Per PRD §7 and TDD §1.3. Used as a lookup table against log content.

export const KNOWN_MILESTONES = new Set([
  'context_loaded', 'workspace_created',
  'investigation_started', 'investigation_completed',
  'severity_classified', 'approval_requested',
  'planning_started', 'planning_completed',
  'design_ready', 'ux_research_completed',
  'design_options_ready', 'foundations_copied',
  'prototype_started', 'prototype_completed',
  'implementation_started', 'implementation_completed',
  'qa_started', 'qa_completed',
  'validation_started', 'validation_completed',
  'review_started', 'review_completed',
  'docs_updated', 'artifact_created',
  'pr_created', 'summary_ready',
  'milestone_planned', 'milestone_started',
  'milestone_completed', 'milestone_blocked',
  'waiting_for_input', 'blocked',
  'failed', 'cancelled', 'completed',
  'escalation_required',
]);

// ── Polling Interval Policy ─────────────────────────────────────────────────
// Per AC5: 1 min for first 10 min, 5 min for 10–60 min, 10 min after 60 min.

export function intervalForDuration(durationMs: number): number {
  const minutes = durationMs / 60_000;
  if (minutes < 10) return 60_000;      // <10 min → 1 min
  if (minutes <= 60) return 300_000;     // 10–60 min → 5 min
  return 600_000;                         // >60 min → 10 min
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function now(): Date {
  return new Date();
}

function timeAgo(date: Date): string {
  const diffMs = now().getTime() - date.getTime();
  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 2) return '1 min ago';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 2) return '1 hour ago';
  return `${hours} hours ago`;
}

// ── Status Text Generation ──────────────────────────────────────────────────
// TDD §3.2 — deterministic templates, R8 guard enforced.

export interface StatusTextInput {
  execStatus: string;
  workflowName?: string | null;
  agentDisplayName?: string | null;
  currentNodes?: string[];
  completedNodes?: string[];
  recentLogs?: { message?: string; node?: string; type?: string }[];
  childExecs?: { status: string; agentName?: string; displayName?: string }[];
  lastCheckedAt?: Date;
}

export function generateStatusText(input: StatusTextInput): string {
  const { execStatus, workflowName, agentDisplayName, currentNodes, completedNodes, recentLogs, childExecs, lastCheckedAt } = input;
  const checked = lastCheckedAt ? `Last checked ${timeAgo(lastCheckedAt)}.` : '';

  // Check for milestone terms in recent logs
  // Sort candidates by length descending so more specific milestones
  // (e.g. "qa_completed") are preferred over general ones (e.g. "completed").
  const foundMilestones: string[] = [];
  if (recentLogs) {
    for (const log of recentLogs) {
      const text = log.message ?? log.node ?? '';
      for (const milestone of KNOWN_MILESTONES) {
        if (text.includes(milestone)) {
          foundMilestones.push(milestone);
        }
      }
    }
  }
  // Deduplicate and sort by length descending so "qa_completed" wins over "completed"
  const uniqueMilestones = [...new Set(foundMilestones)].sort((a, b) => b.length - a.length);

  // R8 guard: never say "completed"/"passed" unless status is literally 'completed'
  // never say "failed" unless status is 'failed'

  // ── Terminal states ──────────────────────────────────────────────────
  if (execStatus === 'completed') {
    const label = workflowName ?? agentDisplayName ?? 'Execution';
    return `${label} completed. ${checked}`;
  }

  if (execStatus === 'failed') {
    const label = workflowName ?? agentDisplayName ?? 'Execution';
    return `${label} failed. ${checked}`;
  }

  if (execStatus === 'cancelled') {
    const label = workflowName ?? agentDisplayName ?? 'Execution';
    return `${label} cancelled. ${checked}`;
  }

  // ── Waiting for input ────────────────────────────────────────────────
  if (execStatus === 'waiting_for_input') {
    const label = workflowName ?? agentDisplayName ?? 'Execution';
    return `${label} is waiting for input. ${checked}`;
  }

  // ── Milestone-driven ─────────────────────────────────────────────────
  if (uniqueMilestones.length > 0) {
    const label = workflowName ?? agentDisplayName ?? 'Execution';
    // Show the most specific milestone (shortest = most generic filtered out by sort)
    const lastMilestone = uniqueMilestones[0];
    const milestoneLabel = lastMilestone.replace(/_/g, ' ');
    const humanLabel = milestoneLabel.charAt(0).toUpperCase() + milestoneLabel.slice(1);
    return `${label}; latest: ${humanLabel}. ${checked}`;
  }

  // ── Completed child agents ────────────────────────────────────────────
  if (childExecs && childExecs.length > 0) {
    const completedChild = childExecs.find(c => c.status === 'completed');
    if (completedChild) {
      const childName = completedChild.displayName ?? completedChild.agentName ?? 'sub-task';
      const leadName = agentDisplayName ?? workflowName ?? 'Execution';
      return `${leadName} is running; ${childName} completed. ${checked}`;
    }
  }

  // ── Workflow progress ─────────────────────────────────────────────────
  if (workflowName && currentNodes && currentNodes.length > 0) {
    const current = currentNodes.join(', ');
    const completed = completedNodes && completedNodes.length > 0
      ? `completed ${completedNodes[completedNodes.length - 1]}`
      : 'started';
    return `${workflowName} ${completed} and is now running ${current}. ${checked}`;
  }

  // ── Agent progress ────────────────────────────────────────────────────
  if (agentDisplayName && currentNodes && currentNodes.includes(agentDisplayName)) {
    const activity = recentLogs && recentLogs.length > 0
      ? `latest activity: ${recentLogs[0].message ?? recentLogs[0].node ?? 'working'}`
      : 'running';
    return `${agentDisplayName} is ${activity}. ${checked}`;
  }

  // ── Fallback for agent running ────────────────────────────────────────
  if (agentDisplayName) {
    return `${agentDisplayName} is running. ${checked}`;
  }

  // ── Generic fallback ───────────────────────────────────────────────────
  const label = workflowName ?? 'Execution';
  return `${label} is ${execStatus}. ${checked}`;
}

// ── WatcherService ─────────────────────────────────────────────────────────

const COLLECTION = 'execution_watchers';

export class WatcherService {
  private db: Db;
  private chatService: ChatService;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private pollingInFlight = false;

  constructor(db: Db, chatService: ChatService) {
    this.db = db;
    this.chatService = chatService;
  }

  private get col() {
    return this.db.collection<ExecutionWatcherDoc>(COLLECTION);
  }

  // ── Registration ──────────────────────────────────────────────────────
  // TDD §2.6 — auto-register on execution start/resume

  async register(options: {
    executionId: string;
    chatSessionId: string;
    executionType: 'workflow' | 'agent' | 'lead';
    originatingMessageId?: string;
    userId?: string;
    rootExecutionId?: string;
    slackTeamId?: string;
    slackChannelId?: string;
    slackThreadTs?: string;
  }): Promise<{ watcherId: string; alreadyExisted: boolean }> {
    const { executionId, chatSessionId, executionType } = options;

    // Check if execution is already terminal — watcher would be resolved immediately
    const exec = await this.db.collection('executions').findOne(
      { id: executionId },
      { projection: { status: 1 } },
    );
    const execStatus = (exec?.status as string | undefined) ?? 'running';
    const isTerminal = ['completed', 'failed', 'cancelled'].includes(execStatus);
    const isWaiting = execStatus === 'waiting_for_input';

    // Idempotent: upsert by executionId
    // Check if a watcher already exists for this execution
    const existing = await this.col.findOne({ executionId });

    if (existing) {
      if (existing.watcherStatus === 'active' || existing.watcherStatus === 'waiting') {
        logger.info('[watcher] Already registered — skipping', {
          component: 'watcher',
          executionId,
          chatSessionId,
          existingStatus: existing.watcherStatus,
        });
        return { watcherId: existing.watcherId, alreadyExisted: true };
      }

      // Reuse the existing doc but reactivate it
      const watcherStatus = isTerminal ? 'resolved' : (isWaiting ? 'waiting' : 'active');
      const executionState = (execStatus as ExecutionWatcherDoc['executionState']) ?? 'running';
      const nowDate = now();
      const nextPollAt = new Date(nowDate.getTime() + intervalForDuration(0));

      await this.col.updateOne(
        { executionId },
        {
          $set: {
            watcherStatus,
            executionState,
            triggerSentForState: isTerminal ? null : existing.triggerSentForState,
            latestStatusText: generateStatusText({ execStatus: executionState }),
            nextPollAt,
            lastCheckedAt: nowDate,
            updateSeq: existing.updateSeq + 1,
            updatedAt: nowDate,
          },
        },
      );

      return { watcherId: existing.watcherId, alreadyExisted: true };
    }

    // Create new watcher
    const nowDate = now();
    const executionState = (execStatus as ExecutionWatcherDoc['executionState']) ?? 'running';
    const watcherStatus = isTerminal ? 'resolved' : (isWaiting ? 'waiting' : 'active');
    const watcherId = randomUUID();
    const nextPollAt = new Date(nowDate.getTime() + intervalForDuration(0));

    const doc: ExecutionWatcherDoc = {
      watcherId,
      executionId,
      chatSessionId,
      originatingMessageId: options.originatingMessageId ?? null,
      userId: options.userId ?? null,
      executionType,
      rootExecutionId: options.rootExecutionId ?? null,
      watcherStatus,
      executionState,
      triggerSentForState: null,
      latestStatusText: generateStatusText({ execStatus: executionState }),
      nextPollAt,
      lastPolledAt: nowDate,
      lastCheckedAt: nowDate,
      slackTeamId: options.slackTeamId ?? null,
      slackChannelId: options.slackChannelId ?? null,
      slackThreadTs: options.slackThreadTs ?? null,
      updateSeq: 0,
      createdAt: nowDate,
      updatedAt: nowDate,
    };

    await this.col.insertOne(doc);

    logger.info('[watcher] Registered', {
      component: 'watcher',
      executionId,
      chatSessionId,
      executionType,
      watcherStatus,
    });

    // If execution is already terminal or waiting, follow the same wake-up
    // ownership rule used by polling: wake only if the chat is idle; otherwise
    // the active Assistant turn owns the user update for this state.
    if ((isTerminal || isWaiting) && !options.rootExecutionId) {
      const triggerType = mapStateToTriggerType(executionState);
      if (this.chatService.isStreaming(chatSessionId)) {
        await this.col.updateOne(
          { executionId },
          {
            $set: {
              triggerSentForState: triggerType,
              updatedAt: now(),
            },
          },
        );
        logger.debug('[watcher] Trigger suppressed on register — Assistant streaming active', {
          component: 'watcher',
          executionId,
          reason: 'handled_by_active_assistant',
        });
      } else {
        setImmediate(() => {
          this.sendHiddenTrigger(doc, triggerType).catch((err) => {
            logger.warn('[watcher] trigger on register failed', {
              component: 'watcher',
              executionId,
              error: (err as Error).message,
            });
          });
        });
      }
    }

    return { watcherId, alreadyExisted: false };
  }

  // ── Reactivation ───────────────────────────────────────────────────────
  // Resume a watcher after an execution is resumed (from checkpoint, agent restart, etc.)

  async reactivate(executionId: string, resumePath: 'checkpoint' | 'agent' | 'engine'): Promise<void> {
    const existing = await this.col.findOne({ executionId });

    if (existing) {
      const nowDate = now();
      const nextPollAt = new Date(nowDate.getTime() + intervalForDuration(0));

      await this.col.updateOne(
        { executionId },
        {
          $set: {
            watcherStatus: 'active',
            triggerSentForState: null,
            nextPollAt,
            lastCheckedAt: nowDate,
            updatedAt: nowDate,
            updateSeq: existing.updateSeq + 1,
          },
        },
      );

      logger.info('[watcher] Reactivated', {
        component: 'watcher',
        executionId,
        resumePath,
      });
    } else {
      logger.warn('[watcher] No existing watcher to reactivate — falling back to register', {
        component: 'watcher',
        executionId,
        resumePath,
      });
      // Fallback: try register — we need the chatSessionId from the execution doc
      const exec = await this.db.collection('executions').findOne(
        { id: executionId },
        { projection: { 'meta.chatSessionId': 1 } },
      );
      const chatSessionId = (exec?.meta as Record<string, unknown> | undefined)?.chatSessionId as string | undefined;
      if (chatSessionId) {
        await this.register({ executionId, chatSessionId, executionType: 'agent' });
      }
    }
  }

  // ── Mark Replaced ──────────────────────────────────────────────────────

  async markReplaced(executionId: string): Promise<void> {
    const existing = await this.col.findOne({ executionId });
    if (!existing) return;

    await this.col.updateOne(
      { executionId },
      {
        $set: {
          watcherStatus: 'replaced',
          updatedAt: now(),
        },
      },
    );

    logger.info('[watcher] Replaced', {
      component: 'watcher',
      executionId,
    });
  }

  // ── Poll Watcher By ExecutionId ────────────────────────────────────────
  // Convenience helper for one-time poll of a specific execution (used by
  // chat-tools completion path so the terminal trigger fires promptly).

  async pollWatcherByExecutionId(executionId: string): Promise<void> {
    const watcher = await this.col.findOne({ executionId });
    if (!watcher) return;
    await this.pollOnce(watcher);
  }

  // ── Single Poll Cycle ──────────────────────────────────────────────────
  // TDD §3.1 — read execution state, logs, child execs; generate status;
  // broadcast update; handle terminal/waiting states.

  async pollOnce(watcherDoc: ExecutionWatcherDoc): Promise<void> {
    const { executionId, chatSessionId } = watcherDoc;
    const pollStart = Date.now();

    try {
      // 1. Read execution state
      const exec = await this.db.collection('executions').findOne(
        { id: executionId },
        {
          projection: {
            status: 1,
            currentNodes: 1,
            completedNodes: 1,
            failedNode: 1,
            errorMessage: 1,
            startedAt: 1,
            completedAt: 1,
            workflowName: 1,
            meta: 1,
            input: 1,
          },
        },
      );

      if (!exec) {
        // Execution deleted — resolve watcher
        await this.col.updateOne(
          { executionId },
          {
            $set: {
              watcherStatus: 'resolved',
              executionState: 'cancelled',
              latestStatusText: 'Execution record not found.',
              updatedAt: now(),
            },
          },
        );
        logger.warn('[watcher] Execution not found during poll', {
          component: 'watcher',
          executionId,
        });
        return;
      }

      const execStatus = (exec.status as string) ?? 'running';
      const executionState = mapStatusToExecutionState(execStatus);
      const currentNodes = (exec.currentNodes as string[]) ?? [];
      const completedNodes = (exec.completedNodes as string[]) ?? [];
      const workflowName = (exec.workflowName as string | undefined) ?? null;
      const errorMessage = (exec.errorMessage as string | null) ?? null;

      // 2. Read latest activity (last 5 execution_logs entries)
      const recentLogs = await this.db.collection('execution_logs')
        .find({ executionId })
        .sort({ timestamp: -1 })
        .limit(5)
        .toArray();

      const logsFormatted = recentLogs.map((l: Record<string, unknown>) => ({
        message: (l.message as string | undefined) ?? (l.content as string | undefined) ?? '',
        node: (l.node as string | undefined) ?? '',
        type: (l.type as string | undefined) ?? '',
      }));

      // 3. Read latest child executions
      const childExecs = await this.db.collection('executions')
        .find(
          { parentExecutionId: executionId },
          { projection: { status: 1, currentNodes: 1, workflowName: 1 } },
        )
        .sort({ startedAt: -1 })
        .limit(10)
        .toArray();

      const childExecsFormatted = childExecs.map((c: Record<string, unknown>) => ({
        status: (c.status as string) ?? 'unknown',
        agentName: ((c.currentNodes as string[] | undefined)?.[0]) ?? ((c.workflowName as string | undefined) ?? ''),
        displayName: ((c.currentNodes as string[] | undefined)?.[0]) ?? ((c.workflowName as string | undefined) ?? ''),
      }));

      // Resolve display name from agent / workflow
      const agentDisplayName = await this.resolveDisplayName(executionId, currentNodes, workflowName);

      // 4. Generate status text
      const nowDate = now();
      const statusText = generateStatusText({
        execStatus: executionState,
        workflowName,
        agentDisplayName,
        currentNodes,
        completedNodes,
        recentLogs: logsFormatted,
        childExecs: childExecsFormatted,
        lastCheckedAt: nowDate,
      });

      // 5. Determine next poll interval
      const durationMs = exec.startedAt
        ? nowDate.getTime() - (exec.startedAt as Date).getTime()
        : 0;
      const interval = intervalForDuration(durationMs);

      // 6. Determine watcher status based on execution state.
      // The watcher only wakes the Assistant when the chat is idle. If the
      // Assistant is already streaming when a user-facing state is observed,
      // that active turn owns the user update and we mark this state handled
      // instead of retrying a duplicate hidden trigger later.
      const isTriggerState = ['completed', 'failed', 'cancelled'].includes(executionState);
      const shouldWakeAssistant = ['completed', 'failed', 'cancelled', 'waiting_for_input'].includes(executionState);
      const wakeNeeded = shouldWakeAssistant && watcherDoc.triggerSentForState !== executionState;
      const streamingActive = wakeNeeded ? this.chatService.isStreaming(chatSessionId) : false;
      const handledByActiveAssistant = wakeNeeded && streamingActive;

      let watcherStatus = watcherDoc.watcherStatus;
      if (isTriggerState) {
        watcherStatus = 'resolved';
      } else if (executionState === 'waiting_for_input') {
        watcherStatus = 'waiting';
      } else if (watcherStatus === 'waiting' && executionState === 'running') {
        // Execution was waiting, now resumed
        watcherStatus = 'active';
        logger.info('[watcher] Resumed after input', {
          component: 'watcher',
          executionId,
        });
      }

      // 7. Update watcher doc
      const terminalState = ['completed', 'failed', 'cancelled'].includes(executionState);
      const nextPollAt = terminalState && watcherStatus === 'resolved'
        ? new Date(nowDate.getTime() + 86_400_000) // far future if terminal AND resolved
        : new Date(nowDate.getTime() + interval);

      const watcherSet: Partial<ExecutionWatcherDoc> = {
        executionState,
        watcherStatus,
        latestStatusText: statusText,
        nextPollAt,
        lastPolledAt: nowDate,
        lastCheckedAt: nowDate,
        updateSeq: watcherDoc.updateSeq + 1,
        updatedAt: nowDate,
      };
      if (handledByActiveAssistant) {
        watcherSet.triggerSentForState = executionState;
      }

      await this.col.updateOne(
        { executionId },
        {
          $set: watcherSet,
        },
      );

      // 8. Broadcast watcher_update via chat SSE
      const updatePayload = {
        executionId,
        chatSessionId,
        watcherStatus,
        latestStatusText: statusText,
        executionState,
        triggerSentForState: watcherSet.triggerSentForState ?? watcherDoc.triggerSentForState,
        lastCheckedAt: nowDate.toISOString(),
        updateSeq: watcherDoc.updateSeq + 1,
      };

      this.chatService.broadcastToSession(chatSessionId, 'watcher_update', updatePayload);

      // Also broadcast on the per-execution stream if available
      try {
        const { broadcastToExecution } = await import('./stream.service.js');
        broadcastToExecution(executionId, {
          event: 'watcher_update',
          data: updatePayload,
        });
      } catch {
        // stream.service not available — non-critical
      }

      logger.debug('[watcher] Polled', {
        component: 'watcher',
        executionId,
        status: executionState,
        pollIntervalMs: interval,
      });

      // 9. Handle terminal / waiting_for_input states — send hidden trigger.
      // streamingActive was already checked in step 6 to determine watcherStatus.
      const shouldTrigger = ['completed', 'failed', 'cancelled', 'waiting_for_input'].includes(executionState);
      const triggerKey = executionState;

      if (shouldTrigger && watcherDoc.triggerSentForState !== triggerKey) {
        if (streamingActive) {
          logger.debug('[watcher] Trigger suppressed — Assistant streaming active', {
            component: 'watcher',
            executionId,
            reason: 'handled_by_active_assistant',
          });
          // The active Assistant turn owns this user update. Marking
          // triggerSentForState above prevents a duplicate wake after it goes
          // idle, while still allowing a later different state to wake.
        } else {
          // Send the trigger
          const triggerType = mapStateToTriggerType(executionState);
          await this.sendHiddenTrigger(
            { ...watcherDoc, executionState: executionState as ExecutionWatcherDoc['executionState'] },
            triggerType,
          );

          const triggerUpdatePayload = {
            ...updatePayload,
            triggerSentForState: triggerType,
            updateSeq: watcherDoc.updateSeq + 2,
          };
          this.chatService.broadcastToSession(chatSessionId, 'watcher_update', triggerUpdatePayload);
          try {
            const { broadcastToExecution } = await import('./stream.service.js');
            broadcastToExecution(executionId, {
              event: 'watcher_update',
              data: triggerUpdatePayload,
            });
          } catch {
            // stream.service not available — non-critical
          }

          logger.info('[watcher] Trigger sent', {
            component: 'watcher',
            executionId,
            triggerType,
            chatSessionId,
          });
        }
      } else if (shouldTrigger && watcherDoc.triggerSentForState === triggerKey) {
        logger.debug('[watcher] Trigger suppressed — already sent for state', {
          component: 'watcher',
          executionId,
          reason: 'already_sent_for_state',
        });
      }
    } catch (err) {
      logger.warn('[watcher] Poll failed', {
        component: 'watcher',
        executionId,
        error: (err as Error).message,
      });
    }
  }

  // ── Hidden Trigger ────────────────────────────────────────────────────
  // TDD §2.3 — POST a hidden chat message that triggers the Assistant.

  async sendHiddenTrigger(
    watcherDoc: Pick<ExecutionWatcherDoc, 'executionId' | 'chatSessionId' | 'executionState' | 'triggerSentForState' | 'updateSeq' | 'executionType' | 'rootExecutionId'>,
    triggerType: 'completed' | 'failed' | 'cancelled' | 'waiting_for_input',
  ): Promise<void> {
    const { executionId, chatSessionId } = watcherDoc;

    // Idempotency via triggerSentForState
    if (watcherDoc.triggerSentForState === triggerType) {
      logger.debug('[watcher] Trigger already sent — idempotent skip', {
        component: 'watcher',
        executionId,
        triggerType,
      });
      return;
    }

    // Build trigger context from execution state
    const exec = await this.db.collection('executions').findOne(
      { id: executionId },
      {
        projection: {
          status: 1,
          workflowName: 1,
          currentNodes: 1,
          errorMessage: 1,
          input: 1,
          meta: 1,
        },
      },
    );

    const triggerContext: WatcherTriggerContext = {
      executionId,
      executionType: watcherDoc.executionType,
      workflowName: (exec?.workflowName as string | undefined) ?? null,
      agentName: ((exec?.currentNodes as string[] | undefined)?.[0]) ?? null,
      currentNode: ((exec?.currentNodes as string[] | undefined)?.[0]) ?? null,
      status: triggerType === 'waiting_for_input' ? 'waiting_for_input' : triggerType,
      recentMilestones: [],
      relevantArtifactUrls: [],
      finalResponse: null,
      errorMessage: (exec?.errorMessage as string | null) ?? null,
      inputRequest: null,
      validNextActions: this.getValidNextActions(triggerType),
    };

    // Attempt to extract final response for completed executions
    if (triggerType === 'completed') {
      try {
        const lastTrace = await this.db.collection('execution_traces')
          .find({ executionId })
          .sort({ completedAt: -1 })
          .limit(1)
          .toArray();
        if (lastTrace[0]?.output) {
          const output = lastTrace[0].output as Record<string, unknown>;
          triggerContext.finalResponse = (output.response as string | undefined) ?? null;
        }
      } catch {
        // Non-critical
      }
    }

    const watcherTriggerType = `watcher_${triggerType}` as const;

    // Call appendWatcherTrigger on the chat service
    try {
      await this.chatService.appendWatcherTrigger(
        chatSessionId,
        watcherTriggerType,
        triggerContext,
      );
    } catch (err) {
      // If session is not found or other error, just log
      logger.warn('[watcher] Trigger append failed', {
        component: 'watcher',
        executionId,
        chatSessionId,
        error: (err as Error).message,
      });
      return;
    }

    // Mark triggerSentForState on the watcher doc
    await this.col.updateOne(
      { executionId },
      {
        $set: {
          triggerSentForState: triggerType,
          updateSeq: watcherDoc.updateSeq + 2,
          updatedAt: now(),
        },
      },
    );
  }

  // ── Background Poller ──────────────────────────────────────────────────
  // TDD §3.1 — sweep every 30s

  startPoller(): void {
    if (this.pollTimer) return;

    this.pollTimer = setInterval(async () => {
      if (this.pollingInFlight) return;
      this.pollingInFlight = true;

      try {
        const nowDate = now();
        const watchers = await this.col
          .find({
            watcherStatus: { $in: ['active', 'waiting'] },
            nextPollAt: { $lte: nowDate },
          })
          .limit(200)
          .toArray();

        await Promise.all(
          watchers.map((w) =>
            this.pollOnce(w).catch((err) => {
              logger.warn('[watcher] Poll error per-watcher', {
                component: 'watcher',
                executionId: w.executionId,
                error: (err as Error).message,
              });
            }),
          ),
        );
      } catch (err) {
        logger.warn('[watcher] Poll sweep error', {
          component: 'watcher',
          error: (err as Error).message,
        });
      } finally {
        this.pollingInFlight = false;
      }
    }, 30_000);
  }

  stopPoller(): Promise<void> {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    return Promise.resolve();
  }

  // ── Boot-Time Reconciliation ───────────────────────────────────────────
  // TDD §1.4 — recover watchers after server restart.

  async runReconciliation(): Promise<void> {
    const watchers = await this.col
      .find({ watcherStatus: { $in: ['active', 'waiting'] } })
      .toArray();

    for (const watcher of watchers) {
      const { executionId } = watcher;

      try {
        const exec = await this.db.collection('executions').findOne(
          { id: executionId },
          { projection: { status: 1 } },
        );

        if (!exec) {
          // Orphan — execution gone
          await this.col.updateOne(
            { executionId },
            {
              $set: {
                watcherStatus: 'resolved',
                updatedAt: now(),
              },
            },
          );
          logger.warn('[watcher] Orphaned — execution not found during reconciliation', {
            component: 'watcher',
            executionId,
            watcherId: watcher.watcherId,
          });
          continue;
        }

        const execStatus = (exec.status as string) ?? 'running';

        if (['completed', 'failed', 'cancelled'].includes(execStatus)) {
          // Terminal state missed while server was down
          const executionState = mapStatusToExecutionState(execStatus);
          const triggerType = mapStateToTriggerType(executionState);

          await this.col.updateOne(
            { executionId },
            {
              $set: {
                executionState,
                watcherStatus: 'resolved',
                updatedAt: now(),
              },
            },
          );

          // Send trigger if not already sent
          if (watcher.triggerSentForState !== triggerType && triggerType !== 'waiting_for_input') {
            await this.sendHiddenTrigger(
              { ...watcher, executionState },
              triggerType,
            );
          }

          logger.info('[watcher] Reconciled terminal', {
            component: 'watcher',
            executionId,
            terminalState: execStatus,
          });
        } else {
          // Still running — recalc nextPollAt
          const nowDate = now();
          const durationMs = 0; // conservative — start from shortest interval
          const nextPollAt = new Date(nowDate.getTime() + intervalForDuration(durationMs));

          await this.col.updateOne(
            { executionId },
            {
              $set: {
                nextPollAt,
                lastCheckedAt: nowDate,
                updatedAt: nowDate,
              },
            },
          );

          logger.info('[watcher] Reconciled active', {
            component: 'watcher',
            executionId,
            executionState: execStatus,
            nextPollAt: nextPollAt.toISOString(),
          });
        }
      } catch (err) {
        logger.warn('[watcher] Reconciliation error per-watcher', {
          component: 'watcher',
          executionId,
          error: (err as Error).message,
        });
      }
    }
  }

  // ── Private helpers ────────────────────────────────────────────────────

  private async resolveDisplayName(
    executionId: string,
    currentNodes: string[],
    workflowName: string | null,
  ): Promise<string | null> {
    // For agent executions, try to resolve the agent's displayName
    if (currentNodes.length > 0 && currentNodes[0] && !workflowName) {
      try {
        const agent = await this.db.collection('agents').findOne(
          { name: currentNodes[0] },
          { projection: { displayName: 1, name: 1 } },
        );
        if (agent) return (agent.displayName as string | undefined) ?? (agent.name as string);
      } catch {
        // Non-critical
      }
    }
    return null;
  }

  private getValidNextActions(triggerType: string): string[] {
    switch (triggerType) {
      case 'completed':
        return ['view_execution_details', 'start_new_workflow'];
      case 'failed':
        return ['view_execution_details', 'retry_execution', 'start_new_workflow'];
      case 'cancelled':
        return ['view_execution_details', 'start_new_workflow'];
      case 'waiting_for_input':
        return ['provide_input', 'cancel_execution', 'view_execution_details'];
      default:
        return ['view_execution_details'];
    }
  }
}

// ── Module-level helpers ────────────────────────────────────────────────────

function mapStatusToExecutionState(status: string): ExecutionWatcherDoc['executionState'] {
  if (status === 'running') return 'running';
  if (status === 'waiting_for_input') return 'waiting_for_input';
  if (status === 'completed') return 'completed';
  if (status === 'failed') return 'failed';
  if (status === 'cancelled' || status === 'canceled') return 'cancelled';
  return 'running';
}

function mapStateToTriggerType(state: string): 'completed' | 'failed' | 'cancelled' | 'waiting_for_input' {
  if (state === 'completed') return 'completed';
  if (state === 'failed') return 'failed';
  if (state === 'cancelled') return 'cancelled';
  if (state === 'waiting_for_input') return 'waiting_for_input';
  return 'completed'; // fallback
}
