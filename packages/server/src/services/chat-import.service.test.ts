/**
 * Tests for ChatImportService — unit + integration.
 *
 * Unit: hasXssPayloads() — pure function, no DB.
 * Integration: preview() and confirm() — require MongoMemoryServer.
 *
 * @see PRD AC17 (bundle validation), AC5 (preview), AC6/7 (replay state),
 *      AC8 (tool calls), AC9 (chat logs), AC10 (executions), AC11 (child execs),
 *      AC13 (source refs), AC15 (resolved watchers)
 */

import { describe, expect, it, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { MongoClient, type Db, ObjectId } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { hasXssPayloads, ChatImportService } from './chat-import.service.js';
import type { ChatExportBundle } from './chat-export.service.js';

// ── hasXssPayloads — pure function, no DB ─────────────────────────────────

describe('hasXssPayloads()', () => {
  it('returns false for inert script-like text', () => {
    expect(hasXssPayloads('<script>alert("xss")</script>')).toBe(false);
  });

  it('returns false for inert protocol-like text', () => {
    expect(hasXssPayloads('javascript:alert(1)')).toBe(false);
  });

  it('returns false for inert event-handler-like text', () => {
    expect(hasXssPayloads('onerror=alert(1)')).toBe(false);
    expect(hasXssPayloads('onclick="evil()"')).toBe(false);
  });

  it('returns false for normal content', () => {
    expect(hasXssPayloads('Hello, this is a normal message')).toBe(false);
  });

  it('rejects unsafe markdown links in nested content', () => {
    const obj = {
      level1: {
        level2: {
          content: '[click](javascript:alert("xss"))',
        },
      },
    };
    expect(hasXssPayloads(obj)).toBe(true);
  });

  it('rejects unsafe URL-like fields in arrays recursively', () => {
    const arr = ['normal', { href: 'javascript:evil()' }];
    expect(hasXssPayloads(arr)).toBe(true);
  });

  it('returns false for numbers, booleans, null, undefined', () => {
    expect(hasXssPayloads(null)).toBe(false);
    expect(hasXssPayloads(undefined)).toBe(false);
    expect(hasXssPayloads(42)).toBe(false);
    expect(hasXssPayloads(true)).toBe(false);
  });

  it('returns false for empty object and empty array', () => {
    expect(hasXssPayloads({})).toBe(false);
    expect(hasXssPayloads([])).toBe(false);
  });

  it('allows unsafe-looking text inside fenced code blocks', () => {
    expect(hasXssPayloads('```html\n<a href="javascript:alert(1)">demo</a>\n```')).toBe(false);
  });

  it('allows unsafe-looking text inside inline code', () => {
    expect(hasXssPayloads('Use `[demo](javascript:alert(1))` as a test case')).toBe(false);
  });

  it('rejects unsafe source link fields', () => {
    expect(hasXssPayloads({ _sourceLinks: { chatPage: 'javascript:alert(1)' } })).toBe(true);
  });
});

// ── ChatImportService integration tests ────────────────────────────────────

describe('ChatImportService', () => {
  let mongo: MongoMemoryServer;
  let client: MongoClient;
  let db: Db;
  let service: ChatImportService;

  // Helper: produce a minimal valid bundle
  function minimalBundle(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      bundleVersion: 1,
      exportedAt: new Date().toISOString(),
      exportedBy: 'user-123',
      sourceEnvironment: { appName: 'Allen', appVersion: '1.0.0' },
      redactions: { pathsRedacted: false, identityRedacted: false, secretsRedacted: false, rawTracesExcluded: false, artifactsExcluded: false, thinkingExcluded: false },
      session: {
        title: 'Test Chat',
        status: 'active',
        messageCount: 1,
        totalCostUsd: 0,
        provider: 'claude',
        model: 'claude-sonnet-4',
        createdAt: new Date().toISOString(),
        lastMessageAt: new Date().toISOString(),
        _sourceId: 'orig-session-id',
      },
      messages: [
        {
          role: 'user',
          content: 'Hello',
          status: 'completed',
          createdAt: new Date().toISOString(),
          _sourceId: 'msg-1',
        },
      ],
      chatLogs: [],
      executions: [],
      executionLogs: [],
      executionTraces: [],
      artifacts: [],
      interventions: [],
      watchers: [],
      ...overrides,
    };
  }

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    client = new MongoClient(mongo.getUri());
    await client.connect();
    db = client.db('chat-import-test');
  });

  afterAll(async () => {
    await client.close();
    await mongo.stop();
  });

  beforeEach(async () => {
    const collections = await db.listCollections().toArray();
    for (const col of collections) {
      await db.collection(col.name).deleteMany({});
    }
    service = new ChatImportService(db);
  });

  // ── preview() — validation tests ────────────────────────────────────────

  describe('preview() — validation', () => {
    it('rejects invalid JSON string → IMPORT_INVALID_JSON', async () => {
      await expect(service.preview('not json at all', 'user-1')).rejects.toMatchObject({
        errorCode: 'IMPORT_INVALID_JSON',
        statusCode: 400,
      });
    });

    it('rejects bundleVersion 0 → IMPORT_UNSUPPORTED_VERSION', async () => {
      const bundle = minimalBundle({ bundleVersion: 0 });
      await expect(service.preview(bundle, 'user-1')).rejects.toMatchObject({
        errorCode: 'IMPORT_UNSUPPORTED_VERSION',
        statusCode: 400,
      });
    });

    it('rejects bundle without bundleVersion field → IMPORT_UNSUPPORTED_VERSION', async () => {
      const { bundleVersion: _, ...noVersion } = minimalBundle();
      await expect(service.preview(noVersion, 'user-1')).rejects.toMatchObject({
        errorCode: 'IMPORT_UNSUPPORTED_VERSION',
        statusCode: 400,
      });
    });

    it('rejects missing session field → IMPORT_MISSING_FIELDS', async () => {
      const { session: _, ...noSession } = minimalBundle();
      await expect(service.preview(noSession, 'user-1')).rejects.toMatchObject({
        errorCode: 'IMPORT_MISSING_FIELDS',
        statusCode: 400,
      });
    });

    it('rejects missing messages → IMPORT_MISSING_FIELDS', async () => {
      const { messages: _, ...noMsgs } = minimalBundle();
      await expect(service.preview(noMsgs, 'user-1')).rejects.toMatchObject({
        errorCode: 'IMPORT_MISSING_FIELDS',
        statusCode: 400,
      });
    });

    it('rejects empty messages array → IMPORT_MISSING_FIELDS', async () => {
      const bundle = minimalBundle({ messages: [] });
      await expect(service.preview(bundle, 'user-1')).rejects.toMatchObject({
        errorCode: 'IMPORT_MISSING_FIELDS',
        statusCode: 400,
      });
    });

    it('rejects message with invalid role → IMPORT_MISSING_FIELDS', async () => {
      const bundle = minimalBundle({
        messages: [{ role: 'system', content: 'beep', createdAt: new Date().toISOString() }],
      });
      await expect(service.preview(bundle, 'user-1')).rejects.toMatchObject({
        errorCode: 'IMPORT_MISSING_FIELDS',
        statusCode: 400,
      });
    });

    it('accepts inert script-like text in message content', async () => {
      const bundle = minimalBundle({
        messages: [
          { role: 'user', content: '<script>alert("xss")</script>', createdAt: new Date().toISOString() },
        ],
      });
      const result = await service.preview(bundle, 'user-1');
      expect(result.valid).toBe(true);
    });

    it('rejects unsafe markdown link in message content → IMPORT_XSS_REJECTED', async () => {
      const bundle = minimalBundle({
        messages: [
          { role: 'user', content: '[click me](javascript:alert("xss"))', createdAt: new Date().toISOString() },
        ],
      });
      await expect(service.preview(bundle, 'user-1')).rejects.toMatchObject({
        errorCode: 'IMPORT_XSS_REJECTED',
        statusCode: 400,
      });
    });

    it('rejects unsafe source link fields → IMPORT_XSS_REJECTED', async () => {
      const bundle = minimalBundle({
        session: {
          ...(minimalBundle().session as Record<string, unknown>),
          _sourceLinks: { chatPage: 'javascript:alert(1)' },
        },
      });
      await expect(service.preview(bundle, 'user-1')).rejects.toMatchObject({
        errorCode: 'IMPORT_XSS_REJECTED',
        statusCode: 400,
      });
    });

    // Size-limit test lives in chat-import.size-limit.test.ts
    // because IMPORT_MAX_BYTES is a module-level const that must be set
    // before module import.

    it('accepts valid bundle and returns preview with correct structure', async () => {
      const bundle = minimalBundle({
        sourceEnvironment: { appName: 'Allen', appVersion: '2.0.0', hostname: 'my-host' },
        redactions: {
          pathsRedacted: true,
          secretsRedacted: true,
          identityRedacted: false,
          rawTracesExcluded: false,
          artifactsExcluded: false,
          thinkingExcluded: false,
        },
        executions: [
          { _sourceId: 'exec-1', status: 'completed', executionType: 'workflow', workflowName: 'test-wf' },
        ],
        artifacts: [{ filename: 'plan.md', contentType: 'markdown', sizeBytes: 50, createdAt: new Date().toISOString() }],
        chatLogs: [{ provider: 'claude', status: 'completed', createdAt: new Date().toISOString() }],
      });

      const result = await service.preview(bundle, 'user-1');

      expect(result.valid).toBe(true);
      expect(result.bundleId).toBeTruthy();
      expect(result.preview.title).toBe('Test Chat');
      expect(result.preview.messageCount).toBe(1);
      expect(result.preview.executionCount).toBe(1);
      expect(result.preview.artifactCount).toBe(1);
      expect(result.preview.bundleVersion).toBe(1);
      expect(result.preview.sourceEnvironment).toMatchObject({ appName: 'Allen', appVersion: '2.0.0' });
      expect(result.preview.importsAs).toBe('read-only replay');
      expect(result.preview.estimatedImportedSize).toBeGreaterThan(0);

      // Warnings for redactions
      expect(result.preview.warnings.length).toBeGreaterThanOrEqual(2);

      // Verify bundle was persisted as 'preview'
      const bundleRow = await db.collection('chat_export_bundles').findOne({ bundleId: result.bundleId });
      expect(bundleRow).toBeTruthy();
      expect(bundleRow!.status).toBe('preview');
      expect(bundleRow!.operation).toBe('import');
    });
  });

  // ── confirm() — error cases ─────────────────────────────────────────────

  describe('confirm() — error cases', () => {
    it('rejects missing bundleId → IMPORT_BUNDLE_NOT_FOUND', async () => {
      await expect(service.confirm('nonexistent-bundle-id', 'user-1')).rejects.toMatchObject({
        errorCode: 'IMPORT_BUNDLE_NOT_FOUND',
        statusCode: 400,
      });
    });

    it('rejects already-completed bundle → IMPORT_ALREADY_COMPLETED', async () => {
      const bundle = minimalBundle();
      const previewResult = await service.preview(bundle, 'user-1');
      // Manually mark as completed
      await db.collection('chat_export_bundles').updateOne(
        { bundleId: previewResult.bundleId },
        { $set: { status: 'completed', importSessionId: 'existing-session-id' } },
      );
      await expect(service.confirm(previewResult.bundleId, 'user-1')).rejects.toMatchObject({
        errorCode: 'IMPORT_ALREADY_COMPLETED',
        statusCode: 400,
        existingSessionId: 'existing-session-id',
      });
    });

    it('rejects rolled_back bundle → IMPORT_BUNDLE_ROLLED_BACK', async () => {
      const bundle = minimalBundle();
      const previewResult = await service.preview(bundle, 'user-1');
      await db.collection('chat_export_bundles').updateOne(
        { bundleId: previewResult.bundleId },
        { $set: { status: 'rolled_back' } },
      );
      await expect(service.confirm(previewResult.bundleId, 'user-1')).rejects.toMatchObject({
        errorCode: 'IMPORT_BUNDLE_ROLLED_BACK',
        statusCode: 400,
      });
    });
  });

  // ── confirm() — happy path ──────────────────────────────────────────────

  describe('confirm() — happy path', () => {
    const userId = 'user-123';

    it('creates a chat session with isImported: true, source refs, and replay label (AC6, AC13)', async () => {
      const bundle = minimalBundle({
        sourceEnvironment: { appName: 'Allen', appVersion: '1.0.0' },
        session: {
          title: 'Original Chat',
          status: 'active',
          messageCount: 1,
          totalCostUsd: 0.5,
          provider: 'claude',
          model: 'claude-sonnet-4',
          createdAt: new Date('2025-01-01').toISOString(),
          lastMessageAt: new Date('2025-01-02').toISOString(),
          _sourceId: 'orig-session-abc',
        },
      });

      const previewResult = await service.preview(bundle, userId);
      const confirmResult = await service.confirm(previewResult.bundleId, userId);

      expect(confirmResult.imported).toBe(true);
      expect(confirmResult.sessionId).toBeTruthy();
      expect(confirmResult.session.isImported).toBe(true);
      expect(confirmResult.session.importBundleId).toBe(previewResult.bundleId);
      expect(confirmResult.session.sourceEnvironment).toMatchObject({
        appName: 'Allen',
        appVersion: '1.0.0',
      });
      expect(confirmResult.session.sourceSessionId).toBe('orig-session-abc');
      expect(confirmResult.session.replayLabel).toBe('Imported replay');

      // DB check
      const sessionDoc = await db.collection('chat_sessions').findOne({ _id: new ObjectId(confirmResult.sessionId) });
      expect(sessionDoc).toBeTruthy();
      expect(sessionDoc!.isImported).toBe(true);
      expect(sessionDoc!.importBundleId).toBe(previewResult.bundleId);
      expect(sessionDoc!.sourceSessionId).toBe('orig-session-abc');
    });

    it('preserves all messages with original timestamps and content (AC7)', async () => {
      const bundle = minimalBundle({
        messages: [
          {
            role: 'user',
            content: 'First message',
            status: 'completed',
            createdAt: new Date('2025-01-01T10:00:00Z').toISOString(),
            _sourceId: 'msg-1',
          },
          {
            role: 'assistant',
            content: 'Second message',
            status: 'completed',
            createdAt: new Date('2025-01-01T10:01:00Z').toISOString(),
            _sourceId: 'msg-2',
          },
        ],
      });

      const previewResult = await service.preview(bundle, userId);
      const confirmResult = await service.confirm(previewResult.bundleId, userId);

      expect(confirmResult.remappedCounts.messages).toBe(2);

      const messages = await db.collection('chat_messages')
        .find({ sessionId: confirmResult.sessionId })
        .sort({ createdAt: 1 })
        .toArray();

      expect(messages).toHaveLength(2);
      expect(messages[0].content).toBe('First message');
      expect(messages[0].role).toBe('user');
      expect(messages[0].createdAt).toEqual(new Date('2025-01-01T10:00:00Z'));
      expect(messages[1].content).toBe('Second message');
      expect(messages[1].role).toBe('assistant');
      expect(messages[1].createdAt).toEqual(new Date('2025-01-01T10:01:00Z'));
    });

    it('preserves tool calls round-trip (AC8)', async () => {
      const bundle = minimalBundle({
        messages: [
          {
            role: 'assistant',
            content: 'Let me search for that',
            status: 'completed',
            createdAt: new Date('2025-01-01T10:00:00Z').toISOString(),
            _sourceId: 'msg-tc-1',
            toolCalls: [
              {
                tool: 'bash',
                args: { command: 'ls -la' },
                result: { stdout: 'file1.txt\nfile2.txt', exitCode: 0 },
                durationMs: 1200,
                timestamp: new Date('2025-01-01T10:00:01Z').toISOString(),
              },
              {
                tool: 'read_file',
                args: { path: '/tmp/test.txt' },
                result: { content: 'hello world' },
                durationMs: 300,
                timestamp: new Date('2025-01-01T10:00:02Z').toISOString(),
              },
            ],
          },
        ],
      });

      const previewResult = await service.preview(bundle, userId);
      const confirmResult = await service.confirm(previewResult.bundleId, userId);

      expect(confirmResult.remappedCounts.messages).toBe(1);

      const messages = await db.collection('chat_messages')
        .find({ sessionId: confirmResult.sessionId })
        .toArray();

      expect(messages).toHaveLength(1);
      const msg = messages[0];
      expect(msg.toolCalls).toBeDefined();
      expect(msg.toolCalls).toHaveLength(2);
      expect(msg.toolCalls[0].tool).toBe('bash');
      expect(msg.toolCalls[0].args.command).toBe('ls -la');
      expect(msg.toolCalls[0].result.stdout).toBe('file1.txt\nfile2.txt');
      expect(msg.toolCalls[0].durationMs).toBe(1200);
      expect(msg.toolCalls[1].tool).toBe('read_file');
    });

    it('preserves chat_logs round-trip (AC9)', async () => {
      const bundle = minimalBundle({
        chatLogs: [
          {
            provider: 'claude',
            model: 'claude-sonnet-4',
            trace: { input: 'hello', output: 'hi' },
            toolCalls: [{ tool: 'bash', args: {} }],
            costUsd: 0.01,
            durationMs: 500,
            status: 'completed',
            createdAt: new Date('2025-01-01T10:00:00Z').toISOString(),
            _sourceId: 'log-1',
          },
          {
            provider: 'claude',
            model: 'claude-sonnet-4',
            trace: { input: 'run workflow', output: 'done' },
            costUsd: 0.02,
            durationMs: 3000,
            status: 'completed',
            createdAt: new Date('2025-01-01T10:01:00Z').toISOString(),
            _sourceId: 'log-2',
          },
        ],
      });

      const previewResult = await service.preview(bundle, userId);
      const confirmResult = await service.confirm(previewResult.bundleId, userId);

      // remappedCounts.executionLogs counts execution_logs (not chat_logs)
      // There were no execution_logs in the bundle, so it's 0 — chat_logs round-trip is separate

      const chatLogs = await db.collection('chat_logs')
        .find({ sessionId: confirmResult.sessionId })
        .sort({ createdAt: 1 })
        .toArray();

      expect(chatLogs).toHaveLength(2);
      expect(chatLogs[0].provider).toBe('claude');
      expect(chatLogs[0].trace).toMatchObject({ input: 'hello', output: 'hi' });
      expect(chatLogs[0].costUsd).toBe(0.01);
    });

    it('inserts executions with meta.imported: true and meta.chatSessionId (AC10)', async () => {
      const bundle = minimalBundle({
        executions: [
          {
            _sourceId: 'exec-root-1',
            _sourceWorkflowRunId: 'wf-run-1',
            executionType: 'workflow',
            workflowName: 'test-workflow',
            status: 'completed',
            startedAt: new Date('2025-01-01T10:00:00Z').toISOString(),
            completedAt: new Date('2025-01-01T10:05:00Z').toISOString(),
            costUsd: 0.1,
            summary: 'Completed successfully',
            childExecutions: [
              {
                _sourceId: 'exec-child-1',
                executionType: 'agent',
                agentName: 'coder',
                status: 'completed',
                costUsd: 0.05,
                summary: 'Code written',
              },
            ],
          },
        ],
      });

      const previewResult = await service.preview(bundle, userId);
      const confirmResult = await service.confirm(previewResult.bundleId, userId);

      expect(confirmResult.remappedCounts.executions).toBe(2);

      const execs = await db.collection('executions')
        .find({ 'meta.chatSessionId': confirmResult.sessionId })
        .toArray();

      expect(execs).toHaveLength(2);

      // Root execution
      const rootExec = execs.find(e => !e.parentExecutionId);
      expect(rootExec).toBeTruthy();
      expect(rootExec!.meta.imported).toBe(true);
      expect(rootExec!.meta.chatSessionId).toBe(confirmResult.sessionId);
      expect(rootExec!.meta.summary).toBe('Completed successfully');

      // Child execution
      const childExec = execs.find(e => e.parentExecutionId);
      expect(childExec).toBeTruthy();
      expect(childExec!.meta.imported).toBe(true);
      expect(childExec!.rootExecutionId).toBe(rootExec!.id);
      expect(childExec!.parentExecutionId).toBe(rootExec!.id);
    });

    it('persists watchers with watcherStatus resolved (AC15)', async () => {
      const bundle = minimalBundle({
        executions: [
          {
            _sourceId: 'exec-w-1',
            executionType: 'workflow',
            workflowName: 'wf',
            status: 'completed',
          },
        ],
        watchers: [
          {
            _sourceId: 'watcher-1',
            executionId: 'exec-w-1',
            executionType: 'workflow',
            watcherStatus: 'active',
            executionState: 'running',
            latestStatusText: 'Running...',
            lastCheckedAt: new Date().toISOString(),
          },
        ],
      });

      const previewResult = await service.preview(bundle, userId);
      await service.confirm(previewResult.bundleId, userId);

      const watchers = await db.collection('execution_watchers').find({}).toArray();
      expect(watchers).toHaveLength(1);
      expect(watchers[0].watcherStatus).toBe('resolved');
      expect(watchers[0].chatSessionId).toBeTruthy();
    });

    it('persists interventions, code diffs, and execution log/traces', async () => {
      const bundle = minimalBundle({
        executions: [
          {
            _sourceId: 'exec-full-1',
            executionType: 'workflow',
            workflowName: 'full-wf',
            status: 'completed',
            startedAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
            costUsd: 0.1,
          },
        ],
        executionLogs: [
          {
            executionId: 'exec-full-1',
            level: 'info',
            category: 'test',
            message: 'Hello from execution log',
            timestamp: new Date().toISOString(),
            _sourceId: 'elog-1',
          },
        ],
        executionTraces: [
          {
            executionId: 'exec-full-1',
            nodeName: 'start',
            prompt: 'Do something',
            response: 'Done',
            costUsd: 0.01,
            durationMs: 100,
            _sourceId: 'etrace-1',
          },
        ],
        interventions: [
          {
            executionId: 'exec-full-1',
            stage: 'human_review',
            severity: 'question',
            title: 'Approve?',
            question: 'Should I continue?',
            status: 'answered',
            decision: 'approve',
            feedback: 'Looks good',
            created_at: new Date().toISOString(),
            answered_at: new Date().toISOString(),
            _sourceId: 'iv-1',
          },
        ],
      });

      const previewResult = await service.preview(bundle, userId);
      const confirmResult = await service.confirm(previewResult.bundleId, userId);

      expect(confirmResult.remappedCounts.executionLogs).toBe(1);
      expect(confirmResult.remappedCounts.executionTraces).toBe(1);
      expect(confirmResult.remappedCounts.interventions).toBe(1);

      // Verify intervention is linked to new execution id
      const interventions = await db.collection('workflow_interventions').find({}).toArray();
      expect(interventions).toHaveLength(1);
      expect(interventions[0].chat_session_id).toBe(confirmResult.sessionId);
      expect(interventions[0].title).toBe('Approve?');

      // Verify code diffs
      // (re-test with codeDiffs populated)
    });

    it('preserves code diffs round-trip', async () => {
      const bundle = minimalBundle({
        codeDiffs: [
          {
            parentMessageId: 'msg-parent',
            files: [
              { filename: 'src/index.ts', language: 'typescript', additions: 10, deletions: 2 },
              { filename: 'src/utils.ts', additions: 3, deletions: 1 },
            ],
            createdAt: new Date().toISOString(),
            _sourceId: 'cdiff-1',
          },
        ],
      });

      const previewResult = await service.preview(bundle, userId);
      const confirmResult = await service.confirm(previewResult.bundleId, userId);

      expect(confirmResult.remappedCounts.codeDiffs).toBe(1);

      const diffs = await db.collection('chat_code_diff_snapshots').find({}).toArray();
      expect(diffs).toHaveLength(1);
      expect(diffs[0].chatSessionId).toBe(confirmResult.sessionId);
      expect(diffs[0].files).toHaveLength(2);
      expect(diffs[0].files[0].filename).toBe('src/index.ts');
      expect(diffs[0].files[0].additions).toBe(10);
    });

    it('inserts artifacts via ArtifactService and they are readable (AC12)', async () => {
      const bundle = minimalBundle({
        artifacts: [
          {
            filename: 'report.md',
            contentType: 'markdown',
            description: 'Generated report',
            content: '# Summary\n\nThe analysis is complete.',
            sizeBytes: 50,
            language: 'markdown',
            createdAt: new Date('2025-01-01T10:00:00Z').toISOString(),
            _sourceId: 'art-1',
            _sourcePublicUrl: 'http://original/artifacts/art-1/content',
          },
        ],
      });

      const previewResult = await service.preview(bundle, userId);
      const confirmResult = await service.confirm(previewResult.bundleId, userId);

      expect(confirmResult.remappedCounts.artifacts).toBe(1);

      // Verify artifact is in the DB with new rootId
      const artifactDocs = await db.collection('artifacts')
        .find({ rootType: 'chat', rootId: confirmResult.sessionId })
        .toArray();
      expect(artifactDocs).toHaveLength(1);
      expect(artifactDocs[0].filename).toBe('report.md');
      expect(artifactDocs[0].contentType).toBe('markdown');
    });

    it('updates bundle status to completed and sets importSessionId', async () => {
      const bundle = minimalBundle();
      const previewResult = await service.preview(bundle, userId);
      const confirmResult = await service.confirm(previewResult.bundleId, userId);

      const bundleRow = await db.collection('chat_export_bundles').findOne({ bundleId: previewResult.bundleId });
      expect(bundleRow).toBeTruthy();
      expect(bundleRow!.status).toBe('completed');
      expect(bundleRow!.importSessionId).toBe(confirmResult.sessionId);
      expect(bundleRow!.chatSessionId).toBe(confirmResult.sessionId);
    });
  });
});
