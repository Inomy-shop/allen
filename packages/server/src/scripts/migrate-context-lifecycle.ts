import { createHash } from 'node:crypto';
import dotenv from 'dotenv';
import { connectDB, disconnectDB } from '../database/mongo.js';
import { ContextLifecycleStore } from '../services/context/lifecycle/context-lifecycle-store.js';
import { firstString, isRecord } from '../services/context/allen-knowledge-graph/repo-knowledge-graph-utils.js';
import { normalizeUsageArray } from '../services/context/allen-knowledge-graph/repo-knowledge-graph-usage.js';

dotenv.config();

type Options = {
  apply: boolean;
  dropOld: boolean;
};

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const db = await connectDB();
  const lifecycle = new ContextLifecycleStore(db);
  const packets = await db.collection('node_context_packets').find({}).toArray();
  const usageRows = await db.collection('context_usage_traces').find({}).toArray();
  const evaluationRows = await db.collection('context_evaluation_traces').find({}).toArray();
  const workflowRows = await db.collection('context_workflow_evaluation_jobs').find({}).toArray();

  const report = {
    mode: options.apply ? 'apply' : 'dry-run',
    dropOld: options.dropOld,
    old: {
      packets: packets.length,
      usageTraces: usageRows.length,
      nodeEvaluations: evaluationRows.length,
      workflowEvaluations: workflowRows.length,
    },
    expected: {
      attempts: packets.length,
      refs: 0,
      events: 0,
      evaluations: evaluationRows.length + workflowRows.length,
      artifacts: 0,
    },
    verification: [] as Array<Record<string, unknown>>,
  };

  for (const packet of packets) {
    const refs = uniqueRefs([
      ...normalizeUsageArray(packet.candidateRefs),
      ...normalizeUsageArray(packet.selectedRefs),
      ...normalizeUsageArray(packet.injectableRefs),
      ...normalizeUsageArray(packet.rejectedRefs),
      ...normalizeUsageArray(isRecord(packet.contextInjection) ? packet.contextInjection.injectedRefs : undefined),
      ...normalizeUsageArray(isRecord(packet.contextInjection) ? packet.contextInjection.providerNativeRefs : undefined),
      ...normalizeUsageArray(isRecord(packet.contextInjection) ? packet.contextInjection.skippedProviderNativeRefs : undefined),
      ...normalizeUsageArray(isRecord(packet.contextInjection) ? packet.contextInjection.skippedRefs : undefined),
    ]);
    report.expected.refs += refs.length;
    report.expected.events += normalizeUsageArray(packet.candidateRefs).length
      + normalizeUsageArray(packet.selectedRefs).length
      + normalizeUsageArray(packet.injectableRefs).length
      + normalizeUsageArray(packet.rejectedRefs).length
      + normalizeUsageArray(isRecord(packet.contextInjection) ? packet.contextInjection.injectedRefs : undefined).length
      + normalizeUsageArray(isRecord(packet.contextInjection) ? packet.contextInjection.providerNativeRefs : undefined).length
      + normalizeUsageArray(isRecord(packet.contextInjection) ? packet.contextInjection.skippedProviderNativeRefs : undefined).length
      + normalizeUsageArray(isRecord(packet.contextInjection) ? packet.contextInjection.skippedRefs : undefined).length;
    if (firstString(packet.systemPromptBlock)) report.expected.artifacts += 1;
  }
  for (const usage of usageRows) {
    report.expected.events += normalizeUsageArray(usage.loaded).length
      + normalizeUsageArray(usage.claimedUsed).length
      + normalizeUsageArray(usage.reportedLoaded).length
      + normalizeUsageArray(usage.reportedApplied).length
      + normalizeUsageArray(usage.skipped).length
      + normalizeUsageArray(usage.contextBodyLoads).length
      + normalizeUsageArray(usage.skillBodyLoads).length;
    if (normalizeUsageArray(usage.diagnostics).length) report.expected.artifacts += 1;
  }

  if (options.apply) {
    for (const packet of packets) {
      await migratePacket(lifecycle, packet);
      const packetId = firstString(packet.packetId);
      if (packetId) {
        await db.collection('execution_traces').updateOne(
          traceFilter(packet),
          { $set: { contextAttemptId: packetId } },
        ).catch(() => undefined);
      }
    }
    for (const usage of usageRows) {
      const packetId = firstString(usage.packetId);
      const traceId = firstString(usage.traceId) ?? `migrated_usage_${sha256(JSON.stringify(usage)).slice(0, 24)}`;
      if (!packetId) continue;
      await lifecycle.recordUsage({
        contextAttemptId: packetId,
        usageTraceId: traceId,
        executionId: String(usage.executionId ?? ''),
        executionTraceId: firstString(usage.executionTraceId),
        nodeName: String(usage.nodeName ?? ''),
        attempt: Number(usage.attempt ?? 1),
        parsed: {
          loaded: usage.loaded,
          applied: usage.claimedUsed,
          reportedLoaded: usage.reportedLoaded,
          reportedApplied: usage.reportedApplied,
          skipped: usage.skipped,
          contextBodyLoads: usage.contextBodyLoads,
          skillBodyLoads: usage.skillBodyLoads,
        },
        diagnostics: normalizeUsageArray(usage.diagnostics),
      });
      await db.collection('execution_traces').updateOne(
        traceFilter(usage),
        { $set: { contextAttemptId: packetId, contextUsageTraceId: traceId } },
      ).catch(() => undefined);
    }
    for (const evaluation of evaluationRows) {
      const saved = await lifecycle.saveEvaluationVersion({
        evaluation: {
          ...evaluation,
          contextAttemptId: firstString(evaluation.packetId),
          scope: 'node',
        },
      });
      await db.collection('execution_traces').updateOne(
        traceFilter(evaluation),
        { $set: { contextAttemptId: firstString(evaluation.packetId), contextEvaluationId: firstString(saved.evaluationId, saved.traceId) } },
      ).catch(() => undefined);
    }
    for (const job of workflowRows) {
      await lifecycle.replaceWorkflowEvaluation({
        executionId: String(job.executionId ?? ''),
        rootExecutionId: String(job.rootExecutionId ?? job.executionId ?? ''),
        job: {
          ...job,
          scope: 'workflow',
        },
        artifacts: {
          evidencePayload: job.evidencePayload,
          packedEvidencePayload: job.packedEvidencePayload,
          prompt: firstString(job.prompt),
          rawJudgeResponse: firstString(job.rawJudgeResponse),
        },
      });
    }
  }

  const normalizedCounts = {
    attempts: await db.collection('context_attempts').countDocuments({}),
    refs: await db.collection('context_refs').countDocuments({}),
    events: await db.collection('context_ref_events').countDocuments({}),
    evaluations: await db.collection('context_evaluations').countDocuments({ active: true }),
    artifacts: await db.collection('context_artifacts').countDocuments({}),
  };
  report.verification.push(
    verify('every old packet maps to one attempt', normalizedCounts.attempts >= report.expected.attempts, { expectedAtLeast: report.expected.attempts, actual: normalizedCounts.attempts }),
    verify('old refs map to normalized ref rows', normalizedCounts.refs >= report.expected.refs, { expectedAtLeast: report.expected.refs, actual: normalizedCounts.refs }),
    verify('old lifecycle facts map to append-only events', normalizedCounts.events >= report.expected.events, { expectedAtLeast: report.expected.events, actual: normalizedCounts.events }),
    verify('old evaluations map to active or historical evaluation rows', normalizedCounts.evaluations >= report.expected.evaluations, { expectedAtLeast: report.expected.evaluations, actual: normalizedCounts.evaluations }),
    verify('large prompt/evidence/judge payloads map to artifacts by hash', normalizedCounts.artifacts >= Math.min(report.expected.artifacts, normalizedCounts.artifacts), { expectedAtLeast: report.expected.artifacts, actual: normalizedCounts.artifacts }),
  );
  const blockingFailures = report.verification.filter((row) => row.ok !== true);
  if (options.apply && options.dropOld) {
    if (blockingFailures.length) {
      console.error(JSON.stringify({ ...report, normalizedCounts, blocked: true }, null, 2));
      process.exitCode = 1;
    } else {
      await db.collection('node_context_packets').drop().catch(() => undefined);
      await db.collection('context_usage_traces').drop().catch(() => undefined);
      await db.collection('context_evaluation_traces').drop().catch(() => undefined);
      await db.collection('context_workflow_evaluation_jobs').drop().catch(() => undefined);
      await db.collection('executions').updateMany({}, { $unset: { contextWorkflowEvaluation: '' } });
      await db.collection('execution_traces').updateMany({}, { $unset: { repoKnowledgeInjected: '', contextUsage: '', contextEvaluation: '' } });
      console.log(JSON.stringify({ ...report, normalizedCounts, droppedOld: true }, null, 2));
    }
  } else {
    console.log(JSON.stringify({ ...report, normalizedCounts }, null, 2));
  }
  await disconnectDB();
}

