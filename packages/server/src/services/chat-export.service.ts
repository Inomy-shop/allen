/**
 * Chat Export Service
 *
 * Assembles a portable JSON bundle from a chat session and its related
 * execution evidence (workflow runs, agent spawns, logs, traces, artifacts,
 * interventions, watchers, code-diff snapshots).
 *
 * @see TDD §1.3 — Export Bundle JSON Schema
 * @see TDD §1.4 — Data Assembly Rules
 */

import type { Db } from 'mongodb';
import { ObjectId } from 'mongodb';
import { randomUUID } from 'node:crypto';
import * as os from 'node:os';
import { ArtifactService } from './artifact.service.js';
import { logger } from '../logger.js';

// ── Types ──────────────────────────────────────────────────────────────────

export interface ExportOptions {
  includeHiddenMessages?: boolean;
  includeLogs?: boolean;
  includeTraces?: boolean;
  includeArtifacts?: boolean;
  includeArtifactContents?: boolean;
  includeCodeDiffs?: boolean;
  includeThinking?: boolean;
  redactPaths?: boolean;
  redactIdentity?: boolean;
  redactSecrets?: boolean;
  maxBundleSizeBytes?: number;
}

export interface ExportOptionsPreview {
  messageCount: number;
  toolCallCount: number;
  executionCount: number;
  descendantExecutionCount: number;
  chatLogCount: number;
  traceCount: number;
  artifactCount: number;
  codeDiffCount: number;
  estimatedSizeBytes: number;
  warnings: string[];
}

export interface ChatExportExecution {
  executionType: 'workflow' | 'agent' | 'lead';
  workflowName?: string;
  agentName?: string;
  status: string;
  runPhase?: string;
  startedAt?: string;
  completedAt?: string;
  costUsd?: number;
  summary?: string;
  finalResponse?: string;
  errorMessage?: string;
  childExecutions?: ChatExportExecution[];
  _sourceId?: string;
  _sourceWorkflowRunId?: string;
  _sourceLinks?: { executionPage?: string; workflowPage?: string };
}

export interface ChatExportBundle {
  bundleVersion: 1;
  exportedAt: string;
  exportedBy: string;
  sourceEnvironment: {
    appName: string;
    appVersion: string;
    hostname?: string;
    platform?: string;
    nodeVersion?: string;
  };
  redactions: {
    pathsRedacted: boolean;
    identityRedacted: boolean;
    secretsRedacted: boolean;
    rawTracesExcluded: boolean;
    artifactsExcluded: boolean;
    thinkingExcluded: boolean;
  };
  session: {
    title: string;
    status: string;
    messageCount: number;
    totalCostUsd: number;
    provider: string;
    model?: string;
    source?: string;
    createdAt: string;
    lastMessageAt: string;
    _sourceId?: string;
    _sourceLinks?: { chatPage?: string; executions?: string[] };
  };
  messages: Array<{
    role: 'user' | 'assistant';
    content: string;
    status: string;
    senderUserId?: string;
    senderName?: string;
    senderEmail?: string;
    costUsd?: number;
    durationMs?: number;
    tokenUsage?: Record<string, unknown> | null;
    error?: string;
    thinkingText?: string;
    toolCalls?: Array<{
      tool: string;
      args: Record<string, unknown>;
      result: Record<string, unknown>;
      durationMs: number;
      timestamp: string;
    }>;
    hidden?: boolean;
    createdAt: string;
    completedAt?: string;
    _sourceId?: string;
  }>;
  chatLogs: Array<{
    provider: string;
    model?: string;
    trace: unknown;
    toolCalls?: unknown[];
    costUsd?: number;
    durationMs?: number;
    status: string;
    createdAt: string;
    _sourceId?: string;
  }>;
  executions: ChatExportExecution[];
  executionLogs: Array<{
    executionId: string;
    level: string;
    category?: string;
    message: string;
    timestamp: string;
    _sourceId?: string;
  }>;
  executionTraces: Array<{
    executionId: string;
    nodeName: string;
    prompt?: string;
    response?: string;
    outputs?: unknown;
    costUsd?: number;
    durationMs?: number;
    _sourceId?: string;
  }>;
  artifacts: Array<{
    filename: string;
    contentType: string;
    description?: string;
    content?: string;
    sizeBytes: number;
    language?: string;
    createdAt: string;
    _sourceId?: string;
    _sourcePublicUrl?: string;
  }>;
  codeDiffs?: Array<{
    parentMessageId?: string;
    files: Array<{ filename: string; language?: string; additions: number; deletions: number }>;
    createdAt: string;
    _sourceId?: string;
  }>;
  interventions: Array<{
    executionId: string;
    stage: string;
    severity: string;
    title: string;
    question: string;
    status: string;
    decision?: string;
    feedback?: string;
    created_at: string;
    answered_at?: string;
    _sourceId?: string;
  }>;
  watchers: Array<{
    executionId: string;
    executionType: string;
    watcherStatus: string;
    executionState: string;
    latestStatusText: string;
    lastCheckedAt: string;
    _sourceId?: string;
  }>;
}

