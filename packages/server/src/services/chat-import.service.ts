/**
 * Chat Import Service
 *
 * Imports a ChatExportBundle as a new read-only replay chat session.
 * Validates the bundle, optionally previews it, then persists all records
 * with remapped IDs and an isImported marker.
 *
 * @see TDD §2.3 — POST /api/chat/import/preview
 * @see TDD §2.4 — POST /api/chat/import/confirm
 */

import type { Db } from 'mongodb';
import { ObjectId } from 'mongodb';
import { randomUUID } from 'node:crypto';
import { logger } from '../logger.js';
import { ArtifactService, type ArtifactContentType } from './artifact.service.js';
import type { ChatExportBundle } from './chat-export.service.js';

// ── Types ──────────────────────────────────────────────────────────────────

export interface PreviewResult {
  valid: true;
  bundleId: string;
  preview: {
    title: string;
    exportedAt: string;
    messageCount: number;
    executionCount: number;
    artifactCount: number;
    bundleVersion: number;
    sourceEnvironment?: { appName: string; appVersion: string; hostname?: string; exportedAt?: string };
    estimatedImportedSize: number;
    importsAs: string;
    warnings: string[];
  };
}

export interface IdRemapTable {
  messages: Map<string, string>;
  executions: Map<string, string>;
  executionLogs: Map<string, string>;
  executionTraces: Map<string, string>;
  artifacts: Map<string, string>;
  interventions: Map<string, string>;
  codeDiffs: Map<string, string>;
  watchers: Map<string, string>;
}

export interface ConfirmResult {
  imported: true;
  sessionId: string;
  session: Record<string, unknown>;
  remappedCounts: {
    messages: number;
    executions: number;
    executionLogs: number;
    executionTraces: number;
    artifacts: number;
    codeDiffs: number;
    interventions: number;
    watchers: number;
  };
}

const IMPORT_MAX_BYTES = Number(process.env.ALLEN_IMPORT_MAX_BYTES) || 100 * 1024 * 1024; // 100 MB

const REQUIRED_FIELDS: (keyof ChatExportBundle)[] = ['bundleVersion', 'session', 'messages'];

