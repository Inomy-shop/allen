import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join, normalize, relative } from 'node:path';
import { spawn } from 'node:child_process';
import type { KnowledgeCandidateRef, KnowledgeNodeKind, RepoContextPacket, RepoContextProvider } from './repo-context-engine.js';
import { DeterministicContextCompressor, type ContextCompressionResult, type ContextPackingTransformation, type ContextRiskClass } from './repo-context-compressor.js';

const DEFAULT_MANDATORY_CONTEXT_MAX_FILE_CHARS = 60_000;
const DEFAULT_MANDATORY_CONTEXT_MAX_TOTAL_CHARS = 180_000;
const DEFAULT_MANDATORY_CONTEXT_MAX_INJECTED_REFS = 12;

export interface ContextInjectionRef extends KnowledgeCandidateRef {
  contentSha256?: string;
  originalContentSha256?: string;
  charCount?: number;
  originalCharCount?: number;
  finalCharCount?: number;
  content?: string;
  skipReason?: 'provider_native' | 'unsupported' | 'missing' | 'untracked' | 'oversize' | 'budget' | 'duplicate' | 'provider_error' | 'previously_injected';
  packingDecision?: 'injected' | 'provider_native' | 'skipped';
  packingTransformation?: ContextPackingTransformation;
  compressorProviderId?: string;
  compressionRatio?: number;
  sectionCount?: number;
  riskClass?: ContextRiskClass;
  packingWarnings?: string[];
}

export interface PreviouslyInjectedContextRef {
  refId?: string;
  contentSha256?: string;
  curatedContextHash?: string;
  curationEntryId?: string;
  contextAttemptId?: string;
  messageId?: string;
}

export interface WorkflowContextInjection {
  injectionId: string;
  graphVersion: string;
  provider: RepoContextProvider;
  targetLayer: 'system_prompt' | 'user_prompt';
  maxFileChars: number;
  maxTotalChars: number;
  maxInjectedRefs: number;
  totalChars: number;
  consideredRefs: ContextInjectionRef[];
  injectedRefs: ContextInjectionRef[];
  skippedRefs: ContextInjectionRef[];
  providerNativeRefs: ContextInjectionRef[];
  packingDecisions: ContextInjectionRef[];
  packingDiagnostics: Array<Record<string, unknown>>;
  contentHash?: string;
  createdAt: Date;
}

