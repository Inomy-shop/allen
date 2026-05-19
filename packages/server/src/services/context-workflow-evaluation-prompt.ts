export type WorkflowSemanticEvaluationPromptInput = {
  execution: Record<string, unknown> | null;
  descendants: Array<Record<string, unknown>>;
  nodeEvaluations: Array<Record<string, unknown>>;
  usageTraces: Array<Record<string, unknown>>;
  nodeContextPackets: Array<Record<string, unknown>>;
  executionTraces: Array<Record<string, unknown>>;
};

const MAX_JSON_CHARS = 120_000;
const OUTPUT_EXCERPT_CHARS = 900;
const MAX_REFS_PER_GROUP = 10;
const MAX_DIAGNOSTICS_PER_NODE = 8;

export function buildWorkflowSemanticEvaluationPrompt(input: WorkflowSemanticEvaluationPromptInput): string {
  return buildWorkflowSemanticEvaluationPromptArtifacts(input).prompt;
}

export function buildWorkflowSemanticEvaluationPromptArtifacts(input: WorkflowSemanticEvaluationPromptInput): {
  prompt: string;
  evidencePayload: Record<string, unknown>;
  packedEvidencePayload: Record<string, unknown>;
  evidenceJson: string;
  evidenceTruncated: boolean;
  evidenceStats: Record<string, unknown>;
} {
  const payload = redactPayload(compactPayload(input));
  const packed = packWorkflowEvidence(payload);
  const evidenceJson = stringifyPackedEvidence(packed.payload);
  const prompt = [
    ...promptHeaderLines(),
    '',
    'Packed workflow evidence JSON:',
    evidenceJson,
  ].join('\n');
  return {
    prompt,
    evidencePayload: payload,
    packedEvidencePayload: packed.payload,
    evidenceJson,
    evidenceTruncated: packed.stats.truncated === true,
    evidenceStats: packed.stats,
  };
}

function redactPayload(value: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value, jsonReplacer)) as Record<string, unknown>;
}

function promptHeaderLines(): string[] {
  return [
    'You are the DeepEval semantic evaluator for Allen workflow context injection.',
    '',
    'Evaluate whether the repo context selected and injected into this workflow was precise, complete, useful, and grounded in the task.',
    'Use the deterministic node metrics as evidence, but do not copy them blindly. Judge whether the injected context actually helped the workflow output and whether important context was missed.',
    'Return one nodeFindings item for every agent node that had repo context injected, context usage tracked, or node context evaluation evidence. If there is not enough semantic evidence for a node, mark that node as not_assessed and explain why in the summary.',
    'Each nodeFinding MUST copy executionId, nodeName, and numeric attempt exactly from one object in Packed workflow evidence JSON.nodes.',
    'Do not append attempt text to nodeName. For example, use {"nodeName":"implement","attempt":1}, never {"nodeName":"implement attempt 1"}.',
    'For each nodeFinding, cite specific evidence from selected refs, injected refs, provider text excerpts, usage claims, node output, diagnostics, or tool evidence. Do not give only high-level conclusions.',
    'Provider-text refs are valid injected context when itemType is provider_text/provider_generated and contentExcerpt is present. Evaluate them by their excerpt, grounding, source, and usage evidence.',
    '',
    'Return only valid JSON with this shape:',
    JSON.stringify({
      status: 'passed | warning | failed',
      scores: {
        precision: 0,
        completeness: 0,
        usefulness: 0,
        groundedness: 0,
        correctness: 0,
        bloat: 0,
        overall: 0,
      },
      diagnostics: [
        {
          code: 'short_machine_code',
          severity: 'info | warn',
          message: 'specific finding',
          nodeName: 'optional node name',
          refIds: ['optional-ref-id'],
        },
      ],
      nodeFindings: [
        {
          executionId: 'execution id',
          nodeName: 'exact node name from Packed workflow evidence JSON.nodes[].nodeName',
          attempt: 1,
          status: 'passed | warning | failed | not_assessed',
          scores: {
            precision: 0,
            completeness: 0,
            usefulness: 0,
            groundedness: 0,
            correctness: 0,
            bloat: 0,
            overall: 0,
          },
          usedRefs: ['ref ids that were relevant and used'],
          missingRefs: ['ref ids or file paths that should have been present'],
          unnecessaryRefs: ['ref ids that looked irrelevant or bloated'],
          supportingEvidence: ['short concrete evidence bullets'],
          recommendation: 'specific retrieval or injection improvement',
          summary: 'specific node-level conclusion',
        },
      ],
      summary: 'workflow-level conclusion',
    }, null, 2),
    '',
    'Scoring rules:',
    '- precision: selected/injected context was relevant to the actual task and node outputs.',
    '- completeness: mandatory or clearly needed repo knowledge was present when needed.',
    '- usefulness: the workflow output shows the context improved decisions or implementation.',
    '- groundedness: claims about context are backed by injected refs, loaded refs, outputs, or tool evidence.',
    '- correctness: the workflow did not claim to use unavailable or contradictory context.',
    '- bloat: higher means more unnecessary context was injected.',
    '- overall: holistic quality score from 0 to 1.',
  ];
}

