import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { KnowledgeCandidateRef, KnowledgeNodeKind, KnowledgeRetrievalInput } from './repo-context-engine.js';
import { isRecord } from './repo-knowledge-graph-utils.js';
import { resolveAllenPython } from './python-runtime.js';

export interface ContextRerankInput extends Omit<KnowledgeRetrievalInput, 'nodes'> {
  candidates: KnowledgeCandidateRef[];
}

export interface ContextRerankResult {
  providerId: string;
  rankedRefs: KnowledgeCandidateRef[];
  diagnostics: Array<Record<string, unknown>>;
  traces: Array<Record<string, unknown>>;
}

export interface ContextReranker {
  readonly providerId: string;
  rerank(input: ContextRerankInput): Promise<ContextRerankResult>;
}

export class ProviderAwareContextReranker implements ContextReranker {
  readonly providerId = 'provider_aware_context_reranker';

  constructor(private delegate: ContextReranker) {}

  async rerank(input: ContextRerankInput): Promise<ContextRerankResult> {
    if (input.candidates.length <= 1) {
      const rankedRefs = preserveProviderOrder(input.candidates, 'trivial_candidate_order_preserver', 'Candidate set is too small to rerank.');
      return {
        providerId: 'trivial_candidate_order_preserver',
        rankedRefs,
        diagnostics: [],
        traces: rankedRefs.map((ref, idx) => traceRef(ref, idx)),
      };
    }

    return this.delegate.rerank(input);
  }
}

export class DeterministicContextReranker implements ContextReranker {
  readonly providerId = 'deterministic_policy_reranker';

  async rerank(input: ContextRerankInput): Promise<ContextRerankResult> {
    const rankedRefs = rankDeterministically(input.candidates, this.providerId, input);
    return {
      providerId: this.providerId,
      rankedRefs,
      diagnostics: contextPolicyDiagnostics(rankedRefs),
      traces: rankedRefs.map((ref, idx) => traceRef(ref, idx)),
    };
  }
}

class SidecarContextReranker implements ContextReranker {
  constructor(
    readonly providerId: string,
    private fallback = new DeterministicContextReranker(),
  ) {}

  async rerank(input: ContextRerankInput): Promise<ContextRerankResult> {
    const fallbackResult = await this.fallback.rerank(input);
    try {
      const output = await runRerankerSidecar(this.providerId, input);
      const scores = scoresByRefId(output);
      if (scores.size === 0) {
        return {
          ...fallbackResult,
          diagnostics: [{
            code: 'semantic_reranker_empty',
            severity: 'warn',
            providerId: this.providerId,
            message: 'Semantic reranker returned no scores; deterministic ranking was used.',
          }],
        };
      }
      const rankedRefs = mergeSemanticScores(input.candidates, scores, this.providerId, input);
      return {
        providerId: this.providerId,
        rankedRefs,
        diagnostics: [
          ...normalizeDiagnostics(output.diagnostics),
          {
            code: 'semantic_reranker_completed',
            severity: 'info',
            providerId: this.providerId,
            candidateCount: input.candidates.length,
            scoredCandidateCount: scores.size,
            contentCandidateCount: input.candidates.filter((candidate) => typeof candidate.content === 'string' && candidate.content.trim()).length,
            contentUsed: true,
          },
          ...contextPolicyDiagnostics(rankedRefs),
        ],
        traces: rankedRefs.map((ref, idx) => traceRef(ref, idx)),
      };
    } catch (err) {
      return {
        ...fallbackResult,
        diagnostics: [{
          code: 'semantic_reranker_failed',
          severity: 'warn',
          providerId: this.providerId,
          message: (err as Error).message,
          fallbackProviderId: fallbackResult.providerId,
        }],
      };
    }
  }
}

export function createConfiguredContextReranker(): ContextReranker {
  const configured = (process.env.ALLEN_CONTEXT_RERANKER ?? '').toLowerCase();
  let reranker: ContextReranker;
  if (['bge', 'flashrank', 'sentence_transformers'].includes(configured)) {
    reranker = new SidecarContextReranker(configured);
  } else {
    reranker = new DeterministicContextReranker();
  }
  return new ProviderAwareContextReranker(reranker);
}

function preserveProviderOrder(candidates: KnowledgeCandidateRef[], providerId: string, reason: string): KnowledgeCandidateRef[] {
  return candidates.map((ref, index) => annotateRank(ref, {
    providerId,
    reason,
    originalRank: index,
    finalRank: index,
    mandatoryProtected: ref.mandatory,
  }));
}