export class WorkflowContextInjectionAdapter {
  async buildInjection(input: {
    packet: RepoContextPacket;
    provider: RepoContextProvider;
    repoPath: string;
    worktreePath?: string;
    targetLayer?: 'system_prompt' | 'user_prompt';
    previouslyInjectedRefs?: PreviouslyInjectedContextRef[];
  }): Promise<WorkflowContextInjection> {
    const basePath = input.worktreePath && existsSync(input.worktreePath) ? input.worktreePath : input.repoPath;
    const limits = contextInjectionLimits();
    const packetInjectableRefs = input.packet.injectableRefs?.length
      ? input.packet.injectableRefs
      : input.packet.selectedRefs.filter((ref) => isInjectablePolicy(ref));
    const consideredRefs = packetInjectableRefs.filter(isContextInjectionEligible);
    const injectedRefs: ContextInjectionRef[] = [];
    const skippedRefs: ContextInjectionRef[] = [];
    const providerNativeRefs: ContextInjectionRef[] = [];
    const packingDiagnostics: Array<Record<string, unknown>> = [];
    const compressor = new DeterministicContextCompressor();
    const hash = createHash('sha256');
    const seenContentHashes = new Set<string>();
    const previousInjectedIndex = previousInjectedRefIndex(input.previouslyInjectedRefs);
    let totalChars = 0;

    for (const ref of consideredRefs) {
      const previousInjection = previousInjectionFor(ref, previousInjectedIndex);
      if (previousInjection && isCuratedSnippetRef(ref)) {
        skippedRefs.push(previouslyInjected(ref, previousInjection));
        continue;
      }
      const queryContext = compressionQueryContext(input.packet, ref);
      if (typeof ref.content === 'string' && ref.content.trim()) {
        const content = redactPotentialSecrets(ref.content);
        const originalContentSha256 = sha256(content);
        const previousContentInjection = previousInjectedIndex.get(`content:${originalContentSha256}`);
        if (previousContentInjection && isCuratedSnippetRef(ref)) {
          skippedRefs.push(previouslyInjected(ref, previousContentInjection, originalContentSha256));
          continue;
        }
        if (seenContentHashes.has(originalContentSha256)) {
          skippedRefs.push({ ...ref, originalCharCount: content.length, originalContentSha256, skipReason: 'duplicate', packingDecision: 'skipped' });
          continue;
        }
        const remainingChars = Math.max(0, limits.maxTotalChars - totalChars);
        const packed = await compressor.compress({
          ref,
          content,
          taskText: queryContext.taskText,
          maxChars: Math.min(limits.maxFileChars, remainingChars),
          allowCompression: true,
        });
        packingDiagnostics.push(...withCompressionQueryDiagnostics(packed, queryContext, ref));
        const withPackingMeta = withCompressionMeta(ref, packed, originalContentSha256);
        if (!packed.content) {
          skippedRefs.push({ ...withPackingMeta, skipReason: packed.transformation === 'skipped' ? 'oversize' : 'provider_error', packingDecision: 'skipped' });
          continue;
        }
        const contentSha256 = sha256(packed.content);
        if (seenContentHashes.has(contentSha256)) {
          skippedRefs.push({ ...withPackingMeta, contentSha256, skipReason: 'duplicate', packingDecision: 'skipped' });
          continue;
        }
        if (packed.content.length > remainingChars || injectedRefs.length >= limits.maxInjectedRefs) {
          skippedRefs.push({ ...withPackingMeta, contentSha256, skipReason: 'budget', packingDecision: 'skipped' });
          continue;
        }
        totalChars += packed.content.length;
        seenContentHashes.add(originalContentSha256);
        seenContentHashes.add(contentSha256);
        hash.update(`${ref.refId}\0${ref.providerId}\0${contentSha256}\0${packed.content}\0`);
        injectedRefs.push({
          ...withPackingMeta,
          contentSha256,
          charCount: packed.content.length,
          source: 'allen_system_injection',
          targetLayer: input.targetLayer ?? 'system_prompt',
          packingDecision: 'injected',
          content: packed.content,
        });
        continue;
      }

      if (!ref.path || !isPreloadLoadableKind(ref.kind)) {
        skippedRefs.push(skipped(ref, 'unsupported'));
        continue;
      }
      if (isProviderNativeContextPath(ref.path, input.provider)) {
        const nativeRef = { ...ref, source: 'provider_native', skipReason: 'provider_native' as const, packingDecision: 'provider_native' as const };
        skippedRefs.push(nativeRef);
        providerNativeRefs.push(nativeRef);
        continue;
      }

      let contextPath = '';
      try {
        contextPath = sanitizeRepoRelativePath(ref.path);
      } catch {
        skippedRefs.push(skipped(ref, 'missing'));
        continue;
      }

      const absolutePath = join(basePath, contextPath);
      if (!basePath || !existsSync(absolutePath) || !isPathInside(basePath, absolutePath)) {
        skippedRefs.push(skipped(ref, 'missing'));
        continue;
      }
      if (!(await isGitTracked(basePath, contextPath))) {
        skippedRefs.push(skipped(ref, 'untracked'));
        continue;
      }

      const content = await readFile(absolutePath, 'utf8');
      const originalContentSha256 = sha256(content);
      if (seenContentHashes.has(originalContentSha256)) {
        skippedRefs.push({ ...ref, originalCharCount: content.length, originalContentSha256, skipReason: 'duplicate', packingDecision: 'skipped' });
        continue;
      }
      const remainingChars = Math.max(0, limits.maxTotalChars - totalChars);
      const maxChars = Math.min(limits.maxFileChars, remainingChars);
      const packed = await compressor.compress({
        ref,
        content,
        taskText: queryContext.taskText,
        maxChars,
        allowCompression: false,
      });
      packingDiagnostics.push(...withCompressionQueryDiagnostics(packed, queryContext, ref));
      const withPackingMeta = withCompressionMeta(ref, packed, originalContentSha256);
      if (!packed.content) {
        skippedRefs.push({ ...withPackingMeta, skipReason: packed.transformation === 'skipped' ? 'oversize' : 'provider_error', packingDecision: 'skipped' });
        continue;
      }
      const contentSha256 = sha256(packed.content);
      if (seenContentHashes.has(contentSha256)) {
        skippedRefs.push({ ...withPackingMeta, contentSha256, skipReason: 'duplicate', packingDecision: 'skipped' });
        continue;
      }
      if (packed.content.length > remainingChars) {
        skippedRefs.push({ ...withPackingMeta, contentSha256, skipReason: 'budget', packingDecision: 'skipped' });
        continue;
      }
      if (injectedRefs.length >= limits.maxInjectedRefs) {
        skippedRefs.push({ ...withPackingMeta, contentSha256, skipReason: 'budget', packingDecision: 'skipped' });
        continue;
      }

      totalChars += packed.content.length;
      seenContentHashes.add(originalContentSha256);
      seenContentHashes.add(contentSha256);
      hash.update(`${ref.refId}\0${contextPath}\0${packed.content}\0`);
      injectedRefs.push({
        ...withPackingMeta,
        contentSha256,
        charCount: packed.content.length,
        source: 'allen_system_injection',
        targetLayer: input.targetLayer ?? 'system_prompt',
        packingDecision: 'injected',
        content: packed.content,
      });
    }

    const packingDecisions = [...injectedRefs, ...skippedRefs];
    return {
      injectionId: randomUUID(),
      graphVersion: input.packet.indexId,
      provider: input.provider,
      targetLayer: input.targetLayer ?? 'system_prompt',
      maxFileChars: limits.maxFileChars,
      maxTotalChars: limits.maxTotalChars,
      maxInjectedRefs: limits.maxInjectedRefs,
      totalChars,
      consideredRefs,
      injectedRefs,
      skippedRefs,
      providerNativeRefs,
      packingDecisions,
      packingDiagnostics,
      contentHash: injectedRefs.length > 0 ? hash.digest('hex') : undefined,
      createdAt: new Date(),
    };
  }