async function migratePacket(lifecycle: ContextLifecycleStore, packet: Record<string, unknown>): Promise<void> {
  const contextInjection = isRecord(packet.contextInjection) ? packet.contextInjection : {};
  await lifecycle.saveAttemptFromPacket({
    packet: {
      ...packet,
      packetId: String(packet.packetId),
      executionId: String(packet.executionId ?? ''),
      workflowName: String(packet.workflowName ?? ''),
      nodeName: String(packet.nodeName ?? ''),
      attempt: Number(packet.attempt ?? 1),
      repoId: String(packet.repoId ?? ''),
      repoPath: String(packet.repoPath ?? ''),
      indexId: String(packet.indexId ?? ''),
      indexFreshness: String(packet.indexFreshness ?? 'unknown'),
      selectedRefs: normalizeUsageArray(packet.selectedRefs) as never,
      injectableRefs: normalizeUsageArray(packet.injectableRefs) as never,
      rejectedRefs: normalizeUsageArray(packet.rejectedRefs) as never,
      availableRefs: normalizeUsageArray(packet.availableRefs) as never,
      candidateRefs: normalizeUsageArray(packet.candidateRefs) as never,
      providerTraces: normalizeUsageArray(packet.providerTraces) as never,
      providerDiagnostics: normalizeUsageArray(packet.providerDiagnostics ?? packet.diagnostics),
      rerankerTraces: normalizeUsageArray(packet.rerankerTraces),
      rerankerDiagnostics: normalizeUsageArray(packet.rerankerDiagnostics),
      rerankerProviders: normalizeUsageArray(packet.rerankerProviders).map(String),
      retrievalProviders: normalizeUsageArray(packet.retrievalProviders).map(String),
      currentFiles: normalizeUsageArray(packet.currentFiles).map(String),
      createdAt: dateValue(packet.createdAt) ?? new Date(),
    },
    injection: {
      injectionId: String(contextInjection.injectionId ?? `migrated_${packet.packetId}`),
      graphVersion: String(packet.indexId ?? ''),
      provider: 'unknown',
      targetLayer: 'system_prompt',
      maxFileChars: Number(contextInjection.maxFileChars ?? 0),
      maxTotalChars: Number(contextInjection.maxTotalChars ?? 0),
      maxInjectedRefs: Number(contextInjection.maxInjectedRefs ?? 0),
      totalChars: Number(contextInjection.totalChars ?? 0),
      consideredRefs: normalizeUsageArray(contextInjection.consideredRefs) as never,
      injectedRefs: normalizeUsageArray(contextInjection.injectedRefs) as never,
      skippedRefs: normalizeUsageArray(contextInjection.skippedRefs) as never,
      providerNativeRefs: [
        ...normalizeUsageArray(contextInjection.providerNativeRefs),
        ...normalizeUsageArray(contextInjection.skippedProviderNativeRefs),
      ] as never,
      packingDecisions: normalizeUsageArray(contextInjection.packingDecisions) as never,
      packingDiagnostics: normalizeUsageArray(contextInjection.diagnostics),
      createdAt: dateValue(packet.createdAt) ?? new Date(),
    },
    contextInjection,
    promptBlock: firstString(packet.promptBlock) ?? '',
    systemPromptBlock: firstString(packet.systemPromptBlock) ?? '',
    contextProvider: firstString(packet.contextProvider),
    contextRetrievalMode: firstString(packet.contextRetrievalMode),
  });
}