const UNSAFE_URL_PROTOCOL_RE = /^\s*(?:javascript|vbscript|data)\s*:/i;
const FENCED_CODE_BLOCK_RE = /```[\s\S]*?```/g;
const INLINE_CODE_RE = /`[^`]*`/g;
const MARKDOWN_LINK_RE = /\[[^\]]+\]\(\s*<?([^\s)>]+)>?(?:\s+["'][^"']*["'])?\s*\)/g;

type ImportContentPath = Array<string | number>;

function normalizeUrlCandidate(value: string): string {
  return value.trim().replace(/^[<"']+|[>"']+$/g, '');
}

function isUnsafeUrlCandidate(value: string): boolean {
  return UNSAFE_URL_PROTOCOL_RE.test(normalizeUrlCandidate(value));
}

function stripInactiveMarkdownRegions(value: string): string {
  return value.replace(FENCED_CODE_BLOCK_RE, '').replace(INLINE_CODE_RE, '');
}

function isUrlLikePath(path: ImportContentPath): boolean {
  const normalized = path.map(part => String(part).replace(/[^a-z0-9]/gi, '').toLowerCase());
  const key = normalized[normalized.length - 1] ?? '';
  return (
    key === 'url' ||
    key === 'href' ||
    key.endsWith('url') ||
    key.endsWith('href') ||
    key.endsWith('link') ||
    normalized.some(part => part === 'links' || part === 'sourcelinks')
  );
}

function hasUnsafeMarkdownLink(value: string): boolean {
  MARKDOWN_LINK_RE.lastIndex = 0;
  const activeMarkdown = stripInactiveMarkdownRegions(value);
  let match: RegExpExecArray | null;
  while ((match = MARKDOWN_LINK_RE.exec(activeMarkdown)) !== null) {
    if (match[1] && isUnsafeUrlCandidate(match[1])) return true;
  }
  return false;
}

/**
 * Import safety scan for executable link sinks. Plain chat/log/artifact text is
 * rendered as React text or code, so strings such as `<script>` must remain
 * importable. Reject only values that the UI can render as navigable links with
 * unsafe protocols.
 */
export function hasXssPayloads(obj: unknown, path: ImportContentPath = []): boolean {
  if (typeof obj === 'string') {
    if (hasUnsafeMarkdownLink(obj)) return true;
    return isUrlLikePath(path) && isUnsafeUrlCandidate(obj);
  }

  if (obj && typeof obj === 'object') {
    if (Array.isArray(obj)) {
      return obj.some((item, index) => hasXssPayloads(item, [...path, index]));
    }

    for (const [key, val] of Object.entries(obj as Record<string, unknown>)) {
      if (hasXssPayloads(val, [...path, key])) return true;
    }
  }

  return false;
}

export class ChatImportService {
  private db: Db;
  private artifactService: ArtifactService;

  constructor(db: Db) {
    this.db = db;
    this.artifactService = new ArtifactService(db);
  }

  /**
   * Validate and preview a bundle without persisting any data.
   * Checks: JSON parseability, bundle version, required fields, message
   * validity, XSS, and size limits.
   */
  async preview(rawJsonOrObject: string | object, userId: string): Promise<PreviewResult> {
    let parsed: Record<string, unknown>;

    if (typeof rawJsonOrObject === 'string') {
      try {
        parsed = JSON.parse(rawJsonOrObject) as Record<string, unknown>;
      } catch {
        throw Object.assign(new Error('Invalid bundle format: not valid JSON'), {
          statusCode: 400,
          errorCode: 'IMPORT_INVALID_JSON',
        });
      }
    } else if (rawJsonOrObject && typeof rawJsonOrObject === 'object') {
      parsed = rawJsonOrObject as Record<string, unknown>;
    } else {
      throw Object.assign(new Error('Invalid bundle format: not valid JSON'), {
        statusCode: 400,
        errorCode: 'IMPORT_INVALID_JSON',
      });
    }

    // Size check on raw input
    const rawSize = typeof rawJsonOrObject === 'string'
      ? Buffer.byteLength(rawJsonOrObject, 'utf8')
      : Buffer.byteLength(JSON.stringify(rawJsonOrObject), 'utf8');
    if (rawSize > IMPORT_MAX_BYTES) {
      throw Object.assign(
        new Error(`Bundle exceeds size limit (${formatBytes(IMPORT_MAX_BYTES)})`),
        { statusCode: 400, errorCode: 'IMPORT_SIZE_EXCEEDED', limitBytes: IMPORT_MAX_BYTES },
      );
    }

    // Version check
    const bundleVersion = parsed.bundleVersion as number | undefined;
    if (typeof bundleVersion !== 'number' || bundleVersion < 1) {
      throw Object.assign(new Error('Unsupported bundle version'), {
        statusCode: 400,
        errorCode: 'IMPORT_UNSUPPORTED_VERSION',
        bundleVersion,
        supportedVersions: [1],
      });
    }

    // Required fields check
    const missing: string[] = [];
    for (const field of REQUIRED_FIELDS) {
      if (!(field in parsed)) missing.push(field);
    }
    if (missing.length > 0) {
      throw Object.assign(new Error('Missing required fields'), {
        statusCode: 400,
        errorCode: 'IMPORT_MISSING_FIELDS',
        missing,
      });
    }

    // Messages validation
    const messages = parsed.messages as Array<Record<string, unknown>> | undefined;
    if (!Array.isArray(messages) || messages.length === 0) {
      throw Object.assign(new Error('Messages must be a non-empty array'), {
        statusCode: 400,
        errorCode: 'IMPORT_MISSING_FIELDS',
        detail: 'messages',
      });
    }
    for (const msg of messages) {
      if (msg.role !== 'user' && msg.role !== 'assistant') {
        throw Object.assign(new Error('Messages contain invalid role values'), {
          statusCode: 400,
          errorCode: 'IMPORT_MISSING_FIELDS',
          detail: 'messages[].role must be "user" or "assistant"',
        });
      }
    }

    // XSS check
    if (hasXssPayloads(parsed)) {
      throw Object.assign(new Error('Contains unsafe content'), {
        statusCode: 400,
        errorCode: 'IMPORT_XSS_REJECTED',
      });
    }

    // Extract source environment
    const sourceEnv = parsed.sourceEnvironment as Record<string, unknown> | undefined;
    const bundleSession = parsed.session as Record<string, unknown> | undefined;
    const executions = parsed.executions as unknown[] | undefined ?? [];
    const artifacts = parsed.artifacts as unknown[] | undefined ?? [];
    const chatLogs = parsed.chatLogs as unknown[] | undefined ?? [];

    // Estimate imported size
    const estimatedImportedSize = rawSize;

    // Warnings
    const warnings: string[] = [];
    const redactions = parsed.redactions as Record<string, unknown> | undefined;
    if (redactions) {
      if (redactions.secretsRedacted) {
        warnings.push('Exporter applied secret redaction — some values may be sanitized.');
      }
      if (redactions.pathsRedacted) {
        warnings.push('Exporter applied path redaction — local paths are masked.');
      }
    }
    if (sourceEnv) {
      warnings.push(`Imported from ${sourceEnv.appName ?? 'Allen'} ${sourceEnv.appVersion ?? 'unknown version'} — links to original environment may not resolve.`);
    }
    if (executions.length > 0) {
      warnings.push(`Bundle contains ${executions.length} execution record(s). These are replay-only and cannot be resumed.`);
    }

    // Persist preview row
    const bundleId = randomUUID();
    const now = new Date();
    await this.db.collection('chat_export_bundles').insertOne({
      bundleId,
      operation: 'import',
      userId,
      bundleVersion,
      payload: parsed,
      sizeBytes: rawSize,
      status: 'preview',
      sourceMetadata: sourceEnv ?? {},
      createdAt: now,
      updatedAt: now,
    });

    logger.info('[chat.import] Preview created', {
      component: 'chat-import',
      bundleId,
      messageCount: messages.length,
      executionCount: executions.length,
    });

    return {
      valid: true,
      bundleId,
      preview: {
        title: (bundleSession?.title as string) ?? 'Untitled',
        exportedAt: (bundleSession?.createdAt as string) ?? (parsed.exportedAt as string) ?? '',
        messageCount: messages.length,
        executionCount: executions.length,
        artifactCount: artifacts.length,
        bundleVersion,
        sourceEnvironment: sourceEnv
          ? {
              appName: sourceEnv.appName as string,
              appVersion: sourceEnv.appVersion as string,
              hostname: sourceEnv.hostname as string | undefined,
              exportedAt: sourceEnv.exportedAt as string | undefined,
            }
          : undefined,
        estimatedImportedSize,
        importsAs: 'read-only replay',
        warnings,
      },
    };
  }

  /**
   * Confirm import and persist all records with remapped IDs.
   * On failure, rolls back all inserted records in reverse order.
   */
  async confirm(bundleId: string, userId: string): Promise<ConfirmResult> {
    // 1. Load and lock bundle
    const bundleRow = await this.db.collection('chat_export_bundles').findOne({ bundleId });

    if (!bundleRow) {
      throw Object.assign(new Error('Bundle not found or already imported'), {
        statusCode: 400,
        errorCode: 'IMPORT_BUNDLE_NOT_FOUND',
      });
    }

    if (bundleRow.status === 'completed') {
      throw Object.assign(new Error('Already completed'), {
        statusCode: 400,
        errorCode: 'IMPORT_ALREADY_COMPLETED',
        existingSessionId: bundleRow.importSessionId,
      });
    }

    if (bundleRow.status === 'rolled_back') {
      throw Object.assign(new Error('Previous import failed. Re-upload to retry.'), {
        statusCode: 400,
        errorCode: 'IMPORT_BUNDLE_ROLLED_BACK',
      });
    }

    if (bundleRow.status === 'importing') {
      throw Object.assign(new Error('Import already in progress'), {
        statusCode: 409,
        errorCode: 'IMPORT_ALREADY_COMPLETED',
      });
    }

    // Lock
    const lockResult = await this.db.collection('chat_export_bundles').updateOne(
      { bundleId, status: 'preview' },
      { $set: { status: 'importing', updatedAt: new Date() } },
    );
    if (lockResult.modifiedCount === 0) {
      throw Object.assign(new Error('Bundle not found or already imported'), {
        statusCode: 400,
        errorCode: 'IMPORT_BUNDLE_NOT_FOUND',
      });
    }

    const bundle = bundleRow.payload as Record<string, unknown>;
    const bundleSession = bundle.session as Record<string, unknown>;
    const sourceEnv = bundle.sourceEnvironment as Record<string, unknown> | undefined;

    // Safety check: re-check XSS on the stored payload
    if (hasXssPayloads(bundle)) {
      await this.db.collection('chat_export_bundles').updateOne(
        { bundleId },
        { $set: { status: 'rolled_back', error: 'XSS_REJECTED', updatedAt: new Date() } },
      );
      throw Object.assign(new Error('Contains unsafe content'), {
        statusCode: 400,
        errorCode: 'IMPORT_XSS_REJECTED',
      });
    }

    const now = new Date();
    const newSessionId = new ObjectId();
    const sessionIdStr = newSessionId.toString();

    // Build remap table
    const remap: IdRemapTable = {
      messages: new Map(),
      executions: new Map(),
      executionLogs: new Map(),
      executionTraces: new Map(),
      artifacts: new Map(),
      interventions: new Map(),
      codeDiffs: new Map(),
      watchers: new Map(),
    };

    // Track what was inserted for rollback
    const insertedCollections: string[] = [];
    let errorMessage = '';

    try {
      // 2. Insert chat_sessions
      const sessionDoc: Record<string, unknown> = {
        _id: newSessionId,
        title: bundleSession?.title ? `${bundleSession.title} (imported)` : 'Imported replay',
        status: 'active',
        messageCount: 0,
        lastMessageAt: new Date(),
        totalCostUsd: 0,
        provider: bundleSession?.provider as string ?? 'claude',
        model: bundleSession?.model as string | undefined,
        source: 'ui',
        isImported: true,
        importBundleId: bundleId,
        sourceEnvironment: sourceEnv
          ? {
              appName: sourceEnv.appName as string ?? 'Allen',
              appVersion: sourceEnv.appVersion as string ?? 'dev',
              hostname: sourceEnv.hostname as string | undefined,
              exportedAt: sourceEnv.exportedAt as string | undefined,
            }
          : { appName: 'Allen', appVersion: 'dev' },
        sourceSessionId: bundleSession?._sourceId as string | undefined ?? (bundle.session as Record<string, unknown>)?._sourceId as string | undefined,
        replayLabel: 'Imported replay',
        ownerUserId: userId,
        createdAt: now,
        updatedAt: now,
      };
      await this.db.collection('chat_sessions').insertOne(sessionDoc);
      insertedCollections.push('chat_sessions');

      // 3. Insert chat_messages
      const bundleMessages = bundle.messages as Array<Record<string, unknown>> ?? [];
      for (const msg of bundleMessages) {
        const sourceId = msg._sourceId as string | undefined;
        const newId = new ObjectId();
        if (sourceId) remap.messages.set(sourceId, newId.toString());

        const toolCalls = msg.toolCalls as Array<Record<string, unknown>> | undefined;
        const doc: Record<string, unknown> = {
          _id: newId,
          sessionId: sessionIdStr,
          role: msg.role as string ?? 'user',
          content: msg.content as string ?? '',
          status: msg.status as string ?? 'completed',
          senderUserId: msg.senderUserId as string | undefined,
          senderName: msg.senderName as string | undefined,
          senderEmail: msg.senderEmail as string | undefined,
          costUsd: msg.costUsd as number | undefined,
          durationMs: msg.durationMs as number | undefined,
          tokenUsage: msg.tokenUsage as Record<string, unknown> | undefined ?? null,
          error: msg.error as string | undefined,
          thinkingText: msg.thinkingText as string | undefined,
          toolCalls: toolCalls && toolCalls.length > 0 ? toolCalls : undefined,
          hidden: msg.hidden as boolean | undefined,
          createdAt: msg.createdAt ? new Date(msg.createdAt as string) : now,
          completedAt: msg.completedAt ? new Date(msg.completedAt as string) : undefined,
        };
        await this.db.collection('chat_messages').insertOne(doc);
      }
      insertedCollections.push('chat_messages');

      // 4. Insert chat_logs
      const bundleChatLogs = bundle.chatLogs as Array<Record<string, unknown>> ?? [];
      for (const log of bundleChatLogs) {
        const sourceId = log._sourceId as string | undefined;
        const newId = new ObjectId();
        if (sourceId) remap.executionLogs.set(sourceId, newId.toString());
        await this.db.collection('chat_logs').insertOne({
          _id: newId,
          sessionId: sessionIdStr,
          provider: log.provider as string ?? 'claude',
          model: log.model as string | undefined,
          trace: log.trace as unknown ?? null,
          toolCalls: log.toolCalls as unknown[] | undefined,
          costUsd: log.costUsd as number | undefined,
          durationMs: log.durationMs as number | undefined,
          status: log.status as string ?? 'completed',
          createdAt: log.createdAt ? new Date(log.createdAt as string) : now,
        });
      }
      if (bundleChatLogs.length > 0) insertedCollections.push('chat_logs');

      // 5. Insert executions (remapped + meta.imported: true)
      // Flatten execution tree
      function flattenExecs(nodes: Record<string, unknown>[], parentId?: string, rootId?: string): Array<Record<string, unknown>> {
        const result: Array<Record<string, unknown>> = [];
        for (const node of nodes) {
          const execId = node._sourceId as string ?? randomUUID();
          const newExecId = randomUUID();
          remap.executions.set(execId, newExecId);
          remap.executions.set(node._sourceWorkflowRunId as string ?? execId, newExecId);

          const children = node.childExecutions as Record<string, unknown>[] | undefined;
          result.push({
            id: newExecId,
            workflowName: node.workflowName as string | undefined,
            agentName: node.agentName as string | undefined,
            executionType: node.executionType as string ?? 'workflow',
            status: node.status as string ?? 'completed',
            startedAt: node.startedAt ? new Date(node.startedAt as string) : undefined,
            completedAt: node.completedAt ? new Date(node.completedAt as string) : undefined,
            totalCostUsd: node.costUsd as number ?? 0,
            parentExecutionId: parentId ?? undefined,
            rootExecutionId: rootId ?? undefined,
            meta: {
              imported: true,
              summary: node.summary as string | undefined,
              finalResponse: node.finalResponse as string | undefined,
              _sourceId: execId,
            },
            errorMessage: node.errorMessage as string | undefined,
            createdAt: now,
            updatedAt: now,
          });

          if (children && children.length > 0) {
            result.push(...flattenExecs(children, newExecId, rootId ?? newExecId));
          }
        }
        return result;
      }

      const bundleExecs = bundle.executions as Record<string, unknown>[] ?? [];
      const flatExecs = flattenExecs(bundleExecs);
      for (const exec of flatExecs) {
        // Set chatSessionId in meta
        const meta = (exec.meta as Record<string, unknown>) ?? {};
        meta.chatSessionId = sessionIdStr;
        exec.meta = meta;
        exec.revision = typeof exec.revision === 'number' ? exec.revision : 1;
        exec.runGeneration = typeof exec.runGeneration === 'number' ? exec.runGeneration : 1;
        exec.updatedAt = exec.updatedAt ?? now;
        await this.db.collection('executions').insertOne(exec);
      }
      if (flatExecs.length > 0) insertedCollections.push('executions');

      // Build set of old → new execution IDs
      const oldExecIds = new Set<string>();
      collectExecIds(bundleExecs, oldExecIds);

      // 6. Insert execution_logs
      const bundleExecLogs = bundle.executionLogs as Array<Record<string, unknown>> ?? [];
      for (const el of bundleExecLogs) {
        const oldExecId = el.executionId as string;
        const newExecId = remap.executions.get(oldExecId);
        if (!newExecId) continue;
        const sourceId = el._sourceId as string | undefined;
        const newId = new ObjectId();
        if (sourceId) remap.executionLogs.set(sourceId, newId.toString());
        const doc: Record<string, unknown> = {
          _id: newId,
          executionId: newExecId,
          level: el.level as string ?? 'info',
          category: el.category as string | undefined,
          message: el.message as string ?? '',
          timestamp: el.timestamp ? new Date(el.timestamp as string) : now,
        };
        // Omit _sourceId, executionId already remapped
        delete doc._sourceId;
        await this.db.collection('execution_logs').insertOne(doc);
      }
      if (bundleExecLogs.length > 0) insertedCollections.push('execution_logs');

      // 7. Insert execution_traces
      const bundleExecTraces = bundle.executionTraces as Array<Record<string, unknown>> ?? [];
      for (const et of bundleExecTraces) {
        const oldExecId = et.executionId as string;
        const newExecId = remap.executions.get(oldExecId);
        if (!newExecId) continue;
        const sourceId = et._sourceId as string | undefined;
        const newId = new ObjectId();
        if (sourceId) remap.executionTraces.set(sourceId, newId.toString());
        delete et._sourceId;
        await this.db.collection('execution_traces').insertOne({
          _id: newId,
          executionId: newExecId,
          nodeName: et.nodeName as string ?? '',
          prompt: et.prompt as string | undefined,
          response: et.response as string | undefined,
          outputs: et.outputs as unknown | undefined,
          costUsd: et.costUsd as number | undefined,
          durationMs: et.durationMs as number | undefined,
        });
      }
      if (bundleExecTraces.length > 0) insertedCollections.push('execution_traces');

      // 8. Insert artifacts
      const bundleArtifacts = bundle.artifacts as Array<Record<string, unknown>> ?? [];
      for (const art of bundleArtifacts) {
        const sourceId = art._sourceId as string | undefined;
        const newArtifactId = randomUUID();
        if (sourceId) remap.artifacts.set(sourceId, newArtifactId);

        const filename = art.filename as string ?? 'unknown.txt';
        const contentType = art.contentType as string ?? 'text';
        const content = art.content as string | undefined;

        try {
          await this.artifactService.save({
            rootType: 'chat',
            rootId: sessionIdStr,
            filename,
            content: content ?? 'Imported artifact (content not included in export)',
            contentType: contentType as ArtifactContentType ?? 'text',
            description: art.description as string | undefined,
            language: art.language as string | undefined,
            createdByUserId: userId,
            overwrite: false,
          });
        } catch {
          // Skip artifact if save fails (e.g. duplicate)
        }
      }
      if (bundleArtifacts.length > 0) insertedCollections.push('artifacts');

      // 9. Insert workflow_interventions
      const bundleInterventions = bundle.interventions as Array<Record<string, unknown>> ?? [];
      for (const iv of bundleInterventions) {
        const sourceId = iv._sourceId as string | undefined;
        const newId = new ObjectId();
        if (sourceId) remap.interventions.set(sourceId, newId.toString());

        const oldExecId = iv.executionId as string;
        const newExecId = remap.executions.get(oldExecId);

        await this.db.collection('workflow_interventions').insertOne({
          _id: newId,
          workflow_run_id: newExecId ?? oldExecId,
          chat_session_id: sessionIdStr,
          stage: iv.stage as string ?? '',
          severity: iv.severity as string ?? 'question',
          title: iv.title as string ?? '',
          question: iv.question as string ?? '',
          status: iv.status as string ?? 'pending',
          decision: iv.decision as string | undefined,
          feedback: iv.feedback as string | undefined,
          created_at: iv.created_at ? new Date(iv.created_at as string) : now,
          answered_at: iv.answered_at ? new Date(iv.answered_at as string) : undefined,
        });
      }
      if (bundleInterventions.length > 0) insertedCollections.push('workflow_interventions');

      // 10. Insert code-diff snapshots
      const bundleCodeDiffs = bundle.codeDiffs as Array<Record<string, unknown>> ?? [];
      for (const cd of bundleCodeDiffs) {
        const sourceId = cd._sourceId as string | undefined;
        const newId = new ObjectId();
        if (sourceId) remap.codeDiffs.set(sourceId, newId.toString());

        const files = cd.files as Array<Record<string, unknown>> ?? [];
        await this.db.collection('chat_code_diff_snapshots').insertOne({
          _id: newId,
          chatSessionId: sessionIdStr,
          parentMessageId: cd.parentMessageId as string | undefined,
          files: files.map(f => ({
            filename: f.filename as string ?? '',
            language: f.language as string | undefined,
            additions: (f.additions as number) ?? 0,
            deletions: (f.deletions as number) ?? 0,
          })),
          createdAt: cd.createdAt ? new Date(cd.createdAt as string) : now,
          updatedAt: now,
        });
      }
      if (bundleCodeDiffs.length > 0) insertedCollections.push('chat_code_diff_snapshots');

      // 11. Insert execution_watchers (resolved)
      const bundleWatchers = bundle.watchers as Array<Record<string, unknown>> ?? [];
      for (const w of bundleWatchers) {
        const sourceId = w._sourceId as string | undefined;
        const newWatcherId = randomUUID();
        if (sourceId) remap.watchers.set(sourceId, newWatcherId);

        const oldExecId = w.executionId as string;
        const newExecId = remap.executions.get(oldExecId);

        await this.db.collection('execution_watchers').insertOne({
          watcherId: newWatcherId,
          executionId: newExecId ?? oldExecId,
          chatSessionId: sessionIdStr,
          executionType: w.executionType as string ?? 'workflow',
          watcherStatus: 'resolved',
          executionState: w.executionState as string ?? 'completed',
          latestStatusText: w.latestStatusText as string ?? '',
          lastCheckedAt: now,
          createdAt: now,
          updatedAt: now,
        });
      }
      if (bundleWatchers.length > 0) insertedCollections.push('execution_watchers');

      // 12. Update messageCount
      await this.db.collection('chat_sessions').updateOne(
        { _id: newSessionId },
        { $set: { messageCount: bundleMessages.length, updatedAt: new Date() } },
      );

      // 13. Finalize bundle
      await this.db.collection('chat_export_bundles').updateOne(
        { bundleId },
        {
          $set: {
            status: 'completed',
            chatSessionId: sessionIdStr,
            importSessionId: sessionIdStr,
            updatedAt: new Date(),
          },
        },
      );

      logger.info('[chat.import] Import completed', {
        component: 'chat-import',
        bundleId,
        sessionId: sessionIdStr,
        messageCount: bundleMessages.length,
        executionCount: flatExecs.length,
      });

      return {
        imported: true,
        sessionId: sessionIdStr,
        session: sessionDoc as Record<string, unknown>,
        remappedCounts: {
          messages: bundleMessages.length,
          executions: flatExecs.length,
          executionLogs: bundleExecLogs.length,
          executionTraces: bundleExecTraces.length,
          artifacts: bundleArtifacts.length,
          codeDiffs: bundleCodeDiffs.length,
          interventions: bundleInterventions.length,
          watchers: bundleWatchers.length,
        },
      };
    } catch (err) {
      errorMessage = (err as Error).message;

      // Rollback — delete inserted records in reverse order
      const rollbackOrder = [
        'execution_watchers',
        'workflow_interventions',
        'chat_code_diff_snapshots',
        'artifacts',
        'execution_traces',
        'execution_logs',
        'executions',
        'chat_logs',
        'chat_messages',
        'chat_sessions',
      ];

      const rolledBackSteps: string[] = [];
      for (const col of rollbackOrder) {
        if (!insertedCollections.includes(col)) continue;
        try {
          if (col === 'chat_sessions') {
            await this.db.collection(col).deleteOne({ _id: newSessionId });
          } else if (col === 'executions') {
            await this.db.collection(col).deleteMany({ 'meta.chatSessionId': sessionIdStr });
          } else if (col === 'chat_messages' || col === 'chat_logs') {
            await this.db.collection(col).deleteMany({ sessionId: sessionIdStr });
          } else if (col === 'workflow_interventions') {
            await this.db.collection(col).deleteMany({ chat_session_id: sessionIdStr });
          } else if (col === 'chat_code_diff_snapshots') {
            await this.db.collection(col).deleteMany({ chatSessionId: sessionIdStr });
          } else if (col === 'execution_watchers') {
            await this.db.collection(col).deleteMany({ chatSessionId: sessionIdStr });
          } else if (col === 'execution_logs' || col === 'execution_traces') {
            // Already covered by executionIds remap deletion
            await this.db.collection(col).deleteMany({ executionId: { $in: [...remap.executions.values()] } });
          } else if (col === 'artifacts') {
            await this.db.collection(col).deleteMany({ rootType: 'chat', rootId: sessionIdStr });
          }
          rolledBackSteps.push(col);
        } catch (rollbackErr) {
          logger.error('[chat.import] Rollback failed for collection', {
            component: 'chat-import',
            collection: col,
            error: (rollbackErr as Error).message,
          });
        }
      }

      // Mark bundle as rolled_back
      await this.db.collection('chat_export_bundles').updateOne(
        { bundleId },
        {
          $set: {
            status: 'rolled_back',
            error: errorMessage,
            rolledBackSteps,
            updatedAt: new Date(),
          },
        },
      );

      logger.error('[chat.import] Import failed — rolled back', {
        component: 'chat-import',
        bundleId,
        error: errorMessage,
        rolledBackSteps,
      });

      throw Object.assign(new Error('Failed to persist imported data'), {
        statusCode: 500,
        errorCode: 'IMPORT_PERSIST_FAILED',
        detail: errorMessage,
      });
    }
  }
}

function collectExecIds(nodes: Record<string, unknown>[], ids: Set<string>): void {
  for (const node of nodes) {
    const sourceId = node._sourceId as string | undefined;
    if (sourceId) ids.add(sourceId);
    const wfRunId = node._sourceWorkflowRunId as string | undefined;
    if (wfRunId) ids.add(wfRunId);
    const children = node.childExecutions as Record<string, unknown>[] | undefined;
    if (children) collectExecIds(children, ids);
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