function compactPayload(input: WorkflowSemanticEvaluationPromptInput): Record<string, unknown> {
  return {
    execution: pick(input.execution, ['id', 'workflowName', 'status', 'input', 'state', 'failedNode', 'errorMessage', 'feedbackEntries', 'startedAt', 'completedAt']),
    descendants: input.descendants.map((row) => pick(row, ['id', 'workflowName', 'status', 'parentExecutionId', 'parentCaller', 'rootExecutionId', 'input', 'failedNode', 'errorMessage'])),
    nodeEvaluations: input.nodeEvaluations.map((row) => pick(row, ['executionId', 'nodeName', 'nodeRole', 'attempt', 'status', 'scores', 'diagnostics', 'refScores', 'feedbackEvidence'])),
    usageTraces: input.usageTraces.map((row) => pick(row, ['executionId', 'nodeName', 'nodeRole', 'attempt', 'packetId', 'loaded', 'claimedUsed', 'reportedLoaded', 'reportedApplied', 'skipped', 'validationPerformed', 'usageSummary', 'diagnostics'])),
    nodeContextPackets: input.nodeContextPackets.map((row) => pick(row, ['executionId', 'nodeName', 'nodeRole', 'attempt', 'packetId', 'repoId', 'repoName', 'indexId', 'selectedRefs', 'contextInjection', 'retrievalProviders'])),
    executionTraces: input.executionTraces.map((row) => pick(row, ['executionId', 'node', 'agent', 'attempt', 'status', 'rawResponse', 'output', 'error', 'repoKnowledgeInjected', 'contextUsage'])),
  };
}

function packWorkflowEvidence(payload: Record<string, unknown>): { payload: Record<string, unknown>; stats: Record<string, unknown> } {
  const originalChars = JSON.stringify(payload).length;
  const attempts = [
    { excerptChars: OUTPUT_EXCERPT_CHARS, maxRefs: MAX_REFS_PER_GROUP, maxDiagnostics: MAX_DIAGNOSTICS_PER_NODE },
    { excerptChars: 500, maxRefs: 7, maxDiagnostics: 5 },
    { excerptChars: 250, maxRefs: 5, maxDiagnostics: 3 },
    { excerptChars: 120, maxRefs: 3, maxDiagnostics: 2 },
  ];
  for (const budget of attempts) {
    const packed = buildPackedPayload(payload, budget);
    const packedChars = JSON.stringify(packed.payload).length;
    if (packedChars <= MAX_JSON_CHARS) {
      return {
        payload: packed.payload,
        stats: {
          ...packed.stats,
          originalChars,
          packedChars,
          targetChars: MAX_JSON_CHARS,
          truncated: packed.stats.droppedSections.length > 0,
        },
      };
    }
  }

  const minimal = buildPackedPayload(payload, { excerptChars: 0, maxRefs: 0, maxDiagnostics: 0 });
  const packedChars = JSON.stringify(minimal.payload).length;
  return {
    payload: minimal.payload,
    stats: {
      ...minimal.stats,
      originalChars,
      packedChars,
      targetChars: MAX_JSON_CHARS,
      truncated: true,
      droppedSections: [...new Set([...minimal.stats.droppedSections, 'node_details_minimized_to_fit_budget'])],
    },
  };
}

function buildPackedPayload(
  payload: Record<string, unknown>,
  budget: { excerptChars: number; maxRefs: number; maxDiagnostics: number },
): { payload: Record<string, unknown>; stats: { nodeCount: number; perNode: Array<Record<string, unknown>>; droppedSections: string[] } } {
  const nodes = collectNodeEvidence(payload, budget);
  const droppedSections = new Set<string>();
  for (const node of nodes) {
    for (const section of stringArray(node.droppedSections)) droppedSections.add(section);
    delete (node as Record<string, unknown>).droppedSections;
  }
  return {
    payload: {
      execution: slimExecution(payload.execution),
      descendants: normalizeUsageArray(payload.descendants).map(slimExecution),
      nodes,
    },
    stats: {
      nodeCount: nodes.length,
      perNode: nodes.map((node) => ({
        nodeName: node.nodeName,
        attempt: node.attempt,
        selectedRefs: normalizeUsageArray(node.selectedRefs).length,
        injectedRefs: normalizeUsageArray(node.injectedRefs).length,
        skippedRefs: normalizeUsageArray(node.skippedRefs).length,
        diagnostics: normalizeUsageArray(node.diagnostics).length,
        outputExcerptChars: String(node.outputExcerpt ?? '').length,
      })),
      droppedSections: Array.from(droppedSections),
    },
  };
}