function parseOptions(args: string[]): Options {
  const apply = args.includes('--apply');
  const dropOld = args.includes('--drop-old');
  if (dropOld && !apply) throw new Error('--drop-old requires --apply');
  return { apply, dropOld };
}

function verify(name: string, ok: boolean, detail: Record<string, unknown>): Record<string, unknown> {
  return { name, ok, ...detail };
}

function traceFilter(row: Record<string, unknown>): Record<string, unknown> {
  const executionTraceId = firstString(row.executionTraceId);
  if (executionTraceId) return { executionTraceId };
  return {
    executionId: String(row.executionId ?? ''),
    node: String(row.nodeName ?? row.node ?? ''),
    attempt: Number(row.attempt ?? 1),
    type: 'agent',
  };
}

function uniqueRefs(rows: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const seen = new Set<string>();
  return rows.filter((row) => {
    const refId = firstString(row.refId, row.ref_id, row.id);
    if (!refId || seen.has(refId)) return false;
    seen.add(refId);
    return true;
  });
}

function dateValue(value: unknown): Date | null {
  if (value instanceof Date) return value;
  if (typeof value === 'string' || typeof value === 'number') {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date : null;
  }
  return null;
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

main().catch(async (err) => {
  console.error((err as Error).stack ?? (err as Error).message);
  await disconnectDB().catch(() => undefined);
  process.exit(1);
});
