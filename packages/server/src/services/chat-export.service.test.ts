/**
 * Tests for ChatExportService — integration with MongoMemoryServer.
 *
 * @see PRD AC2 (export produces file), AC3 (no hosted share), AC10/11 (executions),
 *      AC18 (redactions), AC19 (size limit)
 */

import { describe, expect, it, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { MongoClient, type Db, ObjectId } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { ChatExportService, type ExportOptions } from './chat-export.service.js';

describe('ChatExportService', () => {
  let mongo: MongoMemoryServer;
  let client: MongoClient;
  let db: Db;
  let service: ChatExportService;

  const userId = 'test-user-123';

  /** Insert a minimal chat session + related records for export testing. */
  async function seedSession(opts: {
    sessionId?: string;
    title?: string;
    includeExecutions?: boolean;
    includeMessages?: boolean;
    includeChatLogs?: boolean;
    includeInterventions?: boolean;
    includeWatchers?: boolean;
    includeCodeDiffs?: boolean;
    includeChildExecutions?: boolean;
  } = {}): Promise<string> {
    const sessionId = opts.sessionId ?? new ObjectId().toString();
    const sessionOid = new ObjectId(sessionId);

    await db.collection('chat_sessions').insertOne({
      _id: sessionOid,
      title: opts.title ?? 'Test Chat Session',
      status: 'active',
      messageCount: 0,
      lastMessageAt: new Date(),
      totalCostUsd: 0.5,
      provider: 'claude',
      model: 'claude-sonnet-4',
      source: 'ui',
      createdAt: new Date('2025-01-01'),
      updatedAt: new Date('2025-01-02'),
    });

    if (opts.includeMessages !== false) {
      await db.collection('chat_messages').insertMany([
        {
          _id: new ObjectId(),
          sessionId,
          role: 'user',
          content: 'Hello, can you help me?',
          status: 'completed',
          createdAt: new Date('2025-01-01T10:00:00Z'),
          completedAt: new Date('2025-01-01T10:00:01Z'),
        },
        {
          _id: new ObjectId(),
          sessionId,
          role: 'assistant',
          content: 'Sure, let me look into that.',
          status: 'completed',
          createdAt: new Date('2025-01-01T10:00:02Z'),
          completedAt: new Date('2025-01-01T10:00:05Z'),
          costUsd: 0.01,
          durationMs: 3000,
          tokenUsage: { input_tokens: 100, output_tokens: 50 },
          toolCalls: [
            { tool: 'bash', args: { command: 'ls' }, result: { stdout: 'file.txt' }, durationMs: 500, timestamp: '2025-01-01T10:00:03Z' },
          ],
        },
      ]);
    }

    if (opts.includeChatLogs) {
      await db.collection('chat_logs').insertMany([
        {
          _id: new ObjectId(),
          sessionId,
          provider: 'claude',
          model: 'claude-sonnet-4',
          trace: { prompt: 'Hello', response: 'Hi' },
          costUsd: 0.01,
          durationMs: 500,
          status: 'completed',
          createdAt: new Date('2025-01-01T10:00:00Z'),
        },
      ]);
    }

    if (opts.includeExecutions) {
      await db.collection('executions').insertOne({
        id: 'exec-root-1',
        workflowName: 'test-workflow',
        executionType: 'workflow',
        status: 'completed',
        startedAt: new Date('2025-01-01T10:00:00Z'),
        completedAt: new Date('2025-01-01T10:05:00Z'),
        totalCostUsd: 0.1,
        meta: { chatSessionId: sessionId, summary: 'Completed' },
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      await db.collection('execution_logs').insertOne({
        _id: new ObjectId(),
        executionId: 'exec-root-1',
        level: 'info',
        message: 'Workflow started',
        timestamp: new Date('2025-01-01T10:00:00Z'),
      });

      await db.collection('execution_traces').insertOne({
        _id: new ObjectId(),
        executionId: 'exec-root-1',
        nodeName: 'start',
        prompt: 'Init',
        response: 'Done',
        costUsd: 0.01,
        durationMs: 100,
      });

      if (opts.includeChildExecutions) {
        // Child does NOT have meta.chatSessionId — found only via parentExecutionId
        await db.collection('executions').insertOne({
          id: 'exec-child-1',
          agentName: 'coder',
          executionType: 'agent',
          status: 'completed',
          startedAt: new Date('2025-01-01T10:01:00Z'),
          completedAt: new Date('2025-01-01T10:03:00Z'),
          totalCostUsd: 0.05,
          parentExecutionId: 'exec-root-1',
          rootExecutionId: 'exec-root-1',
          meta: { summary: 'Code written' },
          createdAt: new Date(),
          updatedAt: new Date(),
        });

        await db.collection('execution_logs').insertOne({
          _id: new ObjectId(),
          executionId: 'exec-child-1',
          level: 'info',
          message: 'Agent started',
          timestamp: new Date('2025-01-01T10:01:00Z'),
        });
      }
    }

    if (opts.includeInterventions) {
      await db.collection('workflow_interventions').insertOne({
        _id: new ObjectId(),
        workflow_run_id: 'exec-root-1',
        chat_session_id: sessionId,
        stage: 'human_review',
        severity: 'question',
        title: 'Approve changes?',
        question: 'Should I commit?',
        status: 'answered',
        decision: 'approve',
        feedback: 'Looks good',
        created_at: new Date('2025-01-01T10:02:00Z'),
        answered_at: new Date('2025-01-01T10:02:30Z'),
      });
    }

    if (opts.includeWatchers) {
      await db.collection('execution_watchers').insertOne({
        watcherId: 'watcher-1',
        executionId: 'exec-root-1',
        chatSessionId: sessionId,
        executionType: 'workflow',
        watcherStatus: 'active',
        executionState: 'running',
        latestStatusText: 'Test workflow running...',
        lastCheckedAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    }

    if (opts.includeCodeDiffs) {
      await db.collection('chat_code_diff_snapshots').insertOne({
        _id: new ObjectId(),
        chatSessionId: sessionId,
        parentMessageId: 'msg-2',
        files: [
          { filename: 'src/index.ts', additions: 5, deletions: 1 },
        ],
        createdAt: new Date('2025-01-01T10:03:00Z'),
        updatedAt: new Date('2025-01-01T10:03:00Z'),
      });
    }

    return sessionId;
  }

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    client = new MongoClient(mongo.getUri());
    await client.connect();
    db = client.db('chat-export-test');
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
    service = new ChatExportService(db);
  });

  // ── getExportOptions ────────────────────────────────────────────────────

  describe('getExportOptions()', () => {
    it('throws 404 for missing session', async () => {
      await expect(service.getExportOptions(new ObjectId().toString())).rejects.toMatchObject({
        statusCode: 404,
      });
    });

    it('returns counts for session with messages + executions', async () => {
      const sessionId = await seedSession({
        includeExecutions: true,
        includeChildExecutions: true,
        includeChatLogs: true,
      });

      const options = await service.getExportOptions(sessionId);

      expect(options.messageCount).toBe(2);
      expect(options.toolCallCount).toBeGreaterThanOrEqual(1);
      expect(options.executionCount).toBe(1);   // direct execs
      expect(options.descendantExecutionCount).toBe(1); // child
      expect(options.chatLogCount).toBe(1);
      expect(options.estimatedSizeBytes).toBeGreaterThan(0);
    });
  });

  // ── assembleBundle ──────────────────────────────────────────────────────

  describe('assembleBundle()', () => {
    it('throws 404 for missing session', async () => {
      await expect(
        service.assembleBundle(new ObjectId().toString(), {}, userId),
      ).rejects.toMatchObject({ statusCode: 404 });
    });

    it('includes session, messages, chatLogs, executions, logs, traces, interventions, watchers', async () => {
      const sessionId = await seedSession({
        includeExecutions: true,
        includeChildExecutions: true,
        includeChatLogs: true,
        includeInterventions: true,
        includeWatchers: true,
        includeCodeDiffs: true,
      });

      const result = await service.assembleBundle(sessionId, {}, userId);

      expect(result.bundle.bundleVersion).toBe(1);
      expect(result.bundle.session.title).toBe('Test Chat Session');
      expect(result.bundle.session._sourceId).toBeTruthy();
      expect(result.bundle.messages).toHaveLength(2);
      expect(result.bundle.chatLogs).toHaveLength(1);

      // Executions - both root and child should be present
      expect(result.bundle.executions.length).toBeGreaterThanOrEqual(1);
      // The tree should have the root
      const rootExec = result.bundle.executions.find(e => e.workflowName === 'test-workflow');
      expect(rootExec).toBeTruthy();
      expect(rootExec!.childExecutions).toBeDefined();
      expect(rootExec!.childExecutions).toHaveLength(1);
      expect(rootExec!.childExecutions![0].agentName).toBe('coder');

      expect(result.bundle.executionLogs.length).toBeGreaterThanOrEqual(1);
      expect(result.bundle.executionTraces).toHaveLength(1);

      expect(result.bundle.interventions).toHaveLength(1);
      expect(result.bundle.interventions[0].title).toBe('Approve changes?');

      expect(result.bundle.watchers).toHaveLength(1);
      expect(result.bundle.watchers[0].executionId).toBe('exec-root-1');

      expect(result.bundle.codeDiffs).toBeDefined();
      expect(result.bundle.codeDiffs!).toHaveLength(1);
    });

    it('applies path redaction (AC18)', async () => {
      const sessionId = await seedSession();
      // Insert a message with path content
      await db.collection('chat_messages').insertOne({
        _id: new ObjectId(),
        sessionId,
        role: 'user',
        content: 'Path: /Users/foo/secret and /home/bar/config.json on Mac',
        status: 'completed',
        createdAt: new Date(),
      });

      const result = await service.assembleBundle(sessionId, { redactPaths: true, redactSecrets: true }, userId);

      expect(result.bundle.redactions.pathsRedacted).toBe(true);
      // Check that message content is redacted
      const msg = result.bundle.messages.find(m => m.content.includes('Path'));
      expect(msg).toBeTruthy();
      expect(msg!.content).not.toContain('/Users/foo');
      expect(msg!.content).toContain('<REDACTED_PATH>');
    });

    it('applies secret redaction (AC18)', async () => {
      const sessionId = await seedSession();
      await db.collection('chat_messages').insertOne({
        _id: new ObjectId(),
        sessionId,
        role: 'user',
        content: 'My API key is sk-abcdefghij1234567890ABCDEFGHIJ and token is ghp_abc123def456ghi789jkl012mno345pqr678',
        status: 'completed',
        createdAt: new Date(),
      });

      const result = await service.assembleBundle(sessionId, { redactPaths: false, redactSecrets: true }, userId);

      expect(result.bundle.redactions.secretsRedacted).toBe(true);
      const msg = result.bundle.messages.find(m => m.content.includes('API key'));
      expect(msg).toBeTruthy();
      expect(msg!.content).not.toContain('sk-abcdefghij1234567890ABCDEFGHIJ');
      expect(msg!.content).toContain('<REDACTED>');
    });

    it('sets redaction flags correctly', async () => {
      const sessionId = await seedSession();
      const result = await service.assembleBundle(sessionId, {
        redactPaths: true,
        redactSecrets: false,
        redactIdentity: true,
        includeTraces: false,
        includeArtifacts: false,
        includeThinking: true,
      }, userId);

      expect(result.bundle.redactions.pathsRedacted).toBe(true);
      expect(result.bundle.redactions.secretsRedacted).toBe(false);
      expect(result.bundle.redactions.identityRedacted).toBe(true);
      expect(result.bundle.redactions.rawTracesExcluded).toBe(true);
      expect(result.bundle.redactions.artifactsExcluded).toBe(true);
      expect(result.bundle.redactions.thinkingExcluded).toBe(false);
    });

    it('respects includeHiddenMessages = false (hidden messages omitted)', async () => {
      const sessionId = await seedSession({ includeMessages: false });
      // Insert one visible and one hidden message
      await db.collection('chat_messages').insertMany([
        {
          _id: new ObjectId(),
          sessionId,
          role: 'user',
          content: 'Visible message',
          status: 'completed',
          createdAt: new Date('2025-01-01T10:00:00Z'),
        },
        {
          _id: new ObjectId(),
          sessionId,
          role: 'assistant',
          content: 'Hidden message',
          status: 'completed',
          hidden: true,
          createdAt: new Date('2025-01-01T10:01:00Z'),
        },
        {
          _id: new ObjectId(),
          sessionId,
          role: 'user',
          content: 'Another visible',
          status: 'completed',
          createdAt: new Date('2025-01-01T10:02:00Z'),
        },
      ]);

      const result = await service.assembleBundle(sessionId, { includeHiddenMessages: false }, userId);
      expect(result.bundle.messages).toHaveLength(2);
      expect(result.bundle.messages.every(m => m.content !== 'Hidden message')).toBe(true);

      // With includeHiddenMessages: true
      const resultWithHidden = await service.assembleBundle(sessionId, { includeHiddenMessages: true }, userId);
      expect(resultWithHidden.bundle.messages).toHaveLength(3);
    });

    it('throws EXPORT_SIZE_LIMIT_EXCEEDED when bundle exceeds maxBundleSizeBytes (AC19)', async () => {
      const sessionId = await seedSession({ includeMessages: false });
      // Insert enough content to exceed a tiny limit
      await db.collection('chat_messages').insertOne({
        _id: new ObjectId(),
        sessionId,
        role: 'user',
        content: 'A'.repeat(5000), // ~5KB
        status: 'completed',
        createdAt: new Date(),
      });

      try {
        await service.assembleBundle(sessionId, { maxBundleSizeBytes: 100 }, userId);
        expect.fail('Should have thrown');
      } catch (err: unknown) {
        const error = err as Error & { errorCode?: string; suggestedExclusions?: string[] };
        expect(error.errorCode).toBe('EXPORT_SIZE_LIMIT_EXCEEDED');
        expect(error.suggestedExclusions).toBeDefined();
        expect(error.suggestedExclusions!.length).toBeGreaterThanOrEqual(1);
      }
    });

    it('persists chat_export_bundles row with status: completed on success', async () => {
      const sessionId = await seedSession();
      const result = await service.assembleBundle(sessionId, {}, userId);

      expect(result.bundleId).toBeTruthy();

      const bundleRow = await db.collection('chat_export_bundles').findOne({ bundleId: result.bundleId });
      expect(bundleRow).toBeTruthy();
      expect(bundleRow!.status).toBe('completed');
      expect(bundleRow!.operation).toBe('export');
      expect(bundleRow!.chatSessionId).toBe(sessionId);
      expect(bundleRow!.userId).toBe(userId);
    });

    it('captures descendant executions via parentExecutionId (AC10, AC11)', async () => {
      const sessionId = await seedSession({
        includeExecutions: true,
        includeChildExecutions: true,
      });

      const result = await service.assembleBundle(sessionId, {}, userId);

      // Root exec
      const root = result.bundle.executions.find(e => e.workflowName === 'test-workflow');
      expect(root).toBeTruthy();
      // Child attached
      expect(root!.childExecutions).toHaveLength(1);
      expect(root!.childExecutions![0].agentName).toBe('coder');

      // child execLog included
      const childLog = result.bundle.executionLogs.find(l => l.message === 'Agent started');
      expect(childLog).toBeTruthy();
    });

    it('includes bundleVersion, exportedAt, and sourceEnvironment metadata', async () => {
      const sessionId = await seedSession();
      const result = await service.assembleBundle(sessionId, {}, userId);

      expect(result.bundle.bundleVersion).toBe(1);
      expect(result.bundle.exportedAt).toBeTruthy();
      expect(result.bundle.exportedBy).toBe(userId);
      expect(result.bundle.sourceEnvironment.appName).toBe('Allen');
      expect(result.bundle.sourceEnvironment.platform).toBeDefined();
      expect(result.bundle.sourceEnvironment.nodeVersion).toBeDefined();
    });

    it('empty bundle for session with no messages returns empty arrays', async () => {
      const sessionId = await seedSession({
        includeMessages: false,
        includeExecutions: false,
      });

      const result = await service.assembleBundle(sessionId, {}, userId);
      expect(result.bundle.messages).toHaveLength(0);
      expect(result.bundle.executions).toHaveLength(0);
      expect(result.bundle.executionLogs).toHaveLength(0);
      expect(result.bundle.executionTraces).toHaveLength(0);
      expect(result.bundle.chatLogs).toHaveLength(0);
      expect(result.bundle.artifacts).toHaveLength(0);
      expect(result.bundle.interventions).toHaveLength(0);
      expect(result.bundle.watchers).toHaveLength(0);
    });
  });

  // ── getExportBundle ─────────────────────────────────────────────────────

  describe('getExportBundle()', () => {
    it('returns null when no export bundle exists', async () => {
      const sessionId = new ObjectId().toString();
      const result = await service.getExportBundle(sessionId, userId);
      expect(result).toBeNull();
    });

    it('returns the latest completed bundle for session + user', async () => {
      const sessionId = await seedSession();
      const assembled = await service.assembleBundle(sessionId, {}, userId);

      const retrieved = await service.getExportBundle(sessionId, userId);
      expect(retrieved).toBeTruthy();
      expect(retrieved!.session.title).toBe(assembled.bundle.session.title);
      expect(retrieved!.messages).toHaveLength(assembled.bundle.messages.length);
    });

    it('returns null for different userId', async () => {
      const sessionId = await seedSession();
      await service.assembleBundle(sessionId, {}, userId);

      const retrieved = await service.getExportBundle(sessionId, 'other-user');
      expect(retrieved).toBeNull();
    });
  });
});