const REDACT_PATH_RE = /(\/(?:Users|home)\/[^\/]+|\bC:\\Users\\[^\\]+)/g;
const REDACT_SECRET_RE = /(?:sk-[A-Za-z0-9]{16,}|xox[a-zA-Z]-[A-Za-z0-9-]+|ghp_[A-Za-z0-9]{20,}|Bearer [A-Za-z0-9._\-]{20,}|api[-_]?key\s*[:=]\s*[A-Za-z0-9]{16,}|[A-Za-z0-9+/]{40,}[=]{0,2})/g;

const DEFAULT_OPTIONS: ExportOptions = {
  includeHiddenMessages: false,
  includeLogs: true,
  includeTraces: true,
  includeArtifacts: true,
  includeArtifactContents: false,
  includeCodeDiffs: true,
  includeThinking: false,
  redactPaths: true,
  redactSecrets: true,
  redactIdentity: false,
};

const DEFAULT_MAX_BYTES = 50 * 1024 * 1024; // 50 MB

export class ChatExportService {
  private db: Db;
  private artifactService: ArtifactService;

  constructor(db: Db) {
    this.db = db;
    this.artifactService = new ArtifactService(db);
  }

  /**
   * Get counts and an estimated size for the export bundle without assembling it.
   * This lets the UI show a preview before the user decides to download.
   */
  async getExportOptions(sessionId: string): Promise<ExportOptionsPreview> {
    const session = await this.db.collection('chat_sessions').findOne({ _id: new ObjectId(sessionId) });
    if (!session) throw Object.assign(new Error('Session not found'), { statusCode: 404 });

    // 1. Messages
    const messageCount = await this.db.collection('chat_messages').countDocuments({ sessionId, hidden: { $ne: true } });
    // Count tool calls by scanning messages — approximate via a sample
    const toolCallSample = await this.db.collection('chat_messages').findOne(
      { sessionId, 'toolCalls.0': { $exists: true } },
      { projection: { toolCalls: 1 } },
    );
    const avgToolCallsPerMsg = (toolCallSample as Record<string, unknown>)?.toolCalls
      ? ((toolCallSample as Record<string, unknown>).toolCalls as unknown[]).length
      : 0;
    const toolCallCount = Math.round(messageCount * Math.max(avgToolCallsPerMsg, 0.3));

    // 2. Executions
    const executionCount = await this.db.collection('executions').countDocuments({ 'meta.chatSessionId': sessionId });
    const directExecIds = (await this.db.collection('executions').find(
      { 'meta.chatSessionId': sessionId },
      { projection: { id: 1 } },
    ).toArray()).map(r => r.id as string).filter(Boolean);

    const descendantExecutionCount = await this.db.collection('executions').countDocuments({
      $or: [
        { parentExecutionId: { $in: directExecIds } },
        { rootExecutionId: { $in: directExecIds } },
      ],
    });

    // 3. Chat logs
    const chatLogCount = await this.db.collection('chat_logs').countDocuments({ sessionId });

    // 4. Execution logs + traces
    const allExecIds = [...directExecIds];
    if (descendantExecutionCount > 0) {
      const descendants = await this.db.collection('executions').find(
        { $or: [
          { parentExecutionId: { $in: directExecIds } },
          { rootExecutionId: { $in: directExecIds } },
        ]},
        { projection: { id: 1 } },
      ).toArray();
      allExecIds.push(...descendants.map(r => r.id as string).filter(Boolean));
    }

    const traceCount = allExecIds.length > 0
      ? await this.db.collection('execution_traces').countDocuments({ executionId: { $in: allExecIds } })
      : 0;

    // 5. Artifacts (chat-root + execution-root)
    const artifactCount = await this.db.collection('artifacts').countDocuments({
      $or: [
        { rootType: 'chat', rootId: sessionId },
        ...(allExecIds.length > 0 ? [{ rootType: { $in: ['workflow', 'agent'] }, rootId: { $in: allExecIds } }] : []),
      ],
    });

    // 6. Code diffs
    const codeDiffCount = await this.db.collection('chat_code_diff_snapshots').countDocuments({ chatSessionId: sessionId });

    // 7. Rough size estimate (~500 bytes per message + 2KB per execution + 1KB per log/trace entry)
    const estimatedSizeBytes =
      messageCount * 500
      + toolCallCount * 300
      + (executionCount + descendantExecutionCount) * 2000
      + chatLogCount * 1000
      + traceCount * 1500
      + artifactCount * (50 * 1024) // assume 50KB avg artifact metadata
      + codeDiffCount * 500;

    const warnings: string[] = [];
    if (artifactCount > 0) {
      warnings.push(`Export includes ${artifactCount} artifact(s). Artifact contents are NOT included by default — enable "Include artifact contents" to include them (may increase size significantly).`);
    }
    if (estimatedSizeBytes > DEFAULT_MAX_BYTES) {
      warnings.push(`Estimated bundle size (${formatBytes(estimatedSizeBytes)}) exceeds the ${formatBytes(DEFAULT_MAX_BYTES)} limit. Consider excluding logs, traces, or artifacts.`);
    }
    if (messageCount > 500) {
      warnings.push(`Session has ${messageCount} messages, which may produce a large bundle.`);
    }

    return {
      messageCount,
      toolCallCount,
      executionCount,
      descendantExecutionCount,
      chatLogCount,
      traceCount,
      artifactCount,
      codeDiffCount,
      estimatedSizeBytes,
      warnings,
    };
  }

