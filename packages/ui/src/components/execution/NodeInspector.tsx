import { useState } from 'react';
import {
  ChevronDown, ChevronRight, AlertCircle, CheckCircle, XCircle, Info,
  Settings, GitBranch, Zap, BookOpen, Wrench, Eye,
} from 'lucide-react';

type ContextRefProviderMetadata = {
  chunkId?: unknown;
  cogneeChunkId?: unknown;
  chunkIndex?: unknown;
  documentRole?: unknown;
  containsCodeBlocks?: unknown;
  sourceMetadata?: {
    path?: unknown;
    fileHash?: unknown;
    branch?: unknown;
    headSha?: unknown;
  };
};

type ContextInjectionRefSummary = {
  refId?: string;
  path?: string;
  kind?: string;
  title?: string;
  providerId?: string;
  source?: string;
  itemType?: string;
  grounding?: string;
  contentSha256?: string;
  skipReason?: string;
  providerMetadata?: ContextRefProviderMetadata;
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

interface Props {
  trace: Trace;
  workflowEdges?: Array<{ from: string; to: string | string[]; condition?: string; parallel?: boolean }>;
}

/**
 * NodeInspector — deep-dive view of a single node trace. Renders every
 * Phase-2 enrichment field as a collapsible section. All sections are
 * self-hiding when their data is absent (older traces, non-agent nodes, etc).
 */
export default function NodeInspector({ trace, workflowEdges }: Props) {
  // State diff: keys added/modified by this node's output vs the pre-run state.
  const stateDiff = diffState(trace.inputState ?? {}, trace.output ?? {});

  const upstream = workflowEdges ? getUpstreamNodes(workflowEdges, trace.node) : [];
  const downstream = workflowEdges ? getDownstreamNodes(workflowEdges, trace.node) : [];

  const toolsUsed = new Set((trace.toolCalls ?? []).map((tc) => tc.tool));

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

      <Section icon={BookOpen} title="Repo context injection" defaultOpen={Boolean(trace.repoKnowledgeInjected?.mandatoryContextInjected)}>
        {trace.repoKnowledgeInjected ? (
          <div className="space-y-2">
            <KeyValueGrid
              rows={[
                ['packet', trace.repoKnowledgeInjected.packetId],
                ['repo', trace.repoKnowledgeInjected.repoName],
                ['index', trace.repoKnowledgeInjected.indexId],
                ['freshness', trace.repoKnowledgeInjected.indexFreshness],
                ['retrieval providers', (trace.repoKnowledgeInjected.retrievalProviders ?? []).join(', ') || undefined],
                ['selected refs', trace.repoKnowledgeInjected.selectedContextCount],
                ['mandatory refs', trace.repoKnowledgeInjected.mandatoryCount],
                ['recommended refs', trace.repoKnowledgeInjected.recommendedCount],
                ['system injected', trace.repoKnowledgeInjected.systemPromptContextInjected == null ? undefined : (trace.repoKnowledgeInjected.systemPromptContextInjected ? 'yes' : 'no')],
                ['full bodies injected', trace.repoKnowledgeInjected.mandatoryContextInjectedCount],
                ['provider-native skipped', trace.repoKnowledgeInjected.mandatoryContextSkippedProviderNativeCount],
                ['oversize skipped', trace.repoKnowledgeInjected.mandatoryContextSkippedOversizeCount],
                ['target layer', trace.repoKnowledgeInjected.mandatoryContextTargetLayer],
              ]}
            />
            {trace.repoKnowledgeInjected.contextInjection?.injectedRefs?.length ? (
              <div className="space-y-1">
                <div className="overline">Injected full bodies</div>
                {trace.repoKnowledgeInjected.contextInjection.injectedRefs.map((r, i) => (
                  <div key={r.refId ?? i} className="text-[11px] font-mono text-theme-secondary border border-app rounded-md p-1.5">
                    <span className="text-theme-primary">{r.path ?? r.title ?? r.refId}</span>
                    <span className="text-theme-subtle"> · {r.kind} · {r.itemType ?? 'repo_file'} · {r.grounding ?? 'repo_backed'} · {r.providerId ?? r.source ?? 'context'}</span>
                    {contextRefAuditLine(r) && <div className="mt-1 text-theme-subtle">{contextRefAuditLine(r)}</div>}
                  </div>
                ))}
              </div>
            ) : null}
            {trace.repoKnowledgeInjected.contextInjection?.skippedProviderNativeRefs?.length ? (
              <div className="space-y-1">
                <div className="overline">Provider-native refs</div>
                {trace.repoKnowledgeInjected.contextInjection.skippedProviderNativeRefs.map((r, i) => (
                  <div key={r.refId ?? i} className="text-[11px] font-mono text-theme-secondary border border-app rounded-md p-1.5">
                    <span className="text-theme-primary">{r.path ?? r.title ?? r.refId}</span>
                    <span className="text-theme-subtle"> · already loaded by provider · {r.itemType ?? 'repo_file'} · {r.providerId ?? 'provider-native'}</span>
                    {contextRefAuditLine(r) && <div className="mt-1 text-theme-subtle">{contextRefAuditLine(r)}</div>}
                  </div>
                ))}
              </div>
            ) : null}
            {trace.repoKnowledgeInjected.contextInjection?.skippedRefs?.length ? (
              <div className="space-y-1">
                <div className="overline">Skipped refs</div>
                {trace.repoKnowledgeInjected.contextInjection.skippedRefs.map((r, i) => (
                  <div key={`${r.refId ?? i}-skipped`} className="text-[11px] font-mono text-theme-secondary border border-app rounded-md p-1.5">
                    <span className="text-theme-primary">{r.path ?? r.title ?? r.refId}</span>
                    <span className="text-theme-subtle"> · {r.kind} · {r.itemType ?? 'repo_file'} · {r.skipReason ?? 'skipped'} · {r.providerId ?? 'context'}</span>
                    {contextRefAuditLine(r) && <div className="mt-1 text-theme-subtle">{contextRefAuditLine(r)}</div>}
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        ) : <Empty>No repo knowledge packet captured.</Empty>}
      </Section>

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
    metadata.cogneeChunkId || metadata.chunkId ? `chunk ${String(metadata.cogneeChunkId ?? metadata.chunkId)}` : undefined,
    metadata.chunkIndex !== undefined ? `index ${String(metadata.chunkIndex)}` : undefined,
    metadata.documentRole ? `role ${String(metadata.documentRole)}` : undefined,
    source?.path ? `source ${String(source.path)}` : undefined,
    source?.fileHash ? `hash ${String(source.fileHash).slice(0, 12)}` : undefined,
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : undefined;
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