  renderSystemPromptBlock(injection: WorkflowContextInjection): string {
    if (injection.injectedRefs.length === 0 && injection.skippedRefs.length === 0) return '';
    const manifest = [
      ...injection.providerNativeRefs.map((ref) => renderManifestRef(ref, 'provider_native')),
      ...injection.skippedRefs
        .filter((ref) => ref.skipReason !== 'provider_native')
        .map((ref) => renderManifestRef(ref, `skipped_${ref.skipReason ?? 'unknown'}`)),
    ].join('\n');

    return `<allen_mandatory_repo_context injection_id="${escapeAttr(injection.injectionId)}" graph_version="${escapeAttr(injection.graphVersion)}" provider="${escapeAttr(injection.provider)}" target_layer="${escapeAttr(injection.targetLayer)}">
  <instructions>
    Allen resolved this repo context before agent startup. Treat entries in full_body_context as already loaded source material for this task.
    You do not need to call a context body MCP tool for these injected files. Apply them when they are relevant to the task.
    Provider-native refs are expected to be loaded by the underlying agent provider and are listed for audit only.
    In repo_context_usage, report injected files or provider text with source "allen_system_injection" when they affected the work.
  </instructions>
  <injection_manifest considered="${injection.consideredRefs.length}" injected="${injection.injectedRefs.length}" provider_native="${injection.providerNativeRefs.length}" skipped="${injection.skippedRefs.length}" max_injected_refs="${injection.maxInjectedRefs}" total_chars="${injection.totalChars}" content_hash="${escapeAttr(injection.contentHash ?? '')}">
${manifest || '    <context_ref status="none" />'}
  </injection_manifest>
  <full_body_context>
${injection.injectedRefs.map(renderInjectedContextRef).join('\n')}
  </full_body_context>
</allen_mandatory_repo_context>`;
  }