function mergeSemanticScores(
  candidates: KnowledgeCandidateRef[],
  scores: Map<string, { score: number; reason?: string }>,
  providerId: string,
  input: ContextRerankInput,
): KnowledgeCandidateRef[] {
  const ranked = candidates
    .map((ref, originalRank) => {
      const semantic = scores.get(ref.refId);
      const deterministicScore = deterministicPriority(ref, input);
      const baseScore = ref.mandatory ? deterministicScore : Number(semantic?.score ?? 0);
      const policy = contextPolicyAdjustment(ref, input);
      const rerankerScore = ref.mandatory ? deterministicScore : baseScore + policy.adjustment;
      return {
        ref,
        originalRank,
        score: rerankerScore,
        baseScore,
        reason: semantic?.reason,
        policy,
      };
    })
    .sort((a, b) => {
      if (a.ref.mandatory !== b.ref.mandatory) return a.ref.mandatory ? -1 : 1;
      return b.score - a.score || deterministicPriority(b.ref, input) - deterministicPriority(a.ref, input);
    });

  return ranked.map((entry, finalRank) => annotateRank(entry.ref, {
    providerId,
    score: entry.score,
    semanticScore: entry.baseScore,
    reason: entry.ref.mandatory
      ? 'Mandatory context is protected from semantic demotion.'
      : entry.reason ?? 'Semantic reranker score.',
    originalRank: entry.originalRank,
    finalRank,
    mandatoryProtected: entry.ref.mandatory,
    policyAdjustment: entry.policy.adjustment || undefined,
    policyReason: entry.policy.reason,
  }));
}

function rankDeterministically(candidates: KnowledgeCandidateRef[], providerId: string, input?: ContextRerankInput): KnowledgeCandidateRef[] {
  return candidates
    .map((ref, originalRank) => {
      const baseScore = deterministicPriority(ref, input);
      const policy = contextPolicyAdjustment(ref, input);
      return { ref, originalRank, score: baseScore + policy.adjustment, baseScore, policy };
    })
    .sort((a, b) => b.score - a.score)
    .map((entry, finalRank) => annotateRank(entry.ref, {
      providerId,
      score: entry.score,
      deterministicScore: entry.baseScore,
      reason: 'Deterministic Allen policy score based on mandatory status, provider, kind, and graph score.',
      originalRank: entry.originalRank,
      finalRank,
      mandatoryProtected: entry.ref.mandatory,
      policyAdjustment: entry.policy.adjustment || undefined,
      policyReason: entry.policy.reason,
    }));
}

function annotateRank(ref: KnowledgeCandidateRef, rerank: Record<string, unknown>): KnowledgeCandidateRef {
  return { ...ref, rerank };
}

function traceRef(ref: KnowledgeCandidateRef, finalRank: number): Record<string, unknown> {
  return {
    providerId: isRecord(ref.rerank) ? ref.rerank.providerId : undefined,
    refId: ref.refId,
    path: ref.path,
    kind: ref.kind,
    mandatory: ref.mandatory,
    score: isRecord(ref.rerank) ? ref.rerank.score : ref.score,
    originalRank: isRecord(ref.rerank) ? ref.rerank.originalRank : undefined,
    finalRank,
    reason: isRecord(ref.rerank) ? ref.rerank.reason : ref.reason,
  };
}

function deterministicPriority(ref: KnowledgeCandidateRef, input?: ContextRerankInput): number {
  let priority = ref.score ?? 0;
  if (ref.mandatory) priority += 10_000;
  if (ref.providerId === 'mandatory_graph') priority += 1_000;
  priority += kindPriority(ref.kind);
  if (ref.loadable) priority += 5;
  return priority;
}

function kindPriority(kind: KnowledgeNodeKind): number {
  switch (kind) {
    case 'instruction_file': return 90;
    case 'context_file': return 80;
    case 'runbook': return 70;
    case 'production_note': return 60;
    case 'doc': return 50;
    case 'skill':
    case 'skill_reference': return 40;
    case 'command_profile': return 30;
    case 'module': return 20;
    default: return 0;
  }
}

function scoresByRefId(output: Record<string, unknown>): Map<string, { score: number; reason?: string }> {
  const rows = Array.isArray(output.scores) ? output.scores : [];
  const scores = new Map<string, { score: number; reason?: string }>();
  for (const row of rows) {
    if (!isRecord(row)) continue;
    const refId = typeof row.refId === 'string' ? row.refId : undefined;
    const score = Number(row.score);
    if (!refId || Number.isNaN(score)) continue;
    scores.set(refId, { score, reason: typeof row.reason === 'string' ? row.reason : undefined });
  }
  return scores;
}