function collectNodeEvidence(
  payload: Record<string, unknown>,
  budget: { excerptChars: number; maxRefs: number; maxDiagnostics: number },
): Array<Record<string, unknown>> {
  const nodes = new Map<string, Record<string, unknown>>();
  const ensure = (executionId: unknown, nodeName: unknown, attempt: unknown): Record<string, unknown> => {
    const node = String(nodeName ?? 'unknown');
    const attemptValue = Number(attempt ?? 1);
    const key = `${String(executionId ?? '')}:${node}:${attemptValue}`;
    const existing = nodes.get(key);
    if (existing) return existing;
    const row = {
      executionId,
      nodeName: node,
      attempt: attemptValue,
      selectedRefs: [],
      injectedRefs: [],
      skippedRefs: [],
      loadedRefs: [],
      appliedRefs: [],
      diagnostics: [],
      droppedSections: [],
    };
    nodes.set(key, row);
    return row;
  };

  for (const packet of normalizeUsageArray(payload.nodeContextPackets)) {
    const node = ensure(packet.executionId, packet.nodeName, packet.attempt);
    node.nodeRole ??= packet.nodeRole;
    node.repoName ??= packet.repoName;
    node.indexId ??= packet.indexId;
    node.packetId ??= packet.packetId;
    node.retrievalProviders ??= packet.retrievalProviders;
    assignCappedRefs(node, 'selectedRefs', normalizeUsageArray(packet.selectedRefs), budget.maxRefs);
    const injection = isRecord(packet.contextInjection) ? packet.contextInjection : {};
    assignCappedRefs(node, 'injectedRefs', normalizeUsageArray(injection.injectedRefs), budget.maxRefs);
    assignCappedRefs(node, 'skippedRefs', normalizeUsageArray(injection.skippedRefs), budget.maxRefs);
  }

  for (const usage of normalizeUsageArray(payload.usageTraces)) {
    const node = ensure(usage.executionId, usage.nodeName, usage.attempt);
    node.nodeRole ??= usage.nodeRole;
    node.packetId ??= usage.packetId;
    assignCappedRefs(node, 'loadedRefs', normalizeUsageArray(usage.loaded), budget.maxRefs);
    assignCappedRefs(node, 'appliedRefs', normalizeUsageArray(usage.claimedUsed), budget.maxRefs);
    node.validationPerformed = normalizeUsageArray(usage.validationPerformed).slice(0, 5);
    node.usageSummary = truncateText(firstString(usage.usageSummary), 500);
    appendDiagnostics(node, normalizeUsageArray(usage.diagnostics), budget.maxDiagnostics);
  }

  for (const evaluation of normalizeUsageArray(payload.nodeEvaluations)) {
    const node = ensure(evaluation.executionId, evaluation.nodeName, evaluation.attempt);
    node.nodeRole ??= evaluation.nodeRole;
    node.evaluationStatus = evaluation.status;
    node.scores = evaluation.scores;
    appendDiagnostics(node, normalizeUsageArray(evaluation.diagnostics), budget.maxDiagnostics);
    assignCappedRefs(node, 'refScores', normalizeUsageArray(evaluation.refScores), budget.maxRefs);
    node.feedbackEvidenceCount = normalizeUsageArray(evaluation.feedbackEvidence).length;
  }

  for (const trace of normalizeUsageArray(payload.executionTraces)) {
    const node = ensure(trace.executionId, trace.node, trace.attempt);
    node.agent ??= trace.agent;
    node.status ??= trace.status;
    node.contextUsage ??= trace.contextUsage;
    node.error ??= truncateText(firstString(trace.error), 500);
    const outputText = firstString(trace.rawResponse, isRecord(trace.output) ? JSON.stringify(trace.output) : undefined);
    node.outputExcerpt = budget.excerptChars > 0 ? truncateText(outputText, budget.excerptChars) : undefined;
    if (outputText && outputText.length > budget.excerptChars) addDroppedSection(node, 'output_excerpt_truncated');
  }

  return Array.from(nodes.values()).sort((a, b) => {
    const exec = String(a.executionId ?? '').localeCompare(String(b.executionId ?? ''));
    if (exec !== 0) return exec;
    const node = String(a.nodeName ?? '').localeCompare(String(b.nodeName ?? ''));
    if (node !== 0) return node;
    return Number(a.attempt ?? 0) - Number(b.attempt ?? 0);
  });
}