  renderContextPacket(packet: RepoContextPacket): string {
    const refs = (sectionName: string, source: string, items: KnowledgeCandidateRef[]) => {
      if (!items.length) return `  <context_section name="${escapeAttr(sectionName)}" source="${escapeAttr(source)}" count="0" />`;
      return `  <context_section name="${escapeAttr(sectionName)}" source="${escapeAttr(source)}" count="${items.length}">
${items.map((ref) => renderContextRef(ref)).join('\n')}
  </context_section>`;
    };
    const mandatoryRefs = packet.selectedRefs.filter((ref) => ref.mandatory);
    const optionalRefs = packet.selectedRefs.filter((ref) => !ref.mandatory);
    const skills = packet.selectedRefs.filter((ref) => ref.kind === 'skill' || ref.kind === 'skill_reference');
    const production = packet.selectedRefs.filter((ref) => ref.kind === 'production_note' || ref.kind === 'runbook');
    return `\n\n<repo_knowledge_packet id="${packet.packetId}" repo="${escapeAttr(packet.repoName)}" freshness="${escapeAttr(packet.indexFreshness)}">
  <repo_context_selection>
    <selection_instructions>
      These entries are relevance hints unless Allen injected their full body in the system context.
      File refs with injection_policy="manifest_only" must be loaded before relying on them unless already present in Allen-injected full_body_context.
      File refs with injection_policy="never_full_auto" must not be treated as loaded from this packet.
      Provider-text refs can be used directly when they are present in Allen-injected full_body_context.
    </selection_instructions>
${refs('selected_context', 'provider_composer', packet.selectedRefs)}
${refs('injectable_context', 'injection_policy', packet.injectableRefs ?? [])}
${refs('mandatory_context', 'mandatory_graph', mandatoryRefs)}
${refs('recommended_context', 'graph_keyword_metadata', optionalRefs)}
${refs('available_skills', 'skill_manifest', skills)}
${refs('production_knowledge', 'production_knowledge', production)}
  </repo_context_selection>

  <repo_context_usage_reminder>
    Always include repo_context_usage in the final JSON output or final text. Follow the repo_context_usage contract from the injected system instructions.
  </repo_context_usage_reminder>
</repo_knowledge_packet>\n`;
  }
}

function previousInjectedRefIndex(values: PreviouslyInjectedContextRef[] | undefined): Map<string, PreviouslyInjectedContextRef> {
  const index = new Map<string, PreviouslyInjectedContextRef>();
  for (const value of values ?? []) {
    if (value.contentSha256) index.set(`content:${value.contentSha256}`, value);
    if (value.curatedContextHash) index.set(`content:${value.curatedContextHash}`, value);
    if (value.curationEntryId) index.set(`curation:${value.curationEntryId}`, value);
    if (value.refId) index.set(`ref:${value.refId}`, value);
  }
  return index;
}

function previousInjectionFor(ref: KnowledgeCandidateRef, index: Map<string, PreviouslyInjectedContextRef>): PreviouslyInjectedContextRef | undefined {
  const metadata = ref.providerMetadata ?? {};
  const curationEntryId = stringValue(metadata.curationEntryId);
  const curatedContextHash = stringValue(metadata.curatedContextHash);
  const candidates = [
    ref.contentSha256 ? `content:${ref.contentSha256}` : undefined,
    curatedContextHash ? `content:${curatedContextHash}` : undefined,
    curationEntryId ? `curation:${curationEntryId}` : undefined,
    `ref:${ref.refId}`,
  ].filter((value): value is string => Boolean(value));
  for (const key of candidates) {
    const match = index.get(key);
    if (match) return match;
  }
  return undefined;
}

function isCuratedSnippetRef(ref: KnowledgeCandidateRef): boolean {
  const metadata = ref.providerMetadata ?? {};
  return metadata.curatedInjectionPolicy === 'snippet'
    || (metadata.injectionDecision === 'snippet' && typeof metadata.curationEntryId === 'string');
}

function previouslyInjected(
  ref: KnowledgeCandidateRef,
  previous: PreviouslyInjectedContextRef,
  originalContentSha256?: string,
): ContextInjectionRef {
  return {
    ...ref,
    originalContentSha256,
    skipReason: 'previously_injected',
    packingDecision: 'skipped',
    providerMetadata: {
      ...ref.providerMetadata,
      previouslyInjected: true,
      previousContextAttemptId: previous.contextAttemptId,
      previousMessageId: previous.messageId,
      previousRefId: previous.refId,
    },
  };
}

function contextInjectionLimits(): { maxFileChars: number; maxTotalChars: number; maxInjectedRefs: number } {
  return {
    maxFileChars: positiveIntegerEnv('ALLEN_CONTEXT_MAX_FILE_CHARS', DEFAULT_MANDATORY_CONTEXT_MAX_FILE_CHARS),
    maxTotalChars: positiveIntegerEnv('ALLEN_CONTEXT_MAX_TOTAL_CHARS', DEFAULT_MANDATORY_CONTEXT_MAX_TOTAL_CHARS),
    maxInjectedRefs: positiveIntegerEnv('ALLEN_CONTEXT_MAX_INJECTED_REFS', DEFAULT_MANDATORY_CONTEXT_MAX_INJECTED_REFS),
  };
}

