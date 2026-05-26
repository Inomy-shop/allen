import { useState } from 'react';
import {
  ChevronDown, ChevronRight, AlertCircle, CheckCircle, XCircle, Info,
  Settings, GitBranch, Zap, BookOpen, Wrench, Eye,
} from 'lucide-react';
import { authHeaders } from '../../services/api';

export type ContextRefProviderMetadata = {
  datasetName?: unknown;
  sourceId?: unknown;
  chunkId?: unknown;
  cogneeChunkId?: unknown;
  cogneeDataId?: unknown;
  chunkIndex?: unknown;
  documentRole?: unknown;
  containsCodeBlocks?: unknown;
  searchMode?: unknown;
  confidence?: unknown;
  cogneeChunkText?: unknown;
  curatedContext?: unknown;
  retrievalText?: unknown;
  rejectionReason?: unknown;
  injectionDecision?: unknown;
  injectionPolicy?: unknown;
  curatedInjectionPolicy?: unknown;
  defaultInjectionPolicy?: unknown;
  finalInjectionDecision?: unknown;
  previouslyInjected?: unknown;
  previousContextAttemptId?: unknown;
  previousMessageId?: unknown;
  sourceMetadata?: {
    path?: unknown;
    fileHash?: unknown;
    branch?: unknown;
    headSha?: unknown;
  };
};

export type ContextInjectionRefSummary = {
  refId?: string;
  path?: string;
  kind?: string;
  title?: string;
  providerId?: string;
  source?: string;
  itemType?: string;
  grounding?: string;
  contentSha256?: string;
  charCount?: number;
  loadable?: boolean;
  skipReason?: string;
  injectionPolicy?: string;
  providerMetadata?: ContextRefProviderMetadata;
};

type ContextLifecycleEventSummary = {
  type?: string;
  reason?: unknown;
  createdAt?: string | Date;
};

type ContextRerankSummary = {
  providerId?: unknown;
  score?: unknown;
  semanticScore?: unknown;
  rerankScore?: unknown;
  finalRelevanceScore?: unknown;
  finalRank?: unknown;
  originalRank?: unknown;
  reason?: unknown;
};

export type ContextLifecycleRefSummary = ContextInjectionRefSummary & {
  isMandatory?: boolean;
  isCognee?: boolean;
  cogneeScore?: number;
  retrievalPolicyScore?: number;
  finalRelevanceScore?: number;
  rerankerScore?: number;
  rerank?: ContextRerankSummary;
  rank?: number;
  lifecycleStatus?: string;
  injectionMode?: string;
  isInjected?: boolean;
  isFiltered?: boolean;
  filterReason?: string;
  filterStage?: string;
  contentAvailable?: boolean;
  contentUrl?: string;
  sourceDiscovered?: boolean;
  timeline?: ContextLifecycleEventSummary[];
};

type ContextRefDisplayGroup = 'injected' | 'selected' | 'filtered' | 'other';

type ContextRefGroups = Record<ContextRefDisplayGroup, ContextLifecycleRefSummary[]>;

export type ContextQuerySummary = {
  queryIntentHash?: string;
  renderedQueryHash?: string;
  semanticQueryHash?: string;
  renderedQueryLength?: number;
  semanticQueryLength?: number;
  role?: string;
  roleFamily?: string;
  roleFocus?: string[];
  querySignalSources?: string[];
  querySignalSections?: string[];
  querySignalLength?: number;
  requiredCategories?: string[];
  preferredCategories?: string[];
  exclusionCategories?: string[];
  currentFiles?: string[];
  changedFiles?: string[];
  pathHints?: string[];
  pathScopes?: string[];
  moduleHints?: string[];
  domainHints?: string[];
  groundingPreferences?: string[];
  categoryDiagnostics?: Array<Record<string, unknown>>;
  ignoredExecutionConstraints?: string[];
  agentRoleSignals?: Array<{
    roleSlot?: string;
    roleName?: string;
    agentName?: string;
    provider?: string;
    teamName?: string;
    teamRole?: string;
    signalText?: string;
  }>;
  queryIntentAvailable?: boolean;
  renderedQueryAvailable?: boolean;
  semanticQueryAvailable?: boolean;
  queryIntentUrl?: string;
  renderedQueryUrl?: string;
  semanticQueryUrl?: string;
};

interface Trace {
  executionTraceId?: string;
  node: string;
  attempt: number;
  status: string;
  type?: string;
  agent?: string;
  inputState?: Record<string, unknown>;
  output?: Record<string, unknown>;
  renderedPrompt?: string;
  toolCalls?: Array<{ tool: string; args?: unknown; result?: unknown; isError?: boolean; toolUseId?: string }>;
  retryReason?: string;
  templateBindings?: Array<{ placeholder: string; resolved: unknown; status?: string }>;
  toolsAvailable?: string[];
  gateDecision?: { action: string; reason: string; clarifyAction?: string; clarifyFields?: string[] };
  routingDecision?: { expression: string; result: unknown };
  runtimeContext?: {
    cwd?: string; executionMode?: string; systemPromptMode?: string;
    repoContextLoadingGuidancePresent?: boolean; repoContextLoadingGuidanceInjected?: boolean;
    mandatoryRepoContextInjected?: boolean; mandatoryRepoContextInjectedCount?: number;
    mandatoryRepoContextSkippedProviderNativeCount?: number; mandatoryRepoContextTargetLayer?: string;
    resolvedModel?: string; reasoningEffort?: string; planMode?: boolean;
    mcpServerNames?: string[]; envKeys?: string[];
  };
  repoKnowledgeInjected?: {
    packetId?: string; repoName?: string; indexId?: string; indexFreshness?: string;
    mandatoryCount?: number; recommendedCount?: number; preselectedContextCount?: number; selectedContextCount?: number;
    retrievalProviders?: string[];
    mandatoryContextInjected?: boolean; mandatoryContextInjectedCount?: number;
    mandatoryContextSkippedProviderNativeCount?: number; mandatoryContextSkippedOversizeCount?: number;
    mandatoryContextTargetLayer?: string; systemPromptContextInjected?: boolean;
    contextInjection?: {
      injectionId?: string; provider?: string; targetLayer?: string;
      injectedCount?: number; skippedProviderNativeCount?: number; skippedOversizeCount?: number;
      skippedMissingCount?: number; skippedUntrackedCount?: number; totalChars?: number;
      injectedRefs?: ContextInjectionRefSummary[];
      skippedRefs?: ContextInjectionRefSummary[];
      skippedProviderNativeRefs?: ContextInjectionRefSummary[];
    };
  };
  contextLifecycleAttempt?: {
    packetId?: string;
    contextAttemptId?: string;
    repoName?: string;
    indexId?: string;
    indexFreshness?: string;
    retrievalProviders?: string[];
    refs?: ContextLifecycleRefSummary[];
    contextInjection?: {
      targetLayer?: string;
      totalChars?: number;
      injectedRefs?: ContextInjectionRefSummary[];
      providerNativeRefs?: ContextInjectionRefSummary[];
      skippedProviderNativeRefs?: ContextInjectionRefSummary[];
      skippedRefs?: ContextInjectionRefSummary[];
    };
    contextQuery?: ContextQuerySummary;
  };
  contextEvaluation?: {
    traceId?: string; status?: string;
    scores?: { precision?: number; completeness?: number; usefulness?: number; groundedness?: number; correctness?: number; bloat?: number; overall?: number };
    semantic?: { provider?: string; status?: string; mode?: string; scores?: Record<string, number>; error?: string; completedAt?: string; reason?: string };
    diagnostics?: Array<{ code?: string; severity?: string; message?: string; refId?: string; path?: string }>;
    feedbackEvidenceCount?: number;
  };
  contextEvaluationMissingReason?: string;
  workflowContextFinding?: {
    executionId?: string;
    nodeName?: string;
    attempt?: number;
    source?: string;
    fallbackReason?: string;
    identityNormalized?: boolean;
    status?: string;
    scores?: Record<string, number>;
    summary?: string;
  };
  learningsInjected?: Array<{ id?: string; content: string; contextTags?: string[] }>;
  agentOverrides?: {
    model?: string; reasoningEffort?: string; planMode?: boolean;
    sources: Record<string, string>;
  };
  tokenUsagePerTool?: Array<{ toolUseId: string; tool: string; inputTokens: number; outputTokens: number; estimatedCost: number }>;
}