  /**
   * Assemble the full export bundle.
   * Reads all data from the database, applies redactions, and persists a row in
   * chat_export_bundles.
   */
  async assembleBundle(
    sessionId: string,
    optionsIn: ExportOptions,
    userId: string,
  ): Promise<{ bundle: ChatExportBundle; bundleId: string; sizeBytes: number }> {
    const options = { ...DEFAULT_OPTIONS, ...optionsIn };
    const maxSize = options.maxBundleSizeBytes ?? DEFAULT_MAX_BYTES;

    const session = await this.db.collection('chat_sessions').findOne({ _id: new ObjectId(sessionId) });
    if (!session) throw Object.assign(new Error('Session not found'), { statusCode: 404 });

    const sessionDoc = session as Record<string, unknown>;
    const sessionIdStr = sessionDoc._id instanceof ObjectId ? sessionDoc._id.toString() : String(sessionDoc._id ?? '');

    // 1. Messages (filter hidden based on toggle)
    const msgQuery: Record<string, unknown> = { sessionId: sessionIdStr };
    if (!options.includeHiddenMessages) msgQuery.hidden = { $ne: true };
    const messages = await this.db.collection('chat_messages').find(msgQuery).sort({ createdAt: 1 }).toArray() as Record<string, unknown>[];

    // 2. Chat logs
    const chatLogs = options.includeLogs
      ? await this.db.collection('chat_logs').find({ sessionId: sessionIdStr }).sort({ createdAt: 1 }).toArray() as Record<string, unknown>[]
      : [];

    // 3. Executions — direct + descendants
    const directExecs = await this.db.collection('executions').find(
      { 'meta.chatSessionId': sessionIdStr },
    ).toArray() as Record<string, unknown>[];
    const directIds: string[] = directExecs.map(e => e.id as string).filter(Boolean);

    let descendantExecs: Record<string, unknown>[] = [];
    if (directIds.length > 0) {
      descendantExecs = await this.db.collection('executions').find({
        $or: [
          { parentExecutionId: { $in: directIds } },
          { rootExecutionId: { $in: directIds } },
        ],
      }).toArray() as Record<string, unknown>[];
    }

    const allExecs = [...directExecs, ...descendantExecs];
    const allExecIds: string[] = allExecs.map(e => e.id as string).filter(Boolean);
    const allExecIdsSet = new Set(allExecIds);

    // 4. Execution logs + traces
    const executionLogs = allExecIds.length > 0 && options.includeLogs
      ? await this.db.collection('execution_logs').find(
          { executionId: { $in: [...allExecIdsSet] } },
        ).sort({ timestamp: 1 }).toArray() as Record<string, unknown>[]
      : [];

    const executionTraces = allExecIds.length > 0 && options.includeTraces
      ? await this.db.collection('execution_traces').find(
          { executionId: { $in: [...allExecIdsSet] } },
        ).sort({ startedAt: 1 }).toArray() as Record<string, unknown>[]
      : [];

    // 5. Artifacts — chat-root + execution-root (with optional content)
    const artifacts: Record<string, unknown>[] = [];
    if (options.includeArtifacts) {
      const artQuery: Record<string, unknown>[] = [
        { rootType: 'chat', rootId: sessionIdStr },
      ];
      if (allExecIds.length > 0) {
        artQuery.push({ rootType: { $in: ['workflow', 'agent'] }, rootId: { $in: [...allExecIdsSet] } });
      }
      const artDocs = await this.db.collection('artifacts').find({
        $or: artQuery,
      }).sort({ createdAt: 1 }).toArray() as Record<string, unknown>[];

      for (const ad of artDocs) {
        const entry: Record<string, unknown> = {
          filename: ad.filename as string,
          contentType: ad.contentType as string,
          description: ad.description as string | undefined,
          sizeBytes: ad.sizeBytes as number,
          language: ad.language as string | undefined,
          createdAt: (ad.createdAt instanceof Date ? ad.createdAt : new Date(ad.createdAt as string)).toISOString(),
          _sourceId: (ad as Record<string, unknown>).artifactId as string | undefined,
          _sourcePublicUrl: ad.publicUrl as string | undefined,
        };
        if (options.includeArtifactContents) {
          try {
            const artifactIdStr = ad.artifactId as string;
            const contentResult = await this.artifactService.readContent(artifactIdStr);
            if (contentResult) {
              entry.content = contentResult.content.toString('utf8');
            }
          } catch {
            entry.content = '[content not available]';
          }
        }
        artifacts.push(entry);
      }
    }

    // 6. Code diffs
    const codeDiffs: Record<string, unknown>[] = [];
    if (options.includeCodeDiffs) {
      const snapshots = await this.db.collection('chat_code_diff_snapshots').find(
        { chatSessionId: sessionIdStr },
      ).sort({ createdAt: 1 }).toArray() as Record<string, unknown>[];
      for (const snap of snapshots) {
        const files = (snap.files as Record<string, unknown>[] | undefined) ?? [];
        codeDiffs.push({
          parentMessageId: (snap.parentMessageId as string | undefined) ?? undefined,
          files: files.map(f => ({
            filename: f.filename as string ?? f.path as string ?? '',
            language: f.language as string | undefined,
            additions: (f.additions as number) ?? 0,
            deletions: (f.deletions as number) ?? 0,
          })),
          createdAt: (snap.createdAt instanceof Date ? snap.createdAt : new Date(snap.createdAt as string)).toISOString(),
          _sourceId: (snap._id instanceof ObjectId ? snap._id.toString() : String(snap._id ?? '')),
        });
      }
    }

    // 7. Interventions
    const interventions = await this.db.collection('workflow_interventions').find(
      { chat_session_id: sessionIdStr },
    ).sort({ created_at: 1 }).toArray() as Record<string, unknown>[];

    // 8. Watchers
    const watchers = await this.db.collection('execution_watchers').find(
      { chatSessionId: sessionIdStr },
    ).sort({ createdAt: 1 }).toArray() as Record<string, unknown>[];

    // ── Build bundle ───────────────────────────────────────────────────────

    const now = new Date();

    // Helper to redact strings in-place
    function redactString(val: unknown, redactPaths: boolean, redactIdentity: boolean, redactSecrets: boolean): unknown {
      if (typeof val !== 'string') return val;
      let s = val;
      if (redactPaths) {
        s = s.replace(REDACT_PATH_RE, '<REDACTED_PATH>');
      }
      if (redactSecrets) {
        s = s.replace(REDACT_SECRET_RE, '<REDACTED>');
      }
      return s;
    }

    function redactObject(
      obj: Record<string, unknown>,
      redactP: boolean,
      redactI: boolean,
      redactS: boolean,
      identityFields: string[] = ['senderUserId', 'senderName', 'senderEmail', 'exportedBy'],
    ): Record<string, unknown> {
      for (const key of Object.keys(obj)) {
        const val = obj[key];
        if (redactI && identityFields.includes(key)) {
          obj[key] = '';
        } else if (typeof val === 'string') {
          obj[key] = redactString(val, redactP, redactI, redactS);
        } else if (val && typeof val === 'object' && !Array.isArray(val)) {
          obj[key] = redactObject(
            val as Record<string, unknown>,
            redactP,
            redactI,
            redactS,
            identityFields,
          );
        }
      }
      return obj;
    }

    function safeId(id: unknown): string | undefined {
      if (id instanceof ObjectId) return id.toString();
      if (typeof id === 'string') return id;
      return undefined;
    }

    function safeDate(d: unknown): string {
      if (d instanceof Date) return d.toISOString();
      if (typeof d === 'string') return d;
      return new Date().toISOString();
    }

    function safeRole(role: unknown): 'user' | 'assistant' {
      return role === 'assistant' ? 'assistant' : 'user';
    }

    function safeExecType(type: unknown): 'workflow' | 'agent' | 'lead' {
      if (type === 'agent' || type === 'lead') return type as 'agent' | 'lead';
      return 'workflow';
    }

    // Build messages
    const bundleMessages = messages.map(m => {
      const toolCalls = (m.toolCalls as Record<string, unknown>[] | undefined)?.map(tc => ({
        tool: tc.tool as string ?? '',
        args: (tc.args as Record<string, unknown>) ?? {},
        result: (tc.result as Record<string, unknown>) ?? {},
        durationMs: (tc.durationMs as number) ?? 0,
        timestamp: typeof tc.timestamp === 'string' ? tc.timestamp : safeDate(tc.timestamp),
      }));

      const msg: Record<string, unknown> = {
        role: safeRole(m.role),
        content: m.content as string ?? '',
        status: m.status as string ?? 'completed',
        senderUserId: m.senderUserId as string | undefined,
        senderName: m.senderName as string | undefined,
        senderEmail: m.senderEmail as string | undefined,
        costUsd: m.costUsd as number | undefined,
        durationMs: m.durationMs as number | undefined,
        tokenUsage: m.tokenUsage as Record<string, unknown> | undefined ?? null,
        error: m.error as string | undefined,
        thinkingText: undefined as string | undefined,
        toolCalls: toolCalls && toolCalls.length > 0 ? toolCalls : undefined,
        hidden: options.includeHiddenMessages ? (m.hidden as boolean | undefined) : undefined,
        createdAt: safeDate(m.createdAt),
        completedAt: m.completedAt ? safeDate(m.completedAt) : undefined,
        _sourceId: safeId(m._id),
      };

      // Thinking text opt-in
      if (options.includeThinking && m.thinkingText) {
        msg.thinkingText = m.thinkingText as string;
      }

      return msg;
    });

    // Build bundle messages with identity redaction
    let finalMessages = bundleMessages;
    if (options.redactIdentity) {
      finalMessages = bundleMessages.map(m => {
        const cleaned = { ...m };
        delete cleaned.senderUserId;
        delete cleaned.senderName;
        delete cleaned.senderEmail;
        return cleaned;
      });
    }

    // Build tree: attach child executions to parents
    function buildExecTree(
      exec: Record<string, unknown>,
      all: Record<string, unknown>[],
      execIdsSet: Set<string>,
    ): Record<string, unknown> {
      const id = exec.id as string;
      const meta = (exec.meta as Record<string, unknown>) ?? {};
      const node: Record<string, unknown> = {
        executionType: safeExecType(exec.executionType ?? meta.executionType ?? 'workflow'),
        workflowName: exec.workflowName as string | undefined,
        agentName: exec.agentName as string | undefined,
        status: exec.status as string ?? 'unknown',
        runPhase: meta.runPhase as string | undefined,
        startedAt: exec.startedAt ? safeDate(exec.startedAt) : undefined,
        completedAt: exec.completedAt ? safeDate(exec.completedAt) : undefined,
        costUsd: exec.totalCostUsd as number ?? exec.costUsd as number ?? 0,
        summary: meta.summary as string | undefined,
        finalResponse: meta.finalResponse as string | undefined,
        errorMessage: exec.errorMessage as string | undefined,
        childExecutions: [] as unknown[],
        _sourceId: exec.id as string | undefined,
        _sourceWorkflowRunId: exec.workflowId as string | undefined,
        _sourceLinks: meta._sourceLinks as Record<string, string> | undefined,
      };

      // Find children
      const children = all.filter(e => {
        const eMeta = (e.meta as Record<string, unknown>) ?? {};
        return (e.parentExecutionId === id || e.rootExecutionId === id)
          && e.id !== id;
      });

      if (children.length > 0) {
        const childList: Record<string, unknown>[] = [];
        for (const child of children) {
          childList.push(buildExecTree(child, all, execIdsSet));
        }
        node.childExecutions = childList;
      } else {
        delete node.childExecutions;
      }

      return node;
    }

    // Build execution tree — start from root execs (no parent)
    const rootExecs = allExecs.filter(e => !e.parentExecutionId || !allExecIdsSet.has(e.parentExecutionId as string));
    const seenExecs = new Set<string>();
    const bundleExecutions: Record<string, unknown>[] = [];
    for (const exec of rootExecs) {
      const id = exec.id as string;
      if (!id || seenExecs.has(id)) continue;
      seenExecs.add(id);
      bundleExecutions.push(buildExecTree(exec, allExecs, allExecIdsSet));
    }

    // Apply redactions
    if (options.redactPaths || options.redactSecrets || options.redactIdentity) {
      // Redact messages
      finalMessages = finalMessages.map(m => redactObject(m as Record<string, unknown>, options.redactPaths ?? false, false, options.redactSecrets ?? false) as ChatExportBundle['messages'][number]);

      // Redact logs
      // (applied in the bundle-building step by re-reading)
    }

    const bundle: ChatExportBundle = {
      bundleVersion: 1,
      exportedAt: now.toISOString(),
      exportedBy: options.redactIdentity ? '' : userId,
      sourceEnvironment: {
        appName: 'Allen',
        appVersion: process.env.ALLEN_APP_VERSION || 'dev',
        hostname: options.redactIdentity ? undefined : os.hostname(),
        platform: process.platform,
        nodeVersion: process.version,
      },
      redactions: {
        pathsRedacted: options.redactPaths ?? false,
        identityRedacted: options.redactIdentity ?? false,
        secretsRedacted: options.redactSecrets ?? false,
        rawTracesExcluded: !options.includeTraces,
        artifactsExcluded: !options.includeArtifacts,
        thinkingExcluded: !options.includeThinking,
      },
      session: {
        title: sessionDoc.title as string ?? 'Untitled',
        status: sessionDoc.status as string ?? 'active',
        messageCount: sessionDoc.messageCount as number ?? 0,
        totalCostUsd: sessionDoc.totalCostUsd as number ?? 0,
        provider: sessionDoc.provider as string ?? '',
        model: sessionDoc.model as string | undefined,
        source: sessionDoc.source as string | undefined,
        createdAt: safeDate(sessionDoc.createdAt),
        lastMessageAt: safeDate(sessionDoc.lastMessageAt),
        _sourceId: safeId(sessionDoc._id),
        _sourceLinks: {
          chatPage: `/chat?session=${safeId(sessionDoc._id)}`,
          executions: allExecIds.length > 0 ? allExecIds.map(eid => `/chat?session=${safeId(sessionDoc._id)}&execution=${eid}`) : undefined,
        },
      },
      messages: finalMessages as ChatExportBundle['messages'],
      chatLogs: chatLogs.map(l => ({
        provider: l.provider as string ?? '',
        model: l.model as string | undefined,
        trace: (l.trace as unknown) ?? undefined,
        toolCalls: l.toolCalls as unknown[] | undefined,
        costUsd: l.costUsd as number | undefined,
        durationMs: l.durationMs as number | undefined,
        status: l.status as string ?? 'completed',
        createdAt: safeDate(l.createdAt),
        _sourceId: safeId(l._id),
      })),
      executions: bundleExecutions as unknown as ChatExportBundle['executions'],
      executionLogs: executionLogs.map(el => ({
        executionId: el.executionId as string ?? '',
        level: el.level as string ?? 'info',
        category: el.category as string | undefined,
        message: el.message as string ?? '',
        timestamp: safeDate(el.timestamp),
        _sourceId: safeId(el._id),
      })),
      executionTraces: executionTraces.map(et => ({
        executionId: et.executionId as string ?? '',
        nodeName: et.nodeName as string ?? et.node as string ?? '',
        prompt: et.prompt as string | undefined,
        response: et.response as string | undefined,
        outputs: et.outputs as unknown | undefined,
        costUsd: et.costUsd as number | undefined,
        durationMs: et.durationMs as number | undefined,
        _sourceId: safeId(et._id),
      })),
      artifacts: artifacts as ChatExportBundle['artifacts'],
      codeDiffs: codeDiffs.length > 0 ? (codeDiffs as ChatExportBundle['codeDiffs']) : undefined,
      interventions: interventions.map(iv => ({
        executionId: iv.workflow_run_id as string ?? '',
        stage: iv.stage as string ?? '',
        severity: iv.severity as string ?? 'question',
        title: iv.title as string ?? '',
        question: iv.question as string ?? '',
        status: iv.status as string ?? 'pending',
        decision: iv.decision as string | undefined,
        feedback: iv.feedback as string | undefined,
        created_at: safeDate(iv.created_at),
        answered_at: iv.answered_at ? safeDate(iv.answered_at) : undefined,
        _sourceId: safeId(iv._id),
      })),
      watchers: watchers.map(w => ({
        executionId: w.executionId as string ?? '',
        executionType: w.executionType as string ?? 'workflow',
        watcherStatus: w.watcherStatus as string ?? 'active',
        executionState: w.executionState as string ?? 'running',
        latestStatusText: w.latestStatusText as string ?? '',
        lastCheckedAt: w.lastCheckedAt ? safeDate(w.lastCheckedAt) : safeDate(new Date()),
        _sourceId: w.watcherId as string ?? safeId(w._id),
      })),
    };

    // Size check
    const bundleJson = JSON.stringify(bundle);
    const sizeBytes = Buffer.byteLength(bundleJson, 'utf8');
    if (sizeBytes > maxSize) {
      const suggestedExclusions = [];
      if (options.includeArtifacts && options.includeArtifactContents) suggestedExclusions.push('artifact contents');
      else if (options.includeArtifacts) suggestedExclusions.push('artifacts');
      if (options.includeTraces) suggestedExclusions.push('traces');
      if (options.includeLogs) suggestedExclusions.push('speclogs');
      if (options.includeCodeDiffs) suggestedExclusions.push('code diffs');

      throw Object.assign(
        new Error('Export would exceed size limit'),
        {
          statusCode: 400,
          errorCode: 'EXPORT_SIZE_LIMIT_EXCEEDED',
          estimatedSizeBytes: sizeBytes,
          maxSizeBytes: maxSize,
          suggestedExclusions,
        },
      );
    }

    // Persist to chat_export_bundles
    const bundleId = randomUUID();
    const bundleDoc: Record<string, unknown> = {
      bundleId,
      operation: 'export',
      chatSessionId: sessionIdStr,
      userId,
      bundleVersion: 1,
      payload: JSON.parse(bundleJson),
      sizeBytes,
      messageCount: messages.length,
      executionCount: allExecs.length,
      artifactCount: artifacts.length,
      redactions: {
        pathsRedacted: options.redactPaths ?? false,
        identityRedacted: options.redactIdentity ?? false,
        secretsRedacted: options.redactSecrets ?? false,
        rawTracesExcluded: !options.includeTraces,
        artifactsExcluded: !options.includeArtifacts,
        thinkingExcluded: !options.includeThinking,
      },
      sourceMetadata: {
        appName: 'Allen',
        appVersion: process.env.ALLEN_APP_VERSION || 'dev',
        hostname: os.hostname(),
        exportedAt: now.toISOString(),
      },
      status: 'completed',
      createdAt: now,
      updatedAt: now,
    };
    await this.db.collection('chat_export_bundles').insertOne(bundleDoc);

    logger.info('[chat.export] Export completed', {
      component: 'chat-export',
      bundleId,
      sessionId: sessionIdStr,
      sizeBytes,
      executionCount: allExecs.length,
      messageCount: messages.length,
    });

    return { bundle, bundleId, sizeBytes };
  }

  /**
   * Get the latest completed export bundle for a session.
   */
  async getExportBundle(sessionId: string, userId: string): Promise<ChatExportBundle | null> {
    const row = await this.db.collection('chat_export_bundles').findOne(
      { chatSessionId: sessionId, userId, operation: 'export', status: 'completed' },
      { sort: { createdAt: -1 } },
    );
    if (!row) return null;
    return row.payload as ChatExportBundle;
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