function compressionQueryContext(packet: RepoContextPacket, ref: KnowledgeCandidateRef): {
  taskText: string;
  querySource: 'rendered_context_query' | 'legacy_task_text';
  renderedContextQueryHash?: string;
  renderedContextQueryLength?: number;
} {
  if (typeof packet.renderedContextQuery === 'string' && packet.renderedContextQuery.trim()) {
    return {
      taskText: packet.renderedContextQuery,
      querySource: 'rendered_context_query',
      renderedContextQueryHash: packet.renderedContextQueryHash ?? sha256(packet.renderedContextQuery),
      renderedContextQueryLength: packet.renderedContextQueryLength ?? packet.renderedContextQuery.length,
    };
  }
  return {
    taskText: `${packet.workflowName} ${packet.nodeName} ${packet.nodeRole ?? ''} ${packet.taskPrompt ?? ''} ${ref.summary ?? ''}`,
    querySource: 'legacy_task_text',
  };
}

function withCompressionQueryDiagnostics(
  packed: ContextCompressionResult,
  queryContext: ReturnType<typeof compressionQueryContext>,
  ref: KnowledgeCandidateRef,
): Array<Record<string, unknown>> {
  if (packed.transformation !== 'section_extracted') return packed.diagnostics;
  const queryDiagnostics = {
    code: 'context_compression_query_used',
    severity: 'info',
    refId: ref.refId,
    path: ref.path,
    packingTransformation: packed.transformation,
    querySource: queryContext.querySource,
    renderedContextQueryHash: queryContext.renderedContextQueryHash,
    renderedContextQueryLength: queryContext.renderedContextQueryLength,
    originalChars: packed.originalChars,
    finalChars: packed.finalChars,
    sectionCount: packed.sectionCount,
    message: 'Context compression recorded the query source used for section extraction.',
  };
  return [
    ...packed.diagnostics.map((diagnostic) => ({
      ...diagnostic,
      querySource: queryContext.querySource,
      renderedContextQueryHash: queryContext.renderedContextQueryHash,
      renderedContextQueryLength: queryContext.renderedContextQueryLength,
    })),
    queryDiagnostics,
  ];
}

function positiveIntegerEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

export function summarizeInjection(injection: WorkflowContextInjection): Record<string, unknown> {
  const skippedByReason = (reason: ContextInjectionRef['skipReason']) => injection.skippedRefs.filter((ref) => ref.skipReason === reason);
  return {
    injectionId: injection.injectionId,
    graphVersion: injection.graphVersion,
    provider: injection.provider,
    targetLayer: injection.targetLayer,
    maxInjectedRefs: injection.maxInjectedRefs,
    maxFileChars: injection.maxFileChars,
    maxTotalChars: injection.maxTotalChars,
    consideredCount: injection.consideredRefs.length,
    injectedCount: injection.injectedRefs.length,
    skippedProviderNativeCount: skippedByReason('provider_native').length,
    skippedOversizeCount: skippedByReason('oversize').length,
    skippedBudgetCount: skippedByReason('budget').length,
    skippedMissingCount: skippedByReason('missing').length,
    skippedUntrackedCount: skippedByReason('untracked').length,
    skippedUnsupportedCount: skippedByReason('unsupported').length,
    skippedDuplicateCount: skippedByReason('duplicate').length,
    skippedPreviouslyInjectedCount: skippedByReason('previously_injected').length,
    totalChars: injection.totalChars,
    contentHash: injection.contentHash,
    injectedRefs: stripInjectedContent(injection.injectedRefs),
    skippedRefs: stripInjectedContent(injection.skippedRefs),
    skippedProviderNativeRefs: stripInjectedContent(skippedByReason('provider_native')),
    skippedOversizeRefs: stripInjectedContent(skippedByReason('oversize')),
    skippedBudgetRefs: stripInjectedContent(skippedByReason('budget')),
    skippedMissingRefs: stripInjectedContent(skippedByReason('missing')),
    skippedUntrackedRefs: stripInjectedContent(skippedByReason('untracked')),
    skippedUnsupportedRefs: stripInjectedContent(skippedByReason('unsupported')),
    skippedDuplicateRefs: stripInjectedContent(skippedByReason('duplicate')),
    skippedPreviouslyInjectedRefs: stripInjectedContent(skippedByReason('previously_injected')),
    providerNativeRefs: stripInjectedContent(injection.providerNativeRefs),
    packingDecisions: stripInjectedContent(injection.packingDecisions),
    packingDiagnostics: injection.packingDiagnostics,
  };
}