function slimExecution(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  return pick(value, ['id', 'workflowName', 'status', 'input', 'failedNode', 'errorMessage', 'feedbackEntries', 'startedAt', 'completedAt']);
}

function assignCappedRefs(target: Record<string, unknown>, key: string, refs: Array<Record<string, unknown>>, maxRefs: number): void {
  const existing = normalizeUsageArray(target[key]);
  const slim = refs.slice(0, maxRefs).map(slimRef);
  target[key] = [...existing, ...slim].slice(0, maxRefs);
  if (refs.length > maxRefs) addDroppedSection(target, `${key}_truncated`);
}

function slimRef(ref: Record<string, unknown>): Record<string, unknown> {
  return {
    refId: ref.refId,
    path: ref.path,
    kind: ref.kind,
    title: ref.title,
    providerId: ref.providerId,
    source: ref.source,
    itemType: ref.itemType,
    grounding: ref.grounding,
    mandatory: ref.mandatory,
    reason: truncateText(firstString(ref.reason, ref.summary), 300),
    skipReason: ref.skipReason,
    score: ref.score,
    contentSha256: ref.contentSha256,
    contentExcerpt: truncateText(firstString(ref.content), 1000),
    providerMetadata: slimProviderMetadata(ref.providerMetadata),
    rerank: slimRerank(ref.rerank),
  };
}

function slimProviderMetadata(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const slim = pick(value, [
    'datasetId',
    'datasetName',
    'sourceId',
    'chunkId',
    'cogneeChunkId',
    'chunkIndex',
    'chunkSize',
    'cutType',
    'documentRole',
    'containsCodeBlocks',
    'entityIds',
    'confidence',
    'searchMode',
    'latencyMs',
  ]) ?? {};
  const sourceMetadata = slimSourceMetadata(value.sourceMetadata);
  if (sourceMetadata) slim.sourceMetadata = sourceMetadata;
  return Object.keys(slim).length > 0 ? slim : undefined;
}

function slimSourceMetadata(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const slim = pick(value, ['repoId', 'repoName', 'branch', 'headSha', 'path', 'title', 'kind', 'fileHash', 'ingestFormat', 'source']) ?? {};
  return Object.keys(slim).length > 0 ? slim : undefined;
}

function slimRerank(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  return pick(value, ['providerId', 'score', 'originalRank', 'finalRank', 'reason', 'mandatoryProtected']) ?? undefined;
}

function appendDiagnostics(target: Record<string, unknown>, diagnostics: Array<Record<string, unknown>>, maxDiagnostics: number): void {
  const existing = normalizeUsageArray(target.diagnostics);
  target.diagnostics = [...existing, ...diagnostics.slice(0, maxDiagnostics).map((diag) => ({
    code: diag.code,
    severity: diag.severity,
    message: truncateText(firstString(diag.message, diag.summary), 400),
    refId: diag.refId,
    path: diag.path,
    refIds: normalizeUsageArray(diag.refIds).slice(0, 10),
  }))].slice(0, maxDiagnostics);
  if (diagnostics.length > maxDiagnostics) addDroppedSection(target, 'diagnostics_truncated');
}

function addDroppedSection(target: Record<string, unknown>, section: string): void {
  const dropped = stringArray(target.droppedSections);
  if (!dropped.includes(section)) dropped.push(section);
  target.droppedSections = dropped;
}

function pick(row: Record<string, unknown> | null | undefined, keys: string[]): Record<string, unknown> | null {
  if (!row) return null;
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    if (row[key] !== undefined) out[key] = row[key];
  }
  return out;
}

function stringifyPackedEvidence(value: unknown): string {
  const text = JSON.stringify(value, jsonReplacer, 2);
  if (text.length <= MAX_JSON_CHARS) return text;
  return JSON.stringify({
    warning: 'Packed evidence exceeded prompt budget even after minimization.',
    targetChars: MAX_JSON_CHARS,
    evidenceChars: text.length,
    evidence: value,
  }, jsonReplacer, 2).slice(0, MAX_JSON_CHARS);
}

function jsonReplacer(_key: string, value: unknown): unknown {
  if (/secret|token|password|credential|api[_-]?key|jwt|authorization/i.test(_key)) return '[redacted]';
  if (typeof value === 'string' && value.length > 6000) return `${value.slice(0, 6000)}...[truncated]`;
  return value;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function normalizeUsageArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
}

function truncateText(value: string | undefined, maxChars: number): string | undefined {
  if (!value) return undefined;
  if (maxChars <= 0) return undefined;
  return value.length > maxChars ? `${value.slice(0, maxChars)}...[truncated]` : value;
}