function normalizeDiagnostics(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

async function runRerankerSidecar(providerId: string, input: ContextRerankInput): Promise<Record<string, unknown>> {
  const script = resolveRerankerScript();
  const python = resolveAllenPython();
  const payload = {
    providerId,
    task: `${input.workflowName} ${input.nodeName} ${input.nodeRole ?? ''} ${input.prompt ?? ''}`,
    currentFiles: input.currentFiles,
    candidates: input.candidates.map((candidate) => ({
      refId: candidate.refId,
      title: candidate.title,
      path: candidate.path,
      kind: candidate.kind,
      summary: candidate.summary,
      content: candidate.content?.slice(0, 2_000),
      tags: candidate.tags,
      mandatory: candidate.mandatory,
      itemType: candidate.itemType,
      grounding: candidate.grounding,
      score: candidate.score,
      providerMetadata: candidate.providerMetadata,
    })),
  };
  return new Promise((resolve, reject) => {
    const child = spawn(python, [script], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error('Context reranker timed out'));
    }, Number(process.env.ALLEN_CONTEXT_RERANKER_TIMEOUT_MS ?? 120_000));
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(stderr.trim() || `Context reranker exited with code ${code}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout || '{}') as Record<string, unknown>);
      } catch (err) {
        reject(new Error(`Context reranker returned invalid JSON: ${(err as Error).message}`));
      }
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

function contextPolicyAdjustment(ref: KnowledgeCandidateRef, input?: ContextRerankInput): { adjustment: number; reason?: string } {
  if (!input || ref.mandatory) return { adjustment: 0 };
  const role = documentRole(ref);
  const containsCodeBlocks = Boolean(ref.providerMetadata?.containsCodeBlocks);
  if (isProductOrRequirementsTask(input)) return { adjustment: 0 };
  if (isCodingOrDebuggingTask(input) && ['prd', 'design', 'generated_doc'].includes(role)) {
    return {
      adjustment: containsCodeBlocks ? -0.25 : -0.05,
      reason: containsCodeBlocks
        ? 'PRD/design/generated document contains code snippets and is lower authority than live code for coding tasks.'
        : 'PRD/design/generated document is lower authority than live code for coding tasks.',
    };
  }
  if (['source', 'guideline'].includes(role)) {
    return {
      adjustment: 0.02,
      reason: 'Source and guideline context is preferred when relevance scores are close.',
    };
  }
  return { adjustment: 0 };
}

function contextPolicyDiagnostics(refs: KnowledgeCandidateRef[]): Array<Record<string, unknown>> {
  const adjusted = refs.filter((ref) => {
    const rerank = isRecord(ref.rerank) ? ref.rerank : {};
    return Number(rerank.policyAdjustment ?? 0) !== 0;
  });
  if (!adjusted.length) return [];
  return [{
    code: 'context_policy_adjusted_ranking',
    severity: 'info',
    adjustedCount: adjusted.length,
    prdCodeSnippetDownrankedCount: adjusted.filter((ref) => {
      const rerank = isRecord(ref.rerank) ? ref.rerank : {};
      return Number(rerank.policyAdjustment ?? 0) < 0
        && ['prd', 'design', 'generated_doc'].includes(documentRole(ref))
        && Boolean(ref.providerMetadata?.containsCodeBlocks);
    }).length,
    message: 'Context ranking was adjusted using document-role policy.',
  }];
}

function documentRole(ref: KnowledgeCandidateRef): string {
  return typeof ref.providerMetadata?.documentRole === 'string' ? ref.providerMetadata.documentRole : 'unknown';
}

function isCodingOrDebuggingTask(input: ContextRerankInput): boolean {
  const taskText = taskProfileText(input);
  return /\b(bug|fix|debug|investigat|implement|code|coding|developer|engineer|backend|frontend|refactor|test|tests)\b/.test(taskText);
}

function isProductOrRequirementsTask(input: ContextRerankInput): boolean {
  const taskText = taskProfileText(input);
  return /\b(prd|product|requirement|requirements|acceptance criteria|user story|spec|design review)\b/.test(taskText);
}

function taskProfileText(input: ContextRerankInput): string {
  return `${input.workflowName} ${input.nodeName} ${input.nodeRole ?? ''} ${input.prompt ?? ''}`.toLowerCase();
}

function resolveRerankerScript(): string {
  if (process.env.ALLEN_CONTEXT_RERANKER_SCRIPT) return process.env.ALLEN_CONTEXT_RERANKER_SCRIPT;
  const candidates = [
    join(dirname(fileURLToPath(import.meta.url)), '../scripts/context-reranker.py'),
    join(process.cwd(), 'packages/server/src/scripts/context-reranker.py'),
    join(process.cwd(), 'src/scripts/context-reranker.py'),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}