function renderManifestRef(ref: ContextInjectionRef, status: string): string {
  const injectionPolicy = injectionDecisionFor(ref);
  return `    <context_ref id="${escapeAttr(ref.refId)}" kind="${escapeAttr(ref.kind)}" provider="${escapeAttr(ref.providerId)}" source="${escapeAttr(ref.source)}" status="${escapeAttr(status)}" injection_policy="${escapeAttr(injectionPolicy)}"${ref.path ? ` path="${escapeAttr(ref.path)}"` : ''}${ref.itemType ? ` item_type="${escapeAttr(ref.itemType)}"` : ''}${ref.grounding ? ` grounding="${escapeAttr(ref.grounding)}"` : ''}${ref.contentSha256 ? ` content_sha256="${escapeAttr(ref.contentSha256)}"` : ''}${ref.charCount != null ? ` char_count="${escapeAttr(ref.charCount)}"` : ''}${ref.packingTransformation ? ` packing_transformation="${escapeAttr(ref.packingTransformation)}"` : ''}${ref.riskClass ? ` risk_class="${escapeAttr(ref.riskClass)}"` : ''}>
      <title>${escapeText(ref.title)}</title>
      <reason>${escapeText(ref.reason)}</reason>
    </context_ref>`;
}

function renderInjectedContextRef(ref: ContextInjectionRef): string {
  const content = String(ref.content ?? '');
  const fence = markdownFenceFor(content);
  return `    <context_file id="${escapeAttr(ref.refId)}" kind="${escapeAttr(ref.kind)}" provider="${escapeAttr(ref.providerId)}"${ref.path ? ` path="${escapeAttr(ref.path)}"` : ''}${ref.itemType ? ` item_type="${escapeAttr(ref.itemType)}"` : ''}${ref.grounding ? ` grounding="${escapeAttr(ref.grounding)}"` : ''} injection_policy="${escapeAttr(injectionDecisionFor(ref))}" content_sha256="${escapeAttr(ref.contentSha256 ?? '')}" original_content_sha256="${escapeAttr(ref.originalContentSha256 ?? '')}" char_count="${escapeAttr(ref.charCount ?? 0)}" original_char_count="${escapeAttr(ref.originalCharCount ?? ref.charCount ?? 0)}" packing_transformation="${escapeAttr(ref.packingTransformation ?? 'full_body')}" compressor_provider="${escapeAttr(ref.compressorProviderId ?? '')}" risk_class="${escapeAttr(ref.riskClass ?? '')}">
      <title>${escapeText(ref.title)}</title>
      <reason>${escapeText(ref.reason)}</reason>
${fence}
${content}
${fence}
    </context_file>`;
}

function isInjectablePolicy(ref: KnowledgeCandidateRef): boolean {
  const decision = ref.providerMetadata?.injectionDecision ?? ref.providerMetadata?.injectionPolicy;
  if (!decision) return true;
  return ref.mandatory
    || ref.targetLayer === 'system_prompt'
    || decision === 'mandatory_full'
    || decision === 'snippet'
    || decision === 'injectable';
}

function injectionDecisionFor(ref: KnowledgeCandidateRef): string {
  const decision = ref.providerMetadata?.curatedInjectionPolicy
    ?? ref.providerMetadata?.finalInjectionDecision
    ?? ref.providerMetadata?.injectionDecision
    ?? ref.providerMetadata?.injectionPolicy;
  if (decision === 'injectable') return 'snippet';
  if (typeof decision === 'string' && decision) return decision;
  return ref.mandatory || ref.targetLayer === 'system_prompt' ? 'mandatory_full' : 'manifest_only';
}