export type ContextLifecycleAttemptSummary = NonNullable<Trace['contextLifecycleAttempt']>;
export type RepoKnowledgeInjectedSummary = NonNullable<Trace['repoKnowledgeInjected']>;

interface Props {
  trace: Trace;
  workflowEdges?: Array<{ from: string; to: string | string[]; condition?: string; parallel?: boolean }>;
  contextEngineEnabled?: boolean;
}

/**
 * NodeInspector — deep-dive view of a single node trace. Renders every
 * Phase-2 enrichment field as a collapsible section. All sections are
 * self-hiding when their data is absent (older traces, non-agent nodes, etc).
 */
export default function NodeInspector({ trace, workflowEdges, contextEngineEnabled = true }: Props) {
  // State diff: keys added/modified by this node's output vs the pre-run state.
  const stateDiff = diffState(trace.inputState ?? {}, trace.output ?? {});

  const upstream = workflowEdges ? getUpstreamNodes(workflowEdges, trace.node) : [];
  const downstream = workflowEdges ? getDownstreamNodes(workflowEdges, trace.node) : [];

  const toolsUsed = new Set((trace.toolCalls ?? []).map((tc) => tc.tool));
  const contextAttempt = trace.contextLifecycleAttempt;

  return (
    <div className="space-y-3">
      {trace.retryReason && (
        <div className="border border-amber-500/40 bg-amber-500/5 rounded-lg p-2.5 flex items-start gap-2">
          <AlertCircle className="w-3.5 h-3.5 text-accent-yellow shrink-0 mt-0.5" />
          <div className="text-xs font-body">
            <span className="text-accent-yellow font-semibold">Retry reason:</span>{' '}
            <span className="text-theme-secondary font-mono">{trace.retryReason}</span>
          </div>
        </div>
      )}

      {trace.gateDecision && <GateDecisionBanner g={trace.gateDecision} />}
      {trace.routingDecision && <RoutingDecisionBanner r={trace.routingDecision} />}

      <Section icon={Settings} title="Runtime context" defaultOpen>
        {trace.runtimeContext ? (
          <KeyValueGrid
            rows={[
              ['cwd', trace.runtimeContext.cwd],
              ['execution mode', trace.runtimeContext.executionMode],
              ['system-prompt mode', trace.runtimeContext.systemPromptMode],
              ['repo context guidance present', trace.runtimeContext.repoContextLoadingGuidancePresent == null ? undefined : (trace.runtimeContext.repoContextLoadingGuidancePresent ? 'yes' : 'no')],
              ['repo context guidance injected', trace.runtimeContext.repoContextLoadingGuidanceInjected == null ? undefined : (trace.runtimeContext.repoContextLoadingGuidanceInjected ? 'yes' : 'no')],
              ['mandatory context injected', trace.runtimeContext.mandatoryRepoContextInjected == null ? undefined : (trace.runtimeContext.mandatoryRepoContextInjected ? 'yes' : 'no')],
              ['mandatory context count', trace.runtimeContext.mandatoryRepoContextInjectedCount],
              ['provider-native skipped', trace.runtimeContext.mandatoryRepoContextSkippedProviderNativeCount],
              ['mandatory context layer', trace.runtimeContext.mandatoryRepoContextTargetLayer],
              ['resolved model', trace.runtimeContext.resolvedModel],
              ['reasoning effort', trace.runtimeContext.reasoningEffort],
              ['plan mode', trace.runtimeContext.planMode ? 'on' : 'off'],
              ['MCP servers', (trace.runtimeContext.mcpServerNames ?? []).join(', ') || '(none)'],
            ]}
          />
        ) : <Empty>No runtime context captured (pre-Phase-2 trace).</Empty>}
      </Section>

      <RepoContextInjectionPanel
        contextAttempt={contextAttempt}
        repoKnowledgeInjected={trace.repoKnowledgeInjected}
        contextEngineEnabled={contextEngineEnabled}
      />

      {contextEngineEnabled && (
      <Section icon={CheckCircle} title="Context quality evaluation" defaultOpen={Boolean(trace.contextEvaluation || trace.workflowContextFinding)}>
        {trace.contextEvaluation ? (
          <div className="space-y-2">
            <KeyValueGrid
              rows={[
                ['status', trace.contextEvaluation.status],
                ['overall', formatScore(trace.contextEvaluation.scores?.overall)],
                ['precision', formatScore(trace.contextEvaluation.scores?.precision)],
                ['completeness', formatScore(trace.contextEvaluation.scores?.completeness)],
                ['usefulness', formatScore(trace.contextEvaluation.scores?.usefulness)],
                ['groundedness', formatScore(trace.contextEvaluation.scores?.groundedness)],
                ['correctness', formatScore(trace.contextEvaluation.scores?.correctness)],
                ['bloat', formatScore(trace.contextEvaluation.scores?.bloat)],
                ['semantic provider', trace.contextEvaluation.semantic?.provider],
                ['semantic status', trace.contextEvaluation.semantic?.status],
                ['semantic mode', trace.contextEvaluation.semantic?.mode],
                ['semantic completed', trace.contextEvaluation.semantic?.completedAt],
                ['semantic reason', trace.contextEvaluation.semantic?.reason],
                ['feedback evidence', trace.contextEvaluation.feedbackEvidenceCount],
              ]}
            />
            {trace.contextEvaluation.semantic?.error && (
              <div className="text-[11px] font-mono text-accent-red border border-accent-red/30 rounded-md p-1.5">
                {trace.contextEvaluation.semantic.error}
              </div>
            )}
            {trace.contextEvaluation.diagnostics?.length ? (
              <div className="space-y-1">
                <div className="overline">Evaluation diagnostics</div>
                {trace.contextEvaluation.diagnostics.map((d, i) => (
                  <div key={`${d.code ?? i}-eval`} className="text-[11px] font-mono text-theme-secondary border border-app rounded-md p-1.5">
                    <span className="text-theme-primary">{d.code ?? 'diagnostic'}</span>
                    <span className="text-theme-subtle"> · {d.severity ?? 'info'} · {d.message ?? ''}</span>
                    {(d.refId || d.path) && <div className="mt-1 text-theme-subtle">{[d.refId, d.path].filter(Boolean).join(' · ')}</div>}
                  </div>
                ))}
              </div>
            ) : null}
            {trace.workflowContextFinding && (
              <WorkflowContextFinding finding={trace.workflowContextFinding} />
            )}
          </div>
        ) : (
          <div className="space-y-2">
            {trace.workflowContextFinding ? (
              <WorkflowContextFinding finding={trace.workflowContextFinding} />
            ) : null}
            <Empty>{trace.contextEvaluationMissingReason ?? 'No context quality evaluation captured.'}</Empty>
          </div>
        )}
      </Section>
      )}

      <Section icon={Zap} title="Agent overrides">
        {trace.agentOverrides ? (
          <KeyValueGrid
            rows={[
              ['model', trace.agentOverrides.model, trace.agentOverrides.sources.model],
              ['reasoning effort', trace.agentOverrides.reasoningEffort, trace.agentOverrides.sources.reasoningEffort],
              ['plan mode', trace.agentOverrides.planMode != null ? String(trace.agentOverrides.planMode) : undefined, trace.agentOverrides.sources.planMode],
            ]}
          />
        ) : <Empty>No override data captured.</Empty>}
      </Section>

      <Section icon={Wrench} title={`Tools available (${trace.toolsAvailable?.length ?? 0})`}>
        {trace.toolsAvailable && trace.toolsAvailable.length > 0 ? (
          <div className="flex flex-wrap gap-1">
            {trace.toolsAvailable.map((t) => {
              const used = toolsUsed.has(t);
              return (
                <span
                  key={t}
                  className={`px-1.5 py-0.5 rounded text-[10px] font-mono ${
                    used
                      ? 'bg-accent-green/10 text-accent-green border border-accent-green/30'
                      : 'bg-app-muted text-theme-subtle border border-app'
                  }`}
                  title={used ? 'used at least once' : 'available but not used'}
                >
                  {t}
                </span>
              );
            })}
          </div>
        ) : <Empty>No tools-available data (pre-Phase-2 trace or non-agent node).</Empty>}
      </Section>

      <Section icon={BookOpen} title={`Learnings injected (${trace.learningsInjected?.length ?? 0})`}>
        {trace.learningsInjected && trace.learningsInjected.length > 0 ? (
          <div className="space-y-1.5">
            {trace.learningsInjected.map((l, i) => (
              <div key={l.id ?? i} className="border border-app rounded-md p-2 bg-app-muted/50">
                <div className="text-[10px] font-mono text-theme-subtle mb-0.5">
                  {l.id ?? `(no id)`} {l.contextTags && l.contextTags.length > 0 && `· ${l.contextTags.join(', ')}`}
                </div>
                <div className="text-[11px] font-body text-theme-secondary whitespace-pre-wrap">{l.content}</div>
              </div>
            ))}
          </div>
        ) : <Empty>No learnings injected.</Empty>}
      </Section>

      <Section icon={Info} title={`Template bindings (${trace.templateBindings?.length ?? 0})`}>
        {trace.templateBindings && trace.templateBindings.length > 0 ? (
          <table className="w-full text-[11px] font-mono">
            <thead>
              <tr className="text-theme-muted">
                <th className="text-left py-1 font-label uppercase tracking-[0.15em] text-[10px]">Placeholder</th>
                <th className="text-left py-1 font-label uppercase tracking-[0.15em] text-[10px]">Resolved</th>
              </tr>
            </thead>
            <tbody>
              {trace.templateBindings.map((b, i) => (
                <tr key={i} className="border-t border-border/10">
                  <td className="py-1 text-theme-secondary align-top pr-3">{'{{'}{b.placeholder}{'}}'}</td>
                  <td className="py-1 align-top break-all">
                    {b.status === 'missing' ? (
                      <span className="text-accent-yellow">⚠ missing</span>
                    ) : b.status === 'redacted' ? (
                      <span className="text-theme-subtle">🔒 redacted</span>
                    ) : (
                      <span className="text-theme-secondary">{previewValue(b.resolved)}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : <Empty>No template bindings (node has no prompt template, or pre-Phase-2 trace).</Empty>}
      </Section>

      <Section icon={GitBranch} title="DAG edges">
        <div className="space-y-1.5 text-xs">
          <div>
            <span className="overline">Upstream</span>
            <div className="font-mono text-[11px] text-theme-secondary mt-0.5">
              {upstream.length > 0 ? upstream.join(' · ') : '(none — this is an entry node)'}
            </div>
          </div>
          <div>
            <span className="overline">Downstream</span>
            <div className="font-mono text-[11px] text-theme-secondary mt-0.5">
              {downstream.length > 0 ? downstream.join(' · ') : '(none — terminal node)'}
            </div>
          </div>
        </div>
      </Section>

      <Section icon={Eye} title={`State diff · +${stateDiff.added.length} ~${stateDiff.modified.length}`}>
        {stateDiff.added.length === 0 && stateDiff.modified.length === 0 ? (
          <Empty>No state changes (node produced no new/modified keys).</Empty>
        ) : (
          <div className="space-y-1.5">
            {stateDiff.added.map((k) => (
              <div key={k} className="text-[11px] font-mono border-l-2 border-accent-green/40 pl-2">
                <span className="text-accent-green">+ {k}</span>
                <div className="text-theme-subtle pl-2 break-all whitespace-pre-wrap">
                  {previewValue((trace.output as Record<string, unknown>)[k])}
                </div>
              </div>
            ))}
            {stateDiff.modified.map((k) => (
              <div key={k} className="text-[11px] font-mono border-l-2 border-amber-400/40 pl-2">
                <span className="text-accent-yellow">~ {k}</span>
                <div className="text-theme-subtle pl-2 break-all whitespace-pre-wrap">
                  <span className="text-accent-red">− </span>{previewValue((trace.inputState as Record<string, unknown>)[k])}
                </div>
                <div className="text-theme-subtle pl-2 break-all whitespace-pre-wrap">
                  <span className="text-accent-green">+ </span>{previewValue((trace.output as Record<string, unknown>)[k])}
                </div>
              </div>
            ))}
          </div>
        )}
      </Section>

      {trace.tokenUsagePerTool && trace.tokenUsagePerTool.length > 0 && (
        <Section icon={Wrench} title="Token usage per tool">
          <table className="w-full text-[11px] font-mono">
            <thead>
              <tr className="text-theme-muted">
                <th className="text-left py-1 font-label uppercase tracking-[0.15em] text-[10px]">Tool</th>
                <th className="text-right py-1 font-label uppercase tracking-[0.15em] text-[10px]">Input</th>
                <th className="text-right py-1 font-label uppercase tracking-[0.15em] text-[10px]">Output</th>
                <th className="text-right py-1 font-label uppercase tracking-[0.15em] text-[10px]">Est. Cost</th>
              </tr>
            </thead>
            <tbody>
              {trace.tokenUsagePerTool.map((t) => (
                <tr key={t.toolUseId} className="border-t border-border/10">
                  <td className="py-1 text-theme-secondary">{t.tool}</td>
                  <td className="py-1 text-right text-theme-secondary tabular-nums">{t.inputTokens}</td>
                  <td className="py-1 text-right text-theme-secondary tabular-nums">{t.outputTokens}</td>
                  <td className="py-1 text-right text-theme-secondary tabular-nums">${t.estimatedCost.toFixed(4)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="text-[10px] text-theme-subtle mt-1 italic">
            Estimated — Anthropic doesn't expose per-tool billing. Derived from token proportions.
          </div>
        </Section>
      )}
    </div>
  );
}

export function RepoContextInjectionPanel({
  contextAttempt,
  repoKnowledgeInjected,
  contextEngineEnabled = true,
  title = 'Repo context injection',
  emptyText = 'No repo knowledge packet captured.',
}: {
  contextAttempt?: ContextLifecycleAttemptSummary | null;
  repoKnowledgeInjected?: RepoKnowledgeInjectedSummary | null;
  contextEngineEnabled?: boolean;
  title?: string;
  emptyText?: string;
}) {
  const contextGroups = groupContextRefs(contextAttempt ?? undefined);
  const legacyContextGroups = groupLegacyContextRefs(repoKnowledgeInjected ?? undefined);
  const hasLifecycleRefs = Object.values(contextGroups).some(refs => refs.length > 0);
  const hasLegacyContextRefs = Object.values(legacyContextGroups).some(refs => refs.length > 0);
  const [openContentRef, setOpenContentRef] = useState<string | null>(null);
  const [contentByRef, setContentByRef] = useState<Record<string, { loading?: boolean; error?: string; content?: string }>>({});
  const [openQueryContent, setOpenQueryContent] = useState<string | null>(null);
  const [queryContentByUrl, setQueryContentByUrl] = useState<Record<string, { loading?: boolean; error?: string; content?: string }>>({});

  const toggleRefContent = async (ref: ContextLifecycleRefSummary, key = contextRefKey(ref)) => {
    if (openContentRef === key) {
      setOpenContentRef(null);
      return;
    }
    setOpenContentRef(key);
    if (!ref.contentUrl || contentByRef[key]?.content || contentByRef[key]?.loading) return;
    setContentByRef(prev => ({ ...prev, [key]: { loading: true } }));
    try {
      const response = await fetch(ref.contentUrl, { headers: authHeaders() });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      const content = typeof payload.content === 'string' ? payload.content : '';
      setContentByRef(prev => ({ ...prev, [key]: { content: content || 'No stored chunk content.' } }));
    } catch (err) {
      setContentByRef(prev => ({ ...prev, [key]: { error: (err as Error).message } }));
    }
  };

  const toggleQueryContent = async (kind: 'query' | 'intent' | 'semantic', url?: string) => {
    if (!url) return;
    const key = `${kind}:${url}`;
    if (openQueryContent === key) {
      setOpenQueryContent(null);
      return;
    }
    setOpenQueryContent(key);
    if (queryContentByUrl[key]?.content || queryContentByUrl[key]?.loading) return;
    setQueryContentByUrl(prev => ({ ...prev, [key]: { loading: true } }));
    try {
      const response = await fetch(url, { headers: authHeaders() });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      const content = formatQueryArtifactContent(payload.content);
      setQueryContentByUrl(prev => ({ ...prev, [key]: { content: content || 'No stored query content.' } }));
    } catch (err) {
      setQueryContentByUrl(prev => ({ ...prev, [key]: { error: (err as Error).message } }));
    }
  };

  if (!contextEngineEnabled) return null;

  return (
    <Section icon={BookOpen} title={title} defaultOpen={Boolean(contextAttempt || repoKnowledgeInjected?.mandatoryContextInjected)}>
      {contextAttempt ? (
        <div className="space-y-2">
          <KeyValueGrid
            rows={[
              ['attempt', contextAttempt.contextAttemptId ?? contextAttempt.packetId],
              ['repo', contextAttempt.repoName],
              ['index', contextAttempt.indexId],
              ['freshness', contextAttempt.indexFreshness],
              ['retrieval providers', (contextAttempt.retrievalProviders ?? []).join(', ') || undefined],
              ['injected refs', contextGroups.injected.length],
              ['selected refs', contextGroups.selected.length],
              ['manifest only', countRefs(contextGroups.selected, isManifestOnlyRef)],
              ['filtered refs', contextGroups.filtered.length],
              ['mandatory refs', countRefs(contextAttempt.refs, ref => Boolean(ref.isMandatory))],
              ['Cognee refs', countRefs(contextAttempt.refs, ref => Boolean(ref.isCognee))],
              ['target layer', contextAttempt.contextInjection?.targetLayer],
            ]}
          />
          {contextAttempt.contextQuery ? (
            <div className="space-y-1.5">
              <div className="overline">Retrieval query</div>
              <KeyValueGrid
                rows={[
                  ['role', contextAttempt.contextQuery.role],
                  ['role family', contextAttempt.contextQuery.roleFamily],
                  ['semantic query hash', contextAttempt.contextQuery.semanticQueryHash],
                  ['semantic query length', contextAttempt.contextQuery.semanticQueryLength],
                  ['full query hash', contextAttempt.contextQuery.renderedQueryHash],
                  ['intent hash', contextAttempt.contextQuery.queryIntentHash],
                  ['full query length', contextAttempt.contextQuery.renderedQueryLength],
                  ['signals', formatList(contextAttempt.contextQuery.querySignalSources)],
                  ['sections', formatList(contextAttempt.contextQuery.querySignalSections)],
                  ['required', formatList(contextAttempt.contextQuery.requiredCategories)],
                  ['preferred', formatList(contextAttempt.contextQuery.preferredCategories)],
                  ['excluded', formatList(contextAttempt.contextQuery.exclusionCategories)],
                  ['current files', formatList(contextAttempt.contextQuery.currentFiles)],
                  ['path hints', formatList(contextAttempt.contextQuery.pathHints)],
                  ['path scopes', formatList(contextAttempt.contextQuery.pathScopes)],
                  ['domain hints', formatList(contextAttempt.contextQuery.domainHints)],
                  ['grounding', formatList(contextAttempt.contextQuery.groundingPreferences)],
                  ['category diagnostics', formatList((contextAttempt.contextQuery.categoryDiagnostics ?? []).map((item) => JSON.stringify(item)))],
                  ['ignored constraints', formatList(contextAttempt.contextQuery.ignoredExecutionConstraints)],
                  ['agent diagnostics', formatAgentRoleSignals(contextAttempt.contextQuery.agentRoleSignals)],
                ]}
              />
              <div className="flex flex-wrap gap-1">
                {contextAttempt.contextQuery.semanticQueryAvailable && contextAttempt.contextQuery.semanticQueryUrl ? (
                  <button type="button" onClick={() => void toggleQueryContent('semantic', contextAttempt.contextQuery?.semanticQueryUrl)} className="px-1.5 py-0.5 rounded border border-app text-[11px] font-mono text-theme-secondary hover:text-theme-primary hover:bg-app-muted">
                    {openQueryContent === `semantic:${contextAttempt.contextQuery.semanticQueryUrl}` ? 'Hide semantic query' : 'View semantic query'}
                  </button>
                ) : null}
                {contextAttempt.contextQuery.renderedQueryAvailable && contextAttempt.contextQuery.renderedQueryUrl ? (
                  <button type="button" onClick={() => void toggleQueryContent('query', contextAttempt.contextQuery?.renderedQueryUrl)} className="px-1.5 py-0.5 rounded border border-app text-[11px] font-mono text-theme-secondary hover:text-theme-primary hover:bg-app-muted">
                    {openQueryContent === `query:${contextAttempt.contextQuery.renderedQueryUrl}` ? 'Hide full query' : 'View full query'}
                  </button>
                ) : null}
                {contextAttempt.contextQuery.queryIntentAvailable && contextAttempt.contextQuery.queryIntentUrl ? (
                  <button type="button" onClick={() => void toggleQueryContent('intent', contextAttempt.contextQuery?.queryIntentUrl)} className="px-1.5 py-0.5 rounded border border-app text-[11px] font-mono text-theme-secondary hover:text-theme-primary hover:bg-app-muted">
                    {openQueryContent === `intent:${contextAttempt.contextQuery.queryIntentUrl}` ? 'Hide intent JSON' : 'View intent JSON'}
                  </button>
                ) : null}
              </div>
              {openQueryContent ? (
                <div className="rounded border border-app bg-app-card p-2 max-h-72 overflow-auto whitespace-pre-wrap text-[11px] font-mono text-theme-secondary">
                  {queryContentByUrl[openQueryContent]?.loading
                    ? 'Loading query...'
                    : queryContentByUrl[openQueryContent]?.error
                      ? `Failed to load query: ${queryContentByUrl[openQueryContent]?.error}`
                      : queryContentByUrl[openQueryContent]?.content || 'No content.'}
                </div>
              ) : null}
            </div>
          ) : null}
          {hasLifecycleRefs ? (
            <div className="space-y-1">
              <ContextRefGroupSection
                title="Injected"
                refs={contextGroups.injected}
                group="injected"
                emptyText="No context body or provider-native ref was inserted for this turn."
                openContentRef={openContentRef}
                contentByRef={contentByRef}
                onToggleContent={toggleRefContent}
              />
              <ContextRefGroupSection
                title="Selected"
                refs={contextGroups.selected}
                group="selected"
                emptyText="No selected refs remained as manifest-only or non-injected context."
                openContentRef={openContentRef}
                contentByRef={contentByRef}
                onToggleContent={toggleRefContent}
              />
              <ContextRefGroupSection
                title="Filtered"
                refs={contextGroups.filtered}
                group="filtered"
                emptyText="No refs were filtered out."
                openContentRef={openContentRef}
                contentByRef={contentByRef}
                onToggleContent={toggleRefContent}
              />
              {contextGroups.other.length ? (
                <ContextRefGroupSection
                  title="Other candidates"
                  refs={contextGroups.other}
                  group="other"
                  emptyText=""
                  openContentRef={openContentRef}
                  contentByRef={contentByRef}
                  onToggleContent={toggleRefContent}
                />
              ) : null}
            </div>
          ) : null}
        </div>
      ) : repoKnowledgeInjected ? (
        <div className="space-y-2">
          <KeyValueGrid
            rows={[
              ['packet', repoKnowledgeInjected.packetId],
              ['repo', repoKnowledgeInjected.repoName],
              ['index', repoKnowledgeInjected.indexId],
              ['freshness', repoKnowledgeInjected.indexFreshness],
              ['retrieval providers', (repoKnowledgeInjected.retrievalProviders ?? []).join(', ') || undefined],
              ['selected refs', repoKnowledgeInjected.selectedContextCount],
              ['mandatory refs', repoKnowledgeInjected.mandatoryCount],
              ['recommended refs', repoKnowledgeInjected.recommendedCount],
              ['system injected', repoKnowledgeInjected.systemPromptContextInjected == null ? undefined : (repoKnowledgeInjected.systemPromptContextInjected ? 'yes' : 'no')],
              ['full bodies injected', repoKnowledgeInjected.mandatoryContextInjectedCount],
              ['provider-native skipped', repoKnowledgeInjected.mandatoryContextSkippedProviderNativeCount],
              ['oversize skipped', repoKnowledgeInjected.mandatoryContextSkippedOversizeCount],
              ['target layer', repoKnowledgeInjected.mandatoryContextTargetLayer],
            ]}
          />
          {hasLegacyContextRefs ? (
            <div className="space-y-1">
              <ContextRefGroupSection
                title="Injected"
                refs={legacyContextGroups.injected}
                group="injected"
                emptyText="No context body or provider-native ref was inserted for this turn."
                openContentRef={openContentRef}
                contentByRef={contentByRef}
                onToggleContent={toggleRefContent}
              />
              <ContextRefGroupSection
                title="Selected"
                refs={legacyContextGroups.selected}
                group="selected"
                emptyText="No selected refs remained as manifest-only or non-injected context."
                openContentRef={openContentRef}
                contentByRef={contentByRef}
                onToggleContent={toggleRefContent}
              />
              <ContextRefGroupSection
                title="Filtered"
                refs={legacyContextGroups.filtered}
                group="filtered"
                emptyText="No refs were filtered out."
                openContentRef={openContentRef}
                contentByRef={contentByRef}
                onToggleContent={toggleRefContent}
              />
            </div>
          ) : null}
        </div>
      ) : <Empty>{emptyText}</Empty>}
    </Section>
  );
}

// ── Helpers ────────────────────────────────────────────────────────────────

function Section({
  icon: Icon, title, children, defaultOpen = false,
}: { icon: typeof Settings; title: string; children: React.ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border border-app rounded-lg bg-app-muted/50 overflow-hidden">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-2 px-3 py-2 hover:bg-app-muted"
      >
        {open ? <ChevronDown className="w-3.5 h-3.5 text-theme-muted" /> : <ChevronRight className="w-3.5 h-3.5 text-theme-muted" />}
        <Icon className="w-3.5 h-3.5 text-accent-blue" />
        <span className="font-label text-[11px] uppercase tracking-[0.15em] text-theme-secondary">{title}</span>
      </button>
      {open && <div className="px-3 py-2.5 border-t border-app bg-surface-200/20">{children}</div>}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="text-[11px] text-theme-subtle font-body italic">{children}</div>;
}

function ContextRefGroupSection({
  title,
  refs,
  group,
  emptyText,
  openContentRef,
  contentByRef,
  onToggleContent,
}: {
  title: string;
  refs: ContextLifecycleRefSummary[];
  group: ContextRefDisplayGroup;
  emptyText: string;
  openContentRef: string | null;
  contentByRef: Record<string, { loading?: boolean; error?: string; content?: string }>;
  onToggleContent: (ref: ContextLifecycleRefSummary, key: string) => void | Promise<void>;
}) {
  return (
    <div className="space-y-1">
      <div className="overline">{title} ({refs.length})</div>
      {refs.length ? refs.slice(0, 32).map((ref, index) => {
        const key = contextRefKey(ref, index);
        return (
          <ContextRefCard
            key={key}
            refSummary={ref}
            group={group}
            contentKey={key}
            contentState={contentByRef[key]}
            contentOpen={openContentRef === key}
            onToggleContent={onToggleContent}
          />
        );
      }) : (
        <Empty>{emptyText}</Empty>
      )}
    </div>
  );
}

function ContextRefCard({
  refSummary: ref,
  group,
  contentKey,
  contentOpen,
  contentState,
  onToggleContent,
}: {
  refSummary: ContextLifecycleRefSummary;
  group: ContextRefDisplayGroup;
  contentKey: string;
  contentOpen: boolean;
  contentState?: { loading?: boolean; error?: string; content?: string };
  onToggleContent: (ref: ContextLifecycleRefSummary, key: string) => void | Promise<void>;
}) {
  const chunkId = contextChunkId(ref);
  const policy = contextInjectionPolicy(ref);
  const curatedPolicy = firstText(ref.providerMetadata?.curatedInjectionPolicy);
  const finalDecision = firstText(ref.providerMetadata?.finalInjectionDecision);
  const mode = ref.injectionMode && ref.injectionMode !== policy ? ref.injectionMode : undefined;
  const rowClass = group === 'injected'
    ? 'border-accent-green/40 bg-accent-green/5'
    : group === 'filtered'
      ? 'border-amber-500/40 bg-amber-500/5'
      : group === 'selected'
        ? 'border-accent-blue/35 bg-accent-blue/5'
        : 'border-app text-theme-secondary';
  const policyClass = policyBadgeClass(policy, group);
  const detailParts = [
    ref.rank != null ? `rank ${ref.rank}` : undefined,
    ref.isMandatory ? 'mandatory' : undefined,
    ref.isCognee ? 'Cognee' : undefined,
    contextRefKindLabel(ref),
    ref.itemType,
    ref.providerId ?? ref.source,
  ].filter(Boolean);
  const auditParts = [
    contextScoreLine(ref),
    ref.contentSha256 ? `sha ${ref.contentSha256.slice(0, 12)}` : undefined,
    ref.charCount != null ? `${ref.charCount} chars` : undefined,
    contextRefAuditLine(ref),
    ref.filterReason ? `${ref.filterStage ?? 'filtered'}: ${ref.filterReason}` : undefined,
  ].filter(Boolean);

  return (
    <div className={`text-[11px] font-mono border rounded-md p-1.5 ${rowClass}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-theme-primary break-all">{ref.path ?? ref.title ?? ref.refId}</div>
          <div className="mt-0.5 text-theme-subtle break-all">ref {ref.refId ?? 'unknown'}</div>
          {chunkId ? <div className="mt-0.5 text-theme-subtle break-all">chunk {chunkId}</div> : null}
          {contextCogneePreview(ref) ? <div className="mt-1 text-theme-secondary whitespace-pre-wrap break-words">{contextCogneePreview(ref)}</div> : null}
        </div>
        <div className="shrink-0 flex items-center gap-1">
          {ref.contentAvailable && ref.contentUrl ? (
            <button type="button" onClick={() => void onToggleContent(ref, contentKey)} className="px-1.5 py-0.5 rounded border border-app text-theme-secondary hover:text-theme-primary hover:bg-app-muted">
              {contentOpen ? 'Hide content' : 'View content'}
            </button>
          ) : null}
          <span className="text-theme-subtle">{ref.lifecycleStatus ?? 'unknown'}</span>
        </div>
      </div>
      <div className="mt-1 flex flex-wrap gap-1">
        {curatedPolicy ? <span className={`px-1.5 py-0.5 rounded border ${policyBadgeClass(curatedPolicy, group)}`}>curated {curatedPolicy}</span> : null}
        {policy ? <span className={`px-1.5 py-0.5 rounded border ${policyClass}`}>{policy}</span> : null}
        {finalDecision && finalDecision !== policy ? <span className={`px-1.5 py-0.5 rounded border ${policyBadgeClass(finalDecision, group)}`}>final {finalDecision}</span> : null}
        {mode ? <span className={`px-1.5 py-0.5 rounded border ${policyBadgeClass(mode, group)}`}>{mode}</span> : null}
        <span className="px-1.5 py-0.5 rounded border border-app text-theme-subtle">{group}</span>
      </div>
      {detailParts.length ? (
        <div className="mt-1 text-theme-subtle">
          {detailParts.join(' · ')}
        </div>
      ) : null}
      {auditParts.length ? (
        <div className="mt-1 text-theme-subtle">
          {auditParts.join(' · ')}
        </div>
      ) : null}
      {contentOpen && (
        <div className="mt-2 rounded border border-app bg-app-card p-2 max-h-72 overflow-auto whitespace-pre-wrap text-theme-secondary">
          {contentState?.loading ? 'Loading content...' : contentState?.error ? `Failed to load content: ${contentState.error}` : contentState?.content || 'No content.'}
        </div>
      )}
    </div>
  );
}

function WorkflowContextFinding({ finding }: { finding: NonNullable<Trace['workflowContextFinding']> }) {
  return (
    <div className="rounded-md border border-accent-blue/30 bg-accent-blue/5 p-2">
      <div className="overline mb-1">Workflow semantic finding</div>
      <KeyValueGrid
        rows={[
          ['status', finding.status],
          ['source', finding.source],
          ['attempt', finding.attempt],
          ['fallback reason', finding.fallbackReason],
          ['identity normalized', finding.identityNormalized == null ? undefined : (finding.identityNormalized ? 'yes' : 'no')],
          ['overall', formatScore(finding.scores?.overall)],
        ]}
      />
      {finding.summary && (
        <div className="mt-2 max-h-[160px] overflow-y-auto rounded border border-app bg-surface/60 p-2 text-[11px] text-theme-secondary font-body leading-relaxed whitespace-pre-wrap">
          {finding.summary}
        </div>
      )}
    </div>
  );
}

function contextRefAuditLine(ref: ContextInjectionRefSummary): string | undefined {
  const metadata = ref.providerMetadata;
  if (!metadata) return undefined;
  const source = metadata.sourceMetadata;
  const parts = [
    metadata.datasetName ? `dataset ${String(metadata.datasetName)}` : undefined,
    metadata.sourceId ? `source ${String(metadata.sourceId)}` : undefined,
    metadata.cogneeChunkId || metadata.chunkId ? `chunk ${String(metadata.cogneeChunkId ?? metadata.chunkId)}` : undefined,
    metadata.cogneeDataId ? `data ${String(metadata.cogneeDataId)}` : undefined,
    metadata.chunkIndex !== undefined ? `index ${String(metadata.chunkIndex)}` : undefined,
    metadata.documentRole ? `role ${String(metadata.documentRole)}` : undefined,
    metadata.previouslyInjected === true ? `previously injected${metadata.previousMessageId ? ` message ${String(metadata.previousMessageId)}` : ''}` : undefined,
    metadata.searchMode ? `mode ${String(metadata.searchMode)}` : undefined,
    metadata.confidence !== undefined && metadata.confidence !== null ? `confidence ${formatContextScore(metadata.confidence)}` : undefined,
    source?.path ? `source ${String(source.path)}` : undefined,
    source?.fileHash ? `hash ${String(source.fileHash).slice(0, 12)}` : undefined,
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : undefined;
}

function contextScoreLine(ref: ContextLifecycleRefSummary): string | undefined {
  const parts = [
    ref.isCognee ? `Cognee raw ${ref.cogneeScore != null ? formatContextScore(ref.cogneeScore) : '—'}` : undefined,
    ref.retrievalPolicyScore != null ? `policy ${formatContextScore(ref.retrievalPolicyScore)}` : undefined,
    rerankerScoreLabel(ref),
    ref.finalRelevanceScore != null ? `final ${formatContextScore(ref.finalRelevanceScore)}` : undefined,
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : undefined;
}

function contextCogneePreview(ref: ContextLifecycleRefSummary): string | undefined {
  if (!ref.isCognee) return undefined;
  const text = firstText(
    ref.providerMetadata?.cogneeChunkText,
    ref.providerMetadata?.curatedContext,
    ref.providerMetadata?.retrievalText,
  );
  if (!text) return undefined;
  const compact = text.replace(/\s+/g, ' ').trim();
  return `Cognee chunk: ${compact.length > 320 ? `${compact.slice(0, 320)}...` : compact}`;
}

function rerankerScoreLabel(ref: ContextLifecycleRefSummary): string | undefined {
  const score = firstFiniteNumber(ref.rerankerScore, ref.rerank?.rerankScore, ref.rerank?.semanticScore, ref.rerank?.score);
  if (score != null) {
    const provider = firstText(ref.rerank?.providerId);
    return `reranker${provider ? ` ${provider}` : ''} ${formatContextScore(score)}`;
  }
  return ref.isCognee ? 'reranker not run' : undefined;
}

function contextChunkId(ref: ContextInjectionRefSummary): string | undefined {
  return firstText(
    ref.providerMetadata?.cogneeChunkId,
    ref.providerMetadata?.chunkId,
    ref.refId?.startsWith('cognee:') ? ref.refId.slice('cognee:'.length) : undefined,
  );
}

function contextRefKey(ref: ContextLifecycleRefSummary, fallback?: number): string {
  return String(ref.refId ?? ref.contentUrl ?? fallback ?? 'ref');
}

function formatList(values: unknown): string | undefined {
  if (!Array.isArray(values) || values.length === 0) return undefined;
  return values.map(String).join(', ');
}

function formatAgentRoleSignals(values: ContextQuerySummary['agentRoleSignals']): string | undefined {
  if (!Array.isArray(values) || values.length === 0) return undefined;
  return values
    .map((signal) => {
      const label = [signal.roleSlot, signal.agentName ?? signal.roleName].filter(Boolean).join('=');
      const team = signal.teamName ? `team ${signal.teamName}` : undefined;
      return [label, team].filter(Boolean).join(': ');
    })
    .join(' | ');
}

function formatQueryArtifactContent(value: unknown): string {
  if (typeof value !== 'string') return '';
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}

function countRefs(refs: ContextLifecycleRefSummary[] | undefined, predicate: (ref: ContextLifecycleRefSummary) => boolean): number {
  return (refs ?? []).filter(predicate).length;
}

export function groupContextRefs(attempt: Trace['contextLifecycleAttempt'] | undefined): ContextRefGroups {
  const injectedOrder = refOrderMap(attempt?.contextInjection?.injectedRefs);
  const groups: ContextRefGroups = { injected: [], selected: [], filtered: [], other: [] };
  const sorted = (attempt?.refs ?? [])
    .map((ref, index) => ({ ref, index, group: contextRefGroup(ref) }))
    .sort((a, b) => {
      if (a.group === 'injected' && b.group === 'injected') {
        const injectedOrderDelta = refOrder(injectedOrder, a.ref) - refOrder(injectedOrder, b.ref);
        if (injectedOrderDelta !== 0) return injectedOrderDelta;
      }
      const timeDelta = contextRefGroupTime(a.ref, a.group) - contextRefGroupTime(b.ref, b.group);
      if (timeDelta !== 0) return timeDelta;
      const rankDelta = contextRefRank(a.ref) - contextRefRank(b.ref);
      if (rankDelta !== 0) return rankDelta;
      return a.index - b.index;
    });
  for (const entry of sorted) groups[entry.group].push(entry.ref);
  return groups;
}

function groupLegacyContextRefs(packet: Trace['repoKnowledgeInjected'] | undefined): ContextRefGroups {
  const groups: ContextRefGroups = { injected: [], selected: [], filtered: [], other: [] };
  const injection = packet?.contextInjection;
  groups.injected.push(
    ...(injection?.injectedRefs ?? []).map(ref => ({
      ...ref,
      lifecycleStatus: 'injected',
      injectionMode: 'full',
      isInjected: true,
    })),
    ...(injection?.skippedProviderNativeRefs ?? []).map(ref => ({
      ...ref,
      lifecycleStatus: 'provider_native',
      injectionMode: 'provider_native',
      isInjected: true,
    })),
  );
  groups.filtered.push(
    ...(injection?.skippedRefs ?? [])
      .filter(ref => ref.skipReason !== 'provider_native')
      .map(ref => ({
        ...ref,
        lifecycleStatus: 'skipped',
        injectionMode: 'skipped',
        isFiltered: true,
        filterReason: ref.skipReason,
      })),
  );
  return groups;
}

export function contextRefGroup(ref: ContextLifecycleRefSummary): ContextRefDisplayGroup {
  if (isInjectedRef(ref)) return 'injected';
  if (isFilteredRef(ref)) return 'filtered';
  if (isSelectedRef(ref)) return 'selected';
  return 'other';
}

function isInjectedRef(ref: ContextLifecycleRefSummary): boolean {
  const status = String(ref.lifecycleStatus ?? '').toLowerCase();
  const mode = String(ref.injectionMode ?? '').toLowerCase();
  return Boolean(ref.isInjected)
    || ['injected', 'loaded', 'applied', 'provider_native'].includes(status)
    || ['full', 'provider_native'].includes(mode)
    || hasTimelineEvent(ref, ['injected_full', 'provider_native', 'loaded', 'applied', 'reported_loaded', 'reported_applied']);
}

function isFilteredRef(ref: ContextLifecycleRefSummary): boolean {
  if (isPreviouslyInjectedRef(ref)) return false;
  const status = String(ref.lifecycleStatus ?? '').toLowerCase();
  const mode = String(ref.injectionMode ?? '').toLowerCase();
  return Boolean(ref.isFiltered)
    || ['filtered', 'rejected', 'skipped'].includes(status)
    || mode === 'skipped'
    || hasTimelineEvent(ref, ['filtered', 'rejected', 'skipped']);
}

function isPreviouslyInjectedRef(ref: ContextLifecycleRefSummary): boolean {
  return ref.providerMetadata?.previouslyInjected === true
    || ref.filterReason === 'previously_injected'
    || (hasTimelineEvent(ref, ['skipped']) && ref.timeline?.some(event => event.reason === 'previously_injected') === true);
}

function isSelectedRef(ref: ContextLifecycleRefSummary): boolean {
  const status = String(ref.lifecycleStatus ?? '').toLowerCase();
  const mode = String(ref.injectionMode ?? '').toLowerCase();
  return status === 'selected'
    || mode === 'manifest'
    || hasTimelineEvent(ref, ['selected', 'injected_manifest']);
}

export function isManifestOnlyRef(ref: ContextLifecycleRefSummary): boolean {
  const policy = contextInjectionPolicy(ref);
  const mode = String(ref.injectionMode ?? '').toLowerCase();
  return policy === 'manifest_only' || mode === 'manifest';
}

function contextRefGroupTime(ref: ContextLifecycleRefSummary, group: ContextRefDisplayGroup): number {
  const eventTypes = group === 'injected'
    ? ['injected_full', 'provider_native', 'loaded', 'applied', 'reported_loaded', 'reported_applied']
    : group === 'filtered'
      ? ['filtered', 'rejected', 'skipped']
      : group === 'selected'
        ? ['selected', 'injected_manifest']
        : ['candidate'];
  return firstEventTime(ref.timeline, eventTypes);
}

function hasTimelineEvent(ref: ContextLifecycleRefSummary, eventTypes: string[]): boolean {
  const allowed = new Set(eventTypes);
  return Boolean(ref.timeline?.some(event => allowed.has(String(event.type))));
}

function contextInjectionPolicy(ref: ContextLifecycleRefSummary): string | undefined {
  return firstText(
    ref.providerMetadata?.injectionDecision,
    ref.providerMetadata?.injectionPolicy,
    ref.injectionPolicy,
    ref.injectionMode,
  );
}

function contextRefKindLabel(ref: ContextLifecycleRefSummary): string | undefined {
  if (isInjectedRef(ref) && contextInjectionPolicy(ref) === 'provider_native') return 'provider native';
  if (isManifestOnlyRef(ref)) return 'manifest pointer';
  const kind = String(ref.kind ?? '').toLowerCase();
  const itemType = String(ref.itemType ?? '').toLowerCase();
  if (kind.includes('chunk') || itemType.includes('chunk') || contextChunkId(ref)) return 'document chunk';
  if (ref.contentAvailable) return 'document body';
  if (ref.loadable) return 'loadable document';
  if (ref.path) return 'repo file';
  return ref.kind;
}

function policyBadgeClass(policy: string | undefined, group: ContextRefDisplayGroup): string {
  if (policy === 'mandatory_full') return 'border-accent-green/40 bg-accent-green/10 text-accent-green';
  if (policy === 'snippet') return 'border-accent-blue/40 bg-accent-blue/10 text-accent-blue';
  if (policy === 'manifest_only') return 'border-app bg-app-muted text-theme-secondary';
  if (policy === 'never_full_auto') return 'border-amber-500/40 bg-amber-500/10 text-accent-yellow';
  if (policy === 'provider_native') return 'border-accent-purple/40 bg-accent-purple/10 text-accent-purple';
  if (group === 'injected') return 'border-accent-green/40 bg-accent-green/10 text-accent-green';
  if (group === 'filtered') return 'border-amber-500/40 bg-amber-500/10 text-accent-yellow';
  return 'border-app bg-app-muted text-theme-secondary';
}

function firstEventTime(timeline: ContextLifecycleEventSummary[] | undefined, types: string[]): number {
  for (const type of types) {
    const event = timeline?.find((entry) => entry.type === type);
    const createdAt = event?.createdAt ? new Date(event.createdAt).getTime() : Number.NaN;
    if (Number.isFinite(createdAt)) return createdAt;
  }
  return Number.POSITIVE_INFINITY;
}

function contextRefRank(ref: ContextLifecycleRefSummary): number {
  const rank = firstFiniteNumber(ref.rank, ref.rerank?.finalRank, ref.rerank?.originalRank);
  return rank ?? Number.POSITIVE_INFINITY;
}

function refOrderMap(refs: ContextInjectionRefSummary[] | undefined): Map<string, number> {
  const map = new Map<string, number>();
  for (const [index, ref] of (refs ?? []).entries()) {
    if (ref.refId && !map.has(ref.refId)) map.set(ref.refId, index);
  }
  return map;
}

function refOrder(order: Map<string, number>, ref: ContextLifecycleRefSummary): number {
  return ref.refId && order.has(ref.refId) ? order.get(ref.refId)! : Number.POSITIVE_INFINITY;
}

function KeyValueGrid({ rows }: { rows: Array<[string, unknown, string?]> }) {
  return (
    <div className="space-y-1">
      {rows.map(([k, v, source]) => (
        <div key={k} className="flex items-start gap-3 text-[11px]">
          <div className="w-32 shrink-0 text-theme-muted font-label uppercase tracking-[0.1em] text-[10px] pt-0.5">
            {k}
          </div>
          <div className="flex-1 min-w-0 font-mono text-theme-secondary break-all">
            {v === undefined || v === null || v === '' ? <span className="text-theme-subtle italic">—</span> : String(v)}
            {source && (
              <span className="ml-2 text-[10px] text-theme-subtle">· {source}</span>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function GateDecisionBanner({ g }: { g: NonNullable<Trace['gateDecision']> }) {
  const icon = g.action === 'stop' ? <XCircle className="w-3.5 h-3.5 text-accent-red" />
    : g.action === 'skip' ? <CheckCircle className="w-3.5 h-3.5 text-accent-yellow" />
    : <Info className="w-3.5 h-3.5 text-accent-blue" />;
  const color = g.action === 'stop' ? 'border-red-500/40 bg-red-500/5'
    : g.action === 'skip' ? 'border-amber-500/40 bg-amber-500/5'
    : 'border-accent-blue/40 bg-accent-blue/5';
  return (
    <div className={`border ${color} rounded-lg p-2.5 flex items-start gap-2`}>
      {icon}
      <div className="text-xs font-body flex-1">
        <span className="text-theme-primary font-semibold">Auto-gate: {g.action}</span>
        {g.clarifyAction && <span className="ml-2 text-theme-subtle">({g.clarifyAction})</span>}
        {g.reason && <div className="text-theme-secondary mt-0.5">{g.reason}</div>}
        {g.clarifyFields && g.clarifyFields.length > 0 && (
          <div className="text-[10px] font-mono text-theme-subtle mt-1">fields: {g.clarifyFields.join(', ')}</div>
        )}
      </div>
    </div>
  );
}

function RoutingDecisionBanner({ r }: { r: NonNullable<Trace['routingDecision']> }) {
  return (
    <div className="border border-accent-blue/40 bg-accent-blue/5 rounded-lg p-2.5 flex items-start gap-2">
      <GitBranch className="w-3.5 h-3.5 text-accent-blue shrink-0 mt-0.5" />
      <div className="text-xs font-body flex-1">
        <span className="text-theme-primary font-semibold">Routing:</span>{' '}
        <code className="text-theme-secondary font-mono">{r.expression}</code>
        <span className="ml-2 text-theme-subtle">→ {String(r.result)}</span>
      </div>
    </div>
  );
}

function diffState(before: Record<string, unknown>, after: Record<string, unknown>): {
  added: string[]; modified: string[];
} {
  const added: string[] = [];
  const modified: string[] = [];
  for (const k of Object.keys(after)) {
    if (!(k in before)) added.push(k);
    else if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) modified.push(k);
  }
  return { added, modified };
}

function getUpstreamNodes(edges: NonNullable<Props['workflowEdges']>, node: string): string[] {
  const up = new Set<string>();
  for (const e of edges) {
    const tos = Array.isArray(e.to) ? e.to : [e.to];
    if (tos.includes(node)) up.add(e.from);
  }
  return Array.from(up);
}

function getDownstreamNodes(edges: NonNullable<Props['workflowEdges']>, node: string): string[] {
  const down = new Set<string>();
  for (const e of edges) {
    if (e.from === node) {
      const tos = Array.isArray(e.to) ? e.to : [e.to];
      tos.forEach((t) => down.add(t));
    }
  }
  return Array.from(down);
}

function formatScore(value?: number): string | undefined {
  return typeof value === 'number' ? `${Math.round(value * 100)}%` : undefined;
}

function firstText(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value;
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return undefined;
}

function firstFiniteNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
  }
  return undefined;
}

function formatContextScore(value: unknown): string {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return String(value);
  if (Math.abs(numeric) >= 100) return numeric.toFixed(0);
  if (Math.abs(numeric) >= 10) return numeric.toFixed(2).replace(/\.?0+$/, '');
  if (Math.abs(numeric) >= 1) return numeric.toFixed(3).replace(/\.?0+$/, '');
  return numeric.toFixed(4).replace(/\.?0+$/, '');
}

function previewValue(v: unknown): string {
  if (v === undefined) return 'undefined';
  if (v === null) return 'null';
  if (typeof v === 'string') return v.length > 200 ? `"${v.slice(0, 200)}…"` : `"${v}"`;
  if (typeof v === 'object') {
    const s = JSON.stringify(v);
    return s.length > 200 ? `${s.slice(0, 200)}…` : s;
  }
  return String(v);
}