function renderContextRef(ref: KnowledgeCandidateRef): string {
  const rerank = ref.rerank && typeof ref.rerank === 'object' ? ref.rerank as Record<string, unknown> : {};
  return `    <context_ref id="${escapeAttr(ref.refId)}" kind="${escapeAttr(ref.kind)}" provider="${escapeAttr(ref.providerId)}" source="${escapeAttr(ref.source)}" injection_policy="${escapeAttr(injectionDecisionFor(ref))}"${ref.path ? ` path="${escapeAttr(ref.path)}"` : ''}${ref.itemType ? ` item_type="${escapeAttr(ref.itemType)}"` : ''}${ref.grounding ? ` grounding="${escapeAttr(ref.grounding)}"` : ''} loadable="${escapeAttr(String(ref.loadable))}" mandatory="${escapeAttr(String(ref.mandatory))}"${ref.contentSha256 ? ` content_sha256="${escapeAttr(ref.contentSha256)}"` : ''}${ref.score !== undefined ? ` score="${escapeAttr(String(ref.score))}"` : ''}${rerank.score !== undefined ? ` rerank_score="${escapeAttr(String(rerank.score))}"` : ''}${rerank.finalRank !== undefined ? ` final_rank="${escapeAttr(String(rerank.finalRank))}"` : ''}>
      <title>${escapeText(ref.title)}</title>
      <summary>${escapeText(ref.summary)}</summary>
      <reason>${escapeText(ref.reason)}</reason>
    </context_ref>`;
}

function markdownFenceFor(content: string): string {
  const matches = content.match(/`{3,}/g) ?? [];
  const max = matches.reduce((n, match) => Math.max(n, match.length), 2);
  return '`'.repeat(max + 1);
}

function stripInjectedContent(refs: ContextInjectionRef[]): ContextInjectionRef[] {
  return refs.map((ref) => {
    if (!ref.path && ref.content && ref.grounding !== 'repo_backed') return ref;
    const { content: _content, ...rest } = ref;
    return rest;
  });
}

function skipped(ref: KnowledgeCandidateRef, skipReason: ContextInjectionRef['skipReason']): ContextInjectionRef {
  return { ...ref, skipReason, packingDecision: 'skipped' };
}

function withCompressionMeta(
  ref: KnowledgeCandidateRef,
  packed: ContextCompressionResult,
  originalContentSha256: string,
): ContextInjectionRef {
  return {
    ...ref,
    originalContentSha256,
    originalCharCount: packed.originalChars,
    finalCharCount: packed.finalChars,
    charCount: packed.finalChars,
    packingTransformation: packed.transformation,
    compressorProviderId: packed.providerId,
    compressionRatio: packed.compressionRatio,
    sectionCount: packed.sectionCount,
    riskClass: packed.riskClass,
    packingWarnings: packed.warnings,
  };
}

function isPreloadLoadableKind(kind: KnowledgeNodeKind): boolean {
  return ['instruction_file', 'context_file', 'doc', 'runbook', 'production_note', 'skill', 'skill_reference'].includes(kind);
}

function isContextInjectionEligible(ref: KnowledgeCandidateRef): boolean {
  if (typeof ref.content === 'string' && ref.content.trim()) return true;
  return Boolean(ref.path && ref.loadable);
}

function isProviderNativeContextPath(path: string, provider: RepoContextProvider): boolean {
  const p = path.toLowerCase();
  if (provider === 'claude') return p === 'claude.md' || p === '.claude/claude.md';
  if (provider === 'codex') return p === 'agents.md';
  return false;
}

function sanitizeRepoRelativePath(pathValue: string): string {
  const normalized = normalize(pathValue.replace(/\\/g, '/'));
  if (!normalized || normalized === '.') return '';
  if (isAbsolute(normalized) || normalized.startsWith('..') || normalized.includes('/../')) {
    throw new Error('Path must be repo-relative');
  }
  return normalized;
}

function isPathInside(base: string, target: string): boolean {
  const rel = relative(base, target);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

async function isGitTracked(repoPath: string, relativePath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn('git', ['ls-files', '--error-unmatch', '--', relativePath], { cwd: repoPath });
    proc.on('close', (code) => resolve(code === 0));
    proc.on('error', () => resolve(false));
  });
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function redactPotentialSecrets(value: string): string {
  return value
    .replace(/(api[_-]?key|token|secret|password|authorization)\s*[:=]\s*["']?[^"'\s]+/gi, '$1=[redacted]')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]{20,}/g, 'Bearer [redacted]')
    .replace(/sk-[A-Za-z0-9]{20,}/g, 'sk-[redacted]');
}

function escapeAttr(s: unknown): string {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/[<>]/g, '');
}

function escapeText(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
